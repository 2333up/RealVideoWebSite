"""视频分类文件夹。

为什么需要「应用内文件夹」而不是直接沿用磁盘目录：
    同一个磁盘目录下的视频可能想按项目二次分组，反过来多个磁盘目录的视频
    也可能想归到同一个分类里。磁盘结构是**存储**的视角，分类是**使用**的视角，
    二者不该强行一一对应。

    当然，绝大多数时候它们是一致的，所以「按文件夹批量导入」会默认
    按目录名创建同名分类（见 videos.import_folder）——既省一步操作，
    又保留了事后重组的自由。

删除语义：
    删文件夹≠删视频。视频一律退回到「未分类」，用户的分析结果（转写/章节/导图）
    更是一概不动。删一个分类导致几十个视频的分析成果灰飞烟灭属于灾难级 UX。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from core.database import get_db
from core.models import Folder, Video

router = APIRouter(prefix="/api/folders", tags=["folders"])

MAX_NAME = 32


# ------------------------------------------------------------------ 工具

def normalize_name(raw: str) -> str:
    """规范化文件夹名，非法就抛 400——错误信息必须能直接展示给用户。

    顺手把 / \\ : * ? " < > | 这些 Windows 文件名非法字符清掉：
    从磁盘目录自动建分类时，目录名里带这些字符的情况虽然罕见，
    但一旦撞上会让「导出/清理」环节报错。
    """
    name = (raw or "").strip()
    for ch in '/\\:*?"<>|':
        name = name.replace(ch, "")
    name = " ".join(name.split())
    if not name:
        raise HTTPException(400, "文件夹名称不能为空")
    if len(name) > MAX_NAME:
        raise HTTPException(400, f"文件夹名称不能超过 {MAX_NAME} 个字符（当前 {len(name)}）")
    return name


def folder_to_dict(f: Folder, video_count: int | None = None) -> dict:
    return {
        "id": f.id,
        "name": f.name,
        #: 前端靠它把平铺列表还原成树；None = 根级
        "parent_id": f.parent_id,
        "video_count": len(f.videos) if video_count is None else video_count,
        "created_at": f.created_at.isoformat() if f.created_at else None,
    }


def _load_parent(db: Session, parent_id: int | None) -> Folder | None:
    """校验父分类存在。None 表示建在根级，不用查。"""
    if parent_id is None:
        return None
    parent = db.get(Folder, parent_id)
    if not parent:
        raise HTTPException(404, f"父文件夹不存在（id={parent_id}）")
    return parent


def _has_same_name(
    db: Session, name: str, parent_id: int | None, exclude_id: int | None = None
) -> bool:
    """同一层级下是否已有同名分类。

    只在同一父级内查：多级目录里「课程/进阶」和「项目/进阶」应当共存，
    全表唯一会把这种合理结构误判成重名。
    """
    q = db.query(Folder).filter(Folder.name == name, Folder.parent_id == parent_id)
    if exclude_id is not None:
        q = q.filter(Folder.id != exclude_id)
    return q.first() is not None


def get_or_create_folder(db: Session, name: str) -> Folder:
    """按名字取文件夹，没有就建一个。

    用于「按磁盘目录名自动建分类」：同名即认为是同一个分类意图，
    重复往同一个目录里导东西时不会产生一堆「新建文件夹(1)」。
    """
    clean = normalize_name(name)
    f = db.query(Folder).filter(Folder.name == clean).one_or_none()
    if f:
        return f
    f = Folder(name=clean)
    db.add(f)
    db.flush()
    return f


# ------------------------------------------------------------------ 列表

@router.get("")
def list_folders(db: Session = Depends(get_db)):
    """文件夹列表，带每个文件夹下的视频数。

    计数用一次 group_by 聚合而不是对每行做 len(f.videos)：
    后者会让每一行触发一次 COUNT 查询，视频上百条时侧栏刷新肉眼可见地卡。
    """
    counts = dict(
        db.query(Video.folder_id, func.count(Video.id))
        .filter(Video.folder_id.isnot(None))
        .group_by(Video.folder_id)
        .all()
    )
    folders = db.query(Folder).order_by(Folder.created_at.asc()).all()
    return {"items": [folder_to_dict(f, counts.get(f.id, 0)) for f in folders]}


class FolderCreate(BaseModel):
    name: str
    #: 父分类 id；None（默认）= 建在根级
    parent_id: int | None = None


@router.post("")
def create_folder(body: FolderCreate, db: Session = Depends(get_db)):
    clean = normalize_name(body.name)
    _load_parent(db, body.parent_id)
    if _has_same_name(db, clean, body.parent_id):
        raise HTTPException(400, f"同一层级下已经有同名文件夹「{clean}」")
    f = Folder(name=clean, parent_id=body.parent_id)
    db.add(f)
    try:
        db.commit()
    except IntegrityError:
        # 老库在 name 上还留着全局唯一约束，跨层级同名会撞在这里；
        # 统一翻译成用户能看懂的 400，而不是抛一个 500
        db.rollback()
        raise HTTPException(400, f"已经有同名文件夹「{clean}」")
    db.refresh(f)
    return folder_to_dict(f, 0)


class FolderPatch(BaseModel):
    name: str


@router.patch("/{folder_id}")
def rename_folder(folder_id: int, body: FolderPatch, db: Session = Depends(get_db)):
    f = db.get(Folder, folder_id)
    if not f:
        raise HTTPException(404, "文件夹不存在")
    clean = normalize_name(body.name)
    if _has_same_name(db, clean, f.parent_id, exclude_id=folder_id):
        raise HTTPException(400, f"同一层级下已经有同名文件夹「{clean}」")
    f.name = clean
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, f"已经有同名文件夹「{clean}」")
    db.refresh(f)
    return folder_to_dict(f)


@router.delete("/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db)):
    """删除文件夹：视频退回未分类，子文件夹提升一层，分析结果保持不变。

    两个必须遵守的语义：
      - 子文件夹不是「文件夹的内容」，而是同级的组织单元，删父级时应当**提升**
        到祖父级下，而不是跟着消失——那里面同样挂着用户的视频和分析结果。
      - 视频退回未分类，绝不删除（见模块顶部说明）。

    这里全部走 bulk update/delete 而不是改 ORM 对象：SQLAlchemy 在删除父行时会
    把已加载的 children 的外键置 NULL，那会把「提升一层」覆盖成「掉到根级」。
    """
    f = db.get(Folder, folder_id)
    if not f:
        raise HTTPException(404, "文件夹不存在")

    grandparent_id = f.parent_id
    promoted = (
        db.query(Folder)
        .filter(Folder.parent_id == folder_id)
        .update({Folder.parent_id: grandparent_id}, synchronize_session=False)
    )
    moved = (
        db.query(Video)
        .filter(Video.folder_id == folder_id)
        .update({Video.folder_id: None}, synchronize_session=False)
    )
    name = f.name
    db.commit()
    # 先落盘再删父行：顺序反了的话子文件夹刚提升上去就又被置空
    db.query(Folder).filter(Folder.id == folder_id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "name": name, "unfiled": moved, "promoted": promoted}


# ------------------------------------------------------------------ 移动视频

class AssignRequest(BaseModel):
    video_ids: list[int] = Field(default_factory=list)
    #: null 表示移回「未分类」
    folder_id: int | None = None


@router.post("/assign")
def assign_videos(body: AssignRequest, db: Session = Depends(get_db)):
    """把一批视频移入某个文件夹（folder_id=null 表示移回未分类）。

    批量而非单个：用户最常见的动作是「把刚导进来的这 12 个视频都丢进
    「机器学习」」。一次一个发请求会让 UI 闪成一串 toast。
    """
    if not body.video_ids:
        raise HTTPException(400, "没有选择要移动的视频")

    folder = None
    if body.folder_id is not None:
        folder = db.get(Folder, body.folder_id)
        if not folder:
            raise HTTPException(404, f"目标文件夹不存在（id={body.folder_id}）")

    moved = 0
    missing: list[int] = []
    for vid in body.video_ids:
        v = db.get(Video, vid)
        if not v:
            missing.append(vid)
            continue
        v.folder_id = folder.id if folder else None
        moved += 1
    db.commit()

    return {
        "ok": True,
        "moved": moved,
        "missing": missing,
        "folder_id": folder.id if folder else None,
    }
