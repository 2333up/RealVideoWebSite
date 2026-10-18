"""用「这一段的原文」重写摘要。

为什么单独一个模块：章节摘要此前是模型在**分章节那一刻**顺带写的。
它当时按自己挑的区间写没问题，但之后区间被同步（导图节点改了时间、
章节边界重排）过，摘要就和区间对不上了；更常见的是它顺手把整章的概括
贴到某个小节上，读起来像「用整章目录冒充这一段的内容」。

这里只做一件事：给定 [start, end]，**只喂这段原文**，让模型只依据它写摘要。
没有原文（比如视频开头几分钟没人说话）就返回空，绝不凭标题编。
"""

from __future__ import annotations

from core.config import settings
from providers.llm import LLMError, get_llm

#: 单次喂给模型的原文上限（字符）。一小时的章节可能有几万字，
#: 全塞进去既费钱又容易让模型只顾开头；超了就从中间截断，保留头尾。
MAX_CHARS = 6000

SYSTEM_PROMPT = """你是一位视频内容编辑。用户会给你**一段**视频的逐字稿（带时间戳）、
这段的标题和它的起止时间。请只依据这段原文写摘要。

严格要求：
1. 只输出一个 JSON 对象，不要解释文字，不要 markdown 代码块：
   {"summary": "...", "key_points": ["...", "..."]}
2. summary 100-200 字：说清**这一段**讲了什么、结论是什么。
   - 按原文顺序写，不要写成目录；
   - **不要**引入原文里没出现的内容，也不要概括视频的其他部分；
   - 如果原文是问答，写清「问什么、答什么」。
3. key_points 2-4 条，每条不超过 30 字，必须是原文里真实提到的具体信息
   （数据、名称、步骤、结论），不要和 summary 重复同一句话。
4. 原文里没有可用内容（只有寒暄、语气词、听不清）时，summary 填空字符串，
   key_points 填空数组——**不要编**。"""


def render_slice(segments: list[dict] | list, start: float, end: float) -> str:
    """取 [start, end] 内的片段，渲染成带时间戳的原文。"""
    lines: list[str] = []
    for s in segments:
        try:
            seg_start = float(s["start"])
            seg_text = str(s.get("text") or "").strip()
        except (KeyError, TypeError, ValueError):
            continue
        if not seg_text:
            continue
        # 与区间有交集就算这一段属于本章；用 end 判断起点，避免卡边界
        seg_end = float(s.get("end") or seg_start)
        if seg_end <= start or seg_start >= end:
            continue
        lines.append(f"[{_ts(seg_start)}] {seg_text}")
    return "\n".join(lines)


def _ts(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _clip(text: str, limit: int = MAX_CHARS) -> str:
    """超长时保留头 65% + 尾 35%，中间标出来。

    只留开头会让模型以为整段就在讲第一件事；留点头尾，它至少知道
    「这段从 A 讲到了 B」。
    """
    if len(text) <= limit:
        return text
    head = int(limit * 0.65)
    tail = limit - head
    return f"{text[:head]}\n……（中间省略 {len(text) - limit} 字）……\n{text[-tail:]}"


def rewrite_summary(
    title: str, segments: list[dict] | list, start: float, end: float
) -> dict:
    """用 [start, end] 的原文重写一条摘要。

    返回 {"summary": str, "key_points": list[str]}；原文为空时返回空值，不调模型。

    失败**重试一次**：实测十几个章节里会偶发一条 JSON 解析失败
    （模型把思考过程写太长、正文被截断）。单次失败就让整批停下来太亏，
    重试一次的代价远小于让用户手动再点一遍。
    """
    body = render_slice(segments, start, end)
    if not body.strip():
        return {"summary": "", "key_points": []}

    user = (
        f"标题：{title}\n"
        f"时间范围：{_ts(start)} – {_ts(end)}\n\n"
        f"这一段逐字稿如下：\n{_clip(body)}"
    )

    last_error: LLMError | None = None
    for _attempt in range(2):
        try:
            return _call_llm(user)
        except LLMError as exc:
            last_error = exc
    raise last_error or LLMError("重写摘要失败")


def _call_llm(user: str) -> dict:
    llm = get_llm()
    data = llm.chat_json(
        SYSTEM_PROMPT,
        user,
        temperature=settings.llm_temperature,
        # 必须跟设置页一致（默认 16384）：DeepSeek 这类模型开会先输出一段思考过程，
        # 给 800 会在正文前就被截断，表现为「JSON 解析失败」——别自己写死小值。
        max_tokens=settings.llm_max_tokens,
        # 用量账本里能看出这钱花在「重写摘要」上，而不是分章节
        purpose="重写摘要",
    )

    summary = str(data.get("summary") or "").strip()
    points = [
        str(p).strip()
        for p in (data.get("key_points") or [])
        if str(p).strip()
    ][:4]
    if not summary and not points:
        raise LLMError("模型没有给出可用摘要，请重试。")
    return {"summary": summary, "key_points": points}
