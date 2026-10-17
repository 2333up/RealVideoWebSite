"""ffmpeg 能力探测与 DASH 音视频合并。

为什么需要它：B 站的 MP4 直链（playurl 的 fnval=1）清晰度上限就是 720P，
1080P 及以上只以 DASH 形式下发——视频流与音频流是分开的两个文件，
必须合并才能成为一个能正常播放、带声音的 mp4。

合并用 -c copy 直接封装，不重新编码，所以耗时主要在网络下载而不是 CPU。
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)


def ffmpeg_path() -> str:
    """返回 ffmpeg 可执行文件路径；未配置时回落到 PATH 中查找。"""
    if settings.FFMPEG_LOCATION:
        return settings.FFMPEG_LOCATION
    return shutil.which("ffmpeg") or "ffmpeg"


def ffmpeg_available() -> bool:
    """ffmpeg 是否可用——决定能否提供「需合并」的高画质档位。"""
    if settings.FFMPEG_LOCATION:
        return (
            Path(settings.FFMPEG_LOCATION).is_file()
            or shutil.which(settings.FFMPEG_LOCATION) is not None
        )
    return shutil.which("ffmpeg") is not None


async def merge_av(video: Path, audio: Path, out: Path, timeout: float = 1800.0) -> Path:
    """把 DASH 的视频流与音频流封装成一个 mp4（不重编码）。

    -map 只取一路视频与一路音频：DASH 里可能带多条备用流，
    不指定时会把全部流都塞进输出文件，导致播放器只认第一条、
    甚至出现「有画面没声音」的假象。
    """
    cmd = [
        ffmpeg_path(),
        "-y",
        "-i",
        str(video),
        "-i",
        str(audio),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(out),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("ffmpeg 合并超时") from None

    if proc.returncode != 0:
        tail = (err or b"").decode("utf-8", "ignore")[-300:]
        raise RuntimeError(f"ffmpeg 合并失败（code={proc.returncode}）: {tail}")
    return out
