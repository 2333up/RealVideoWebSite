"""抖音平台适配器。

⚠️ 能力现状（务必阅读，勿夸大）
------------------------------------------------------------------
抖音 Web 端的主力接口受 `a_bogus` 签名保护 —— JSVMP 虚拟机混淆 + WASM + msToken/ttwid
会话令牌 + TLS 指纹，且数据中心 IP 被直接封禁。本适配器**不实现该签名逆向**，
而是采用两条路径：

  ✅ 热榜（hot/search/list）：实测无需签名即可返回真实数据，已接入
  ✅ 关键词搜索：普通 HTTP 会被登录墙 / 静默风控拦下，故**回退到浏览器自动化**
     （Playwright 驱动真实 Chromium，让页面 JS 自行生成 a_bogus），已接入
  ⚠️ 浏览器自动化依赖 `playwright + chromium`，未安装时会如实报错

搜索方法先走普通 HTTP（完整协议实现），一旦将来接入签名模块即可直接生效；
被拦截时自动回退到浏览器路径，无需改动其余任何层。

架构上与 B 站完全对称：实现 PlatformAdapter + 在 main.py 注册即可。
"""

from __future__ import annotations

import logging
import re
import time
import urllib.parse
from typing import Any, ClassVar

import httpx

from app.core.config import settings
from app.core.security import mask_secret
from app.platforms.base import (
    Author,
    ContentItem,
    LoginResult,
    LoginTicket,
    PlatformAdapter,
    SearchParams,
)

logger = logging.getLogger(__name__)

WEB_BASE = "https://www.douyin.com"

# 抖音用 status_code 表达业务状态（0 = 成功），与 B 站的 code 不同
STATUS_OK = 0

# 已知的拦截状态码 -> 人类可读说明
STATUS_HINTS: dict[int, str] = {
    2483: "抖音要求登录后才能搜索（需登录态 + 有效 a_bogus 签名）",
    8: "请求参数不合法",
    2118: "触发风控，请稍后重试",
    2145: "请求过于频繁，已被限流",
}

_HEADERS = {
    "User-Agent": settings.USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.douyin.com/",
    "Origin": "https://www.douyin.com",
}


class DouyinError(RuntimeError):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


