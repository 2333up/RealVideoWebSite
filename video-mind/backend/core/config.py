"""video-mind 全局配置。

设计原则：
- 所有可切换的实现（ASR / LLM）都以「provider id + 参数字典」描述，
  新增一个 provider 只需要在注册表里加一项，不动调用方代码。
- 敏感信息（API Key）只从环境变量或 .env 读取，不写进代码、不入 Git。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------- 路径布局

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
DATA_DIR = Path(os.getenv("VIDEOMIND_DATA", PROJECT_DIR / "data"))

UPLOAD_DIR = DATA_DIR / "videos"
ARTIFACT_DIR = DATA_DIR / "artifacts"  # 音频、关键帧、转写中间产物
DB_PATH = DATA_DIR / "videomind.db"

for _d in (DATA_DIR, UPLOAD_DIR, ARTIFACT_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- 运行时设置

class Settings(BaseModel):
    """可在运行期通过 /api/settings 修改、并持久化到 settings.json 的配置。

    与密钥无关的部分放这里；API Key 一律走环境变量，避免明文落盘。
    """

    # ---- ASR ----
    asr_provider: str = "faster_whisper"
    whisper_model_size: str = Field(
        default="large-v3",
        description="faster-whisper 模型；中文场景 large-v3 精度最佳，medium 更快",
    )
    whisper_device: str = Field(default="auto", description="auto | cuda | cpu")
    whisper_compute_type: str = Field(
        default="float16", description="cuda 用 float16，cpu 用 int8"
    )
    # 云端 ASR（可选加速通道）
    cloud_asr_provider: str = Field(default="siliconflow", description="siliconflow | dashscope")
    cloud_asr_model: str = Field(default="FunAudioLLM/SenseVoiceSmall", description="云端 ASR 模型 id")

    # ---- LLM ----
    llm_provider: str = Field(default="deepseek", description="当前启用的 LLM provider id")
    # 注意：DeepSeek 已于 2026-07-24 弃用 deepseek-chat / deepseek-reasoner。
    # 现役模型的 **API name** 以 GET /models 实际返回为准（DeepSeek-V4.1-Flash 的
    # id 是 deepseek-flash，不带 v4）——官方文档与搜索结果曾给出 deepseek-v4-flash，
    # 是错的。因此默认值只信接口返回值，设置页也会动态拉取真实列表。
    llm_model: str = Field(default="deepseek-flash", description="模型名，可在设置页覆盖")
    llm_temperature: float = 0.2
    # 8192 对思考型模型不够：DeepSeek-V4 默认开启思考，reasoning 会先吃掉
    # 一大截配额，剩余部分才用于真正输出。实测同一个问题下 max_tokens=16 时
    # content 全空（16 个 token 全花在 reasoning 上）。给足余量避免输出被截断。
    llm_max_tokens: int = 16384
    llm_timeout_s: int = 300

    # ---- 管线 ----
    chapter_target_chars: int = Field(
        default=12000,
        description="分章节时每个 LLM chunk 的目标字符数；超出则走 Map-Reduce",
    )
    chunk_overlap_chars: int = 500
    language: str = Field(default="zh", description="转写语言提示，留空则自动检测")

    # ---- 关键帧 ----
    keyframe_enabled: bool = True
    keyframes_per_chapter: int = 1


def load_settings() -> Settings:
    path = DATA_DIR / "settings.json"
    if path.exists():
        try:
            return Settings.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception:
            # 配置损坏不应阻塞启动：回退到默认值，保留损坏文件便于排查
            path.rename(path.with_suffix(".json.broken"))
    return Settings()


def save_settings(s: Settings) -> None:
    (DATA_DIR / "settings.json").write_text(
        s.model_dump_json(indent=2), encoding="utf-8"
    )


settings = load_settings()


# ---------------------------------------------------------------- 密钥

def get_secret(name: str) -> str | None:
    """读取密钥：优先进程环境变量，其次 backend/.env。

    .env 只在首次调用时解析一次并缓存，避免每次请求都读盘。
    """
    val = os.getenv(name)
    if val:
        return val
    return _ENV_CACHE.get(name)


_ENV_CACHE: dict[str, str] = {}


def _load_dotenv() -> None:
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        _ENV_CACHE[k.strip()] = v.strip().strip('"').strip("'")


_load_dotenv()


# ---------------------------------------------------------------- Provider 目录

class ProviderSpec(BaseModel):
    """一个可切换 provider 的元数据，驱动设置页与后端校验。"""

    id: str
    name: str
    kind: str  # asr | llm
    base_url: str = ""
    default_model: str = ""
    #: 供设置页下拉展示的候选模型；留空表示「自由填写」
    models: list[str] = Field(default_factory=list)
    env_key: str = ""  # 对应哪个环境变量存 API Key
    note: str = ""
    requires_key: bool = True


# OpenAI 兼容接口的 provider 全部走同一套实现，这里只描述差异。
LLM_CATALOG: list[ProviderSpec] = [
    ProviderSpec(
        id="deepseek",
        name="DeepSeek",
        kind="llm",
        base_url="https://api.deepseek.com",
        # 2026-07-24 起 deepseek-chat / deepseek-reasoner 已弃用。
        # 现役 id 为 deepseek-flash 与 deepseek-v4-pro（以 /models 接口为准）。
        default_model="deepseek-flash",
        models=["deepseek-flash", "deepseek-v4-pro"],
        env_key="DEEPSEEK_API_KEY",
        note="中文能力强、成本极低，推荐默认；v4-pro 更强也更贵",
    ),
    ProviderSpec(
        id="qwen",
        name="通义千问",
        kind="llm",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model="qwen-plus",
        models=["qwen-plus", "qwen-max", "qwen-turbo"],
        env_key="DASHSCOPE_API_KEY",
        note="阿里百炼，与云端 ASR 共用同一个 Key",
    ),
    ProviderSpec(
        id="doubao",
        name="豆包",
        kind="llm",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        default_model="doubao-pro-32k",
        models=["doubao-pro-32k", "doubao-lite-32k"],
        env_key="ARK_API_KEY",
        note="火山引擎方舟平台",
    ),
    ProviderSpec(
        id="openai",
        name="OpenAI",
        kind="llm",
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o-mini",
        models=["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
        env_key="OPENAI_API_KEY",
        note="需海外网络",
    ),
    ProviderSpec(
        id="custom",
        name="自定义 (OpenAI 兼容)",
        kind="llm",
        base_url="",
        default_model="",
        env_key="CUSTOM_LLM_API_KEY",
        note="任意 OpenAI 兼容端点，如本地 Ollama / vLLM",
    ),
]

ASR_CATALOG: list[ProviderSpec] = [
    ProviderSpec(
        id="faster_whisper",
        name="本地 faster-whisper",
        kind="asr",
        default_model="large-v3",
        env_key="",
        note="数据不出本机，GPU 加速；首次运行需下载模型",
        requires_key=False,
    ),
    ProviderSpec(
        id="siliconflow",
        name="硅基流动 SenseVoice",
        kind="asr",
        base_url="https://api.siliconflow.cn/v1",
        default_model="FunAudioLLM/SenseVoiceSmall",
        env_key="SILICONFLOW_API_KEY",
        note="中文快且便宜，音频需上传",
    ),
    ProviderSpec(
        id="dashscope",
        name="阿里百炼 Paraformer",
        kind="asr",
        base_url="https://dashscope.aliyuncs.com",
        default_model="paraformer-v2",
        env_key="DASHSCOPE_API_KEY",
        note="与通义千问共用 Key",
    ),
]


def get_spec(kind: str, provider_id: str) -> ProviderSpec | None:
    catalog = LLM_CATALOG if kind == "llm" else ASR_CATALOG
    return next((p for p in catalog if p.id == provider_id), None)


def mask_key(key: str | None) -> str:
    """把密钥遮掩成 sk-abc...wxyz 形式，用于设置页回显。"""
    if not key:
        return ""
    if len(key) <= 10:
        return "*" * len(key)
    return f"{key[:6]}...{key[-4:]}"


def dump_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)
