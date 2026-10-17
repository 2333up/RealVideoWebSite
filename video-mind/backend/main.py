"""video-mind 后端入口。

启动方式：
    python -m uvicorn main:app --port 8600 --reload
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import logging

from core.compat import ensure_av_compatible, ensure_cuda_dll_path
from core.config import DATA_DIR, UPLOAD_DIR, settings
from core.database import SessionLocal, init_db
from pipeline import runner
from routers import files, folders, jobs, settings as settings_router, usage, videos

logger = logging.getLogger("videomind")

# 进程启动时打一次：PyAV>=19 与 faster-whisper 1.2.1 的参数不兼容，
# 不打补丁的话转写会在打开音频容器时直接抛 TypeError。
ensure_av_compatible()
# cuBLAS 装在 site-packages 下，不在 Windows 默认 DLL 搜索路径里，
# 不注册的话「模型能加载、一推理就报 cublas64_12.dll 找不到」。
ensure_cuda_dll_path()

app = FastAPI(
    title="video-mind",
    description="本地视频分章节总结 · 时间戳思维导图 · 联动播放器",
    version="0.1.0",
)

# 本应用通常由仓库根目录的 backend/main.py 挂载到 /videomind 子路径下，
# 届时这层 CORS 会被剥掉、统一由主应用处理（否则会出现重复的
# Access-Control-Allow-Origin 响应头，浏览器直接拒绝）。
# 保留它是为了单独调试：python -m uvicorn main:app --port 8600 --reload
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

# 清掉上次进程留下的孤儿任务，否则它们会一直占着「同时只跑一个任务」的位置
_session = SessionLocal()
try:
    _reset = runner.reset_orphan_jobs(_session)
    if _reset:
        logger.warning("启动时重置了 %d 个被中断的任务", _reset)
finally:
    _session.close()

app.include_router(videos.router)
app.include_router(folders.router)
app.include_router(files.router)
app.include_router(jobs.router)
app.include_router(settings_router.router)
app.include_router(usage.router)

# 关键帧等静态产物
app.mount("/artifacts", StaticFiles(directory=str(DATA_DIR / "artifacts")), name="artifacts")


@app.get("/api/health")
def health():
    import shutil

    return {
        "ok": True,
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "ffprobe": bool(shutil.which("ffprobe")),
        "asr_provider": settings.asr_provider,
        "llm_provider": settings.llm_provider,
        "data_dir": str(DATA_DIR),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8600)
