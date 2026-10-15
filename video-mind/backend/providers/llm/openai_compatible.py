"""OpenAI 兼容协议的 LLM provider。

DeepSeek、通义千问、豆包、OpenAI、以及本地 vLLM / Ollama 的兼容端点
都实现同一套 /chat/completions 协议，因此这里只需要一个实现 + 一份目录。
"""

from __future__ import annotations

import httpx

from .base import LLMError, LLMProvider


class OpenAICompatProvider(LLMProvider):
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        provider_id: str = "custom",
        provider_name: str = "自定义",
        timeout_s: int = 300,
    ) -> None:
        super().__init__()  # 初始化 usage_log 记账容器
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.id = provider_id
        self.name = provider_name
        self.timeout_s = timeout_s

    def chat(
        self,
        system: str,
        user: str,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        purpose: str = "",
    ) -> str:
        if not self.api_key:
            raise LLMError(
                f"未配置「{self.name}」的 API Key，无法调用大模型。请先在设置页填写密钥。"
            )
        if not self.base_url:
            raise LLMError(
                f"「{self.name}」缺少服务地址（base_url），请在设置页填写后端接口地址。"
            )
        if not self.model:
            raise LLMError(f"「{self.name}」未指定模型名，请在设置页选择或填写模型。")

        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }

        try:
            with httpx.Client(timeout=httpx.Timeout(self.timeout_s, connect=30.0)) as client:
                resp = client.post(url, headers=headers, json=payload)
        except httpx.TimeoutException as exc:
            raise LLMError(
                f"调用「{self.name}」超时（>{self.timeout_s}s）。"
                "长视频分析耗时较久，可在设置页提高超时上限，或改用更快的模型。"
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"调用「{self.name}」网络失败：{exc}") from exc

        if resp.status_code >= 400:
            raise LLMError(
                f"「{self.name}」返回 {resp.status_code}：{resp.text[:400]}\n"
                "请检查 API Key、模型名、余额与服务地址是否正确。"
            )

        try:
            data = resp.json()
            choice = data["choices"][0]
            message = choice["message"]
            content = message.get("content") or ""
            finish_reason = choice.get("finish_reason")
        except Exception as exc:
            raise LLMError(
                f"解析「{self.name}」响应失败：{exc}\n原始响应前 300 字符：{resp.text[:300]}"
            ) from exc

        if not content.strip():
            # 思考型模型（如 DeepSeek-V4）会先把 token 花在 reasoning_content 上，
            # max_tokens 不够时 content 就是空的且 finish_reason == "length"。
            # 这种情况必须说清楚，否则用户只会看到一句莫名其妙的「返回空内容」。
            reasoning = message.get("reasoning_content") or ""
            if finish_reason == "length" or reasoning:
                raise LLMError(
                    f"「{self.name}」的回复被截断了（finish_reason={finish_reason}），"
                    f"思考过程已消耗 {len(reasoning)} 字符却没来得及输出正文。\n"
                    f"原因：该模型默认开启思考模式，会先占用大量 token 配额。\n"
                    f"解决：把设置页的「最大输出 token」调大（当前 {max_tokens}，建议 16384 以上）。"
                )
            raise LLMError(
                f"「{self.name}」返回了空内容（finish_reason={finish_reason}）。"
                "可能是触发了内容安全策略，请换个说法或换个模型重试。"
            )

        # 记账放在成功之后：失败的请求要么没产生费用，要么已经在上层抛错，
        # 记进去只会让统计失真。
        self._record_usage(data.get("usage"), purpose=purpose, model=data.get("model") or self.model)
        return content
