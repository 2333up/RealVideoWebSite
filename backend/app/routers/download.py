"""视频下载路由。

提供两个平台的能力：
  1. B 站：获取播放直链（分 P / 清晰度列表） + 服务端流式代理下载
  2. YouTube：列出可下载流 + 服务端下载/合并后转发

为什么要走服务端代理而不是让浏览器直接下：
  - B 站直链有 Referer + Cookie 防盗链，浏览器直接访问会 403
  - YouTube 直链绑定 IP 与时效，且浏览器大概率连不上 YouTube；由服务端
    （配好代理的那台机器）统一下发，前端才能拿到文件

注意：清晰度上限由登录态（B 站）或 ffmpeg 是否可用（YouTube）决定，
这里如实返回平台给出的能力，不伪造。
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import urllib.parse
from pathlib import Path

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
    qn: int | None = Query(None, description="目标清晰度代码，取自 formats[].quality；不传则由平台决定"),
    db: Session = Depends(get_db),
):
    """返回视频的播放直链信息（分 P 列表 + 清晰度列表）。"""
    try:
        adapter = registry.get("bilibili")
    except KeyError:
        raise HTTPException(status_code=404, detail="B 站平台未注册") from None

    creds = await account_service.get_credentials_for(db, "bilibili")

    try:
        info = await adapter.get_playurl(bvid, cid, creds, qn=qn)
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
    qn: int | None = Query(None, description="目标清晰度代码；不传则由平台决定"),
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
        info = await adapter.get_playurl(bvid, cid, creds, qn=qn)
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


# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------

# YouTube 下载走服务端而非浏览器：直链绑定 IP 与时效，且客户端网络通常
# 根本连不上 YouTube，必须让配好代理的服务端代取。


def _youtube_adapter():
    try:
        return registry.get("youtube")
    except KeyError:
        raise HTTPException(status_code=404, detail="YouTube 平台未注册") from None


def _content_disposition(filename: str) -> str:
    """生成同时兼容 ASCII 与非 ASCII 文件名的 Content-Disposition。

    filename 走百分号编码保证老浏览器不炸，filename* 走 RFC 5987 保证
    中文标题在现代表里显示正确。
    """
    quoted = urllib.parse.quote(filename)
    return f"attachment; filename=\"{quoted}\"; filename*=UTF-8''{quoted}"


@router.get("/platforms/youtube/streams")
async def youtube_streams(video_id: str = Query(..., min_length=1)):
    """列出该视频可下载的流（清晰度 / 是否有音轨 / 体积）。

    返回结果里 `ffmpeg_available` 决定前端能否提供「音视频合并」选项。
    """
    adapter = _youtube_adapter()
    try:
        return await adapter.fetch_streams(video_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("获取 YouTube 流列表失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"获取下载选项失败: {exc}") from exc


@router.get("/platforms/youtube/download")
async def youtube_download(
    video_id: str = Query(..., min_length=1),
    format_id: str = Query("merge"),
):
    """下载 YouTube 视频。

    format_id:
      - `merge`  → 最佳视频 + 最佳音频，用 ffmpeg 合并成 mp4（需 ffmpeg）
      - 其他值   → 下载该单流（可能是纯视频或纯音频，由 yt-dlp 的 format_id 指定）
    """
    adapter = _youtube_adapter()

    if format_id == "merge" and not adapter.ffmpeg_available():
        raise HTTPException(
            status_code=400,
            detail=(
                "合并音视频需要 ffmpeg，但当前未找到。"
                "请在 .env 中配置 FFMPEG_LOCATION，或选择纯视频/纯音频格式下载"
            ),
        )

    # 无论合并还是单流，都由 yt-dlp 落盘后再转发。
    # 为什么不直接代理直链：实测 YouTube 对「整文件 GET」限速极狠
    # （同一视频直连约 8 KB/s，yt-dlp 分片下载约 0.45~2 MB/s，相差数十倍），
    # 直连代理会让大文件下载慢到不可用。
    return await _download_via_ytdlp(adapter, video_id, format_id)


async def _download_via_ytdlp(adapter, video_id: str, format_id: str):
    """yt-dlp 下载到临时文件 → 流式读出 → 读完即清理。"""
    tmpdir = ""
    try:
        tmpdir, filepath = await adapter.download_to_file(video_id, format_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("YouTube 下载失败: %s", exc)
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)
        raise HTTPException(status_code=502, detail=f"下载失败: {exc}") from exc

    path = Path(filepath)
    safe_title = _safe_filename(path.stem or video_id)
    ext = path.suffix.lstrip(".") or "mp4"
    size = path.stat().st_size
    media_type = "audio/mp4" if ext in ("m4a", "aac") else "video/mp4"

    async def stream():
        try:
            with path.open("rb") as fh:
                while True:
                    chunk = await asyncio.to_thread(fh.read, 1024 * 256)
                    if not chunk:
                        break
                    yield chunk
        finally:
            # 临时目录必须清理：产物可能上 GB，留在磁盘会静默吃掉空间
            shutil.rmtree(tmpdir, ignore_errors=True)

    return StreamingResponse(
        stream(),
        media_type=media_type,
        headers={
            "Content-Disposition": _content_disposition(f"{safe_title}.{ext}"),
            "Content-Length": str(size),
        },
    )


def _safe_filename(title: str) -> str:
    """清洗 Windows 文件名非法字符，并截短避免超出路径长度限制。"""
    cleaned = "".join(c for c in title if c not in '\\/:*?"<>|\r\n\t').strip()
    return (cleaned or "youtube")[:80]
