"""视频资源接口。

包含本项目最关键的一个接口：GET /{id}/stream。
它实现了 HTTP Range（206 Partial Content）——没有它，浏览器原生播放器
无法拖动进度条，而「点时间戳跳转」正是本项目的核心，所以这不是可选项。
"""

from __future__ import annotations

import copy
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from core.database import get_db
from core.media_types import MIME_BY_EXT, VIDEO_EXT, is_video_file
from core.models import Chapter, Folder, MindMap, Transcript, Video
from pipeline import mindmap as mindmap_ops
from routers import usage as usage_router
# 文件夹相关的纯逻辑放在 folders 模块里统一维护（那里也对外暴露同名接口）
from routers.folders import folder_to_dict, get_or_create_folder

router = APIRouter(prefix="/api/videos", tags=["videos"])

# 扩展名白名单与 MIME 映射统一放在 core/media_types.py。
# 三处共用同一份：这里的导入校验、流式播放的 Content-Type、
# 以及原生选择对话框的 Filter——漏改一处就会「明明支持却选不到/播不了」。

CHUNK_SIZE = 1024 * 1024  # 1 MB


# ------------------------------------------------------------------ 序列化

def video_to_dict(v: Video, with_detail: bool = False) -> dict:
    data = {
        "id": v.id,
        "title": v.title,
        "filename": v.filename,
        "duration": v.duration,
        "size_bytes": v.size_bytes,
        "status": v.status,
        "error": v.error,
        "created_at": v.created_at.isoformat() if v.created_at else None,
        "folder_id": v.folder_id,
        "chapter_count": len(v.chapters),
        "has_mindmap": v.mindmap is not None,
        "has_transcript": v.transcript is not None,
    }
    if with_detail:
        data["transcript"] = (
            {"provider": v.transcript.provider, "segments": v.transcript.segments}
            if v.transcript else None
        )
        # id 与 source_node_id 必须一起下发：前端要靠 id 调 PATCH/DELETE，
        # 靠 source_node_id 判断这条章节是不是「由导图节点驱动的」
        # （是的话要提示用户：改导图节点的时间会覆盖这里的修改）。
        data["chapters"] = [
            {
                "id": c.id, "idx": c.idx, "title": c.title, "start": c.start, "end": c.end,
                "summary": c.summary, "key_points": c.key_points,
                "source_node_id": c.source_node_id,
            }
            for c in sorted(v.chapters, key=lambda x: x.idx)
        ]
        # 读到旧版本导图（节点没有 id）时顺手补上，前端才有稳定的编辑对象。
        # 这是纯函数、不写库，真正的落库发生在用户第一次保存时。
        data["mindmap"] = (
            mindmap_ops.ensure_node_ids(v.mindmap.tree) if v.mindmap else None
        )
        data["last_job"] = job_to_dict(v.jobs[-1] if v.jobs else None)
    return data


def job_to_dict(job) -> dict | None:
    """最近一次分析任务。

    elapsed_seconds 由服务端算好而不是前端自己掐表：
    前端掐表的起点只能是「页面发现它开始处理」，用户中途切走视频或刷新页面
    就断了；而且排队等待的时间不该算进来，只有后端知道真正的起跑时刻。
    """
    if job is None:
        return None
    # started_at 是后加的列，老任务为 NULL。此时退回 created_at：
    # 它包含了「排队等上一个任务」的时间，会略微偏大，但总好过什么都不显示。
    started = job.started_at or job.created_at
    finished = job.finished_at
    elapsed = None
    if started is not None:
        end = finished or datetime.now()
        elapsed = round((end - started).total_seconds(), 1)
    return {
        "id": job.id,
        "stage": job.stage,
        "progress": job.progress,
        "message": job.message,
        "error": job.error,
        "started_at": started.isoformat() if started else None,
        "finished_at": finished.isoformat() if finished else None,
        "elapsed_seconds": elapsed,
        "running": job.stage not in ("done", "failed"),
    }


# ------------------------------------------------------------------ 列表 / 详情

