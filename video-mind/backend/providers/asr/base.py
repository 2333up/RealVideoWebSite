"""ASR provider 抽象层。

新增一种转写服务 = 实现本文件里的 ASRProvider 并注册，调用方零改动。
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass
class Segment:
    """一个带时间戳的转写片段。整条管线的时间基准（秒，浮点）。"""

    start: float
    end: float
    text: str

    def to_dict(self) -> dict:
        return {"start": round(self.start, 2), "end": round(self.end, 2), "text": self.text}


@dataclass
class ASRResult:
    segments: list[Segment] = field(default_factory=list)
    language: str = ""
    provider: str = ""

    @property
    def full_text(self) -> str:
        return "".join(s.text for s in self.segments)

    @property
    def duration(self) -> float:
        return self.segments[-1].end if self.segments else 0.0


class ASRError(RuntimeError):
    """转写失败。message 必须能直接展示给用户（含可行动的修复建议）。"""


class ASRProvider(abc.ABC):
    """转写服务统一接口。"""

    #: 注册表里的唯一 id，与 config.ASR_CATALOG 对应
    id: str = ""
    name: str = ""

    @abc.abstractmethod
    def transcribe(
        self,
        audio_path: str,
        language: str = "zh",
        on_progress: "callable | None" = None,
    ) -> ASRResult:
        """把音频转成带时间戳的片段列表。

        on_progress(percent: int, message: str) 用于长任务进度回传。
        """

    def close(self) -> None:  # 可选：释放模型显存
        pass
