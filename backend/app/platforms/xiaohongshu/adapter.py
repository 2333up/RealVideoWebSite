"""小红书平台适配器。

⚠️ 能力现状（务必阅读，勿夸大）
------------------------------------------------------------------
小红书 Web 端主力搜索接口 `/api/sns/web/v1/search/notes` 受 `X-s` / `X-t`
动态签名保护 —— 小红书自研 JSVMP 混淆 SDK，且数据中心 IP 会被静默风控。
本适配器**不实现该签名逆向**，而是沿用与抖音完全一致的策略：

  ✅ 关键词搜索：普通 HTTP 会被静默风控 / 登录墙拦截，故**回退到浏览器自动化**
     （Playwright 驱动真实 Chromium，让页面 JS 自行生成 X-s / X-t），已接入
  ⚠️ 浏览器自动化依赖 `playwright + chromium`，未安装时会如实报错

架构上与 B 站 / 抖音完全对称：实现 PlatformAdapter + 在 main.py 注册即可。
"""

from __future__ import annotations

import hashlib
import logging
import re
import urllib.parse
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

WEB_BASE = "https://www.xiaohongshu.com"

# 剥离全部 <script>（含内联与外链，DOTALL 跨行匹配）。
# 静态快照模式的核心：小红书 SPA 从我们的源启动会 403，接管失败会清空
# SSR 已渲染的结果卡片；剥离后卡片原样保留，交互由注入的点击拦截接管。
_SCRIPT_RE = re.compile(r"<script\b[^>]*>.*?</script>", re.DOTALL | re.IGNORECASE)
# 自闭合 script（少见但防御一下）
_SCRIPT_OPEN_RE = re.compile(r"<script\b[^>]*/>", re.IGNORECASE)

# 已知的登录态 Cookie 字段（用于校验与提示）
LOGIN_COOKIES = (
    "web_session",
    "a1",
    "gid",
    "websectiga",
    "sec_poison_id",
)

# 整页嵌入（静态快照模式）注入的净化脚本。
# 选择器基于实测的小红书 Web 端真实布局类名（2026-10 探明）：
#   .header-container 顶部导航 / .main-container 频道区 / .bottom-channel 底部菜单
#   .with-side-bar 侧栏挂点 / .feeds-page .search-layout 搜索结果主体（保留铺满）
# 由于 script 已剥离、页面是静态的，无需 MutationObserver 持续清扫。
_XHS_EMBED_CLEANUP = r"""
<style id="lingoseek-xhs-cleanup">
  /* 干扰区：顶部导航、底部菜单、侧栏、页脚、猜你想搜/大家都在搜 */
  .header-container, .bottom-channel, .bottom-menu-component,
  .side-bar, .side-bar-component, .side-bar-ai, [class*="side-bar"],
  .app-info, .information-container, .information-wrapper-ai,
  .channel-list-content, .popover-container, .badge-container,
  [class*="guess"], [class*="hot-search"],
  /* 「大家都在搜」推荐面板（query-note-wrapper 是其实际类名，实测探明） */
  .query-note-wrapper, .query-note-header, .query-note-list
  { display: none !important; }
  /* 关键：小红书自家 CSS 在水合前把主内容 display:none（防闪烁），
     脚本已剥离没人再显示它们。只恢复 display，不覆盖尺寸——
     尺寸交给原生 CSS，否则网格会乱掉（实测教训）。 */
  #app .main-content { display: block !important; margin: 0 !important; padding: 8px 12px !important; }
  #app .feeds-page, #app .search-layout, #app .search-layout__main
    { display: block !important; width: 100% !important; max-width: 100% !important; }
  #app .feeds-container { display: block !important; width: 100% !important; }
  #app section.note-item, #app section.note-item a { display: block !important; }
  #app .main-content, #app .main-content * { visibility: visible !important; }
  body { overflow-y: auto !important; background: #fff !important; }
</style>
<script id="lingoseek-xhs-capture">
/* 修复图片防盗链：小红书 CDN 校验 Referer，127.0.0.1 会被 403。
   给所有图片设 referrerPolicy=no-referrer 并强制重新加载失败的图。
   实测 no-referrer 请求返回 200。 */
(function () {
  function fixImgs() {
    document.querySelectorAll('img').forEach(function (im) {
      if (!im.getAttribute('referrerpolicy')) {
        im.setAttribute('referrerpolicy', 'no-referrer');
      }
      // 已加载失败（complete 但 naturalWidth=0）的图，重新赋 src 触发无 referer 重载
      if (im.complete && im.naturalWidth === 0 && im.src) {
        var s = im.src;
        im.src = '';
        im.src = s;
      }
    });
  }
  fixImgs();
  // 懒加载的图滚动后才出现，用观察器持续兜底
  var mo = new MutationObserver(fixImgs);
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  // 监听 img 加载错误，逐个用 no-referrer 重试
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && !t.getAttribute('referrerpolicy')) {
      t.setAttribute('referrerpolicy', 'no-referrer');
      var s = t.src; t.src = ''; t.src = s;
    }
  }, true);
})();

/* 静态快照没有 SPA 路由：拦截卡片点击，通过 postMessage 通知父页面
   弹出站内详情浮层（父页面用 fetch_detail 抓详情，图文可完整看图）。 */
document.addEventListener('click', function (e) {
  var node = e.target;
  while (node && node !== document.body) {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      var href = node.getAttribute('href') || '';
      if (href.indexOf('/explore/') === 0 || href.indexOf('/search_result/') === 0
          || href.indexOf('/user/profile/') === 0) {
        e.preventDefault();
        var noteId = '';
        var m = href.match(/\/explore\/([0-9a-zA-Z]+)/);        if (m) noteId = m[1];
        var cover = '';
        var img = node.querySelector('img') || node.parentElement.querySelector('img');
        if (img) cover = img.src || img.getAttribute('data-src') || '';
        window.parent.postMessage({
          type: 'lingoseek-xhs-open',
          noteId: noteId,
          href: href,
          cover: cover
        }, '*');
      }
      return;
    }
    node = node.parentNode;
  }
}, true);
</script>
"""


