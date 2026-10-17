"""推荐编排服务。

把「多路召回 -> 逐条打分 -> 去重过滤 -> 排序裁剪 -> 产出解释」
编排成一条流水线，并向上暴露统一的调用入口。
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from app.platforms.base import ContentItem, PlatformAdapter, SearchParams
from app.recommend.dedup import dedup_items
from app.recommend.relevance import build_fingerprint, filter_by_fingerprint
from app.recommend.scorer import WEIGHTS, score_item, text_relevance

logger = logging.getLogger(__name__)

# 跑题闸门。默认关闭，理由（重要）：
# 平台自身的搜索结果已是按相关性排好序的，其中大量结果「内容强相关但标题不含关键词」
# ——典型如番剧单集《兰利镇特色父女情深》《圣诞埋尸夜》，它们属于《美国老爹》却在标题里
# 不出现片名。此时用标题文本相似度做过滤，会把这些正主内容与真正的噪声一起误杀
# （二者 relevance 同为 0.0，无法区分）。
# 结论：相关性判定应当信任平台，本服务只负责去重与呈现。
RELEVANCE_GATE_ENABLED = False
RELEVANCE_GATE = 0.20

# 非「综合相关度」排序下是否启用语义指纹去噪（保序，只剔除不重排）
NOISE_FILTER_FOR_ORDERED_MODES = True

# 单路需要抓取的页数。实测 B 站单页固定 20 条，但可翻至 50 页以上且基本无重复，
# 「美国老爹」一路即可拿到数百条。取 8 页（160 条/路）作为速度与数量的平衡点。
# 上限见 bilibili/adapter.py 的 MAX_FETCH_PAGES。
DEFAULT_FETCH_PAGES = 8

# 单条 recommend 最多返回的结果数（防止单次响应过大）
MAX_OUTPUT_SIZE = 100

# 视频与非视频的交错比例。
# 若直接顺序截断，video 一路往往就占满整页，导致图文一条都挤不进来。
INTERLEAVE_RATIO = (3, 1)


def interleave_by_kind(items: list[ContentItem]) -> list[ContentItem]:
    """按 INTERLEAVE_RATIO 把视频与非视频均匀编织，保留各自的原生内部顺序。

    例如比例 (3,1) 表示每 3 条视频穿插 1 条图文，
    任一形态耗尽后剩余部分按原顺序补齐。
    """
    videos = [i for i in items if i.kind == "video"]
    others = [i for i in items if i.kind != "video"]
    if not videos or not others:
        return list(items)

    step_v, step_o = INTERLEAVE_RATIO
    result: list[ContentItem] = []
    vi = oi = 0
    while vi < len(videos) or oi < len(others):
        for _ in range(step_v):
            if vi < len(videos):
                result.append(videos[vi])
                vi += 1
        for _ in range(step_o):
            if oi < len(others):
                result.append(others[oi])
                oi += 1
    return result


@dataclass(slots=True)
class RecommendResult:
    """一次检索的完整产出，含结果本体与统计元信息。"""

    keyword: str
    items: list[ContentItem]
    total_recalled: int = 0
    deduped: int = 0
    platforms: list[str] = field(default_factory=list)
    elapsed_ms: int = 0
    credential_used: bool = False
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "keyword": self.keyword,
            "items": [item_to_dict(i) for i in self.items],
            "total_recalled": self.total_recalled,
            "deduped": self.deduped,
            "platforms": self.platforms,
            "elapsed_ms": self.elapsed_ms,
            "credential_used": self.credential_used,
            "warnings": self.warnings,
            "score_weights": WEIGHTS,
        }


def item_to_dict(item: ContentItem) -> dict[str, Any]:
    """将 ContentItem 序列化为前端友好的 dict。"""
    return {
        "platform": item.platform,
        "kind": item.kind,
        "uid": item.uid,
        "title": item.title,
        "summary": item.summary,
        "cover_url": item.cover_url,
        "page_url": item.page_url,
        "author": {
            "uid": item.author.uid,
            "name": item.author.name,
            "avatar_url": item.author.avatar_url,
            "homepage": item.author.homepage,
        },
        "published_at": item.published_at,
        "duration": item.duration,
        "view_count": item.view_count,
        "like_count": item.like_count,
        "comment_count": item.comment_count,
        "favorite_count": item.favorite_count,
        "coin_count": item.coin_count,
        "share_count": item.share_count,
        "danmaku_count": item.danmaku_count,
        "tags": item.tags,
        "score": item.score,
        "score_detail": item.score_detail,
        "extra": item.extra,
    }


async def recommend(
    *,
    adapters: list[PlatformAdapter],
    keyword: str,
    page: int = 1,
    page_size: int = 20,
    kinds: list[str] | None = None,
    order: str = "relevance",
    duration_min: int | None = None,
    duration_max: int | None = None,
    min_views: int | None = None,
    min_followers: int | None = None,
    credentials_provider=None,
    rerank: bool = False,
    fetch_pages: int = DEFAULT_FETCH_PAGES,
) -> RecommendResult:
    """执行一次多平台聚合推荐。

    :param adapters: 参与检索的平台适配器列表
    :param credentials_provider: 形如 async (platform_key) -> dict | None 的可调用对象
    :param rerank: 是否用五维打分重排。False 时保留平台原生顺序，
        使返回结果与平台网页端观感一致（当前前端默认关闭评分体系，故默认 False）
    :param fetch_pages: 每路内容抓取的页数
    """
    started = time.perf_counter()
    kinds = kinds or ["video", "article"]
    output_size = max(1, min(page_size, MAX_OUTPUT_SIZE))
    # 每路自己的抓取上限要高于最终输出条数，否则多路混合时
    # 排在前面的形态会占满名额，后面的形态一条都进不来。
    per_kind_limit = max(output_size, 40)

    params = SearchParams(
        keyword=keyword,
        page=page,
        pages=fetch_pages,
        page_size=per_kind_limit,
        kinds=kinds,  # type: ignore[arg-type]
        order=order,
        duration_min=duration_min,
        duration_max=duration_max,
        min_views=min_views,
        min_followers=min_followers,
    )

    async def _run(
        adapter: PlatformAdapter,
    ) -> tuple[PlatformAdapter, list[ContentItem], bool, str]:
        """返回 (适配器, 结果, 是否用了登录态, 失败原因)。

        失败原因必须透传：平台被风控拦下时（如抖音返回「请先登录」），
        用户需要看到真实原因，而不是笼统的「未返回结果」。
        """
        creds = None
        if credentials_provider is not None:
            try:
                creds = await credentials_provider(adapter.key)
            except Exception as exc:  # noqa: BLE001 - 凭据异常不应中断检索
                logger.warning("获取 %s 凭据失败: %s", adapter.key, exc)
        try:
            items = await adapter.search(params, creds)
            return adapter, items, bool(creds), ""
        except Exception as exc:  # noqa: BLE001 - 单平台失败需降级而非整体失败
            logger.warning("%s 检索失败: %s", adapter.display_name, exc)
            return adapter, [], bool(creds), str(exc)

    # 多平台并行下探
    results = await asyncio.gather(*[_run(a) for a in adapters])

    recalled: list[ContentItem] = []
    warnings: list[str] = []
    platforms_ok: list[str] = []
    credential_used = False

    for adapter, items, used_cred, failure in results:
        credential_used = credential_used or used_cred
        if not items:
            msg = f"{adapter.display_name} 未返回结果"
            if failure:
                msg += f"（{failure}）"
            warnings.append(msg)
            continue
        platforms_ok.append(adapter.key)
        recalled.extend(items)

    if not recalled:
        elapsed = int((time.perf_counter() - started) * 1000)
        return RecommendResult(
            keyword=keyword,
            items=[],
            total_recalled=0,
            platforms=platforms_ok,
            elapsed_ms=elapsed,
            credential_used=credential_used,
            warnings=warnings or ["所有平台均未返回内容，请检查登录态或稍后重试"],
        )

    # 跑题闸门（默认关闭，见 RELEVANCE_GATE_ENABLED 注释）
    gated = recalled
    off_topic = 0
    if RELEVANCE_GATE_ENABLED:
        gated = [
            item for item in recalled
            if text_relevance(keyword, [item.title, item.summary]) >= RELEVANCE_GATE
        ]
        off_topic = len(recalled) - len(gated)
        if off_topic > 0:
            logger.info("跑题闸门过滤 %s 条弱相关内容", off_topic)

    # 语义指纹保序去噪。
    # 仅在「最多播放 / 最新发布」这类平台不再保证相关性的排序下启用：
    # relevance 模式平台已按相关度排好，无需也不应干预。
    # 过滤只做剔除，通过者的相对顺序原封不动 —— 保持平台原生排序。
    if NOISE_FILTER_FOR_ORDERED_MODES and order not in ("relevance", "", None):
        try:
            fingerprint = await build_fingerprint(adapters, keyword, credentials_provider)
            off_topic = 0
            gated, off_topic = filter_by_fingerprint(gated, fingerprint)
            if off_topic:
                logger.info("语义指纹剔除跑题内容 %s 条（order=%s）", off_topic, order)
        except Exception as exc:  # noqa: BLE001 - 去噪失败必须安全降级，不能让搜索失败
            logger.warning("语义指纹过滤异常，跳过该步骤: %s", exc)

    if not gated:
        elapsed = int((time.perf_counter() - started) * 1000)
        return RecommendResult(
            keyword=keyword, items=[], total_recalled=len(recalled), deduped=off_topic,
            platforms=platforms_ok, elapsed_ms=elapsed,
            credential_used=credential_used,
            warnings=warnings or [f"「{keyword}」在所有结果中与关键词的匹配度均过低"],
        )

    # 可选重排：默认保持平台原生顺序
    processed = gated
    if rerank:
        processed = [score_item(item, keyword) for item in gated]
        processed.sort(key=lambda i: i.score, reverse=True)

    kept, deduped = dedup_items(processed)
    final_items = interleave_by_kind(kept)[:output_size]

    elapsed = int((time.perf_counter() - started) * 1000)
    logger.info(
        "推荐完成 keyword=%s 召回=%s 跑题过滤=%s 去重=%s 输出=%s 重排=%s 耗时=%sms",
        keyword, len(recalled), off_topic, deduped, len(final_items), rerank, elapsed,
    )
    return RecommendResult(
        keyword=keyword,
        items=final_items,
        total_recalled=len(recalled),
        deduped=deduped + off_topic,
        platforms=platforms_ok,
        elapsed_ms=elapsed,
        credential_used=credential_used,
        warnings=warnings,
    )
