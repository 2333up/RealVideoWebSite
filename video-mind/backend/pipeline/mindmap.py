"""把章节结构升维成一张可导航的思维导图。

设计取舍：为什么不直接拿转写稿生成导图？
    - 转写稿动辄上万字，token 成本高、模型容易顾此失彼
    - 章节已经过时间戳校验，导图直接继承这些「干净」的时间点，
      等于复用了一遍防幻觉的成果，准确性和成本都更优

导图中每个节点都可以带 start 时间戳；没有自己独立时间点的节点
（例如纯分类节点）会继承最近子节点的 start，点击时跳转到对应位置。

每个节点都有一个 **稳定的 id**（`nd0` / `nd1` …）。这是后来支持「手工编辑导图」
的前提：没有 id 就只能靠「第几个子节点」这种位置来指代节点，用户改一次文案、
加一个兄弟节点，之前生成的章节就会认错人。
"""

from __future__ import annotations

import itertools

from core.config import settings
from providers.llm import LLMError, get_llm

MAX_DEPTH = 3          # 根节点算第 0 层，实际是「中心主题 -> 主分支 -> 子分支」
MAX_CHILDREN = 7       # 每层最多子节点数，超过会让导图难以阅读
MAX_LABEL = 40         # 节点文案上限，与提示词里的「不超过 15 字」不冲突（兜底）

#: 节点缩放系数的允许区间。放大到 2 倍还能读，再大就会把整张图撑爆。
MIN_SCALE = 0.8
MAX_SCALE = 2.0


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
    """递归清洗导图：限深、限宽、去空、校正时间戳、给空节点继承子节点时间。

    顺带给每个节点分配稳定 id——见本模块顶部说明：没有 id 就无法支持
    「用户手工编辑导图后章节还能对上号」。
    """
    bounds = _chapter_bounds(chapters)
    ids = itertools.count()
    next_id = lambda: f"nd{next(ids)}"  # noqa: E731  局部闭包，比传参更省事

    def walk(node: dict, depth: int) -> dict | None:
        if not isinstance(node, dict):
            return None
        label = str(node.get("label") or "").strip()
        if not label:
            return None

        out: dict = {
            "id": next_id(),
            "label": label[:MAX_LABEL],
            "start": _clamp_to_chapters(node.get("start"), bounds),
        }

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


# ------------------------------------------------------------------ 树操作
#
# 下面这组函数只做一件事：让用户能在导图上「增删改节点」，
# 且每次改动都能被章节同步逻辑准确追踪。
#
# 约定：这些函数**原地修改传入的树**（调用方负责先 deepcopy，
# 否则 SQLAlchemy 检测不到 JSON 列的变化，改动会静默丢失——
# 这是个不报错、只是「保存了但没生效」的坑）。

def _next_free_id(used: set[str]) -> str:
    for i in itertools.count():
        cand = f"nd{i}"
        if cand not in used:
            return cand
    raise RuntimeError("不可能走到这里")  # pragma: no cover


def iter_nodes(tree: dict) -> list[tuple[dict, str | None, int]]:
    """按深度优先展开成 [(节点, 父id, 深度)]。"""
    out: list[tuple[dict, str | None, int]] = []

    def walk(node: dict, parent: str | None, depth: int):
        if not isinstance(node, dict):
            return
        out.append((node, parent, depth))
        for kid in node.get("children") or []:
            walk(kid, node.get("id"), depth + 1)

    walk(tree, None, 0)
    return out


def collect_ids(tree: dict) -> set[str]:
    return {n.get("id") for n, _p, _d in iter_nodes(tree) if n.get("id")}


def ensure_node_ids(tree: dict) -> dict:
    """给缺 id 的节点补上 id，并消除重复 id。返回新树（不改动入参）。

    历史数据没有 id：analyze 流程在旧版本生成的导图里每个节点只有 label/start，
    不补 id 的话这些视频就永远用不了编辑功能。
    """
    used: set[str] = set()

    def walk(node: dict) -> dict:
        out = {k: v for k, v in node.items() if k != "children"}
        nid = str(out.get("id") or "").strip()
        if not nid or nid in used:
            nid = _next_free_id(used)
        used.add(nid)
        out["id"] = nid
        kids = node.get("children")
        if isinstance(kids, list):
            out["children"] = [walk(k) for k in kids if isinstance(k, dict)]
        return out

    return walk(tree)


