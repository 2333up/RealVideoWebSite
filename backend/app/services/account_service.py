"""平台账号服务层。

负责账号的增删改查、默认账号选举、登录态体检，
并对上层屏蔽 ORM 与加密细节。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import mask_secret
from app.models.account import PlatformAccount
from app.platforms.base import registry

logger = logging.getLogger(__name__)


def parse_cookie_str(raw: str) -> dict[str, str]:
    """把浏览器复制出来的 Cookie 串解析成字典。

    兼容 `a=1; b=2` 与换行分隔两种粘贴形式，并容忍空值与重复键。
    """
    result: dict[str, str] = {}
    if not raw:
        return result
    normalized = raw.replace("\n", ";").replace("\r", "")
    for part in normalized.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        name, value = name.strip(), value.strip()
        if name:
            result[name] = value
    return result


async def save_manual_credential(
    db: Session,
    platform_key: str,
    cookie_str: str,
    nickname: str = "",
) -> tuple[PlatformAccount | None, str]:
    """手动注入平台凭据：解析 -> 校验 -> 加密入库。

    :return: (账号对象, 校验说明)。校验失败时账号为 None，说明即失败原因。
    """
    adapter = registry.get(platform_key)
    if not adapter.manual_credential:
        return None, f"{adapter.display_name} 不支持手动注入 Cookie"

    cookie_map = parse_cookie_str(cookie_str)
    if not cookie_map:
        return None, "未能解析出任何 Cookie 字段，请确认已从浏览器完整复制"

    credentials = {"cookie": cookie_map}
    ok, note = await adapter.verify_credentials(credentials)
    if not ok:
        return None, note

    # 平台 UID：优先取登录态字段，缺失时退化为 Cookie 指纹，
    # 以保证同一份 Cookie 重复注入时更新同一条记录而非新增。
    uid = (
        cookie_map.get("uid_tt")
        or cookie_map.get("sessionid_ss")
        or cookie_map.get("sessionid")
        or cookie_map.get("sid_tt")
        or ""
    )
    if not uid:
        import hashlib

        uid = hashlib.md5(cookie_str.encode("utf-8")).hexdigest()[:16]

    account = upsert_account(
        db,
        platform=platform_key,
        platform_uid=str(uid),
        nickname=nickname.strip() or f"{adapter.display_name}账号",
        avatar_url="",
        credentials=credentials,
    )
    return account, note


def serialize(account: PlatformAccount) -> dict[str, Any]:
    return {
        "id": account.id,
        "platform": account.platform,
        "platform_uid": account.platform_uid,
        "nickname": account.nickname,
        "avatar_url": account.avatar_url,
        "is_default": account.is_default,
        "is_active": account.is_active,
        "last_verified_at": account.last_verified_at.isoformat() if account.last_verified_at else None,
        "last_error": account.last_error,
    }


def list_accounts(db: Session, platform: str | None = None) -> list[dict[str, Any]]:
    stmt = select(PlatformAccount).order_by(PlatformAccount.is_default.desc(), PlatformAccount.id)
    if platform:
        stmt = stmt.where(PlatformAccount.platform == platform)
    return [serialize(a) for a in db.scalars(stmt).all()]


def get_account(db: Session, account_id: int) -> PlatformAccount | None:
    return db.get(PlatformAccount, account_id)


def get_default_account(db: Session, platform: str) -> PlatformAccount | None:
    """取指定平台的默认账号；若未显式设置默认，退而取最近创建的活跃账号。"""
    stmt = (
        select(PlatformAccount)
        .where(PlatformAccount.platform == platform, PlatformAccount.is_active.is_(True))
        .order_by(PlatformAccount.is_default.desc(), PlatformAccount.id.desc())
    )
    return db.scalars(stmt).first()


async def get_credentials_for(db: Session, platform: str, account_id: int | None = None) -> dict[str, Any] | None:
    """为检索准备凭据：优先指定账号，其次默认账号，最后回落到 无登录态。"""
    account = get_account(db, account_id) if account_id is not None else None
    if account is None:
        account = get_default_account(db, platform)
    if account is None or not account.is_active:
        return None

    creds = account.get_credentials()
    if not creds:
        return None
    try:
        adapter = registry.get(account.platform)
        ok, note = await adapter.verify_credentials(creds)
        account.last_verified_at = datetime.now(timezone.utc)
        account.last_error = "" if ok else note
        db.commit()
        if not ok:
            logger.warning("账号 %s(%s) 登录态失效: %s", account.id, account.nickname, note)
            return None
        if creds.get("cookie", {}).get("SESSDATA"):
            logger.info("使用账号 %s(%s) 检索，SESSDATA=%s",
                        account.id, account.nickname, mask_secret(creds["cookie"]["SESSDATA"]))
        return creds
    except Exception as exc:  # noqa: BLE001 - 校验失败不应阻断检索
        logger.warning("凭据校验异常，将以游客态继续: %s", exc)
        return None


def upsert_account(
    db: Session,
    *,
    platform: str,
    platform_uid: str,
    nickname: str,
    avatar_url: str,
    credentials: dict[str, Any],
    set_default: bool = True,
) -> PlatformAccount:
    """新增或更新同一平台账号。同一 UID 重复登录时覆盖旧凭据。"""
    stmt = select(PlatformAccount).where(
        PlatformAccount.platform == platform,
        PlatformAccount.platform_uid == platform_uid,
    )
    account = db.scalars(stmt).first()

    now = datetime.now(timezone.utc)
    if account is None:
        account = PlatformAccount(
            platform=platform,
            platform_uid=platform_uid,
            created_at=now,
        )
        db.add(account)

    account.nickname = nickname
    account.avatar_url = avatar_url
    account.set_credentials(credentials)
    account.is_active = True
    account.last_verified_at = now
    account.last_error = ""

    has_default = db.scalars(
        select(PlatformAccount).where(
            PlatformAccount.platform == platform, PlatformAccount.is_default.is_(True)
        )
    ).first()
    if set_default or has_default is None:
        # 同平台内唯一默认
        for other in db.scalars(select(PlatformAccount).where(PlatformAccount.platform == platform)):
            if other.id != account.id:
                other.is_default = False
        account.is_default = True

    db.commit()
    db.refresh(account)
    logger.info("账号已保存: %s/%s(%s)", platform, platform_uid, nickname)
    return account


def delete_account(db: Session, account_id: int) -> bool:
    account = db.get(PlatformAccount, account_id)
    if account is None:
        return False
    platform = account.platform
    db.delete(account)
    db.commit()

    # 若删掉的是默认账号，把默认转交给剩余账号
    remaining = db.scalars(
        select(PlatformAccount).where(PlatformAccount.platform == platform)
    ).all()
    if remaining and not any(a.is_default for a in remaining):
        remaining[0].is_default = True
        db.commit()
    return True


def set_default(db: Session, account_id: int) -> bool:
    account = db.get(PlatformAccount, account_id)
    if account is None:
        return False
    for other in db.scalars(
        select(PlatformAccount).where(PlatformAccount.platform == account.platform)
    ):
        other.is_default = other.id == account.id
    db.commit()
    return True


async def verify_all(db: Session, platform: str | None = None) -> list[dict[str, Any]]:
    """体检所有账号的登录态，返回带健康状态的列表。"""
    accounts = db.scalars(select(PlatformAccount)).all() if platform is None else db.scalars(
        select(PlatformAccount).where(PlatformAccount.platform == platform)
    ).all()

    output: list[dict[str, Any]] = []
    for account in accounts:
        info = serialize(account)
        creds = account.get_credentials()
        if not creds:
            info["health"] = "invalid"
            account.last_error = "凭据缺失或已损坏"
        else:
            try:
                adapter = registry.get(account.platform)
                ok, note = await adapter.verify_credentials(creds)
                info["health"] = "valid" if ok else "expired"
                account.last_error = "" if ok else note
                account.last_verified_at = datetime.now(timezone.utc)
            except Exception as exc:  # noqa: BLE001
                info["health"] = "error"
                account.last_error = str(exc)
        output.append(info)
    db.commit()
    return output


__all__ = [
    "serialize", "list_accounts", "get_account", "get_default_account",
    "get_credentials_for", "upsert_account", "delete_account", "set_default",
    "verify_all", "parse_cookie_str", "save_manual_credential", "settings",
]
