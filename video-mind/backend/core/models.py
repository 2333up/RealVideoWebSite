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

    支持**多级嵌套**：parent_id 指向父分类，None 表示根级。

    为什么从单层改成多级：单层时「课程 / 进阶」这种天然的两级关系只能拍平成
    「课程-进阶」，层级一多就变成一堆靠命名约定维系的平级条目，既难看又不可
    靠。层级关系本身就是信息，应该由结构表达，而不是靠名字里的分隔符去猜。

    注意这不是表里加一列就能解决的事：一个文件夹要装多个视频，反过来一个视频
    只能属于一个文件夹，所以是 folders 主表 + videos.folder_id 外键；而层级是
    folders 表自己的自引用外键。

    重名规则是「同一父级下不能同名」，不是全局唯一——「课程/进阶」和
    「项目/进阶」应当共存。这条约束放在应用层校验（见 routers/folders.py），
    因为 SQLite 的唯一索引认为多个 NULL 互不相同，根级同名会漏过去。
    """

    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), default="", index=True)
    #: 父分类；None = 根级。删除父分类时子分类会被提升一层，不会被连带删掉
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), nullable=True, default=None, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    videos: Mapped[list["Video"]] = relationship(back_populates="folder")
    children: Mapped[list["Folder"]] = relationship(back_populates="parent")
    parent: Mapped["Folder | None"] = relationship(
        back_populates="children", remote_side=[id]
    )


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
    # order_by 必须显式写：不写的话 SQLAlchemy 不保证返回顺序，
    # 而「最近一次任务」是靠 v.jobs[-1] 取的，顺序错了会拿到错误的耗时
    jobs: Mapped[list["Job"]] = relationship(
        back_populates="video", cascade="all, delete-orphan", order_by="Job.id"
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

    # 真实起止时间：updated_at 会被进度的每次回写刷新，拿它当「结束时间」
    # 会得到一个不断往前跑的错误数字。只有这两个字段是给用户看耗时用的。
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)

    video: Mapped["Video"] = relationship(back_populates="jobs")
