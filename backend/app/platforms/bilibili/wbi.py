"""B 站 WBI 签名算法实现。

自 2023 年起 B 站多数 Web API 引入了 wbi 签名，缺失 w_rid/wts 会返回 -352。
签名流程：
  1. GET /x/web-interface/nav 取 wbi_img.img_url 与 wbi_img.sub_url
  2. 各取文件名（去扩展名）拼接为 64 位原始串
  3. 按 MIXIN_KEY_ENC_TAB 重排并截取前 32 位 -> mixin_key
  4. 参数加 wts 时间戳后按 key 升序排列、剔除危险字符、urlencode
  5. md5(query + mixin_key) 即为 w_rid

mixin_key 会不定期轮换，故做定时缓存（默认 10 分钟）而非永久记忆。
"""

from __future__ import annotations

import hashlib
import time
import urllib.parse
from functools import lru_cache
from typing import Any

# fmt: off
MIXIN_KEY_ENC_TAB: tuple[int, ...] = (
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
)
# fmt: on

# 需要从参数值中剔除的字符
_UNSAFE_CHARS = "!'()*"
_KEY_TTL_SECONDS = 600  # mixin_key 缓存时长


@lru_cache(maxsize=1)
def _mixin_key_table() -> tuple[int, ...]:
    return MIXIN_KEY_ENC_TAB


def extract_mixin_key(img_url: str, sub_url: str) -> str:
    """由两张密码图的 URL 还原出 32 位 mixin_key。"""
    raw = ""
    for url in (img_url, sub_url):
        filename = url.rsplit("/", 1)[-1].split(".")[0]
        raw += filename
    if len(raw) != 64:
        raise ValueError(f"WBI 原始串长度异常: {len(raw)}，预期 64")
    shuffled = "".join(raw[i] for i in _mixin_key_table())
    return shuffled[:32]


def _sanitize(value: Any) -> str:
    """剔除会被签名校验拒绝的特殊字符。"""
    return str(value).replace("'", "").replace("!", "").replace("(", "").replace(")", "").replace("*", "")


def sign_params(params: dict[str, Any], mixin_key: str) -> dict[str, Any]:
    """为参数集合附加 wts 与 w_rid。"""
    signed = {k: v for k, v in params.items() if v is not None}
    signed["wts"] = int(time.time())

    # 按 key 升序排列后编码，顺序敏感
    query_parts: list[str] = []
    for key in sorted(signed.keys()):
        value = _sanitize(signed[key])
        encoded_value = urllib.parse.quote(value, safe="")
        query_parts.append(f"{urllib.parse.quote(key, safe='')}={encoded_value}")
    query = "&".join(query_parts)

    w_rid = hashlib.md5((query + mixin_key).encode("utf-8")).hexdigest()
    signed["w_rid"] = w_rid
    return signed


class WbiSigner:
    """带自动缓存与刷新的 WBI 签名器。

    用法:
        signer = WbiSigner(fetch_nav=async_callable)
        signed = await signer.sign({"keyword": "原神"})
    """

    def __init__(self, fetch_nav) -> None:
        self._fetch_nav = fetch_nav
        self._mixin_key: str | None = None
        self._fetched_at: float = 0.0

    @property
    def cache_valid(self) -> bool:
        return self._mixin_key is not None and (time.time() - self._fetched_at) < _KEY_TTL_SECONDS

    async def refresh(self, force: bool = False) -> str:
        """拉取最新的 mixin_key。"""
        if not force and self.cache_valid:
            return self._mixin_key  # type: ignore[return-value]

        wbi_img = await self._fetch_nav()
        img_url = wbi_img.get("img_url", "")
        sub_url = wbi_img.get("sub_url", "")
        if not img_url or not sub_url:
            raise RuntimeError("未能从 nav 接口获取 wbi_img，可能被风控或响应结构变更")

        self._mixin_key = extract_mixin_key(img_url, sub_url)
        self._fetched_at = time.time()
        return self._mixin_key

    async def sign(self, params: dict[str, Any]) -> dict[str, Any]:
        """返回附带签名的全新参数字典。"""
        key = await self.refresh()
        return sign_params(params, key)

    def invalidate(self) -> None:
        """签名失效时（如返回 -403）可手动清理缓存。"""
        self._mixin_key = None
        self._fetched_at = 0.0
