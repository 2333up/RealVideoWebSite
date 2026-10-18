"""追番持久化模型。

一张表承载用户的追番列表：记录「在追哪部番」以及「看到第几话」，
更新检测只需比较数据源给出的最新话数与本地已看话数。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AnimeFollow(Base):
    __tablename__ = "anime_follows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # 数据源侧的作品 ID（agedm 的 AID，如 20260293）。
    # 字段名沿用任务约定；多个数据源时由 source 区分命名空间。
    subject_id: Mapped[int] = mapped_column(Integer, nullable=False, unique=True, index=True)

    # 数据源标识。当前仅 "agedm"，预留以便日后接入其它源。
    source: Mapped[str] = mapped_column(String(16), default="agedm", server_default="agedm")

    title: Mapped[str] = mapped_column(String(256), nullable=False)
    cover_url: Mapped[str] = mapped_column(Text, default="", server_default="")

    # 数据源侧「已播出的最新正片话数」，由 uptodate 解析而来（无法解析时为 0）
    latest_eps: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # 用户已看话数
    watched_eps: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 数据源给出的原始更新描述（如「第03集」「第12集(完结)」），
    # 保留下来便于界面直接展示，也方便排查解析失败的情况。
    latest_label: Mapped[str] = mapped_column(String(64), default="", server_default="")

    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = ({"sqlite_autoincrement": True},)

    @property
    def has_update(self) -> bool:
        """有新话可看。

        必须比较 latest_eps 而非「总话数」：总话数含未播出的集，
        会让「已完结但没看完」的番永远显示红点。
        """
        return self.latest_eps > self.watched_eps

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"<AnimeFollow {self.subject_id} {self.title} {self.watched_eps}/{self.latest_eps}>"