class DouyinAdapter(PlatformAdapter):
    key: ClassVar[str] = "douyin"
    display_name: ClassVar[str] = "抖音"
    accent_color: ClassVar[str] = "#161823"  # 抖音品牌黑
    homepage: ClassVar[str] = "https://www.douyin.com"
    supported_kinds: ClassVar[list] = ["video"]
    # 抖音扫码登录同样依赖 a_bogus 体系，当前不提供
    supports_login: ClassVar[bool] = False
    # 但支持手动粘贴浏览器 Cookie —— 2483「请先登录」正说明登录态是关键变量
    manual_credential: ClassVar[bool] = True

    # 抖音登录态相关的主要 Cookie 字段
    LOGIN_COOKIES = (
        "sessionid", "sessionid_ss", "sid_tt", "uid_tt",
        "passport_csrf_token", "ttwid", "msToken", "odin_tt", "s_v_web_id",
    )

    def __init__(self) -> None:
        self._timeout = httpx.Timeout(settings.HTTP_TIMEOUT, connect=8.0)
        self._client: httpx.AsyncClient | None = None
        # 浏览器自动化搜索：绕过 a_bogus 的唯一可行路径（惰性启动，首次搜索才拉起）
        self._browser_search: Any = None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self._timeout, follow_redirects=True)
        return self._client

    async def _ensure_browser_search(self) -> Any:
        """惰性导入浏览器搜索模块，避免未装 playwright 时导入即报错。"""
        if self._browser_search is None:
            from app.platforms.douyin.browser_search import DouyinBrowserSearch

            self._browser_search = DouyinBrowserSearch()
        return self._browser_search

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        if self._browser_search is not None:
            await self._browser_search.aclose()

    # ------------------------------------------------------------ 基础请求
    def _cookie(self, credentials: dict[str, Any] | None) -> str:
        """拼接登录 Cookie（若用户已提供）。"""
        creds = credentials or {}
        cookie_map: dict[str, Any] = creds.get("cookie") or {}
        parts = [f"{k}={v}" for k, v in cookie_map.items() if v]
        if creds.get("cookie_str"):
            parts.append(str(creds["cookie_str"]).strip().rstrip(";"))
        return "; ".join(parts)

    async def _get(self, path: str, params: dict[str, Any], credentials: dict[str, Any] | None) -> dict[str, Any]:
        """发起 GET 并解包抖音响应；非零 status_code 抛出带中文说明的异常。"""
        client = await self._ensure_client()
        headers = dict(_HEADERS)
        cookie = self._cookie(credentials)
        if cookie:
            headers["Cookie"] = cookie

        resp = await client.get(f"{WEB_BASE}{path}", params=params, headers=headers)
        resp.raise_for_status()
        body = resp.json()

        status = body.get("status_code", -1)
        if status != STATUS_OK:
            hint = STATUS_HINTS.get(status, body.get("status_msg") or "未知错误")
            raise DouyinError(status, hint)
        return body

    # ------------------------------------------------------------ 搜索
    async def search(
        self, params: SearchParams, credentials: dict[str, Any] | None = None
    ) -> list[ContentItem]:
        """关键词检索视频。

        双路径策略：
          1. 先走普通 HTTP（完整协议实现），一旦将来接入签名模块即可直接生效
          2. 被 a_bogus 静默拦截（空结果 / 2483）时，回退到浏览器自动化搜索
             —— 用真实 Chromium 让页面 JS 自行生成签名，这是当前唯一可用路径

        浏览器自动化依赖 playwright + chromium，若环境未装会如实抛错，
        绝不返回伪造结果。
        """
        # 路径 1：普通 HTTP
        try:
            items = await self._search_http(params, credentials)
            if items:
                return items
            # 空结果 = 被静默风控，转入浏览器路径
            logger.info("抖音 HTTP 搜索返回空结果，回退浏览器自动化（keyword=%s）", params.keyword)
        except DouyinError as exc:
            if exc.code == 2483:
                logger.info("抖音 HTTP 搜索被登录墙拦截（2483），回退浏览器自动化（keyword=%s）", params.keyword)
            else:
                # 其他错误也尝试浏览器路径，因为浏览器环境可能绕过
                logger.info("抖音 HTTP 搜索失败 [%s]，回退浏览器自动化", exc.code)
        except Exception as exc:  # noqa: BLE001
            logger.info("抖音 HTTP 搜索异常，回退浏览器自动化: %s", exc)

        # 路径 2：浏览器自动化
        # 浏览器自动化无法真正翻页（每次都是重开页面拿第一屏 + 滚动），
        # 故 page > 1 时直接返回空，交由前端停止「加载更多」，避免重复的昂贵劳动。
        if params.page > 1:
            logger.info("抖音浏览器搜索不支持翻页（page=%s），返回空以终止加载更多", params.page)
            return []

        try:
            browser = await self._ensure_browser_search()
            items = await browser.search(
                params.keyword,
                credentials=credentials,
                max_items=params.page_size,
            )
        except Exception as exc:  # noqa: BLE001
            raise DouyinError(
                -2,
                f"抖音浏览器自动化搜索失败：{exc}",
            ) from exc

        if not items:
            raise DouyinError(
                -1,
                f"抖音搜索「{params.keyword}」未返回结果。可能原因：关键词无内容、"
                "账号未登录、或被风控。请确认已注入有效 Cookie 后重试",
            )
        return items

    async def _search_http(
        self, params: SearchParams, credentials: dict[str, Any] | None
    ) -> list[ContentItem]:
        """普通 HTTP 搜索（原实现，保留作首选路径）。"""
        payload: dict[str, Any] = {
            "device_platform": "webapp",
            "aid": 6383,
            "channel": "channel_pc_web",
            "search_channel": "aweme_general",
            "keyword": params.keyword,
            "search_source": "normal_search",
            "query_correct_type": 1,
            "is_filter_search": 0,
            "offset": (max(1, params.page) - 1) * 10,
            "count": 10,
            "need_filter_settings": 1,
        }
        body = await self._get("/aweme/v1/web/general/search/single/", payload, credentials)
        items = self._parse_search(body)
        if not items:
            # 实测：带登录 Cookie 时 status_code 回到 0，但 data 恒为空数组。
            # 这是抖音对缺少 a_bogus 请求的「静默风控」—— 不报错，只给空结果。
            # 必须显式抛出，否则上层只会显示「未返回结果」，用户无从判断原因。
            raise DouyinError(
                -1,
                "抖音返回空结果（status_code=0 但 data 为空）。若该关键词确实有内容，"
                "则说明请求仍缺少 a_bogus 签名而被静默拦截 —— Cookie 只能解决登录态，无法替代签名",
            )
        return items

    def _parse_search(self, body: dict[str, Any]) -> list[ContentItem]:
        """解析搜索结果。抖音把视频包在 data[].aweme_info 中。"""
        items: list[ContentItem] = []
        for entry in body.get("data") or []:
            aweme = entry.get("aweme_info") or entry.get("aweme_mix_info")
            if not isinstance(aweme, dict):
                continue
            item = self._aweme_to_item(aweme)
            if item:
                items.append(item)
        return items

    def _aweme_to_item(self, aweme: dict[str, Any]) -> ContentItem | None:
        """把抖音视频对象压平成统一的 ContentItem。"""
        aweme_id = str(aweme.get("aweme_id") or "")
        if not aweme_id:
            return None

        video = aweme.get("video") or {}
        stat = aweme.get("statistics") or {}
        author = aweme.get("author") or {}

        cover = ""
        cover_list = (video.get("cover") or {}).get("url_list") or (video.get("origin_cover") or {}).get("url_list")
        if cover_list:
            cover = self._normalize_url(cover_list[0])

        avatar_list = (author.get("avatar_thumb") or {}).get("url_list") or []
        duration_ms = video.get("duration")

        return ContentItem(
            platform=self.key,
            kind="video",
            uid=aweme_id,
            title=self._clean(aweme.get("desc")),
            summary="",
            cover_url=cover,
            page_url=f"https://www.douyin.com/video/{aweme_id}",
            author=Author(
                uid=str(author.get("uid") or author.get("sec_uid") or ""),
                name=self._clean(author.get("nickname")),
                avatar_url=self._normalize_url(avatar_list[0]) if avatar_list else "",
                homepage=f"https://www.douyin.com/user/{author.get('sec_uid')}" if author.get("sec_uid") else "",
            ),
            published_at=aweme.get("create_time"),
            # 抖音时长单位为毫秒，统一换算为秒
            duration=int(duration_ms / 1000) if isinstance(duration_ms, (int, float)) and duration_ms > 0 else None,
            view_count=int(stat.get("play_count") or 0),
            like_count=int(stat.get("digg_count") or 0),
            comment_count=int(stat.get("comment_count") or 0),
            favorite_count=int(stat.get("collect_count") or 0),
            share_count=int(stat.get("share_count") or 0),
            tags=[t for t in re.findall(r"#([^\s#]+)", aweme.get("desc") or "")][:6],
            extra={"aweme_id": aweme_id},
        )

    # ------------------------------------------------------------ 热榜
    async def fetch_hot_search(self, credentials: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """获取抖音热搜榜 —— 实测无需签名即可访问。

        这是当前抖音侧唯一稳定可用的数据通道，可用于降级展示或灵感入口。
        """
        payload = {
            "device_platform": "webapp",
            "aid": 6383,
            "channel": "channel_pc_web",
            "detail_list": 1,
        }
        body = await self._get("/aweme/v1/web/hot/search/list/", payload, credentials)
        data = body.get("data") or {}
        word_list = data.get("word_list") or []
        result: list[dict[str, Any]] = []
        for word in word_list:
            result.append(
                {
                    "word": word.get("word", ""),
                    "hot_value": int(word.get("hot_value") or 0),
                    "position": word.get("position"),
                    "url": f"https://www.douyin.com/hot/{word.get('sentence_id')}"
                    if word.get("sentence_id")
                    else "",
                }
            )
        logger.info("抖音热榜获取成功，共 %s 条", len(result))
        return result

    # ------------------------------------------------------------ 详情
    async def fetch_detail(
        self, uid: str, credentials: dict[str, Any] | None = None
    ) -> ContentItem | None:
        """抖音单条详情同样受风控保护，当前不可用。"""
        logger.warning("抖音详情接口需要 a_bogus 签名，当前未实现（aweme_id=%s）", uid)
        return None

    # ------------------------------------------------------------ 登录
    async def start_login(self) -> LoginTicket:
        raise NotImplementedError(
            "抖音登录依赖 a_bogus 签名体系，当前未接入"
        )

    async def poll_login(self, ticket: LoginTicket) -> LoginResult:
        return LoginResult(status="error", message="抖音登录当前不可用（需签名支持）")

    async def verify_credentials(self, credentials: dict[str, Any]) -> tuple[bool, str]:
        """分级探测凭据的真实效力。

        返回 (凭据是否可保存, 说明)。分两级：
          1. 连通性 —— 热榜端点能否访问（无需签名）
          2. 登录态 —— 是否包含 sessionid / sid_tt 等登录字段

        注意：**不再用关键词试搜做第 2 级**。浏览器自动化搜索对敏感词会触发
        滑块验证码，而每次保存/体检账号都触发一次搜索极易把账号/IP 拉入风控，
        导致后续真实搜索全部被验证码拦截。故只做轻量连通性 + 字段检查。

        即便只通过第 1 级也允许保存（Cookie 本身有效，只是搜索还需签名），
        但说明里必须如实告知，避免用户以为已经能用。
        """
        cookie = self._cookie(credentials)
        if not cookie:
            return False, "未提供抖音 Cookie"

        has_login_marker = any(
            name in (credentials.get("cookie") or {}) or name in str(credentials.get("cookie_str") or "")
            for name in ("sessionid", "sessionid_ss", "sid_tt")
        )

        # 第 1 级：连通性
        try:
            await self.fetch_hot_search(credentials)
        except DouyinError as exc:
            return False, f"连通性检查失败: {exc.message}"
        except Exception as exc:  # noqa: BLE001
            return False, f"网络异常: {exc}"

        # 未发现登录态字段时，无论后续结果如何都要明确告知 ——
        # 因为热榜端点无需 Cookie 也能访问，仅凭连通性无法证明已登录。
        if has_login_marker:
            return True, "Cookie 有效（含登录态字段，搜索需走浏览器自动化）"
        return True, (
            "Cookie 可连通，但 ⚠ 未发现 sessionid / sid_tt 等登录态字段，"
            "请确认浏览器已登录抖音并复制完整 Cookie，否则搜索可能被登录墙拦截。"
        )

    # ------------------------------------------------------------ 工具
    @staticmethod
    def _clean(value: str | None) -> str:
        return (value or "").strip()

    @staticmethod
    def _normalize_url(url: str | None) -> str:
        if not url:
            return ""
        if url.startswith("//"):
            return f"https:{url}"
        return url.replace("http://", "https://", 1) if url.startswith("http://") else url
