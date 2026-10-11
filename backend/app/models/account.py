"""平台账号持久化模型。

设计要点：一张表承载所有平台的账号，字段与具体平台解耦。
各平台特有的凭据（如 B 站的 SESSDATA / bili_jct）统一塞进
加密后的 credentials 字典，新增平台无需迁移表结构。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.security import decrypt_dict, encrypt_dict


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class PlatformAccount(Base):
    __tablename__ = "platform_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # 平台标识，如 "bilibili"；与 PlatformRegistry 中的 key 对应
    platform: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    # 平台侧的用户唯一 ID（B 站为 DedeUserID）
    platform_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    nickname: Mapped[str] = mapped_column(String(128), default="", server_default="")
    avatar_url: Mapped[str] = mapped_column(Text, default="", server_default="")

    # Fernet 加密后的凭据字典（含 cookie、token 等）
    credentials: Mapped[str] = mapped_column(Text, nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    # 登录态体检
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(Text, default="", server_default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = ({"sqlite_autoincrement": True},)

    # ---------- 凭据读写（自动加解密） ----------
    def get_credentials(self) -> dict[str, Any]:
        return decrypt_dict(self.credentials) or {}

    def set_credentials(self, data: dict[str, Any]) -> None:
        self.credentials = encrypt_dict(data)

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"<PlatformAccount {self.platform}:{self.platform_uid} {self.nickname}>"
