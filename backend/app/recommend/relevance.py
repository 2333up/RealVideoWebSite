"""语义指纹：不打乱顺序地剔除跑题内容。

背景
----
平台在按「最多播放 / 最新发布」排序时**不再考虑相关性**，只会把
「标题蹭到关键词子串且数据高」的内容顶上来。典型灾害：

    搜索《美国老爹》→ 吹牛老爹案终于开庭！(257万播放)
                    → FBI突袭！吹牛老爹被捕！(230万播放)

这些是艺人 Diddy 的社会新闻，与动画《美国老爹》毫无关系。

思路
----
平台自身的「综合相关度」排序是对相关性的权威判断。先用它抓一小批种子，
从中提炼该关键词的**内容指纹**（创作者集合 + 高频标签），
再用指纹对其他排序模式的结果做筛选。

因为是**过滤而非重排**，通过筛选的部分仍严格保持平台的原生顺序。
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field

from app.platforms.base import ContentItem, PlatformAdapter, SearchParams

logger = logging.getLogger(__name__)

# 种子抓取页数（仅 1 页即可获得足够信号，成本很低）
SEED_PAGES = 1
# 标签进入指纹所需的最低出现次数，用于滤掉偶发噪声标签
MIN_TAG_FREQ = 2
# 指纹标签上限，防止关键词过泛时退化成「什么都算相关」
MAX_FINGERPRINT_TAGS = 24


@dataclass(slots=True)
class SemanticFingerprint:
    """某个关键词在平台语境下的内容特征。"""

    keyword: str
    authors: set[str] = field(default_factory=set)
    tags: set[str] = field(default_factory=set)
    seed_size: int = 0

    @property
    def is_usable(self) -> bool:
        return bool(self.authors or self.tags)


async def build_fingerprint(
    adapters: list[PlatformAdapter],
    keyword: str,
    credentials_provider=None,
    seed_pages: int = SEED_PAGES,
) -> SemanticFingerprint | None:
    """用「综合相关度」抓一批种子，提炼内容指纹。

    任一路失败不影响其他路；全部失败返回 None，调用方需安全降级（不过滤）。
    """
    fp = SemanticFingerprint(keyword=keyword)
    tag_counter: Counter[str] = Counter()

    async def _seed_one(adapter: PlatformAdapter) -> None:
        creds = None
        if credentials_provider is not None:
            try:
                creds = await credentials_provider(adapter.key)
            except Exception:  # noqa: BLE001 - 凭据问题不应中断种子构建
                creds = None
        # 关键：始终用 relevance（综合相关度）取种，与用户选择的排序无关
        params = SearchParams(
            keyword=keyword,
            page=1,
            pages=seed_pages,
            page_size=60,
            kinds=["video", "article"],
            order="relevance",
        )
        items = await adapter.search(params, creds)
        for item in items:
            if item.author.uid:
                fp.authors.add(item.author.uid)
            elif item.author.name:
                fp.authors.add(item.author.name)
            for tag in item.tags:
                tag_counter[tag.strip().lower()] += 1

    import asyncio

    results = await asyncio.gather(*[_seed_one(a) for a in adapters], return_exceptions=True)
    for adapter, result in zip(adapters, results):
        if isinstance(result, BaseException):
            logger.warning("为 %s 构建语义种子失败: %s", adapter.key, result)

    fp.seed_size = sum(v for v in tag_counter.values())
    fp.tags = {
        tag
        for tag, freq in tag_counter.most_common(MAX_FINGERPRINT_TAGS)
        if freq >= MIN_TAG_FREQ and tag
    }

    if not fp.is_usable:
        return None
    logger.info(
        "语义指纹就绪 keyword=%s 作者=%d 标签=%d", keyword, len(fp.authors), len(fp.tags)
    )
    return fp


def _title_hits(item: ContentItem, keyword: str) -> bool:
    """标题/简介中是否出现完整关键词（而非零散子串）。"""
    haystack = f"{item.title} {item.summary} {' '.join(item.tags)}".lower()
    return keyword.strip().lower() in haystack


def is_relevant(item: ContentItem, fp: SemanticFingerprint) -> bool:
    """判断一条结果是否与指纹相符，任一命中即可。

    三路判据互为补充：
      1. 作者曾在相关种子中出现
      2. 标题/简介/标签包含完整关键词
      3. 携带至少一个种子高频标签（如《美国老爹》的 Stan / AmericanDad）
    """
    author_key = item.author.uid or item.author.name
    if author_key and author_key in fp.authors:
        return True
    if _title_hits(item, fp.keyword):
        return True
    item_tags = {t.strip().lower() for t in item.tags if t and t.strip()}
    return bool(item_tags & fp.tags)


def filter_by_fingerprint(
    items: list[ContentItem], fp: SemanticFingerprint | None
) -> tuple[list[ContentItem], int]:
    """保序过滤：剔除与指纹不符的结果，**其余顺序原封不动**。"""
    if fp is None:
        return list(items), 0
    kept = [item for item in items if is_relevant(item, fp)]
    return kept, len(items) - len(kept)
