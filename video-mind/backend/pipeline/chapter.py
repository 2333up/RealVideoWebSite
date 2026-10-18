"""把带时间戳的转写文本切成有标题、有摘要、有边界的章节。

这一层最大的敌人是**时间戳幻觉**：LLM 会编造转写里根本不存在的时间点，
一点偏差就会让「点章节跳播放器」跳到无关内容。因此这里设了三道防线：

    1. 提示词强制：start / end 必须取自转写文本中真实出现的时间戳
    2. 吸附校正：snap_timestamp() 把任何输出值吸附到最近的真实片段起点
    3. 结构修复：单调性、覆盖性、最小时长——不满足就修，修不好就报错

长视频（超过 chapter_target_chars）走 Map-Reduce：分段并行出章节，再合并去重。
"""

from __future__ import annotations

import math
import re

from core import config
from core.config import settings
from providers.asr.base import Segment
from providers.llm import LLMError, get_llm

# 章节最短时长（秒）。短于这个值的章节没有跳转价值，会被合并进上一章。
MIN_CHAPTER_SEC = 15.0


# ------------------------------------------------------------------ 文本格式化

def format_ts(seconds: float) -> str:
    """秒 -> HH:MM:SS 或 MM:SS。与前端显示格式保持一致，便于人工核对。"""
    seconds = max(0.0, float(seconds))
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def render_transcript(segments: list[Segment]) -> str:
    """把片段渲染成给 LLM 看的、带时间戳前缀的文本。"""
    lines = []
    for s in segments:
        text = (s.text or "").strip()
        if not text:
            continue
        lines.append(f"[{format_ts(s.start)}] {text}")
    return "\n".join(lines)


# ------------------------------------------------------------------ 时间吸附

def snap_timestamp(t: float, segments: list[Segment]) -> float:
    """把任意时间戳吸附到最近的真实片段起点。

    章节边界应该落在「有人开始说话」的位置，因此吸附目标是 start 而非 end。
    """
    if not segments:
        return max(0.0, t)
    return min(segments, key=lambda s: abs(s.start - t)).start


# ------------------------------------------------------------------ 切片

def split_segments(
    segments: list[Segment], target_chars: int, overlap_chars: int
) -> list[list[Segment]]:
    """按字符数把片段切成若干块，相邻块之间保留重叠以避免章节被腰斩。

    重叠的意义：如果切割点正好落在一个话题的中间，
    没有上下文的模型很容易把同一话题切成两章。
    """
    if not segments:
        return []
    total = sum(len(s.text) for s in segments)
    if total <= target_chars:
        return [segments]

    step = max(1, target_chars - overlap_chars)
    chunks: list[list[Segment]] = []
    cur: list[Segment] = []
    cur_len = 0
    # 已消费的字符数（含重叠），用于计算下一块的起点
    consumed = 0

    for s in segments:
        cur.append(s)
        cur_len += len(s.text)
        consumed += len(s.text)
        if cur_len >= target_chars:
            chunks.append(cur)
            # 回退 overlap_chars 个字符作为下一块的开头
            back = 0
            tail: list[Segment] = []
            for prev in reversed(cur):
                if back >= overlap_chars:
                    break
                tail.insert(0, prev)
                back += len(prev.text)
            cur, cur_len = tail, back

    if cur and (not chunks or cur is not chunks[-1]):
        chunks.append(cur)
    return chunks or [segments]


# ------------------------------------------------------------------ 提示词

