"""ASR provider 工厂。

对外只暴露 get_asr()：调用方拿到的永远是 ASRProvider，不关心背后是本地还是云端。
"""

from __future__ import annotations

from core import config
from .base import ASRError, ASRProvider, ASRResult, Segment
from .cloud import CloudASRProvider
from .faster_whisper import FasterWhisperProvider


def get_asr(provider_id: str | None = None) -> ASRProvider:
    """按 id 构造 ASR provider。

    参数来自运行期设置（config.settings），密钥来自环境变量。
    """
    pid = provider_id or config.settings.asr_provider
    spec = config.get_spec("asr", pid)

    if pid == "faster_whisper":
        return FasterWhisperProvider(
            model_size=config.settings.whisper_model_size,
            device=config.settings.whisper_device,
            compute_type=config.settings.whisper_compute_type,
        )

    if spec is None:
        raise ASRError(f"未知的 ASR provider：{pid}")

    api_key = config.get_secret(spec.env_key)
    if not api_key:
        raise ASRError(
            f"未配置「{spec.name}」的 API Key。请在 backend/.env 中设置 {spec.env_key}，"
            "或先改用本地 faster-whisper 转写。"
        )

    return CloudASRProvider(
        base_url=spec.base_url,
        api_key=api_key,
        model=config.settings.cloud_asr_model or spec.default_model,
        provider_id=pid,
    )


__all__ = [
    "ASRProvider",
    "ASRResult",
    "ASRError",
    "Segment",
    "get_asr",
    "FasterWhisperProvider",
    "CloudASRProvider",
]
