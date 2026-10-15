"""抖音浏览器自动化搜索 —— 绕过 a_bogus 签名的唯一可行路径。

背景
------------------------------------------------------------------
抖音 Web 端搜索接口 `/aweme/v1/web/general/search/single/` 需要一个名为
`a_bogus` 的动态签名，该签名由字节的 bdms 安全 SDK（JSVMP 虚拟机混淆）
在真实浏览器环境里计算，绑定了浏览器指纹、请求参数与时间戳。

纯 HTTP 逆向不可行（前面已实测：注入 Cookie 后 status_code=0 但 data 恒空，
即「静默风控」）。因此本模块改用 Playwright 驱动真实 Chromium：

  1. 打开抖音搜索页 `https://www.douyin.com/search/{keyword}`
  2. 页面自身的 JS 会向搜索接口发起请求，浏览器自动为其附带正确的
     a_bogus、TLS 指纹与 Cookie
  3. 我们用 `page.on("response")` 拦截搜索接口的响应，直接解析 JSON
  4. 用户保存的登录 Cookie 注入浏览器上下文，保留登录态

这样完全不需要逆向签名算法，签名由页面 JS 在真实环境里自然生成。

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
import json
import logging
import urllib.parse
from typing import Any

from app.platforms.base import ContentItem

logger = logging.getLogger(__name__)

# 搜索接口的路径片段，用于在 response 流里精确识别目标
_SEARCH_PATH = "/aweme/v1/web/general/search/single/"
_SEARCH_HOME = "https://www.douyin.com/search/"

# 单次搜索最多等待搜索接口返回的秒数
_RESPONSE_TIMEOUT = 20.0
# 页面加载后的滚动轮次，用于触发更多结果。
# 实测：滚到底约 1 轮触发 1 次 single 请求（约 10 条），10 轮可累计 100+ 条。
# 抖音搜索内容普遍充足，这里给足轮次以一次拿满结果，避免「加载更多」的昂贵重复劳动。
_SCROLL_ROUNDS = 12
# 应对间歇性风控：同一次搜索最多尝试几次（新开 page 重试）
_MAX_ATTEMPTS = 3
# 重试之间的递增等待（秒）
_RETRY_DELAY = 2.0
# 单次浏览器搜索的硬性条数上限（与前端 page_size 对齐，避免无限滚动耗时）
_HARD_LIMIT = 60


class BrowserSearchError(RuntimeError):
    """浏览器自动化搜索失败，携带人类可读的指引。"""


class DouyinBrowserSearch:
    """持有 Playwright 浏览器单例，提供 `search()` 作为唯一对外入口。"""

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._context = None
        self._lock = asyncio.Lock()
        self._available = True  # 是否还有尝试价值（首次失败后置 False 避免反复重试）

    # ------------------------------------------------------------------ 生命周期
    async def _ensure_browser(
        self, credentials: dict[str, Any] | None, force_rebuild: bool = False
    ) -> None:
        """惰性启动浏览器并注入登录 Cookie。

        force_rebuild=True 时强制重建 context（丢弃旧 context 重新注入 Cookie）。
        用于应对抖音对同一浏览器指纹反复搜索后的静默风控/登录弹窗——旧 context
        的登录态可能已失效，重建能拿到全新指纹与新鲜会话（与小红书同款机制）。
        """
        if force_rebuild:
            if self._context is not None:
                try:
                    await self._context.close()
                except Exception:  # noqa: BLE001
                    pass
                self._context = None
        # 浏览器可能被外部 kill（内存压力等），仅判断非 None 不够，需检查 is_connected
        browser_alive = False
        if self._browser is not None:
            try:
                browser_alive = self._browser.is_connected()
            except Exception:  # noqa: BLE001 - 老版本 playwright 无此方法
                browser_alive = True
        if not browser_alive:
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
                        "domain": ".douyin.com",
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

    # ------------------------------------------------------------------ 页面弹窗处理
    async def _dismiss_login_dialog(self, page: Any) -> bool:
        """检测并关闭抖音登录弹窗（请输入手机号 / 扫码登录）。

        登录弹窗会以遮罩形式盖住搜索框，导致后续输入交互失败
        （实测：wait_for input 超时的常见元凶）。检测到即尝试点击
        关闭按钮，成功返回 True。风控弹窗（验证码）不在此处理。
        """
        try:
            body_text = await page.evaluate("document.body ? document.body.innerText : ''")
        except Exception:  # noqa: BLE001
            return False
        if not ("请输入手机号" in body_text or "扫码登录" in body_text or "验证码登录" in body_text):
            return False
        # 常见关闭形态：右上角 X（aria-label 关闭 / class 含 close）
        for selector in ('[aria-label="关闭"]', '[class*="close"] button', 'button[class*="close"]'):
            try:
                btn = page.locator(selector).first
                if await btn.is_visible():
                    await btn.click(timeout=2000)
                    await asyncio.sleep(1)
                    logger.info("已关闭抖音登录弹窗（%s）", selector)
                    return True
            except Exception:  # noqa: BLE001 - 换下一个选择器继续
                continue
        # 兜底：Escape 键
        try:
            await page.keyboard.press("Escape")
            await asyncio.sleep(1)
            return True
        except Exception:  # noqa: BLE001
            return False

    async def _wait_search_box(self, page: Any, timeout_ms: int = 10000) -> None:
        """等待搜索框可见；超时前先尝试关闭登录弹窗再等一轮。

        抛 BrowserSearchError 时带明确指引，不再抛裸超时。
        """
        loc = page.locator('input[placeholder*="搜索"]').first
        try:
            await loc.wait_for(state="visible", timeout=timeout_ms)
            return
        except Exception:  # noqa: BLE001
            pass
        # 第一轮超时：很可能被登录弹窗遮挡，尝试关闭后再等一轮
        if await self._dismiss_login_dialog(page):
            try:
                await loc.wait_for(state="visible", timeout=timeout_ms)
                return
            except Exception:  # noqa: BLE001
                pass
        raise BrowserSearchError(
            "抖音搜索页未出现可交互的搜索框。可能原因：登录弹窗未关闭、"
            "会话被风控要求验证、或页面加载异常。建议重新注入有效 Cookie 后重试"
        )

    # ------------------------------------------------------------------ 搜索
    async def search(
        self,
        keyword: str,
        credentials: dict[str, Any] | None = None,
        max_items: int = 20,
    ) -> list[ContentItem]:
        """在真实浏览器里搜索抖音，拦截搜索接口响应并解析。

        :param keyword: 搜索关键词
        :param credentials: 统一凭据结构（含 cookie / cookie_str）
        :param max_items: 期望返回的最大条数（受平台单次返回限制）
        :return: 解析后的内容列表；无结果返回空列表（不抛错）
        """
        if not self._available:
            raise BrowserSearchError("抖音浏览器搜索此前已失败，为避免反复重试已停用")

        async with self._lock:
            try:
                return await self._search_locked(keyword, credentials, max_items)
            except BrowserSearchError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("抖音浏览器搜索异常: %s", exc)
                raise BrowserSearchError(f"抖音浏览器搜索异常: {exc}") from exc

    async def _search_locked(
        self,
        keyword: str,
        credentials: dict[str, Any] | None,
        max_items: int,
    ) -> list[ContentItem]:
        await self._ensure_browser(credentials)

        # 抖音对 headless 自动化存在间歇性风控（随机不触发搜索请求 / 返回空体），
        # 因此做多次尝试：同一浏览器上下文内新建 page 重试，而非重启浏览器。
        # 但验证码（BrowserSearchError 含「验证码」）重试无益，应立即抛出让用户知晓。
        last_error: str = ""
        for attempt in range(_MAX_ATTEMPTS):
            try:
                items = await self._search_once(keyword, max_items)
                if items:
                    return items
                last_error = "未捕获到结果（可能被风控）"
            except BrowserSearchError as exc:
                # 验证码等明确不可自动解决的错误：不重试，直接抛出
                raise exc
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
            logger.info("抖音浏览器搜索第 %s 次尝试失败（keyword=%s）: %s", attempt + 1, keyword, last_error)
            await asyncio.sleep(_RETRY_DELAY * (attempt + 1))

        logger.warning("抖音浏览器搜索「%s」连续 %s 次失败: %s", keyword, _MAX_ATTEMPTS, last_error)
        return []

    async def _search_once(self, keyword: str, max_items: int) -> list[ContentItem]:
        """单次搜索：开新页 -> 输入关键词触发搜索 -> 拦截 single 接口响应。

        注意：Playwright 的 `page.on("response")` 期望同步回调，
        在 async 回调里 `await response.body()` 会因事件循环调度而拿不到数据。
        因此这里只在回调里**同步收集 response 对象**，待主流程统一 await body。

        关键：抖音对敏感词 / 高频自动化会弹出滑块验证码（#captcha_container），
        其遮罩会拦截搜索框点击，导致 Locator.click 反复重试、超时 30 秒才放弃。
        故在交互前先探测验证码，命中则**立即抛错**，绝不傻等超时。
        """
        page = await self._context.new_page()
        responses: list[Any] = []

        def on_response(response) -> None:  # noqa: ANN001 - 必须是同步回调
            if _SEARCH_PATH in response.url:
                responses.append(response)

        page.on("response", on_response)

        captured: list[dict[str, Any]] = []
        try:
            url = _SEARCH_HOME + urllib.parse.quote(keyword)
            await page.goto(url, wait_until="load", timeout=40000)
            await asyncio.sleep(6)

            # 交互前先探测验证码遮罩；命中则快速失败，避免 30 秒点击超时的漫长等待
            try:
                captcha_visible = await page.locator("#captcha_container").is_visible()
            except Exception:  # noqa: BLE001
                captcha_visible = False
            if captcha_visible:
                raise BrowserSearchError(
                    f"抖音对关键词「{keyword}」触发了滑块验证码，"
                    "当前无法自动通过，请稍后或更换关键词重试"
                )

            # 关键：必须在搜索框里输入关键词并回车，搜索接口才会发出。
            # 仅 goto 带关键词的 URL 并不会自动触发 single 接口。
            # 等待前先处理可能出现的登录弹窗（遮罩会导致可见性判定失败）。
            await self._dismiss_login_dialog(page)
            await self._wait_search_box(page)
            loc = page.locator('input[placeholder*="搜索"]').first
            await loc.click(timeout=5000)
            await asyncio.sleep(1)
            await loc.fill(keyword)
            await asyncio.sleep(1.5)
            await loc.press("Enter")

            # 滚动加载更多：抖音搜索页是懒加载，需滚到接近底部才触发下一页 single 请求。
            # 固定滚 N 次不可靠（前几次常是页面初始的重复请求，且滚动深度不够触发分页），
            # 改为「滚到底 → 等待新请求」循环，直到收集到足够条数或达到最大滚动轮次。
            for _ in range(_SCROLL_ROUNDS):
                # 用 JS 直接滚到底部，确保触发懒加载（wheel 滚动深度不够，分页请求不发）
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(1.8)

            # 缓冲，确保最后一轮滚动触发的响应回调已收集完毕
            await asyncio.sleep(2)

            # 关键：必须在 page.close() 之前 await body，否则 body 会失效
            for response in responses:
                try:
                    raw = await response.body()
                    body = json.loads(raw)
                except Exception:  # noqa: BLE001 - 空体 / 非 JSON 跳过
                    continue
                status = body.get("status_code", -1)
                data = body.get("data") or []
                if status == 0 and data:
                    captured.extend(data if isinstance(data, list) else [data])
        finally:
            await page.close()

        if not captured:
            return []
        return self._parse(captured, min(max_items, _HARD_LIMIT))

    # ------------------------------------------------------------------ 搜索页整页抓取
    async def fetch_search_html(
        self,
        keyword: str,
        credentials: dict[str, Any] | None = None,
    ) -> str:
        """在真实浏览器里打开抖音搜索页，返回渲染后的完整 HTML。

        供「整页嵌入」方案使用：把抖音官方搜索页原样搬到 iframe 里，
        让用户直接看到平台原生搜索结果，点击视频由抖音自己的页面渲染详情，
        从而绕开「自建详情被 a_bogus 风控」的问题。

        与小红书的关键差异：抖音搜索页关键词在 URL path（/search/{keyword}），
        且仅 goto 不会自动发起搜索，必须在搜索框输入关键词 + 回车。

        :return: 渲染后的 HTML 字符串；失败返回空串
        """
        if not self._available:
            raise BrowserSearchError("抖音浏览器搜索此前已失败，为避免反复重试已停用")

        async with self._lock:
            # 抖音对常驻指纹有静默风控：第一次失败后重建 context 换新指纹再试一次
            # （验证码错误不重试——重试无益，直接抛出让用户知晓）。
            last_error: Exception | None = None
            for attempt in range(2):
                try:
                    return await self._fetch_search_html_locked(keyword, credentials)
                except BrowserSearchError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    logger.warning(
                        "抖音搜索页抓取第 %s 次失败（keyword=%s）: %s", attempt + 1, keyword, exc
                    )
                    if attempt == 0:
                        logger.info("重建浏览器 context 以应对风控（keyword=%s）", keyword)
                        await self._ensure_browser(credentials, force_rebuild=True)
                        await asyncio.sleep(_RETRY_DELAY)
            logger.exception("抖音搜索页抓取异常: %s", last_error)
            raise BrowserSearchError(f"抖音搜索页抓取异常: {last_error}") from last_error

    async def _fetch_search_html_locked(
        self,
        keyword: str,
        credentials: dict[str, Any] | None,
    ) -> str:
        await self._ensure_browser(credentials)

        page = await self._context.new_page()
        try:
            url = _SEARCH_HOME + urllib.parse.quote(keyword)
            await page.goto(url, wait_until="load", timeout=40000)
            await asyncio.sleep(6)

            # 交互前先探测验证码遮罩；命中则快速失败
            try:
                captcha_visible = await page.locator("#captcha_container").is_visible()
            except Exception:  # noqa: BLE001
                captcha_visible = False
            if captcha_visible:
                raise BrowserSearchError(
                    f"抖音对关键词「{keyword}」触发了滑块验证码，"
                    "当前无法自动通过，请稍后或更换关键词重试"
                )

            # 关键：必须在搜索框里输入关键词并回车，搜索接口才会发出。
            # 仅 goto 带关键词的 URL 并不会自动触发搜索。
            # 等待前先处理可能出现的登录弹窗（遮罩会导致可见性判定失败）。
            await self._dismiss_login_dialog(page)
            await self._wait_search_box(page)
            loc = page.locator('input[placeholder*="搜索"]').first
            await loc.click(timeout=5000)
            await asyncio.sleep(1)
            await loc.fill(keyword)
            await asyncio.sleep(1.5)
            await loc.press("Enter")

            # 等待结果渲染出来。抖音搜索结果卡片是 div#waterfall_item_{aweme_id}
            # （SSR 直出，非 <a href>），等待其出现即说明搜索有结果。
            try:
                await page.wait_for_selector(
                    '[id^="waterfall_item_"]', timeout=_RESPONSE_TIMEOUT * 1000
                )
            except Exception:  # noqa: BLE001 - 无结果/风控时卡片不出现
                logger.info("抖音搜索页未出现结果卡片（keyword=%s）", keyword)

            # 给结果稳定一点时间
            await asyncio.sleep(3)

            html = await page.content()
            return html
        finally:
            await page.close()

    # ------------------------------------------------------------------ 解析
    def _parse(self, captured: list[dict[str, Any]], max_items: int) -> list[ContentItem]:
        """把捕获的搜索接口 data 压平为 ContentItem 列表。

        single 接口的 data 是 `[{type:1, aweme_info:{...}}, ...]`，
        aweme_info 才是视频对象本体。
        """
        from app.platforms.douyin.adapter import DouyinAdapter

        adapter = DouyinAdapter()
        items: list[ContentItem] = []
        seen: set[str] = set()
        for entry in captured:
            if not isinstance(entry, dict):
                continue
            # 兼容两种包裹形态：aweme_info 直挂 / aweme_list 列表
            aweme = entry.get("aweme_info") or entry.get("aweme_mix_info")
            if isinstance(aweme, dict):
                item = adapter._aweme_to_item(aweme)
                if item and item.uid not in seen:
                    seen.add(item.uid)
                    items.append(item)
            else:
                for sub in entry.get("aweme_list") or []:
                    item = adapter._aweme_to_item(sub)
                    if item and item.uid not in seen:
                        seen.add(item.uid)
                        items.append(item)
            if len(items) >= max_items:
                break
        return items

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
