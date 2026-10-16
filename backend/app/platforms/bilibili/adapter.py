"""B 站平台适配器实现。

已实现内容形态：
  - video   视频（search_type=video）
  - article 图文/专栏（search_type=article）

多平台扩展提示：新平台复制本文件结构实现 PlatformAdapter 即可，
无需触碰推荐引擎与路由层。
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
from typing import Any, ClassVar

from app.core.config import settings
from app.platforms.base import (
    Author,
    ContentItem,
    ContentKind,
    LoginResult,
    LoginTicket,
    PlatformAdapter,
    SearchParams,
)
from app.platforms.bilibili.client import BilibiliClient, BilibiliError
from app.platforms.bilibili.login import BilibiliLogin

logger = logging.getLogger(__name__)

# 分页抓取策略：B 站对同关键词高频并发有风控，整页并发会偶发丢页，
# 故限制批大小并在批间留出间隔；失败页串行补抓。
PAGING_CONCURRENCY = 3      # 单批并发页数
PAGING_BATCH_DELAY = 0.45   # 批之间的间隔（秒）
PAGING_RETRY_DELAY = 0.9    # 补抓前的等待（秒）
MAX_FETCH_PAGES = 30        # 单次请求最多抓多少页

# 搜索结果标题里包裹的高亮标签，需剥离
_TAG_RE = re.compile(r"<[^>]+>")
# duration 字段形如 "12:34" 或 "1:02:03"
_DURATION_RE = re.compile(r"^(?:\d+:)?\d+:\d+$")

# 排序映射：通用语义 -> B 站原生字段
_VIDEO_ORDER_MAP = {
    "relevance": "totalrank",
    "hot": "click",
    "new": "pubdate",
}
_ARTICLE_ORDER_MAP = {
    "relevance": "totalrank",
    "hot": "click",
    "new": "pubdate",
}


def clean_text(value: str | None) -> str:
    """去除搜索结果中的 HTML 标签、还原实体字符。"""
    if not value:
        return ""
    text = _TAG_RE.sub("", str(value))
    # 序列图 dstRaw 用 &amp; 等转义
    return html.unescape(text).strip()


def parse_duration(value: str | int | None) -> int | None:
    """将 "05:23" / "1:02:03" 转为秒数。"""
    if value is None:
        return None
    if isinstance(value, int):
        return max(value, 0)
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)
    if not _DURATION_RE.match(text):
        return None
    try:
        parts = [int(p) for p in text.split(":")]
        seconds = 0
        for part in parts:
            seconds = seconds * 60 + part
        return seconds
    except ValueError:
        return None


def normalize_cover(url: str | None) -> str:
    """补全协议头并切到 https，避免混合内容告警。"""
    if not url:
        return ""
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("http://"):
        return url.replace("http://", "https://", 1)
    return url


def to_int(value: Any, default: int = 0) -> int:
    """接口字段偶有缺 None / 字符串环绕的情况，统一兜底。"""
    if value is None:
        return default
    try:
        return int(str(value).replace(",", "").strip() or default)
    except (TypeError, ValueError):
        return default


class BilibiliAdapter(PlatformAdapter):
    key: ClassVar[str] = "bilibili"
    display_name: ClassVar[str] = "哔哩哔哩"
    accent_color: ClassVar[str] = "#FB7299"
    homepage: ClassVar[str] = "https://www.bilibili.com"
    supported_kinds: ClassVar[list[ContentKind]] = ["video", "article"]
    supports_login: ClassVar[bool] = True
    # 搜索结果自带播放量，粉丝量可查 /x/relation/stat，故两项门槛都可实现
    supports_thresholds: ClassVar[bool] = True

    # ============================================================ 搜索
    def __init__(self) -> None:
        self.client = BilibiliClient()
        self.login = BilibiliLogin(self.client)
        # 作者粉丝数缓存：一次搜索会命中多个 UP 主，同一个 mid 反复查会拖慢检索。
        # 粉丝数变化很慢，进程内缓存足够（数量大时整体丢弃，避免无界增长）。
        self._follower_cache: dict[str, int | None] = {}

    async def aclose(self) -> None:
        """释放底层 HTTP 连接池。

        main.py 的 lifespan 会通过 getattr 探测并调用本方法，
        缺失它会导致进程退出时连接池无法回收。
        """
        await self.client.aclose()

    async def search(
        self, params: SearchParams, credentials: dict[str, Any] | None = None
    ) -> list[ContentItem]:
        """并行下探视频与图文两路，再合并交付推荐引擎。"""
        tasks: list[tuple[ContentKind, Any]] = []
        for kind in params.kinds:
            if kind == "video":
                tasks.append(("video", self._search_video(params, credentials)))
            elif kind == "article":
                tasks.append(("article", self._search_article(params, credentials)))

        if not tasks:
            return []

        results = await asyncio.gather(
            *[coro for _, coro in tasks], return_exceptions=True
        )

        items: list[ContentItem] = []
        for (kind, _), result in zip(tasks, results):
            if isinstance(result, BaseException):
                logger.warning("B 站 %s 检索失败: %s", kind, result)
                continue
            items.extend(result)
        return await self._apply_thresholds(items, params)

    # ------------------------------------------------------------ 互动量过滤
    async def _apply_thresholds(
        self, items: list[ContentItem], params: SearchParams
    ) -> list[ContentItem]:
        """按播放量 / 粉丝量下限过滤。

        播放量搜索结果里就有，直接比即可。粉丝量必须额外查 UP 主的关系接口
        （/x/relation/stat），因此只对**去重后的作者**并发请求，避免同一 UP 主
        的多条内容把请求量放大数十倍。

        一个刻意的兜底：若所有粉丝数都查不到（接口异常/风控），**跳过粉丝量
        过滤**而不是把结果清空 —— 让「接口抽风」表现为少一层过滤，而不是
        「你搜的东西不存在」。
        """
        min_views = params.min_views
        min_followers = params.min_followers
        if not min_views and not min_followers:
            return items

        result = items
        if min_views:
            result = [i for i in result if i.view_count >= min_views]
            logger.info("B 站播放量过滤（≥%s）：%d → %d 条", min_views, len(items), len(result))

        if min_followers:
            mids = list({i.author.uid for i in result if i.author.uid})
            counts = await asyncio.gather(
                *[self._fetch_follower_count(m) for m in mids],
                return_exceptions=True,
            )
            follower_of: dict[str, int | None] = {}
            for mid, value in zip(mids, counts):
                follower_of[mid] = None if isinstance(value, BaseException) else value

            resolved = [c for c in follower_of.values() if c is not None]
            if not resolved:
                logger.warning(
                    "B 站粉丝数全部查询失败，跳过粉丝量过滤以免结果被清空（%d 位作者）",
                    len(mids),
                )
            else:
                before = len(result)
                kept: list[ContentItem] = []
                for item in result:
                    count = follower_of.get(item.author.uid)
                    if count is None:
                        continue
                    item.extra["follower_count"] = count
                    if count >= min_followers:
                        kept.append(item)
                result = kept
                logger.info(
                    "B 站粉丝量过滤（≥%s）：%d → %d 条", min_followers, before, len(result)
                )

        return result

    async def _fetch_follower_count(self, mid: str) -> int | None:
        """查单个 UP 主的粉丝数（/x/relation/stat）。失败返回 None 而非抛出。"""
        cached = self._follower_cache.get(mid)
        if cached is not None or mid in self._follower_cache:
            return cached
        try:
            data = await self.client.request_json(
                "GET", "/x/relation/stat", params={"vmid": mid}
            )
            count = int((data or {}).get("follower") or 0)
        except Exception as exc:  # noqa: BLE001 - 单个作者查询失败不影响整体
            logger.warning("查询 UP 主粉丝数失败（mid=%s）: %s", mid, exc)
            count = None
        if len(self._follower_cache) > 500:
            self._follower_cache.clear()
        self._follower_cache[mid] = count
        return count

    def _pagerange(self, params: SearchParams) -> list[int]:
        """待抓取的页码列表，从 params.page 起向后取 params.pages 页。"""
        start = max(1, params.page)
        count = max(1, min(params.pages, MAX_FETCH_PAGES))
        return list(range(start, start + count))

    async def _fetch_multi_pages(
        self,
        fetch_fn,
        pages: list[int],
        params: SearchParams,
        credentials: dict[str, Any] | None,
        label: str,
    ) -> list[ContentItem]:
        """分批并发抓取多个页码，并对失败/空响应补抓。

        重要：B 站对同关键词的高频并发有风控，整批 gather 时
        偶发某页被直接返回空 result（而非报错），若不处理就会静默丢数据。
        因此这里限制批大小、批间留出间隔，并在批内检测空洞后串行重试一次。
        """
        import asyncio

        collected: list[ContentItem] = []

        for batch_start in range(0, len(pages), PAGING_CONCURRENCY):
            batch = pages[batch_start : batch_start + PAGING_CONCURRENCY]
            responses = await asyncio.gather(
                *[fetch_fn(page, params, credentials) for page in batch],
                return_exceptions=True,
            )

            healed: list[list[ContentItem]] = []
            for page, response in zip(batch, responses):
                if isinstance(response, BaseException) or not response:
                    # 空洞：稍作等待后串行补一次，避免与下一批请求再次撞车
                    logger.warning("B 站 %s 第 %s 页为空/失败，触发补抓", label, page)
                    await asyncio.sleep(PAGING_RETRY_DELAY)
                    try:
                        retried = await fetch_fn(page, params, credentials)
                        healed.append(retried if isinstance(retried, list) else [])
                    except Exception as exc:  # noqa: BLE001 - 补抓失败则放弃该页
                        logger.warning("B 站 %s 第 %s 页补抓失败: %s", label, page, exc)
                        healed.append([])
                else:
                    healed.append(response)
                collected.extend(healed[-1])

            await asyncio.sleep(PAGING_BATCH_DELAY)

        return collected

    @staticmethod
    def _merge(items: list[ContentItem]) -> list[ContentItem]:
        """合并多页结果并按平台原生顺序去重（保留首次出现位置）。"""
        seen: set[str] = set()
        merged: list[ContentItem] = []
        for item in items:
            key = item.unique_key
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
        return merged

    async def _search_video(
        self, params: SearchParams, credentials: dict[str, Any] | None
    ) -> list[ContentItem]:
        pages = self._pagerange(params)
        collected = await self._fetch_multi_pages(
            self._fetch_video_page, pages, params, credentials, "视频"
        )

        items = self._merge(collected)
        logger.info("B站视频检索「%s」%s 页累计命中 %s 条", params.keyword, len(pages), len(items))
        return items[: params.page_size] if params.page_size > 0 else items

    async def _fetch_video_page(
        self, page: int, params: SearchParams, credentials: dict[str, Any] | None
    ) -> list[ContentItem]:
        payload: dict[str, Any] = {
            "search_type": "video",
            "keyword": params.keyword,
            "page": page,
            "order": _VIDEO_ORDER_MAP.get(params.order, "totalrank"),
        }
        if params.duration_min is not None or params.duration_max is not None:
            payload["duration"] = self._duration_code(params.duration_min, params.duration_max)
        if params.pubdate_begin and params.pubdate_end:
            payload["pubtime_begin_s"] = params.pubdate_begin
            payload["pubtime_end_s"] = params.pubdate_end

        data = await self.client.request_json(
            "GET", "/x/web-interface/wbi/search/type", params=payload,
            credentials=credentials, signed=True,
        )
        # 单页结果由平台决定上限，此处不再二次裁剪
        rows = (data.get("result") or []) if isinstance(data, dict) else []
        return [self._video_to_item(row) for row in rows]

    async def _search_article(
        self, params: SearchParams, credentials: dict[str, Any] | None
    ) -> list[ContentItem]:
        pages = self._pagerange(params)
        collected = await self._fetch_multi_pages(
            self._fetch_article_page, pages, params, credentials, "图文"
        )

        items = self._merge(collected)
        logger.info("B站图文检索「%s」%s 页累计命中 %s 条", params.keyword, len(pages), len(items))
        return items[: params.page_size] if params.page_size > 0 else items

    async def _fetch_article_page(
        self, page: int, params: SearchParams, credentials: dict[str, Any] | None
    ) -> list[ContentItem]:
        payload: dict[str, Any] = {
            "search_type": "article",
            "keyword": params.keyword,
            "page": page,
            "order": _ARTICLE_ORDER_MAP.get(params.order, "totalrank"),
        }
        if params.pubdate_begin and params.pubdate_end:
            payload["pubtime_begin_s"] = params.pubdate_begin
            payload["pubtime_end_s"] = params.pubdate_end

        data = await self.client.request_json(
            "GET", "/x/web-interface/wbi/search/type", params=payload,
            credentials=credentials, signed=True,
        )
        rows = (data.get("result") or []) if isinstance(data, dict) else []
        return [self._article_to_item(row) for row in rows]

    @staticmethod
    def _duration_code(dmin: int | None, dmax: int | None) -> int | None:
        """把秒数区间映射为 B 站的 length_type 枚举（取最贴近的一档）。"""
        seconds = dmax if dmax is not None else dmin
        if seconds is None:
            return None
        if seconds <= 600:
            return 1  # 10 分钟以下
        if seconds <= 1800:
            return 2  # 10-30 分钟
        if seconds <= 3600:
            return 3  # 30-60 分钟
        return 4  # 60 分钟以上

    # ---------------------------------------------------- 结构转换
    def _video_to_item(self, row: dict[str, Any]) -> ContentItem:
        bvid = row.get("bvid") or ""
        aid = str(row.get("aid") or row.get("id") or "")
        mid = str(row.get("mid") or "")
        duration = parse_duration(row.get("duration"))

        return ContentItem(
            platform=self.key,
            kind="video",
            uid=aid or bvid,
            title=clean_text(row.get("title")),
            summary=clean_text(row.get("description")),
            cover_url=normalize_cover(row.get("pic")),
            page_url=f"https://www.bilibili.com/video/{bvid}" if bvid else "",
            author=Author(
                uid=mid,
                name=clean_text(row.get("author")),
                avatar_url=normalize_cover(row.get("upic")),
                homepage=f"https://space.bilibili.com/{mid}" if mid else "",
            ),
            published_at=to_int(row.get("pubdate")) or None,
            duration=duration,
            view_count=to_int(row.get("play")),
            like_count=to_int(row.get("like")),
            comment_count=to_int(row.get("review")),
            favorite_count=to_int(row.get("favorites")),
            danmaku_count=to_int(row.get("video_review") or row.get("danmaku")),
            tags=[t for t in clean_text(row.get("tag")).split(",") if t],
            extra={
                "bvid": bvid,
                "aid": aid,
                "badge": clean_text(row.get("badge")),
                "rank_score": to_int(row.get("rank_score")),
            },
        )

    def _article_to_item(self, row: dict[str, Any]) -> ContentItem:
        cv_id = str(row.get("id") or "")
        mid = str(row.get("mid") or "")
        cover = row.get("image_urls") or []
        first_image = normalize_cover(cover[0]) if cover else normalize_cover(row.get("cover"))

        return ContentItem(
            platform=self.key,
            kind="article",
            uid=cv_id,
            title=clean_text(row.get("title")),
            summary=clean_text(row.get("description") or row.get("summary")),
            cover_url=first_image,
            page_url=f"https://www.bilibili.com/read/cv{cv_id}" if cv_id else "",
            author=Author(
                uid=mid,
                name=clean_text(row.get("author") or row.get("name")),
                avatar_url="",
                homepage=f"https://space.bilibili.com/{mid}" if mid else "",
            ),
            published_at=to_int(row.get("pub_time") or row.get("ctime")) or None,
            view_count=to_int(row.get("view")),
            like_count=to_int(row.get("like")),
            comment_count=to_int(row.get("reply")),
            favorite_count=to_int(row.get("favorite")),
            tags=[clean_text(row.get("category_name"))] if row.get("category_name") else [],
            extra={
                "cv_id": cv_id,
                "image_count": len(cover),
                "category": clean_text(row.get("category_name")),
            },
        )

    # ============================================================ 详情
    async def fetch_detail(
        self, uid: str, credentials: dict[str, Any] | None = None
    ) -> ContentItem | None:
        """按 bvid / aid 拉取单个视频详情。"""
        param_key = "aid" if uid.isdigit() else "bvid"
        try:
            data = await self.client.request_json(
                "GET", "/x/web-interface/view",
                params={param_key: uid}, credentials=credentials,
            )
        except BilibiliError as exc:
            logger.warning("获取视频详情失败 %s: %s", uid, exc)
            return None

        stat = data.get("stat") or {}
        owner = data.get("owner") or {}
        # 新版 view 接口不再内联返回 tags，需单独取一次
        tags = await self._fetch_tags(data.get("bvid", ""))
        return ContentItem(
            platform=self.key,
            kind="video",
            uid=str(data.get("aid", uid)),
            title=data.get("title", ""),
            summary=data.get("desc", ""),
            cover_url=normalize_cover(data.get("pic")),
            page_url=f"https://www.bilibili.com/video/{data.get('bvid', uid)}",
            author=Author(
                uid=str(owner.get("mid", "")),
                name=owner.get("name", ""),
                avatar_url=normalize_cover(owner.get("face")),
            ),
            published_at=data.get("pubdate"),
            duration=data.get("duration"),
            view_count=to_int(stat.get("view")),
            like_count=to_int(stat.get("like")),
            comment_count=to_int(stat.get("reply")),
            favorite_count=to_int(stat.get("favorite")),
            danmaku_count=to_int(stat.get("danmaku")),
            coin_count=to_int(stat.get("coin")),
            share_count=to_int(stat.get("share")),
            tags=tags,
            extra={"bvid": data.get("bvid", "")},
        )

    # ============================================================ 播放地址 / 下载
    async def get_playurl(
        self,
        uid: str,
        cid: int | None = None,
        credentials: dict[str, Any] | None = None,
        qn: int | None = None,
    ) -> dict[str, Any]:
        """获取视频播放直链与分 P 信息，供下载使用。

        调用 /x/player/playurl，需登录态 Cookie 才能拿高清（游客最高 480P，
        登录最高 1080P，大会员更高）。返回结构：
          {
            "bvid": str, "aid": str, "title": str,
            "pages": [{"cid": int, "page": int, "part": str, "duration": int}],
            "current_cid": int, "quality": int, "quality_desc": str,
            "formats": [{"quality": int, "desc": str}],
            "durl": [{"url": str, "size": int, "length": int}],
          }

        :param qn: 请求的目标清晰度代码（取 support_formats 里的 quality）。
            不传则用 80（1080P）——B 站会在权限不足时自动降级到可用的最高档，
            因此「不传」永远能拿到东西；传了则尽力满足该档，拿不到会如实报错。
        """
        # 先解析 bvid/aid；playurl 需要 bvid 与 cid
        bvid = uid if not uid.isdigit() else ""
        param_key = "aid" if uid.isdigit() else "bvid"

        try:
            view = await self.client.request_json(
                "GET", "/x/web-interface/view",
                params={param_key: uid}, credentials=credentials,
            )
        except BilibiliError as exc:
            logger.warning("获取视频信息失败 %s: %s", uid, exc)
            raise

        bvid = view.get("bvid") or bvid
        pages = view.get("pages") or []
        cid_list = [p.get("cid") for p in pages if p.get("cid")]

        if cid is None:
            cid = cid_list[0] if cid_list else (view.get("cid") or 0)

        # playurl 需要 Referer 指向视频页 + 登录态。
        # 关键参数：
        #   - qn=80 请求 1080P（游客会自动降级到其最高可用，如 720P/480P）。
        #     不能写 qn=127（8K）：无大会员时接口直接报 -400「请求错误」。
        #     用户选定清晰度时传入对应 qn；取不到该档时接口会自行降级，
        #     降级结果由响应里的 quality 如实回报，不伪造。
        #   - fnval=1 返回 durl（FLV 直链，可下载）；fnval=16 返回 dash 流（分片）。
        payload: dict[str, Any] = {
            "bvid": bvid,
            "cid": cid,
            "qn": int(qn) if qn else 80,
            "fnval": 1,
            "fnver": 0,
            "fourk": 1,
        }
        try:
            play = await self.client.request_json(
                "GET", "/x/player/playurl", params=payload, credentials=credentials,
            )
        except BilibiliError as exc:
            logger.warning("获取播放地址失败 %s: %s", uid, exc)
            raise

        # 支持的清晰度列表（去重保序）
        formats: list[dict[str, Any]] = []
        seen_q: set[int] = set()
        for f in play.get("support_formats") or []:
            q = f.get("quality")
            if q is None or q in seen_q:
                continue
            seen_q.add(q)
            formats.append({"quality": q, "desc": f.get("new_description") or f.get("display_desc") or str(q)})
        # 若 support_formats 为空，回退 durl 里的清晰度
        if not formats:
            for d in play.get("durl") or []:
                formats.append({
                    "quality": play.get("quality") or 0,
                    "desc": play.get("quality") and f"{play.get('quality')}P" or "默认",
                })

        # 实际拿到的清晰度（可能与请求的不同 —— 权限不足时会被降级）。
        # 用 support_formats 里的描述把它翻译成人话，而不是甩一个裸数字给前端。
        actual_q = play.get("quality") or 0
        desc_by_q = {f["quality"]: f["desc"] for f in formats}
        quality_desc = desc_by_q.get(actual_q) or (f"{actual_q}P" if actual_q else "")

        return {
            "bvid": bvid,
            "aid": str(view.get("aid") or ""),
            "title": view.get("title") or "",
            "pages": [
                {
                    "cid": p.get("cid"),
                    "page": p.get("page"),
                    "part": p.get("part") or "",
                    "duration": p.get("duration"),
                }
                for p in pages
            ],
            "current_cid": cid,
            "quality": actual_q,
            "quality_desc": quality_desc,
            "formats": formats,
            "durl": [
                {"url": d.get("url") or "", "size": d.get("size") or 0, "length": d.get("length") or 0}
                for d in (play.get("durl") or [])
                if d.get("url")
            ],
        }

    async def _fetch_tags(self, bvid: str) -> list[str]:
        """取视频标签。

        新版 /x/web-interface/view 已移除 tags 字段，
        需要单独请求 /x/tag/archive/tags。失败时静默降级为空列表，
        不应因标签缺失导致整个详情加载失败。
        """
        if not bvid:
            return []
        try:
            data = await self.client.request_json(
                "GET", "/x/tag/archive/tags", params={"bvid": bvid}, signed=True
            )
            # 该接口的标签是裸数组而非标准 data 段，request_json 会把它包成 result；
            # 也可能直接落在 data 上，两种形态都要兼容。
            rows = data.get("result") or data.get("data") or []
            return [
                str(item.get("tag_name", "")).strip()
                for item in rows
                if isinstance(item, dict) and item.get("tag_name")
            ][:10]
        except Exception as exc:  # noqa: BLE001
            logger.warning("获取视频标签失败(%s): %s", bvid, exc)
            return []

    # ============================================================ 评论
    async def fetch_comments(
        self,
        uid: str,
        page: int = 1,
        page_size: int = 20,
        sort: str = "hot",
        credentials: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """获取视频评论。

        :param uid: 视频 aid（B 站评论区的 oid 用 aid 而非 bvid）
        :param sort: hot=热度 / time=时间
        :return: {"items": [...], "total": int, "has_more": bool, "page": int}
        """
        payload: dict[str, Any] = {
            "type": 1,  # 1 = 视频稿件
            "oid": uid,
            "pn": max(1, page),
            "ps": max(1, min(page_size, 49)),
            "sort": 2 if sort == "hot" else 0,
        }
        data = await self.client.request_json(
            "GET", "/x/v2/reply", params=payload, credentials=credentials, signed=True
        )
        replies = data.get("replies") or []
        page_info = data.get("page") or {}

        total = int(page_info.get("count") or 0)
        size = int(page_info.get("size") or payload["ps"])
        shown = int(page_info.get("num") or payload["pn"]) * size

        return {
            "items": [self._reply_to_dict(r) for r in replies],
            "total": total,
            "has_more": total > shown,
            "page": payload["pn"],
        }

    def _reply_to_dict(self, reply: dict[str, Any], is_sub: bool = False) -> dict[str, Any]:
        """把 B 站评论对象压平成平台无关结构，楼中楼最多带 3 条。"""
        member = reply.get("member") or {}
        content = reply.get("content") or {}
        sub_list = reply.get("replies") or []
        return {
            "id": str(reply.get("rpid") or ""),
            "author": member.get("uname") or "",
            "avatar": normalize_cover(member.get("avatar")),
            "content": content.get("message") or "",
            "like": int(reply.get("like") or 0),
            "reply_count": int(reply.get("rcount") or 0),
            "created_at": int(reply.get("ctime") or 0),
            # 楼中楼只展示前 3 条，避免单条评论无限膨胀
            "replies": [] if is_sub else [self._reply_to_dict(s, True) for s in sub_list[:3]],
        }

    # ============================================================ 页面嵌入
    async def fetch_embed_html(
        self, bvid: str, credentials: dict[str, Any] | None = None
    ) -> str:
        """抓取视频页 HTML 并注入净化样式。

        为什么要走服务端代理而不是直接 iframe 站方页面：
          1. 跨域 iframe 无法注入 CSS/JS（同源策略），就藏不掉推荐区
          2. 我们保存在库里的 Cookie 也无法传给跨域 iframe，登录态会丢
        代理成同源之后，两个问题一并解决：样式全局生效（连 JS 后续渲染的
        推荐也会被隐藏），首屏与播放器都按登录态渲染。
        """
        await self.client._ensure_fingerprint()
        headers = {
            "User-Agent": settings.USER_AGENT,
            "Referer": "https://www.bilibili.com/",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cookie": self.client._build_cookie(credentials),
        }
        client = await self.client._ensure_client()
        resp = await client.get(
            f"https://www.bilibili.com/video/{bvid}", headers=headers, follow_redirects=True
        )
        resp.raise_for_status()
        return self._inject_cleanup_css(resp.text)

    # 需要隐藏的元素特征。SSR 首屏里推荐区是空的（Vue 的 <!----> 占位），
    # 真实内容全部由客户端 JS 动态渲染，所以单靠 CSS 选择器命中不了，
    # 必须由注入的 JS 配合 MutationObserver 持续清扫。
    CLEANUP_JS = """
