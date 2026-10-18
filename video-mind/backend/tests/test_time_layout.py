"""时间布局：兄弟节点「按顺序瓜分父区间」的测试。

背景（2026-10-18 用户报「几乎每个节点的时间都不对」）：
模型经常只给叶子 start、end 填 null。以前拿「所在章节的终点」补 end，
同一个章节下的兄弟就全部结束在同一秒，大纲里每个节点都像跨越整章、区间层层重叠；
enforce_time_order 还会把撞车的起点按 1 秒推开，造出「00:00 / 00:01 / 00:02」
这种一串 1 秒的假区间。

现在的规则：子节点按顺序等分父区间；**已经首尾相接铺满的（模型给得好的）不动**。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import mindmap as mm  # noqa: E402


def ranges(tree: dict) -> list[tuple[float | None, float | None]]:
    return [(n.get("start"), n.get("end")) for n in tree.get("children") or []]


def test_同章节的叶子不再全部结束在章节终点():
    """两个叶子挂在一个 0-180 的章节里、end 都是 null。

    旧行为：两个都补成 0-180，区间完全重叠。
    新行为：按顺序瓜分 -> 0-90 / 90-180。
    """
    chapters = [{"start": 0, "end": 180}]
    tree = {
        "label": "根",
        "children": [
            {
                "label": "第一章",
                "children": [
                    {"label": "子一", "start": 0, "end": None},
                    {"label": "子二", "start": 0, "end": None},
                ],
            }
        ],
    }
    out = mm.normalize_tree(tree, chapters)

    chapter = out["children"][0]
    a, b = chapter["children"]
    assert (a["start"], a["end"]) == (0, 90), f"第一个子节点应占前半段，实际 {a}"
    assert (b["start"], b["end"]) == (90, 180), f"第二个子节点应占后半段，实际 {b}"
    # 父节点 = 子节点并集
    assert (chapter["start"], chapter["end"]) == (0, 180)
    assert (out["start"], out["end"]) == (0, 180)


def test_兄弟区间重叠时按顺序等分():
    """模型给的两个区间互相重叠（0-100 与 50-200）-> 按顺序重排成 0-100 / 100-200

    注意父节点必须先有区间（真实流程里由 derive_parent_ranges 先算出来），
    否则「瓜分哪儿」就没有依据。
    """
    tree = {
        "label": "根",
        "start": 0,
        "end": 200,
        "children": [
            {"label": "A", "start": 0, "end": 100},
            {"label": "B", "start": 50, "end": 200},
        ],
    }
    mm.partition_children(tree)
    assert ranges(tree) == [(0, 100), (100, 200)]


def test_已经铺满的兄弟一个数都不动():
    """视频 2 那种「模型给得对」的数据：首尾相接铺满父区间，不能被重排"""
    tree = {
        "label": "根",
        "start": 0,
        "end": 326,
        "children": [
            {"label": "A", "start": 0, "end": 110},
            {"label": "B", "start": 110, "end": 200},
            {"label": "C", "start": 200, "end": 326},
        ],
    }
    mm.partition_children(tree)
    assert ranges(tree) == [(0, 110), (110, 200), (200, 326)]


def test_单个子节点继承父区间():
    """只有一个孩子时不用等分——它就该覆盖整个父区间"""
    tree = {
        "label": "根",
        "start": 10,
        "end": 90,
        "children": [{"label": "唯一", "start": None, "end": None}],
    }
    mm.partition_children(tree)
    assert ranges(tree) == [(10, 90)]


def test_多层嵌套逐层瓜分():
    """每一层都在自己的父区间里瓜分，不会越界"""
    tree = {
        "label": "根",
        "start": 0,
        "end": 300,
        "children": [
            {"label": "甲", "start": 0, "end": 300, "children": [
                {"label": "甲一", "start": 0, "end": 300},
                {"label": "甲二", "start": 0, "end": 300},
            ]},
            {"label": "乙", "start": 0, "end": 300},
        ],
    }
    mm.partition_children(tree)
    jia, yi = tree["children"]
    assert (jia["start"], jia["end"]) == (0, 150)
    assert (yi["start"], yi["end"]) == (150, 300)
    assert ranges(jia) == [(0, 75), (75, 150)], "孙节点要在 0-150 里再分"


def test_分析流程不再出现一秒长的假区间():
    """三个叶子同起点、无终点：不该出现 0-1 / 1-2 这种 1 秒区间"""
    chapters = [{"start": 0, "end": 300}]
    tree = {
        "label": "根",
        "children": [
            {"label": "章", "children": [
                {"label": "一", "start": 0, "end": None},
                {"label": "二", "start": 0, "end": None},
                {"label": "三", "start": 0, "end": None},
            ]},
        ],
    }
    out = mm.normalize_tree(tree, chapters)
    spans = [(n["start"], n["end"]) for n in out["children"][0]["children"]]
    assert spans == [(0, 100), (100, 200), (200, 300)], spans
    assert all(e - s > 1 for s, e in spans), "不允许出现 1 秒长的假区间"


# ------------------------------------------------------------------ 笔记节点
#
# 用户 2026-10-18 追加的需求：「增加一种新的节点，这个节点没有时间区域，
# 它的父节点也不会因为增加了这种节点而改变它本身的时间区域。」
#
# 这类节点（kind="note"）整支退出时间轴：不参与排序、不参与瓜分、
# 不出现在父节点的 min/max 里，自己的 start/end 一律为 None。

def test_笔记节点自己没有时间范围():
    chapters = [{"start": 0, "end": 300}]
    tree = {
        "label": "根",
        "children": [
            {"label": "章", "children": [
                {"label": "一", "start": 0, "end": 100},
                {"label": "小抄", "start": 40, "end": 90, "kind": "note"},
            ]},
        ],
    }
    out = mm.normalize_tree(tree, chapters)
    zhang = out["children"][0]
    note = zhang["children"][1]
    assert note.get("kind") == "note"
    assert note.get("start") is None and note.get("end") is None


def test_加笔记不改变父节点的时间范围():
    """加笔记前后，分支的范围必须一模一样——这是需求的原文。"""
    chapters = [{"start": 0, "end": 300}]
    base = {
        "label": "根",
        "children": [
            {"label": "章", "children": [
                {"label": "一", "start": 0, "end": 100},
                {"label": "二", "start": 100, "end": 220},
            ]},
        ],
    }
    with_note = {
        "label": "根",
        "children": [
            {"label": "章", "children": [
                {"label": "一", "start": 0, "end": 100},
                {"label": "二", "start": 100, "end": 220},
                {"label": "小抄", "kind": "note"},
            ]},
        ],
    }
    a = mm.normalize_tree(base, chapters)["children"][0]
    b = mm.normalize_tree(with_note, chapters)["children"][0]
    assert (a["start"], a["end"]) == (0, 220)
    assert (b["start"], b["end"]) == (a["start"], a["end"])
    # 兄弟俩的时间也不能因为多了个笔记被重新瓜分
    assert [(k["start"], k["end"]) for k in b["children"][:2]] == [
        (k["start"], k["end"]) for k in a["children"]
    ]


def test_只有笔记子节点时节点自己的时间保留():
    """给一个本来有时间的叶子添一条笔记，它的时间不能凭空消失。"""
    tree = {
        "label": "根",
        "children": [
            {"label": "一", "start": 10, "end": 100, "children": [
                {"label": "小抄", "kind": "note"},
            ]},
            {"label": "二", "start": 100, "end": 200},
        ],
    }
    mm.derive_parent_ranges(tree)
    one = tree["children"][0]
    assert (one["start"], one["end"]) == (10, 100)
    assert (tree["start"], tree["end"]) == (10, 200)


def test_笔记子节点也不被瓜分():
    """笔记不占用兄弟区间的份额：两个定时子节点仍然平分父区间。"""
    tree = {
        "label": "根", "start": 0, "end": 200,
        "children": [
            {"label": "一", "start": 0, "end": 200},
            {"label": "二", "start": 0, "end": 200},
            {"label": "小抄", "kind": "note"},
        ],
    }
    mm.partition_children(tree)
    one, two, note = tree["children"]
    assert (one["start"], one["end"]) == (0, 100)
    assert (two["start"], two["end"]) == (100, 200)
    assert note.get("start") is None


def test_笔记节点在排序里保留原位():
    """用户把它插在中间，保存后不该被甩到最后一个。"""
    tree = {
        "label": "根",
        "children": [
            {"label": "一", "start": 30, "end": 40},
            {"label": "小抄", "kind": "note"},
            {"label": "二", "start": 10, "end": 20},
        ],
    }
    mm.enforce_time_order(tree)
    labels = [k["label"] for k in tree["children"]]
    assert labels == ["二", "小抄", "一"], labels


def test_笔记下面的子节点也自动变笔记():
    tree = {"label": "根", "children": [{"label": "小抄", "kind": "note", "children": [
        {"label": "细节", "start": 5, "end": 9},
    ]}]}
    mm.strip_note_times(tree)
    kid = tree["children"][0]["children"][0]
    assert kid.get("kind") == "note"
    assert kid.get("start") is None and kid.get("end") is None


def test_把节点改成笔记会清掉它的时间():
    tree = {"label": "根", "children": [{"label": "一", "start": 10, "end": 20}]}
    assert mm.set_node(tree, "nd1", kind="note") is False  # 没有这个 id
    tree["children"][0]["id"] = "nd1"
    assert mm.set_node(tree, "nd1", kind="note") is True
    one = tree["children"][0]
    assert one["kind"] == "note" and one.get("start") is None and one.get("end") is None


def test_新增笔记节点不带时间():
    tree = {"id": "nd0", "label": "根", "children": []}
    nid = mm.add_child(tree, "nd0", label="小抄", kind="note")
    assert nid == "nd1"
    note = tree["children"][0]
    assert note["kind"] == "note" and note.get("start") is None
    # 笔记下面再加的节点自动继承
    kid = mm.add_child(tree, "nd1", label="细节")
    assert kid == "nd2"
    assert tree["children"][0]["children"][0]["kind"] == "note"


def test_给有时间的叶子加子节点不会抹掉父节点的时间():
    """用户 2026-10-18 报「加节点后整个页面重置」时顺带炸出来的数据丢失。

    旧行为：给一个已经标好时间的叶子「+子」，新子节点身上没有时间，
    derive_parent_ranges 看到「有定时子节点、但都没有 start」，就把父节点的
    start pop 掉了——用户的时间凭空消失，删掉子节点也回不来。
    现在：没有任何依据可推断时不动它。
    """
    tree = {
        "label": "根",
        "children": [
            {"id": "a", "label": "一", "start": 10, "end": 100},
            {"id": "b", "label": "二", "start": 100, "end": 200},
        ],
    }
    mm.add_child(tree, "a", label="细节")
    mm.enforce_time_order(tree)
    a = next(k for k in tree["children"] if k["id"] == "a")
    assert (a["start"], a["end"]) == (10, 100), a
    assert (tree["start"], tree["end"]) == (10, 200), tree


def test_子节点全都没有时间时父节点也不被清空():
    tree = {
        "label": "根", "start": 5, "end": 90,
        "children": [
            {"label": "一", "start": None},
            {"label": "二", "start": None},
        ],
    }
    mm.derive_parent_ranges(tree)
    assert (tree["start"], tree["end"]) == (5, 90)


# ------------------------------------------------------------------ 节点笔记（Markdown）

def test_节点笔记能写能改能清():
    tree = {"id": "nd0", "label": "根", "children": [{"id": "nd1", "label": "一", "start": 0}]}
    assert mm.set_node(tree, "nd1", note="# 标题\n\n- 要点") is True
    assert tree["children"][0]["note"] == "# 标题\n\n- 要点"
    mm.set_node(tree, "nd1", note="  改过的  ")
    assert tree["children"][0]["note"] == "改过的"
    mm.set_node(tree, "nd1", note="   ")
    assert "note" not in tree["children"][0], "空串等于删掉笔记"
    assert mm.set_node(tree, "no-such", note="x") is False


def test_节点笔记超长会截断():
    tree = {"id": "nd0", "label": "根", "children": []}
    mm.add_child(tree, "nd0", label="一")
    nid = tree["children"][0]["id"]
    mm.set_node(tree, nid, note="啊" * (mm.MAX_NOTE + 500))
    assert len(tree["children"][0]["note"]) == mm.MAX_NOTE


def test_写笔记不影响时间范围():
    tree = {
        "id": "nd0", "label": "根",
        "children": [
            {"id": "a", "label": "一", "start": 0, "end": 100},
            {"id": "b", "label": "二", "start": 100, "end": 200},
        ],
    }
    before = [(k["start"], k["end"]) for k in tree["children"]]
    mm.set_node(tree, "a", note="随便写点什么")
    mm.enforce_time_order(tree)
    assert [(k["start"], k["end"]) for k in tree["children"]] == before
