"""全局配置中心。

所有可调参数集中于此，避免魔法数字散落各处。
凭据加密密钥默认自动生成并持久化到 data/.secret_key，
确保重启后已保存的账号仍能解密。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 项目根 = backend/ 目录
BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "灵搜 · LingoSeek"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True

    # SQLite 数据库文件
    DATABASE_URL: str = f"sqlite:///{DATA_DIR / 'app.db'}"

    # 允许的前端来源（Vite 开发服务器）
    # 前端已合并为单一工程：灵搜与 video-mind 同跑 5173，video-mind 的 API
    # 经 /videomind 子路径由同一个源发出，不需要单独的跨域来源。
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ]

    # 凭据加密密钥；为空则读取/生成 data/.secret_key
    SECRET_KEY: str = ""

    # 请求 B 站时的伪装 UA（游客态下至关重要）
    USER_AGENT: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    )

    HTTP_TIMEOUT: float = 15.0
    # 搜索结果每路最大抓取条数
    SEARCH_PAGE_SIZE: int = 30
    # 扫码登录二维码有效期（秒）
    QRCODE_TTL: int = 180

    # ---- YouTube ----
    # YouTube 在多数网络环境下无法直连，需要显式指定 HTTP 代理。
    # 留空表示直连（不启用代理）。
    # 注意：不能依赖环境里的 HTTP_PROXY/HTTPS_PROXY —— 那类变量常指向只允许
    # 内网白名单的代理，访问 youtube.com 会直接返回 502。
    YOUTUBE_PROXY: str = ""
    # YouTube 只提供音视频分离的 DASH 流，下载「带声音的完整视频」必须由
    # ffmpeg 合并。留空则让 yt-dlp 自行在 PATH 中查找。
    FFMPEG_LOCATION: str = ""
    # YouTube 单次搜索页的结果数上限（受页面结构限制，与 SEARCH_PAGE_SIZE 无关）
    YOUTUBE_SEARCH_LIMIT: int = 60

    # ---- 追番数据源（agedm）----
    # AGE 动漫的移动端接口，无需签名、无需代理即可直连。
    AGEDM_API_BASE: str = "https://api.agedm.io/v2"
    # 站点地址（详情页在桌面版，返回的是 SSR 完整 HTML）
    AGEDM_SITE_BASE: str = "https://www.agedm.io"
    # 该站点证书链不完整（缺中间证书），开启校验会直接 CERTIFICATE_VERIFY_FAILED。
    # 默认关闭以保证可用；若日后站点修好证书，把它设为 true 即可恢复校验。
    AGEDM_VERIFY_SSL: bool = False
    # 显式代理。留空 = 直连（不走环境变量，避免被只放行白名单的会话代理劫持成 502）。
    AGEDM_PROXY: str = ""

    @property
    def secret_key(self) -> str:
        """惰性持久化并返回对称加密密钥。"""
        if self.SECRET_KEY:
            return self.SECRET_KEY
        key_file = DATA_DIR / ".secret_key"
        if key_file.exists():
            return key_file.read_text(encoding="utf-8").strip()
        from cryptography.fernet import Fernet

        generated = Fernet.generate_key().decode()
        key_file.write_text(generated, encoding="utf-8")
        # Windows 下尽量收紧权限
        try:
            os.chmod(key_file, 0o600)
        except Exception:  # pragma: no cover - Windows 权限模型不同
            pass
        return generated


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
