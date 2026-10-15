"""独立验证脚本：测试小红书浏览器自动化搜索是否真正打通 X-s。

用法：
    python test_xiaohongshu_browser.py "关键词"

优先读取数据库里保存的小红书账号 Cookie（登录态），缺失时以游客态尝试。
"""

import asyncio
import sys

sys.path.insert(0, ".")

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models.account import PlatformAccount  # noqa: E402
from app.platforms.xiaohongshu.browser_search import XiaohongshuBrowserSearch  # noqa: E402


async def main() -> None:
    keyword = sys.argv[1] if len(sys.argv) > 1 else "美食"
    print(f"正在用浏览器自动化搜索小红书「{keyword}」…")

    # 读取数据库里的小红书登录态
    credentials = None
    try:
        engine = create_engine("sqlite:///data/app.db")
        with Session(engine) as db:
            account = db.scalars(
                select(PlatformAccount).where(PlatformAccount.platform == "xiaohongshu")
            ).first()
            if account:
                credentials = account.get_credentials()
                print("已读取小红书账号 Cookie（登录态）")
    except Exception as exc:  # noqa: BLE001
        print(f"读取 Cookie 失败（将以游客态尝试）: {exc}")

    browser = XiaohongshuBrowserSearch()
    try:
        items = await browser.search(keyword, credentials=credentials, max_items=20)
        if not items:
            print("[FAIL] 未捕获到任何结果（可能被风控，可重试）")
            return
        print(f"[OK] 命中 {len(items)} 条：")
        for it in items[:10]:
            print(f"  - [{it.kind}] {it.title[:40]} | 作者 {it.author.name} | 赞 {it.like_count}")
    finally:
        await browser.aclose()


if __name__ == "__main__":
    asyncio.run(main())
