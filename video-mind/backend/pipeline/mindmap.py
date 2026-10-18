"""把章节结构升维成一张可导航的思维导图。

设计取舍：为什么不直接拿转写稿生成导图？
    - 转写稿动辄上万字，token 成本高、模型容易顾此失彼
    - 章节已经过时间戳校验，导图直接继承这些「干净」的时间点，
      等于复用了一遍防幻觉的成果，准确性和成本都更优

**层级由模型重组，深度不限**（2026-10-18 改回）：
    曾经为了「节点与章节一一对应」把导图压成两层（根 + N 个章节叶子），
    结果知识结构被压没了：一支课被压成 16 个平铺的章节名，
    看不出谁是谁的子话题。导图体现的是**知识结构**，不是目录，
    所以恢复让模型按内容重组多层分类。代价是节点与章节不再一一对应——
    这是明确接受的取舍：章节同步早已下线，两者本就是互相独立的两份产物。

**每个节点带两个属性**：时间范围（start / end）与 1-2 句摘要（summary）。
    分类节点没有自己的时段，两者都为 null，界面上就不显示时间——
    「节点不一定都要显示时间戳」是刻意的设计，不是数据缺失。

**两种节点**（2026-10-18 加了第二种）：
    - 普通节点：挂时间轴，参与排序 / 瓜分 / 父节点派生；
    - 笔记节点（kind="note"）：用户自己补的注记，**不挂时间轴**。
      它没有时间范围，父节点的时间范围也不会因为它而改变——
      这是用户明确定的要求（见 NOTE_KIND 的注释）。

**时间戳的三条铁律**（踩过坑才定下来）：

    1. **有子节点的节点，时间范围由子节点算出来**（derive_parent_ranges）：
       起点 = 最早的那个子节点起点，终点 = 最晚的那个子节点终点，
       也就是「第一个子节点的开始 → 最后一个子节点的结束」。
       它不再接受用户手填——分支的范围就是它包含内容的范围，允许另填一份，
       就能造出「分支 3:00-4:00，而它下面的子话题在 1:00/2:00/5:00」这种自相矛盾的数据。
       （2026-10-18 用户再次强调；此前「分类节点可手工设时间」的规则已作废。）
    2. **同一父节点下的子节点，时间戳必须互不相同且严格递增**。
       否则大纲从上往下读会出现时间回跳，章节排序也就跟着错了。
    3. **章节区间互不交叉**：按 start 排序后，每条的 end 就是下一条的 start。

每个节点都有一个 **稳定的 id**（`nd0` / `nd1` …）。这是后来支持「手工编辑导图」
的前提：没有 id 就只能靠「第几个子节点」这种位置来指代节点，用户改一次文案、
加一个兄弟节点，之前生成的章节就会认错人。
"""

from __future__ import annotations

import itertools

from core.config import settings
from providers.llm import LLMError, get_llm

#: 深度上限只是防跑飞的护栏（模型偶尔会造出十几层空壳），不是设计上的层数限制。
#: 需求要的是「嵌套深度不限」——内容需要几层就几层，这里给的余量远超实际需要。
MAX_DEPTH = 8
MAX_CHILDREN = 7       # 每层最多子节点数，超过会让导图难以阅读
MAX_LABEL = 40         # 节点文案上限，与提示词里的「不超过 15 字」不冲突（兜底）
#: 摘要上限。节点上只显示 1-2 句，超长的截断——导图不是正文。
MAX_SUMMARY = 120

#: 节点笔记（Markdown）上限。它不是正文编辑器，但也不该短到写不下一篇读书笔记。
MAX_NOTE = 20000

#: 节点缩放系数的允许区间。放大到 2 倍还能读，再大就会把整张图撑爆。
MIN_SCALE = 0.8
MAX_SCALE = 2.0

