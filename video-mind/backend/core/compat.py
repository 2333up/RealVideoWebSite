"""第三方依赖的运行时兼容层。

存在的理由：上游包之间的版本裂缝，我们既不能改上游代码，也常常无法通过
锁版本解决（Windows 上很多旧版本只有 sdist，需要本地编译 FFmpeg）。
这里每个补丁都必须满足三个条件才允许留下：

1. **行为检测，不猜版本号** —— 靠 try/except 判断能力，而不是比对版本字符串；
   版本比对在某天上游又改回去时就会误伤。
2. **幂等** —— 重复调用只生效一次（打标记 `__vm_compat__`）。
3. **最小侵入** —— 只剥离/转换出问题的参数，其余行为原样透传。

若某天上游修复了，这里的补丁会自动退化成「原样调用」，不需要回头删代码。
"""

from __future__ import annotations

import functools
import logging
import os
import sys
import sysconfig
from pathlib import Path

logger = logging.getLogger(__name__)

#: av 在不同版本间增删过的容器打开参数；faster-whisper 1.2.1 固定传入它们
_AV_OPEN_KWARGS = ("metadata_errors", "metadata_encoding")

#: CUDA 相关 DLL 的常见安放位置（相对 site-packages）
_CUDA_BIN_DIRS = ("nvidia/cublas/bin", "nvidia/cudnn/bin", "nvidia/cuda_runtime/bin")

#: 按依赖顺序预加载：cublas64_12.dll 的导入表里写着 cublasLt64_12.dll，
#: 必须先有 Lt 才能装主库
_CUDA_DLL_PRELOAD = ("cublasLt64_12.dll", "cublas64_12.dll")

_patched = False
_dll_handles: list = []  # 必须持有引用：被 GC 后 add_dll_directory 会失效


def ensure_av_compatible() -> bool:
    """让 faster-whisper 能在任意版本的 PyAV 上打开音频容器。

    背景：faster-whisper 1.2.1（截至目前仍是最新版）在 audio.py 里写死了
    `av.open(path, mode="r", metadata_errors="ignore")`。而 PyAV 从 19.0 起
    移除了 `metadata_errors`，调用直接抛
    `TypeError: open() got an unexpected keyword argument 'metadata_errors'`
    —— 这会让整条转写管线在第一步就炸掉，且报错完全看不出是依赖版本问题。

    不降级 av 的原因：PyAV 14.4.0 及以下在 PyPI 上只有 sdist，
    Windows 装它需要本地编译 FFmpeg，对普通用户不可行。

    返回是否真的打了补丁（未安装 av 或已打过则返回 False）。
    """
    global _patched
    if _patched:
        return False
    _patched = True  # 先置位，避免失败时反复重试

    try:
        import av
    except ImportError:
        logger.debug("未安装 av，跳过兼容补丁")
        return False

    original = av.open
    if getattr(original, "__vm_compat__", False):
        return False

    @functools.wraps(original)
    def _open(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except TypeError as exc:
            msg = str(exc)
            # 只在我们认识的「参数被移除」这一类报错上做降级，
            # 其余 TypeError 必须原样抛出，否则会掩盖真正的调用错误。
            if not any(k in msg for k in _AV_OPEN_KWARGS):
                raise
            dropped = [k for k in _AV_OPEN_KWARGS if k in kwargs]
            if not dropped:
                raise
            for k in dropped:
                kwargs.pop(k)
            logger.warning(
                "当前 PyAV %s 不支持 %s，已剥离后重试（faster-whisper 1.2.1 的已知兼容问题）",
                getattr(av, "__version__", "?"),
                "、".join(dropped),
            )
            return original(*args, **kwargs)

    _open.__vm_compat__ = True  # type: ignore[attr-defined]
    av.open = _open
    return True


def ensure_cuda_dll_path() -> list[str]:
    """把 site-packages 下的 CUDA DLL 目录挂进 Windows 的 DLL 搜索路径。

    为什么需要：ctranslate2 的 wheel 自带 cuDNN 9，但**不含 cuBLAS**。
    补装的 cublas64_12.dll 落在 site-packages/nvidia/cublas/bin/，
    而这个目录既不是 python.exe 所在目录、也不在 PATH 里，
    Windows 根本找不到它，于是出现那个极具误导性的报错：

        RuntimeError: Library cublas64_12.dll is not found or cannot be loaded

    注意它是在**开始推理时**才炸的——模型加载那一步完全正常，
    所以很容易被误判成「模型文件下载坏了」而白白重下 3GB。

    os.add_dll_directory 返回的句柄必须一直持有，否则会被回收失效。
    返回实际添加的目录列表（非 Windows 或目录不存在时为空）。
    """
    if not sys.platform.startswith("win") or not hasattr(os, "add_dll_directory"):
        return []

    roots = [sysconfig.get_paths().get("purelib"), sysconfig.get_paths().get("platlib")]
    dirs: list[Path] = []
    for root in roots:
        if not root:
            continue
        for rel in _CUDA_BIN_DIRS:
            d = Path(root) / Path(rel.replace("/", os.sep))
            if d.is_dir() and d not in dirs:
                dirs.append(d)
    if not dirs:
        return []

    for d in dirs:
        try:
            _dll_handles.append(os.add_dll_directory(str(d)))
        except OSError as exc:
            logger.warning("注册 CUDA DLL 目录失败 %s：%s", d, exc)
        # add_dll_directory 只影响 LoadLibraryEx，CTranslate2 用的是
        # 不带标志位的 LoadLibrary，所以再显式设一次默认搜索目录
        try:
            import ctypes

            ctypes.windll.kernel32.SetDllDirectoryW(str(d))
        except Exception as exc:  # noqa: BLE001
            logger.debug("SetDllDirectory 不可用：%s", exc)

    _preload_cuda_dlls(dirs)

    paths = [str(d) for d in dirs]
    # 部分加载路径仍依赖 PATH，双保险
    os.environ["PATH"] = os.pathsep.join(paths + [os.environ.get("PATH", "")])
    logger.info("已注册 CUDA DLL 目录：%s", "、".join(paths))
    return paths


def _preload_cuda_dlls(dirs: list[Path]) -> list[str]:
    """用完整路径主动把 cuBLAS 装进进程。

    这是最关键的兜底：CTranslate2 内部调用 `LoadLibrary("cublas64_12.dll")`
    ——**只按文件名**，而 site-packages 既不在 exe 目录、也不在 PATH 里，
    无论 add_dll_directory 还是 SetDllDirectory 都可能不生效。

    但 Windows 的 LoadLibrary 会先查「本进程已加载模块列表」（按基名匹配），
    所以只要我们提前用完整路径把它装进去，之后按名字的调用必然命中。

    返回实际加载成功的 DLL 名。
    """
    import ctypes

    loaded: list[str] = []
    for name in _CUDA_DLL_PRELOAD:
        for d in dirs:
            p = d / name
            if not p.exists():
                continue
            try:
                # 按完整路径加载时，Windows 会顺带在**该文件所在目录**里
                # 找它的依赖，所以 Lt 与主库放同一目录即可互相找到
                ctypes.CDLL(str(p))
                loaded.append(name)
                break
            except OSError as exc:
                logger.warning("预加载 %s 失败：%s", p, exc)
    return loaded
