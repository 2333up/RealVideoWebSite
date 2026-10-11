"""热榜路由。

抖音关键词搜索受登录墙限制，但热榜端点是公开可访问的，
因此单独暴露出来 —— 既可作为降级内容，也可作为灵感入口。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.platforms.base import registry

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["hot"])


@router.get("/platforms/{platform_key}/hot")
async def get_hot(platform_key: str, limit: int = 20):
    """获取指定平台的热搜/热榜。

    各平台适配器按需实现 `fetch_hot_search`；未实现的返回 404。
    """
    try:
        adapter = registry.get(platform_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未知平台: {platform_key}") from None

    fetcher = getattr(adapter, "fetch_hot_search", None)
    if fetcher is None:
        raise HTTPException(status_code=404, detail=f"{adapter.display_name} 暂不支持热榜")

    try:
        words = await fetcher()
    except Exception as exc:  # noqa: BLE001
        logger.warning("获取 %s 热榜失败: %s", platform_key, exc)
        raise HTTPException(status_code=502, detail=f"获取热榜失败: {exc}") from exc

    return {"platform": platform_key, "words": words[: max(1, min(limit, 100))]}
