# -*- coding: utf-8 -*-
"""四边吸附自检（离屏运行，不需要真的弹出窗口）。

把桌宠摆到屏幕四个边缘附近各走一遍「松手 → 吸附」，断言：
  - 选中的边是最近的边（而不是固定判左右）
  - 窗口确实紧贴那条边
  - 沿边的落点被夹在可用区内，不会露出半边在屏幕外
  - 上/下/侧边各自的探头素材被正确选中

用法：
  python test_dock4.py
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "Jingxi")

from PyQt6.QtWidgets import QApplication  # noqa: E402
from PyQt6.QtGui import QGuiApplication  # noqa: E402

import pet_app  # noqa: E402

FAILS = []
OKS = []


def check(cond, label, extra=""):
    (OKS if cond else FAILS).append(label + (f"  {extra}" if extra else ""))
    print(("  ok   " if cond else "  FAIL ") + label + (f"  {extra}" if extra else ""))


def main():
    app = QApplication(sys.argv)
    cfg_path = os.path.join(BUILD, "pet_config.json")
    cfg = pet_app.load_cfg(cfg_path) if hasattr(pet_app, "load_cfg") else None
    if cfg is None:
        import json
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    pet_app.app_dir = lambda: BUILD  # 让素材从构建目录读（源码运行时的默认路径不同）

    w = pet_app.PetWidget(cfg)
    g = w._screen_geo()
    print(f"[test] 可用区 {g.left()},{g.top()} {g.width()}x{g.height()}")

    # ---- 素材装载 ----
    check(isinstance(cfg.get("peek"), dict), "配置 peek 是字典（四边）", str(cfg.get("peek")))
    check("side" in w.peek_pix, "侧边探头已装载", str(w.peek_pix.get("side").size()))
    check("top" in w.peek_pix, "上边探头已装载", str(w.peek_pix.get("top").size()))
    check("bottom" in w.peek_pix, "下边探头已装载", str(w.peek_pix.get("bottom").size()))
    check(w._peek_for("left") is w._peek_for("right"), "左右共用同一张侧边探头")
    check(w._peek_for("top") is not w._peek_for("left"), "上边用独立素材")
    check(w._peek_for("bottom") is not w._peek_for("top"), "下边用独立素材")

    # ---- 四条边各吸附一次 ----
    cases = [
        ("left", g.left() + 2, 300),
        ("right", g.right() - w.width() - 2, 500),
        ("top", 400, g.top() + 1),
        ("bottom", 600, g.bottom() - w.height() - 1),
    ]
    for edge, x, y in cases:
        w._dock = None
        w._apply_scale()               # 先回到站立尺寸，再摆位
        w.move(x, y)
        got = w._try_dock()
        check(got is True, f"{edge}: 触发吸附")
        check(w._dock is not None and w._dock["edge"] == edge,
              f"{edge}: 选中正确的边", str(w._dock))
        if edge == "left":
            check(w.x() == g.left(), f"{edge}: 紧贴左边", f"x={w.x()}")
            check(w.y() == g.top() + 300, f"{edge}: 保留纵向落点", f"y={w.y()}")
        elif edge == "right":
            check(w.x() + w.width() == g.right() + 1, f"{edge}: 紧贴右边",
                  f"right={w.x() + w.width()}")
            check(w.y() == g.top() + 500, f"{edge}: 保留纵向落点", f"y={w.y()}")
        elif edge == "top":
            check(w.y() == g.top(), f"{edge}: 紧贴顶边", f"y={w.y()}")
            check(w.x() == g.left() + 400, f"{edge}: 保留横向落点", f"x={w.x()}")
        else:
            check(w.y() + w.height() == g.bottom() + 1, f"{edge}: 紧贴底边",
                  f"bottom={w.y() + w.height()}")
            check(w.x() == g.left() + 600, f"{edge}: 保留横向落点", f"x={w.x()}")
        # 窗口必须完整在可用区内
        check(w.x() >= g.left() and w.y() >= g.top()
              and w.x() + w.width() <= g.right() + 1
              and w.y() + w.height() <= g.bottom() + 1,
              f"{edge}: 完整落在可用区内")

    # ---- 角落越界：落点要被夹住 ----
    w._dock = None
    w._apply_scale()
    w.move(g.left() + 3, g.bottom() - 10)      # 左下角，纵向落点几乎超出屏幕底
    check(w._try_dock() is True, "角落: 触发吸附")
    check(w.y() + w.height() <= g.bottom() + 1, "角落: 纵向落点被夹住",
          f"bottom={w.y() + w.height()} 可用底={g.bottom()}")

    # ---- 离边太远：不吸附 ----
    w._dock = None
    w._apply_scale()
    cx = g.left() + (g.width() - w.width()) // 2
    cy = g.top() + (g.height() - w.height()) // 2
    w.move(cx, cy)
    check(w._try_dock() is False, "屏幕中央: 不吸附")

    # ---- 出边：回到屏幕里并说话 ----
    w._dock = None
    w._apply_scale()
    w.move(g.left() + 2, 300)
    w._try_dock()
    before = (w.x(), w.y())
    w._undock()
    check(w._dock is None, "出边: 解除贴边状态")
    check(w.x() > before[0] or w.y() != before[1], "出边: 位置向内移动",
          f"{before} -> ({w.x()}, {w.y()})")

    app.quit()
    print(f"\n[test] 通过 {len(OKS)} 项，失败 {len(FAILS)} 项")
    for f in FAILS:
        print("  - " + f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