@router.get("")
def list_videos(folder: str = "", db: Session = Depends(get_db)):
    """视频列表，可按应用内文件夹筛选。

    folder 的取值约定（用字符串而不是 int，是为了区分「不筛选」与「未分类」）：
        空字符串   -> 全部
        "none"     -> 未分类（folder_id IS NULL）
        "12"       -> id=12 的文件夹
    """
    query = db.query(Video)
    if folder == "none":
        query = query.filter(Video.folder_id.is_(None))
    elif folder.strip().lstrip("-").isdigit():
        query = query.filter(Video.folder_id == int(folder.strip()))
    # 其他取值一律当作「不筛选」，不给前端制造查询失败
    videos = query.order_by(Video.created_at.desc()).all()
    return {"items": [video_to_dict(v) for v in videos]}


@router.get("/{video_id}")
def get_video(video_id: int, db: Session = Depends(get_db)):
    v = db.get(Video, video_id)
    if not v:
        raise HTTPException(404, "视频不存在")
    data = video_to_dict(v, with_detail=True)
    # 带上这部视频累计的模型用量，前端不用再单独请求一次
    data["token_usage"] = usage_router.video_usage_summary(db, video_id)
    return data


@router.delete("/{video_id}")
def delete_video(video_id: int, db: Session = Depends(get_db)):
    """删除记录。默认不动用户的原始视频文件——那是用户的资产，不是我们的数据。"""
    v = db.get(Video, video_id)
    if not v:
        raise HTTPException(404, "视频不存在")
    db.delete(v)
    db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 导入本地文件

class ImportRequest(BaseModel):
    path: str
    #: 导入后归入哪个应用内文件夹；留空表示「未分类」
    folder_id: int | None = None


class BatchImportRequest(BaseModel):
    #: 一次选多个文件时用这个；一个个发请求会让 UI 闪成一串提示
    paths: list[str]
    folder_id: int | None = None


class FolderImportRequest(BaseModel):
    path: str
    #: 是否连子目录一起扫描
    recursive: bool = True
    #: 是否按目录名自动建立（或复用）一个应用内分类文件夹
    create_folder: bool = True
    #: 单次扫描的文件上限。素材目录里躺着几百个视频很常见，
    #: 一把梭进去会把转写队列塞死，也给前端渲染造成压力。
    max_files: int = 200


MAX_FOLDER_NAME = 32


def _clean_path(raw: str) -> Path:
    """去掉资源管理器「复制文件地址」带来的引号与空白——最常见的手工粘贴错误。"""
    return Path((raw or "").strip().strip('"').strip("'"))


def _import_one(db: Session, raw: str, folder_id: int | None = None) -> dict:
    """导入单个文件。返回是否新建以及基础信息；重复导入返回 duplicate=True。

    只登记路径、不复制文件：用户动辄几十 GB 的素材库，复制一份纯属浪费。
    代价是原文件被移动或删除后需要重新导入，这个取舍对本地工具是合理的。
    """
    p = _clean_path(raw)
    if not str(p):
        raise HTTPException(400, "路径为空")
    if not p.exists():
        raise HTTPException(400, f"文件不存在：{p}")
    if not p.is_file():
        raise HTTPException(400, f"不是文件：{p}")
    if not is_video_file(p.name):
        raise HTTPException(
            400, f"不支持的格式：{p.suffix or '（无扩展名）'}（支持 {', '.join(sorted(VIDEO_EXT))}）"
        )
    _resolve_folder(db, folder_id)

    resolved = str(p.resolve())
    existed = db.query(Video).filter(Video.path == resolved).first()
    if existed:
        # 已存在时顺手把它挪到目标文件夹：用户从别的目录重复导入，
        # 期望的是「进了当前分类」，而不是一声不响地什么都不做
        if folder_id is not None and existed.folder_id != folder_id:
            existed.folder_id = folder_id
            db.commit()
        return {"id": existed.id, "duplicate": True, "status": existed.status}

    from pipeline import media

    try:
        probe = media.probe(str(p))
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc

    v = Video(
        title=p.stem,
        filename=p.name,
        path=resolved,
        duration=probe.duration,
        size_bytes=p.stat().st_size,
        status="pending",
        folder_id=folder_id,
    )
    db.add(v)
    db.commit()
    db.refresh(v)
    return {"id": v.id, "duplicate": False, "status": v.status, "duration": probe.duration}


def _resolve_folder(db: Session, folder_id: int | None) -> Folder | None:
    """校验 folder_id 有效性。外键也会拦，但那样报的是 SQLite 的原始错误。"""
    if folder_id is None:
        return None
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(404, f"分类文件夹不存在（id={folder_id}），请刷新列表后重试")
    return folder


