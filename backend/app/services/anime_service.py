"""追番业务逻辑：列表读写、更新检测、标记已看。

与数据源解耦：本模块只管「本地记录什么、怎么判定更新」，
具体怎么向 agedm 取数据由 agedm_client 负责。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.anime import AnimeFollow
from app.services.agedm_client import AgedmError, agedm_client, parse_episode_number

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ 查询


def list_follows(db: Session) -> list[AnimeFollow]:
    return list(db.scalars(select(AnimeFollow).order_by(AnimeFollow.created_at.desc())))


def get_follow(db: Session, follow_id: int) -> AnimeFollow | None:
    return db.get(AnimeFollow, follow_id)


def get_by_subject(db: Session, subject_id: int) -> AnimeFollow | None:
    return db.scalar(select(AnimeFollow).where(AnimeFollow.subject_id == subject_id))


# ------------------------------------------------------------------ 写入


async def search(db: Session, keyword: str, page: int = 1) -> list[dict]:
    """搜索候选；已追番的标出来，前端可以据此置灰「已添加」。"""
    items = await agedm_client.search(keyword, page=page)
    followed = {f.subject_id for f in list_follows(db)}
    for it in items:
        it["followed"] = it["subject_id"] in followed
    return items


async def add_follow(db: Session, subject_id: int) -> AnimeFollow:
    """添加追番。

    话数在添加时就取一次详情：若留到「更新检测」才首次拉取，
    用户刚添加就会立刻看到红点（0 < 最新话数），属于误报。
    新添加的番默认「已看到当前最新」，之后只在真的出新话时提示。
    """
    existing = get_by_subject(db, subject_id)
    if existing is not None:
        return existing

    detail = await agedm_client.detail(subject_id)
    # uptodate 解不出时才回退到集数列表长度
    latest = parse_episode_number(detail.get("latest_label")) or detail.get("episodes") or 0

    follow = AnimeFollow(
        subject_id=subject_id,
        source="agedm",
        title=detail.get("title") or f"#{subject_id}",
        cover_url=detail.get("cover_url") or "",
        latest_eps=latest,
        watched_eps=latest,  # 见 docstring：新添加视为已跟上进度
        latest_label=detail.get("latest_label") or "",
        last_checked_at=_utcnow(),
    )
    db.add(follow)
    db.commit()
    db.refresh(follow)
    return follow


def remove_follow(db: Session, follow_id: int) -> bool:
    follow = db.get(AnimeFollow, follow_id)
    if follow is None:
        return False
    db.delete(follow)
    db.commit()
    return True


def mark_watched(db: Session, follow_id: int, watched_eps: int) -> AnimeFollow | None:
    """标记已看话数（用于消除红点）。"""
    follow = db.get(AnimeFollow, follow_id)
    if follow is None:
        return None
    # 不允许记成负数，也不越过后端已知的最新话数（否则红点会「永远消失」）
    follow.watched_eps = max(0, min(watched_eps, follow.latest_eps))
    db.commit()
    db.refresh(follow)
    return follow


# ------------------------------------------------------------------ 更新检测


async def check_updates(db: Session) -> list[AnimeFollow]:
    """逐条刷新最新话数，返回有新话的追番。

    单条失败（网络抖动 / 某部番被下架）只跳过该条并记日志，
    不能让一个坏条目把整次检测拖垮 —— 那样前端红点会整体失灵。
    """
    updated: list[AnimeFollow] = []
    for follow in list_follows(db):
        try:
            detail = await agedm_client.detail(follow.subject_id)
        except AgedmError as exc:
            logger.warning("追番 %s(%s) 更新检测失败：%s", follow.title, follow.subject_id, exc)
            continue

        latest = parse_episode_number(detail.get("latest_label"))
        if latest is None:
            latest = detail.get("episodes") or follow.latest_eps
        follow.latest_eps = latest
        follow.latest_label = detail.get("latest_label") or follow.latest_label
        follow.last_checked_at = _utcnow()
        if follow.title != detail.get("title") and detail.get("title"):
            follow.title = detail["title"]
        if detail.get("cover_url"):
            follow.cover_url = detail["cover_url"]

        if follow.has_update:
            updated.append(follow)

    db.commit()
    for f in updated:
        db.refresh(f)
    return updated