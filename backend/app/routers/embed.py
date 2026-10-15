"""平台页面嵌入路由。

通过服务端代理把站方页面转成同源内容，
使得「隐藏推荐区」与「保留登录态」可以同时成立 —— 直接跨域 iframe 两者都做不到。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.platforms.base import registry
from app.services import account_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["embed"])


@router.get("/platforms/bilibili/embed", response_class=HTMLResponse)
async def bilibili_embed(bvid: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    """返回净化后的 B 站视频页，供详情浮层以同源 iframe 嵌入。

    - 带上库中保存的登录 Cookie 请求站方，首屏与播放器按登录态渲染
    - 注入 CSS 隐藏推荐列表与站方头部
    - 同源返回，因此样式对后续 JS 动态渲染的内容同样生效
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
