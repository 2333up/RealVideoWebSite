"""video-mind 完整性自检。

用途：判断「下载的模型 / 音频 / 数据库」是否被损坏，而不是只看文件大小。
设计原则：能真正解码/加载的东西就不靠猜——模型用 CTranslate2 实载并跑一次转写，
音频用 ffprobe 探测，数据库用 PRAGMA integrity_check。
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.compat import ensure_av_compatible, ensure_cuda_dll_path  # noqa: E402
from core.config import ARTIFACT_DIR, DATA_DIR, DB_PATH  # noqa: E402

MODEL_DIR = DATA_DIR / "models" / "faster-whisper" / "large-v3"

OK, BAD, WARN = "✅", "❌", "⚠️ "


def line(status: str, name: str, detail: str = "") -> bool:
    print(f"{status} {name}" + (f" — {detail}" if detail else ""))
    return status == OK


def check_db() -> None:
    print("\n【1】数据库")
    if not DB_PATH.exists():
        line(BAD, "videomind.db", "文件不存在")
        return
    line(OK, "文件存在", f"{DB_PATH.stat().st_size:,} bytes")
    con = sqlite3.connect(str(DB_PATH))
    res = con.execute("PRAGMA integrity_check").fetchone()[0]
    line(OK if res == "ok" else BAD, "integrity_check", res)
    for t in ("videos", "transcripts", "chapters", "mindmaps", "jobs"):
        try:
            n = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"     {t}: {n} 行")
        except Exception as e:  # noqa: BLE001
            line(BAD, f"表 {t}", str(e))
    # 孤儿任务：服务已停但 job 卡在非终态
    rows = con.execute(
        "SELECT id, video_id, stage, progress, message, error, updated_at FROM jobs"
    ).fetchall()
    for r in rows:
        print(f"     job#{r[0]} video={r[1]} stage={r[2]} {r[3]}% msg={r[4]!r} err={r[5]!r} @ {r[6]}")
        print(f"     {WARN} 该 job 处于非终态，若服务已停止则为孤儿任务，需重置")
    con.close()


def check_ffmpeg() -> str | None:
    print("\n【2】ffmpeg / ffprobe")
    exe = shutil.which("ffprobe")
    if not exe:
        line(BAD, "ffprobe", "未安装或不在 PATH")
        return None
    line(OK, "ffprobe", exe)
    return exe


def probe(ffprobe: str, path: Path, label: str) -> bool:
    if not path.exists():
        return line(BAD, label, "文件不存在")
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries",
             "format=duration,size,bit_rate:stream=codec_name,codec_type",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0:
            return line(BAD, label, f"ffprobe 退出 {out.returncode}: {out.stderr[:200]}")
        info = json.loads(out.stdout)
        dur = float(info["format"]["duration"])
        br = int(info["format"].get("bit_rate", 0))
        codecs = [s.get("codec_name") for s in info.get("streams", [])]
        return line(OK, label, f"{path.stat().st_size:,} bytes | {dur:.1f}s | {br//1000}kbps | {codecs}")
    except Exception as e:  # noqa: BLE001
        return line(BAD, label, f"{type(e).__name__}: {e}")


def check_videos(ffprobe: str | None) -> None:
    print("\n【3】已登记视频的源文件")
    con = sqlite3.connect(str(DB_PATH))
    rows = con.execute("SELECT id, title, path, duration, status FROM videos").fetchall()
    con.close()
    for vid, title, path, dur, status in rows:
        p = Path(path)
        if not p.exists():
            line(BAD, f"#{vid} {title[:30]}", f"源文件丢失: {path}")
            continue
        print(f"   #{vid} {title[:34]} | 库中 {dur:.1f}s | status={status}")
        if ffprobe:
            probe(ffprobe, p, f"    源文件")


def check_artifacts(ffprobe: str | None) -> None:
    print("\n【4】中间产物")
    if not ARTIFACT_DIR.exists():
        line(BAD, "artifacts 目录", "不存在")
        return
    for d in sorted(ARTIFACT_DIR.iterdir()):
        if not d.is_dir():
            continue
        print(f"   artifacts/{d.name}/")
        for f in sorted(d.iterdir()):
            if f.suffix == ".json":
                try:
                    obj = json.loads(f.read_text(encoding="utf-8"))
                    if isinstance(obj, list):
                        line(OK, f"    {f.name}", f"合法 JSON，{len(obj)} 项")
                    else:
                        line(OK, f"    {f.name}",
                             f"合法 JSON，键 {list(obj)[:6]}")
                except Exception as e:  # noqa: BLE001
                    line(BAD, f"    {f.name}", f"JSON 损坏: {e}")
            elif ffprobe and f.suffix in (".mp3", ".m4a", ".wav"):
                probe(ffprobe, f, f"    {f.name}")
            else:
                line(OK, f"    {f.name}", f"{f.stat().st_size:,} bytes")


def check_model() -> None:
    print("\n【5】faster-whisper large-v3 模型")
    if not MODEL_DIR.exists():
        line(BAD, "模型目录", str(MODEL_DIR))
        return
    for f in sorted(MODEL_DIR.iterdir()):
        print(f"     {f.name:26s} {f.stat().st_size:>14,d} bytes")

    try:
        import ctranslate2
    except Exception as e:  # noqa: BLE001
        line(BAD, "ctranslate2 导入", str(e))
        return
    print(f"     ctranslate2 {ctranslate2.__version__} | CUDA 设备数 "
          f"{ctranslate2.get_cuda_device_count()}")

    t0 = time.time()
    try:
        ensure_av_compatible()
        ensure_cuda_dll_path()
        from faster_whisper import WhisperModel
        model = WhisperModel(
            str(MODEL_DIR), device="cuda", compute_type="float16"
        )
        line(OK, "CTranslate2 实载模型", f"{time.time() - t0:.1f}s（未报 incomplete 即文件完整）")
    except Exception as e:  # noqa: BLE001
        line(BAD, "CTranslate2 实载模型", f"{type(e).__name__}: {e}")
        return

    # 真正跑一次转写才算通过：只加载不推理，权重损坏仍可能蒙混过关
    audio = None
    for cand in sorted(ARTIFACT_DIR.glob("*/audio.mp3")):
        audio = cand
        break
    if audio is None:
        line(WARN, "实机转写", "无可用音频，跳过")
        return
    t1 = time.time()
    try:
        segs, info = model.transcribe(
            str(audio), language="zh", beam_size=5, vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        segs = list(segs)
    except Exception as e:  # noqa: BLE001
        line(BAD, "实机转写", f"{type(e).__name__}: {e}")
        return
    if not segs:
        line(WARN, "实机转写", f"{time.time() - t1:.1f}s，但无语音段（可能音频无语音）")
        return
    total = sum(s.end - s.start for s in segs)
    line(OK, "实机转写",
         f"{time.time() - t1:.1f}s | {len(segs)} 段 | 语音总长 {total:.1f}s | "
         f"语言 {info.language} ({info.language_probability:.2f})")
    print(f"     首段 [{segs[0].start:.1f}-{segs[0].end:.1f}] {segs[0].text[:60]}")
    print(f"     末段 [{segs[-1].start:.1f}-{segs[-1].end:.1f}] {segs[-1].text[:60]}")


def main() -> int:
    print("=" * 72)
    print("video-mind 完整性自检")
    print("=" * 72)
    check_db()
    ffprobe = check_ffmpeg()
    check_videos(ffprobe)
    check_artifacts(ffprobe)
    check_model()
    print("\n" + "=" * 72)
    print("检查结束")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
