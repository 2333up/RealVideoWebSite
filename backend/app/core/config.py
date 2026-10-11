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
