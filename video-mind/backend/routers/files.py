"""本机文件系统访问（原生选择对话框）。

这一层只有一个职责：把「让用户挑一个本地文件/文件夹」这件事包装成 HTTP 接口。
真正的弹框逻辑在 core/files_dialog.py。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal

from core import files_dialog
from core.media_types import extension_filter

router = APIRouter(prefix="/api/files", tags=["files"])


class PickRequest(BaseModel):
    #: file = 选文件（可多选）；folder = 选文件夹
    mode: Literal["file", "folder"] = "file"
    #: 对话框的初始目录；留空则用上次的位置
    start_dir: str = ""
    #: 最多等多久（秒）。用户盯着窗口不动时，服务端不该无限挂着请求
    timeout: int = Field(default=300, ge=10, le=1800)


@router.get("/picker")
def picker_status():
    """告诉前端「能不能弹原生对话框」。

    后端打不开对话框（精简版 Python、容器环境等）时，前端要能自动退回
    「粘贴路径」的手工方式，而不是点按钮没反应。
    """
    status = files_dialog.picker_status()
    status["extensions"] = extension_filter()
    return status


@router.post("/pick")
def pick(req: PickRequest):
    """弹出原生选择窗口并返回用户挑中的路径。cancelled=true 表示用户按了取消。"""
    try:
        paths = files_dialog.pick(req.mode, req.start_dir or None, req.timeout)
    except files_dialog.PickerError as exc:
        # 报错文案里必须带「下一步该干什么」，否则用户只知道失败了不知道怎么绕
        raise HTTPException(400, str(exc)) from exc
    return {"paths": paths, "cancelled": not paths}
