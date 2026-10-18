"""agedm（AGE 动漫）数据源客户端。

只做三件事：搜索作品、取作品详情、把「已更新到第几集」解析成话数。

为什么不用 bangumi：本机环境下 bangumi 三条通路全断（直连 DNS 被污染、
会话代理白名单不放行、本机代理未开）。agedm 的移动端接口无需签名、无需代理，
且直接提供 `uptodate` 字段（如「第03集」「第12集(完结)」），
省掉了「按播出日期自行推算已播话数」这一步。

网络约定：`trust_env=False`，代理只来自 settings.AGEDM_PROXY —— 环境里的
HTTP_PROXY 常指向只放行白名单的代理，让 httpx 自动读取会让「配了代理仍失败」
变得难以排查。
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# 「第03集」「第12集(完结)」「01:00 第03集」都能命中；这里只取数字部分
_EPS_RE = re.compile(r"第\s*(\d+)\s*[集话]")
# 详情接口的更新描述会带时间前缀，如「23:00 已完结」；
# 「已完结」本身没有话数，但同一条目里常写「全24集」「共12话」。
_EPS_TOTAL_RE = re.compile(r"(?:全|共)\s*(\d+)\s*[集话]")
# 「更新至第 12 话」这类写法中的数字（部分条目不写「第N集」）
_EPS_BARE_RE = re.compile(r"(?:更新至|更新到|至)\s*(\d+)")


class AgedmError(RuntimeError):
    """agedm 访问失败。文案直接面向使用者，不要吞成空结果。"""


def parse_episode_number(text: str | None) -> int | None:
    """从更新描述里解出话数；解不出返回 None。

    例：
      「第03集」       -> 3
      「第12集(完结)」  -> 12    ← 完结后缀不影响
      「01:00 第03集」  -> 3     ← 详情接口会带时长前缀
      「全24集」        -> 24    ← 已完结条目常这么写
      「23:00 已完结」  -> None  ← 确实没有话数，交由调用方回退到集数列表
      「PV」           -> None
    """
    if not text:
        return None
    m = _EPS_RE.search(text)
    if m:
        return int(m.group(1))
    # 「全24集」「共12话」：已完结条目的话数往往写在这里
    m = _EPS_TOTAL_RE.search(text)
    if m:
        return int(m.group(1))
    # 兜底：部分条目写「更新至 12」
    m = _EPS_BARE_RE.search(text)
    if m:
        return int(m.group(1))
    return None


class AgedmClient:
    """agedm 接口的最小封装。"""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    def _build_kwargs(self) -> dict[str, Any]:
        return {
            "base_url": settings.AGEDM_API_BASE,
            "proxy": settings.AGEDM_PROXY or None,
            "trust_env": False,
            "verify": settings.AGEDM_VERIFY_SSL,
            "timeout": max(settings.HTTP_TIMEOUT, 20.0),
            "follow_redirects": True,
            "headers": {
                "User-Agent": settings.USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://m.agedm.io/",
            },
        }

    async def _ensure(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(**self._build_kwargs())
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def _get_json(self, path: str, **params: Any) -> dict[str, Any]:
        client = await self._ensure()
        try:
            resp = await client.get(path, params=params or None)
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            raise AgedmError(f"访问 AGE 动漫失败：{exc}") from exc
        except ValueError as exc:  # 非 JSON（如被拦截到 HTML 页）
            raise AgedmError("AGE 动漫返回了非预期内容，可能被风控拦截") from exc

        if not isinstance(data, dict):
            raise AgedmError("AGE 动漫返回格式异常")
        code = data.get("code")
        # 接口用 code=200 表示成功；其余情况附上 message 便于定位
        if code not in (200, None):
            raise AgedmError(f"AGE 动漫返回错误：{data.get('message') or code}")
        return data

    # ---------------------------------------------------------- 对外能力

    async def search(self, keyword: str, page: int = 1) -> list[dict[str, Any]]:
        """按名称搜索作品，返回候选列表（归一化后的字段）。"""
        data = await self._get_json("/search", query=keyword, page=max(1, page))
        videos = (data.get("data") or {}).get("videos") or []
        return [self._normalize(v) for v in videos if v.get("id")]

    async def detail(self, subject_id: int) -> dict[str, Any]:
        """取作品详情，含集数列表。"""
        data = await self._get_json(f"/detail/{subject_id}")
        video = data.get("video") or {}
        if not video:
            raise AgedmError(f"未找到作品 {subject_id}")
        # _normalize 已在 uptodate 解析不出时回退到集数列表长度，
        # 这里再补一个「原始集数」供调用方参考
        item = self._normalize(video)
        item["episodes"] = self._episode_count(video)
        return item

    # ---------------------------------------------------------- 归一化

    @staticmethod
    def _normalize(v: dict[str, Any]) -> dict[str, Any]:
        """把接口字段压成前端需要的几个键，避免前端耦合上游命名。

        latest_eps 的口径是「已播出的最新正片话数」：
          1. 优先从 uptodate 解析（「第03集」「全24集」）
          2. 解析不出（如「23:00 已完结」）且有集数列表时，退回列表长度
        搜索接口不返回 playlists，因此搜索候选里这类条目可能仍为 0；
        添加追番时会走详情接口重算，不影响实际追番的准确性。
        """
        uptodate = v.get("uptodate") or ""
        latest = parse_episode_number(uptodate)
        if latest is None:
            latest = AgedmClient._episode_count(v)
        return {
            "subject_id": int(v.get("id") or 0),
            "title": v.get("name") or "",
            "title_original": v.get("name_original") or "",
            "cover_url": v.get("cover") or "",
            "latest_label": uptodate,
            "latest_eps": latest,
            "status": v.get("status") or "",
            "premiere": v.get("premiere") or "",
            "intro": v.get("intro") or "",
        }

    @staticmethod
    def _episode_count(v: dict[str, Any]) -> int:
        """正片集数：取所有播放源里最长的那个集数列表。

        `uptodate` 为「已完结」这类无法解析的写法时，用它作为回退，
        否则「完结番」会被当成 0 集，红点判定随之失真。
        """
        playlists = v.get("playlists") or {}
        best = 0
        for eps in playlists.values():
            if isinstance(eps, list):
                best = max(best, len(eps))
        return best


# 单例：与 adapters 一致，生命周期由 main.py 统一关闭
agedm_client = AgedmClient()