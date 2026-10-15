"""大模型用量查询。

设计目标：用户能随时回答三个问题——
  1. 这部视频分析一次烧了多少 token？
  2. 钱花在哪一步（分章节 / 导图）？
  3. 我这个 Key 总共用了多少？

数据来自 llm_usage 表（每次调用一行明细），这里只做聚合，不存汇总结果，
避免「明细改了汇总没跟着变」的不一致。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from core.database import get_db
from core.models import LLMUsage, Video

router = APIRouter(prefix="/api/usage", tags=["usage"])


class UsageTotals(BaseModel):
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    total_tokens: int = 0


def _totals(rows) -> UsageTotals:
    """把查询结果聚合成总计。

    用 COALESCE 在 SQL 层兜底，避免某列是 None 时 Python 侧相加炸掉。
    """
    t = UsageTotals()
    for r in rows:
        t.calls += 1
        t.prompt_tokens += int(r.prompt_tokens or 0)
        t.completion_tokens += int(r.completion_tokens or 0)
        t.cached_tokens += int(r.cached_tokens or 0)
        t.total_tokens += int(r.total_tokens or 0)
    return t


def _group(rows, key: str) -> list[dict[str, Any]]:
    """按某个字段分组聚合，用于「按用途 / 按模型」的横向对比。"""
    buckets: dict[str, UsageTotals] = {}
    for r in rows:
        k = getattr(r, key) or "未标注"
        b = buckets.setdefault(k, UsageTotals())
        b.calls += 1
        b.prompt_tokens += int(r.prompt_tokens or 0)
        b.completion_tokens += int(r.completion_tokens or 0)
        b.cached_tokens += int(r.cached_tokens or 0)
        b.total_tokens += int(r.total_tokens or 0)
    out = [
        {
            "key": k,
            "calls": v.calls,
            "prompt_tokens": v.prompt_tokens,
            "completion_tokens": v.completion_tokens,
            "cached_tokens": v.cached_tokens,
            "total_tokens": v.total_tokens,
        }
        for k, v in buckets.items()
    ]
    return sorted(out, key=lambda x: -x["total_tokens"])


def video_usage_summary(db: Session, video_id: int) -> dict:
    """给视频详情接口用的轻量汇总。"""
    rows = db.query(LLMUsage).filter(LLMUsage.video_id == video_id).all()
    if not rows:
        return {"calls": 0, "total_tokens": 0, "by_purpose": []}
    t = _totals(rows)
    return {
        "calls": t.calls,
        "prompt_tokens": t.prompt_tokens,
        "completion_tokens": t.completion_tokens,
        "cached_tokens": t.cached_tokens,
        "total_tokens": t.total_tokens,
        "by_purpose": _group(rows, "purpose"),
    }


@router.get("")
def query_usage(video_id: int | None = None, db: Session = Depends(get_db)):
    """用量查询。带 video_id 时只查该视频，否则返回全局统计。"""
    q = db.query(LLMUsage)
    if video_id is not None:
        v = db.get(Video, video_id)
        if not v:
            raise HTTPException(404, "视频不存在")
        q = q.filter(LLMUsage.video_id == video_id)

    rows = q.order_by(LLMUsage.id.desc()).all()
    t = _totals(rows)

    # 逐视频聚合：全局视图下才知道哪部视频最费 token
    per_video: dict[int | None, dict] = {}
    for r in rows:
        b = per_video.setdefault(
            r.video_id,
            {"video_id": r.video_id, "title": "", "calls": 0, "total_tokens": 0},
        )
        b["calls"] += 1
        b["total_tokens"] += int(r.total_tokens or 0)
    if per_video:
        titles = {
            v.id: v.title
            for v in db.query(Video).filter(Video.id.in_(list(per_video))).all()
        }
        for vid, b in per_video.items():
            b["title"] = titles.get(vid, "（已删除）")

    return {
        "totals": t.model_dump(),
        "by_purpose": _group(rows, "purpose"),
        "by_model": _group(rows, "model"),
        "by_video": sorted(per_video.values(), key=lambda x: -x["total_tokens"]),
        "items": [
            {
                "id": r.id,
                "job_id": r.job_id,
                "video_id": r.video_id,
                "provider": r.provider,
                "model": r.model,
                "purpose": r.purpose,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "cached_tokens": r.cached_tokens,
                "total_tokens": r.total_tokens,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows[:200]  # 明细最多返回 200 条，防止长视频刷爆响应
        ],
    }


@router.delete("")
def clear_usage(video_id: int | None = None, db: Session = Depends(get_db)):
    """清空用量记录（用户想重新开始计数时用）。"""
    q = db.query(LLMUsage)
    if video_id is not None:
        q = q.filter(LLMUsage.video_id == video_id)
    n = q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": n}
