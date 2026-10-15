"""小红书浏览器自动化搜索 —— 绕过 X-s / X-t 签名的可行路径。

背景
------------------------------------------------------------------
小红书 Web 端搜索接口 `/api/sns/web/v1/search/notes` 需要一个名为
`X-s`（配套 `X-t`）的动态签名，由小红书自研的 JSVMP 混淆 SDK 在真实浏览器里
计算，绑定了浏览器指纹、请求参数与时间戳。纯 HTTP 逆向不可行（与抖音的
`a_bogus` 同为 JSVMP 级别难度，且存在静默风控）。

因此本模块复用抖音已验证的 Playwright 方案：

  1. 打开小红书搜索页 `https://www.xiaohongshu.com/search_result?keyword={keyword}`
  2. 页面自身的 JS 会向搜索接口发起请求，浏览器自动为其附带正确的
     X-s、X-t、TLS 指纹与 Cookie
  3. 我们用 `page.on("response")` 拦截搜索接口的响应，直接解析 JSON
  4. 用户保存的登录 Cookie 注入浏览器上下文，保留登录态

设计约束
------------------------------------------------------------------
- 单例浏览器：Chromium 启动开销约 1~2s，绝不能每次搜索都重启进程。
- 串行化：Playwright 的 page 操作非线程安全，且搜索是重操作，用 asyncio.Lock
  串行执行，避免并发搜索相互踩踏。
- 惰性启动：首次搜索时才拉起浏览器；失败时给出明确错误，不伪造结果。
- 诚实降级：若浏览器不可用（未装 Chromium / 环境不支持），抛出带指引的异常。
"""

from __future__ import annotations

import asyncio
import logging
import urllib.parse
from typing import Any

from app.platforms.base import ContentItem

logger = logging.getLogger(__name__)

# 搜索接口的路径片段，用于在 response 流里精确识别目标。
# 小红书 Web API 实际域名为 so.xiaohongshu.com（搜索）与 edith.xiaohongshu.com（其他）。
# 注意：搜索接口版本是 v2，而非其他接口的 v1。
_SEARCH_PATH = "/api/sns/web/v2/search/notes"
_SEARCH_HOME = "https://www.xiaohongshu.com/search_result"

# 页面加载后的滚动轮次，用于触发更多结果。
_XHS_SCROLL_ROUNDS = 10
# 应对间歇性风控：同一次搜索最多尝试几次（新开 page 重试）
_XHS_MAX_ATTEMPTS = 3
# 重试之间的递增等待（秒）
_XHS_RETRY_DELAY = 2.0
# 单次浏览器搜索的硬性条数上限
_XHS_HARD_LIMIT = 60
# 页面加载 / 滚动等待时间
_XHS_GOTO_TIMEOUT = 40000
_XHS_INITIAL_WAIT = 5.0
_XHS_SCROLL_WAIT = 1.8
_XHS_FINAL_WAIT = 2.0
# 详情页 noteDetailMap 轮询就绪的最长等待时间（秒）
_XHS_DETAIL_MAX_WAIT = 15.0


class BrowserSearchError(RuntimeError):
    """浏览器自动化搜索失败，携带人类可读的指引。"""


