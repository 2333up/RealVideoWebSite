"""追番接口的输入输出模型。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AnimeCandidate(BaseModel):
    """搜索候选（同时用于前端「添加追番」时的选择列表）。"""

    subject_id: int
    title: str
    title_original: str = ""
    cover_url: str = ""
    latest_label: str = ""
    latest_eps: int = 0
    status: str = ""
    premiere: str = ""
    intro: str = ""
    # 是否已在追番列表中（前端据此置灰按钮，避免重复添加）
    followed: bool = False


class AnimeFollowOut(BaseModel):
    """追番条目。"""

    id: int
    subject_id: int
    source: str
    title: str
    cover_url: str
    latest_eps: int
    watched_eps: int
    latest_label: str
    last_checked_at: str | None
    created_at: str
    has_update: bool


class AnimeFollowCreate(BaseModel):
    subject_id: int = Field(..., gt=0, description="数据源作品 ID（agedm 的 AID）")


class AnimeMarkWatched(BaseModel):
    watched_eps: int = Field(..., ge=0, description="已看话数")


class AnimeSearchResponse(BaseModel):
    keyword: str
    items: list[AnimeCandidate]


class AnimeUpdateResponse(BaseModel):
    """更新检测结果。"""

    checked: int
    updated: list[AnimeFollowOut]


class MessageResponse(BaseModel):
    message: str
    ok: bool = True