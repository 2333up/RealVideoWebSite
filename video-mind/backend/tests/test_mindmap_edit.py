"""思维导图手工编辑 + 章节同步的测试。

核心验证三件事，它们错起来都不报错、只是「看起来没生效」：
    1. 保存导图是**幂等**的（反复保存不会每次冒出一批新章节）
    2. 节点时间戳变了，由它生成的章节跟着变
    3. 节点被删了，它生成的章节随之消失；而分析生成的章节不被动
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.database import Base  # noqa: E402
from core.models import Chapter, MindMap, Video  # noqa: E402
from pipeline import mindmap as mm  # noqa: E402
from routers import videos as videos_mod  # noqa: E402


#: 请求体的字段默认值。真正的 Pydantic 模型自带默认值，
#: 这里手搓的假模型必须补齐，否则会冒出「AttributeError: type object has no attribute」
#: 这种跟被测代码毫无关系的报错。
_BODY_DEFAULTS = {"title": "", "start": 0.0, "end": None, "summary": "", "key_points": [],
                  "create_chapters": True, "tree": {}}


def body(**kw):
    """用类冒充 Pydantic 请求体，省掉一堆只用一次的模型类。"""
    attrs = {**_BODY_DEFAULTS, **kw}
    return type("B", (), attrs)


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool, future=True
    )

    @event.listens_for(engine, "connect")
    def _fk_on(conn, _rec):  # pragma: no cover
        conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, future=True)()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def video(db):
    v = Video(title="测试视频", filename="t.mp4", path="/t.mp4", duration=100.0, status="ready")
    db.add(v)
    db.commit()
    # 一条「分析生成」的章节：任何导图编辑都不许动它
    db.add(
        Chapter(
            video_id=v.id, idx=0, title="原始章节", start=0, end=50,
            summary="", key_points=[], source_node_id=None,
        )
    )
    db.commit()
    return v


SIMPLE_TREE = {
    "label": "根",
    "start": 0,
    "children": [
        {"label": "要点一", "start": 10},
        {"label": "要点二", "start": 60},
    ],
}


# ------------------------------------------------------------------ 树操作

def test_ensure_node_ids_补齐且唯一():
    tree = {"label": "根", "children": [{"label": "A"}, {"label": "B", "children": [{"label": "C"}]}]}
    out = mm.ensure_node_ids(tree)
    ids = mm.collect_ids(out)
    assert len(ids) == 4
    assert out["id"] == "nd0"


def test_ensure_node_ids_消除重复id():
    tree = {"id": "x", "label": "根", "children": [{"id": "x", "label": "A"}]}
    out = mm.ensure_node_ids(tree)
    assert len(mm.collect_ids(out)) == 2


def test_normalize_tree_带id():
    out = mm.normalize_tree({"label": "根", "start": 0, "children": [{"label": "A", "start": 30}]},
                            [{"start": 0, "end": 60}])
    assert out["id"] == "nd0"
    assert out["children"][0]["id"] == "nd1"


def test_add_child_超出深度返回None():
    """深度用 MAX_DEPTH 现造，别写死层数——上限一改测试就变成谎话。"""
    node: dict = {"label": "叶"}
    for _ in range(mm.MAX_DEPTH):
        node = {"label": "层", "children": [node]}
    tree = mm.ensure_node_ids(node)
    deepest = mm.iter_nodes(tree)[-1][0]
    assert mm.add_child(tree, deepest["id"]) is None, f"MAX_DEPTH={mm.MAX_DEPTH} 层已满，不能再加"


def test_add_child_超出宽度返回None():
    kids = [{"label": f"c{i}"} for i in range(mm.MAX_CHILDREN)]
    tree = mm.ensure_node_ids({"label": "根", "children": kids})
    assert mm.add_child(tree, tree["id"]) is None


def test_add_child_正常返回新id():
    tree = mm.ensure_node_ids({"label": "根"})
    nid = mm.add_child(tree, tree["id"], label="子")
    assert nid is not None
    assert mm.find_node(tree, nid)["label"] == "子"


def test_remove_node_不能删根():
    tree = mm.ensure_node_ids({"label": "根", "children": [{"label": "A"}]})
    assert mm.remove_node(tree, tree["id"]) is False


def test_remove_node_连带子树():
    tree = mm.ensure_node_ids({"label": "根", "children": [{"label": "A", "children": [{"label": "B"}]}]})
    target = mm.find_node(tree, "nd1")["id"]
    assert mm.remove_node(tree, target) is True
    assert mm.find_node(tree, "nd2") is None


def test_set_node_与clear_start():
    tree = mm.ensure_node_ids({"label": "根", "start": 5})
    assert mm.set_node(tree, "nd0", label="新名字", scale=3.0) is True
    assert tree["label"] == "新名字"
    assert tree["scale"] == mm.MAX_SCALE, "超出上限要被夹住"
    mm.clear_start(tree, "nd0")
    assert tree["start"] is None
    assert mm.set_node(tree, "不存在", label="x") is False


def test_clamp_scale_非法值回落为1():
    assert mm.clamp_scale(None) == 1.0
    assert mm.clamp_scale("abc") == 1.0
    assert mm.clamp_scale(0.1) == mm.MIN_SCALE


# ------------------------------------------------------------------ 保存导图

def test_保存导图_补id并落库(db, video):
    r = videos_mod.patch_mindmap(video.id, body(tree=SIMPLE_TREE, create_chapters=True), db)
    assert r["ok"] is True
    assert r["tree"]["id"] == "nd0"
    db.expire_all()
    assert db.get(MindMap, db.query(MindMap).first().id).tree["id"] == "nd0"


def test_保存导图不影响章节(db, video):
    """分析完成后导图与章节一一对应；之后的编辑是两件独立的事，
    保存导图不该凭空增删任何章节（2026-10-17 需求变更）。"""
    videos_mod.patch_mindmap(video.id, body(tree=SIMPLE_TREE, create_chapters=True), db)
    before = db.query(Chapter).count()

    tree = db.query(MindMap).first().tree
    mm.set_node(tree, "nd0", label="改名了")
    r = videos_mod.patch_mindmap(video.id, body(tree=tree, create_chapters=True), db)

    assert r["chapters_created"] == 0
    assert r["chapters_removed"] == 0
    assert db.query(Chapter).count() == before


def test_重复保存是幂等的(db, video):
    r1 = videos_mod.patch_mindmap(video.id, body(tree=SIMPLE_TREE, create_chapters=True), db)
    r2 = videos_mod.patch_mindmap(video.id, body(tree=SIMPLE_TREE, create_chapters=True), db)
    assert r1["tree"] == r2["tree"], "同一棵树保存两次，结果必须完全一致"
    assert db.query(Chapter).count() == 1  # 只有那条原始章节


def test_分叉树保存_不碰章节(db, video):
    """重分析会在服务端重新生成导图（全新 id）；页面里若还拿着旧树保存，
    顶多把导图盖回去，章节一个都不能动。真实事故：旧逻辑一次保存
    凭空造出 26 条章节。"""
    videos_mod.patch_mindmap(video.id, body(tree=SIMPLE_TREE, create_chapters=True), db)
    before = db.query(Chapter).count()

    stale = {
        "label": "根",
        "start": 0,
        "children": [
            {"id": "old-a", "label": "旧要点一", "start": 12, "pinned": True},
            {"id": "old-b", "label": "旧要点二", "start": 55},
        ],
    }
    r = videos_mod.patch_mindmap(video.id, body(tree=stale, create_chapters=True), db)
    assert r["chapters_created"] == 0 and r["chapters_removed"] == 0
    assert db.query(Chapter).count() == before


def test_时间戳超出时长被夹取(db, video):
    tree = {"label": "根", "start": 0, "children": [{"label": "越界", "start": 9999}]}
    r = videos_mod.patch_mindmap(video.id, body(tree=tree, create_chapters=True), db)
    assert r["tree"]["children"][0]["start"] == 100.0, "不能超过视频时长，否则点了会跳到不存在的位置"


def test_同级时间戳重复被自动推开(db, video):
    """同父的子节点时间戳必须互不相同且严格递增——大纲从上往下读
    不该出现时间回跳或重复。"""
    tree = {"label": "根", "children": [
        {"label": "要点一", "start": 30},
        {"label": "要点二", "start": 30},   # 故意与上一个撞时间
        {"label": "要点三", "start": 10},   # 顺序还反了
    ]}
    r = videos_mod.patch_mindmap(video.id, body(tree=tree, create_chapters=True), db)
    starts = [c["start"] for c in r["tree"]["children"]]
    assert starts == sorted(starts), f"同级未按时间排序: {starts}"
    assert len(set(starts)) == len(starts), f"同级时间戳重复: {starts}"
    # 有子节点的节点：范围由子节点算出来，起点跟着最小的那个走
    assert r["tree"]["start"] == starts[0]


# ------------------------------------------------------------------ 章节边界跟随导图节点

def _save(db, video, tree):
    return videos_mod.patch_mindmap(video.id, body(tree=tree, create_chapters=True), db)


def _chapter(db, video, title):
    return next(c for c in db.query(Chapter).filter(Chapter.video_id == video.id).all()
                if c.title == title)


def _reset_chapters(db, video, specs):
    """清掉 fixture 自带的那条「原始章节」，换成测试要的几条。

    不删的话它会和自建章节抢节点：节点按「落在谁的区间里」归组，
    前半段永远归它，测试断言的章节反而拿不到节点。
    """
    for c in list(db.query(Chapter).filter(Chapter.video_id == video.id).all()):
        db.delete(c)
    db.commit()
    for s in specs:
        videos_mod.create_chapter(video.id, body(**s), db)


def _saved_tree(db):
    """取一份**拷贝**：直接在库里那棵树上改，等于把服务端用来比对的
    旧树也一起改了——前后一致，同步逻辑就认为「什么都没动」。
    前端每次提交的是新对象，不会出现这种情况。"""
    return copy.deepcopy(db.query(MindMap).first().tree)


def test_改最靠前的节点_章节起点跟着走(db, video):
    """章节是容器：把它最靠前的节点往后挪，容器的起点跟着挪。"""
    _reset_chapters(db, video, [
        {"title": "前半", "start": 0, "end": 50},
        {"title": "后半", "start": 50, "end": None},
    ])
    tree = mm.ensure_node_ids({"label": "根", "children": [
        {"label": "要点一", "start": 10},
        {"label": "要点二", "start": 60},
    ]})
    _save(db, video, tree)                      # 首次保存没有基线，不动章节

    saved = _saved_tree(db)
    mm.set_node(saved, "nd1", start=20)         # 把「前半」里最靠前的节点挪到 20s
    _save(db, video, saved)

    db.expire_all()
    assert _chapter(db, video, "前半").start == 20.0, "章节起点应跟着它最靠前的节点走"


def test_改最靠后节点的终点_章节终点跟着走(db, video):
    _reset_chapters(db, video, [
        {"title": "前半", "start": 0, "end": 50},
        {"title": "后半", "start": 50, "end": None},
    ])
    tree = mm.ensure_node_ids({"label": "根", "children": [
        {"label": "要点一", "start": 10},
        {"label": "要点二", "start": 60},
    ]})
    _save(db, video, tree)

    saved = _saved_tree(db)
    mm.set_node(saved, "nd2", end=90)           # 「后半」里最靠后的节点，终点改到 90s
    _save(db, video, saved)

    db.expire_all()
    assert _chapter(db, video, "后半").end == 90.0


def test_只改中间节点_章节不动(db, video):
    """只挪动容器中间的子话题，不该惊动章节——章节的范围由首尾决定。"""
    _reset_chapters(db, video, [{"title": "整章", "start": 0, "end": 90}])
    tree = mm.ensure_node_ids({"label": "根", "children": [
        {"label": "要点一", "start": 10},
        {"label": "要点二", "start": 30},
        {"label": "要点三", "start": 60},
    ]})
    _save(db, video, tree)
    before = (_chapter(db, video, "整章").start, _chapter(db, video, "整章").end)

    saved = _saved_tree(db)
    mm.set_node(saved, "nd2", start=35)         # 中间的要点二：30 -> 35
    _save(db, video, saved)

    db.expire_all()
    c = _chapter(db, video, "整章")
    assert (c.start, c.end) == before, f"中间节点动了，章节也跟着动了：{before} -> {(c.start, c.end)}"


def test_章节同步不新建也不删除章节(db, video):
    _reset_chapters(db, video, [{"title": "前半", "start": 0, "end": 50}])
    tree = mm.ensure_node_ids({"label": "根", "children": [
        {"label": "要点一", "start": 10},
        {"label": "要点二", "start": 60},
        {"label": "要点三", "start": 80},
    ]})
    before = db.query(Chapter).count()
    r = _save(db, video, tree)
    assert r["chapters_created"] == 0 and r["chapters_removed"] == 0
    saved = _saved_tree(db)
    mm.set_node(saved, "nd1", start=15)
    r2 = _save(db, video, saved)
    assert r2["chapters_created"] == 0 and r2["chapters_removed"] == 0
    assert db.query(Chapter).count() == before


def test_分类节点的时间由子节点算出来(db, video):
    """用户定的铁律（2026-10-18）：有子节点的节点，起点=最早的子节点起点，
    终点=最晚的子节点终点。手填的值一律被覆盖——分支的范围就是它包含内容的范围。

    之前允许分类节点另存一份时间，结果是能造出「分支 0-90，子话题却在 10-40」
    这类自相矛盾的数据：章节同步、点击跳转、导图徽章会各读各的。
    """
    tree = mm.ensure_node_ids({
        "label": "根",
        "start": 0,     # 手填：比子节点还早
        "end": 90,      # 手填：比子节点还晚
        "children": [{"label": "要点一", "start": 10, "end": 40}],
    })
    r = _save(db, video, tree)
    assert r["tree"]["start"] == 10, "父节点起点必须由子节点决定，不能是手填的 0"
    assert r["tree"]["end"] == 40, "父节点终点必须由子节点决定，不能是手填的 90"


def test_父节点范围取子节点的并集(db, video):
    """多个子节点时：起点取最早、终点取最晚（= 第一个子节点的开始 → 最后一个的结束）"""
    tree = mm.ensure_node_ids({
        "label": "根",
        "children": [
            {"label": "A", "start": 10, "end": 40},
            {"label": "B", "start": 40, "end": 70},
            {"label": "C", "start": 70, "end": 95},
        ],
    })
    r = _save(db, video, tree)
    assert r["tree"]["start"] == 10
    assert r["tree"]["end"] == 95


def test_多层嵌套逐层向上推导(db, video):
    """孙节点的范围要一路顶到最外层：中间层不是叶子，它的范围也是算出来的"""
    tree = mm.ensure_node_ids({
        "label": "根",
        "children": [
            {
                "label": "分支",
                "children": [
                    {"label": "孙一", "start": 5, "end": 30},
                    {"label": "孙二", "start": 30, "end": 80},
                ],
            }
        ],
    })
    r = _save(db, video, tree)
    branch = r["tree"]["children"][0]
    assert branch["start"] == 5 and branch["end"] == 80, "中间层要由孙节点算"
    assert r["tree"]["start"] == 5 and r["tree"]["end"] == 80, "根要跟着中间层一起算"


def test_分析流程的父节点时间也来自子节点():
    """分析流程与手工保存用的是同一条规则，不再有「分析清空 / 手工保留」的分叉。"""
    out = mm.normalize_tree(
        {"label": "根", "start": 0, "end": 60, "children": [{"label": "A", "start": 10}]},
        [{"start": 0, "end": 60}],
    )
    assert out["start"] == 10, "起点来自唯一的子节点"
    assert out["end"] == 60, "终点来自子节点（end 缺省时由章节补到 60）"


def test_章节时间范围互不交叉(db, video):
    """两条硬性要求：起点互不相同，且任意两条章节的时间范围不重叠。"""
    # 三条手工章节，其中两条起点撞车、一条插在别人中间
    videos_mod.create_chapter(video.id, body(title="手写一", start=10, end=None), db)
    videos_mod.create_chapter(video.id, body(title="手写二", start=10, end=40), db)
    videos_mod.create_chapter(video.id, body(title="手写三", start=30, end=None), db)

    ch = sorted(
        db.query(Chapter).filter(Chapter.video_id == video.id).all(),
        key=lambda c: c.start,
    )
    starts = [c.start for c in ch]
    assert len(set(starts)) == len(starts), f"章节起点重复: {starts}"

    for prev, cur in zip(ch, ch[1:]):
        assert prev.end <= cur.start + 1e-6, (
            f"章节区间交叉：「{prev.title}」到 {prev.end}，「{cur.title}」从 {cur.start} 开始"
        )


def test_空标签节点被丢弃(db, video):
    r = videos_mod.patch_mindmap(
        video.id,
        body(tree={"label": "根", "start": 0, "children": [{"label": "   ", "start": 10}]}, create_chapters=True),
        db,
    )
    assert "children" not in r["tree"]


def test_导图为空时报错(db, video):
    with pytest.raises(HTTPException) as e:
        videos_mod.patch_mindmap(video.id, body(tree={"label": "  "}, create_chapters=True), db)
    assert "至少" in str(e.value.detail)


# ------------------------------------------------------------------ 章节增删改

def test_手工新增章节_终点自动兜到片尾(db, video):
    c = videos_mod.create_chapter(video.id, body(title="手写章节", start=70, end=None), db)
    assert c["end"] == 100.0
    assert c["source_node_id"] is None


def test_手工新增章节_终点取下一个章节起点(db, video):
    """终点 = 下一个已有章节的起点。原始章节 0-50 在 10 秒之前，不算「下一个」。"""
    videos_mod.create_chapter(video.id, body(title="后面的", start=60, end=None), db)
    c = videos_mod.create_chapter(video.id, body(title="插在中间", start=10, end=None), db)
    assert c["end"] == 60.0


def test_章节时间非法时报错(db, video):
    with pytest.raises(HTTPException) as e:
        videos_mod.create_chapter(video.id, body(title="x", start=30, end=10), db)
    assert "必须晚于" in str(e.value.detail)
    with pytest.raises(HTTPException) as e:
        videos_mod.create_chapter(video.id, body(title="x", start=999, end=1000), db)
    assert "超出" in str(e.value.detail)


def test_修改章节(db, video):
    c = videos_mod.create_chapter(video.id, body(title="手写", start=60, end=90), db)
    r = videos_mod.patch_chapter(video.id, c["id"], body(title="改后", start=60, end=95), db)
    assert r["chapter"]["title"] == "改后"
    assert r["chapter"]["end"] == 95


def test_删除不存在的章节报404(db, video):
    with pytest.raises(HTTPException) as e:
        videos_mod.delete_chapter(video.id, 12345, db)
    assert e.value.status_code == 404
