"""B 站视频下载路由。

提供两个能力：
  1. 获取播放直链信息（分 P / 清晰度列表），供前端渲染下载选项
  2. 服务端流式代理下载：直链有 Referer + Cookie 防盗链校验，
     浏览器直接下载会被 403，必须由后端带正确请求头转发。

注意：清晰度上限由登录态决定（游客最高 480P，登录最高 1080P，
大会员更高），这里如实返回平台给出的能力，不伪造。
"""

from __future__ import annotations

import logging
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.platforms.base import registry
from app.services import account_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["download"])


@router.get("/platforms/bilibili/playurl")
async def bilibili_playurl(
    bvid: str = Query(..., min_length=1),
    cid: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """返回视频的播放直链信息（分 P 列表 + 清晰度列表）。"""
    try:
        adapter = registry.get("bilibili")
    except KeyError:
        raise HTTPException(status_code=404, detail="B 站平台未注册") from None

    creds = await account_service.get_credentials_for(db, "bilibili")

    try:
        info = await adapter.get_playurl(bvid, cid, creds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("获取 B 站播放地址失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"获取播放地址失败: {exc}") from exc

    if not info or not info.get("durl"):
        raise HTTPException(status_code=502, detail="未获取到可下载的播放直链（可能需登录或该视频不可下载）")

    return info


@router.get("/platforms/bilibili/download")
async def bilibili_download(
    bvid: str = Query(..., min_length=1),
    cid: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """流式代理下载视频，返回带正确文件名的二进制流。

    直链来自 B 站 CDN，有 Referer + Cookie 防盗链，浏览器直接访问会 403。
    这里由后端携带正确请求头转发，绕开防盗链（用户已登录时用登录态 Cookie）。
    """
    try:
        adapter = registry.get("bilibili")
    except KeyError:
        raise HTTPException(status_code=404, detail="B 站平台未注册") from None

    creds = await account_service.get_credentials_for(db, "bilibili")

    try:
        info = await adapter.get_playurl(bvid, cid, creds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("获取 B 站下载地址失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"获取下载地址失败: {exc}") from exc

    durl = (info.get("durl") or [])
    if not durl:
        raise HTTPException(status_code=502, detail="未获取到可下载的播放直链（可能需登录或该视频不可下载）")

    target_url = durl[0]["url"]

    # 文件名：优先标题，回退 bvid；清洗非法字符
    title = (info.get("title") or bvid).strip()
    safe_title = "".join(c for c in title if c not in '\\/:*?"<>|').strip() or bvid
    filename = f"{safe_title}.mp4"

    headers = {
        "User-Agent": settings.USER_AGENT,
        "Referer": "https://www.bilibili.com/",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    cookie = adapter.client._build_cookie(creds)
    if cookie:
        headers["Cookie"] = cookie

    # 惰性导入 httpx 流式客户端（复用 adapter 的 client 底层，但需要 stream）
    import httpx

    client = await adapter.client._ensure_client()

    async def stream():
        try:
            async with client.stream("GET", target_url, headers=headers) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(chunk_size=1024 * 256):
                    yield chunk
        except httpx.HTTPError as exc:
            logger.warning("B 站下载流转发失败: %s", exc)
            # 流已开始，无法再改状态码，直接终止
            return

    return StreamingResponse(
        stream(),
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'attachment; filename="{urllib.parse.quote(filename)}"',
        },
    )
