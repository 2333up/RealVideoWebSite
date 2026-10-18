# -*- coding: utf-8 -*-
"""把「探头」姿态处理成贴边素材（桌面 PNG + 网页 WebP）。

生成图里带了一条「墙的边缘」竖线（浅灰渐变）。贴到屏幕/视口边缘时这条线会
露在外面，很突兀，所以先把它抹掉再抠图 —— 抹掉后素材的左边界就是人物的
裁切边界，正好与屏幕边缘重合。

用法：
  python make_peek.py --src assets/gen/peek.png \
      --png build/Jingxi/peek.png --webp ../frontend/src/assets/pet/peek.webp
"""
import argparse
import os
from collections import deque

from PIL import Image, ImageDraw, ImageFilter

TOL = 40


def find_line(im, x_from=0.2, x_to=0.45):
    """在左侧 20%~45% 区域找那条竖线：中性灰、纵向连续。"""
    w, h = im.size
    px = im.load()
    best_x, best_score = None, 0
    for x in range(int(w * x_from), int(w * x_to)):
        score = 0
        for y in range(0, h, 3):
            r, g, b = px[x, y]
            if abs(r - g) < 10 and abs(g - b) < 10 and 185 < r < 232:
                score += 1
        if score > best_score:
            best_x, best_score = x, score
    return best_x, best_score / (h / 3)


def erase_line(im, x, half=14):
    """抹掉竖线及其淡出渐变。

    线是**带蓝调的浅灰**（约 188,188,207），不是纯中性灰 —— 最早按
    |g-b|<10 判定，b 比 r 高 19 就漏掉了，结果残留一条浅灰竖条贴在左边缘。
    这里改成「亮度高 + 红绿接近 + 蓝不高于红太多」，避开了皮肤
    （r 明显大于 g，差值 >25 会被排除）和深色发丝。
    """
    px = im.load()
    w, h = im.size
    removed = 0
    for xx in range(max(0, x - half), min(w, x + half + 1)):
        for y in range(h):
            r, g, b = px[xx, y][:3]
            if r > 170 and abs(r - g) < 10 and -4 < (b - r) < 32:
                px[xx, y] = (255, 255, 255)
                removed += 1
    return im, removed


def cutout(im, tol=TOL):
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
    if box:
        # 左边不留白：贴边时要被人物的裁切边界贴住屏幕边缘
        im = im.crop((box[0], max(0, box[1] - 4), box[2], box[3]))
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--png", required=True, help="桌面版输出")
    ap.add_argument("--webp", required=True, help="网页版输出")
    ap.add_argument("--png-height", type=int, default=640)
    ap.add_argument("--webp-height", type=int, default=300)
    args = ap.parse_args()

    im = Image.open(args.src).convert("RGB")
    x, score = find_line(im)
    print(f"[peek] 竖线位置 x={x}（纵向覆盖率 {score:.0%}）")
    if score > 0.5:
        im, removed = erase_line(im, x)
        print(f"[peek] 已擦除竖线像素 {removed}")
    else:
        print("[peek] 未找到明显竖线，跳过擦除")

    art = cutout(im)
    print(f"[peek] 裁剪后 {art.size}")

    png = art.resize((round(art.width * args.png_height / art.height), args.png_height),
                     Image.LANCZOS)
    png.save(args.png)
    webp = art.resize((round(art.width * args.webp_height / art.height), args.webp_height),
                      Image.LANCZOS)
    webp.save(args.webp, format="WEBP", quality=90, method=6)
    print(f"[peek] {args.png} {png.size}  {os.path.getsize(args.png) // 1024}KB")
    print(f"[peek] {args.webp} {webp.size}  {os.path.getsize(args.webp) // 1024}KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
