# -*- coding: utf-8 -*-
"""从角色三视图里提取多个全身姿态，做成桌宠可切换的帧。

三视图是同一个人物的不同姿势，直接当独立图片用会有两个坑：
  1. 每张图自带白底 —— 桌面上一贴就是一个白方块；
  2. 各自尺寸/基线不同 —— 切换姿态时人物会突然跳动、大小不一致。

所以这里做三件事：**抠白底 → 统一缩放到同一高度 → 按脚底居中贴到同尺寸画布**。
对齐之后，切换帧只换像素内容，位置和比例完全不变。

用法：
  python make_poses.py --sheet assets/deepseek-chan-sheet.jpg --out build/DeepseekChan/frames
  python make_poses.py --sheet ... --out ... --preview      # 额外输出深底预览拼图
"""
import argparse
import json
import os
from collections import deque

from PIL import Image, ImageDraw, ImageFilter

# 三视图的四个人物所在横条（相对图片高度的比例），避开标题与底部说明区
BAND_TOP, BAND_BOTTOM = 0.115, 0.533
TARGET_H = 820          # 统一后的角色高度（px），够大且有缩放余量
MIN_COL_RUN = 20        # 相邻内容的合并阈值：小于这个宽度的间隙视为同一张图的一部分
TOL = 18                # 背景色容差


def content_mask(im):
    """偏暗或彩色 → 内容；接近白底 → 背景。"""
    g = im.convert("L")
    return g.point(lambda v: 255 if v < 243 else 0)


def column_runs(mask, min_len):
    """按列投影切出各个人物。用 resize 求列均值，避免逐像素 Python 循环。"""
    w = mask.width
    col = list(mask.resize((w, 1), Image.BOX).getdata())
    runs, start = [], None
    for x, v in enumerate(col):
        if v > 1 and start is None:
            start = x
        elif v <= 1 and start is not None:
            if x - start >= min_len:
                runs.append((start, x))
            start = None
    if start is not None and w - start >= min_len:
        runs.append((start, w))
    return runs


def cutout(im, tol=TOL):
    """边界泛洪抠白底。

    种子取**所有**接近背景色的边框像素（不只看四角）：人物触边、四角颜色
    不同的图也能抠。只清理与边框连通的像素，所以衣服/头发内部的白色不会丢。
    """
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()

    def near(c):
        return (abs(c[0] - 255) <= tol and abs(c[1] - 255) <= tol
                and abs(c[2] - 255) <= tol)

    seen = bytearray(w * h)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near(px[x, y]):
                dq.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if near(px[x, y]):
                dq.append((x, y))

    while dq:
        x, y = dq.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        c = px[x, y]
        if not near(c):
            continue
        px[x, y] = (c[0], c[1], c[2], 0)
        dq.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    alpha = im.getchannel("A").filter(ImageFilter.MinFilter(3)).filter(
        ImageFilter.GaussianBlur(0.6))
    im.putalpha(alpha)
    box = im.getbbox()
    return im.crop(box) if box else im


def make_icon(src, dst):
    im = src.convert("RGBA")
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    canvas.save(dst, format="ICO",
                sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--out", required=True, help="构建目录（frames 子目录写这里）")
    ap.add_argument("--name", default="鲸汐")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--target-h", type=int, default=TARGET_H)
    args = ap.parse_args()

    sheet = Image.open(args.sheet).convert("RGB")
    W, H = sheet.size
    band = sheet.crop((0, int(H * BAND_TOP), W, int(H * BAND_BOTTOM)))
    bm = content_mask(band)
    runs = column_runs(bm, MIN_COL_RUN)
    print(f"[poses] 面板高度 {H}，检测到 {len(runs)} 个姿态：")
    for i, (a, b) in enumerate(runs):
        print(f"  #{i} x {a}..{b} (宽 {b - a})")

    poses = []
    for a, b in runs:
        # 再按行收紧一次，去掉上下空白
        piece = band.crop((a, 0, b, band.height))
        pm = content_mask(piece)
        box = pm.getbbox()
        if box is None:
            continue
        piece = piece.crop(box)
        cut = cutout(piece)
        poses.append(cut)
        print(f"  裁切后 {cut.size}")

    if not poses:
        print("[poses] ERROR=没有提取到任何姿态")
        return 1

    # 统一缩放：以最高的姿态为基准，其余按同一比例缩放（保持彼此相对大小正确）
    max_h = max(p.height for p in poses)
    scale = args.target_h / max_h
    scaled = [(p.resize((max(1, round(p.width * scale)), max(1, round(p.height * scale))),
                        Image.LANCZOS)) for p in poses]

    canvas_w = max(p.width for p in scaled)
    canvas_h = max(p.height for p in scaled)
    frames_dir = os.path.join(args.out, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    for i, p in enumerate(scaled):
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        # 底部居中对齐：脚踩在同一水平线上，切换姿态不会「跳」
        canvas.alpha_composite(p, ((canvas_w - p.width) // 2, canvas_h - p.height))
        dst = os.path.join(frames_dir, f"f{i:03d}.png")
        canvas.save(dst)
        print(f"[poses] {dst}  {canvas.size}")

    if args.preview:
        pad = 20
        cols = len(scaled)
        sheet_w = canvas_w * cols + pad * (cols + 1)
        sheet_h = canvas_h + pad * 2
        prev = Image.new("RGBA", (sheet_w, sheet_h), (32, 40, 56, 255))
        for i, p in enumerate(scaled):
            prev.alpha_composite(p, (pad + i * (canvas_w + pad), pad + canvas_h - p.height))
        prev = prev.convert("RGB")
        prev.save(os.path.join(args.out, "_preview.png"))
        print(f"[poses] 预览 {os.path.join(args.out, '_preview.png')}")

    # ---- 配置与图标：让构建目录可以直接交给 build_exe.py ----
    n = len(scaled)
    last = n - 1
    poses = {
        "idle": 0,
        # 三视图顺序：0 正 / 1 侧 / 2 背 / 3 演唱
        "drag": 1 if n > 1 else 0,
        "double": 2 if n > 2 else last,
        "poke": last,
        "pat": last,
    }
    cfg = {
        "name": args.name,
        "image": [f"frames/f{i:03d}.png" for i in range(n)],
        "mode": "poses",
        "animation": "breathe",
        "speed": 1.0,
        "scale": 1.0,
        "pos": None,
        "autostart": False,
        "poses": poses,
    }
    with open(os.path.join(args.out, "pet_config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    make_icon(scaled[0], os.path.join(args.out, "icon.ico"))
    print(f"[poses] 配置 pet_config.json（mode=poses, {n} 帧）与 icon.ico")
    print(f"[poses] 画布 {canvas_w}x{canvas_h}，共 {n} 帧")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
