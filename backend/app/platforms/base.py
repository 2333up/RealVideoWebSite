"""平台适配器抽象契约。

这是整个系统的"宪法"：任何新平台（抖音 / YouTube / 小红书…）
只需实现本文件中的 PlatformAdapter，其余业务层无需改动一行。
由此实现「多平台共同浏览」的开放架构。
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal

ContentKind = Literal["video", "article"]


# ---------------------------------------------------------------- 数据契约


@dataclass(slots=True)
class Author:
    """归一化作者信息。"""

    uid: str = ""
    name: str = ""
    avatar_url: str = ""
    homepage: str = ""


@dataclass(slots=True)
class ContentItem:
    """跨平台的统一内容载体。

    无论上游来源多么千奇百怪，进入推荐引擎前一律压平成这个结构，
    打分、去重、排序得以与具体平台完全解耦。
    """

    platform: str
    kind: ContentKind  # video=视频, article=图文/专栏
    uid: str  # 平台内唯一标识
    title: str
    summary: str = ""
    cover_url: str = ""
    page_url: str = ""
    author: Author = field(default_factory=Author)

    published_at: int | None = None  # Unix 时间戳（秒）
    duration: int | None = None  # 视频时长（秒）

    # 互动指标
    view_count: int = 0
    like_count: int = 0
    comment_count: int = 0
    favorite_count: int = 0
    coin_count: int = 0
    share_count: int = 0
    danmaku_count: int = 0

    tags: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    # 由推荐引擎填充
    score: float = 0.0
    score_detail: dict[str, float] = field(default_factory=dict)
    matched_source: str = ""  # 命中的检索路径，如 "video:keyword"

    @property
    def unique_key(self) -> str:
        """跨去重的主键。"""
        return f"{self.platform}:{self.kind}:{self.uid}"


@dataclass(slots=True)
class SearchParams:
    """搜索入参，平台无关的通用表达。"""

    keyword: str
    page: int = 1
    # 单次请求要覆盖的页数。
    # 平台搜索接口普遍存在单页上限（B 站为 20 条/页），
    # 想拿到接近网页端的结果量必须并发翻页。
    pages: int = 3
    page_size: int = 30
    kinds: list[ContentKind] = field(default_factory=lambda: ["video", "article"])
    order: str = "relevance"  # relevance | hot | new
    # 时长区间（秒），None 表示不限制
    duration_min: int | None = None
    duration_max: int | None = None
    pubdate_begin: int | None = None
    pubdate_end: int | None = None


@dataclass(slots=True)
class LoginTicket:
    """扫码登录票据：前端拿它渲染二维码，再拿 token 轮询结果。"""

    token: str  # 本地会话标识
    qrcode_image: str  # data URI 形式的 PNG
    qrcode_url: str  # 原始链接（备用）
    expires_at: float = field(default_factory=lambda: time.time() + 180)

    def is_expired(self) -> bool:
        return time.time() > self.expires_at


@dataclass(slots=True)
class LoginResult:
    """登录轮询的中间/终态。"""

    status: Literal["pending", "scanned", "success", "expired", "error"]
    message: str = ""
    account: PlatformAccountPayload | None = None


@dataclass(slots=True)
class PlatformAccountPayload:
    """登录成功后提取出的账号信息，供落库使用。"""

    platform: str
    platform_uid: str
    nickname: str
    avatar_url: str
    credentials: dict[str, Any]


# ---------------------------------------------------------------- 适配器契约


class PlatformAdapter(ABC):
    """平台适配器基类。

    子类需声明两类能力：
      1. 内容检索 —— search()
      2. 账号接入 —— start_login() / poll_login() / verify_credentials()
    """

    key: ClassVar[str] = ""  # 平台唯一标识，如 "bilibili"
    display_name: ClassVar[str] = ""
    accent_color: ClassVar[str] = "#FB7299"  # 前端主题色
    homepage: ClassVar[str] = ""
    supported_kinds: ClassVar[list[ContentKind]] = ["video", "article"]
    supports_login: ClassVar[bool] = True
    # 是否支持「手动粘贴 Cookie」方式接入账号。
    # 用于那些没有可行扫码流程、但持有浏览器 Cookie 即可提升权限的平台（如抖音）。
    manual_credential: ClassVar[bool] = False

    # ----------------------------- 内容检索
    @abstractmethod
    async def search(self, params: SearchParams, credentials: dict[str, Any] | None = None) -> list[ContentItem]:
        """按关键字检索内容，返回统一结构列表。"""

    @abstractmethod
    async def fetch_detail(self, uid: str, credentials: dict[str, Any] | None = None) -> ContentItem | None:
        """按平台内 ID 获取单条内容详情。"""

    # ----------------------------- 账号接入
    @abstractmethod
    async def start_login(self) -> LoginTicket:
        """发起登录，返回二维码票据。"""

    @abstractmethod
    async def poll_login(self, ticket: LoginTicket) -> LoginResult:
        """轮询登录状态；成功时携带账号载荷。"""

    @abstractmethod
    async def verify_credentials(self, credentials: dict[str, Any]) -> tuple[bool, str]:
        """校验存量凭据是否仍然有效，返回 (是否有效, 说明)。"""

    # ----------------------------- 元信息
    def describe(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "display_name": self.display_name,
            "accent_color": self.accent_color,
            "homepage": self.homepage,
            "supported_kinds": self.supported_kinds,
            "supports_login": self.supports_login,
            "manual_credential": self.manual_credential,
        }


# ---------------------------------------------------------------- 注册表


class PlatformRegistry:
    """平台注册表：新增平台只需 register()，业务层通过 get() 取用。"""

    def __init__(self) -> None:
        self._adapters: dict[str, PlatformAdapter] = {}

    def register(self, adapter: PlatformAdapter) -> None:
        if not adapter.key:
            raise ValueError("adapter.key 不可为空")
        self._adapters[adapter.key] = adapter

    def get(self, key: str) -> PlatformAdapter:
        if key not in self._adapters:
            available = ", ".join(self._adapters) or "（无）"
            raise KeyError(f"未注册的平台: {key}，当前已注册: {available}")
        return self._adapters[key]

    def all(self) -> list[PlatformAdapter]:
        return list(self._adapters.values())

    def keys(self) -> list[str]:
        return list(self._adapters)

    def describe_all(self) -> list[dict[str, Any]]:
        return [a.describe() for a in self._adapters.values()]


registry = PlatformRegistry()
