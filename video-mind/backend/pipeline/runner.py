"""处理流水线编排。

四个阶段串行推进，每完成一步就把中间产物落盘：
这样任一步失败都可以单独重跑，不必从头再来（长视频转写很贵）。

    extract_audio -> transcribe -> chapter -> mindmap

进度回写采用「阶段 + 百分比」双信号，前端拿到的既是状态也是可展示的文案。
"""

from __future__ import annotations

import json
import threading
import traceback
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from core import config
from core.config import settings
from core.models import Chapter, Job, LLMUsage, MindMap, Transcript, Video
from providers.asr import get_asr
from providers.asr.base import Segment
from providers.llm import take_all_usage
from . import chapter as chapter_mod
from . import media, mindmap as mindmap_mod

# 同一时刻只允许一个任务在跑：GPU 显存与 CPU 都吃不消并行转写
_exec_lock = threading.Lock()
_cancel_flags: dict[int, bool] = {}


def request_cancel(job_id: int) -> None:
    _cancel_flags[job_id] = True


#: 终态：这两个阶段之外的 job 都视为「还在跑」
TERMINAL_STAGES = ("done", "failed")


def reset_orphan_jobs(db) -> int:
    """把上一次进程残留的非终态任务标记为失败。

    为什么必须做：job 跑在**本进程**的后台线程里，进程一死线程就没了，
    但数据库里的 stage 还停在 `transcribe`——重启后它既不会继续推进，
    又会让路由层以为「有任务在跑」而永久拒绝新任务（409）。
    用户视角就是：视频永远卡在「处理中」，点重新分析也没用，只能手动改库。

    进程刚启动时任何非终态 job 都必然是孤儿，所以这里无条件重置是安全的。
    返回被重置的数量，便于启动时打日志。
    """
    orphans = db.query(Job).filter(Job.stage.notin_(TERMINAL_STAGES)).all()
    for job in orphans:
        job.stage = "failed"
        job.error = "服务重启，任务被中断。请对该视频重新分析。"
        video = db.get(Video, job.video_id)
        if video is not None and video.status == "processing":
            # 回退到 pending 而不是 failed：用户可以直接重跑，不用改任何东西
            video.status = "pending"
            video.error = ""
    if orphans:
        db.commit()
    return len(orphans)


def _is_cancelled(job_id: int) -> bool:
    return _cancel_flags.get(job_id, False)


def _update(job: Job, db: Session, stage: str, progress: int, message: str) -> None:
    job.stage = stage
    job.progress = max(0, min(100, progress))
    job.message = message
    db.commit()


def _flush_usage(db: Session, job_id: int, video_id: int) -> int:
    """把本阶段累计的 LLM 用量落库。

    在阶段边界调用（而不是等全部跑完），好处有两个：
    一是中途失败也能看到已经烧掉的 token，二是能区分每步各花多少。
    take_all_usage 取后即清，不会把同一次调用重复计入下一阶段。
    """
    records = take_all_usage()
    if not records:
        return 0
    provider_id = settings.llm_provider
    for rec in records:
        db.add(
            LLMUsage(
                job_id=job_id,
                video_id=video_id,
                provider=provider_id,
                model=rec.model,
                purpose=rec.purpose,
                prompt_tokens=rec.prompt_tokens,
                completion_tokens=rec.completion_tokens,
                cached_tokens=rec.cached_tokens,
                total_tokens=rec.total_tokens,
            )
        )
    db.commit()
    return len(records)


# ------------------------------------------------------------------ 对外入口

def run_pipeline(video_id: int, job_id: int, db_factory) -> None:
    """在后台线程中执行；所有异常都收敛成 job.error，不让线程静默死亡。"""
    if not _exec_lock.acquire(blocking=False):
        # 理论上不会走到这里（路由层已拦截），留作兜底
        db = db_factory()
        try:
            job = db.get(Job, job_id)
            if job:
                job.stage = "failed"
                job.error = "已有任务正在处理中，请等待其完成后再试。"
                db.commit()
        finally:
            db.close()
        return

    db = db_factory()
    try:
        job = db.get(Job, job_id)
        video = db.get(Video, video_id)
        if not job or not video:
            return

        # 起跑时间在这里记，而不是建 job 行时记：
        # 同一时刻只允许一个任务在跑，排在后面的任务建完行还要排队，
        # 用 created_at 会把「排队等别人的时间」算进本次耗时里。
        job.started_at = datetime.now()
        job.finished_at = None
        db.commit()

        _execute(job, video, db)
    except Exception as exc:  # noqa: BLE001 - 兜底：把任何异常转成用户可见的错误
        db.rollback()
        job = db.get(Job, job_id)
        video = db.get(Video, video_id)
        if job:
            job.stage = "failed"
            job.error = f"{type(exc).__name__}: {exc}"
            if job.finished_at is None:
                job.finished_at = datetime.now()
            db.commit()
        if video:
            video.status = "failed"
            video.error = str(exc)
            db.commit()
        traceback.print_exc()
    finally:
        _cancel_flags.pop(job_id, None)
        _exec_lock.release()
        db.close()


