"""B 站扫码登录实现。

标准 TV/Web 扫码登录链路：
  1. /x/passport-login/web/qrcode/generate  获取二维码 key 与跳转链接
  2. 前端展示二维码（由 qrcode 库本地生成 PNG，不外泄给第三方图床）
  3. /x/passport-login/web/qrcode/poll      轮询：
        86101 未扫码 | 86090 已扫码待确认 | 86038 已失效 | 0 成功
  4. 成功时从响应 Set-Cookie 与 temporary_code URL 中提取登录态
  5. 用得到的 Cookie 反查 nav 接口补全昵称与头像
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import urllib.parse
from time import time
from typing import Any

import qrcode

from app.platforms.base import LoginResult, LoginTicket, PlatformAccountPayload
from app.platforms.bilibili.client import PASSPORT_BASE, BilibiliClient, BilibiliError

logger = logging.getLogger(__name__)

# 轮询返回码语义
CODE_SUCCESS = 0
CODE_EXPIRED = 86038
CODE_SCANNED = 86090  # 已扫码但未确认
CODE_NOT_SCANNED = 86101

# 登录后需要保留并持久化的 Cookie 字段
PERSIST_COOKIES = (
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "refresh_token",
    "ac_time_value",
    "buvid3",
    "buvid4",
)


class BilibiliLogin:
    """封装 B 站扫码登录全过程。"""

    def __init__(self, client: BilibiliClient) -> None:
        self.client = client

    # ---------------------------------------------------- 生成二维码
    async def generate(self) -> LoginTicket:
        data = await self.client.request_json(
            "GET",
            "/x/passport-login/web/qrcode/generate",
            base=PASSPORT_BASE,
        )
        qrcode_key = data.get("qrcode_key", "")
        url = data.get("url", "")
        if not qrcode_key:
            raise BilibiliError(-1, "未能获取 qrcode_key", data)

        image_data_uri = self._make_qrcode_png(url, qrcode_key)
        return LoginTicket(
            token=qrcode_key,
            qrcode_image=image_data_uri,
            qrcode_url=url,
            expires_at=time() + 180,
        )

    @staticmethod
    def _make_qrcode_png(content: str, fallback_key: str) -> str:
        """将链接本地渲染为 base64 PNG data URI。"""
        payload = content or f"https://passport.bilibili.com/x/passport-login/web/qrcode/key?key={fallback_key}"
        qr = qrcode.QRCode(version=None, box_size=8, border=2)
        qr.add_data(payload)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#1a1a1a", back_color="#ffffff")
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{encoded}"

    # ---------------------------------------------------- 轮询结果
    async def poll(self, ticket: LoginTicket) -> LoginResult:
        if ticket.is_expired():
            return LoginResult(status="expired", message="二维码已过期，请重新获取")

        try:
            data = await self.client.request_json(
                "GET",
                "/x/passport-login/web/qrcode/poll",
                params={"qrcode_key": ticket.token},
                base=PASSPORT_BASE,
            )
        except BilibiliError as exc:
            # 轮询接口用 data.code 表达业务码，HTTP 层异常视为终态错误
            return LoginResult(status="error", message=exc.message)

        code = data.get("code", CODE_NOT_SCANNED)

        if code == CODE_SUCCESS:
            credentials = await self._extract_credentials(data, ticket.token)
            if credentials is None:
                return LoginResult(status="error", message="登录成功但未能提取有效 Cookie，请重试")
            profile = await self._fetch_profile(credentials)
            return LoginResult(
                status="success",
                message="登录成功",
                account=PlatformAccountPayload(
                    platform="bilibili",
                    platform_uid=str(profile["mid"]),
                    nickname=profile["uname"],
                    avatar_url=profile["face"],
                    credentials=credentials,
                ),
            )

        if code == CODE_SCANNED:
            return LoginResult(status="scanned", message="已扫码，请在手机上确认")
        if code == CODE_EXPIRED:
            return LoginResult(status="expired", message="二维码已失效，请重新获取")
        if code == CODE_NOT_SCANNED:
            return LoginResult(status="pending", message="等待扫码")
        return LoginResult(status="pending", message=data.get("message", "等待扫码"))

    # ---------------------------------------------------- 凭据提取
    async def _extract_credentials(self, poll_data: dict[str, Any], qrcode_key: str) -> dict[str, Any] | None:
        """从临时凭证地址/回落 HTTP Cookie 中提取登录态。

        新版接口通常返回一个带签名参数的 URL，需再换取一次正式 Cookie；
        老接口直接通过 Set-Cookie 下发。两条路径都要兼容。
        """
        cookie_map: dict[str, str] = {}

        # 路径 A：data.url 中含各凭据的查询参数
        url = poll_data.get("url") or ""
        if url:
            query = urllib.parse.urlparse(url).query
            for name, value in urllib.parse.parse_qsl(query):
                if name in PERSIST_COOKIES and value:
                    cookie_map[name] = value

        # 路径 B：HTTP 响应 Set-Cookie（httpx 已合入 cookie jar）
        jar = getattr(self.client, "_client", None)
        if jar is not None and not jar.is_closed:
            for cookie in jar.cookies.jar:
                if cookie.name in PERSIST_COOKIES and cookie.value:
                    cookie_map.setdefault(cookie.name, cookie.value)

        # 路径 C：改用 TC 换票（部分风控环境所需）
        if "SESSDATA" not in cookie_map and url:
            parsed = urllib.parse.urlparse(url)
            qs = dict(urllib.parse.parse_qsl(parsed.query))
            temp_code = qs.get("temporary_code")
            if temp_code:
                if not await self._confirm(temp_code):
                    return None
                cookie_map.update(await self._pull_cookies_from_jar())

        if not cookie_map.get("SESSDATA"):
            logger.warning("扫码成功但未拿到 SESSDATA：%s", list(cookie_map))
            return None

        return {"cookie": cookie_map}

    async def _confirm(self, temporary_code: str) -> bool:
        """用临时凭证换取正式登录 Cookie（Set-Cookie 由 httpx 自动入 jar）。"""
        payload = {
            "code": temporary_code,
            "source": "pc-qrcode",
            "type": "qrcode",
            "ReturnUrl": "https://www.bilibili.com/",
        }
        try:
            await self.client.request_json(
                "POST",
                "/x/passport-login/web/login/confirm",
                data=payload,
                base=PASSPORT_BASE,
            )
        except BilibiliError as exc:
            logger.warning("confirm 换票失败: %s", exc)
            return False
        return True

    async def _pull_cookies_from_jar(self) -> dict[str, str]:
        result: dict[str, str] = {}
        jar = getattr(self.client, "_client", None)
        if jar is None or jar.is_closed:
            return result
        for cookie in jar.cookies.jar:
            if cookie.name in PERSIST_COOKIES and cookie.value:
                result[cookie.name] = cookie.value
        return result

    # ---------------------------------------------------- 资料补全
    async def _fetch_profile(self, credentials: dict[str, Any]) -> dict[str, Any]:
        """用新凭据反查用户信息。"""
        last_data: dict[str, Any] = {}
        for _ in range(2):
            last_data = await self.client.request_json(
                "GET", "/x/web-interface/nav",
                credentials=credentials, tolerant_codes={-101},
            )
            # 已登录时 nav 会带上 mid/uname；偶尔需要二次请求才同步到位
            if last_data.get("mid") and last_data.get("uname"):
                return {
                    "mid": last_data.get("mid"),
                    "uname": last_data.get("uname", ""),
                    "face": last_data.get("face", ""),
                }
            await asyncio.sleep(0.4)
        raise BilibiliError(-101, f"凭据未能通过 B 站身份校验: {last_data.get('message', '') or '未知原因'}")
