"""搜索推荐路由。"""

from __future__ import annotations

import logging

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.platforms.base import registry
from app.recommend.service import RecommendResult, item_to_dict, recommend
from app.schemas.api import SearchRequest
from app.services import account_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["search"])


@router.post("/search")
async def do_search(payload: SearchRequest, db: Session = Depends(get_db)):
    """执行一次多平台聚合推荐检索。"""
    # 平台解析：未知平台直接拒绝，避免内部异常暴露
    adapters = []
    for key in payload.platforms:
        try:
            adapters.append(registry.get(key))
        except KeyError:
            raise HTTPException(status_code=400, detail=f"不支持的平台: {key}") from None

    if not adapters:
        raise HTTPException(status_code=400, detail="请至少选择一个平台")

    async def credentials_provider(platform_key: str):
        return await account_service.get_credentials_for(db, platform_key, payload.account_id)

    try:
        result: RecommendResult = await recommend(
            adapters=adapters,
            keyword=payload.keyword,
            page=payload.page,
            page_size=payload.page_size,
            kinds=payload.kinds,
            order=payload.order,
            duration_min=payload.duration_min,
            duration_max=payload.duration_max,
            min_views=payload.min_views,
            min_followers=payload.min_followers,
            credentials_provider=credentials_provider,
            fetch_pages=payload.pages,
        )
    except Exception as exc:  # noqa: BLE001 - 兜底，避免上游异常穿透成 500 空响应
        logger.exception("检索失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"上游平台请求失败: {exc}") from exc

    return result.to_dict()


@router.get("/platforms/{platform_key}/detail")
async def get_detail(platform_key: str, uid: str, db: Session = Depends(get_db)):
    """按平台内 ID 获取单条内容详情，供前端详情浮层渲染。

    走平台官方接口取结构化数据（而非嵌入网页），
    这样详情区域完全由我们自己渲染，不会夹带平台的推荐内容。
    """
    try:
        adapter = registry.get(platform_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未知平台: {platform_key}") from None

    try:
        creds = await account_service.get_credentials_for(db, platform_key)
        item = await adapter.fetch_detail(uid, creds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("获取 %s 详情失败: %s", platform_key, exc)
        raise HTTPException(status_code=502, detail=f"获取详情失败: {exc}") from exc

    if item is None:
        raise HTTPException(status_code=404, detail="未获取到该内容详情")
    return {"platform": platform_key, "item": item_to_dict(item)}


@router.get("/platforms/{platform_key}/comments")
async def get_comments(
    platform_key: str,
    uid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=49),
    sort: Literal["hot", "time"] = "hot",
    db: Session = Depends(get_db),
):
    """获取内容评论。

    评论属于可选能力：适配器未实现 fetch_comments 时返回 404，
    而不是强求每个平台都支持。
    """
    try:
        adapter = registry.get(platform_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未知平台: {platform_key}") from None

    fetcher = getattr(adapter, "fetch_comments", None)
    if fetcher is None:
        raise HTTPException(status_code=404, detail=f"{adapter.display_name} 暂不支持评论")

    try:
        creds = await account_service.get_credentials_for(db, platform_key)
        result = await fetcher(uid, page, page_size, sort, creds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("获取 %s 评论失败: %s", platform_key, exc)
        raise HTTPException(status_code=502, detail=f"获取评论失败: {exc}") from exc

    return {"platform": platform_key, **result}


@router.get("/search/suggest")
async def suggest(keyword: str):
    """简易搜索联想占位实现，供后续接入平台原生补全接口。"""
    return {"keyword": keyword, "suggestions": []}
