"""视频资源接口。

包含本项目最关键的一个接口：GET /{id}/stream。
它实现了 HTTP Range（206 Partial Content）——没有它，浏览器原生播放器
无法拖动进度条，而「点时间戳跳转」正是本项目的核心，所以这不是可选项。
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.database import get_db
from core.media_types import MIME_BY_EXT, VIDEO_EXT, is_video_file
from core.models import Chapter, Folder, MindMap, Transcript, Video
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
        data["chapters"] = [
            {
                "idx": c.idx, "title": c.title, "start": c.start, "end": c.end,
                "summary": c.summary, "key_points": c.key_points,
            }
            for c in sorted(v.chapters, key=lambda x: x.idx)
        ]
        data["mindmap"] = v.mindmap.tree if v.mindmap else None
    return data


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


@router.patch("/{video_id}/chapters/{chapter_id}")
def patch_chapter(
    video_id: int, chapter_id: int, patch: ChapterPatch, db: Session = Depends(get_db)
):
    """人工微调章节。

    LLM 的分章不总是完美，给用户一个「能动手指改」的出口，
    比反复调 prompt 更实际。
    """
    c = db.get(Chapter, chapter_id)
    if not c or c.video_id != video_id:
        raise HTTPException(404, "章节不存在")
    for field in ("title", "start", "end", "summary"):
        val = getattr(patch, field)
        if val is not None:
            setattr(c, field, val)
    if c.end <= c.start:
        raise HTTPException(400, "章节结束时间必须晚于开始时间")
    db.commit()
    return {"ok": True}
