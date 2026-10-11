"""API 输入输出模型。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class SearchRequest(BaseModel):
    keyword: str = Field(..., min_length=1, max_length=60, description="搜索关键词")
    platforms: list[str] = Field(default_factory=lambda: ["bilibili"])
    page: int = Field(1, ge=1, le=200)
    # 上限与 recommend.MAX_OUTPUT_SIZE(100) 对齐：超出部分服务端也会再截断
    page_size: int = Field(60, ge=1, le=100)
    # 单次请求要抓取的平台页数。每页由平台决定条数（B 站固定 20）。
    # 配合 page 使用即可实现「加载更多」：首批 page=1, pages=4，
    # 下一批 page=5, pages=4，以此类推。上限见 MAX_FETCH_PAGES。
    pages: int = Field(4, ge=1, le=30)
    kinds: list[Literal["video", "article"]] = Field(default_factory=lambda: ["video", "article"])
    order: Literal["relevance", "hot", "new"] = "relevance"
    duration_min: int | None = Field(None, ge=0, description="最短时长（秒）")
    duration_max: int | None = Field(None, ge=0, description="最长时长（秒）")
    # 指定用于检索的账号 ID；为空则自动选用该平台的默认账号
    account_id: int | None = None


class AccountBrief(BaseModel):
    id: int
    platform: str
    platform_uid: str
    nickname: str
    avatar_url: str
    is_default: bool
    is_active: bool
    last_verified_at: str | None
    last_error: str


class LoginStartResponse(BaseModel):
    token: str
    qrcode_image: str
    qrcode_url: str
    expires_in: int


class LoginPollResponse(BaseModel):
    status: Literal["pending", "scanned", "success", "expired", "error"]
    message: str
    account: AccountBrief | None = None


class ManualCredentialRequest(BaseModel):
    """手动注入平台 Cookie 的请求体。"""

    cookie_str: str = Field(..., min_length=1, description="从浏览器复制的完整 Cookie 串")
    nickname: str = Field("", max_length=64, description="可选备注名")


class MessageResponse(BaseModel):
    message: str
    data: dict[str, Any] | None = None