<script id="lingoseek-cleanup-js">
(function () {
  // 关键词清单放宽：站方推荐容器的真实类名无法从 SSR 推断（首屏为空），
  // 故改为「子串包含」而非精确匹配，覆盖 recommend / related / side / header 等变体。
  // 实测 SSR 已能命中 .rec-list / .video-page-card-small / .right-container，此处兜底动态渲染。
  var KEYWORDS = [
    'recommend', 'related', 'side-bar', 'sidebar', 'side_bar',
    'rec-list', 'video-page-card', 'right-container',
    'bili-header', 'biliheader', 'mini-header', 'bili-video-card',
    'feed-card', 'video-card-list', 'right-side', 'fixed-sidenav'
  ];
  var observer = null;
  // 等级越高越激进：0=关键词命中，1=宽泛（含 card/feed/hot/rank），2=按几何位置扫右侧
  var level = 0;
  var WIDE = ['card', 'feed', 'hot', 'rank', 'guess', 'more', 'list'];

  function text(el) {
    return ((el.getAttribute && el.getAttribute('class')) || '') + ' ' +
           ((el.getAttribute && el.getAttribute('id')) || '');
  }

  function match(el) {
    var s = text(el).toLowerCase();
    if (!s.trim()) return false;
    for (var i = 0; i < KEYWORDS.length; i++) {
      if (s.indexOf(KEYWORDS[i]) >= 0) return true;
    }
    if (level >= 1) {
      for (var j = 0; j < WIDE.length; j++) {
        if (s.indexOf(WIDE[j]) >= 0) return true;
      }
    }
    return false;
  }

  // 几何兜底：隐藏明显位于主内容右侧的宽栏（推荐区通常固定在右列）
  function matchByGeometry(el) {
    if (level < 2) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width < 200) return false;
    var vw = window.innerWidth || 1000;
    return r.left > vw * 0.55 && r.height > 200;
  }

  // 供父页面调用：逐级加强过滤强度（同源 iframe 可直接访问 contentWindow）
  window.__lingoseekEscalate = function () {
    level = Math.min(level + 1, 2);
    sweep();
    return level;
  };
  window.__lingoseekLevel = function () { return level; };

  // 统计已隐藏元素数并暴露给父页面，便于确认清扫是否真的生效
  var stats = { hidden: 0, last: '' };
  window.__lingoseekStats = stats;

  function hide(el) {
    if (!el || el.__lsHidden) return;
    el.__lsHidden = true;
    stats.hidden++;
    stats.last = (el.getAttribute('class') || el.tagName).slice(0, 60);
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    // 右侧栏收起后，让主内容铺满整行（B 站用 grid 分栏）
    var p = el.parentElement;
    if (p) {
      try {
        p.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');
      } catch (e) { /* 忽略非 grid 容器 */ }
    }
  }

  function sweep() {
    if (!document.body) return;
    var all = document.body.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (match(el) || matchByGeometry(el)) hide(el);
    }
  }

  function boot() {
    sweep();
    try {
      observer = new MutationObserver(sweep);
      observer.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['class']
      });
    } catch (e) { /* 老浏览器降级为一次性清扫 */ }
    // 兜底：延迟再扫几次，覆盖懒加载与异步渲染
    [500, 1500, 3000].forEach(function (t) { setTimeout(sweep, t); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
</script>
"""

    @classmethod
    def _inject_cleanup_css(cls, html: str) -> str:
        """注入隐藏推荐区与站方头部的样式/脚本，并修正资源基准路径。"""
        css = """
<style id="lingoseek-cleanup">
/* ============ 推荐区（真实容器，实测 SSR 命中） ============ */
/* B 站视频页右侧推荐列表的真实容器是 .rec-list，内部是 .video-page-card-small；
   .recommend-list-v1 只是空占位，命中它无用，故以下精确锁定真实节点。 */
.rec-list, .rec-list * { display: none !important; visibility: hidden !important; }
.video-page-card-small, .video-page-card-small * { display: none !important; visibility: hidden !important; }
.recommend-list-v1, .recommend-list-v1 * { display: none !important; visibility: hidden !important; }
/* 右侧栏整体（含 UP 主面板与推荐）。若只想藏推荐、保留 UP 主面板，
   可去掉 .right-container 这一条，但用户要求「铺满、空白最少」，故整体收起。 */
.right-container, .right-container-inner { display: none !important; }
/* ============ 站方头部与频道导航 ============ */
.bili-header__menu, .bili-header__menu * { display: none !important; visibility: hidden !important; }
.biliMainHeader, #biliMainHeader, .bili-header, .bili-header__bar,
.header-channel, .bili-header__channel { display: none !important; }
/* ============ 左侧主内容铺满，去掉右侧栏留下的空隙 ============ */
.video-container-v1, .video-container, .video-page-container, .video-info-container {
    grid-template-columns: minmax(0, 1fr) !important;
    max-width: none !important;
}
.left-container { max-width: none !important; }
/* 去掉因隐藏头部而残留的顶部留白 */
body { padding-top: 0 !important; }
#app, .bili-video-card { margin-top: 0 !important; }
</style>
"""
        # 资源仍从站方域名加载，故保留原站为基准路径
        base = '<base href="https://www.bilibili.com/">'
        payload = f"{base}{css}{cls.CLEANUP_JS}"
        if "<head>" in html:
            html = html.replace("<head>", f"<head>{payload}", 1)
        elif "<HEAD>" in html:
            html = html.replace("<HEAD>", f"<HEAD>{payload}", 1)
        else:
            html = payload + html
        return html

    # ============================================================ 登录
    async def start_login(self) -> LoginTicket:
        return await self.login.generate()

    async def poll_login(self, ticket: LoginTicket) -> LoginResult:
        return await self.login.poll(ticket)

    async def verify_credentials(self, credentials: dict[str, Any]) -> tuple[bool, str]:
        """用 nav 接口体检登录态是否有效。"""
        try:
            data = await self.client.request_json(
                "GET", "/x/web-interface/nav",
                credentials=credentials, tolerant_codes={-101},
            )
        except BilibiliError as exc:
            return False, f"校验失败: {exc.message}"
        if data.get("isLogin"):
            return True, f"登录有效（{data.get('uname', '未知用户')}）"
        return False, "登录态已失效，请重新扫码登录"