@router.post("/import")
def import_local(req: ImportRequest, db: Session = Depends(get_db)):
    """导入单个视频文件。"""
    return _import_one(db, req.path, req.folder_id)


@router.post("/import-many")
def import_many(req: BatchImportRequest, db: Session = Depends(get_db)):
    """批量导入多个视频文件（原生文件选择框通常一次给你一堆）。

    单个失败不回滚整批，错误逐条返回——用户要的是「能进来的先进来」。
    """
    results, failed = [], []
    for raw in req.paths:
        try:
            results.append(_import_one(db, raw, req.folder_id))
        except HTTPException as exc:
            failed.append({"path": raw, "reason": str(exc.detail)})
        except Exception as exc:  # noqa: BLE001
            failed.append({"path": raw, "reason": str(exc)})
    return {
        "items": results,
        "created": sum(1 for r in results if not r.get("duplicate")),
        "duplicates": sum(1 for r in results if r.get("duplicate")),
        "failed": failed,
    }


def collect_video_files(
    directory: Path, recursive: bool = True, max_files: int = 200
) -> list[Path]:
    """扫描目录下的视频文件，按路径排序后截断到 max_files。

    rglob 的返回顺序由文件系统决定，不排序的话同一目录两次导入的顺序可能不同，
    用户会觉得「我选的那批视频怎么顺序是乱的」。
    """
    iterator = directory.rglob("*") if recursive else directory.glob("*")
    files: list[Path] = []

    def _hidden(p: Path) -> bool:
        # 跳过隐藏项（Linux/macOS 的 .xxx）与 macOS 的资源回收目录
        return any(part.startswith(".") or part == "__MACOSX" for part in p.parts)

    for p in iterator:
        if not p.is_file() or _hidden(p):
            continue
        if is_video_file(p.name):
            files.append(p)
            if len(files) >= max_files:
                break
    return sorted(files, key=lambda x: str(x).lower())


@router.post("/import-folder")
def import_folder(req: FolderImportRequest, db: Session = Depends(get_db)):
    """把一个磁盘目录下的视频批量导入，并按需归入同名应用内分类。

    这是「点按钮选文件夹」那条路的后端：用户选的是磁盘上的一个真实目录，
    我们默认按目录名建一个同名分类，省掉「先建分类再手工拖进去」两步操作。
    """
    d = _clean_path(req.path)
    if not str(d):
        raise HTTPException(400, "路径为空")
    if not d.exists():
        raise HTTPException(400, f"目录不存在：{d}")
    if not d.is_dir():
        raise HTTPException(400, f"不是文件夹：{d}")

    files = collect_video_files(d, req.recursive, max(1, req.max_files))
    if not files:
        return {
            "folder": None,
            "created": 0,
            "duplicates": 0,
            "failed": [],
            "imported_ids": [],
            "message": "该目录下没有找到支持的视频文件",
        }

    folder = None
    folder_id = None
    if req.create_folder:
        folder = get_or_create_folder(db, d.name or "未命名文件夹")
        folder_id = folder.id

    created, imported_ids, failed = 0, [], []
    for f in files:
        try:
            r = _import_one(db, str(f), folder_id)
        except HTTPException as exc:
            # 单个文件失败（比如这个容器损坏）不该让整批回滚——
            # 用户要的是「能导的先进来」，失败清单单独告诉他们
            failed.append({"path": str(f), "reason": str(exc.detail)})
            continue
        except Exception as exc:  # noqa: BLE001
            failed.append({"path": str(f), "reason": str(exc)})
            continue
        if r.get("duplicate"):
            continue
        created += 1
        imported_ids.append(r["id"])

    return {
        "folder": folder_to_dict(folder) if folder else None,
        "created": created,
        "duplicates": len(files) - created - len(failed),
        "failed": failed,
        "imported_ids": imported_ids,
        "message": None,
    }


# ------------------------------------------------------------------ 流式播放

