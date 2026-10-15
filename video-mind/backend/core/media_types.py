"""媒体类型的单一事实来源。

扩展名白名单与 MIME 映射被三处用到：导入校验、附带的流式播放 Content-Type、
以及给原生对话框传的 Filter 通配串。分散定义的结果一定是某天漏改一处——
比如新增了 .flv 支持但文件对话框里筛不到，用户会认为「导不进去」。
"""

from __future__ import annotations

# 支持的视频扩展名（导入白名单）
VIDEO_EXT: frozenset[str] = frozenset(
    {
        ".mp4", ".mkv", ".mov", ".webm", ".avi", ".flv", ".wmv",
        ".m4v", ".mpg", ".mpeg", ".ts", ".rmvb",
    }
)

# 容器格式 -> Content-Type。类型错了浏览器会直接拒绝播放。
MIME_BY_EXT: dict[str, str] = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".ts": "video/mp2t",
    ".rmvb": "application/vnd.rn-realmedia-vbr",
}


def is_video_file(path: str | object) -> bool:
    """按扩展名判断是否视频（大小写不敏感）。"""
    name = str(path).lower()
    return any(name.endswith(ext) for ext in VIDEO_EXT)


def extension_filter() -> str:
    """拼成 Windows 文件对话框 Filter 用的通配串：*.mp4;*.mkv;...

    显式排序，保证对话框里的顺序稳定可预期。
    """
    return ";".join(f"*{ext}" for ext in sorted(VIDEO_EXT))
