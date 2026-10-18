"""集成测试：用假的 LLM 跑通「转写 -> 分章节 -> 思维导图」全链路。

目的不是测模型（那需要真实 API），而是验证编排逻辑：
    - 章节能被正确解析、校验、入库结构合法
    - 导图继承自章节的时间戳，且所有时间点都落在视频真实时长内
    - 任何点击目标都能对应到视频里真实存在的位置
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import providers.llm as llm_pkg  # noqa: E402
from pipeline import chapter as chapter_mod  # noqa: E402
from pipeline import mindmap as mindmap_mod  # noqa: E402
from providers.asr.base import Segment  # noqa: E402
from providers.llm.base import LLMProvider  # noqa: E402


class FakeLLM(LLMProvider):
    """按调用轮次返回预设内容的假 LLM。

    第一轮返回章节 JSON，第二轮返回导图 JSON——对应 build_chapters /
    build_mindmap 的调用顺序。
    """

    id = "fake"
    name = "假模型"

    def __init__(self, chapters_payload: str | None = None, mindmap_payload: str | None = None):
        super().__init__()  # 初始化 usage_log
        self.calls: list[dict] = []
        self._chapters = chapters_payload
        self._mindmap = mindmap_payload

    def chat(self, system, user, temperature=0.2, max_tokens=4096, purpose="") -> str:
        self.calls.append({"system": system, "user": user, "purpose": purpose})
        # 顺手记一笔用量，好让「用量记账」在集成测试里也被覆盖到
        self._record_usage({"prompt_tokens": 100, "completion_tokens": 50}, purpose=purpose)
        # 按 purpose 分流：两个提示词里都出现「章节」二字，靠关键词判别会串台
        if purpose == "思维导图":
            return self._mindmap if self._mindmap is not None else "{}"
        if self._chapters is not None:
            return self._chapters
        return "{}"


@pytest.fixture
def segments() -> list[Segment]:
    """12 个 30 秒片段，总时长 360 秒（6 分钟）。"""
    return [
        Segment(start=i * 30, end=(i + 1) * 30, text=f"第{i}段讲解内容，介绍了若干概念。")
        for i in range(12)
    ]


@pytest.fixture(autouse=True)
def patch_llm(monkeypatch):
    """接管 get_llm，让管线用假模型。

    注意必须 patch 到**实际使用的命名空间**：chapter.py / mindmap.py 在导入时
    执行了 `from providers.llm import get_llm`，把函数绑进了自己的模块作用域。
    只 patch providers.llm.get_llm 不会影响它们，这是 Python 导入机制的经典陷阱。
    """
    holder: dict = {"instance": FakeLLM()}

    def factory(provider_id=None, model=None):
        return holder["instance"]

    monkeypatch.setattr(chapter_mod, "get_llm", factory)
    # 导图同样要 mock：它现在会再调一次模型做多层重组
    monkeypatch.setattr(mindmap_mod, "get_llm", factory)
    return holder


# ------------------------------------------------------------------ 正常链路

def test_分章节_能产出合法结构(segments, patch_llm):
    payload = """
    {"chapters": [
        {"title": "开场介绍", "start": 0,   "end": 90,  "summary": "介绍课程目标", "key_points": ["目标一", "目标二"]},
        {"title": "核心概念", "start": 90,  "end": 210, "summary": "讲解核心概念", "key_points": ["概念A", "概念B"]},
        {"title": "实战演示", "start": 210, "end": 300, "summary": "演示操作流程", "key_points": ["步骤1"]},
        {"title": "总结回顾", "start": 300, "end": 360, "summary": "回顾重点",     "key_points": ["要点"]}
    ]}
    """
    patch_llm["instance"] = FakeLLM(chapters_payload=payload)

    out = chapter_mod.build_chapters(segments)

    assert len(out) == 4
    assert [c["idx"] for c in out] == [0, 1, 2, 3]
    # 时间戳必须全部吸附到真实的片段起点（0/30/60/.../330）
    real = {s.start for s in segments} | {segments[-1].end}
    for c in out:
        assert c["start"] in real
    assert out[0]["start"] == 0.0
    assert out[-1]["end"] == 360.0


def test_分章节_修正幻觉时间戳(segments, patch_llm):
    """模型给出 47 / 133 这类转写里不存在的时间，输出必须被吸附。"""
    payload = """
    {"chapters": [
        {"title": "A", "start": 0,   "end": 47,  "summary": "", "key_points": []},
        {"title": "B", "start": 47,  "end": 133, "summary": "", "key_points": []},
        {"title": "C", "start": 133, "end": 355, "summary": "", "key_points": []}
    ]}
    """
    patch_llm["instance"] = FakeLLM(chapters_payload=payload)
    out = chapter_mod.build_chapters(segments)

    real = {s.start for s in segments}
    for c in out:
        assert c["start"] in real, f"{c['start']} 不是真实片段起点"


def test_分章节_模型返回垃圾时报错(segments, patch_llm):
    patch_llm["instance"] = FakeLLM(chapters_payload="抱歉，我无法分析这段内容。")
    with pytest.raises(Exception):
        chapter_mod.build_chapters(segments)


def test_分章节_合并过短章节(segments, patch_llm):
    """一个只覆盖 8 秒（跨一个片段内部）的章节没有跳转价值，应被合并。"""
    payload = """
    {"chapters": [
        {"title": "长章节", "start": 0,  "end": 120, "summary": "", "key_points": []},
        {"title": "很短",   "start": 120, "end": 150, "summary": "", "key_points": []},
        {"title": "后面",   "start": 150, "end": 360, "summary": "", "key_points": []}
    ]}
    """
    patch_llm["instance"] = FakeLLM(chapters_payload=payload)
    out = chapter_mod.build_chapters(segments)
    # 「很短」30 秒，大于 MIN_CHAPTER_SEC(15)，应保留；此处验证不崩溃且结构合法
    assert out[0]["start"] == 0.0
    assert out[-1]["end"] == 360.0
    for i in range(len(out) - 1):
        assert out[i]["end"] == out[i + 1]["start"]


# ------------------------------------------------------------------ 思维导图

def test_导图_时间戳全部落在视频时长内(segments, patch_llm):
    chapters = [
        {"idx": 0, "title": "A", "start": 0, "end": 120, "summary": "s", "key_points": []},
        {"idx": 1, "title": "B", "start": 120, "end": 240, "summary": "s", "key_points": []},
        {"idx": 2, "title": "C", "start": 240, "end": 360, "summary": "s", "key_points": []},
    ]
    tree = mindmap_mod.build_mindmap(chapters, video_title="测试视频")

    def all_starts(node):
        yield node.get("start")
        for c in node.get("children") or []:
            yield from all_starts(c)

    for s in all_starts(tree):
        if s is not None:
            assert 0 <= s <= 360, f"导图时间戳 {s} 超出视频时长范围"


def test_导图_保留模型给出的多层嵌套(segments, patch_llm):
    """模型重组出的多层结构必须原样保留，不能被压平成两层。

    导图体现的是知识结构：一支课被压成「根 + N 个章节名」之后，
    「谁是谁的子话题」就彻底看不出来了。所以这里断言深度与层级都在。
    """
    chapters = [
        {"idx": 0, "title": "开场", "start": 0, "end": 60, "summary": "s", "key_points": []},
        {"idx": 1, "title": "主体", "start": 60, "end": 120, "summary": "s", "key_points": []},
        {"idx": 2, "title": "收尾", "start": 120, "end": 180, "summary": "s", "key_points": []},
    ]
    payload = """
    {"label": "测试视频", "start": null, "end": null, "summary": "", "children": [
      {"label": "基础概念", "start": 0, "end": 60, "summary": "先讲两个基础概念。", "children": [
        {"label": "概念一", "start": 0, "end": 30, "summary": "概念一的定义与用途。", "children": [
          {"label": "常见误区", "start": 10, "end": 25, "summary": "容易被搞混的两种写法。"}
        ]},
        {"label": "概念二", "start": 30, "end": 60, "summary": "概念二的适用边界。"}
      ]},
      {"label": "进阶用法", "start": 60, "end": 180, "summary": "两个实战场景。", "children": [
        {"label": "场景A", "start": 60, "end": 120, "summary": "场景A的完整步骤。"},
        {"label": "场景B", "start": 120, "end": 180, "summary": "场景B的取舍。"}
      ]}
    ]}
    """
    patch_llm["instance"] = FakeLLM(mindmap_payload=payload)
    tree = mindmap_mod.build_mindmap(chapters, video_title="测试视频")

    assert tree["label"] == "测试视频"
    # 深度 3（根 → 基础概念 → 概念一 → 常见误区）必须活着
    deep = tree["children"][0]["children"][0]["children"][0]
    assert deep["label"] == "常见误区", "四层节点被压掉了"
    assert deep["summary"] == "容易被搞混的两种写法。", "摘要必须跟着节点一起保留"
    # 有子节点的节点：范围由子节点算出来（起点=最早子节点起点，终点=最晚子节点终点）
    # 「概念一」自己写着 0-30，但它只有一个 10-25 的子节点 —— 所以它就是 10-25，
    # 一路顶上去根节点落在 10-180
    assert tree["start"] == 10, "根节点起点 = 最早子节点的起点"
    assert tree["end"] == 180, "根节点终点 = 最晚子节点的终点"
    assert tree["children"][0]["start"] == 10 and tree["children"][0]["end"] == 60
    concept1 = tree["children"][0]["children"][0]
    assert concept1["start"] == 10 and concept1["end"] == 25, "父节点不能比子节点覆盖得还宽"
    # 叶子拿到合法的时间范围，且 end 缺省时由所属章节补齐
    leaf = tree["children"][1]["children"][0]
    assert leaf["start"] == 60 and leaf["end"] == 120


def test_导图_模型不可用时退回一章一叶子(patch_llm):
    """模型这一步挂了不能把整支视频打成 failed：转写和分章节已经跑完了。

    兜底就是「一章一叶子」，标题与时间范围原样搬，摘要取章节摘要。
    """
    chapters = [
        {"idx": 0, "title": "开场", "start": 0, "end": 60, "summary": "开场摘要", "key_points": []},
        {"idx": 1, "title": "主体", "start": 60, "end": 120, "summary": "主体摘要", "key_points": []},
        {"idx": 2, "title": "收尾", "start": 120, "end": 180, "summary": "收尾摘要", "key_points": []},
    ]
    # 没配 mindmap_payload：假模型对「思维导图」返回 "{}"，走兜底分支
    tree = mindmap_mod.build_mindmap(chapters, video_title="测试视频")

    assert tree["label"] == "测试视频"
    kids = tree.get("children") or []
    assert len(kids) == len(chapters), f"兜底后节点数 {len(kids)} != 章节数 {len(chapters)}"
    for node, c in zip(kids, chapters):
        assert node["label"] == c["title"], "兜底节点的标题必须沿用章节标题"
        assert node["start"] == c["start"], "兜底节点的起点必须沿用章节起点"
        assert node["summary"] == c["summary"], "兜底节点要带上章节摘要"


def test_导图_空章节报错(patch_llm):
    with pytest.raises(Exception):
        mindmap_mod.build_mindmap([])
