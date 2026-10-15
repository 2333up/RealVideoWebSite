"""把章节结构升维成一张可导航的思维导图。

设计取舍：为什么不直接拿转写稿生成导图？
    - 转写稿动辄上万字，token 成本高、模型容易顾此失彼
    - 章节已经过时间戳校验，导图直接继承这些「干净」的时间点，
      等于复用了一遍防幻觉的成果，准确性和成本都更优

导图中每个节点都可以带 start 时间戳；没有自己独立时间点的节点
（例如纯分类节点）会继承最近子节点的 start，点击时跳转到对应位置。
"""

from __future__ import annotations

from core.config import settings
from providers.llm import LLMError, get_llm

MAX_DEPTH = 3          # 根节点算第 0 层，实际是「中心主题 -> 主分支 -> 子分支」
MAX_CHILDREN = 7       # 每层最多子节点数，超过会让导图难以阅读


SYSTEM_PROMPT = """你是一位知识结构化专家，擅长把线性内容重组成层次清晰的思维导图。

任务：根据视频的章节信息，生成一棵思维导树。

严格要求：
1. 只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。
2. 结构：{"label": "...", "start": 0, "children": [{"label": "...", "start": 0, "children": [...]}]}
3. 根节点 label 是整支视频的核心主题（不超过 15 字）。
4. 第 1 层子节点按「内容模块 / 主题板块」划分，不超过 7 个。
5. 第 2 层可以把模块拆成更细的知识点，层数总共不超过 3 层。
6. 每个节点的 label 不超过 15 个字，要具体、有信息量，
   禁止出现「主要内容」「相关介绍」「其他」这类空话。
7. **start 字段填该节点内容首次出现的秒数，必须是整数**；
   可以从所给章节的时间范围中选取，不要超出该章节的范围。
   纯分类、没有对应具体时段的节点，start 填 null。
8. 不要照抄章节标题，要做真正的归纳与重组——导图体现的是知识结构，不是目录。"""


USER_TEMPLATE = """视频主题：{title}

章节信息如下（start / end 单位为秒）：

{chapters}

请生成思维导图 JSON。"""


def _render_chapters(chapters: list[dict]) -> str:
    lines = []
    for c in chapters:
        kp = "；".join(c.get("key_points") or [])
        lines.append(
            f"- [{c['start']:.0f}s - {c['end']:.0f}s] {c['title']}\n"
            f"  摘要：{c.get('summary') or '（无）'}\n"
            f"  要点：{kp or '（无）'}"
        )
    return "\n".join(lines)


def build_mindmap(
    chapters: list[dict],
    video_title: str = "",
    on_progress: "callable | None" = None,
) -> dict:
    """输入规范化章节，输出思维导图树。"""
    if not chapters:
        raise LLMError("尚未生成章节，无法构建思维导图。")

    if on_progress:
        on_progress(85, "正在构建思维导图…")

    llm = get_llm()
    data = llm.chat_json(
        SYSTEM_PROMPT,
        USER_TEMPLATE.format(title=video_title or "未命名视频", chapters=_render_chapters(chapters)),
        temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens,
        purpose="思维导图",
    )

    if "label" not in data:
        raise LLMError("模型返回的 JSON 缺少根节点 label。")

    return normalize_tree(data, chapters)


# ------------------------------------------------------------------ 规范化

def _chapter_bounds(chapters: list[dict]) -> list[tuple[float, float]]:
    return [(float(c["start"]), float(c["end"])) for c in chapters]


def _clamp_to_chapters(t: float | None, bounds: list[tuple[float, float]]) -> float | None:
    """把节点时间戳约束到某个真实章节区间内。

    模型偶尔会给出越界的秒数，这里把它拉近到最近的章节起点，
    保证点击导图节点时一定跳到视频里真实存在的位置。
    """
    if t is None:
        return None
    try:
        t = float(t)
    except (TypeError, ValueError):
        return None
    if not bounds:
        return max(0.0, t)

    overall_start, overall_end = bounds[0][0], bounds[-1][1]
    if t < overall_start:
        return overall_start
    if t > overall_end:
        return overall_end

    # 若已落在某个章节内，直接采用
    for s, e in bounds:
        if s <= t <= e:
            return t
    # 落在章节缝隙里：吸附到最近的章节起点
    return min(bounds, key=lambda b: abs(b[0] - t))[0]


def normalize_tree(tree: dict, chapters: list[dict]) -> dict:
    """递归清洗导图：限深、限宽、去空、校正时间戳、给空节点继承子节点时间。"""
    bounds = _chapter_bounds(chapters)

    def walk(node: dict, depth: int) -> dict | None:
        if not isinstance(node, dict):
            return None
        label = str(node.get("label") or "").strip()
        if not label:
            return None

        out: dict = {"label": label[:40], "start": _clamp_to_chapters(node.get("start"), bounds)}

        children_raw = node.get("children") or []
        if not isinstance(children_raw, list):
            children_raw = []

        if depth < MAX_DEPTH:
            kids = []
            for child in children_raw[:MAX_CHILDREN]:
                cleaned = walk(child, depth + 1)
                if cleaned:
                    kids.append(cleaned)
            if kids:
                out["children"] = kids

        # 分类节点没有自己的时间点时，继承第一个子节点的时间，
        # 这样点击任何节点都能跳转，不会出现「点了没反应」
        if out.get("start") is None:
            kids = out.get("children") or []
            for k in kids:
                if k.get("start") is not None:
                    out["start"] = k["start"]
                    break

        return out

    cleaned = walk(tree, 0)
    if not cleaned:
        raise LLMError("思维导图清洗后为空，请重试。")
    # 根节点兜底：至少要从 0 秒开始
    if cleaned.get("start") is None:
        cleaned["start"] = 0.0
    return cleaned


def flatten_tree(tree: dict) -> list[dict]:
    """把树压平成带层级的列表，供前端做「导图节点 <-> 章节」的联动查找。"""
    out: list[dict] = []

    def walk(node: dict, depth: int, path: str):
        cur_path = f"{path}/{node['label']}" if path else node["label"]
        out.append(
            {
                "label": node["label"],
                "start": node.get("start"),
                "depth": depth,
                "path": cur_path,
            }
        )
        for c in node.get("children") or []:
            walk(c, depth + 1, cur_path)

    walk(tree, 0, "")
    return out