SYSTEM_PROMPT = """你是一位专业的视频内容结构化分析助手。

你的任务：阅读一段带时间戳的视频转写稿，先找出「话题在哪一刻发生转折」，
再据此把它切分成逻辑连贯的章节。

## 思考顺序（先做第一步，再输出）

1. 扫一遍转写稿，在心里列出话题真正发生改变的几个时间点
   （换议题、换案例、从讲原理变成讲实操、从铺垫变成给结论……都算转折）。
   可以把它们写进 JSON 的 topic_shifts 字段当草稿，这个字段不会被使用，
   但先写出来能显著提高切分位置的准确度。
2. 以这些转折点为界切分章节，保证每章内部讲的是同一件事。

## 硬性要求（违反任何一条都会导致解析失败）

1. 只输出一个 JSON 对象，不要输出解释文字，不要 markdown 代码块。
2. JSON 结构：
   {"topic_shifts": [123, 456], "chapters": [
     {"title": "...", "start": 0, "end": 120, "summary": "...", "key_points": ["...", "..."]}
   ]}
3. start / end 单位是「秒」。
4. **start 和 end 必须取自转写稿方括号里真实出现过的时间戳**，严禁自行推算、插值或编造。
   找不到正好匹配的时间点时，取**不早于**转折位置、且离它最近的那个已有时间戳。
5. 章节按时间递增排列，相邻章节首尾相接（上一章的 end 等于下一章的 start）。
6. 第一节的 start 必须是 0；最后一节的 end 必须覆盖到转写稿的结束时间。
7. title 不超过 20 字，要能概括该段的核心内容，禁止「第一部分」「相关介绍」这种无信息量的标题。
8. summary 100-200 字，讲清楚这段「讲了什么、结论是什么」。
9. key_points 列 2-4 条要点，每条不超过 30 字，必须是这一段里真实提到的内容；
   **不要和 summary 重复同一句话**，要点要更具体（数据、名称、步骤）。
10. 章节数量以用户消息里给出的「建议章节数」为准，上下浮动不超过 2 章。
    宁可少切几章讲透，也不要把同一件事切成好几章。

## 示例

输入（片段）：
[00:00] 今天我们聊聊这个宝可梦的强度问题
[00:45] 先看看它的种族值，特攻 145 速度 43
[02:10] 速度太低了，实战里根本抢不到先手，使用率只有 150 名

输出：
{"topic_shifts": [45, 130], "chapters": [
  {"title": "开场与种族值分析", "start": 0, "end": 45,
   "summary": "开场介绍本期主角，先给出种族值：特攻 145、速度 43，定位为高攻低速。",
   "key_points": ["特攻 145 属于第一梯队", "速度 43 明显偏低"]},
  {"title": "速度劣势与实战使用率", "start": 45, "end": 130,
   "summary": "速度过低导致实战抢不到先手，排位使用率跌到 150 名，强度因此受限。",
   "key_points": ["低速导致无法先手出手", "排位使用率仅 150 名"]}
]}"""


USER_TEMPLATE = """视频总时长：{duration}
建议章节数：约 {suggest} 章（按每 5 分钟一章推算，可上下浮动 2 章）

以下是转写稿，每行格式为「[时:分:秒] 内容」：

{transcript}

{extra}
请按系统提示的思考顺序切分章节，并输出 JSON。"""


def _build_user_prompt(segments: list[Segment], extra: str = "") -> str:
    duration = segments[-1].end if segments else 0.0
    # 给模型一个章节数锚点：只说「每 3-10 分钟一章」时它要么切得太碎要么太粗。
    # 按 5 分钟一章推算一个具体数字，允许上下浮动 2 章，命中率明显更高。
    span = max(0.0, duration - (segments[0].start if segments else 0.0))
    suggest = max(1, round(span / 300))
    return USER_TEMPLATE.format(
        duration=format_ts(duration),
        suggest=suggest,
        transcript=render_transcript(segments),
        extra=extra,
    )


# ------------------------------------------------------------------ 主流程

def build_chapters(
    segments: list[Segment],
    on_progress: "callable | None" = None,
) -> list[dict]:
    """输入转写片段，输出规范化后的章节列表。"""
    if not segments:
        raise LLMError("转写结果为空，无法分章节。")

    total_chars = sum(len(s.text) for s in segments)
    target = settings.chapter_target_chars
    overlap = settings.chunk_overlap_chars

    if total_chars <= target:
        if on_progress:
            on_progress(65, "正在分析内容并划分章节…")
        raw = _call_llm(segments)
    else:
        chunks = split_segments(segments, target, overlap)
        if on_progress:
            on_progress(65, f"内容较长，分 {len(chunks)} 段分析…")
        raw = []
        for i, chunk in enumerate(chunks, 1):
            if on_progress:
                on_progress(65 + int(15 * i / len(chunks)), f"分析第 {i}/{len(chunks)} 段…")
            try:
                part = _call_llm(
                    chunk,
                    extra=f"注意：这只是视频的第 {i}/{len(chunks)} 段切片，"
                    f"只需为这一段内容划分章节，不要试图覆盖全片。\n",
                )
            except LLMError:
                # 单段失败不应让整条管线崩掉：跳过这一段，其余章节照常产出
                continue
            raw.extend(part)

    if not raw:
        raise LLMError("模型未能产出任何章节。请检查模型输出能力或更换模型后重试。")

    return normalize_chapters(raw, segments)


