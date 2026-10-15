"""与 ffmpeg / ffprobe 打交道的全部逻辑，集中在这一个文件里。

只依赖系统 PATH 中的 ffmpeg、ffprobe，不引入额外 Python 音视频依赖。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from core.config import ARTIFACT_DIR


class MediaError(RuntimeError):
    """ffmpeg 相关失败。message 需包含可直接执行的修复建议。"""


def _require(binary: str) -> str:
    exe = shutil.which(binary)
    if not exe:
        raise MediaError(
            f"未在系统 PATH 中找到 {binary}。请安装 FFmpeg 并确保 {binary}.exe 可被命令行调用。"
        )
    return exe


FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


# ------------------------------------------------------------------ 探测

@dataclass
class ProbeResult:
    duration: float
    width: int = 0
    height: int = 0
    has_audio: bool = False
    has_video: bool = False


def probe(path: str | Path) -> ProbeResult:
    """读取媒体元信息。失败一律抛 MediaError，不返回半截数据。"""
    _require(FFPROBE)
    cmd = [
        FFPROBE, "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        str(path),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as exc:
        raise MediaError(f"ffprobe 探测超时：{path}") from exc

    if out.returncode != 0:
        raise MediaError(f"无法读取视频文件（可能已损坏或格式不支持）：{out.stderr[:400]}")

    try:
        info = json.loads(out.stdout)
    except json.JSONDecodeError as exc:
        raise MediaError(f"ffprobe 输出解析失败：{exc}") from exc

    duration = 0.0
    try:
        duration = float(info.get("format", {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    width = height = 0
    has_audio = has_video = False
    for st in info.get("streams", []):
        codec_type = st.get("codec_type")
        if codec_type == "video":
            has_video = True
            width = int(st.get("width") or 0)
            height = int(st.get("height") or 0)
            # 有些容器不写 format.duration，退一步用视频流时长
            if not duration:
                try:
                    duration = float(st.get("duration") or 0.0)
                except (TypeError, ValueError):
                    pass
        elif codec_type == "audio":
            has_audio = True

    if duration <= 0:
        raise MediaError(
            "无法获取视频时长。文件可能已损坏，或使用了 ffprobe 无法解析的封装格式。"
        )
    return ProbeResult(
        duration=duration, width=width, height=height,
        has_audio=has_audio, has_video=has_video,
    )


# ------------------------------------------------------------------ 抽音频

def extract_audio(
    video_path: str | Path,
    out_path: str | Path,
    on_progress: "callable | None" = None,
) -> Path:
    """抽取单声道 16kHz MP3，供 ASR 使用。

    用 mp3 而非 wav：1 小时音频 wav 约 115 MB，mp3 约 28 MB，
    云端上传与磁盘占用都差一个量级，而 ASR 精度几乎没有损失。
    """
    _require(FFMPEG)
    video_path = Path(video_path)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if on_progress:
        on_progress(2, "抽取音频轨道…")

    cmd = [
        FFMPEG, "-y", "-i", str(video_path),
        "-vn",                 # 去掉视频流
        "-ac", "1",            # 单声道：ASR 只关心语音，立体声纯属浪费
        "-ar", "16000",        # 16kHz：Whisper 原生采样率
        "-b:a", "64k",
        "-loglevel", "error",
        str(out_path),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    except subprocess.TimeoutExpired as exc:
        raise MediaError("音频抽取超时（>1 小时）。视频可能过长或磁盘 IO 异常。") from exc

    if out.returncode != 0 or not out_path.exists():
        raise MediaError(
            f"音频抽取失败：{out.stderr[:400]}\n"
            "若提示「does not contain any stream」，说明该视频没有音轨，无法做语音转写。"
        )

    if out_path.stat().st_size == 0:
        raise MediaError("抽取出的音频文件为空，视频可能没有有效音轨。")

    if on_progress:
        on_progress(10, f"音频抽取完成（{out_path.stat().st_size / 1024 / 1024:.1f} MB）")
    return out_path


# ------------------------------------------------------------------ 关键帧

def extract_keyframe(
    video_path: str | Path,
    timestamp: float,
    out_path: str | Path,
    width: int = 640,
) -> Path | None:
    """在指定秒数截取一张缩略图。失败返回 None（关键帧是锦上添花，不该阻断主流程）。"""
    _require(FFMPEG)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # -ss 放在 -i 之前：先 seek 再解码，长视频上快一个数量级
    cmd = [
        FFMPEG, "-y",
        "-ss", str(max(0.0, timestamp)),
        "-i", str(video_path),
        "-frames:v", "1",
        "-vf", f"scale={width}:-2",
        "-q:v", "4",
        "-loglevel", "error",
        str(out_path),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None

    if out.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
        return None
    return out_path


def artifact_dir(video_id: int) -> Path:
    d = ARTIFACT_DIR / str(video_id)
    d.mkdir(parents=True, exist_ok=True)
    return d