#: 同级相邻节点的最小时间间隔（秒）。
#: 界面上的时间戳精确到秒，小于 1 秒的差异用户根本看不出来，
#: 取 1 秒既保证「各不相同」又不改变内容归属。
MIN_TIME_STEP = 1.0

#: 「笔记节点」的类型标记（2026-10-18 新增）。
#:
#: 它存在的理由：有些节点是用户自己补的注记（自己的理解、待办、和视频无直接
#: 对应关系的补充说明），硬给它挂一个时间范围只会污染时间轴。所以：
#:   - 它自己没有时间范围，也不接受手填；
#:   - 它**不参与**兄弟时间排序、区间瓜分与父节点派生——
#:     父节点的时间范围不会因为多了一个笔记而改变；
#:   - 它下面的子节点同样是笔记（整支退出时间轴），避免出现
#:     「这一支不影响父节点，但点它能跳时间」的自相矛盾状态。
NOTE_KIND = "note"


def is_note(node: object) -> bool:
    """这个节点是不是笔记节点（不挂时间轴的那种）。"""
    return isinstance(node, dict) and node.get("kind") == NOTE_KIND


def _kids(node: dict) -> list[dict]:
    return [k for k in (node.get("children") or []) if isinstance(k, dict)]


def _timed_kids(node: dict) -> list[dict]:
    """真正挂在时间轴上的子节点：笔记节点整支被排除。"""
    return [k for k in _kids(node) if not is_note(k)]


SYSTEM_PROMPT = """你是一位知识结构化专家，擅长把线性内容重组成层次清晰的思维导图。

任务：根据视频的章节信息，生成一棵**多层**思维导树。

严格要求：
1. 只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。
2. 结构：{"label": "...", "start": 0, "end": 120, "summary": "...", "children": [...]}
3. 根节点 label 是整支视频的核心主题（不超过 15 字）。
4. **层数不限**：内容需要几层就展开几层。不要为了「好看」把内容压成两层，
   也不要为了凑层级把一句话拆成空壳节点。每层子节点不超过 7 个。
5. **标题必须来自原文**：label 优先沿用章节标题与要点里的原话，
   不要自造「主要内容」「相关介绍」「其他」这类空话，也不要把原意改写走样。
   每个 label 不超过 15 个字。
6. **start / end 填该节点内容在视频里的时间范围（秒，整数）**，
   必须落在所给章节的时间范围内。纯分类、没有对应具体时段的节点，两者都填 null。
   同一父节点下的子节点按时间先后排列：**前一个的 end 就是后一个的 start，不要重叠**；
   拿不准就按顺序把父节点这段分给几个子节点，别让它们全都覆盖整段。
7. **summary 用 1-2 句话讲清楚这个节点「讲了什么、结论是什么」**，不超过 60 字。
   它要和父节点的 summary 有信息增量，不要只是复述 label。
8. 允许归纳与重组，但**每个节点必须能回溯到原始章节**：
   一个节点下的内容必须真的来自它所标注的时间范围，不要凭空造节点。"""


USER_TEMPLATE = """视频主题：{title}

章节信息如下（start / end 单位为秒）：

{chapters}

请生成思维导图 JSON。"""


def _render_chapters(chapters: list[dict]) -> str:
    """把章节渲染成提示词里的素材：标题 + 时间范围 + 摘要 + 要点。

    摘要和要点是模型写节点 summary 的直接来源——只给标题的话，
    模型只能靠标题字面意思编摘要，那就又回到「复述 label」了。
    """
    lines = []
    for c in chapters:
        kp = "；".join(c.get("key_points") or [])
        lines.append(
            f"- [{c['start']:.0f}s - {c['end']:.0f}s] {c['title']}\n"
            f"  摘要：{c.get('summary') or '（无）'}\n"
            f"  要点：{kp or '（无）'}"
        )
    return "\n".join(lines)


