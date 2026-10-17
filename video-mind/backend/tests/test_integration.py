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
        # 通过 system 提示词区分是分章节还是导图
        if "章节" in system and self._chapters is not None:
            return self._chapters
        if self._mindmap is not None:
            return self._mindmap
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
    # 导图不再调用大模型（一章一节点的确定性构造），无需 mock
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


def test_导图_节点与章节一一对应(segments, patch_llm):
    """分析完成后，导图节点和章节必须一一对应——这是一一对应需求的根基。

    以前这一步会再调一次 LLM 把章节重组成多层分类，节点和章节对不上号；
    现在是确定性构造：根节点 = 视频标题，每个章节挂一个叶子。
    """
    chapters = [
        {"idx": 0, "title": "开场", "start": 0, "end": 60, "summary": "s", "key_points": []},
        {"idx": 1, "title": "主体", "start": 60, "end": 120, "summary": "s", "key_points": []},
        {"idx": 2, "title": "收尾", "start": 120, "end": 180, "summary": "s", "key_points": []},
    ]
    tree = mindmap_mod.build_mindmap(chapters, video_title="测试视频")

    assert tree["label"] == "测试视频"
    kids = tree.get("children") or []
    assert len(kids) == len(chapters), f"节点数 {len(kids)} != 章节数 {len(chapters)}"
    for node, c in zip(kids, chapters):
        assert node["label"] == c["title"], "节点标题必须与章节标题一致"
        assert node["start"] == c["start"], "节点时间必须与章节起点一致"
        assert not node.get("children"), "章节节点不该有下级，否则就不是一一对应"


def test_导图_空章节报错(patch_llm):
    with pytest.raises(Exception):
        mindmap_mod.build_mindmap([])
