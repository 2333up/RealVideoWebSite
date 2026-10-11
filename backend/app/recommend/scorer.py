"""多维质量打分器。

核心理念：播放量高 ≠ 值得推荐。真正该被推到前面的内容，
要在「相关性、互动质量、热度、时效性、完播友好度」五个维度综合胜出。

打分全程可解释 —— score_detail 会告诉你每一分从何而来，
前端即可展示「为什么推荐这条」。
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass
from typing import Iterable

from app.platforms.base import ContentItem

# ----------------------------- 权重配置（可按需调优）
WEIGHTS: dict[str, float] = {
    "relevance": 0.32,   # 与搜索词的相关程度
    "engagement": 0.26,  # 互动质量（点赞/投币/收藏率）
    "popularity": 0.20,  # 热度体量
    "freshness": 0.12,   # 时效性
    "duration": 0.10,    # 时长适配度
}

# 低质 / 标题党特征
_CLICKBAIT_PATTERNS = [
    r"震惊[!！]?",
    r"万万没想到",
    r"不转不是",
    r"删前速看",
    r"速看[!！]",
    r"一定要看到最后",
    r"最后我?[哭泪]了",
    r"真相竟然",
    r"竟然是这样",
    r"专家都不想你知道",
    r"!!+",
    r"！{2,}",
]
_CLICKBAIT_RE = re.compile("|".join(_CLICKBAIT_PATTERNS))

_TITLE_NOISE_WORDS = {"合集", "全集", "完整版", "高清", "1080P", "4K"}


@dataclass(slots=True)
class QualityVerdict:
    """质检结论。"""

    passed: bool
    penalty: float  # 0.0 ~ 1.0 之间的惩罚系数
    reason: str = ""


# ---------------------------------------------------------------- 工具函数


def _bigrams(text: str) -> set[str]:
    """中文友好的二元组切分，规避引入分词库的重量级依赖。"""
    cleaned = re.sub(r"[\s\W_]+", "", text.lower())
    if len(cleaned) < 2:
        return {cleaned} if cleaned else set()
    return {cleaned[i : i + 2] for i in range(len(cleaned) - 1)}


def text_relevance(keyword: str, fields: Iterable[str]) -> float:
    """计算关键词与若干文本字段的相关程度，返回 0.0~1.0。

    字段按传入顺序享有递减权重（先传标题，再传摘要/标签）。
    """
    if not keyword:
        return 0.5
    kw_clean = keyword.strip().lower()
    if not kw_clean:
        return 0.5

    kw_bigrams = _bigrams(kw_clean)
    total = 0.0
    weight_sum = 0.0

    for index, field in enumerate(fields):
        weight = 1.0 / (index + 1.2)  # 第 1 项权重最大，后续递减
        weight_sum += weight
        if not field:
            continue
        field_clean = field.strip().lower()

        # 完整命中：最强信号
        if kw_clean in field_clean:
            score = 1.0
        elif kw_bigrams:
            bg = _bigrams(field_clean)
            overlap = len(kw_bigrams & bg)
            score = min(overlap / max(len(kw_bigrams), 1), 1.0)
        else:
            score = 0.0
        total += weight * score

    return total / weight_sum if weight_sum else 0.0


def _log_normalize(value: int, ceiling: int) -> float:
    """对数压制头部效应，避免百万播放量碾压一切。"""
    if value <= 0:
        return 0.0
    return min(math.log10(value + 1) / math.log10(ceiling + 1), 1.0)


def _engagement_score(item: ContentItem) -> float:
    """互动质量：点赞/投币/收藏/评论相对播放量的比例。

    这是识别「真干货」与「标题党」最锋利的一刀 ——
    刷量的视频播放高但互动率惨不忍睹。
    """
    views = max(item.view_count, 1)
    # 避免小样本暴击：样本太小时打折
    sample_weight = min(1.0, math.log10(views + 1) / 3.0)  # 1000 播放以上才获满权

    like_rate = item.like_count / views
    fav_rate = item.favorite_count / views if item.favorite_count else 0.0
    coin_rate = item.coin_count / views if item.coin_count else 0.0
    comment_rate = item.comment_count / views if item.comment_count else 0.0

    # 各指标的"优秀基准线"（达到即得满分）
    benchmarks = (0.05, 0.03, 0.01, 0.005)
    aggregate = 0.0
    for rate, bench in zip((like_rate, fav_rate, coin_rate, comment_rate), benchmarks):
        aggregate += min(rate / bench, 1.0)
    normalized = aggregate / len(benchmarks)
    return round(min(normalized * sample_weight, 1.0), 4)


def _freshness_score(item: ContentItem) -> float:
    """时效性：新内容加权，但不让老经典彻底埋没。"""
    if not item.published_at:
        return 0.4  # 信息缺失给中位值，不惩罚也不奖励
    age_days = max((time.time() - item.published_at) / 86400, 0)
    # 一年内衰减至约 0.5，十年以上趋近 0.2
    return round(1.0 / (1.0 + age_days / 365.0) * 0.8 + 0.2, 4)


def _duration_score(item: ContentItem) -> float:
    """完播友好度：视频偏好 3~25 分钟的"黄金区间"。"""
    if item.kind != "video":
        return 0.6  # 图文不参与时长评分，给中性
    if item.duration is None or item.duration <= 0:
        return 0.4

    minutes = item.duration / 60.0
    if minutes < 1:
        return 0.25  # 疑似切片/营销短片
    if minutes <= 3:
        return 0.6
    if minutes <= 25:
        # 黄金区间，微微向 8 分钟倾斜
        return round(0.75 + 0.25 * math.exp(-((minutes - 10) ** 2) / 300), 4)
    if minutes <= 60:
        return 0.6
    return 0.45  # 超长：多为直播录像/大部头合集


def inspect_quality(item: ContentItem) -> QualityVerdict:
    """低质内容体检：命中则返回惩罚系数。"""
    penalty = 1.0
    reasons: list[str] = []

    if _CLICKBAIT_RE.search(item.title):
        penalty *= 0.55
        reasons.append("标题存在煽动性话术")

    # 播放量极低且已发布一段时间 -> 大概率无人认可
    if item.published_at and item.view_count < 100:
        age_days = (time.time() - item.published_at) / 86400
        if age_days > 1:
            penalty *= 0.6
            reasons.append("播放量过低")

    # 无标题或标题残缺
    if len(item.title.strip()) < 2:
        penalty *= 0.3
        reasons.append("标题异常")

    # 视频时长短得不合理
    if item.kind == "video" and item.duration is not None and 0 < item.duration < 20:
        penalty *= 0.5
        reasons.append("时长过短")

    passed = penalty >= 0.99
    if passed:
        return QualityVerdict(True, 1.0, "")
    return QualityVerdict(False, round(penalty, 3), "、".join(reasons))


# ---------------------------------------------------------------- 主评分器


def score_item(item: ContentItem, keyword: str) -> ContentItem:
    """就地计算分数并写回 item.score / item.score_detail。"""
    relevance = round(
        text_relevance(keyword, [item.title, item.summary, " ".join(item.tags)]), 4
    )
    engagement = _engagement_score(item)
    popularity = round(_log_normalize(item.view_count, 2_000_000), 4)
    freshness = _freshness_score(item)
    duration = _duration_score(item)

    base = (
        relevance * WEIGHTS["relevance"]
        + engagement * WEIGHTS["engagement"]
        + popularity * WEIGHTS["popularity"]
        + freshness * WEIGHTS["freshness"]
        + duration * WEIGHTS["duration"]
    )

    verdict = inspect_quality(item)
    final = round(base * verdict.penalty * 100, 2)

    item.score = final
    item.score_detail = {
        "relevance": relevance,
        "engagement": engagement,
        "popularity": popularity,
        "freshness": freshness,
        "duration": duration,
        "penalty": verdict.penalty,
    }
    if not verdict.passed:
        item.extra["quality_warning"] = verdict.reason
    return item
