"""FastAPI 应用入口。"""

from __future__ import annotations

import importlib.util
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.database import init_db
from app.platforms.base import registry
from app.platforms.bilibili.adapter import BilibiliAdapter
from app.platforms.douyin.adapter import DouyinAdapter
from app.platforms.xiaohongshu.adapter import XiaohongshuAdapter
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


# ---------------------------------------------------------------------------
# 合并 video-mind 后端
#
# 把 video-mind 的 FastAPI 应用作为子应用挂载到 /videomind，从而让「单一后端
# 进程」同时暴露 lingoSeek 与 video-mind 两套 API（视频流、分类、转写、导图…）。
# 这样两个前端都只需对接一个地址（8000），不再各自起一个后端。
#
# 要点：
# - video-mind 自带一份 CORSMiddleware（allow_origins=["*"]）。若保留，会和本应用
#   的 CORS 叠加出重复的 Access-Control-Allow-Origin 响应头，浏览器会直接拒绝。
#   因此挂载前先剥掉它的 CORS，统一由本应用处理跨域。
# - 加载失败（例如依赖缺失）时记录告警并跳过挂载，保证 lingoSeek 自身仍可启动。
# ---------------------------------------------------------------------------
def _mount_videomind(application: FastAPI) -> None:
    vm_backend = Path(__file__).resolve().parent.parent / "video-mind" / "backend"
    if not (vm_backend / "main.py").exists():
        logger.warning("未找到 video-mind 后端，跳过挂载：%s", vm_backend)
        return

    # 让 video-mind 内部的 `from core / pipeline / routers / providers import ...`
    # 在导入其 main 时可以被解析
    sys.path.insert(0, str(vm_backend))

    try:
        spec = importlib.util.spec_from_file_location("videomind_backend", vm_backend / "main.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules["videomind_backend"] = module
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 - 加载失败不应拖垮主应用
        logger.error("video-mind 后端加载失败，其接口将不可用：%s", exc)
        return

    vm_app = module.app
    # 剥掉子应用自带的 CORS（见上方说明）
    vm_app.user_middleware = [
        m for m in vm_app.user_middleware if m.cls is not CORSMiddleware
    ]
    vm_app.middleware_stack = None
    application.mount("/videomind", vm_app)
    logger.info("已挂载 video-mind 后端 → /videomind")


_mount_videomind(app)


@app.get("/api/health", tags=["system"])
async def health():
    """健康检查，同时汇报平台注册情况。"""
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "platforms": registry.keys(),
    }
