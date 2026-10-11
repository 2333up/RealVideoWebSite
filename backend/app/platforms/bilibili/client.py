"""B 站 HTTP 客户端。

统一管理：
  - 浏览器指纹 Cookie（buvid3/buvid4）的获取与复用
  - WBI 签名的自动附加与失效重试
  - 登录态 Cookie 的注入与 401/403 识别
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Iterable
from typing import Any

import httpx

from app.core.config import settings
from app.platforms.bilibili.wbi import WbiSigner

logger = logging.getLogger(__name__)

API_BASE = "https://api.bilibili.com"
PASSPORT_BASE = "https://passport.bilibili.com"

_COMMON_HEADERS = {
    "User-Agent": settings.USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Connection": "keep-alive",
}


class BilibiliError(RuntimeError):
    """B 站接口返回业务错误时抛出。"""

    def __init__(self, code: int, message: str, payload: Any = None) -> None:
        self.code = code
        self.message = message
        self.payload = payload
        super().__init__(f"[{code}] {message}")


class BilibiliClient:
    """薄封装的异步 HTTP 客户端，按调用场景构造。

    每个请求可独立指定是否带登录 Cookie，
    以支持「多账号共存、按请求切换身份」的需求。
    """

    def __init__(self) -> None:
        self._timeout = httpx.Timeout(settings.HTTP_TIMEOUT, connect=8.0)
        self._client: httpx.AsyncClient | None = None
        # 游客指纹，全进程共享一次即可
        self._buvid3: str = ""
        self._buvid4: str = ""
        self._buvid_lock = asyncio.Lock()
        self._signer = WbiSigner(self._fetch_wbi_img)

    # ------------------------------ 生命周期
    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self._timeout,
                follow_redirects=True,
                http2=False,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ------------------------------ Cookie 组装
    async def _ensure_fingerprint(self) -> None:
        """获取 buvid3/buvid4。游客身份下缺失会直接被风控拦截。"""
        if self._buvid3 and self._buvid4:
            return
        async with self._buvid_lock:
            if self._buvid3 and self._buvid4:
                return
            try:
                client = await self._ensure_client()
                resp = await client.get(
                    f"{API_BASE}/x/frontend/finger/spi", headers=_COMMON_HEADERS
                )
                data = resp.json()
                self._buvid3 = data.get("data", {}).get("b_3", "")
                self._buvid4 = data.get("data", {}).get("b_4", "")
                logger.info("已获取 buvid3=%s", self._buvid3[:8] if self._buvid3 else "空")
            except Exception as exc:  # noqa: BLE001 - 指纹失败不应阻断主流程
                logger.warning("获取 buvid 失败，将以无指纹状态继续: %s", exc)
                self._buvid3, self._buvid4 = "", ""

    def _build_cookie(self, credentials: dict[str, Any] | None) -> str:
        """拼接最终的 Cookie 串。"""
        parts: list[str] = []
        if self._buvid3:
            parts.append(f"buvid3={self._buvid3}")
        if self._buvid4:
            parts.append(f"buvid4={self._buvid4}")

        creds = credentials or {}
        cookie_map: dict[str, Any] = creds.get("cookie") or {}
        for name, value in cookie_map.items():
            if value:
                parts.append(f"{name}={value}")
        # 允许直接传入 cookie 字符串
        if isinstance(creds.get("cookie_str"), str) and creds["cookie_str"]:
            parts.append(creds["cookie_str"].strip().rstrip(";"))

        parts.append("buvid_fp=plain")
        parts.append("CURRENT_FNVAL=4048")
        return "; ".join(parts)

    def _headers(self, cookie: str) -> dict[str, str]:
        headers = dict(_COMMON_HEADERS)
        headers["Cookie"] = cookie
        return headers

    # ------------------------------ WBI 素材
    async def _fetch_wbi_img(self) -> dict[str, str]:
        """签名器回调：拉取 nav 中的 wbi_img。

        注意：游客态下 nav 会返回 -101（未登录），但其 data 段仍携带
        必需的 wbi_img，故必须容忍该业务码，否则签名链路会自我中断。
        """
        data = await self.request_json("GET", "/x/web-interface/nav", tolerant_codes={-101})
        return data.get("wbi_img") or {}

    # ------------------------------ 核心请求
    async def request_json(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        credentials: dict[str, Any] | None = None,
        base: str = API_BASE,
        signed: bool = False,
        max_retries: int = 2,
        tolerant_codes: Iterable[int] | None = None,
    ) -> dict[str, Any]:
        """发起请求并解包 B 站标准响应。

        约定：code==0 时返回 data 段内容，否则抛 BilibiliError。

        :param tolerant_codes: 这些业务码虽非 0，但其 data 段仍有价值
            （典型场景：游客访问 /nav 返回 -101 未登录，却仍需其中的 wbi_img）
        """
        await self._ensure_fingerprint()
        client = await self._ensure_client()
        tolerated = set(tolerant_codes or ())

        last_error: BilibiliError | None = None
        for attempt in range(max_retries + 1):
            req_params = dict(params or {})
            if signed:
                req_params = await self._signer.sign(req_params)

            cookie = self._build_cookie(credentials)
            headers = self._headers(cookie)

            try:
                resp = await client.request(
                    method, f"{base}{path}", params=req_params, data=data, headers=headers
                )
                resp.raise_for_status()
                body = resp.json()
            except (httpx.HTTPError, json.JSONDecodeError) as exc:
                if attempt >= max_retries:
                    raise BilibiliError(-1, f"网络请求失败: {exc}") from exc
                await asyncio.sleep(0.6 * (attempt + 1))
                continue

            code = body.get("code", -1)
            if code == 0 or code in tolerated:
                raw_data = body.get("data")
                return raw_data if isinstance(raw_data, dict) else {"result": raw_data, "raw": body}

            last_error = BilibiliError(code, body.get("message", "未知错误"), body)
            # 签名过期 / 参数异常：清空缓存重试
            if code in (-352, -403, -401, -509) and attempt < max_retries:
                logger.warning("B 站返回 %s，刷新签名后重试(%s/%s)", code, attempt + 1, max_retries)
                self._signer.invalidate()
                await asyncio.sleep(0.4 * (attempt + 1))
                continue
            if attempt >= max_retries:
                raise last_error
            await asyncio.sleep(0.4 * (attempt + 1))

        raise last_error or BilibiliError(-1, "请求失败")

    async def get_text(self, url: str, credentials: dict[str, Any] | None = None) -> str:
        """请求任意完整 URL 并返回文本（用于资源下载等非 JSON 场景）。"""
        client = await self._ensure_client()
        resp = await client.get(url, headers=self._headers(self._build_cookie(credentials)))
        resp.raise_for_status()
        return resp.text
