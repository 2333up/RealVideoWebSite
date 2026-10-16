"""FastAPI 应用入口。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.database import init_db
from app.platforms.base import registry
from app.platforms.bilibili.adapter import BilibiliAdapter
from app.platforms.douyin.adapter import DouyinAdapter
from app.platforms.xiaohongshu.adapter import XiaohongshuAdapter
from app.platforms.youtube.adapter import YouTubeAdapter
from app.routers import account as account_router
from app.routers import download as download_router
from app.routers import embed as embed_router
from app.routers import hot as hot_router
from app.routers import search as search_router

logging.basicConfig(
    level=logging.INFO if settings.DEBUG else logging.WARNING,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("app")

# 全局持有的适配器实例，需在应用关闭时释放其 HTTP 连接
_adapters: list = []


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """应用生命周期：启动时装配依赖，关闭时清理资源。"""
    logger.info("正在启动 %s v%s", settings.APP_NAME, settings.APP_VERSION)

    init_db()
    logger.info("数据库就绪")

    # ---- 平台注册区：未来接入新平台只需在此追加一行 ----
    bilibili = BilibiliAdapter()
    registry.register(bilibili)
    _adapters.append(bilibili)

    douyin = DouyinAdapter()
    registry.register(douyin)
    _adapters.append(douyin)

    xiaohongshu = XiaohongshuAdapter()
    registry.register(xiaohongshu)
    _adapters.append(xiaohongshu)

    youtube = YouTubeAdapter()
    registry.register(youtube)
    _adapters.append(youtube)

    logger.info("已注册平台: %s", ", ".join(registry.keys()))

    yield

    # 关闭各平台的 HTTP 连接池
    for adapter in _adapters:
        close = getattr(adapter, "aclose", None)
        if close:
            try:
                await close()
            except Exception:  # noqa: BLE001 - 关闭阶段异常无需传播
                pass
    logger.info("应用已停止")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="多平台视频与图文主动推荐搜索引擎 — 当前支持哔哩哔哩",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(search_router.router)
app.include_router(account_router.router)
app.include_router(hot_router.router)
app.include_router(embed_router.router)
app.include_router(download_router.router)


@app.get("/api/health", tags=["system"])
async def health():
    """健康检查，同时汇报平台注册情况。"""
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "platforms": registry.keys(),
    }
