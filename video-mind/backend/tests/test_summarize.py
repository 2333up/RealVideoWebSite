"""「按时间区间重写摘要」的测试。

核心承诺只有一条：**只依据这段原文写摘要**。
所以测试盯的是「喂给模型的文本里，有没有混进区间外的内容」——
混进去，摘要就又会变成整章的概括。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import summarize as sum_mod  # noqa: E402
from providers.llm.base import LLMProvider  # noqa: E402

SEGS = [
    {"start": 0, "end": 10, "text": "开场寒暄，今天聊聊合同法"},
    {"start": 10, "end": 20, "text": "第一个问题：签名算不算意思表示"},
    {"start": 60, "end": 70, "text": "第二个问题：重大误解怎么认定"},
    {"start": 70, "end": 80, "text": "重大误解需要以意思表示为前提"},
]


class FakeLLM(LLMProvider):
    id = "fake"
    name = "假模型"

    def __init__(self):
        super().__init__()
        self.last_user = ""

    def chat(self, system, user, **kw):  # type: ignore[override]
        self.last_user = user
        return "ok"

    def chat_json(self, system, user, **kw):  # type: ignore[override]
        self.last_user = user
        return {"summary": "这一段讲了签名的性质。", "key_points": ["签名不等于意思表示"]}


@pytest.fixture()
def fake(monkeypatch):
    inst = FakeLLM()

    def _get():
        return inst

    monkeypatch.setattr(sum_mod, "get_llm", _get)
    return inst


def test_只取区间内的片段():
    text = sum_mod.render_slice(SEGS, 0, 20)
    assert "签名算不算意思表示" in text
    assert "重大误解" not in text, "区间外的内容不能混进来"
    assert "[00:00]" in text and "[00:10]" in text


def test_区间外为空时不调模型(fake):
    r = sum_mod.rewrite_summary("某个标题", SEGS, 20, 60)
    assert r == {"summary": "", "key_points": []}
    assert fake.last_user == "", "没有原文就不该打模型（更不能凭标题编）"


def test_提示词里只有这一段(fake):
    sum_mod.rewrite_summary("签名的性质", SEGS, 0, 20)
    assert "签名算不算意思表示" in fake.last_user
    assert "重大误解" not in fake.last_user
    assert "签名的性质" in fake.last_user, "标题要一起给，模型才知道这段在讲什么"


def test_跨区间取交集():
    """片段和区间只重叠一部分也要算进来（避免卡边界丢内容）"""
    text = sum_mod.render_slice(SEGS, 15, 65)
    assert "签名算不算意思表示" in text  # 10-20 与 15-65 有交集
    assert "重大误解怎么认定" in text  # 60-70 与 15-65 有交集
    assert "开场寒暄" not in text  # 0-10 完全在区间外


def test_超长原文中间截断():
    long_text = "A" * 5000 + "B" * 5000
    clipped = sum_mod._clip(long_text, limit=1000)
    assert clipped.startswith("A")
    assert clipped.endswith("B"), "头尾都要留：只留开头会让模型以为整段只讲第一件事"
    assert "中间省略" in clipped
    assert len(clipped) < 1200