@router.api_route("/{video_id}/stream", methods=["GET", "HEAD"])
def stream_video(video_id: int, request: Request, db: Session = Depends(get_db)):
    """支持 Range 请求的视频流。

    浏览器 <video> 在 seek 时会发 `Range: bytes=N-`；
    服务端必须回 206 + Content-Range，否则进度条拖不动。

    HEAD 也支持：部分播放器会先用 HEAD 探测文件长度。
    """
    v = db.get(Video, video_id)
    if not v:
        raise HTTPException(404, "视频不存在")

    path = Path(v.path)
    if not path.exists():
        raise HTTPException(404, f"原始文件已不存在：{v.path}")

    range_header = request.headers.get("range", "")
    resp = RangeFileResponse(path, range_header=range_header)

    if request.method == "HEAD":
        # HEAD 只回头部：复用同样的 Range 解析逻辑，但 Body 为空
        return Response(
            status_code=resp.status_code,
            headers=dict(resp.headers),
            media_type=resp.media_type,
        )
    return resp


class RangeFileResponse(StreamingResponse):
    """带 Range 支持的文件响应。

    注意初始化顺序：StreamingResponse.__init__ 内部会调用 init_headers()，
    那时 raw_headers 还没建立。因此这里**不覆写 init_headers**，
    而是把 Range 解析结果作为构造参数传进来，在 super().__init__() 之后统一设置头部。
    """

    def __init__(self, path: Path, range_header: str = "", media_type: str | None = None):
        self.path = path
        self.file_size = path.stat().st_size
        if media_type is None:
            media_type = MIME_BY_EXT.get(path.suffix.lower(), "video/mp4")

        start, end, status = self._parse_range(range_header)
        self._start, self._end = start, end

        super().__init__(self._real_iter(), status_code=status, media_type=media_type)

        self.headers["Accept-Ranges"] = "bytes"
        self.headers["Content-Length"] = str(end - start + 1)
        self.headers["Cache-Control"] = "no-cache"
        if status == 206:
            self.headers["Content-Range"] = f"bytes {start}-{end}/{self.file_size}"

    def _parse_range(self, range_header: str) -> tuple[int, int, int]:
        """解析 Range 头，返回 (start, end, status_code)。

        只处理单区间；多区间（逗号分隔）浏览器播放视频时不会用到，按全量返回。
        """
        start, end, status = 0, self.file_size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)", (range_header or "").strip())
        if m:
            gs, ge = m.group(1), m.group(2)
            try:
                if gs:
                    start = int(gs)
                elif ge:
                    # bytes=-500 表示「最后 500 字节」
                    start = max(0, self.file_size - int(ge))
                if ge and gs:
                    end = min(int(ge), self.file_size - 1)
            except ValueError:
                start, end, status = 0, self.file_size - 1, 200
            else:
                start = min(start, max(0, self.file_size - 1))
                end = min(end, self.file_size - 1)
                if start > end:
                    start = end
                status = 206
        return start, end, status

    async def _real_iter(self):
        with self.path.open("rb") as f:
            f.seek(self._start)
            remaining = self._end - self._start + 1
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk


# ------------------------------------------------------------------ 章节手工修正

class ChapterPatch(BaseModel):
    title: str | None = None
    start: float | None = None
    end: float | None = None
    summary: str | None = None
    key_points: list[str] | None = None


@router.patch("/{video_id}/chapters/{chapter_id}")
def patch_chapter(
    video_id: int, chapter_id: int, patch: ChapterPatch, db: Session = Depends(get_db)
):
    """人工微调章节。

    LLM 的分章不总是完美，给用户一个「能动手指改」的出口，
    比反复调 prompt 更实际。
    """
    v, c = _video_and_chapter(db, video_id, chapter_id)
    for field in ("title", "start", "end", "summary", "key_points"):
        val = getattr(patch, field)
        if val is not None:
            setattr(c, field, val)
    _assert_valid_range(c, v.duration)
    db.commit()
    normalize_chapter_ranges(db, video_id)
    db.commit()
    return {"ok": True, "chapter": chapter_to_dict(c)}


class ChapterCreate(BaseModel):
    title: str
    start: float = 0.0
    end: float | None = None
    summary: str = ""
    key_points: list[str] = Field(default_factory=list)


