"""云端 ASR（OpenAI 兼容 /audio/transcriptions 协议）。

关于时间戳的重要说明
--------------------
本项目的一切交互都建立在「精确时间戳」之上，而多数云端 ASR 只返回纯文本。
这里的实现遵循一条硬规矩：

    能拿到 segments 就用；拿不到就如实报错，绝不按比例估算时间戳。

估算出来的时间戳会让「点导图跳播放器」变成随机跳转，那比没有更糟。
支持返回 segments 的服务：OpenAI whisper-1、Groq whisper-large-v3，
以及任何实现了 verbose_json 的 OpenAI 兼容端点。
"""

from __future__ import annotations

from pathlib import Path

import httpx

from .base import ASRProvider, ASRError, ASRResult, Segment

# 单次上传的体积上限（字节）。超过则提示改用本地转写或先切片。
MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB


class CloudASRProvider(ASRProvider):
    id = "cloud"
    name = "云端 ASR"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        provider_id: str = "cloud",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.id = provider_id

    def transcribe(
        self,
        audio_path: str,
        language: str = "zh",
        on_progress: "callable | None" = None,
    ) -> ASRResult:
        path = Path(audio_path)
        if not path.exists():
            raise ASRError(f"音频文件不存在：{path}")

        size = path.stat().st_size
        if size > MAX_UPLOAD_BYTES:
            raise ASRError(
                f"音频文件 {size / 1024 / 1024:.0f} MB 超出云端上传上限 "
                f"{MAX_UPLOAD_BYTES / 1024 / 1024:.0f} MB。请改用本地 faster-whisper 转写。"
            )

        if on_progress:
            on_progress(5, f"上传音频到 {self.id}（{size / 1024 / 1024:.1f} MB）…")

        url = f"{self.base_url}/audio/transcriptions"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        # timestamp_granularities 是 OpenAI 官方扩展字段，非兼容端点会忽略它
        data = {
            "model": self.model,
            "response_format": "verbose_json",
            "timestamp_granularities[]": "segment",
        }
        if language:
            data["language"] = language

        try:
            with path.open("rb") as fh:
                files = {"file": (path.name, fh, "application/octet-stream")}
                with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
                    resp = client.post(url, headers=headers, data=data, files=files)
        except httpx.HTTPError as exc:
            raise ASRError(f"调用云端 ASR 网络失败：{exc}") from exc

        if resp.status_code >= 400:
            raise ASRError(
                f"云端 ASR 返回 {resp.status_code}：{resp.text[:400]}\n"
                "请检查 API Key、模型名与账户余额。"
            )

        try:
            payload = resp.json()
        except Exception as exc:
            raise ASRError(f"云端 ASR 返回非 JSON 内容：{resp.text[:300]}") from exc

        if on_progress:
            on_progress(50, "云端转写完成，解析时间戳…")

        raw_segments = payload.get("segments")
        if not raw_segments:
            text = payload.get("text", "")
            raise ASRError(
                f"「{self.model}」未返回时间戳片段（服务端只给了纯文本，共 {len(text)} 字）。\n"
                "本项目的章节跳转依赖精确时间戳，拒绝用估算值填充。\n"
                "解决办法：改用本地 faster-whisper，或换用支持 verbose_json 的端点"
                "（如 OpenAI whisper-1、Groq whisper-large-v3）。"
            )

        segments: list[Segment] = []
        for s in raw_segments:
            txt = (s.get("text") or "").strip()
            if not txt:
                continue
            segments.append(
                Segment(start=float(s.get("start", 0.0)), end=float(s.get("end", 0.0)), text=txt)
            )

        if not segments:
            raise ASRError("云端 ASR 返回的片段全部为空文本。")

        return ASRResult(
            segments=segments,
            language=payload.get("language") or language,
            provider=self.id,
        )
