# -*- coding: utf-8 -*-
"""四边探头形态渲染取样：把每条边的贴边画面渲染出来存成 PNG，肉眼确认没有残留边缘线。

与 test_dock4.py 互补：那个验几何（位置对不对），这个验画面（图干不干净）。

用法：
  python shoot_dock4.py --out <输出目录>
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "Jingxi")

from PyQt6.QtWidgets import QApplication  # noqa: E402

import pet_app  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(BUILD, "dock-shots"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    app = QApplication(sys.argv)
    pet_app.app_dir = lambda: BUILD
    with open(os.path.join(BUILD, "pet_config.json"), encoding="utf-8") as f:
        cfg = json.load(f)

    w = pet_app.PetWidget(cfg)
    w.show()
    app.processEvents()

    for edge in ("left", "right", "top", "bottom"):
        w._dock_to(edge, 200)
        app.processEvents()
        pm = w.grab()
        path = os.path.join(args.out, f"dock-{edge}.png")
        pm.save(path)
        # 统计最靠边那一列/行的不透明像素占比：
        # 若「墙的边缘线」没擦干净，贴边那一列会是一条近乎满高的实线（占比极高）。
        img = pm.toImage()
        if edge in ("left", "right"):
            col = 0 if edge == "left" else img.width() - 1
            total = img.height()
            opaque = sum(1 for y in range(total) if img.pixelColor(col, y).alpha() > 24)
        else:
            row = 0 if edge == "top" else img.height() - 1
            total = img.width()
            opaque = sum(1 for x in range(total) if img.pixelColor(x, row).alpha() > 24)
        print(f"[shot] {edge:6s} {img.width()}x{img.height()}  "
              f"贴边列/行不透明占比 {opaque}/{total} = {opaque / max(1, total):.0%}  -> {path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