def _fallback_tree(chapters: list[dict], video_title: str) -> dict:
    """模型不可用时的兜底：一章一个叶子，标题与时间范围原样搬过来。

    走到这里说明转写和分章节已经跑完了，因为导图这一步的失败把整支视频
    打成 failed 是最糟的结局——用户白等十几分钟。所以宁可给一张「目录级」
    的导图，也要让分析收尾成功。
    """
    return {
        "label": video_title or "章节导图",
        "children": [
            {
                "label": str(c["title"]),
                "start": c["start"],
                "end": c.get("end"),
                "summary": str(c.get("summary") or "")[:MAX_SUMMARY],
            }
            for c in chapters
        ],
    }


def build_mindmap(
    chapters: list[dict],
    video_title: str = "",
    on_progress: "callable | None" = None,
) -> dict:
    """输入规范化章节，输出思维导图树（多层，深度不限）。"""
    if not chapters:
        raise LLMError("尚未生成章节，无法构建思维导图。")

    if on_progress:
        on_progress(85, "正在构建思维导图…")

    data: dict | None = None
    try:
        llm = get_llm()
        data = llm.chat_json(
            SYSTEM_PROMPT,
            USER_TEMPLATE.format(
                title=video_title or "未命名视频", chapters=_render_chapters(chapters)
            ),
            temperature=settings.llm_temperature,
            max_tokens=settings.llm_max_tokens,
            purpose="思维导图",
        )
    except Exception:
        data = None

    if not isinstance(data, dict) or "label" not in data:
        # 模型没给出能用的树：退回「一章一叶子」，别让整支视频白跑一趟
        if on_progress:
            on_progress(86, "模型重组未成功，改用章节直译的导图…")
        return normalize_tree(_fallback_tree(chapters, video_title), chapters)

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


def _chapter_end_of(t: float, bounds: list[tuple[float, float]]) -> float | None:
    """t 落在哪个章节里，就返回那个章节的终点——节点缺省 end 时的补值。"""
    for s, e in bounds:
        if s <= t < e:
            return e
    return bounds[-1][1] if bounds else None


def _resolve_range(
    start: float | None,
    end: float | None,
    bounds: list[tuple[float, float]],
) -> tuple[float | None, float | None]:
    """把 (start, end) 洗成一对合法的时间范围。

    end 缺失或不合法时**不在这里补**：补值要等 enforce_time_order 把同级起点
    拉开之后才算得准（兄弟节点的 start 会互相推开），所以统一交给
    _fill_leaf_ranges 收尾。
    """
    s = _clamp_to_chapters(start, bounds)
    if s is None:
        return None, None
    e = _clamp_to_chapters(end, bounds)
    if e is None or e <= s:
        return s, None
    return s, round(e, 2)


def _fill_leaf_ranges(tree: dict, bounds: list[tuple[float, float]]) -> dict:
    """给每个有时间的叶子补上 end（先用所属章节的终点兜底）。

    这只是**初值**：同一个章节下往往挂着好几个叶子，用章节终点补会让它们
    全部结束在同一秒、区间互相重叠。真正的收尾在 partition_children——
    兄弟节点按顺序瓜分父节点的区间。这里先补一个合法值，是为了让
    「父节点派生」有东西可算（父区间 = 子节点并集）。
    """
    def walk(node: dict) -> None:
        if is_note(node):
            return  # 笔记分支整支退出时间轴，不补终点
        kids = _kids(node)
        if kids:
            for k in kids:
                walk(k)
            return
        s = node.get("start")
        if s is None:
            node.pop("end", None)
            return
        e = node.get("end")
        if e is None or float(e) <= float(s):
            e = _chapter_end_of(float(s), bounds)
        if e is None or float(e) <= float(s):
            node.pop("end", None)
        else:
            node["end"] = round(float(e), 2)

    walk(tree)
    return tree