class XiaohongshuBrowserSearch:
    """持有 Playwright 浏览器单例，提供 `search()` 作为唯一对外入口。"""

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._context = None
        self._lock = asyncio.Lock()
        self._available = True  # 首次失败后置 False，避免反复重试

    # ------------------------------------------------------------------ 生命周期
    async def _ensure_browser(
        self, credentials: dict[str, Any] | None, force_rebuild: bool = False
    ) -> None:
        """惰性启动浏览器并注入登录 Cookie。

        force_rebuild=True 时强制重建 context（丢弃旧 context 重新注入 Cookie）。
        用于应对小红书对同一浏览器指纹反复搜索后的静默风控——旧 context 的登录态
        可能已失效，重建能拿到全新指纹与新鲜会话。
        """
        if force_rebuild:
            if self._context is not None:
                try:
                    await self._context.close()
                except Exception:  # noqa: BLE001
                    pass
                self._context = None

        # 关键：浏览器/context 可能被外部 kill（内存压力、其他进程），
        # 仅判断「非 None」不够，必须检查 is_connected()，否则 new_page 会抛
        # "Target page, context or browser has been closed" 且不自愈。
        browser_alive = False
        if self._browser is not None:
            try:
                # is_connected() 返回 True 表示浏览器仍连接可用
                browser_alive = self._browser.is_connected()
            except Exception:  # noqa: BLE001 - 老版本 playwright 无此方法
                browser_alive = True  # 无法探测时保守视为可用，走正常流程
        if not browser_alive:
            # 浏览器已断开，清理引用准备重建
            self._browser = None
            self._context = None
            if self._pw is not None:
                try:
                    await self._pw.stop()
                except Exception:  # noqa: BLE001
                    pass
                self._pw = None

        if self._browser is not None and self._context is not None:
            return

        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:  # pragma: no cover
            raise BrowserSearchError(
                "未安装 playwright。请执行 pip install playwright && playwright install chromium"
            ) from exc

        if self._pw is None:
            self._pw = await async_playwright().start()

        if self._browser is None:
            try:
                self._browser = await self._pw.chromium.launch(
                    headless=True,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                    ],
                )
            except Exception as exc:  # noqa: BLE001
                raise BrowserSearchError(
                    f"启动 Chromium 失败（可能是浏览器未下载）：{exc}。"
                    "请执行 playwright install chromium"
                ) from exc

        self._context = await self._browser.new_context(
            viewport={"width": 1440, "height": 900},
            locale="zh-CN",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0.0.0 Safari/537.36"
            ),
        )

        # 注入用户保存的登录 Cookie（若有），保留登录态
        cookie_map = self._extract_cookie_map(credentials)
        if cookie_map:
            cookies = []
            for name, value in cookie_map.items():
                if not value:
                    continue
                cookies.append(
                    {
                        "name": name,
                        "value": value,
                        "domain": ".xiaohongshu.com",
                        "path": "/",
                    }
                )
            if cookies:
                await self._context.add_cookies(cookies)

    @staticmethod
    def _extract_cookie_map(credentials: dict[str, Any] | None) -> dict[str, str]:
        """从统一凭据结构里抽出 Cookie 字典。"""
        if not credentials:
            return {}
        cookie_map = dict(credentials.get("cookie") or {})
        raw = credentials.get("cookie_str")
        if raw:
            for part in str(raw).replace("\n", ";").split(";"):
                part = part.strip()
                if not part or "=" not in part:
                    continue
                name, value = part.split("=", 1)
                cookie_map[name.strip()] = value.strip()
        return cookie_map

    # ------------------------------------------------------------------ 搜索
    async def search(
        self,
        keyword: str,
        credentials: dict[str, Any] | None = None,
        max_items: int = 20,
    ) -> list[ContentItem]:
        """在真实浏览器里搜索小红书，拦截搜索接口响应并解析。

        :param keyword: 搜索关键词
        :param credentials: 统一凭据结构（含 cookie / cookie_str）
        :param max_items: 期望返回的最大条数（受平台单次返回限制）
        :return: 解析后的内容列表；无结果返回空列表（不抛错）
        """
        if not self._available:
            raise BrowserSearchError("小红书浏览器搜索此前已失败，为避免反复重试已停用")

        async with self._lock:
            try:
                return await self._search_locked(keyword, credentials, max_items)
            except BrowserSearchError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("小红书浏览器搜索异常: %s", exc)
                raise BrowserSearchError(f"小红书浏览器搜索异常: {exc}") from exc

    async def _search_locked(
        self,
        keyword: str,
        credentials: dict[str, Any] | None,
        max_items: int,
    ) -> list[ContentItem]:
        await self._ensure_browser(credentials)

        last_error: str = ""
        for attempt in range(_XHS_MAX_ATTEMPTS):
            try:
                items = await self._search_once(keyword, max_items)
                if items:
                    return items
                last_error = "未捕获到结果（可能被风控）"
            except BrowserSearchError as exc:
                raise exc
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                # 浏览器被外部关闭（如内存压力 kill）时，强制重建后重试
                if "browser has been closed" in last_error or "has been closed" in last_error:
                    logger.warning("小红书浏览器已断开，尝试重建（keyword=%s）", keyword)
                    await self._ensure_browser(credentials, force_rebuild=True)
            logger.info(
                "小红书浏览器搜索第 %s 次尝试失败（keyword=%s）: %s",
                attempt + 1, keyword, last_error,
            )
            # 关键：常驻进程反复搜索后，同一浏览器指纹会被小红书静默风控，
            # 旧 context 的登录态失效，导致「未捕获到结果」。重建 context
            # 换新指纹 + 重新注入 Cookie，往往能恢复。
            if attempt < _XHS_MAX_ATTEMPTS - 1:
                logger.info("重建浏览器 context 以应对风控（keyword=%s）", keyword)
                await self._ensure_browser(credentials, force_rebuild=True)
            await asyncio.sleep(_XHS_RETRY_DELAY * (attempt + 1))

        logger.warning("小红书浏览器搜索「%s」连续 %s 次失败: %s", keyword, _XHS_MAX_ATTEMPTS, last_error)
        return []

    async def _search_once(self, keyword: str, max_items: int) -> list[ContentItem]:
        """单次搜索：开新页 -> 进入搜索结果页 -> 拦截 search/notes 接口响应。

        小红书搜索结果页是 SSR 直出，进入 `search_result?keyword=...` 后页面 JS
        会自动发起 search/notes 请求，无需像抖音那样再在搜索框输入。滚动加载
        会触发后续分页请求，这里收集所有 search/notes 响应并合并解析。
        """
        page = await self._context.new_page()
        responses: list[Any] = []

        def on_response(response) -> None:  # noqa: ANN001 - 必须是同步回调
            if _SEARCH_PATH in response.url:
                responses.append(response)

        page.on("response", on_response)

        captured: list[dict[str, Any]] = []
        try:
            url = _SEARCH_HOME + "?keyword=" + urllib.parse.quote(keyword)
            await page.goto(url, wait_until="load", timeout=_XHS_GOTO_TIMEOUT)
            await asyncio.sleep(_XHS_INITIAL_WAIT)

            # 关键：小红书搜索强制登录，未登录直接弹登录墙。
            # 登录墙下搜索请求不会发出，重试无益，必须快速失败并给明确指引。
            body_text = ""
            try:
                body_text = await page.evaluate("document.body ? document.body.innerText : ''")
            except Exception:  # noqa: BLE001
                body_text = ""
            if "登录后查看搜索结果" in body_text:
                raise BrowserSearchError(
                    "小红书要求登录后才能查看搜索结果。"
                    "请在浏览器登录小红书后，从请求头复制完整 Cookie，"
                    "通过「注入 Cookie」保存到本机后再搜索"
                )

            # 滚动加载更多（懒加载分页）
            for _ in range(_XHS_SCROLL_ROUNDS):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(_XHS_SCROLL_WAIT)

            await asyncio.sleep(_XHS_FINAL_WAIT)

            # 关键：必须在 page.close() 之前 await body，否则 body 会失效
            for response in responses:
                try:
                    body = await response.json()
                except Exception:  # noqa: BLE001 - 空体 / 非 JSON 跳过
                    continue
                if not isinstance(body, dict):
                    continue
                success = body.get("success")
                # search/notes 成功时 success=True 且 data.items 为列表
                items = (body.get("data") or {}).get("items")
                if success and isinstance(items, list) and items:
                    logger.info("小红书捕获 search/notes 响应 %d 条", len(items))
                    captured.extend(items)
        finally:
            await page.close()

        if not captured:
            return []
        return self._parse(captured, min(max_items, _XHS_HARD_LIMIT))

    # ------------------------------------------------------------------ 解析
    def _parse(self, captured: list[dict[str, Any]], max_items: int) -> list[ContentItem]:
        """把捕获的 search/notes items 压平为 ContentItem 列表。

        兼容两种包裹形态：`note_card` 内包 / 字段直铺。
        """
        from app.platforms.xiaohongshu.adapter import XiaohongshuAdapter

        adapter = XiaohongshuAdapter()
        items: list[ContentItem] = []
        seen: set[str] = set()
        for entry in captured:
            if not isinstance(entry, dict):
                continue
            # search/notes 的 items 里会混入非笔记条目（如 model_type="hot_query" 搜索词推荐），
            # 它们没有 note_card，必须过滤掉，只处理真正的笔记。
            if entry.get("model_type") != "note":
                continue
            # 传入完整 entry（含顶层 id 与 note_card），让 _note_to_item 取到真正的笔记 ID
            item = adapter._note_to_item(entry)
            if item and item.uid not in seen:
                seen.add(item.uid)
                items.append(item)
            if len(items) >= max_items:
                break
        logger.info("小红书解析出 %d 条有效笔记（原始 %d 条）", len(items), len(captured))
        return items

    # ------------------------------------------------------------------ 详情
    async def fetch_detail(
        self,
        note_id: str,
        xsec_token: str = "",
        credentials: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """在真实浏览器里打开笔记详情页，从 SSR 的 __INITIAL_STATE__ 提取详情。

        小红书笔记详情数据由 SSR 直出（`__INITIAL_STATE__.note.noteDetailMap[note_id].note`），
        但**必须携带 xsec_token** 才能渲染出真实数据，否则 note 为空对象。

        :return: 笔记详情 dict；未捕获到返回 None
        """
        if not self._available:
            raise BrowserSearchError("小红书浏览器搜索此前已失败，为避免反复重试已停用")

        async with self._lock:
            try:
                return await self._fetch_detail_locked(note_id, xsec_token, credentials)
            except BrowserSearchError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("小红书浏览器详情抓取异常: %s", exc)
                raise BrowserSearchError(f"小红书浏览器详情抓取异常: {exc}") from exc

    async def _fetch_detail_locked(
        self,
        note_id: str,
        xsec_token: str,
        credentials: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        await self._ensure_browser(credentials)

        page = await self._context.new_page()
        # 验证码风控探测：详情页（尤其视频笔记）会触发 redcaptcha，
        # 此时数据永远不会加载，轮询无意义，必须快速失败。
        captcha_seen: list[str] = []

        def _on_captcha(response: Any) -> None:  # 同步回调
            if "redcaptcha" in response.url:
                captcha_seen.append(response.url)

        page.on("response", _on_captcha)

        # 用 JS 提取详情，避免整体序列化 __INITIAL_STATE__（对象引用链过长）
        extract_js = """
        (noteId) => {
          const s = window.__INITIAL_STATE__ || {};
          const m = (s.note || {}).noteDetailMap || {};
          const entry = m[noteId] || {};
          const n = entry.note || {};
          if (!n || !n.noteId && !n.title) return null;
          return {
            noteId: n.noteId || noteId,
            title: n.title || '',
            desc: n.desc || '',
            type: n.type || '',
            time: n.time || n.lastUpdateTime || null,
            user: n.user ? {
              userId: n.user.userId || n.user.user_id || n.user.id || '',
              nickname: n.user.nickname || n.user.nickName || n.user.nick_name || '',
              avatar: n.user.avatar || '',
            } : null,
            interactInfo: n.interactInfo ? {
              likedCount: n.interactInfo.likedCount || n.interactInfo.liked_count || 0,
              collectedCount: n.interactInfo.collectedCount || n.interactInfo.collected_count || 0,
              commentCount: n.interactInfo.commentCount || n.interactInfo.comment_count || 0,
              shareCount: n.interactInfo.shareCount || n.interactInfo.share_count || 0,
            } : null,
            tagList: (n.tagList || []).map(t => ({ name: t.name || '' })).filter(t => t.name),
            // 图片列表：取每张图的高清原图 urlDefault（缺失时回退 infoList 里的 url）
            images: (n.imageList || []).map(im => {
              const src = (im && (im.urlDefault || im.urlPre)) || '';
              if (src) return src;
              const info = (im && im.infoList) || [];
              for (let i = info.length - 1; i >= 0; i--) {
                if (info[i] && info[i].url) return info[i].url;
              }
              return '';
            }).filter(Boolean),
            // 视频源：优先 h264 最高清，回退 h265 / av1 / masterUrl
            video: n.video ? (() => {
              const v = n.video;
              const media = v.media || {};
              const stream = media.stream || {};
              const h264 = stream.h264 || [];
              const h265 = stream.h265 || [];
              const av1 = stream.av1 || [];
              let src = '';
              let masterUrl = (stream.masterUrl) || '';
              const pick = (arr) => {
                // stream 数组里 url 越靠前通常越清晰（或最后一个为最高清），取第一个非空
                for (const s of arr) {
                  if (s && s.masterUrl) masterUrl = masterUrl || s.masterUrl;
                  if (s && s.backupUrls && s.backupUrls.length) {
                    if (!src) src = s.backupUrls[0];
                  }
                  if (s && s.url && !src) src = s.url;
                }
              };
              pick(h264); if (!src) pick(h265); if (!src) pick(av1);
              return { url: src, masterUrl: masterUrl, cover: v.image || null };
            })() : null,
          };
        }
        """

        try:
            # 关键：必须带 xsec_token，否则详情数据为空
            if xsec_token:
                url = (
                    "https://www.xiaohongshu.com/explore/%s?xsec_token=%s&xsec_source=pc_search"
                    % (note_id, xsec_token)
                )
            else:
                url = "https://www.xiaohongshu.com/explore/" + note_id

            await page.goto(url, wait_until="load", timeout=_XHS_GOTO_TIMEOUT)

            # 详情数据（__INITIAL_STATE__.note.noteDetailMap）由客户端 JS 异步填充，
            # 固定 sleep 不可靠：负载高或被风控时会偶发拿到空对象。
            # 改为轮询等待 noteDetailMap 就绪，最多等 _XHS_DETAIL_MAX_WAIT 秒。
            result: dict[str, Any] | None = None
            deadline = asyncio.get_event_loop().time() + _XHS_DETAIL_MAX_WAIT
            while True:
                # 验证码已触发：数据不会再来，立即放弃（返回 None 交由前端降级）
                if captcha_seen:
                    logger.info("小红书详情页触发验证码风控（note_id=%s）", note_id)
                    return None
                result = await page.evaluate(extract_js, note_id)
                # 就绪判定：必须有标题，且（图文笔记要有图片 / 视频笔记要有视频源）。
                # 标题与互动数据 SSR 直出较快，imageList / video 由客户端 JS 异步填充，
                # 若只看 title 就 break 会拿到「有标题但图片列表为空」的半成品。
                if result and result.get("title"):
                    is_video = result.get("type") == "video"
                    if is_video:
                        if (result.get("video") or {}).get("url"):
                            break
                    elif result.get("images"):
                        break
                if asyncio.get_event_loop().time() >= deadline:
                    break
                await asyncio.sleep(0.8)
            return result
        finally:
            await page.close()

    # ------------------------------------------------------------------ 搜索页整页抓取
    async def fetch_search_html(
        self,
        keyword: str,
        credentials: dict[str, Any] | None = None,
    ) -> str:
        """在真实浏览器里打开小红书搜索页，返回渲染后的完整 HTML。

        供「整页代理」方案使用：把小红书官方搜索页原样搬到 iframe 里，
        让用户直接看到平台原生搜索结果，点击笔记由小红书自己的页面渲染详情，
        从而绕开我们「自建详情」被风控的问题。

        :return: 渲染后的 HTML 字符串；失败返回空串
        """
        if not self._available:
            raise BrowserSearchError("小红书浏览器搜索此前已失败，为避免反复重试已停用")

        async with self._lock:
            try:
                return await self._fetch_search_html_locked(keyword, credentials)
            except BrowserSearchError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("小红书搜索页抓取异常: %s", exc)
                raise BrowserSearchError(f"小红书搜索页抓取异常: {exc}") from exc

    async def _fetch_search_html_locked(
        self,
        keyword: str,
        credentials: dict[str, Any] | None,
    ) -> str:
        await self._ensure_browser(credentials)

        page = await self._context.new_page()
        try:
            url = _SEARCH_HOME + "?keyword=" + urllib.parse.quote(keyword)
            await page.goto(url, wait_until="load", timeout=_XHS_GOTO_TIMEOUT)
            # 等结果卡片渲染出来（a[href*=explore] 出现即说明搜索有结果）
            got_cards = True
            try:
                await page.wait_for_selector(
                    'a[href*="explore"]', timeout=_XHS_DETAIL_MAX_WAIT * 1000
                )
            except Exception:  # noqa: BLE001 - 无结果/风控时卡片不出现
                got_cards = False
                logger.info("小红书搜索页未出现结果卡片（keyword=%s）", keyword)

            # 登录墙 / 扫码验证墙检测：会话被风控时官方会要求 APP 扫码，
            # 此时快照只有二维码，必须明确报错指引重新注入 Cookie，而非静默展示。
            body_text = ""
            try:
                body_text = await page.evaluate(
                    "document.body ? document.body.innerText : ''"
                )
            except Exception:  # noqa: BLE001
                body_text = ""
            if not got_cards and (
                "扫码验证身份" in body_text
                or "请使用已登录账号" in body_text
                or "登录后查看搜索结果" in body_text
            ):
                raise BrowserSearchError(
                    "小红书登录态已被风控，需要重新验证。请在浏览器登录小红书后，"
                    "从请求头复制完整 Cookie，通过「注入 Cookie」重新保存后再搜索"
                )

            # 再给一点时间让图片/懒加载内容稳定
            await asyncio.sleep(_XHS_FINAL_WAIT)
            html = await page.content()
            return html
        finally:
            await page.close()

    # ------------------------------------------------------------------ 清理
    async def aclose(self) -> None:
        """释放浏览器与 Playwright 资源（进程退出时调用）。"""
        if self._context is not None:
            try:
                await self._context.close()
            except Exception:  # noqa: BLE001
                pass
            self._context = None
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception:  # noqa: BLE001
                pass
            self._browser = None
        if self._pw is not None:
            try:
                await self._pw.stop()
            except Exception:  # noqa: BLE001
                pass
            self._pw = None
