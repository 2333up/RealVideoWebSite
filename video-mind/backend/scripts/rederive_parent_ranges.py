"""把库里已有的思维导图按最新规则重排一遍时间。

两次规则变更都靠它兜底：
  1. 2026-10-18 起「有子节点的节点，时间范围由子节点决定」
     （起点取最早、终点取最晚）。之前存下的树里父节点没有 start/end。
  2. 同一天稍后：**兄弟节点按顺序瓜分父区间**。老数据的叶子终点是拿
     「所在章节的终点」补的，同一章的兄弟会全部结束在同一秒、区间层层重叠。

这个脚本逐棵树跑一遍 normalize_time_layout（含排序、补终点、派生、瓜分），
变了就写回。不动章节、不动节点 id、不动叶子自己的起点。

用法：
    cd video-mind/backend
    python scripts/rederive_parent_ranges.py          # 只报数，不落库
    python scripts/rederive_parent_ranges.py --apply  # 真的写回
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.database import SessionLocal  # noqa: E402
from core.models import Chapter, MindMap  # noqa: E402
from pipeline import mindmap as mindmap_ops  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的写回数据库")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        changed: list[tuple[int, str]] = []
        total = 0
        for mm in db.query(MindMap).all():
            total += 1
            tree = copy.deepcopy(mm.tree or {})
            before = json.dumps(tree, sort_keys=True, ensure_ascii=False)

            chapters = [
                {"start": c.start, "end": c.end}
                for c in db.query(Chapter).filter(Chapter.video_id == mm.video_id).all()
            ]
            mindmap_ops.normalize_time_layout(tree, mindmap_ops._chapter_bounds(chapters))

            after = json.dumps(tree, sort_keys=True, ensure_ascii=False)
            if before == after:
                continue
            root = tree if isinstance(tree, dict) else {}
            changed.append((mm.video_id, f"{root.get('start')}–{root.get('end')}"))
            if args.apply:
                # 必须赋新对象：原地改 dict 不会被 SQLAlchemy 认作脏数据
                mm.tree = tree

        print(f"扫描 {total} 棵树，需要更新 {len(changed)} 棵")
        for vid, rng in changed:
            print(f"  video_id={vid}  根节点范围 -> {rng}")
        if args.apply:
            db.commit()
            print("已写回")
        elif changed:
            print("（这是预告，加 --apply 才会写库）")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