class XiaohongshuError(RuntimeError):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


class XiaohongshuAdapter(PlatformAdapter):
    key: ClassVar[str] = "xiaohongshu"
    display_name: ClassVar[str] = "小红书"
    accent_color: ClassVar[str] = "#FF2442"  # 小红书品牌红
    homepage: ClassVar[str] = "https://www.xiaohongshu.com"
    supported_kinds: ClassVar[list] = ["video", "article"]
    # 小红书登录依赖 X-s 签名体系，当前不提供扫码登录
    supports_login: ClassVar[bool] = False
    # 但支持手动粘贴浏览器 Cookie —— 登录态是能否稳定搜索的关键变量
    manual_credential: ClassVar[bool] = True

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        # 浏览器自动化搜索：绕过 X-s 的唯一可行路径（惰性启动，首次搜索才拉起）
        self._browser_search: Any = None

    async def _ensure_browser_search(self) -> Any:
        """惰性导入浏览器搜索模块，避免未装 playwright 时导入即报错。"""
        if self._browser_search is None:
            from app.platforms.xiaohongshu.browser_search import XiaohongshuBrowserSearch

            self._browser_search = XiaohongshuBrowserSearch()
        return self._browser_search

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        if self._browser_search is not None:
            await self._browser_search.aclose()

    # ------------------------------------------------------------ 搜索
    async def search(
        self, params: SearchParams, credentials: dict[str, Any] | None = None
    ) -> list[ContentItem]:
        """关键词检索笔记。

        小红书搜索无「普通 HTTP 可用」的公开回退路径（热榜接口同样受 X-s 保护），
        因此直接走浏览器自动化。浏览器自动化无法真正翻页（每次都是重开页面拿
        第一屏 + 滚动），故 page > 1 时直接返回空，交由前端停止「加载更多」，
        避免重复的昂贵劳动。
        """
        if params.page > 1:
            logger.info("小红书浏览器搜索不支持翻页（page=%s），返回空以终止加载更多", params.page)
            return []

        try:
            browser = await self._ensure_browser_search()
            items = await browser.search(
                params.keyword,
                credentials=credentials,
                max_items=params.page_size,
            )
        except Exception as exc:  # noqa: BLE001
            raise XiaohongshuError(
                -2,
                f"小红书浏览器自动化搜索失败：{exc}",
            ) from exc

        if not items:
            raise XiaohongshuError(
                -1,
                f"小红书搜索「{params.keyword}」未返回结果。可能原因：关键词无内容、"
                "账号未登录、或被风控。请确认已注入有效 Cookie 后重试",
            )
        return items

    # ------------------------------------------------------------ 解析
    def _note_to_item(self, note: dict[str, Any]) -> ContentItem | None:
        """把小红书笔记对象压平成统一的 ContentItem。

        字段结构基于 search/notes 返回的 note_card（可能被 note_card 包裹或直铺）：
          - id / note_id           笔记 ID
          - display_title          标题
          - desc                   正文摘要（可选）
          - type                   normal=图文 / video=视频
          - cover                  { url_default / info_list }
          - user                   { nickname / avatar / user_id }
          - interact_info          { liked_count / collected_count / comment_count / share_count }
        """
        # 兼容两种入参形态：
        #   1. 完整 entry：{id, model_type, note_card:{...}, xsec_token}
        #   2. 直接就是 note_card 内容
        entry_id = ""
        entry_xsec = ""
        if "note_card" in note and isinstance(note.get("note_card"), dict):
            entry_id = str(note.get("id") or "")
            entry_xsec = str(note.get("xsec_token") or "")
            note = note["note_card"]

        note_id = str(note.get("id") or note.get("note_id") or entry_id or "")
        if not note_id:
            return None

        note_type = note.get("type") or ""
        # normal=图文，video=视频；未知类型按图文处理（小红书笔记图文居多）
        kind = "video" if note_type == "video" else "article"

        cover = note.get("cover") or {}
        cover_url = cover.get("url_default") or cover.get("url") or ""
        if not cover_url:
            info_list = cover.get("info_list") or []
            for info in reversed(info_list):
                url = (info.get("url") or "").strip()
                if url and "default" in url:
                    cover_url = url
                    break
            if not cover_url and info_list:
                cover_url = info_list[-1].get("url") or info_list[0].get("url") or ""
        cover_url = self._normalize_url(cover_url)

        user = note.get("user") or {}
        user_id = str(user.get("user_id") or user.get("id") or "")
        nickname = self._clean(user.get("nickname") or user.get("nick_name") or user.get("name"))
        avatar = self._normalize_url(user.get("avatar") or "")

        interact = note.get("interact_info") or {}

        # 时长：video 段可能含 duration（毫秒），图文无
        duration: int | None = None
        video = note.get("video") or {}
        if kind == "video" and video:
            dur = video.get("duration")
            if isinstance(dur, (int, float)) and dur > 0:
                # 小红书 video.duration 单位为毫秒
                duration = int(dur / 1000) if dur > 1000 else int(dur)

        title = self._clean(note.get("display_title") or note.get("title"))
        desc = self._clean(note.get("desc") or "")
        # 视频笔记的搜索接口常不返回 display_title，只有 desc；
        # 用 desc 首行/前若干字兜底标题，避免前端出现空白卡片。
        if not title and desc:
            title = desc.strip().splitlines()[0][:40] if desc.strip() else ""
        if not title and nickname:
            title = f"{nickname} 的笔记"

        return ContentItem(
            platform=self.key,
            kind=kind,
            uid=note_id,
            title=title,
            summary=desc,
            cover_url=cover_url,
            page_url=f"https://www.xiaohongshu.com/explore/{note_id}",
            author=Author(
                uid=user_id,
                name=nickname,
                avatar_url=avatar,
                homepage=f"https://www.xiaohongshu.com/user/profile/{user_id}" if user_id else "",
            ),
            published_at=self._to_timestamp(note.get("time") or note.get("last_update_time")),
            view_count=0,  # search/notes 不返回播放量，如实展示，不伪造
            like_count=self._to_int(interact.get("liked_count")),
            comment_count=self._to_int(interact.get("comment_count")),
            favorite_count=self._to_int(interact.get("collected_count")),
            share_count=self._to_int(interact.get("share_count")),
            duration=duration,
            tags=self._extract_tags(note),
            extra={
                "note_id": note_id,
                "xsec_token": note.get("xsec_token", "") or entry_xsec,
                "note_type": note_type,
            },
        )

    @staticmethod
    def _extract_tags(note: dict[str, Any]) -> list[str]:
        """从笔记的 tag_list 提取话题标签。"""
        tags: list[str] = []
        for tag in note.get("tag_list") or []:
            name = (tag.get("name") or "").strip()
            if name:
                tags.append(name)
        return tags[:6]

    @staticmethod
    def _to_int(value: Any) -> int:
        """把互动数转 int，兼容「2.1万」「1.4万」等中文单位缩写。"""
        if value is None:
            return 0
        text = str(value).replace(",", "").strip()
        if not text:
            return 0
        try:
            if "万" in text:
                num = float(text.replace("万", "").strip())
                return int(num * 10000)
            if "亿" in text:
                num = float(text.replace("亿", "").strip())
                return int(num * 100000000)
            return int(float(text))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _to_timestamp(value: Any) -> int | None:
        """time 字段可能是秒级或毫秒级时间戳，统一归一为秒。"""
        if value is None:
            return None
        try:
            ts = int(value)
        except (TypeError, ValueError):
            return None
        if ts <= 0:
            return None
        # 毫秒级（13 位）归一为秒
        return ts // 1000 if ts > 10_000_000_000 else ts

    @staticmethod
    def _clean(value: str | None) -> str:
        return (value or "").strip()

    @staticmethod
    def _normalize_url(url: str | None) -> str:
        if not url:
            return ""
        if url.startswith("//"):
            return f"https:{url}"
        if url.startswith("http://"):
            return url.replace("http://", "https://", 1)
        return url

    # ------------------------------------------------------------ 详情
    async def fetch_detail(
        self, uid: str, credentials: dict[str, Any] | None = None
    ) -> ContentItem | None:
        """用浏览器自动化打开笔记详情页，从 SSR 提取详情数据。

        uid 可能是纯 note_id，也可能是「note_id + xsec_token」的拼接形式。
        详情页必须带 xsec_token 才能渲染出真实数据，否则返回空对象。
        """
        note_id = uid
        xsec_token = ""

        # uid 可能形如 "note_id|xsec_token"（由搜索结果的 extra 拼合，避免丢失 token）
        if "|" in uid:
            note_id, xsec_token = uid.split("|", 1)

        try:
            browser = await self._ensure_browser_search()
            detail = await browser.fetch_detail(note_id, xsec_token, credentials)
        except Exception as exc:  # noqa: BLE001
            logger.warning("小红书详情抓取失败（note_id=%s）: %s", note_id, exc)
            return None

        if not detail or not isinstance(detail, dict):
            return None

        note_type = detail.get("type") or ""
        kind = "video" if note_type == "video" else "article"
        user = detail.get("user") or {}
        # browser_search 返回的 key 是 interactInfo（驼峰），这里兼容两种命名
        interact = detail.get("interactInfo") or detail.get("interact_info") or {}

        # 图片列表：https 化（小红书图片 CDN 支持 https，http 会被混合内容拦截）
        images = [self._normalize_url(u) for u in (detail.get("images") or []) if u]
        # 视频源：https 化
        video = detail.get("video") or {}
        video_src = self._normalize_url(video.get("url") or "")

        # 图文笔记无封面字段时，用第一张图兜底作为封面
        cover_url = ""
        if images:
            cover_url = images[0]

        return ContentItem(
            platform=self.key,
            kind=kind,
            uid=detail.get("noteId") or note_id,
            title=self._clean(detail.get("title")),
            summary=self._clean(detail.get("desc")),
            cover_url=cover_url,
            page_url=f"https://www.xiaohongshu.com/explore/{note_id}",
            author=Author(
                uid=str(user.get("userId") or ""),
                name=self._clean(user.get("nickname")),
                avatar_url=self._normalize_url(user.get("avatar") or ""),
                homepage=f"https://www.xiaohongshu.com/user/profile/{user.get('userId')}" if user.get("userId") else "",
            ),
            published_at=self._to_timestamp(detail.get("time")),
            view_count=0,  # 小红书笔记不返回播放量，如实展示
            like_count=self._to_int(interact.get("likedCount")),
            comment_count=self._to_int(interact.get("commentCount")),
            favorite_count=self._to_int(interact.get("collectedCount")),
            share_count=self._to_int(interact.get("shareCount")),
            tags=[t.get("name", "") for t in (detail.get("tagList") or []) if t.get("name")][:8],
            extra={
                "note_id": detail.get("noteId") or note_id,
                "xsec_token": xsec_token,
                "note_type": note_type,
                "images": images,
                "video": video_src or None,
                "video_master": self._normalize_url(video.get("masterUrl") or ""),
            },
        )

    # ------------------------------------------------------------ 整页嵌入
    async def fetch_embed_html(
        self, keyword: str, credentials: dict[str, Any] | None = None
    ) -> str:
        """抓取小红书搜索页渲染后的 HTML，做成「静态快照」供 iframe 嵌入。

        实测结论：整页代理（保留脚本）行不通——小红书 SPA 启动时会从我们的
        源（127.0.0.1:8000）调用小红书 API，全部 403（Referer/Origin 校验），
        Vue 接管失败反而把 SSR 已渲染的结果卡片清空成白屏。

        因此做成静态快照：
          1. 保留 SSR 直出的搜索结果卡片（图片/布局/标题完整）
          2. 剥离全部 <script>，不让小红书 JS 接管（避免 403 白屏）
          3. 注入 <base> 与净化样式：隐藏顶部导航/侧边栏/底部菜单，结果铺满
          4. 注入点击拦截：点卡片时在新标签页打开小红书原页（有完整登录态）
        """
        browser = await self._ensure_browser_search()
        html = await browser.fetch_search_html(keyword, credentials)
        if not html:
            return ""

        # 1. 剥离所有 script（含内联与外链），阻止 SPA 接管导致白屏
        html = _SCRIPT_RE.sub("", html)
        html = _SCRIPT_OPEN_RE.sub("", html)

        # 1.5 修复图片 403：SSR 里部分封面是 http://sns-na-i4.xhscdn.com（北美节点），
        #     浏览器按混合内容拦截或该节点防盗链，统一 https 化 + 归一到国内可直连的
        #     sns-webpic-qc 节点。img 的 src 与 srcset 一并处理。
        html = html.replace("http://sns-na-i4.xhscdn.com", "https://sns-webpic-qc.xhscdn.com")
        html = html.replace("http://sns-webpic-qc.xhscdn.com", "https://sns-webpic-qc.xhscdn.com")
        html = html.replace("http://sns-avatar-qc.xhscdn.com", "https://sns-avatar-qc.xhscdn.com")

        # 2. 注入 <base> 让相对路径资源（CSS/图片）正确解析到小红书主站
        base_tag = '<base href="https://www.xiaohongshu.com/">'
        if "<head" in html:
            html = html.replace("<head", "<head>\n" + base_tag, 1)
        else:
            html = base_tag + html

        # 3. 注入净化样式与点击拦截
        cleanup = _XHS_EMBED_CLEANUP
        if "</head>" in html:
            html = html.replace("</head>", cleanup + "</head>", 1)
        else:
            html += cleanup

        return html

    # ------------------------------------------------------------ 登录
    async def start_login(self) -> LoginTicket:
        raise NotImplementedError("小红书登录依赖 X-s 签名体系，当前未接入")

    async def poll_login(self, ticket: LoginTicket) -> LoginResult:
        return LoginResult(status="error", message="小红书登录当前不可用（需签名支持）")

    def extract_credential_uid(self, cookie_map: dict[str, str]) -> str:
        """小红书登录态核心是 web_session，其长度超 64 无法直接作 UID，
        且会随重新登录变化；取 web_session 的 md5 前 16 位作为稳定标识。
        """
        web_session = cookie_map.get("web_session") or ""
        if not web_session:
            return ""
        return hashlib.md5(web_session.encode("utf-8")).hexdigest()[:16]

    async def verify_credentials(self, credentials: dict[str, Any]) -> tuple[bool, str]:
        """校验小红书 Cookie 是否含登录态核心字段。

        小红书搜索接口受 X-s 保护，纯 HTTP 无法做真实的「试搜」连通性校验
        （会像抖音一样被静默风控），因此只做字段级检查，不发起签名请求。
        """
        cookie = (credentials or {}).get("cookie") or {}
        if not cookie:
            return False, "未提供小红书 Cookie"

        has_web_session = bool(cookie.get("web_session"))
        has_a1 = bool(cookie.get("a1"))

        if has_web_session and has_a1:
            return True, "Cookie 完整（含 web_session 与 a1，搜索需走浏览器自动化）"
        if has_web_session:
            return True, (
                "Cookie 含 web_session，但 ⚠ 未发现 a1 等基础标识字段，"
                "建议从浏览器完整复制 Cookie，否则可能被风控拦截"
            )
        return False, (
            "未发现 web_session 登录态字段。请在浏览器登录小红书后，"
            "从请求头完整复制 Cookie 再粘贴"
        )
