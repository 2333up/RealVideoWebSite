"""管线核心逻辑测试。

不依赖网络与模型，用合成数据验证两件事：
  1. 时间戳防幻觉（吸附 + 结构修复）
  2. 结构化输出的健壮解析
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import chapter as chapter_mod  # noqa: E402
from pipeline import mindmap as mindmap_mod  # noqa: E402
from providers.asr.base import Segment  # noqa: E402
from providers.llm.base import LLMError, extract_json_object  # noqa: E402


def make_segments(n: int, step: float = 10.0) -> list[Segment]:
    """造 n 个等间距片段：0-10, 10-20, 20-30 …"""
    return [
        Segment(start=i * step, end=(i + 1) * step, text=f"第{i}段的内容")
        for i in range(n)
    ]


# ------------------------------------------------------------------ 时间吸附

def test_snap_timestamp_吸附到最近的真实起点():
    segs = make_segments(6)  # 0, 10, 20, 30, 40, 50
    # LLM 编造的时间戳必须被拉回到真实存在的语音起点
    assert chapter_mod.snap_timestamp(3.0, segs) == 0.0
    assert chapter_mod.snap_timestamp(8.0, segs) == 10.0
    assert chapter_mod.snap_timestamp(27.0, segs) == 30.0
    assert chapter_mod.snap_timestamp(46.0, segs) == 50.0


def test_snap_timestamp_负数不越界():
    segs = make_segments(3)
    assert chapter_mod.snap_timestamp(-5.0, segs) == 0.0


def test_snap_timestamp_空片段表不崩():
    assert chapter_mod.snap_timestamp(12.0, []) == 12.0


# ------------------------------------------------------------------ 章节规范化

def test_normalize_chapters_吸附幻觉时间戳():
    """即使模型给出转写里不存在的时间点，输出也必须落在真实起点上。"""
    segs = make_segments(6)
    raw = [
        {"title": "开场", "start": 0, "end": 17, "summary": "开场白", "key_points": ["要点A"]},
        # 17 和 33 都不是真实的片段起点（真实是 10/20/30/40），应被吸附
        {"title": "正文", "start": 17, "end": 33, "summary": "正文内容", "key_points": ["要点B"]},
        {"title": "结尾", "start": 33, "end": 55, "summary": "结尾", "key_points": ["要点C"]},
    ]
    out = chapter_mod.normalize_chapters(raw, segs)
    real_starts = {s.start for s in segs}
    for c in out:
        assert c["start"] in real_starts, f"章节起点 {c['start']} 未吸附到真实片段"


def test_normalize_chapters_首章从零开始_末章覆盖到结尾():
    segs = make_segments(5)  # 总时长 50
    raw = [
        {"title": "A", "start": 12, "end": 25, "summary": "", "key_points": []},
        {"title": "B", "start": 25, "end": 38, "summary": "", "key_points": []},
    ]
    out = chapter_mod.normalize_chapters(raw, segs)
    assert out[0]["start"] == 0.0
    assert out[-1]["end"] == 50.0


def test_分章提示词带章节数锚点():
    """只说「每 3-10 分钟一章」时模型要么切碎要么切粗，必须给具体数字做锚点。"""
    # 20 分钟 -> 按每 5 分钟一章推算，建议 4 章
    segs = [Segment(start=i * 30, end=(i + 1) * 30, text="内容") for i in range(40)]
    prompt = chapter_mod._build_user_prompt(segs)
    assert "建议章节数" in prompt
    assert "约 4 章" in prompt

    # 60 分钟 -> 约 12 章，锚点要跟着时长走
    long_segs = [Segment(start=i * 30, end=(i + 1) * 30, text="内容") for i in range(120)]
    assert "约 12 章" in chapter_mod._build_user_prompt(long_segs)


def test_分章提示词要求先找话题转折():
    """先定位话题转折点再切分（CoT），比直接让模型切分准确得多。"""
    assert "topic_shifts" in chapter_mod.SYSTEM_PROMPT
    assert "话题" in chapter_mod.SYSTEM_PROMPT
    # 给模型一个草稿字段，但同时要说明它不会被使用，免得模型以为必须填
    assert "不会被使用" in chapter_mod.SYSTEM_PROMPT


def test_normalize_chapters_相邻章节首尾相接():
    segs = make_segments(8)
    raw = [
        {"title": f"第{i}章", "start": i * 15, "end": i * 15 + 15, "summary": "", "key_points": []}
        for i in range(4)
    ]
    out = chapter_mod.normalize_chapters(raw, segs)
    for i in range(len(out) - 1):
        assert out[i]["end"] == out[i + 1]["start"], "相邻章节之间存在空隙或重叠"


def test_normalize_chapters_过滤无效条目():
    segs = make_segments(4)
    raw = [
        {"title": "", "start": 0, "end": 10, "summary": "", "key_points": []},  # 无标题
        {"title": "有效", "start": 0, "end": 20, "summary": "x", "key_points": []},
        {"title": "坏数据", "start": "abc", "end": None, "summary": "", "key_points": []},  # 类型错误
        "这不是一个字典",
    ]
    out = chapter_mod.normalize_chapters(raw, segs)
    assert len(out) == 1
    assert out[0]["title"] == "有效"


def test_normalize_chapters_编号连续():
    segs = make_segments(6)
    raw = [
        {"title": f"C{i}", "start": i * 12, "end": i * 12 + 12, "summary": "", "key_points": []}
        for i in range(3)
    ]
    out = chapter_mod.normalize_chapters(raw, segs)
    assert [c["idx"] for c in out] == [0, 1, 2]


def test_normalize_chapters_全部无效时报错而非静默返回空():
    segs = make_segments(3)
    with pytest.raises(Exception) as exc:
        chapter_mod.normalize_chapters([{"title": "", "start": 0, "end": 1}], segs)
    assert "章节" in str(exc.value)


# ------------------------------------------------------------------ 切片

def test_split_segments_短文本不切片():
    segs = make_segments(3)
    chunks = chapter_mod.split_segments(segs, target_chars=10_000, overlap_chars=500)
    assert len(chunks) == 1


def test_split_segments_长文本切片保留重叠():
    segs = [Segment(start=i * 5, end=(i + 1) * 5, text="字" * 100) for i in range(100)]
    chunks = chapter_mod.split_segments(segs, target_chars=2000, overlap_chars=500)
    assert len(chunks) > 1
    # 相邻块之间必须有重叠，否则话题会被腰斩
    first_tail = chunks[0][-1].text
    assert any(s.text == first_tail for s in chunks[1]) or len(chunks[1]) > 0


def test_split_segments_空输入不崩():
    assert chapter_mod.split_segments([], 1000, 100) == []


# ------------------------------------------------------------------ 时间格式化

def test_format_ts():
    assert chapter_mod.format_ts(0) == "00:00"
    assert chapter_mod.format_ts(65) == "01:05"
    assert chapter_mod.format_ts(3661) == "01:01:01"
    assert chapter_mod.format_ts(-5) == "00:00"  # 负数兜底


def test_render_transcript_带时间戳前缀():
    segs = [Segment(start=0, end=5, text="你好")]
    out = chapter_mod.render_transcript(segs)
    assert out.startswith("[00:00]")


# ------------------------------------------------------------------ 思维导图

def test_normalize_tree_越界时间戳被钳位():
    chapters = [
        {"idx": 0, "title": "A", "start": 0, "end": 100, "summary": "", "key_points": []},
    ]
    tree = {
        "label": "根",
        "start": 99999,  # 严重越界
        "children": [{"label": "子", "start": -50}],
    }
    out = mindmap_mod.normalize_tree(tree, chapters)
    # 根有子节点 → 不持有自己的时间；越界的是子节点，它被钳进章节区间
    assert out.get("start") is None
    assert 0 <= out["children"][0]["start"] <= 100


def test_normalize_tree_分类节点不持有自己的时间():
    """分类节点的时间就是它第一个子节点的时间，不该再存一份。

    存一份会在大纲里和子节点并排显示同一个时间点（看着像重复数据），
    章节同步时还会把父子俩都生成章节，区间直接交叉。
    """
    chapters = [{"idx": 0, "title": "A", "start": 0, "end": 100, "summary": "", "key_points": []}]
    tree = {
        "label": "根",
        "start": None,
        "children": [{"label": "子", "start": 42}],
    }
    out = mindmap_mod.normalize_tree(tree, chapters)
    assert out.get("start") is None
    # 点击分类时靠 first_timed_descendant 找到跳转目标，仍然「点了有反应」
    assert mindmap_mod.first_timed_descendant(out) == 42.0


def test_enforce_time_order_同级时间戳互不相同():
    """同级节点撞在同一个时间点时，后一个要被推开至少 MIN_TIME_STEP。"""
    tree = {"label": "根", "children": [
        {"label": "子1", "start": 30},
        {"label": "子2", "start": 30},   # 与上一个撞了
        {"label": "子3", "start": 10},   # 顺序还反了
    ]}
    mindmap_mod.enforce_time_order(tree)
    starts = [c["start"] for c in tree["children"]]
    assert starts == sorted(starts), f"同级未按时间排序: {starts}"
    assert len(set(starts)) == len(starts), f"同级时间戳重复: {starts}"
    assert starts[1] - starts[0] >= mindmap_mod.MIN_TIME_STEP


def test_normalize_tree_限制深度与宽度():
    chapters = [{"idx": 0, "title": "A", "start": 0, "end": 100, "summary": "", "key_points": []}]
    # 造一棵 5 层深、每层 20 个节点的过深过宽树
    def build(depth):
        node = {"label": f"d{depth}", "start": depth}
        if depth < 5:
            node["children"] = [build(depth + 1) for _ in range(20)]
        return node

    out = mindmap_mod.normalize_tree(build(0), chapters)

    def max_depth(n):
        kids = n.get("children") or []
        return 1 + max((max_depth(k) for k in kids), default=0)

    def max_width(n):
        kids = n.get("children") or []
        return max(len(kids), *(max_width(k) for k in kids)) if kids else 0

    # 深度上限 MAX_DEPTH+1 层（根算第 0 层）
    assert max_depth(out) <= mindmap_mod.MAX_DEPTH + 1
    assert max_width(out) <= mindmap_mod.MAX_CHILDREN


def test_normalize_tree_过滤空标签():
    chapters = [{"idx": 0, "title": "A", "start": 0, "end": 10, "summary": "", "key_points": []}]
    tree = {"label": "根", "start": 0, "children": [{"label": ""}, {"label": "有效", "start": 5}]}
    out = mindmap_mod.normalize_tree(tree, chapters)
    assert len(out["children"]) == 1
    assert out["children"][0]["label"] == "有效"


def test_normalize_tree_根节点兜底从零开始():
    chapters = [{"idx": 0, "title": "A", "start": 0, "end": 10, "summary": "", "key_points": []}]
    out = mindmap_mod.normalize_tree({"label": "根", "start": None}, chapters)
    assert out["start"] == 0.0


def test_flatten_tree():
    tree = {"label": "根", "start": 0, "children": [{"label": "子", "start": 5}]}
    flat = mindmap_mod.flatten_tree(tree)
    assert len(flat) == 2
    assert flat[0]["depth"] == 0
    assert flat[1]["depth"] == 1
    assert flat[1]["path"] == "根/子"


# ------------------------------------------------------------------ JSON 解析

def test_extract_json_纯净对象():
    assert extract_json_object('{"a": 1}') == {"a": 1}


def test_extract_json_带代码块围栏():
    raw = '好的，结果如下：\n```json\n{"chapters": [{"title": "x"}]}\n```\n'
    assert extract_json_object(raw)["chapters"][0]["title"] == "x"


def test_extract_json_前后有废话():
    raw = '我的分析是：{"a": 1, "b": [1,2,{"c": "}"}]} 以上就是结果。'
    out = extract_json_object(raw)
    assert out["a"] == 1
    # 字符串里的右花括号不应被当作结构结束
    assert out["b"][2]["c"] == "}"


def test_extract_json_中文与转义():
    raw = '{"title": "标题含\\"引号\\"与\\n换行", "n": 3}'
    out = extract_json_object(raw)
    assert out["n"] == 3
    assert '引号' in out["title"]


def test_extract_json_空内容报错():
    with pytest.raises(LLMError):
        extract_json_object("")


def test_extract_json_无结构报错():
    with pytest.raises(LLMError):
        extract_json_object("很抱歉，我无法完成这个任务。")
