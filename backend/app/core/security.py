"""对称加密工具。

用户在平台上登录后的 Cookie 属于高敏感凭据，
绝不以明文落盘；统一经 Fernet（AES-128-CBC + HMAC）加密存储。
"""

from __future__ import annotations

import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


def _cipher() -> Fernet:
    return Fernet(settings.secret_key.encode())


def encrypt_dict(payload: dict[str, Any]) -> str:
    """将字典序列化后加密，返回可安全入库的字符串。"""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _cipher().encrypt(raw).decode("utf-8")


def decrypt_dict(token: str) -> dict[str, Any] | None:
    """解密并反序列化；凭据损坏或密钥变更时返回 None。"""
    if not token:
        return None
    try:
        raw = _cipher().decrypt(token.encode("utf-8"))
        return json.loads(raw.decode("utf-8"))
    except (InvalidToken, json.JSONDecodeError, ValueError):
        return None


def mask_secret(value: str, keep: int = 6) -> str:
    """用于日志/前端展示的脱敏。"""
    if not value:
        return ""
    if len(value) <= keep:
        return "*" * len(value)
    return f"{value[:keep]}{'*' * 8}{value[-2:]}"
