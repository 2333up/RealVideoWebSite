"""YouTube 适配器翻页与新卡片结构的联调验证脚本。

用途
----
YouTube 的页面结构变动频繁（本项目已经踩过两次：2025 起搜索结果从
videoRenderer 换成 lockupViewModel；SSR 首屏不再内嵌翻页游标），
靠单元测试防不住 —— 这些改动只有在**真实网络响应**上才暴露。

所以这里刻意不去 mock httpx，而是真打 YouTube：

    cd backend
    python scripts/verify_youtube_search.py

需要 .env 里的 YOUTUBE_PROXY 指向一个真正能出网的代理。
跑之前先确认代理可用，否则只会看到满屏 ConnectError —— 那不是代码问题。

输出会逐页打印条数与首条标题；正常情况下 page1..pageN 都应有内容，
最后一页之后返回空（表示翻到底了）。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# 允许直接 `python scripts/verify_youtube_search.py` 运行
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.platforms.base import SearchParams  # noqa: E402
from app.platforms.youtube.adapter import YouTubeAdapter  # noqa: E402

KEYWORD = "python tutorial"
PAGES = 3
PAGE_SIZE = 20


async def main() -> int:
    adapter = YouTubeAdapter()
    try:
        for page in range(1, PAGES + 1):
            try:
                items = await adapter.search(
                    SearchParams(
                        keyword=KEYWORD,
                        kinds=["video"],
                        page=page,
                        page_size=PAGE_SIZE,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - 验证脚本需要看到原始错误
                print(f"page{page}: 请求失败 -> {exc}")
                return 1

            if not items:
                print(f"page{page}: 0 条（若之前页都有内容，说明已翻到底）")
                continue

            first = items[0]
            print(
                f"page{page}: {len(items)} 条 | {first.title[:45]} | "
                f"播放 {first.view_count} | 时长 {first.duration}s | "
                f"作者 {first.author.name or '-'}"
            )
            missing_cover = sum(1 for i in items if not i.cover_url)
            missing_views = sum(1 for i in items if not i.view_count)
            if missing_cover or missing_views:
                print(
                    f"  ⚠ 有字段缺失：封面 {missing_cover} 条、播放量 {missing_views} 条"
                    "（可能是 YouTube 又改了卡片结构）"
                )
        return 0
    finally:
        await adapter.aclose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
