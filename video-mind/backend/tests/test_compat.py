"""依赖兼容层与孤儿任务重置的测试。

这两块都是「环境一变就炸、但炸起来看不出原因」的地方，必须有测试守住。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import compat  # noqa: E402


# ------------------------------------------------------------ av 兼容补丁


class _FakeAV:
    """模拟 PyAV：open() 是否接受 metadata_errors 由 supported 决定。"""

    def __init__(self, supported: bool):
        self.supported = supported
        self.calls: list[dict] = []

    def open(self, *args, **kwargs):
        self.calls.append(dict(kwargs))
        if not self.supported and "metadata_errors" in kwargs:
            # 真实 PyAV>=19 的报错形态
            raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")
        return f"opened:{args},{sorted(kwargs)}"


@pytest.fixture
def patch_av(monkeypatch):
    """把 core.compat 里的 av 换成可控假对象，并重置幂等标记。"""
    monkeypatch.setattr(compat, "_patched", False)
    fake = _FakeAV(supported=False)
    monkeypatch.setitem(sys.modules, "av", fake)
    return fake


def test_剥离不支持的参数后能正常打开(patch_av):
    assert compat.ensure_av_compatible() is True
    assert patch_av.open("a.mp3", mode="r", metadata_errors="ignore") == (
        "opened:('a.mp3',),['mode']"
    )


def test_支持该参数时原样透传(monkeypatch):
    monkeypatch.setattr(compat, "_patched", False)
    fake = _FakeAV(supported=True)
    monkeypatch.setitem(sys.modules, "av", fake)
    compat.ensure_av_compatible()
    out = fake.open("a.mp3", metadata_errors="ignore")
    assert "metadata_errors" in out


def test_不相关的TypeError必须原样抛出(patch_av):
    """降级只能针对「参数被移除」，否则会掩盖真正的调用错误。"""

    def boom(*args, **kwargs):
        raise TypeError("open() missing 1 required positional argument: 'file'")

    patch_av.open = boom
    compat.ensure_av_compatible()
    import av as av_mod

    with pytest.raises(TypeError, match="missing 1 required"):
        av_mod.open()


def test_重复调用是幂等的(patch_av):
    assert compat.ensure_av_compatible() is True
    assert compat.ensure_av_compatible() is False


def test_未安装av时不报错(monkeypatch):
    monkeypatch.setattr(compat, "_patched", False)
    monkeypatch.setitem(sys.modules, "av", None)  # 触发 ImportError 分支
    # sys.modules 里放 None 会让 import av 抛 ImportError
    assert compat.ensure_av_compatible() is False


# ------------------------------------------------------------ 孤儿任务重置


def test_孤儿任务在启动时被重置():
    from pipeline.runner import TERMINAL_STAGES, reset_orphan_jobs

    class FakeVideo:
        def __init__(self, status):
            self.status = status
            self.error = "old"

    class FakeJob:
        def __init__(self, stage, video):
            self.stage = stage
            self.video_id = 1
            self.error = ""

    class FakeDB:
        """只实现被用到的查询接口：notin_ 过滤 + get + commit。"""

        def __init__(self, jobs):
            self._jobs = jobs
            self._video = FakeVideo("processing")
            self.committed = False

        def query(self, _model):
            db = self

            class Q:
                def filter(self, _cond):
                    class R:
                        def all(self):
                            return [j for j in db._jobs if j.stage not in TERMINAL_STAGES]
                    return R()
            return Q()

        def get(self, _model, _id):
            return self._video

        def commit(self):
            self.committed = True

    stuck = FakeJob("transcribe", None)
    done = FakeJob("done", None)
    failed = FakeJob("failed", None)
    db = FakeDB([stuck, done, failed])

    n = reset_orphan_jobs(db)

    assert n == 1, "只应重置非终态的那一个"
    assert stuck.stage == "failed"
    assert "重启" in stuck.error
    assert db._video.status == "pending", "视频要能直接重跑"
    assert db._video.error == ""
    assert db.committed is True
    # 终态任务不该被碰
    assert done.error == "" and failed.error == ""
