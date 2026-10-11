"""去重与多样性模块。

搜索聚合最容易犯的病：
  - 同一条内容在两路召回里重复出现（ID 不同但内容一致）
  - 搬运号把原视频换个标题重发，占满整页
  - 某个高产 UP 主一次性刷屏五条，挤占其他创作者的位置

本模块依次解决：精确去重 -> 模糊去重 -> 作者多样性配额。
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from difflib import SequenceMatcher
from typing import Iterable

from app.platforms.base import ContentItem

logger = logging.getLogger(__name__)

# 标题相似度阈值，超过即认定为重复内容。
# 取值偏高是为了避免误伤：连载番剧「第1集 / 第2集」的序列比对可达 0.86，
# 若阈值过低会把整季连载当成一条内容砍掉。
SIMILARITY_THRESHOLD = 0.90
# 同一作者在同一页内最多保留的条数。
# 取值放宽的原因（踩过坑）：番剧连载 / 系列教程场景下一个 UP 主往往承包整季内容，
# 用户搜索时想看的就是这些。配额设小会直接导致「加了筛选反而结果骤减」
# ——实测搜索「美国老爹」时输出可从 60 条暴跌到 19 条。
# 现在仅保留一个极大值作为「单一 UP 主刷屏刷爆整页」的极端兜底。
MAX_PER_AUTHOR = 50

_DIGIT_RE = re.compile(r"\d+")


def _strip_digits(text: str) -> str:
    """抹去标题中的所有数字，用于识别「同系列不同集数」。"""
    return _DIGIT_RE.sub("#", text)


def is_duplicate_pair(a: str, b: str) -> bool:
    """判定两个标题指纹是否代表同一内容。

    豁免规则：若两标题仅在数字编号上不同（如「第1集」vs「第2集」、
    「EP01」vs「EP02」），则视为**不同内容**予以保留 ——
    这类差异正是连载番剧的正常形态，而非搬运刷屏。
    """
    if not a or not b:
        return False
    if a == b:
        return True

    # 位数不同的连续编号 -> 豁免
    bare_a, bare_b = _strip_digits(a), _strip_digits(b)
    if bare_a == bare_b and a != b:
        return False

    return similarity(a, b) >= SIMILARITY_THRESHOLD


def _title_key(title: str) -> str:
    """去除标点与噪声词后的标题指纹。"""
    import re

    cleaned = re.sub(r"[\s\W_]+", "", title.lower())
    noise = {"合集", "全集", "完整版", "高清", "纯净版", "官方"}
    for word in noise:
        cleaned = cleaned.replace(word, "")
    return cleaned


def similarity(a: str, b: str) -> float:
    """综合序列比对与二元组重合度的标题相似度。"""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    seq = SequenceMatcher(None, a, b).ratio()

    def bigrams(text: str) -> set[str]:
        return {text[i : i + 2] for i in range(len(text) - 1)} or {text}

    bg_a, bg_b = bigrams(a), bigrams(b)
    jaccard = len(bg_a & bg_b) / max(len(bg_a | bg_b), 1)

    # 取较强信号，避免长标题因序列比对吃亏
    return max(seq, jaccard * 0.95)


def dedup_items(items: Iterable[ContentItem]) -> tuple[list[ContentItem], int]:
    """执行完整去重流水线。

    返回 (保留列表, 剔除数量)。
    调用前请保证 items 已打分并按分数降序排列 —— 保留的总是高分者。
    """
    ordered = list(items)

    # 阶段 1：唯一键精确去重
    seen: dict[str, ContentItem] = {}
    stage1: list[ContentItem] = []
    for item in ordered:
        key = item.unique_key
        if key in seen:
            continue
        seen[key] = item
        stage1.append(item)

    # 阶段 2：标题模糊去重
    stage2: list[ContentItem] = []
    removed = len(ordered) - len(stage1)
    fingerprints: list[str] = []
    for item in stage1:
        fp = _title_key(item.title)
        if any(is_duplicate_pair(fp, existing) for existing in fingerprints):
            removed += 1
            continue
        fingerprints.append(fp)
        stage2.append(item)

    # 阶段 3：作者多样性配额
    author_counter: defaultdict[str, int] = defaultdict(int)
    stage3: list[ContentItem] = []
    for item in stage2:
        author_key = item.author.uid or item.author.name
        if author_key and author_counter[author_key] >= MAX_PER_AUTHOR:
            removed += 1
            continue
        if author_key:
            author_counter[author_key] += 1
        stage3.append(item)

    if removed:
        logger.info("去重流水线剔除 %s 条，剩余 %s 条", removed, len(stage3))
    return stage3, removed