@router.post("/{video_id}/chapters")
def create_chapter(video_id: int, body: ChapterCreate, db: Session = Depends(get_db)):
    """手工新增一条章节（不来自导图节点）。

    为什么单独留这个入口：有些章节是用户边看边记的，
    它不对应导图里任何一个节点，不该被导图同步逻辑管着。
    """
    v = db.get(Video, video_id)
    if not v:
        raise HTTPException(404, "视频不存在")

    next_idx = _next_idx(db, video_id)

    c = Chapter(
        video_id=video_id,
        idx=next_idx,
        title=body.title.strip() or f"第 {next_idx + 1} 章",
        start=max(0.0, float(body.start)),
        end=float(body.end) if body.end is not None else max(0.0, float(body.start)),
        summary=body.summary,
        key_points=list(body.key_points),
        source_node_id=None,
    )
    # 只给了起点没给终点时，默认覆盖到下一个已有章节的起点，否则到片尾
    if body.end is None:
        c.end = _next_boundary(db, video_id, c.start, v.duration)
    _assert_valid_range(c, v.duration)
    db.add(c)
    db.commit()
    # 新建的这条会插进已有章节之间：全局重排一遍，保证区间不交叉
    normalize_chapter_ranges(db, video_id)
    db.commit()
    db.refresh(c)
    return chapter_to_dict(c)


@router.delete("/{video_id}/chapters/{chapter_id}")
def delete_chapter(video_id: int, chapter_id: int, db: Session = Depends(get_db)):
    """删除章节。

    若这条章节是某个导图节点生成的，还要把该节点的时间戳一并清掉：
    否则下一次保存导图时，同步逻辑会「好心」地把它再建回来——
    用户删一次它长回来一次，看着像灵异事件。
    """
    v, c = _video_and_chapter(db, video_id, chapter_id)
    node_id = c.source_node_id
    db.delete(c)
    db.commit()
    # 删掉一条后，前一条的终点还停在原处，会留下一段没人认领的缝隙
    normalize_chapter_ranges(db, video_id)
    db.commit()

    cleared = False
    if node_id and v.mindmap:
        tree = copy.deepcopy(v.mindmap.tree)
        cleared = mindmap_ops.clear_start(tree, node_id)
        if cleared:
            v.mindmap.tree = tree
            db.commit()
    return {"ok": True, "cleared_node_start": cleared}


# ------------------------------------------------------------------ 思维导图编辑

class MindMapPatch(BaseModel):
    tree: dict
    #: 是否按节点时间戳同步生成/更新章节（默认开——这是本次需求的核心）
    create_chapters: bool = True


@router.patch("/{video_id}/mindmap")
def patch_mindmap(video_id: int, body: MindMapPatch, db: Session = Depends(get_db)):
    """保存手工编辑后的思维导图，并按节点时间戳同步章节。

    三件事，按这个顺序做：
      1. 清洗树（补 id、限深限宽、时间戳夹到视频时长内）
      2. 有时间戳的节点 -> 保证存在对应章节（新建或更新，不会重复建）
      3. 树里已不存在的节点 -> 删掉它们当初生成的章节
    """
    v = db.get(Video, video_id)
    if not v:
        raise HTTPException(404, "视频不存在")

    cleaned = clean_mindmap_tree(body.tree, v.duration)
    cleaned = mindmap_ops.ensure_node_ids(cleaned)
    # 手工编辑同样要过一遍时间整理：用户完全可能把两个同级节点设成同一个时间，
    # 或者给分类节点设了时间——这两件事都会让章节区间交叉。
    mindmap_ops.enforce_time_order(cleaned)

    # 必须先留一份旧树：判断「这次有没有动过时间戳」靠它。
    # 覆盖之后再读就只剩新树，所有节点都会变成「新节点」，
    # 于是保存一次就冒出一批章节——正是要避免的行为。
    previous = copy.deepcopy(v.mindmap.tree) if v.mindmap else None

    mm = v.mindmap
    if mm is None:
        mm = MindMap(video_id=video_id, tree=cleaned)
        db.add(mm)
    else:
        mm.tree = cleaned
    db.flush()

    # 2026-10-17 起导图保存**不再**同步章节：分析完成后导图与章节一一对应，
    # 之后的编辑（改名/加节点/挪时间）是两件独立的事，不要求保持对应。
    # 以前这里会把树里的时间戳同步成章节，结果旧树盖回新树时章节成批复活，
    # 「删除按钮没起作用」的体感一大半来自这里。
    created = updated = removed = 0

    db.commit()
    db.refresh(v)
    return {
        "ok": True,
        "tree": v.mindmap.tree if v.mindmap else cleaned,
        "chapters_created": created,
        "chapters_updated": updated,
        "chapters_removed": removed,
        "chapters": [
            chapter_to_dict(c) for c in sorted(v.chapters, key=lambda x: x.idx)
        ],
    }


