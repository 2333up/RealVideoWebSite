"""LLM provider 抽象层。

全项目只用两个能力：chat() 自由文本，chat_json() 强制结构化输出。
后者是章节与思维导图的地基——拿不到合法 JSON 就直接失败，不猜、不补。
"""

from __future__ import annotations

import abc
import json
import re
from dataclasses import dataclass


class LLMError(RuntimeError):
    """LLM 调用失败。message 需可直接展示给用户。"""


@dataclass
class UsageRecord:
    """一次 LLM 调用的 token 消耗。

    purpose 记录这次调用是干什么用的（分章节 / 思维导图 / 连通性测试），
    因为一次视频分析会打很多次模型，没有 purpose 就没法知道钱花在哪一步。
    """

    purpose: str = ""
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    #: 部分服务商会把命中缓存的 token 单独计，没有则为 0
    cached_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def to_dict(self) -> dict:
        return {
            "purpose": self.purpose,
            "model": self.model,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cached_tokens": self.cached_tokens,
            "total_tokens": self.total_tokens,
        }


#: 全局用量账本。
#:
#: **为什么不能用 WeakSet 存 provider 实例**：管线每一步都是
#: `llm = get_llm()` 新建实例、用完即弃，函数一返回实例就可能被 GC，
#: 弱引用随即失效，挂在实例上的 usage_log 一起消失——等管线在阶段边界
#: 来取时已经空了。这个 bug 在单测里查不出来（局部变量还持有强引用），
#: 只在真实跑一次分析时才暴露为「用量永远是 0」。
#:
#: 用量是**数据**而不是实例状态，所以必须在调用发生的那一刻就写进全局
#: 账本，而不是寄存在实例上等人来取。账本里只有几十字节的小对象，
#: 且每次落库都会被取走，不会无限增长（另设上限兜底）。
_LEDGER: list[UsageRecord] = []

#: 账本上限：极端情况下（长时间没人取）丢弃最早的记录，防止无界增长
_LEDGER_MAX = 10000


def take_all_usage() -> list[UsageRecord]:
    """取走全局账本里累计的用量（取后清空）。

    管线在阶段边界调用它落库：一次分析会打许多次模型
    （长视频分章节是 Map-Reduce），逐步落库才能看出每步各花多少。
    """
    global _LEDGER
    taken, _LEDGER = _LEDGER, []
    return taken


class LLMProvider(abc.ABC):
    id: str = ""
    name: str = ""

    def __init__(self) -> None:
        #: 实例级记录，主要用于单测断言；跨实例的统计走全局账本
        self.usage_log: list[UsageRecord] = []

    # ------------------------------------------------------------ 用量记账

    def _record_usage(self, usage: dict | None, purpose: str, model: str = "") -> UsageRecord:
        """把一次调用的 usage 记进日志。

        各家返回的字段名不完全一致（有的给 prompt_tokens，有的给 input_tokens），
        这里做宽松解析——**取不到就记 0，绝不让记账逻辑把主流程搞崩**。
        """
        usage = usage or {}
        rec = UsageRecord(
            purpose=purpose,
            model=model or self._current_model(),
            prompt_tokens=_pick_int(usage, "prompt_tokens", "input_tokens", "prompt_token_count"),
            completion_tokens=_pick_int(
                usage, "completion_tokens", "output_tokens", "completion_token_count"
            ),
            cached_tokens=_pick_int(
                usage.get("prompt_tokens_details", {}) if isinstance(usage, dict) else {},
                "cached_tokens",
            ),
        )
        self.usage_log.append(rec)
        # 同时写全局账本：实例随时可能被 GC，账本不会
        _LEDGER.append(rec)
        if len(_LEDGER) > _LEDGER_MAX:
            del _LEDGER[: len(_LEDGER) - _LEDGER_MAX]
        return rec

    def _current_model(self) -> str:
        return getattr(self, "model", "")

    def take_usage(self) -> list[UsageRecord]:
        """取走并清空累计记录。"""
        taken, self.usage_log = self.usage_log, []
        return taken

    @abc.abstractmethod
    def chat(
        self,
        system: str,
        user: str,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        purpose: str = "",
    ) -> str:
        ...

    def chat_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.2,
        max_tokens: int = 8192,
        purpose: str = "",
    ) -> dict:
        """调用 LLM 并解析出 JSON 对象。

        兼容三种现实情况：
        1. 服务端支持 response_format=json_object，直接返回干净 JSON
        2. 模型把 JSON 包在 ```json 代码块里
        3. 前面夹杂了几句废话，需要抠出第一个 {...} 块
        """
        raw = self.chat(
            system, user, temperature=temperature, max_tokens=max_tokens, purpose=purpose
        )
        return extract_json_object(raw)


def _pick_int(d: dict, *keys: str) -> int:
    """按候选键名顺序取第一个有意义的值；取不到返回 0。"""
    if not isinstance(d, dict):
        return 0
    for k in keys:
        v = d.get(k)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            return int(v)
        if isinstance(v, str) and v.strip().isdigit():
            return int(v.strip())
    return 0


# ------------------------------------------------------------------ JSON 提取

def extract_json_object(text: str) -> dict:
    """从 LLM 输出中稳健地抠出第一个完整 JSON 对象。

    LLM 是概率模型，输出格式不可信，这里必须做防御式解析。
    """
    if not text or not text.strip():
        raise LLMError("LLM 返回空内容。")

    cleaned = text.strip()

    # 情况 2：去掉 ```json / ``` 围栏
    fence = re.search(r"```(?:json)?\s*(.*?)```", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()
    else:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned).strip()

    try:
        obj = json.loads(cleaned)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    # 情况 3：扫描出第一个花括号配平的片段
    start = cleaned.find("{")
    if start == -1:
        raise LLMError(f"LLM 未返回 JSON 结构。前 300 字符：{cleaned[:300]}")

    depth, in_str, escape = 0, False, False
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = cleaned[start : i + 1]
                try:
                    obj = json.loads(candidate)
                    if isinstance(obj, dict):
                        return obj
                except json.JSONDecodeError:
                    break

    raise LLMError(
        "无法从 LLM 输出中解析出合法 JSON。前 500 字符：\n" + cleaned[:500]
    )
