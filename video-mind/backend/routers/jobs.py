"""长任务接口（Init-Step-Poll 模式）。

视频分析动辄十几分钟，不可能让 HTTP 请求挂着等。
前端拿 job_id 轮询，后端把「阶段 + 百分比 + 文案」回写进 job 表。
"""

from __future__ import annotations

import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.database import SessionLocal, get_db
from core.models import Job, Video
from pipeline import runner

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


class StartRequest(BaseModel):
    video_id: int
    force: bool = False  # 已处理过的视频是否重跑


@router.post("")
def start_job(req: StartRequest, db: Session = Depends(get_db)):
    v = db.get(Video, req.video_id)
    if not v:
        raise HTTPException(404, "视频不存在")

    # 已有任务在跑时拒绝新任务：GPU 显存与 CPU 都撑不住并行转写
    running = (
        db.query(Job)
        .filter(Job.stage.notin_(["done", "failed"]))
        .first()
    )
    if running:
        raise HTTPException(
            409,
            f"已有任务正在处理「{running.video.title if running.video else '未知视频'}」，"
            "请等待其完成或先取消。",
        )

    job = Job(video_id=v.id, stage="queued", progress=0, message="排队中…")
    db.add(job)
    v.status = "processing"
    v.error = ""
    db.commit()
    db.refresh(job)

    thread = threading.Thread(
        target=runner.run_pipeline,
        args=(v.id, job.id, SessionLocal),
        daemon=True,
    )
    thread.start()

    return {"job_id": job.id, "video_id": v.id}


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    return {
        "id": job.id,
        "video_id": job.video_id,
        "stage": job.stage,
        "progress": job.progress,
        "message": job.message,
        "error": job.error,
        "cancel_requested": bool(job.cancel_requested),
    }


@router.post("/{job_id}/cancel")
def cancel_job(job_id: int, db: Session = Depends(get_db)):
    """协作式取消：置标志位，管线在每个阶段边界检查后自行退出。

    不用强制 kill 线程——那会让模型显存与实际状态脱节。
    """
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    job.cancel_requested = 1
    db.commit()
    runner.request_cancel(job_id)
    return {"ok": True}
