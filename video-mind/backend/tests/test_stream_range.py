"""视频流接口（HTTP Range）的测试。

这个接口有两个「写错就会让播放器假死」的点，所以单独测：

1. **开放式区间必须夹窗口**。浏览器为了拿 MP4 的 moov 会先发 `bytes=0-`；
   很多文件 moov 在尾部（本项目就有 489MB 的例子），浏览器拿到文件头就 abort、
   改去请求尾部。若不设上限，服务端会在被 abort 前一路把几百 MB 推过去，
   每次 seek 白推一遍，攒几条就能把 dev 代理的连接槽占满——
   表现是「点节点后一直显示加载中，播放按钮不出现」。
2. **客户端断开后要停止读盘**。否则生成器会继续把剩下的字节读完写进没人收的
   socket，白占 CPU 和磁盘。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import videos as videos_mod  # noqa: E402
from routers.videos import OPEN_RANGE_CAP, RangeFileResponse  # noqa: E402


def make_file(tmp_path: Path, size: int) -> Path:
    """造一个指定大小的假视频文件（内容无所谓，只测区间与长度）"""
    p = tmp_path / "clip.mp4"
    with p.open("wb") as f:
        f.write(b"\0" * size)
    return p


def drain(resp: RangeFileResponse) -> int:
    """把响应体读完，返回总字节数（不留在内存里）"""

    async def run() -> int:
        total = 0
        async for chunk in resp.body_iterator:
            total += len(chunk)
        return total

    return asyncio.run(run())


class FakeRequest:
    """假的 Request：只实现 is_disconnected，用来模拟浏览器中途 abort。

    注意 `is_disconnected` 是**每 8 个块探一次**，所以它不是被调用 8 次；
    `disconnect_on_check=1` 表示「第一次探测就说断开」。
    """

    def __init__(self, disconnect_on_check: int | None = None):
        self.calls = 0
        self._on = disconnect_on_check

    async def is_disconnected(self) -> bool:
        self.calls += 1
        return self._on is not None and self.calls >= self._on


@pytest.fixture()
def big_file(tmp_path: Path) -> Path:
    """比窗口大 1MB 的文件：刚好能验证「夹」与「不夹」的边界"""
    return make_file(tmp_path, OPEN_RANGE_CAP + 1024 * 1024)


def test_开放式区间被夹到窗口内(big_file: Path):
    size = big_file.stat().st_size
    resp = RangeFileResponse(big_file, range_header="bytes=0-")

    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 0-{OPEN_RANGE_CAP - 1}/{size}"
    assert int(resp.headers["content-length"]) == OPEN_RANGE_CAP
    assert drain(resp) == OPEN_RANGE_CAP


def test_明确终点不夹(big_file: Path):
    size = big_file.stat().st_size
    resp = RangeFileResponse(big_file, range_header="bytes=100-200")

    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 100-200/{size}"
    assert int(resp.headers["content-length"]) == 101
    assert drain(resp) == 101


def test_尾部区间按后缀理解(big_file: Path):
    size = big_file.stat().st_size
    resp = RangeFileResponse(big_file, range_header="bytes=-1024")

    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes {size - 1024}-{size - 1}/{size}"
    assert drain(resp) == 1024


def test_小文件开放区间整段返回(tmp_path: Path):
    """比窗口小的文件没必要分块：直接一次给完，少一次往返"""
    p = make_file(tmp_path, 1024 * 1024)
    resp = RangeFileResponse(p, range_header="bytes=0-")

    assert resp.status_code == 206
    assert int(resp.headers["content-length"]) == 1024 * 1024
    assert drain(resp) == 1024 * 1024


def test_无Range头返回200全量(tmp_path: Path):
    p = make_file(tmp_path, 2048)
    resp = RangeFileResponse(p, range_header="")

    assert resp.status_code == 200
    assert int(resp.headers["content-length"]) == 2048
    assert "content-range" not in resp.headers
    assert drain(resp) == 2048


def test_客户端断开后停止读盘(big_file: Path):
    """模拟浏览器 seek 时 abort：探到断开就不该继续读（1MB 一块，每 8 块探一次）"""
    req = FakeRequest(disconnect_on_check=1)
    resp = RangeFileResponse(big_file, range_header="bytes=0-", request=req)

    sent = drain(resp)
    # 第一次探测（第 8 个块之前）就说断开了 -> 只发了 7 块
    assert sent == OPEN_RANGE_CAP - videos_mod.CHUNK_SIZE
    assert req.calls == 1


def test_窗口常量与分块的关系():
    """窗口是分块大小的整数倍：否则最后一块会小得可怜，白白多一次读盘"""
    assert OPEN_RANGE_CAP % videos_mod.CHUNK_SIZE == 0
