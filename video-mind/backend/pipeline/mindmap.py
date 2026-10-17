"""把章节结构升维成一张可导航的思维导图。

设计取舍：为什么不直接拿转写稿生成导图？
    - 转写稿动辄上万字，token 成本高、模型容易顾此失彼
    - 章节已经过时间戳校验，导图直接继承这些「干净」的时间点，
      等于复用了一遍防幻觉的成果，准确性和成本都更优

**时间戳的三条铁律**（踩过坑才定下来）：

    1. 只有**叶子节点**才持有 start。分类节点不存自己的时间——
       它的时间就是第一个子节点的时间。以前让分类节点「继承」子节点的时间，
       结果大纲里分类和它的第一个子节点并排显示同一个时间点，
       看着像重复数据；更糟的是章节同步会把这一对都生成章节，区间直接交叉。
    2. **同一父节点下的子节点，时间戳必须互不相同且严格递增**。
       否则大纲从上往下读会出现时间回跳，章节排序也就跟着错了。
    3. **章节区间互不交叉**：按 start 排序后，每条的 end 就是下一条的 start。

每个节点都有一个 **稳定的 id**（`nd0` / `nd1` …）。这是后来支持「手工编辑导图」
的前提：没有 id 就只能靠「第几个子节点」这种位置来指代节点，用户改一次文案、
加一个兄弟节点，之前生成的章节就会认错人。
"""

from __future__ import annotations

import itertools

from providers.llm import LLMError

MAX_DEPTH = 3          # 根节点算第 0 层，实际是「中心主题 -> 主分支 -> 子分支」
MAX_CHILDREN = 7       # 每层最多子节点数，超过会让导图难以阅读
MAX_LABEL = 40         # 节点文案上限，与提示词里的「不超过 15 字」不冲突（兜底）

#: 节点缩放系数的允许区间。放大到 2 倍还能读，再大就会把整张图撑爆。
MIN_SCALE = 0.8
MAX_SCALE = 2.0

#: 同级相邻节点的最小时间间隔（秒）。
#: 界面上的时间戳精确到秒，小于 1 秒的差异用户根本看不出来，
#: 取 1 秒既保证「各不相同」又不改变内容归属。
MIN_TIME_STEP = 1.0


# 旧的 LLM 重组方案已移除：它生成的多层分类好看，但节点和章节对不上号。
# 「一章一节点」的确定性构造见 build_mindmap。


def build_mindmap(
    chapters: list[dict],
    video_title: str = "",
    on_progress: "callable | None" = None,
) -> dict:
    """由章节**直接**构造导图：一章一个叶子节点，与章节列表一一对应。

    为什么不再让大模型重组层次（2026-10-17 定下的规矩）：
        以前这一步会再调一次 LLM 把章节重新编排成多层分类——好看，
        但节点和章节完全对不上号：大纲里 21 个节点对着 7 条章节，
        用户没法回答「这个节点是哪条章节」。而「章节总结」是用户
        阅读导图时的参照物，一一对应是它的前提。

    所以这一步是纯确定性的：根节点 = 视频标题，每个章节挂一个叶子，
    标题与时间戳原样搬过来。省一次 LLM 调用，也省掉一整类幻觉问题。
    分析完成后的手工编辑不要求保持对应关系（见 AGENTS/需求记录）。
    """
    if not chapters:
        raise LLMError("尚未生成章节，无法构建思维导图。")

    if on_progress:
        on_progress(85, "正在构建思维导图…")

    tree: dict = {
        "label": video_title or "章节导图",
        "children": [
            {"label": str(c["title"]), "start": c["start"]} for c in chapters
        ],
    }
    return normalize_tree(tree, chapters)


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

        return out

    cleaned = walk(tree, 0)
    if not cleaned:
        raise LLMError("思维导图清洗后为空，请重试。")

    # 根节点同样是「分类节点」：它覆盖整支视频，不该占用 0 秒这个点，
    # 否则章节同步会把它也当成一条章节，和第一条真实章节撞在一起。
    # 点击根节点时前端会用 first_timed_descendant 找到开头。
    enforce_time_order(cleaned)

    # 例外：退化成单节点的导图（没有任何子节点）里，根就是唯一的叶子，
    # 此时给它 0 秒，保证点它还能跳到视频开头。
    if not cleaned.get("children") and cleaned.get("start") is None:
        cleaned["start"] = 0.0
    return cleaned


def enforce_time_order(tree: dict) -> dict:
    """把整棵树的时间戳整理成「同级严格递增、分类不持时间」的形态。

    自底向上做两件事，顺序不能反：

    一、同级子节点按时间排序，并把相邻两个拉开至少 MIN_TIME_STEP。
        模型偶尔会给同级的两个节点同一个时间点，不改的话大纲里就会
        出现「上下两行时间一样」，章节排序也失去依据。

    二、处理完子节点后，**清掉有子节点的那个节点自己的 start**。
        分类的时间就是它第一个子节点的时间，存一份只会造成重复显示
        和章节区间交叉。点击分类时前端会向下找第一个有时间的后代来跳转。

    返回同一棵树（原地修改），方便链式调用。
    """
    def walk(node: dict) -> None:
        kids = [k for k in (node.get("children") or []) if isinstance(k, dict)]
        if not kids:
            return  # 叶子：保留自己的时间

        for k in kids:
            walk(k)

        # 有时间的排前面并按时间升序，没时间的保持原序排在后面
        timed = [k for k in kids if k.get("start") is not None]
        untimed = [k for k in kids if k.get("start") is None]
        timed.sort(key=lambda k: float(k["start"]))

        prev: float | None = None
        for k in timed:
            t = float(k["start"])
            if prev is not None and t <= prev:
                t = prev + MIN_TIME_STEP
            k["start"] = round(t, 2)
            prev = t

        ordered = timed + untimed
        if ordered is not kids:
            node["children"] = ordered
        else:
            node["children"] = ordered

        # 分类节点不持有自己的时间
        node.pop("start", None)
        node.pop("pinned", None)

    walk(tree)
    return tree


def first_timed_descendant(node: dict) -> float | None:
    """分类节点自身没有时间，取它第一个带时间的后代——点击分类时的跳转目标。"""
    for kid in node.get("children") or []:
        if not isinstance(kid, dict):
            continue
        s = kid.get("start")
        if s is not None:
            try:
                return float(s)
            except (TypeError, ValueError):
                continue
        deeper = first_timed_descendant(kid)
        if deeper is not None:
            return deeper
    return None


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
