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
import tempfile
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.ffmpeg import ffmpeg_available, merge_av
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

    if not info or not (info.get("durl") or (info.get("dash") or {}).get("video")):
        raise HTTPException(status_code=502, detail="未获取到可下载的播放地址（可能需登录或该视频不可下载）")

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

    durl = info.get("durl") or []
    # MP4 直链（fnval=1）清晰度上限 720P：目标档位高于它时，唯一可用的
    # 是 DASH 的音视频分离流，必须下完再合并，否则要么拿不到、要么无声。
    need_merge = (qn is not None and qn > (info.get("direct_quality") or 0)) or (
        not durl and bool((info.get("dash") or {}).get("video"))
    )
    if need_merge:
        return await _download_dash_merged(adapter, info, qn, creds)

    if not durl:
        raise HTTPException(status_code=502, detail="未获取到可下载的播放直链（可能需登录或该视频不可下载）")

    target_url = durl[0]["url"]

    # 文件名：优先标题，回退 bvid；清洗非法字符
    filename = _bilibili_filename(info, bvid)

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


def _bilibili_filename(info: dict, bvid: str) -> str:
    """文件名：优先标题，回退 bvid；清洗 Windows 非法字符。"""
    title = (info.get("title") or bvid).strip()
    safe_title = "".join(c for c in title if c not in '\\/:*?"<>|').strip() or bvid
    return f"{safe_title}.mp4"


def _bili_stream_headers(adapter, creds) -> dict[str, str]:
    """B 站流媒体请求头——缺 Referer 或 Cookie 会被 CDN 直接 403。"""
    headers = {
        "User-Agent": settings.USER_AGENT,
        "Referer": "https://www.bilibili.com/",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    cookie = adapter.client._build_cookie(creds)
    if cookie:
        headers["Cookie"] = cookie
    return headers


async def _fetch_to_file(client, entry: dict, headers: dict[str, str], path: Path) -> None:
    """把一条 DASH 流下载到临时文件；主域名失败时依次尝试备用域名。"""
    last: Exception | None = None
    for url in [entry.get("url") or "", *(entry.get("backup") or [])]:
        if not url:
            continue
        try:
            async with client.stream("GET", url, headers=headers) as resp:
                resp.raise_for_status()
                with path.open("wb") as fh:
                    async for chunk in resp.aiter_bytes(chunk_size=1024 * 256):
                        fh.write(chunk)
            return
        except Exception as exc:  # noqa: BLE001 - 换下一个备用域名
            last = exc
            logger.warning("DASH 分片下载失败，尝试备用域名: %s", exc)
    raise RuntimeError(f"DASH 分片下载失败: {last}")


async def _download_dash_merged(adapter, info: dict, qn: int | None, creds) -> StreamingResponse:
    """下载 DASH 视频流 + 音频流，ffmpeg 合并成单个 mp4 后流式返回。

    B 站 1080P 及以上只有音视频分离的流（MP4 直链最高 720P），
    所以高画质只能「下两个文件 + 合并」，这一步绕不开 ffmpeg。
    """
    if not ffmpeg_available():
        raise HTTPException(
            status_code=400,
            detail=(
                "该清晰度需要 ffmpeg 合并音视频，但服务端未检测到 ffmpeg。"
                "请在 .env 配置 FFMPEG_LOCATION，或改选 720P 及以下"
                "（MP4 直链，无需合并）"
            ),
        )

    dash = info.get("dash") or {}
    videos = [v for v in (dash.get("video") or []) if v.get("url")]
    audios = [a for a in (dash.get("audio") or []) if a.get("url")]
    if not videos or not audios:
        raise HTTPException(status_code=502, detail="未获取到该清晰度的 DASH 音视频流")

    # 同一档位会有多种编码（avc1=H.264 / hev1=H.265 / av01=AV1），
    # 优先 H.264：兼容性最好，老播放器与剪辑软件都能开；
    # 只在没有 H.264 时才退而取其他编码。
    def _rank(v: dict) -> tuple[int, bool]:
        return (v.get("quality") or 0, (v.get("codecs") or "").startswith("avc1"))

    target = qn or 80
    lower = [v for v in videos if (v.get("quality") or 0) <= target]
    chosen = max(lower, key=_rank) if lower else min(videos, key=_rank)
    audio = audios[0]

    headers = _bili_stream_headers(adapter, creds)
    client = await adapter.client._ensure_client()
    tmpdir = tempfile.mkdtemp(prefix="bili-dash-")
    try:
        vpath = Path(tmpdir) / "video.m4s"
        apath = Path(tmpdir) / "audio.m4s"
        await asyncio.gather(
            _fetch_to_file(client, chosen, headers, vpath),
            _fetch_to_file(client, audio, headers, apath),
        )
        out = Path(tmpdir) / "merged.mp4"
        await merge_av(vpath, apath, out)
    except HTTPException:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    except Exception as exc:  # noqa: BLE001
        # 半途失败必须清场：分片可能上百 MB，留着会静默吃掉磁盘
        shutil.rmtree(tmpdir, ignore_errors=True)
        logger.exception("B 站 DASH 合并下载失败")
        raise HTTPException(status_code=502, detail=f"下载并合并失败: {exc}") from exc

    size = out.stat().st_size
    filename = _bilibili_filename(info, info.get("bvid") or "")

    async def stream():
        try:
            with out.open("rb") as fh:
                while True:
                    chunk = await asyncio.to_thread(fh.read, 1024 * 256)
                    if not chunk:
                        break
                    yield chunk
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    return StreamingResponse(
        stream(),
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'attachment; filename="{urllib.parse.quote(filename)}"',
            "Content-Length": str(size),
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