# ------------------------------------------------------------------ 内部工具

def _video_and_chapter(db: Session, video_id: int, chapter_id: int) -> tuple[Video, Chapter]:
    v = db.get(Video, video_id)
    if not v:
        raise HTTPException(404, "视频不存在")
    c = db.get(Chapter, chapter_id)
    if not c or c.video_id != video_id:
        raise HTTPException(404, "章节不存在")
    return v, c


def _next_idx(db: Session, video_id: int) -> int:
    """下一个可用的章节序号。

    注意这里**不能**写成 `... .scalar() or -1`：idx 从 0 开始，
    0 是假值，会被 or 换成 -1，于是新章节复用已有序号，
    直接撞上 (video_id, idx) 的唯一约束——报错信息是 UNIQUE constraint failed，
    离真正的原因（一个 or）有十万八千里。
    """
    current = (
        db.query(func.coalesce(func.max(Chapter.idx), -1))
        .filter(Chapter.video_id == video_id)
        .scalar()
    )
    return (current if current is not None else -1) + 1


def _assert_valid_range(c: Chapter, duration: float) -> None:
    """章节时间必须合法：非负、起点早于终点、且不超出视频时长。"""
    if c.start < 0:
        raise HTTPException(400, "章节开始时间不能为负")
    if c.end <= c.start:
        raise HTTPException(400, "章节结束时间必须晚于开始时间")
    if duration and c.start > duration + 1:
        raise HTTPException(400, f"章节开始时间超出了视频时长（{duration:.1f} 秒）")


def _next_boundary(db: Session, video_id: int, start: float, duration: float) -> float:
    """找「下一个已有章节的起点」作为本条的终点；没有就用视频时长。"""
    later = (
        db.query(Chapter.start)
        .filter(Chapter.video_id == video_id, Chapter.start > start + 0.01)
        .order_by(Chapter.start.asc())
        .first()
    )
    if later and later[0] > start:
        return float(later[0])
    return max(start + 1.0, duration if duration else start + 1.0)


def clean_mindmap_tree(raw: dict, duration: float) -> dict:
    """把前端传来的任意 JSON 洗成一棵干净的树。

    前端是可被篡改的，所以这里必须重新做一遍和模型输出同样的校验：
    限深、限宽、去空节点、时间戳夹到视频时长之内。
    唯一**不能动**的是节点 id——id 变了，章节与节点的对应关系就断了。
    """
    if not isinstance(raw, dict):
        raise HTTPException(400, "思维导图数据格式不正确")

    def clamp_ts(raw_ts) -> float | None:
        try:
            t = float(raw_ts)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        if t < 0:
            t = 0.0
        if duration and t > duration:
            t = float(duration)
        return round(t, 2)

    def walk(node: object, depth: int) -> dict | None:
        if not isinstance(node, dict):
            return None
        label = str(node.get("label") or "").strip()
        if not label:
            return None
        out: dict = {
            "label": label[:mindmap_ops.MAX_LABEL],
            "start": clamp_ts(node.get("start")),
            "scale": mindmap_ops.clamp_scale(node.get("scale")),
        }
        nid = str(node.get("id") or "").strip()
        if nid:
            out["id"] = nid
        # pinned = 用户显式点过「设置时间」。它决定了这个节点要不要生成章节，
        # 属于用户意图，必须原样保留。
        if node.get("pinned"):
            out["pinned"] = True
        kids_raw = node.get("children")
        if isinstance(kids_raw, list) and depth < mindmap_ops.MAX_DEPTH:
            kids = []
            for kid in kids_raw[: mindmap_ops.MAX_CHILDREN]:
                cleaned = walk(kid, depth + 1)
                if cleaned:
                    kids.append(cleaned)
            if kids:
                out["children"] = kids
        return out

    cleaned = walk(raw, 0)
    if not cleaned:
        raise HTTPException(400, "思维导图为空，至少要保留一个节点")
    return cleaned


_MISSING = object()


