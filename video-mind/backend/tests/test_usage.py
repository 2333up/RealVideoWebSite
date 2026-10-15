"""LLM 用量记账的测试。

这块的价值全在「数字对不对」：字段解析漏一个、取后没清空导致重复计数，
用户看到的账单就全错了，而且错得很隐蔽（不会报错，只会数字虚高）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from providers.llm import take_all_usage  # noqa: E402
from providers.llm.base import LLMProvider, UsageRecord  # noqa: E402
from providers.llm.openai_compatible import OpenAICompatProvider  # noqa: E402


class Recorder(LLMProvider):
    """只实现记账所需的最小接口。"""

    id = "rec"
    name = "记账测试"

    def chat(self, system, user, temperature=0.2, max_tokens=4096, purpose="") -> str:
        return ""


@pytest.fixture(autouse=True)
def clean_ledger():
    """全局账本是进程级共享状态，测试之间必须隔离。

    少了这个 fixture，前一个测试留下的记录会渗进下一个测试的断言里
    （表现为「期望 33 实际 1615」这种莫名其妙的数字）。
    """
    take_all_usage()
    yield
    take_all_usage()


def test_total_tokens_是输入输出之和():
    r = UsageRecord(prompt_tokens=100, completion_tokens=25)
    assert r.total_tokens == 125


def test_字段名各家不统一时要宽松解析():
    """有的服务商返回 input_tokens / output_tokens，不能只认 OpenAI 那套。"""
    p = Recorder()
    rec = p._record_usage({"input_tokens": 300, "output_tokens": 40}, purpose="分章节")
    assert (rec.prompt_tokens, rec.completion_tokens, rec.total_tokens) == (300, 40, 340)


def test_usage缺失时为0而不是崩溃():
    """记账绝不能把主流程搞崩——拿不到就记 0。"""
    p = Recorder()
    rec = p._record_usage(None, purpose="分章节")
    assert rec.total_tokens == 0
    rec2 = p._record_usage({"weird_field": 1}, purpose="分章节")
    assert rec2.total_tokens == 0


def test_字符串数字也能解析():
    p = Recorder()
    rec = p._record_usage({"prompt_tokens": "120", "completion_tokens": "30"}, purpose="x")
    assert rec.total_tokens == 150


def test_布尔值不能被当成token数():
    """isinstance(True, int) 为真，必须排除，否则会记出 1 个 token 的幽灵消耗。"""
    p = Recorder()
    rec = p._record_usage({"prompt_tokens": True}, purpose="x")
    assert rec.prompt_tokens == 0


def test_take_usage取后清空_避免跨任务串账():
    p = Recorder()
    p._record_usage({"prompt_tokens": 10, "completion_tokens": 5}, purpose="分章节")
    p._record_usage({"prompt_tokens": 20, "completion_tokens": 5}, purpose="导图")

    first = p.take_usage()
    assert len(first) == 2
    assert sum(r.total_tokens for r in first) == 40
    # 第二次必须为空：否则同一次调用会被重复计入下一个任务
    assert p.take_usage() == []


def test_purpose被正确记录():
    """没有 purpose 就无法回答「钱花在哪一步」。"""
    p = Recorder()
    p._record_usage({"prompt_tokens": 1}, purpose="分章节")
    p._record_usage({"prompt_tokens": 1}, purpose="思维导图")
    assert [r.purpose for r in p.take_usage()] == ["分章节", "思维导图"]


def test_take_all_usage能跨实例收集():
    """管线每一步都新建 provider，全局收集器必须能把它们全捞出来。"""
    a, b = Recorder(), Recorder()
    a._record_usage({"prompt_tokens": 10, "completion_tokens": 1}, purpose="分章节")
    b._record_usage({"prompt_tokens": 20, "completion_tokens": 2}, purpose="思维导图")

    got = take_all_usage()
    total = sum(r.total_tokens for r in got)
    assert total == 33
    # 取走后再取应为空
    assert take_all_usage() == []


def test_provider被回收后用量仍在():
    """**这个测试守护的是一个真实踩过的坑。**

    管线里的写法是 `llm = get_llm()` —— 局部变量，函数一返回就可能被引擎回收。
    如果用量挂在实例上、靠 WeakSet 追踪实例，这时候就全丢了，
    表现为「分析明明跑完了，用量却永远是 0」。
    而且单测里局部变量还持有强引用，GC 不会动它，所以常规测试抓不到。

    结论：用量必须在调用发生的瞬间写进全局账本。
    """
    import gc

    def run_step():
        # 复刻管线里的真实作用域：实例只活在函数内
        p = Recorder()
        p._record_usage({"prompt_tokens": 100, "completion_tokens": 20}, purpose="分章节")

    run_step()
    gc.collect()  # 强制回收，模拟真实运行中的 GC 时机

    got = take_all_usage()
    assert sum(r.total_tokens for r in got) == 120, "实例被 GC 后用量不能丢"
    assert got[0].purpose == "分章节"


def test_openai_provider会把usage写进日志(monkeypatch):
    """端到端：真实 provider 解析响应后必须记账。"""
    import httpx

    class FakeResp:
        status_code = 200

        def json(self):
            return {
                "model": "deepseek-flash",
                "choices": [
                    {"message": {"content": "你好"}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 200},
            }

        @property
        def text(self):
            return "{}"

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, *a, **kw):
            return FakeResp()

    monkeypatch.setattr(httpx, "Client", lambda **kw: FakeClient())
    p = OpenAICompatProvider(
        base_url="http://x", api_key="k", model="deepseek-flash", provider_id="deepseek"
    )
    p.chat("sys", "user")

    recs = p.take_usage()
    assert len(recs) == 1
    assert recs[0].total_tokens == 1200
    assert recs[0].model == "deepseek-flash"
