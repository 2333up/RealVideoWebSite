"""本机原生文件 / 文件夹选择对话框。

为什么不在前端做：
    浏览器出于安全策略永远不给网页文件的真实绝对路径——
    `<input type=file>` 只有 File 对象，File System Access API 也不暴露磁盘路径。
    而本项目的设计红线是「只登记路径、不复制文件」（用户素材库动辄几十 GB），
    于是选择文件这一步只能由**与浏览器同处一台机器的后端进程**代劳。

两条实现路径，按可用性自动选择：
    1. PowerShell + WinForms：Windows 自带，外观原生、支持多选folder/file；
    2. tkinter filedialog：跨平台兜底（Linux / macOS / 精简版 Windows）。

两者都在**子进程**里跑，不污染服务端进程。tkinter 尤其不能在服务端初始化：
它会在当前线程建立根窗口与消息循环，和后续请求线程抢事件循环。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from core.config import DATA_DIR
from core.media_types import VIDEO_EXT, extension_filter

if sys.platform == "win32":
    # 起子进程时不要闪出一个黑色控制台窗口。CREATE_NO_WINDOW 只有 Windows 有。
    #: 传给 subprocess 的隐藏窗口参数
    _NO_WINDOW: dict = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
else:
    _NO_WINDOW = {}

MODE_FILE = "file"
MODE_FOLDER = "folder"

#: 用户盯着一个对话框不操作的合理上限；超了就报错而不是让请求永远挂着
DEFAULT_TIMEOUT = 300.0

_SCRIPT_DIR = Path(__file__).resolve().parent.parent / "scripts"
_PS_SCRIPT = _SCRIPT_DIR / "pick_dialog.ps1"


class PickerError(RuntimeError):
    """弹不出对话框，或弹了但没能读到结果。错误信息直接面向用户。"""


# 同一时刻只允许一个对话框：用户多点一次不该叠出第二个窗口，
# 更不该让两个请求同时争抢同一个临时结果文件。
_LOCK = threading.Lock()

_LAST_DIR: str | None = None
_LAST_DIR_FILE = DATA_DIR / "picker_last_dir.txt"
#: (方法名, 可执行文件路径|None, 不可用时原因)
_BACKEND: tuple[str, str | None, str] | None = None


# ------------------------------------------------------------------ 能力探测

def _probe() -> tuple[str, str | None, str]:
    """探测当前环境用哪个方案弹框，结果缓存（探测一次要起子进程）。"""
    global _BACKEND
    if _BACKEND is not None:
        return _BACKEND

    if sys.platform == "win32":
        # 用 Windows PowerShell 5.1（powershell.exe），不用 pwsh：
        # pwsh 不支持 -STA 参数，而 WinForms 的 OpenFileDialog 必须在 STA 线程里跑。
        exe = shutil.which("powershell")
        if exe and _PS_SCRIPT.exists():
            _BACKEND = ("powershell", exe, "")
            return _BACKEND
        reason = []
        if not exe:
            reason.append("未找到 powershell.exe")
        if not _PS_SCRIPT.exists():
            reason.append(f"缺失脚本 {_PS_SCRIPT}")
        ps_reason = "；".join(reason)

    tk_ok, tk_reason = _probe_tkinter()
    if tk_ok:
        _BACKEND = ("tkinter", sys.executable, "")
        return _BACKEND

    detail = ps_reason if sys.platform == "win32" else "非 Windows 环境"
    _BACKEND = ("none", None, f"{detail}；tkinter 也不可用（{tk_reason}）")
    return _BACKEND


def _probe_tkinter() -> tuple[bool, str]:
    """tkinter 不是必装组件（很多精简版 Python 不带），必须实测而不能假设。"""
    try:
        proc = subprocess.run(
            [sys.executable, "-c", "import tkinter"],
            capture_output=True,
            timeout=20,
            **_NO_WINDOW,
        )
    except Exception as exc:  # noqa: BLE001  探测失败等同于不可用
        return False, str(exc)
    if proc.returncode == 0:
        return True, ""
    return False, (proc.stderr.decode("utf-8", "replace").strip() or "未知原因")


def picker_status() -> dict:
    """给前端的能力报告：能不能弹框、用什么弹、上次打开的目录。"""
    method, exe, reason = _probe()
    return {
        "available": method != "none",
        "method": method if method != "none" else None,
        "exe": exe,
        "reason": reason,
        "last_dir": last_dir(),
    }


# ------------------------------------------------------------------ 上次目录

def last_dir() -> str:
    """上次选择所在的目录；为空表示还没选过。"""
    global _LAST_DIR
    if _LAST_DIR:
        return _LAST_DIR
    try:
        text = _LAST_DIR_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""
    if text and Path(text).is_dir():
        _LAST_DIR = text
        return text
    return ""


def _remember(paths: list[str], mode: str) -> None:
    """记住本次结果所在目录，下次弹框直接落在这里——反复从「此电脑」翻墙是最累的。"""
    if not paths:
        return
    p = Path(paths[0])
    target = p if (mode == MODE_FOLDER and p.is_dir()) else p.parent
    if not target.is_dir():
        return
    global _LAST_DIR
    _LAST_DIR = str(target.resolve())
    try:
        _LAST_DIR_FILE.write_text(_LAST_DIR, encoding="utf-8")
    except Exception:
        # 记不住目录只是体验损失，不该让选择流程失败
        pass


# ------------------------------------------------------------------ 对外入口

def pick(
    mode: str = MODE_FILE,
    start_dir: str | None = None,
    timeout: float | None = None,
) -> list[str]:
    """弹出原生对话框并返回选择的绝对路径列表；返回空列表表示用户点了「取消」。

    注意这个函数会**阻塞**：同步端点跑在线程池里，不影响事件循环，
    但调用方必须自己给超时（默认 5 分钟），否则请求会无限挂着。
    """
    if mode not in (MODE_FILE, MODE_FOLDER):
        raise PickerError(f"未知的选择模式：{mode}")
    if not _LOCK.acquire(blocking=False):
        raise PickerError("已经有一个选择窗口打开了，请先处理它")
    try:
        method, exe, reason = _probe()
        if method == "none":
            raise PickerError(f"当前环境无法弹出文件选择窗口：{reason}")
        limit = float(timeout or DEFAULT_TIMEOUT)
        start = start_dir or last_dir()
        if start and not Path(start).is_dir():
            start = ""

        if method == "powershell":
            paths = _run_powershell(exe, mode, start, limit)
        else:
            paths = _run_tkinter(mode, start, limit)
    finally:
        _LOCK.release()

    paths = _dedupe(paths)
    _remember(paths, mode)
    return paths


def _dedupe(paths: list[str]) -> list[str]:
    """Windows 的文件对话框在极少数情况下会返回重复项；顺手做规范化去重（保序）。"""
    out: list[str] = []
    seen: set[str] = set()
    for raw in paths:
        p = Path(raw)
        try:
            key = str(p.resolve()).lower()
        except Exception:
            key = str(p).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(str(p))
    return out


# ------------------------------------------------------------------ PowerShell

def _run_powershell(exe: str, mode: str, start_dir: str, timeout: float) -> list[str]:
    """调用 WinForms 脚本弹框，结果从一个 UTF-8 临时文件里读回来。"""
    _ensure_bom(_PS_SCRIPT)
    handle, out_path = tempfile.mkstemp(prefix="vmpick_", suffix=".txt")
    os.close(handle)
    try:
        args = [
            exe,
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(_PS_SCRIPT),
            "-Mode",
            "File" if mode == MODE_FILE else "Folder",
            "-OutFile",
            out_path,
            "-Extensions",
            extension_filter(),
        ]
        if start_dir:
            args += ["-StartDir", start_dir]

        try:
            proc = subprocess.run(
                args,
                capture_output=True,
                timeout=timeout,
                **_NO_WINDOW,
            )
        except subprocess.TimeoutExpired as exc:
            raise PickerError(
                f"等待选择超时（{int(timeout)} 秒）。没看到窗口的话，"
                f"检查一下它是否被其他窗口挡住了。"
            ) from exc

        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        out_text = (proc.stdout or b"").decode("utf-8", "replace").strip()
        if proc.returncode != 0:
            raise PickerError(_friendly_ps_error(err or out_text or f"退出码 {proc.returncode}"))
        if "VM-PICKER-ERROR" in out_text:
            raise PickerError(_friendly_ps_error(out_text))

        text = Path(out_path).read_text(encoding="utf-8", errors="replace")
        return [ln.strip() for ln in text.splitlines() if ln.strip()]
    finally:
        try:
            Path(out_path).unlink(missing_ok=True)
        except Exception:
            pass


def _ensure_bom(script: Path) -> None:
    """自动给 PowerShell 脚本补 UTF-8 BOM。

    这是个真踩过的坑：Windows PowerShell 5.1 读 .ps1 时默认按**系统 ANSI 代码页**
    解码，没有 BOM 的中文会被踩成乱码。实测表现极其离谱——报错信息是
    「对象上找不到属性 TopMost」，完全指不到真正的病因（脚本中文本身），
    排查成本极高。这里每次调用前自查一次，谁用编辑器重新保存都不会再犯。
    """
    try:
        raw = script.read_bytes()
    except Exception:
        return
    if raw.startswith(b"\xef\xbb\xbf"):
        return
    try:
        script.write_bytes(b"\xef\xbb\xbf" + raw)
    except Exception:
        pass  # 只读环境下补不了，脚本全英文部分仍可用


def _friendly_ps_error(raw: str) -> str:
    """把 PowerShell 的原始报错压成一句用户能看懂、最好还能动手修的话。"""
    tail = raw.strip().splitlines()[-1] if raw.strip() else "未知错误"
    if len(tail) > 300:
        tail = tail[:300] + "…"
    return (
        "弹出文件选择窗口失败：" + tail
        + "。可在终端执行 `powershell -STA -Command "
        + '"Add-Type -AssemblyName System.Windows.Forms" '
        + "` 复现该问题。"
    )


# ------------------------------------------------------------------ tkinter 兜底

_TK_CODE = r"""
import sys
from tkinter import Tk, filedialog