def normalize_chapter_ranges(db: Session, video_id: int) -> int:
    """把整张章节表重新切成互不交叉的区间，返回被调整过的条数。

    这是「章节区间不得交叉」这条硬要求的最终兜底，任何改动过章节的入口
    都要调一次（新建、编辑、删除、导图同步）。

    为什么必须全局做一遍：
        章节有两个来源——分析流程生成的粗粒度章节，和导图叶子节点同步来的
        细粒度章节。两者的粒度天生不同，只想「自己那几条」的话，
        新插入的一条会插进别人中间，前后章节的时间范围立刻重叠。
        统一按 start 排序后「前一条的终点 = 后一条的起点」，
        就把整张表变成一串严丝合缝的区间，无论来源。

    两个刻意的「不做」：
      - 只把终点**夹到**后一条的起点，不强行延伸到片尾。章节之间留一段
        没人认领的时间是正常的（片尾字幕就不该算进任何一章），
        要求「不交叉」，没要求「铺满」。
      - 只有起点真撞车才推后，其余一律尊重用户/模型给的值。
    """
    video = db.get(Video, video_id)
    if video is None:
        return 0

    chapters = sorted(
        db.query(Chapter).filter(Chapter.video_id == video_id).all(),
        key=lambda c: (c.start, c.idx, c.id),
    )
    if not chapters:
        return 0

    duration = float(video.duration) if video.duration else None
    prev_start: float | None = None
    changed = 0

    for i, c in enumerate(chapters):
        start = float(c.start)
        if prev_start is not None and start <= prev_start:
            start = prev_start + mindmap_ops.MIN_TIME_STEP
        if abs(start - float(c.start)) > 1e-6:
            c.start = round(start, 2)
            changed += 1
        prev_start = start

    # idx 跟着时间走：章节列表按 idx 排序展示，idx 还停在「插入顺序」的话，
    # 界面上会出现时间来回跳的假象，看起来就像「时间顺序乱了」。
    #
    # (video_id, idx) 上有唯一约束，直接原地重排会撞键：
    # 把 3 号改成 1 的时候，1 还被 2 号占着。所以先整体挪到一个临时区间，
    # flush 一次腾空位置，再落回真正的序号。
    renumber = [c for c in chapters if any(c.idx != i for i, c in enumerate(chapters))]
    if renumber:
        offset = len(chapters) + 1
        for i, c in enumerate(chapters):
            c.idx = offset + i
        db.flush()
        for i, c in enumerate(chapters):
            c.idx = i
            changed += 1
        db.flush()

    for i, c in enumerate(chapters):
        start = float(c.start)
        end = float(c.end)
        next_start = float(chapters[i + 1].start) if i + 1 < len(chapters) else None

        # 终点不许越过下一条的起点——这是「不交叉」的全部含义
        if next_start is not None and end > next_start:
            end = next_start
        if end <= start:
            end = next_start if next_start is not None else (duration if duration else start + 1.0)
        if end <= start:
            end = start + 1.0

        if abs(float(c.end) - end) > 1e-6:
            c.end = round(end, 2)
            changed += 1

    return changed


