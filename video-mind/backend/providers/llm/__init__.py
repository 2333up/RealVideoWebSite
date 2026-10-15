"""LLM provider 工厂。

新增一家大模型 = 在 config.LLM_CATALOG 里加一条（填 base_url / 默认模型 / Key 环境变量），
本文件与调用方都不需要改。
"""

from __future__ import annotations

from core import config
from .base import (
    LLMError,
    LLMProvider,
    UsageRecord,
    extract_json_object,
    take_all_usage,
)
from .openai_compatible import OpenAICompatProvider


def get_llm(provider_id: str | None = None, model: str | None = None) -> LLMProvider:
    """按 id 构造 LLM provider。

    允许运行期覆盖 model，用于「同一 provider 下切换不同档位模型」。
    """
    pid = provider_id or config.settings.llm_provider
    spec = config.get_spec("llm", pid)
    if spec is None:
        raise LLMError(f"未知的 LLM provider：{pid}")

    api_key = config.get_secret(spec.env_key) or ""
    model_name = model or config.settings.llm_model or spec.default_model

    # 自定义端点允许运行期填写地址与模型，base_url 可能为空（此时提示用户补全）
    base_url = spec.base_url
    if pid == "custom":
        base_url = config.get_secret("CUSTOM_LLM_BASE_URL") or ""

    provider = OpenAICompatProvider(
        base_url=base_url,
        api_key=api_key,
        model=model_name,
        provider_id=pid,
        provider_name=spec.name,
        timeout_s=config.settings.llm_timeout_s,
    )
    # 记账登记由 LLMProvider.__init__ 自动完成，这里不必（也不应）重复处理
    return provider


__all__ = [
    "LLMProvider",
    "LLMError",
    "UsageRecord",
    "get_llm",
    "take_all_usage",
    "extract_json_object",
    "OpenAICompatProvider",
]