def _needs_refit(kids: list[dict], pstart: float, pend: float) -> bool:
    """这组子节点是否需要重排（瓜分父区间）。

    只认三种「真的坏了」的情况：
      1. 有子节点缺起止、或终点不晚于起点（零长度 / 脏数据）
      2. 有子节点越出父区间（父节点刚被上一轮瓜分重新分配过，子节点身上还挂着旧范围）
      3. 相邻兄弟**重叠**（同一章下所有叶子都结束在章节终点，就是这种）

    **不认「有空档」**：兄弟之间留一段空白是真实信息——那段视频里没有它讲的
    内容。把它均分掉等于凭空捏造时间，比留个洞更糟。
    """
    eps = 0.5
    prev_end: float | None = None
    for k in kids:
        s, e = _num(k.get("start")), _num(k.get("end"))
        if s is None or e is None or e <= s:
            return True
        if s < pstart - eps or e > pend + eps:
            return True
        if prev_end is not None and s < prev_end - eps:
            return True
        prev_end = e
    return False


def partition_children(tree: dict) -> dict:
    """兄弟节点按顺序瓜分父节点的区间。

    **为什么必须做**（2026-10-18 用户报「几乎每个节点的时间都不对」）：
    模型经常只给叶子一个 start、end 填 null。以前拿「所在章节的终点」补 end，
    同一个章节下的兄弟就全部结束在同一秒，大纲里看起来每个节点都跨越整章、
    区间层层重叠；而 enforce_time_order 又会把撞车的起点按 1 秒推开，
    于是出现「00:00–03:06 / 00:01–03:06 / 00:02–03:06」这种一串 1 秒的假区间。

    规则很简单：**子节点按顺序等分父区间**（起止连续、互不重叠）。
    但只在「这组子节点真的坏了」时才动：重叠 / 越界 / 缺起止。
    已经排好、只是兄弟之间留了空档的，原样保留——空档是真实信息
    （那段视频里没有它讲的内容），均分掉等于凭空捏造。

    笔记节点不在这套算法里：它们和视频时间无关，既不参与判定也不参与分配。
    """
    def walk(node: dict) -> None:
        if is_note(node):
            return
        kids = _timed_kids(node)
        if not kids:
            return

        pstart, pend = _num(node.get("start")), _num(node.get("end"))
        if pstart is not None and pend is not None and pend > pstart:
            if _needs_refit(kids, pstart, pend):
                # 等分。只有一个孩子时 step 就是整个父区间——等价于「它继承父区间」。
                # 这里不能偷懒跳过：父节点的区间是**上一轮瓜分刚分配的**，
                # 而子节点身上还挂着更早算出来的宽区间；不覆盖它，
                # 后面的 derive_parent_ranges 会拿这个宽区间把父节点又顶回去
                # （实测表现：父节点被「撑大」成整个章节，兄弟再次重叠）。
                step = (pend - pstart) / len(kids)
                for i, k in enumerate(kids):
                    k["start"] = round(pstart + step * i, 2)
                    k["end"] = round(pstart + step * (i + 1), 2)
                    k.pop("pinned", None)

        for k in _kids(node):
            walk(k)

    walk(tree)
    return tree


def strip_note_times(tree: dict, inside_note: bool = False) -> dict:
    """笔记分支退出时间轴：笔记节点及其所有后代不保留 start / end / pinned。

    「笔记下面的子节点也是笔记」是刻意的：一支注记整体不对应视频里的某一段，
    允许它里面混进带时间的节点，就会造出「这一支不影响父节点范围，
    但点它能跳时间」的自相矛盾状态。
    """
    node = tree
    note = inside_note or is_note(node)
    if note:
        node["kind"] = NOTE_KIND
        node.pop("start", None)
        node.pop("end", None)
        node.pop("pinned", None)
    for kid in _kids(node):
        strip_note_times(kid, note)
    return tree