def sync_chapters_from_mindmap(
    db: Session, v: Video, tree: dict, previous: dict | None
) -> tuple[int, int]:
    """按节点时间戳同步章节。

    生成条件（这是最容易被做错的地方）：
        **只在时间戳「被设置/被改动」时才生成章节**。
    分析流程生成的导图里，分类节点的时间是从子节点继承来的，
    若不加区分地「有时间戳就建章节」，用户改一次文案就会凭空多出
    十几条与已有章节重复的条目——这不是帮忙，是添乱。

    判定顺序：
      - previous 为空（首次保存）→ 建全部带时间戳的节点
      - 两棵树 id 大面积对不上（分叉）→ 只信 pinned，绝不批量建
      - 这个节点的时间戳这次被改了 → 建（或更新）
      - 用户显式点过「设置时间」→ 节点带 pinned 标记 → 建
      - 已经存在对应章节 → 始终同步标题与终点，保持跟随节点

    幂等性靠 source_node_id：章节按节点 id 认人，反复保存不会重复建。

    分叉检测（后者正是本次事故）：
        页面里还拿着旧树时点了重新分析，服务端会把导图重新生成（全新 id）；
        用户随后保存手里的旧树，旧 id 对新树全部 _MISSING——
        若把 _MISSING 一律当「用户新建节点」，一次保存就能凭空造出 26 条章节。
        所以先比对新旧树的 id 重合度，重合度低于一半即判定为分叉，
        分叉树上只有 pinned（用户显式意图）才有资格建章节。
    """
    timed = [(n, d) for n, _p, d in mindmap_ops.iter_nodes(tree) if n.get("start") is not None]
    timed.sort(key=lambda x: float(x[0]["start"]))

    prev_starts: dict[str, object] = {}
    prev_ids: set[str] = set()
    if previous:
        for n, _p, _d in mindmap_ops.iter_nodes(previous):
            nid = str(n.get("id"))
            if nid:
                prev_ids.add(nid)
            prev_starts[str(n.get("id"))] = n.get("start")

    # 分叉检测：incoming 的 id 大半在旧树里找不到，就不是同一份树的演进
    diverged = False
    if previous:
        incoming_ids = {
            str(n.get("id"))
            for n, _p, _d in mindmap_ops.iter_nodes(tree)
            if n.get("id")
        }
        if incoming_ids and prev_ids:
            overlap = len(incoming_ids & prev_ids) / len(incoming_ids)
            diverged = overlap < 0.5

    by_node = {c.source_node_id: c for c in v.chapters if c.source_node_id}
    next_idx = _next_idx(db, v.id)

    # 先把时间点排成严格递增、互不相同的一串，再按「下一条的起点」切区间。
    # 顺序不能反过来：先用未去重的 start 算 end，两个节点撞在同一个时间点时
    # 会算出 end == start 的零长区间，紧接着下一条又从同样的 start 开始——
    # 前后章节的时间范围就交叉了。
    starts: list[float] = []
    for node, _depth in timed:
        s = float(node["start"])
        if starts and s <= starts[-1]:
            s = starts[-1] + mindmap_ops.MIN_TIME_STEP
        starts.append(round(s, 2))

    duration = float(v.duration) if v.duration else None

    created = updated = 0
    for i, (node, _depth) in enumerate(timed):
        start = starts[i]
        end = starts[i + 1] if i + 1 < len(starts) else (duration if duration else start + 1.0)
        if end <= start:
            end = duration if duration and duration > start else start + 1.0
        title = str(node.get("label") or "未命名节点")

        nid = str(node.get("id"))
        prev = prev_starts.get(nid, _MISSING)
        if diverged:
            # 两棵树对不上号：只有用户显式 pin 过的节点才有资格建章节。
            # 「id 没见过」在这种时候不是「新节点」，而是「树分叉了」。
            touched = bool(node.get("pinned"))
        else:
            touched = prev is _MISSING or prev != node.get("start") or bool(
                node.get("pinned")
            )

        c = by_node.get(nid)
        if c is None:
            if not touched:
                continue  # 时间点没动过、也没显式标记 -> 不自动造章节
            db.add(
                Chapter(
                    video_id=v.id,
                    idx=next_idx,
                    title=title,
                    start=start,
                    end=end,
                    summary="",
                    key_points=[],
                    source_node_id=node.get("id"),
                )
            )
            next_idx += 1
            created += 1
            continue

        changed = False
        for field, value in (("title", title), ("start", start), ("end", end)):
            if getattr(c, field) != value:
                setattr(c, field, value)
                changed = True
        if changed:
            updated += 1
    return created, updated


def drop_orphan_node_chapters(db: Session, v: Video, tree: dict) -> int:
    """删掉「不再对应一个带时间戳节点」的章节。

    两种情形都会走到这里：
      - 节点被用户删了 -> 它的章节跟着走
      - 节点还在，但时间戳被清掉了 -> 同样不该再留着章节
    所以「存活」的判定是**节点存在且仍带时间戳**，缺一不可。

    只删 source_node_id 非空的（即由节点生成的）；分析流程直接生成的章节
    不会因为导图被编辑而消失，那是用户花钱跑出来的结果。
    """
    alive = {
        n.get("id")
        for n, _p, _d in mindmap_ops.iter_nodes(tree)
        if n.get("start") is not None
    }
    removed = 0
    for c in list(v.chapters):
        if c.source_node_id and c.source_node_id not in alive:
            db.delete(c)
            removed += 1
    return removed


def chapter_to_dict(c: Chapter) -> dict:
    return {
        "id": c.id,
        "idx": c.idx,
        "title": c.title,
        "start": c.start,
        "end": c.end,
        "summary": c.summary,
        "key_points": c.key_points,
        "source_node_id": c.source_node_id,
    }