def _execute(job: Job, video: Video, db: Session) -> None:
    art_dir = media.artifact_dir(video.id)
    audio_path = art_dir / "audio.mp3"

    # ---------------- 阶段 1：抽音频 ----------------
    _update(job, db, "extract_audio", 1, "读取视频信息…")
    probe = media.probe(video.path)

    video.duration = probe.duration
    db.commit()

    if not probe.has_audio:
        raise RuntimeError(
            "该视频没有音轨，无法进行语音转写。请确认文件包含声音，或换一个视频试。"
        )

    if _is_cancelled(job.id):
        raise RuntimeError("任务已被取消")

    media.extract_audio(
        video.path, audio_path,
        on_progress=lambda p, m: _update(job, db, "extract_audio", p, m),
    )

    # ---------------- 阶段 2：转写 ----------------
    if _is_cancelled(job.id):
        raise RuntimeError("任务已被取消")

    _update(job, db, "transcribe", 12, "准备语音转写…")
    asr = get_asr()

    def asr_progress(p: int, m: str) -> None:
        # 转写映射到 12% -> 62%
        _update(job, db, "transcribe", 12 + int(p * 0.5), m)

    result = asr.transcribe(
        str(audio_path),
        language=settings.language,
        on_progress=asr_progress,
    )

    # 中间产物落盘：换 ASR 或调 prompt 时可以复用同一份转写，省下最贵的这步
    (art_dir / "transcript.json").write_text(
        json.dumps(
            {
                "provider": result.provider,
                "language": result.language,
                "segments": [s.to_dict() for s in result.segments],
            },
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )

    tr = video.transcript or Transcript(video_id=video.id)
    tr.provider = result.provider
    tr.language = result.language
    tr.segments = [s.to_dict() for s in result.segments]
    tr.full_text = result.full_text
    db.add(tr)
    db.commit()

    segments = result.segments

    # ---------------- 阶段 3：分章节 ----------------
    if _is_cancelled(job.id):
        raise RuntimeError("任务已被取消")

    def chapter_progress(p: int, m: str) -> None:
        # 章节映射到 65% -> 80%
        _update(job, db, "chapter", 65 + int((p - 65) * 0.75), m)

    chapters = chapter_mod.build_chapters(segments, on_progress=chapter_progress)

    # 写入前先清空旧章节，保证「重新分析」不会留下幽灵数据
    db.query(Chapter).filter(Chapter.video_id == video.id).delete()
    for c in chapters:
        db.add(
            Chapter(
                video_id=video.id,
                idx=c["idx"],
                title=c["title"],
                start=c["start"],
                end=c["end"],
                summary=c["summary"],
                key_points=c["key_points"],
            )
        )
    db.commit()

    chapter_dicts = [
        {
            "idx": c["idx"], "title": c["title"], "start": c["start"],
            "end": c["end"], "summary": c["summary"], "key_points": c["key_points"],
        }
        for c in chapters
    ]
    (art_dir / "chapters.json").write_text(
        json.dumps(chapter_dicts, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _flush_usage(db, job.id, video.id)

    # ---------------- 阶段 4：思维导图 ----------------
    if _is_cancelled(job.id):
        raise RuntimeError("任务已被取消")

    def mm_progress(p: int, m: str) -> None:
        _update(job, db, "mindmap", p, m)

    tree = mindmap_mod.build_mindmap(
        chapter_dicts, video_title=video.title, on_progress=mm_progress
    )

    mm = video.mindmap or MindMap(video_id=video.id)
    mm.tree = tree
    db.add(mm)
    db.commit()

    (art_dir / "mindmap.json").write_text(
        json.dumps(tree, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _flush_usage(db, job.id, video.id)

    # ---------------- 收尾 ----------------
    video.status = "ready"
    video.error = ""
    job.finished_at = datetime.now()
    db.commit()
    _update(job, db, "done", 100, f"完成：{len(chapters)} 个章节")
