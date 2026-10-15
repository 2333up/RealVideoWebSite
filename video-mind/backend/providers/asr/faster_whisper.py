"""本地 faster-whisper 转写（CTranslate2 后端，支持 CUDA）。

模型按 size 懒加载并缓存在进程内；切换 size / device 时重建。
"""

from __future__ import annotations

import threading

from core.compat import ensure_av_compatible, ensure_cuda_dll_path
from core.config import DATA_DIR
from .base import ASRProvider, ASRError, ASRResult, Segment


class FasterWhisperProvider(ASRProvider):
    id = "faster_whisper"
    name = "本地 faster-whisper"

    _lock = threading.Lock()
    _model = None
    _model_key: tuple[str, str, str] | None = None

    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "auto",
        compute_type: str = "float16",
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type

    # ------------------------------------------------------------ 模型加载

    @staticmethod
    def _cuda_available() -> bool:
        """探测 CUDA 是否可用。

        必须用 ctranslate2 自己的 API 而不是 torch——faster-whisper 的后端是
        CTranslate2，环境里通常根本没装 torch。早期版本依赖 torch.cuda.is_available()，
        导入失败被 except 吞掉后会「静默降级到 CPU」，有显卡却跑在 CPU 上，
        转写速度差好几倍。这里改成直接问 CTranslate2。
        """
        try:
            import ctranslate2

            return ctranslate2.get_cuda_device_count() > 0
        except Exception:
            return False

    def _resolve_device(self) -> tuple[str, str]:
        """auto 模式下探测 CUDA；不可用则退到 CPU 并同步降低精度。

        返回 (device, compute_type)。CPU 上 float16 会报错，必须换成 int8。
        """
        device, compute = self.device, self.compute_type
        if device == "auto" or compute == "auto":
            has_cuda = self._cuda_available() if (device == "auto" or compute == "auto") else False
            if device == "auto":
                device = "cuda" if has_cuda else "cpu"
            if compute == "auto":
                compute = "float16" if device == "cuda" else "int8"
        if device == "cpu" and compute == "float16":
            # CTranslate2 在 CPU 上跑 float16 会直接抛错，静默降级比崩溃友好
            compute = "int8"
        return device, compute

    def _resolve_model_path(self) -> str:
        """优先用本地目录里的模型，其次才回退到按名字联网拉取。

        本地目录由 scripts/fetch_model.py 生成；走本地路径有两个好处：
        一是绕开 HF 客户端在弱网下把 model.bin 下残缺的问题，
        二是离线环境也能用。
        """
        local = DATA_DIR / "models" / "faster-whisper" / self.model_size
        if (local / "model.bin").exists():
            return str(local)
        return self.model_size

    def _get_model(self):
        device, compute = self._resolve_device()
        model_path = self._resolve_model_path()
        key = (model_path, device, compute)

        with self.__class__._lock:
            if self._model is not None and self._model_key == key:
                return self._model

            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:  # pragma: no cover - 依赖缺失提示
                raise ASRError(
                    "未安装 faster-whisper。请执行：pip install faster-whisper"
                ) from exc

            # 这两件事都必须在首次解码音频之前完成（详见 core/compat.py）：
            # 1. PyAV>=19 与 faster-whisper 1.2.1 的参数不兼容，否则直接抛 TypeError
            # 2. cuBLAS 的 DLL 搜索路径，否则一推理就报 cublas64_12.dll 找不到
            ensure_av_compatible()
            ensure_cuda_dll_path()

            try:
                model = WhisperModel(model_path, device=device, compute_type=compute)
            except Exception as exc:
                hint = ""
                if "incomplete" in str(exc).lower() or "model.bin" in str(exc).lower():
                    hint = (
                        "\n看起来 model.bin 不完整（弱网下常见）。"
                        f"请删除残留文件后重跑：python scripts/fetch_model.py {self.model_size}"
                    )
                raise ASRError(
                    f"加载 Whisper 模型失败（{model_path} / {device} / {compute}）：{exc}\n"
                    "首次运行需要下载模型，可执行："
                    f"python scripts/fetch_model.py {self.model_size}"
                    "\n网络不通时设置 HF_ENDPOINT=https://hf-mirror.com 与 HF_HUB_DISABLE_XET=1。"
                    + hint
                ) from exc

            self.__class__._model = model
            self.__class__._model_key = key
            return model

    # ------------------------------------------------------------ 转写

    def transcribe(
        self,
        audio_path: str,
        language: str = "zh",
        on_progress: "callable | None" = None,
    ) -> ASRResult:
        model = self._get_model()

        if on_progress:
            on_progress(5, f"已加载模型 {self.model_size}，开始转写…")

        lang = language or None  # None 交给 whisper 自动检测
        try:
            raw_segments, info = model.transcribe(
                audio_path,
                language=lang,
                beam_size=5,
                vad_filter=True,  # 过滤静音，显著减少空片段与时间漂移
                vad_parameters={"min_silence_duration_ms": 500},
                word_timestamps=False,
            )
            segments = [
                Segment(start=float(s.start), end=float(s.end), text=s.text.strip())
                for s in raw_segments
                if s.text and s.text.strip()
            ]
        except Exception as exc:
            raise ASRError(f"转写失败：{exc}") from exc

        if on_progress:
            on_progress(60, f"转写完成，共 {len(segments)} 个片段")

        if not segments:
            raise ASRError(
                "转写结果为空。可能原因：音频无声、语言设置不匹配，或视频本身没有语音轨道。"
            )

        return ASRResult(
            segments=segments,
            language=getattr(info, "language", language) or language,
            provider=self.id,
        )