def normalize_time_layout(
    tree: dict, bounds: list[tuple[float, float]] | None = None
) -> dict:
    """时间布局总入口：清笔记时间 → 排序 → 补叶子终点 → 父节点派生 → 兄弟瓜分 → 再派生。

    顺序不能乱：
      0. 笔记分支先整支摘出时间轴，后面的每一步都不会再看到它；
      1. 排序把「撞车的起点」推开，后面的分组才有确定的先后；
      2. 补叶子终点让每个叶子都有合法区间（否则父区间算不出来）；
      3. 第一次派生给每个父节点一个可用区间，作为「瓜分」的范围；
      4. 瓜分把重叠的兄弟改成首尾相接；
      5. 再派生一次，让父区间与瓜分后的子节点严格一致。
    """
    strip_note_times(tree)
    enforce_time_order(tree)
    _fill_leaf_ranges(tree, bounds or [])
    derive_parent_ranges(tree)
    partition_children(tree)
    derive_parent_ranges(tree)
    return tree


def normalize_tree(tree: dict, chapters: list[dict]) -> dict:
    """递归清洗导图：限深、限宽、去空、校正时间范围、保留摘要。

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

        out: dict = {"id": next_id(), "label": label[:MAX_LABEL]}
        start, end = _resolve_range(node.get("start"), node.get("end"), bounds)
        # 模型不会产出笔记节点，但重新分析／导入外部树时可能带上这个标记，
        # 保留它并清掉时间——笔记不挂时间轴，这是硬约束。
        if is_note(node):
            out["kind"] = NOTE_KIND
            start, end = None, None
        out["start"] = start
        if end is not None:
            out["end"] = end

        summary = str(node.get("summary") or "").strip()
        if summary:
            out["summary"] = summary[:MAX_SUMMARY]

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
    # 时间布局一把梭：排序 → 补叶子终点 → 父节点派生 → 兄弟瓜分区间 → 再派生
    normalize_time_layout(cleaned, bounds)

    # 例外：退化成单节点的导图（没有任何子节点）里，根就是唯一的叶子，
    # 此时给它 0 秒，保证点它还能跳到视频开头。
    if not cleaned.get("children") and cleaned.get("start") is None:
        cleaned["start"] = 0.0
    return cleaned


def enforce_time_order(tree: dict) -> dict:
    """把整棵树的时间戳整理成「同级严格递增 + 父节点范围由子节点决定」。

    自底向上做两件事：

    一、同级子节点按时间排序，并把相邻两个拉开至少 MIN_TIME_STEP。
        模型偶尔会给同级的两个节点同一个时间点，不改的话大纲里就会
        出现「上下两行时间一样」，章节排序也失去依据。

    二、**有子节点的节点，时间范围一律由子节点推出来**（见 derive_parent_ranges）：
        起点 = 第一个子节点的起点，终点 = 最后一个子节点的终点。

        这条是用户定的铁律（2026-10-18 再次强调）：分支的范围就是它包含内容的范围。
        之前允许用户给分类节点另填一份时间，结果是可以造出
        「这条分支从 3:00 讲到 4:00，但它下面三个子话题分别在 1:00 / 2:00 / 5:00」
        这种自相矛盾的数据——章节同步、点击跳转、导图徽章三处会各读各的答案。
        现在父节点的时间只读、只算，前端也不再提供编辑入口。

    返回同一棵树（原地修改），方便链式调用。
    """
    # 先把父节点上的旧值（可能是客户端传来的、也可能是上次算的）覆盖成
    # 子节点当前的真实范围，再排序——否则排序会拿一个错的分支起点当依据
    derive_parent_ranges(tree)

    def walk(node: dict) -> None:
        if is_note(node):
            return  # 笔记分支不参与时间排序
        kids = _kids(node)
        if not kids:
            return  # 叶子：保留自己的时间

        for k in kids:
            walk(k)

        # 排序必须按「有效起点」而不是「自身起点」。
        # 分类节点自己没有 start，按自身起点排它们会被一律甩到最后面——
        # 多层树里分支节点遍地都是，一次排序就把模型排好的层级顺序打乱了。
        # 有效起点 = 自己的 start，没有就向下取第一个有时间的后代，
        # 于是分类节点按它真实覆盖的位置参与排序，原顺序得以保留。
        #
        # 笔记节点不参与这套排序，但**保留它原来的位置**：
        # 它没有时间，按时间排只会被一律甩到末尾——用户把它插在第三个，
        # 一保存就跑到最后，等于「插不进去」。
        slots = [i for i, k in enumerate(kids) if not is_note(k)]
        pairs = [(kids[i], _effective_start(kids[i])) for i in slots]
        timed = [(k, t) for k, t in pairs if t is not None]
        untimed = [k for k, t in pairs if t is None]
        timed.sort(key=lambda pair: pair[1])

        prev: float | None = None
        for k, t in timed:
            if k.get("start") is None:
                prev = t  # 分类节点没有自己的时间，占位但不参与「推开」
                continue
            if prev is not None and t <= prev:
                t = prev + MIN_TIME_STEP
                k["start"] = round(t, 2)
            prev = t

        ordered = [k for k, _t in timed] + untimed
        out = list(kids)
        for slot, k in zip(slots, ordered):
            out[slot] = k
        node["children"] = out

    walk(tree)
    # 排序可能把子节点往后推了，父节点范围要按推完的结果再算一遍
    derive_parent_ranges(tree)
    return tree


def derive_parent_ranges(tree: dict) -> dict:
    """父节点的时间范围 = 它所有子节点的并集区间。

    起点取**最早**的子节点起点，终点取**最晚**的子节点终点。
    子节点在调用前已按时间排好序，所以实际效果就是
    「第一个子节点的开始 → 最后一个子节点的结束」——正是用户要的那句话。

    叶子节点原样不动（时间归用户管）。父节点上的 `pinned` 一并清掉：
    这个标记的含义是「用户显式钉过时间」，而父节点的时间已经不允许钉了。

    **笔记子节点不参与派生**——这是「加个笔记不会改变父节点时间」的实现处：
    只聚合带时间轴的那些子节点，一支笔记都没有贡献。而如果一个节点下面
    *只有* 笔记子节点（典型情况：给一个本来有时间的叶子添了一条笔记），
    它自己的时间原样保留，否则「加条笔记，时间就没了」。

    同理，**子节点全都还没有时间时也不做推断**（starts / ends 都为空就直接返回），
    保留节点自己原有的范围。这条是 2026-10-18 补的：给一个已经标好时间的叶子
    「+子」，新子节点身上没有时间，旧逻辑会把父节点的 start pop 掉——
    用户的时间凭空消失，而且删掉子节点也回不来（父节点自己的值已经没了）。
    推断要有依据，没依据就别动。
    """
    def walk(node: dict) -> None:
        if is_note(node):
            return
        kids = _kids(node)
        if not kids:
            return
        for k in kids:
            walk(k)

        timed = [k for k in kids if not is_note(k)]
        if not timed:
            return

        starts = [s for s in (_num(k.get("start")) for k in timed) if s is not None]
        ends = [e for e in (_num(k.get("end")) for k in timed) if e is not None]
        if not starts and not ends:
            # 没有任何依据可推断：保留节点自己的时间（可能本来就是空的）
            return

        if starts:
            node["start"] = round(min(starts), 2)
        else:
            node.pop("start", None)
        if ends:
            node["end"] = round(max(ends), 2)
        else:
            node.pop("end", None)
        node.pop("pinned", None)

    walk(tree)
    return tree


def _num(v: object) -> float | None:
    """把 node 上的时间字段安全转成 float；脏数据一律当「没有」"""
    if v is None:
        return None
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _effective_start(node: dict) -> float | None:
    """这个节点「从哪一秒开始」：自己有时间就用自己，否则向下找第一个有时间的后代。

    排序与「点击分类跳到哪里」都用它，两者因此永远一致——
    不会出现「大纲里排在第三个，点它却跳到最前面」。
    """
    s = node.get("start")
    if s is not None:
        try:
            return float(s)
        except (TypeError, ValueError):
            return None
    for kid in node.get("children") or []:
        if not isinstance(kid, dict):
            continue
        t = _effective_start(kid)
        if t is not None:
            return t
    return None


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
    end: float | None = None,
    scale: float | None = None,
    kind: str | None = None,
    note: str | None = None,
) -> bool:
    """修改单个节点的文案 / 时间范围 / 缩放 / 类型。返回是否命中。

    start / end 用「传了才算改」的约定：只有显式传入才动它，
    这样「只改终点、不动起点」才表达得出来。

    kind = "note" 表示把它变成笔记节点：时间范围会被立刻清掉，
    因为笔记不在时间轴上（父节点也不会因为它而改变自己的范围）。

    note 是节点附带的 **Markdown 笔记**（与上面的「笔记节点」是两件事：
    后者是一种不挂时间轴的节点类型，前者是任意节点上的一段自由文本）。
    传空串等于清掉它。
    """
    node = find_node(tree, node_id)
    if node is None:
        return False
    if label is not None:
        text = str(label).strip()
        if text:
            node["label"] = text[:MAX_LABEL]
    if start is not None:
        node["start"] = float(start)
    if end is not None:
        node["end"] = float(end)

    # 收尾统一做一次合法性检查：起点晚于终点、或没有起点却挂着终点，
    # 这两种倒挂数据显示出来就是「15:00–12:30」，直接清掉 end。
    s, e = node.get("start"), node.get("end")
    if s is None:
        node.pop("end", None)
    elif e is not None:
        try:
            if float(e) <= float(s):
                node.pop("end", None)
        except (TypeError, ValueError):
            node.pop("end", None)
    if scale is not None:
        node["scale"] = clamp_scale(scale)
    if kind is not None:
        if kind == NOTE_KIND:
            # inside_note=True：先把这棵子树的 kind 打上，再往下清时间
            strip_note_times(node, inside_note=True)
        else:
            node.pop("kind", None)
    if note is not None:
        text = str(note).strip()
        if text:
            node["note"] = text[:MAX_NOTE]
        else:
            node.pop("note", None)
    return True


def add_child(
    tree: dict,
    parent_id: str,
    label: str = "新节点",
    start: float | None = None,
    scale: float = 1.0,
    kind: str | None = None,
) -> str | None:
    """在指定节点下挂一个子节点，返回新节点 id；超限或父节点不存在时返回 None。

    用户虽然可以手工加节点，但仍然要受 MAX_DEPTH / MAX_CHILDREN 约束——
    没有约束的树会在几下点击之后变成一张谁也读不懂的蜘蛛网。

    kind = "note" 建出来的是笔记节点（无时间范围）；父节点本身是笔记时，
    新节点也自动是笔记——一支注记整体不挂时间轴。
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
    note = kind == NOTE_KIND or is_note(parent)
    fresh: dict = {
        "id": nid,
        "label": str(label).strip()[:MAX_LABEL] or "新节点",
        "scale": clamp_scale(scale),
    }
    if note:
        fresh["kind"] = NOTE_KIND
        fresh["start"] = None
    else:
        fresh["start"] = start
    kids.append(fresh)
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
        item = {
            "id": node.get("id"),
            "label": node["label"],
            "start": node.get("start"),
            "scale": clamp_scale(node.get("scale")),
            "depth": depth,
            "path": cur_path,
        }
        if is_note(node):
            item["kind"] = NOTE_KIND
        out.append(item)
        for c in node.get("children") or []:
            walk(c, depth + 1, cur_path)

    walk(tree, 0, "")
    return out