root = Tk()
root.withdraw()               # 只需要承载对话框，不需要主窗口本身
root.attributes("-topmost", True)
mode, outfile, startdir, exts = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

patterns = [("视频文件", exts.split(";") if exts else ["*.*"]), ("所有文件", ["*.*"])]
paths = []
if mode == "folder":
    d = filedialog.askdirectory(
        parent=root,
        title="选择包含视频的文件夹",
        initialdir=startdir or None,
        mustexist=True,
    )
    paths = [d] if d else []
else:
    chosen = filedialog.askopenfilenames(
        parent=root,
        title="选择要导入的视频文件（可多选）",
        initialdir=startdir or None,
        filetypes=patterns,
    )
    paths = list(chosen)

root.update()
root.destroy()
with open(outfile, "w", encoding="utf-8") as f:
    f.write("\n".join(paths))
"""


def _run_tkinter(mode: str, start_dir: str, timeout: float) -> list[str]:
    handle, out_path = tempfile.mkstemp(prefix="vmpick_", suffix=".txt")
    os.close(handle)
    try:
        args = [
            sys.executable,
            "-c",
            _TK_CODE,
            MODE_FILE if mode == MODE_FILE else "folder",
            out_path,
            start_dir or "",
            extension_filter(),
        ]
        try:
            proc = subprocess.run(args, capture_output=True, timeout=timeout, **_NO_WINDOW)
        except subprocess.TimeoutExpired as exc:
            raise PickerError(f"等待选择超时（{int(timeout)} 秒）") from exc
        if proc.returncode != 0:
            detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise PickerError(
                "弹出文件选择窗口失败：" + (detail[-1] if detail else f"退出码 {proc.returncode}")
            )
        text = Path(out_path).read_text(encoding="utf-8", errors="replace")
        return [ln.strip() for ln in text.splitlines() if ln.strip()]
    finally:
        try:
            Path(out_path).unlink(missing_ok=True)
        except Exception:
            pass