def find_node(tree: dict, node_id: str) -> dict | None:
    for node, _parent, _depth in iter_nodes(tree):
        if node.get("id") == node_id:
            return node
    return None


def node_depth(tree: dict, node_id: str) -> int | None:
    for node, _parent, depth in iter_nodes(tree):
        if node.get("id") == node_id:
            return depth
    return None


def clamp_scale(raw: object) -> float:
    """把缩放系数约束到 [MIN_SCALE, MAX_SCALE]。非法值一律按 1.0 处理。"""
    try:
        v = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 1.0
    return max(MIN_SCALE, min(MAX_SCALE, round(v, 2)))


def set_node(
    tree: dict,
    node_id: str,
    *,
    label: str | None = None,
    start: float | None = None,
    scale: float | None = None,
) -> bool:
    """修改单个节点的文案 / 时间戳 / 缩放。返回是否命中。"""
    node = find_node(tree, node_id)
    if node is None:
        return False
    if label is not None:
        text = str(label).strip()
        if text:
            node["label"] = text[:MAX_LABEL]
    if start is not None:
        node["start"] = float(start)
    if scale is not None:
        node["scale"] = clamp_scale(scale)
    return True


def add_child(
    tree: dict,
    parent_id: str,
    label: str = "新节点",
    start: float | None = None,
    scale: float = 1.0,
) -> str | None:
    """在指定节点下挂一个子节点，返回新节点 id；超限或父节点不存在时返回 None。

    用户虽然可以手工加节点，但仍然要受 MAX_DEPTH / MAX_CHILDREN 约束——
    没有约束的树会在几下点击之后变成一张谁也读不懂的蜘蛛网。
    """
    parent = find_node(tree, parent_id)
    if parent is None:
        return None
    depth = node_depth(tree, parent_id) or 0
    if depth + 1 > MAX_DEPTH:
        return None
    kids = parent.get("children")
    if not isinstance(kids, list):
        kids = []
        parent["children"] = kids
    if len(kids) >= MAX_CHILDREN:
        return None

    nid = _next_free_id(collect_ids(tree))
    kids.append(
        {
            "id": nid,
            "label": str(label).strip()[:MAX_LABEL] or "新节点",
            "start": start,
            "scale": clamp_scale(scale),
        }
    )
    return nid


def clear_start(tree: dict, node_id: str) -> bool:
    """清掉某个节点的时间戳（对应「删掉由它生成的章节」）。"""
    node = find_node(tree, node_id)
    if node is None:
        return False
    node["start"] = None
    return True


def remove_node(tree: dict, node_id: str) -> bool:
    """删除节点（连带其整棵子树）。根节点不允许删除——删了树就没了。"""
    if tree.get("id") == node_id:
        return False

    def walk(node: dict) -> bool:
        kids = node.get("children")
        if not isinstance(kids, list):
            return False
        for i, kid in enumerate(kids):
            if not isinstance(kid, dict):
                continue
            if kid.get("id") == node_id:
                kids.pop(i)
                return True
            if walk(kid):
                return True
        return False

    return walk(tree)


def flatten_tree(tree: dict) -> list[dict]:
    """把树压平成带层级的列表，供前端做「导图节点 <-> 章节」的联动查找。"""
    out: list[dict] = []

    def walk(node: dict, depth: int, path: str):
        cur_path = f"{path}/{node['label']}" if path else node["label"]
        out.append(
            {
                "id": node.get("id"),
                "label": node["label"],
                "start": node.get("start"),
                "scale": clamp_scale(node.get("scale")),
                "depth": depth,
                "path": cur_path,
            }
        )
        for c in node.get("children") or []:
            walk(c, depth + 1, cur_path)

    walk(tree, 0, "")
    return out
