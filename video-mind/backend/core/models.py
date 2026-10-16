"""数据模型。

一条视频的处理链路：Video -> Transcript -> Chapters -> MindMap，
外加一张 Job 表承载长任务进度。

注意：SQLAlchemy 2.0 的声明式要求同一个类里注解风格统一——
要么全部用 Mapped[...]，要么全部不用。这里统一用 Mapped[...]。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _now() -> datetime:
    return datetime.now()


class Folder(Base):
    """视频分类文件夹（应用内概念，与磁盘目录无关）。

    刻意做成**单层**：这是给已导入视频「打标签/归类」的功能，不是文件系统的
    镜像。一旦支持嵌套，侧栏就变成树形选择器，而真实场景里一层分类已经够用。

    注意这不是表里加一列就能解决的事：一个文件夹要装多个视频，反过来一个视频
    只能属于一个文件夹，所以是 folders 主表 + videos.folder_id 外键。
    """

    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: 同名文件夹会让人分不清（尤其从磁盘目录自动创建时），因此唯一约束
    name: Mapped[str] = mapped_column(String(128), default="", index=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    videos: Mapped[list["Video"]] = relationship(back_populates="folder")


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(512), default="")
    filename: Mapped[str] = mapped_column(String(512), default="")
    # 原始文件在磁盘上的绝对路径（只登记路径，不复制用户的文件）
    path: Mapped[str] = mapped_column(Text, default="")
    # 所属分类文件夹；None = 未分类。删除文件夹时置空而不是删掉视频
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), nullable=True, default=None
    )
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)

    # pending | processing | ready | failed
    status: Mapped[str] = mapped_column(String(32), default="pending")
    error: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    transcript: Mapped["Transcript | None"] = relationship(
        back_populates="video", uselist=False, cascade="all, delete-orphan"
    )
    chapters: Mapped[list["Chapter"]] = relationship(
        back_populates="video", cascade="all, delete-orphan", order_by="Chapter.idx"
    )
    mindmap: Mapped["MindMap | None"] = relationship(
        back_populates="video", uselist=False, cascade="all, delete-orphan"
    )
    jobs: Mapped[list["Job"]] = relationship(
        back_populates="video", cascade="all, delete-orphan"
    )
    folder: Mapped["Folder | None"] = relationship(back_populates="videos")


class Transcript(Base):
    __tablename__ = "transcripts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"))
    provider: Mapped[str] = mapped_column(String(64), default="")
    language: Mapped[str] = mapped_column(String(16), default="")
    # [{"start": 0.0, "end": 3.2, "text": "..."}, ...]
    segments: Mapped[list] = mapped_column(JSON, default=list)
    full_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    video: Mapped["Video"] = relationship(back_populates="transcript")


class Chapter(Base):
    __tablename__ = "chapters"
    __table_args__ = (UniqueConstraint("video_id", "idx", name="uq_chapter_video_idx"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"))
    idx: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str] = mapped_column(String(512), default="")
    start: Mapped[float] = mapped_column(Float, default=0.0)
    end: Mapped[float] = mapped_column(Float, default=0.0)
    summary: Mapped[str] = mapped_column(Text, default="")
    # ["要点一", "要点二"]
    key_points: Mapped[list] = mapped_column(JSON, default=list)
    #: 由哪个思维导图节点生成（节点 id）。不为 None 时意味着这条章节
    #  「由节点的时间戳驱动」——节点改时间它跟着改，节点被删它也跟着走。
    #  分析流程直接生成的章节此列为 None，用户手工改它不会被导图覆盖。
    source_node_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True, default=None, index=True
    )

    video: Mapped["Video"] = relationship(back_populates="chapters")


class MindMap(Base):
    __tablename__ = "mindmaps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"))
    # {"label": "...", "children": [{"label": "...", "start": 0.0, "children": []}]}
    tree: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    video: Mapped["Video"] = relationship(back_populates="mindmap")


class LLMUsage(Base):
    """每一次大模型调用的 token 消耗明细。

    为什么要单独一张表而不是塞进 Job：
    一次分析会打很多次模型（长视频分章节是 Map-Reduce，一次十几个 chunk），
    只记总数的话用户无法判断「钱到底烧在哪一步」。
    独立成表既能按 job 汇总，也能按视频、按模型横向统计。
    """

    __tablename__ = "llm_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: 关联任务；连通性测试等没有任务的调用留空
    job_id: Mapped[int | None] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, default=None
    )
    video_id: Mapped[int | None] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), nullable=True, default=None
    )
    provider: Mapped[str] = mapped_column(String(64), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    #: 调用用途：分章节 / 章节归纳 / 思维导图 / 连通性测试
    purpose: Mapped[str] = mapped_column(String(64), default="")
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cached_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"))
    # queued | extract_audio | transcribe | chapter | mindmap | done | failed
    stage: Mapped[str] = mapped_column(String(32), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)  # 0-100
    message: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    cancel_requested: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    video: Mapped["Video"] = relationship(back_populates="jobs")
