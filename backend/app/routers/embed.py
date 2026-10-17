"""平台页面嵌入路由。

通过服务端代理把站方页面转成同源内容，
使得「隐藏推荐区」与「保留登录态」可以同时成立 —— 直接跨域 iframe 两者都做不到。
"""

from __future__ import annotations

import logging
import urllib.parse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse
from starlette.requests import Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.platforms.base import registry
from app.services import account_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["embed"])

# 资源代理允许的域名后缀。
# ⚠️ 这是 SSRF 防线：/platforms/youtube/proxy 本质是「代用户取任意 URL」，
# 没有白名单就等于把本机网络敞开给外部调用者（可探测内网、读云元数据）。
# 因此只放行 YouTube 播放链路真正需要的几个域。
_ALLOWED_PROXY_SUFFIXES = (
    "youtube.com",
    "ytimg.com",
    "ggpht.com",
    "googlevideo.com",
    "gstatic.com",
)


@router.get("/platforms/bilibili/embed", response_class=HTMLResponse)
async def bilibili_embed(bvid: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    """返回 B 站视频页的同源代理版本，供详情浮层以 iframe 嵌入。

    带上库中保存的登录 Cookie 请求站方，首屏与播放器按登录态渲染；
    页面原样返回，仅修正资源基准路径（相对 URL 指回站方域名）。
    """
    try:
        adapter = registry.get("bilibili")
    except KeyError:
        raise HTTPException(status_code=404, detail="B 站平台未注册") from None

    fetcher = getattr(adapter, "fetch_embed_html", None)
    if fetcher is None:
        raise HTTPException(status_code=404, detail="该平台不支持页面嵌入")

    creds = None
    try:
        creds = await account_service.get_credentials_for(db, "bilibili")
    except Exception as exc:  # noqa: BLE001 - 凭据问题不应阻断，退化为游客页面
        logger.warning("获取 B 站凭据失败，将以游客态渲染嵌入页: %s", exc)

    try:
        html = await fetcher(bvid, creds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("抓取 B 站嵌入页失败: %s", exc)
        # iframe 里抛出 JSON 错误体验极差，这里降级成一张友好的提示页
        return HTMLResponse(
            status_code=200,
            content=_fallback_page(str(exc)),
        )

    return HTMLResponse(content=html)


@router.get("/platforms/xiaohongshu/embed", response_class=HTMLResponse)
async def xiaohongshu_embed(keyword: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    """返回净化后的小红书搜索页，供前端以同源 iframe 嵌入。

    方案 A：把小红书官方搜索页原样搬进来，用户直接看平台原生搜索结果，
    点击笔记由小红书自己的页面渲染详情，绕开「自建详情」被风控的问题。
    """
    try:
        adapter = registry.get("xiaohongshu")
    except KeyError:
        raise HTTPException(status_code=404, detail="小红书平台未注册") from None

    fetcher = getattr(adapter, "fetch_embed_html", None)
    if fetcher is None:
        raise HTTPException(status_code=404, detail="该平台不支持页面嵌入")

    creds = None
    try:
        creds = await account_service.get_credentials_for(db, "xiaohongshu")
    except Exception as exc:  # noqa: BLE001
        logger.warning("获取小红书凭据失败，将以游客态渲染嵌入页: %s", exc)

    try:
        html = await fetcher(keyword, creds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("抓取小红书搜索页失败: %s", exc)
        return HTMLResponse(status_code=200, content=_fallback_page(str(exc)))

    if not html:
        return HTMLResponse(status_code=200, content=_fallback_page("小红书搜索页未能渲染（可能被风控）"))

    return HTMLResponse(content=html)


@router.get("/platforms/douyin/embed", response_class=HTMLResponse)
async def douyin_embed(keyword: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    """返回净化后的抖音搜索页，供前端以同源 iframe 嵌入。

    与小红书相同的「整页嵌入」方案：把抖音官方搜索页原样搬进来，
    用户直接看平台原生搜索结果，点击视频由抖音自己的页面渲染详情，
    绕开「自建详情被 a_bogus 风控」的问题。
    """
    try:
        adapter = registry.get("douyin")
    except KeyError:
        raise HTTPException(status_code=404, detail="抖音平台未注册") from None

    fetcher = getattr(adapter, "fetch_embed_html", None)
    if fetcher is None:
        raise HTTPException(status_code=404, detail="该平台不支持页面嵌入")

    creds = None
    try:
        creds = await account_service.get_credentials_for(db, "douyin")
    except Exception as exc:  # noqa: BLE001
        logger.warning("获取抖音凭据失败，将以游客态渲染嵌入页: %s", exc)

    try:
        html = await fetcher(keyword, creds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("抓取抖音搜索页失败: %s", exc)
        return HTMLResponse(status_code=200, content=_fallback_page(str(exc)))

    if not html:
        return HTMLResponse(status_code=200, content=_fallback_page("抖音搜索页未能渲染（可能被风控）"))

    return HTMLResponse(content=html)


# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------


@router.get("/platforms/youtube/embed", response_class=HTMLResponse)
async def youtube_embed(video_id: str = Query(..., min_length=1)):
    """返回 YouTube 原视频页，供详情浮层以同源 iframe 嵌入。

    必须走服务端代理：YouTube 的 /watch 带 `X-Frame-Options: SAMEORIGIN`，
    浏览器会拒绝任何跨域嵌入。代理成同源后还要配合下面的资源代理，
    否则页面里的 XHR 仍会被 CORS 拦下，播放器拿不到数据。
    """
    try:
        adapter = registry.get("youtube")
    except KeyError:
        raise HTTPException(status_code=404, detail="YouTube 平台未注册") from None

    fetcher = getattr(adapter, "fetch_embed_html", None)
    if fetcher is None:
        raise HTTPException(status_code=404, detail="该平台不支持页面嵌入")

    try:
        html = await fetcher(video_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("抓取 YouTube 嵌入页失败: %s", exc)
        return HTMLResponse(status_code=200, content=_fallback_page(str(exc)))

    if not html:
        return HTMLResponse(
            status_code=200,
            content=_fallback_page(
                "未能取到 YouTube 原页面。请确认后端能访问 YouTube（YOUTUBE_PROXY 配置）"
            ),
        )

    return HTMLResponse(content=html)


def _host_allowed(url: str) -> bool:
    """校验待代理的 URL 域名是否在白名单内（SSRF 防线）。"""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    return any(host == s or host.endswith("." + s) for s in _ALLOWED_PROXY_SUFFIXES)


@router.api_route(
    "/platforms/youtube/proxy",
    methods=["GET", "POST", "HEAD", "OPTIONS"],
)
async def youtube_proxy(request: Request, url: str = Query(..., min_length=1)):
    """代取 YouTube 播放链路上的资源（XHR / 视频分片）。

    存在意义：嵌入页是同源的，但页面 JS 要向 youtube.com 发 XHR，跨域会被
    CORS 拒绝；视频分片同理。改道到这里后请求从我们的源发出，不再跨域。

    必须支持 POST：YouTube 播放器取流用的是 `POST /youtubei/v1/player`，
    只放行 GET 会让播放器直接 405 —— 页面出来了但视频永远起不来。

    域名白名单必须保留，否则这个接口就是一台开放代理。
    """
    if not _host_allowed(url):
        raise HTTPException(status_code=400, detail=f"不允许代理该域名: {url[:80]}")

    # 只转发必要的请求头，避免把本站的 Host / Cookie 带到 YouTube
    forward_headers = {
        "User-Agent": settings.USER_AGENT,
        "Accept": request.headers.get("accept", "*/*"),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    upstream_ct = request.headers.get("content-type")
    if upstream_ct:
        forward_headers["Content-Type"] = upstream_ct
    # 视频分片依赖 Range；不转发会导致播放器无法拖动进度
    rng = request.headers.get("range")
    if rng:
        forward_headers["Range"] = rng

    body = await request.body() if request.method in ("POST", "PUT", "PATCH") else None

    async def stream():
        async with httpx.AsyncClient(
            proxy=settings.YOUTUBE_PROXY or None,
            trust_env=False,
            timeout=None,
            follow_redirects=True,
        ) as client:
            async with client.stream(
                request.method, url, headers=forward_headers, content=body
            ) as resp:
                # 通过生成器对象把状态码与响应头带回外层（首个 chunk 后才能读到）
                stream.status_code = resp.status_code
                stream.headers = dict(resp.headers)
                async for chunk in resp.aiter_bytes(chunk_size=1024 * 256):
                    yield chunk

    stream.status_code = 502
    stream.headers = {}
    gen = stream()

    first = None
    try:
        async for chunk in gen:
            first = chunk
            break
    except httpx.HTTPError as exc:
        logger.warning("YouTube 资源代理失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"代理请求失败: {exc}") from exc

    if first is None:
        raise HTTPException(status_code=502, detail="代理请求失败：上游无响应")

    # 刻意**不透传 content-length**：上游若返回 gzip，httpx 解压后字节数会少于
    # 原始 Content-Length，照抄会让客户端一直等一个永远收不满的响应体
    # （表现为 "transfer closed with N bytes remaining"）。交给框架用分块传输。
    passthrough = {}
    for key in ("content-type", "content-range", "accept-ranges", "etag"):
        value = getattr(gen, "headers", {}).get(key) or stream.headers.get(key)
        if value:
            passthrough[key] = value

    async def body():
        yield first
        async for chunk in gen:
            yield chunk

    return StreamingResponse(body(), status_code=stream.status_code, headers=passthrough)


def _fallback_page(reason: str) -> str:
    """嵌入页不可用时的提示页。"""
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>页面加载失败</title>
<style>
  body {{ margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
        font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
        background:#FAFAFA; color:#2C2F38; }}
  .box {{ text-align:center; padding:28px 32px; max-width:520px; }}
  .icon {{ font-size:40px; opacity:.35; margin-bottom:10px; }}
  h2 {{ margin:0 0 8px; font-size:15px; font-weight:600; }}
  p {{ margin:0; font-size:12px; color:#8A90A0; line-height:1.7; }}
</style></head>
<body><div class="box">
  <div class="icon">🔒</div>
  <h2>嵌入页面加载失败</h2>
  <p>{reason[:200]}</p>
</div></body></html>"""