def _call_llm(segments: list[Segment], extra: str = "") -> list[dict]:
    llm = get_llm()
    data = llm.chat_json(
        SYSTEM_PROMPT,
        _build_user_prompt(segments, extra),
        temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens,
        # purpose 会随用量一起记账，用户才能看出钱花在「分章节」还是「导图」
        purpose="分章节" if not extra else "章节归纳",
    )
    chapters = data.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise LLMError("模型返回的 JSON 中缺少有效的 chapters 数组。")
    return chapters


# ------------------------------------------------------------------ 规范化

def normalize_chapters(raw: list[dict], segments: list[Segment]) -> list[dict]:
    """把模型输出的原始章节清洗成可直接入库、可直接跳转的结构。

    处理顺序：吸附时间戳 -> 过滤垃圾 -> 按时序排序去重 -> 合并过短章节 -> 收尾补边。
    """
    duration = segments[-1].end if segments else 0.0
    cleaned: list[dict] = []

    for item in raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", 0))
        except (TypeError, ValueError):
            continue

        # 防线 2：吸附到真实的语音起点
        start = snap_timestamp(start, segments)
        end = snap_timestamp(end, segments)
        if end <= start:
            end = _next_segment_start(start, segments, duration)

        summary = str(item.get("summary") or "").strip()
        kp = item.get("key_points") or []
        if isinstance(kp, str):
            kp = [kp]
        key_points = [str(x).strip() for x in kp if str(x).strip()][:4]

        cleaned.append(
            {"title": title, "start": start, "end": end, "summary": summary, "key_points": key_points}
        )

    if not cleaned:
        raise LLMError("清理后没有剩下任何有效章节，请重试或换用更强的模型。")

    # 防线 3：时序排序 + 去重（同一起点只保留第一个）
    cleaned.sort(key=lambda c: c["start"])
    deduped: list[dict] = []
    for c in cleaned:
        if deduped and abs(c["start"] - deduped[-1]["start"]) < 0.01:
            continue
        deduped.append(c)

    # 首尾补边：保证从 0 开始、到视频结束
    deduped[0]["start"] = 0.0
    if deduped[-1]["end"] < duration:
        deduped[-1]["end"] = round(duration, 2)

    # 相邻章节首尾相接，消除空隙与重叠
    for i in range(len(deduped) - 1):
        deduped[i]["end"] = deduped[i + 1]["start"]

    # 合并过短的章节
    merged: list[dict] = [deduped[0]]
    for c in deduped[1:]:
        prev = merged[-1]
        if c["end"] - c["start"] < MIN_CHAPTER_SEC and prev["end"] - prev["start"] >= MIN_CHAPTER_SEC:
            prev["end"] = c["end"]
            if c["summary"]:
                prev["summary"] = (prev["summary"] + " " + c["summary"]).strip()
            prev["key_points"] = (prev["key_points"] + c["key_points"])[:4]
        else:
            merged.append(c)

    # 若合并后首章仍然过短（整片太短的情况），保留原样，不做二次处理
    for i, c in enumerate(merged):
        c["idx"] = i
        c["start"] = round(c["start"], 2)
        c["end"] = round(c["end"], 2)

    return merged


def _next_segment_start(t: float, segments: list[Segment], duration: float) -> float:
    """找到 strictly 大于 t 的第一个片段起点，找不到就用视频总时长兜底。"""
    for s in segments:
        if s.start > t + 0.01:
            return s.start
    return duration
