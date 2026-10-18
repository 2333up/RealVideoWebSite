"""追番路由。

对外提供：候选搜索 / 追番列表增删 / 更新检测 / 标记已看。
数据源为 agedm（见 services/agedm_client.py）。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.anime import (
    AnimeCandidate,
    AnimeFollowCreate,
    AnimeFollowOut,
    AnimeMarkWatched,
    AnimeSearchResponse,
    AnimeUpdateResponse,
    MessageResponse,
)
from app.services import anime_service
from app.services.agedm_client import AgedmError, agedm_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/anime", tags=["anime"])


def _to_out(f) -> AnimeFollowOut:
    return AnimeFollowOut(
        id=f.id,
        subject_id=f.subject_id,
        source=f.source,
        title=f.title,
        cover_url=f.cover_url,
        latest_eps=f.latest_eps,
        watched_eps=f.watched_eps,
        latest_label=f.latest_label,
        last_checked_at=f.last_checked_at.isoformat() if f.last_checked_at else None,
        created_at=f.created_at.isoformat(),
        has_update=f.has_update,
    )


@router.get("/search", response_model=AnimeSearchResponse)
async def search_anime(
    q: str = Query(..., min_length=1, max_length=60, description="番剧名称"),
    page: int = Query(1, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """按番剧名搜索候选。"""
    try:
        items = await anime_service.search(db, q, page=page)
    except AgedmError as exc:
        # 明确把失败原因透出去，不要伪装成「没搜到」
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return AnimeSearchResponse(keyword=q, items=[AnimeCandidate(**it) for it in items])


@router.get("/follows", response_model=list[AnimeFollowOut])
async def list_follows(db: Session = Depends(get_db)):
    """追番列表（含更新状态）。"""
    return [_to_out(f) for f in anime_service.list_follows(db)]


@router.post("/follows", response_model=AnimeFollowOut)
async def add_follow(payload: AnimeFollowCreate, db: Session = Depends(get_db)):
    """添加追番。"""
    try:
        follow = await anime_service.add_follow(db, payload.subject_id)
    except AgedmError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return _to_out(follow)


@router.delete("/follows/{follow_id}", response_model=MessageResponse)
async def remove_follow(follow_id: int, db: Session = Depends(get_db)):
    if not anime_service.remove_follow(db, follow_id):
        raise HTTPException(status_code=404, detail="追番不存在")
    return MessageResponse(message="已删除")


@router.patch("/follows/{follow_id}", response_model=AnimeFollowOut)
async def mark_watched(
    follow_id: int, payload: AnimeMarkWatched, db: Session = Depends(get_db)
):
    """标记已看话数，用于消除红点。"""
    follow = anime_service.mark_watched(db, follow_id, payload.watched_eps)
    if follow is None:
        raise HTTPException(status_code=404, detail="追番不存在")
    return _to_out(follow)


@router.get("/updates", response_model=AnimeUpdateResponse)
async def check_updates(db: Session = Depends(get_db)):
    """检测哪些追番有新话。"""
    updated = await anime_service.check_updates(db)
    return AnimeUpdateResponse(
        checked=len(anime_service.list_follows(db)),
        updated=[_to_out(f) for f in updated],
    )


# ---------------------------------------------------------------- 页面代理


@router.get("/embed", response_class=HTMLResponse)
async def embed_detail(subject_id: int = Query(..., gt=0)):
    """返回 agedm 作品详情页（同源），供应用内 iframe 嵌入。

    agedm 带 `X-Frame-Options: SAMEORIGIN`，直接跨站 iframe 会被浏览器拒绝，
    因此由服务端取回后同源返回 —— 与 YouTube 嵌入走的是同一套思路。

    ⚠️ 只保证「详情 / 集数 / 介绍」可读；**点集数播放仍会空白**，
    因为播放器是嵌套的第二个 iframe，同样带 XFO。界面需明确提示到站内观看。
    """
    try:
        html = await agedm_client.fetch_detail_html(subject_id)
    except AgedmError as exc:
        return HTMLResponse(status_code=200, content=_fallback_page(str(exc)))
    return HTMLResponse(content=html)


@router.get("/proxy")
async def proxy_api(url: str = Query(..., min_length=1)):
    """转发页面内对 api.agedm.io 的 XHR（仅限该域，见客户端白名单）。"""
    try:
        status, body, ctype = await agedm_client.proxy_json(url)
    except AgedmError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(content=body, status_code=status, media_type=ctype)


def _fallback_page(reason: str) -> str:
    """嵌入页不可用时的提示页（与 embed.py 的样式保持一致）。"""
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
  <h2>番剧页面加载失败</h2>
  <p>{reason[:200]}</p>
</div></body></html>"""