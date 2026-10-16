"""YouTube 平台适配器。

能力现状（务必阅读，勿夸大）
------------------------------------------------------------------
- ✅ **关键词搜索**：YouTube 搜索结果是 SSR 直出，页面里带一份完整的
  `ytInitialData` JSON，普通 HTTP 抓取即可解析，**不需要任何签名，也不需要
  浏览器自动化** —— 这与小红书（X-s 签名，必须 Playwright）完全不同，
  因此这里不使用浏览器方案。
- ✅ **详情**：`ytInitialPlayerResponse.videoDetails` 同样是直出的，
  可拿到标题 / 作者 / 时长 / 播放量 / 简介 / 发布日期。
- ⚠️ **下载**：`ytInitialPlayerResponse` 里的流**既没有 url 也没有
  signatureCipher** —— YouTube 已把真实地址隐藏在播放器 JS 背后，必须
  由播放器动态解出签名（并附带 n 参数 / PO token）。
  自建这套 decipher 是与 YouTube 长期对抗的维护陷阱，因此下载交给
  `yt-dlp`（它专门维护该逻辑），我们只做「取直链 + 流式转发」。

网络可达性
------------------------------------------------------------------
YouTube 在多数办公/家庭网络下无法直连，且**不能依赖环境里的 HTTP_PROXY**：
那类变量常指向只允许内网白名单的代理，访问 youtube.com 会直接返回 502。
因此代理必须显式配置（settings.YOUTUBE_PROXY 或 .env），且请求一律
`trust_env=False`，避免被环境代理静默劫持。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Any, ClassVar

import httpx

from app.core.config import settings
from app.platforms.base import (
    Author,
    ContentItem,
    LoginResult,
    LoginTicket,
    PlatformAdapter,
    SearchParams,
)

logger = logging.getLogger(__name__)

WEB_BASE = "https://www.youtube.com"
SEARCH_URL = WEB_BASE + "/results"
WATCH_URL = WEB_BASE + "/watch"

# 页面里那两份直出 JSON 的抓取正则。
# 用非贪婪 + 以 `;</script>` 收尾，避免吃掉整页 HTML。
_INITIAL_DATA_RE = re.compile(r"ytInitialData\s*=\s*(\{.+?\})\s*;\s*</script>", re.S)
_PLAYER_RESPONSE_RE = re.compile(
    r"ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|const|let|</script>|$)", re.S
)

# 搜索排序对应的 sp 过滤参数（YouTube 内部 protobuf 的 base64 形式）。
# 这些是公开页面里可见的值，随 YouTube 改版可能失效；失效时按相关性返回，
# 不影响主流程。
_SP_ORDER = {
    "relevance": "",
    "new": "CAI%3D",  # 按上传时间
    "hot": "CAM%3D",  # 按观看量
}
# 时长过滤（与排序互斥，YouTube 只允许一个 sp）
_SP_DURATION = {
    "short": "EgIYAQ%3D%3D",  # < 4 分钟
    "medium": "EgIYAw%3D%3D",  # 4~20 分钟
    "long": "EgIYAg%3D%3D",  # > 20 分钟
}

# yt-dlp 取流时依次尝试的播放器客户端。
# 实测（2026-10）：web / web_safari / mweb / ios / web_embedded 会返回
# "Requested format is not available"，tv 会返回 "The page needs to be reloaded"，
# 而 `default,-tv`、`tv_embedded`、`android` 可用。故按此顺序回退。
_YTDLP_CLIENT_CHAIN: list[list[str]] = [
    ["default", "-tv"],
    ["tv_embedded"],
    ["android"],
]


class YouTubeError(RuntimeError):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


class YouTubeAdapter(PlatformAdapter):
    key: ClassVar[str] = "youtube"
    display_name: ClassVar[str] = "YouTube"
    accent_color: ClassVar[str] = "#FF0000"  # YouTube 品牌红
    homepage: ClassVar[str] = WEB_BASE
    supported_kinds: ClassVar[list] = ["video"]
    # YouTube 搜索与详情均无需登录
    supports_login: ClassVar[bool] = False
    manual_credential: ClassVar[bool] = False

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    # ------------------------------------------------------------ HTTP
    def _build_client_kwargs(self) -> dict[str, Any]:
        """构造 httpx 客户端参数。

        关键点：`trust_env=False`。环境里的 HTTP_PROXY/HTTPS_PROXY 常指向
        只允许内网白名单的代理，访问 youtube.com 会直接 502；让 httpx 自动
        读取环境变量会让「明明配了 YOUTUBE_PROXY 却依然失败」变得极难排查。
        代理一律显式来自 settings.YOUTUBE_PROXY。
        """
        return {
            "proxy": settings.YOUTUBE_PROXY or None,
            "trust_env": False,
            "timeout": max(settings.HTTP_TIMEOUT, 25.0),
            "follow_redirects": True,
            "headers": {
                "User-Agent": settings.USER_AGENT,
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        }

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(**self._build_client_kwargs())
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ------------------------------------------------------------ 搜索
    async def search(
        self, params: SearchParams, credentials: dict[str, Any] | None = None
    ) -> list[ContentItem]:
        """按关键词检索视频。

        搜索结果页是 SSR 直出的一次性快照：翻页依赖 continuation token 与
        InnerTube API（需硬编码 API key，脆弱）。因此 page > 1 直接返回空，
        交由前端停止「加载更多」——与小红书适配器同样的取舍。
        """
        if params.page > 1:
            logger.info("YouTube 搜索不支持翻页（page=%s），返回空以终止加载更多", params.page)
            return []

        sp = self._build_sp(params)
        query: dict[str, str] = {"search_query": params.keyword, "hl": "en", "gl": "US"}
        if sp:
            query["sp"] = sp

        client = await self._ensure_client()
        try:
            resp = await client.get(SEARCH_URL, params=query)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise YouTubeError(-2, f"YouTube 搜索请求失败：{exc}") from exc

        data = self._extract_json(resp.text, _INITIAL_DATA_RE)
        if data is None:
            raise YouTubeError(
                -1,
                "未能从 YouTube 搜索页解析出结果数据（页面结构可能已变化，"
                "或当前网络无法访问 YouTube —— 请检查 YOUTUBE_PROXY 配置）",
            )

        renderers = self._collect_video_renderers(data)
        limit = min(params.page_size, settings.YOUTUBE_SEARCH_LIMIT)
        items: list[ContentItem] = []
        seen: set[str] = set()
        for node in renderers:
            item = self._video_renderer_to_item(node)
            if item and item.uid not in seen:
                seen.add(item.uid)
                items.append(item)
            if len(items) >= limit:
                break

        if not items:
            raise YouTubeError(
                -1,
                f"YouTube 搜索「{params.keyword}」未返回视频结果。"
                "可能是关键词无结果，或当前网络无法访问 YouTube",
            )
        logger.info("YouTube 搜索「%s」解析出 %d 条", params.keyword, len(items))
        return items

    @staticmethod
    def _build_sp(params: SearchParams) -> str:
        """把排序/时长条件翻译成 YouTube 的 sp 过滤参数。

        YouTube 只允许一个 sp，时长过滤优先于排序（时长是硬条件，
        排序只是呈现顺序）。
        """
        if params.duration_max is not None and params.duration_max <= 240:
            return _SP_DURATION["short"]
        if params.duration_min is not None and params.duration_min >= 1200:
            return _SP_DURATION["long"]
        if params.duration_min is not None and params.duration_min >= 240:
            return _SP_DURATION["medium"]
        return _SP_ORDER.get(params.order, "")

    @staticmethod
    def _extract_json(html: str, pattern: re.Pattern[str]) -> dict[str, Any] | None:
        match = pattern.search(html)
        if not match:
            return None
        import json

        try:
            return json.loads(match.group(1))
        except ValueError:
            logger.warning("YouTube 页面 JSON 解析失败")
            return None

    @staticmethod
    def _collect_video_renderers(data: Any) -> list[dict[str, Any]]:
        """递归收集页面里所有 videoRenderer 节点。

        搜索结果里还会混入 shorts（reelItemRenderer / shortsLockupViewModel）
        与推荐位，这里只取标准视频卡片，保证结构可控。
        """
        found: list[dict[str, Any]] = []

        def walk(node: Any) -> None:
            if isinstance(node, dict):
                if "videoRenderer" in node and isinstance(node["videoRenderer"], dict):
                    found.append(node["videoRenderer"])
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(data)
        return found

    # ------------------------------------------------------------ 解析
    def _video_renderer_to_item(self, node: dict[str, Any]) -> ContentItem | None:
        """把 videoRenderer 压平成统一的 ContentItem。"""
        video_id = str(node.get("videoId") or "")
        if not video_id:
            return None

        title = self._text(node.get("title"))
        # 频道名与主页：byline 的 navigationEndpoint 里带 /@handle 路径
        channel_name = self._text(node.get("ownerText") or node.get("longBylineText"))
        channel_url = self._channel_url(node.get("ownerText") or node.get("longBylineText"))
        channel_id = self._channel_id(node)

        # 简介摘要（搜索结果里的 detailedMetadataSnippets）
        summary = ""
        snippets = node.get("detailedMetadataSnippets") or []
        if snippets and isinstance(snippets[0], dict):
            summary = self._text(snippets[0].get("snippetText"))

        thumbnails = (node.get("thumbnail") or {}).get("thumbnails") or []
        cover_url = self._pick_thumbnail(thumbnails)

        # 时长与播放量在搜索页里是「给人看的文本」，需要解析回数字
        duration = self._parse_duration(self._text(node.get("lengthText")))
        view_count = self._parse_count(self._text(node.get("viewCountText")))
        # 发布时间是相对描述（"7 years ago"），只能算出近似时间戳
        published_at = self._parse_relative_time(self._text(node.get("publishedTimeText")))

        return ContentItem(
            platform=self.key,
            kind="video",
            uid=video_id,
            title=title or f"YouTube 视频 {video_id}",
            summary=summary,
            cover_url=cover_url,
            page_url=f"{WATCH_URL}?v={video_id}",
            author=Author(
                uid=channel_id,
                name=channel_name,
                avatar_url=self._pick_channel_avatar(node),
                homepage=channel_url,
            ),
            published_at=published_at,
            duration=duration,
            view_count=view_count,
            # 搜索页不返回点赞/评论数，如实留 0，不伪造
            like_count=0,
            comment_count=0,
            tags=self._extract_badges(node),
            extra={"video_id": video_id, "channel_id": channel_id},
        )

    @staticmethod
    def _text(node: Any) -> str:
        """YouTube 的文本节点有两种形态：simpleText 与 runs[]。"""
        if not isinstance(node, dict):
            return str(node) if node else ""
        if node.get("simpleText"):
            return str(node["simpleText"]).strip()
        runs = node.get("runs") or []
        return "".join(str(r.get("text", "")) for r in runs if isinstance(r, dict)).strip()

    @staticmethod
    def _channel_url(byline: Any) -> str:
        """从 byline 的 navigationEndpoint 里取频道主页路径。"""
        if not isinstance(byline, dict):
            return ""
        runs = byline.get("runs") or []
        if not runs:
            return ""
        endpoint = (runs[0] or {}).get("navigationEndpoint") or {}
        url = (
            (endpoint.get("commandMetadata") or {})
            .get("webCommandMetadata", {})
            .get("url", "")
        )
        if not url:
            url = (endpoint.get("browseEndpoint") or {}).get("canonicalBaseUrl", "")
        return f"{WEB_BASE}{url}" if url.startswith("/") else url

    @staticmethod
    def _channel_id(node: dict[str, Any]) -> str:
        """频道 ID 藏在频道缩略图的 browseEndpoint 里。"""
        renderer = (node.get("channelThumbnailSupportedRenderers") or {}).get(
            "channelThumbnailWithLinkRenderer"
        ) or {}
        endpoint = renderer.get("navigationEndpoint") or {}
        return str((endpoint.get("browseEndpoint") or {}).get("browseId", "") or "")

    @staticmethod
    def _pick_thumbnail(thumbnails: list[dict[str, Any]]) -> str:
        """取分辨率最高的一张缩略图（列表通常按从小到大排列）。"""
        if not thumbnails:
            return ""
        best = max(thumbnails, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
        return str(best.get("url", "") or "")

    @staticmethod
    def _pick_channel_avatar(node: dict[str, Any]) -> str:
        renderer = (node.get("channelThumbnailSupportedRenderers") or {}).get(
            "channelThumbnailWithLinkRenderer"
        ) or {}
        thumbs = (renderer.get("thumbnail") or {}).get("thumbnails") or []
        return YouTubeAdapter._pick_thumbnail(thumbs)

    @staticmethod
    def _extract_badges(node: dict[str, Any]) -> list[str]:
        """提取卡片角标（如「4K」「CC」），作为轻量标签展示。"""
        tags: list[str] = []
        for badge in node.get("badges") or []:
            renderer = (badge or {}).get("metadataBadgeRenderer") or {}
            label = renderer.get("style") or renderer.get("label") or ""
            if isinstance(label, str) and label:
                tags.append(label)
        return tags[:4]

    @staticmethod
    def _parse_duration(text: str) -> int | None:
        """把 "6:14:07" / "12:34" 解析为秒。"""
        if not text:
            return None
        parts = text.split(":")
        try:
            nums = [int(p) for p in parts]
        except ValueError:
            return None
        if not nums:
            return None
        total = 0
        for num in nums:
            total = total * 60 + num
        return total or None

    @staticmethod
    def _parse_count(text: str) -> int:
        """把 "49,352,085 views" / "1.2M views" 解析为整数。"""
        if not text:
            return 0
        cleaned = text.lower().replace("views", "").replace(",", "").strip()
        multipliers = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}
        try:
            if cleaned[-1:] in multipliers:
                return int(float(cleaned[:-1]) * multipliers[cleaned[-1]])
            return int(float(cleaned))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _parse_relative_time(text: str) -> int | None:
        """把 "7 years ago" 解析为近似 Unix 时间戳（秒）。

        这是**近似值**：YouTube 在搜索页只给相对描述，粒度到「年」时误差可达
        半年。比留空更有用（可用于排序与区间过滤），但不该当作精确发布时间展示。
        """
        if not text:
            return None
        match = re.search(r"(\d+)\s+(second|minute|hour|day|week|month|year)", text.lower())
        if not match:
            return None
        amount = int(match.group(1))
        unit = match.group(2)
        seconds = {
            "second": 1,
            "minute": 60,
            "hour": 3600,
            "day": 86400,
            "week": 604800,
            "month": 2592000,  # 按 30 天折算
            "year": 31536000,  # 按 365 天折算
        }.get(unit, 0)
        return int(time.time()) - amount * seconds

    # ------------------------------------------------------------ 详情
    async def fetch_detail(
        self, uid: str, credentials: dict[str, Any] | None = None
    ) -> ContentItem | None:
        """打开视频页，从 ytInitialPlayerResponse 提取详情。"""
        video_id = uid.split("|")[0].strip()
        if not video_id:
            return None

        client = await self._ensure_client()
        try:
            resp = await client.get(WATCH_URL, params={"v": video_id, "hl": "en", "gl": "US"})
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("YouTube 详情请求失败（%s）: %s", video_id, exc)
            return None

        player = self._extract_json(resp.text, _PLAYER_RESPONSE_RE)
        if player is None:
            logger.warning("YouTube 详情页未解析出 playerResponse（%s）", video_id)
            return None

        details = player.get("videoDetails") or {}
        title = str(details.get("title") or "")
        if not title:
            return None

        micro = (player.get("microformat") or {}).get("playerMicroformatRenderer") or {}
        channel_id = str(details.get("channelId") or micro.get("externalChannelId") or "")
        thumbnails = (details.get("thumbnail") or {}).get("thumbnails") or []

        try:
            duration = int(details.get("lengthSeconds") or 0) or None
        except (TypeError, ValueError):
            duration = None

        return ContentItem(
            platform=self.key,
            kind="video",
            uid=str(details.get("videoId") or video_id),
            title=title,
            summary=str(details.get("shortDescription") or ""),
            cover_url=self._pick_thumbnail(thumbnails),
            page_url=f"{WATCH_URL}?v={video_id}",
            author=Author(
                uid=channel_id,
                name=str(details.get("author") or micro.get("ownerChannelName") or ""),
                avatar_url="",
                homepage=f"{WEB_BASE}/channel/{channel_id}" if channel_id else "",
            ),
            published_at=self._parse_publish_date(micro.get("publishDate")),
            duration=duration,
            view_count=self._safe_int(details.get("viewCount")),
            # 点赞数不在 playerResponse 里，如实留 0
            like_count=0,
            comment_count=0,
            tags=list(details.get("keywords") or [])[:8],
            extra={
                "video_id": video_id,
                "channel_id": channel_id,
                "category": micro.get("category") or "",
            },
        )

    @staticmethod
    def _parse_publish_date(value: Any) -> int | None:
        """把 "2024-03-15" 解析为 Unix 时间戳（秒）。"""
        if not value or not isinstance(value, str):
            return None
        try:
            return int(time.mktime(time.strptime(value[:10], "%Y-%m-%d")))
        except (ValueError, OverflowError):
            return None

    @staticmethod
    def _safe_int(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    # ------------------------------------------------------------ 下载
    @staticmethod
    def _ytdlp_base_opts() -> dict[str, Any]:
        opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "socket_timeout": 30,
            "noplaylist": True,
        }
        if settings.YOUTUBE_PROXY:
            opts["proxy"] = settings.YOUTUBE_PROXY
        if settings.FFMPEG_LOCATION:
            opts["ffmpeg_location"] = settings.FFMPEG_LOCATION
        return opts

    @staticmethod
    def _extract_info(video_url: str, opts: dict[str, Any], download: bool) -> Any:
        """在线程里同步调用 yt-dlp（它是阻塞库，不能直接放进事件循环）。"""
        import yt_dlp

        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(video_url, download=download)

    async def _run_ytdlp(
        self, video_url: str, extra: dict[str, Any] | None = None, download: bool = False
    ) -> Any:
        """按播放器客户端回退链依次尝试，第一个成功的即返回。

        整条链都失败时抛出最后一个异常：YouTube 的反爬策略经常只对某些客户端
        生效，单一客户端失败不代表视频不可下载。
        """
        last_error: Exception | None = None
        for clients in _YTDLP_CLIENT_CHAIN:
            opts = self._ytdlp_base_opts()
            opts["extractor_args"] = {"youtube": {"player_client": clients}}
            # extra 放在最后，允许调用方覆盖 skip_download 等基础项
            opts.update(extra or {})
            try:
                info = await asyncio.to_thread(
                    self._extract_info, video_url, opts, download
                )
                logger.info("yt-dlp 使用 %s 客户端成功", clients)
                return info
            except Exception as exc:  # noqa: BLE001 - 逐个客户端尝试
                last_error = exc
                logger.warning("yt-dlp 客户端 %s 失败: %s", clients, str(exc)[:120])
        raise YouTubeError(
            -3,
            f"YouTube 取流失败（已尝试 {len(_YTDLP_CLIENT_CHAIN)} 种播放器客户端）：{last_error}",
        )

    async def fetch_streams(self, video_id: str) -> dict[str, Any]:
        """列出该视频可下载的流。

        返回结构刻意区分「可直接下」与「需 ffmpeg 合并」两类：
        YouTube 现在只提供音视频分离的 DASH 流，没有自带声音的整片，
        「带声音的完整视频」必须由 ffmpeg 合并，没有 ffmpeg 时只能
        提供纯视频或纯音频——这一点必须如实告诉用户，而不是给一个没声音的文件。
        """
        video_url = f"{WATCH_URL}?v={video_id}"
        info = await self._run_ytdlp(video_url)
        return self._streams_from_info(info)

    @staticmethod
    def _streams_from_info(info: Any) -> dict[str, Any]:
        formats = info.get("formats") or []
        streams: list[dict[str, Any]] = []
        for fmt in formats:
            if not fmt.get("url"):
                continue
            has_video = (fmt.get("vcodec") or "none") != "none"
            has_audio = (fmt.get("acodec") or "none") != "none"
            streams.append(
                {
                    "format_id": str(fmt.get("format_id") or ""),
                    "ext": fmt.get("ext") or "mp4",
                    "resolution": fmt.get("resolution") or fmt.get("format_note") or "",
                    "note": fmt.get("format_note") or "",
                    "has_video": has_video,
                    "has_audio": has_audio,
                    "filesize": fmt.get("filesize") or fmt.get("filesize_approx") or 0,
                    "abr": fmt.get("abr") or 0,
                }
            )
        # 视频流按分辨率从高到低，便于前端默认选中最高清
        def sort_key(item: dict[str, Any]) -> tuple[int, float]:
            resolution = str(item["resolution"])
            match = re.search(r"(\d+)", resolution)
            height = int(match.group(1)) if match else 0
            return (height, float(item["abr"] or 0))

        streams.sort(key=sort_key, reverse=True)
        return {
            "title": info.get("title") or "",
            "duration": info.get("duration") or 0,
            "thumbnail": info.get("thumbnail") or "",
            "ffmpeg_available": YouTubeAdapter.ffmpeg_available(),
            "streams": streams,
        }

    @staticmethod
    def ffmpeg_available() -> bool:
        """检测 ffmpeg 是否可用（决定能否提供音视频合并下载）。

        YouTube 只给音视频分离的 DASH 流，没有 ffmpeg 就意味着拿不到
        「带声音的完整视频」——这时必须如实告知，而不是给一个没声音的文件。
        """
        import shutil

        candidate = settings.FFMPEG_LOCATION
        if candidate:
            return bool(shutil.which(candidate) or Path(candidate).is_file())
        return shutil.which("ffmpeg") is not None

    async def download_to_file(self, video_id: str, format_id: str) -> tuple[str, str]:
        """用 yt-dlp 把视频下载到临时文件，返回 (目录, 文件路径)。

        调用方负责在使用完后删除返回的目录。

        `format_id == "merge"` 时下载「最佳视频 + 最佳音频」并用 ffmpeg 合并成
        mp4；其余情况下载指定单流（可能是纯视频或纯音频）。
        """
        import tempfile

        tmpdir = tempfile.mkdtemp(prefix="yt-dl-")
        opts: dict[str, Any] = {
            "outtmpl": str(Path(tmpdir) / "%(title).80s.%(ext)s"),
            # 关键：基础项里是 skip_download=True（列流用），这里必须关掉才会落盘
            "skip_download": False,
            "noprogress": True,
        }
        if format_id == "merge":
            # bestvideo+bestaudio 一定会触发 ffmpeg 合并
            opts["format"] = "bestvideo+bestaudio/best"
            opts["merge_output_format"] = "mp4"
        else:
            opts["format"] = str(format_id)

        video_url = f"{WATCH_URL}?v={video_id}"
        info = await self._run_ytdlp(video_url, extra=opts, download=True)

        # yt-dlp 会把实际写出的文件记在 requested_downloads 里
        for entry in info.get("requested_downloads") or []:
            filepath = entry.get("filepath") or ""
            if filepath and Path(filepath).is_file():
                return tmpdir, filepath

        # 兜底：直接扫临时目录，取最大的那个（合并产物通常最大）
        files = [p for p in Path(tmpdir).iterdir() if p.is_file()]
        if not files:
            raise YouTubeError(-5, "下载完成但未找到输出文件")
        return tmpdir, str(max(files, key=lambda p: p.stat().st_size))

    # ------------------------------------------------------------ 登录
    async def start_login(self) -> LoginTicket:
        raise NotImplementedError("YouTube 搜索与详情均无需登录")

    async def poll_login(self, ticket: LoginTicket) -> LoginResult:
        return LoginResult(status="error", message="YouTube 无需登录")

    async def verify_credentials(self, credentials: dict[str, Any]) -> tuple[bool, str]:
        return True, "YouTube 无需登录凭据"
