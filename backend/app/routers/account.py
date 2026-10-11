"""平台与账号管理路由。

对外提供：
  - 平台清单查询
  - 扫码登录发起 / 轮询
  - 账号列表、删除、设为默认、登录态体检
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.platforms.base import LoginTicket, registry
from app.schemas.api import (
    LoginPollResponse,
    LoginStartResponse,
    ManualCredentialRequest,
    MessageResponse,
)
from app.services import account_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["account"])

# 待确认的登录票据：token -> {platform, ticket, created_at}
# 单机部署足够；多实例场景可替换为 Redis。
_pending_tickets: dict[str, dict[str, Any]] = {}


def _sweep_expired() -> None:
    now = time.time()
    for token in [k for k, v in _pending_tickets.items() if now - v["created_at"] > 300]:
        _pending_tickets.pop(token, None)


@router.get("/platforms")
async def list_platforms():
    """返回已注册平台的元信息，供前端渲染平台切换器。"""
    return {"platforms": registry.describe_all()}


@router.get("/accounts")
async def get_accounts(platform: str | None = Query(None), db: Session = Depends(get_db)):
    return {"accounts": account_service.list_accounts(db, platform)}


@router.post("/platforms/{platform_key}/login/start")
async def start_login(platform_key: str):
    """发起扫码登录，返回二维码 data URI。"""
    try:
        adapter = registry.get(platform_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未知平台: {platform_key}") from None

    if not adapter.supports_login:
        raise HTTPException(status_code=400, detail=f"{adapter.display_name} 暂不支持账号登录")

    try:
        ticket: LoginTicket = await adapter.start_login()
    except Exception as exc:  # noqa: BLE001
        logger.exception("生成二维码失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"获取登录二维码失败: {exc}") from exc

    _sweep_expired()
    _pending_tickets[ticket.token] = {
        "platform": platform_key,
        "ticket": ticket,
        "created_at": time.time(),
    }
    return LoginStartResponse(
        token=ticket.token,
        qrcode_image=ticket.qrcode_image,
        qrcode_url=ticket.qrcode_url,
        expires_in=int(ticket.expires_at - time.time()),
    )


@router.get("/platforms/{platform_key}/login/poll", response_model=LoginPollResponse)
async def poll_login(platform_key: str, token: str, db: Session = Depends(get_db)):
    """轮询二维码状态；成功时账号自动入库。"""
    session = _pending_tickets.get(token)
    if session is None:
        return LoginPollResponse(status="expired", message="登录会话不存在或已超时，请重新获取二维码")
    if session["platform"] != platform_key:
        raise HTTPException(status_code=400, detail="登录会话与平台不匹配")

    adapter = registry.get(session["platform"])
    result = await adapter.poll_login(session["ticket"])

    if result.status == "success" and result.account:
        account = account_service.upsert_account(
            db,
            platform=result.account.platform,
            platform_uid=result.account.platform_uid,
            nickname=result.account.nickname,
            avatar_url=result.account.avatar_url,
            credentials=result.account.credentials,
        )
        _pending_tickets.pop(token, None)
        return LoginPollResponse(
            status="success",
            message=f"登录成功，欢迎 {result.account.nickname}",
            account=account_service.serialize(account),  # type: ignore[arg-type]
        )

    if result.status in ("expired", "error"):
        _pending_tickets.pop(token, None)

    return LoginPollResponse(status=result.status, message=result.message)


@router.post("/platforms/{platform_key}/credentials")
async def add_manual_credential(
    platform_key: str, payload: ManualCredentialRequest, db: Session = Depends(get_db)
):
    """手动粘贴 Cookie 接入账号（用于无可行扫码流程的平台，如抖音）。

    会真实调用平台接口探测凭据效力，并在 message 中如实反馈：
    Cookie 是否可连通、搜索是否真的可用。
    """
    try:
        registry.get(platform_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未知平台: {platform_key}") from None

    try:
        account, note = await account_service.save_manual_credential(
            db, platform_key, payload.cookie_str, payload.nickname
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("注入 %s 凭据失败", platform_key)
        raise HTTPException(status_code=502, detail=f"注入失败: {exc}") from exc

    if account is None:
        raise HTTPException(status_code=400, detail=note)

    return {
        "message": note,
        "account": account_service.serialize(account),  # type: ignore[arg-type]
    }


@router.delete("/accounts/{account_id}")
async def remove_account(account_id: int, db: Session = Depends(get_db)):
    if not account_service.delete_account(db, account_id):
        raise HTTPException(status_code=404, detail="账号不存在")
    return MessageResponse(message="账号已删除")


@router.post("/accounts/{account_id}/default")
async def make_default(account_id: int, db: Session = Depends(get_db)):
    if not account_service.set_default(db, account_id):
        raise HTTPException(status_code=404, detail="账号不存在")
    return MessageResponse(message="已设为默认账号")


@router.post("/accounts/verify")
async def verify_accounts(platform: str | None = Query(None), db: Session = Depends(get_db)):
    """批量体检账号登录态。"""
    result = await account_service.verify_all(db, platform)
    return {"accounts": result}
