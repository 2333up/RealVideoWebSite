"""设置接口：ASR / LLM provider 切换与密钥状态查询。

密钥只回传遮掩后的形式；写入走 .env 文件，不进数据库、不进 Git。
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import config
from core.config import BACKEND_DIR, LLM_CATALOG, ASR_CATALOG, save_settings, settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

ENV_FILE = BACKEND_DIR / ".env"


@router.get("")
def get_settings():
    from providers.asr.faster_whisper import FasterWhisperProvider

    dev, compute = FasterWhisperProvider(
        model_size=settings.whisper_model_size,
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
    )._resolve_device()

    return {
        "current": settings.model_dump(),
        "llm_providers": [
            {
                **p.model_dump(),
                "key_configured": bool(config.get_secret(p.env_key)),
                "key_masked": config.mask_key(config.get_secret(p.env_key)),
            }
            for p in LLM_CATALOG
        ],
        "asr_providers": [
            {
                **p.model_dump(),
                "key_configured": bool(config.get_secret(p.env_key)),
                "key_masked": config.mask_key(config.get_secret(p.env_key)),
            }
            for p in ASR_CATALOG
        ],
        "resolved_whisper": {"device": dev, "compute_type": compute},
    }


class SettingsPatch(BaseModel):
    asr_provider: str | None = None
    whisper_model_size: str | None = None
    whisper_device: str | None = None
    whisper_compute_type: str | None = None
    cloud_asr_provider: str | None = None
    cloud_asr_model: str | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_temperature: float | None = None
    llm_max_tokens: int | None = None
    llm_timeout_s: int | None = None
    chapter_target_chars: int | None = None
    language: str | None = None


@router.patch("")
def update_settings(patch: SettingsPatch):
    for field, value in patch.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(settings, field, value)
    save_settings(settings)
    return {"ok": True, "current": settings.model_dump()}


class KeyPayload(BaseModel):
    env_key: str
    value: str
    base_url: str | None = None  # 仅 custom provider 需要


@router.post("/keys")
def set_key(payload: KeyPayload):
    """把密钥写进 backend/.env（幂等覆盖同名变量）。"""
    if not re.fullmatch(r"[A-Z0-9_]+", payload.env_key or ""):
        raise HTTPException(400, "环境变量名不合法")

    lines: list[str] = []
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()

    def upsert(name: str, value: str) -> None:
        nonlocal lines
        pattern = re.compile(rf"^\s*{re.escape(name)}\s*=")
        new_line = f"{name}={value}"
        for i, line in enumerate(lines):
            if pattern.match(line):
                lines[i] = new_line
                return
        lines.append(new_line)

    upsert(payload.env_key, payload.value.strip())
    if payload.base_url is not None:
        upsert("CUSTOM_LLM_BASE_URL", payload.base_url.strip())

    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # 同步到进程内缓存，避免必须重启才能生效
    config._ENV_CACHE[payload.env_key] = payload.value.strip()
    if payload.base_url is not None:
        config._ENV_CACHE["CUSTOM_LLM_BASE_URL"] = payload.base_url.strip()

    return {"ok": True, "masked": config.mask_key(payload.value.strip())}


# ------------------------------------------------------------------ 动态模型列表

@router.get("/llm-models")
def list_llm_models(provider_id: str):
    """从供应商的 /models 接口拉取**真实可用**的模型 id。

    为什么需要它：
        模型名会随时间失效（DeepSeek 就在 2026-07 弃用了 deepseek-chat，
        而它的现役 id 是 deepseek-flash 而非文档所写的 deepseek-v4-flash）。
        硬编码的候选列表迟早会写错，唯一可信的来源是接口本身。

    失败时返回 ok=False 并附带原因，前端回退到内置候选列表。
    """
    spec = config.get_spec("llm", provider_id)
    if spec is None:
        raise HTTPException(400, f"未知的 LLM provider：{provider_id}")

    base_url = spec.base_url
    if provider_id == "custom":
        base_url = config.get_secret("CUSTOM_LLM_BASE_URL") or ""
    if not base_url:
        return {"ok": False, "models": [], "message": "该 provider 未配置服务地址"}

    api_key = config.get_secret(spec.env_key) or ""
    if not api_key:
        return {
            "ok": False,
            "models": [],
            "message": f"未配置 {spec.env_key}，填写后才能拉取模型列表",
        }

    try:
        with httpx.Client(timeout=httpx.Timeout(30.0, connect=15.0)) as client:
            resp = client.get(
                f"{base_url.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except Exception as exc:
        return {"ok": False, "models": [], "message": f"网络请求失败：{exc}"}

    if resp.status_code >= 400:
        return {
            "ok": False,
            "models": [],
            "message": f"接口返回 {resp.status_code}：{resp.text[:200]}",
        }

    try:
        data = resp.json()
        raw = data.get("data") or data.get("models") or []
        ids: list[str] = []
        for item in raw:
            if isinstance(item, dict):
                mid = item.get("id") or item.get("name")
            else:
                mid = str(item)
            if mid:
                ids.append(str(mid))
    except Exception as exc:
        return {"ok": False, "models": [], "message": f"解析响应失败：{exc}"}

    if not ids:
        return {"ok": False, "models": [], "message": "接口未返回任何模型"}

    return {"ok": True, "models": sorted(ids), "message": f"共 {len(ids)} 个模型"}


# ------------------------------------------------------------------ 连通性自检

class TestPayload(BaseModel):
    kind: str  # llm | asr
    provider_id: str
    model: str | None = None


@router.post("/test")
def test_connection(payload: TestPayload):
    """用一次极小的真实调用验证配置是否可用。

    只返回成功/失败与原因，不打印密钥。
    """
    try:
        if payload.kind == "llm":
            from providers.llm import get_llm

            llm = get_llm(payload.provider_id, payload.model)
            # max_tokens 不能给太小：思考型模型（DeepSeek-V4）会先把配额花在
            # reasoning 上，给 16 会导致 content 为空，被误判成「连通失败」。
            # 这里给 512，足够思考+回答两个字。
            text = llm.chat(
                "你是一个连通性测试助手。", "请只回复两个字：正常", max_tokens=512
            )
            return {"ok": True, "message": f"连通正常，模型回复：{text.strip()[:40]}"}

        if payload.kind == "asr":
            spec = config.get_spec("asr", payload.provider_id)
            if spec is None:
                raise HTTPException(400, f"未知的 ASR provider：{payload.provider_id}")
            if not spec.requires_key:
                # 本地 whisper：检查依赖与模型可加载性，不实际转写
                from providers.asr import get_asr

                asr = get_asr(payload.provider_id)
                asr._get_model()
                return {"ok": True, "message": "本地 Whisper 模型加载成功"}
            return {
                "ok": True,
                "message": "云端 ASR 需实际上传音频才能验证，导入视频后即可测试",
            }

        raise HTTPException(400, f"未知的 kind：{payload.kind}")
    except HTTPException:
        raise
    except Exception as exc:
        return {"ok": False, "message": f"{type(exc).__name__}: {exc}"}
