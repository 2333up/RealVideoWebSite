# -*- coding: utf-8 -*-
"""把「探头」姿态处理成贴边素材（桌面 PNG + 网页 WebP）。

四边贴边用的是三张图：
  --edge left    从左边框探头（右侧靠水平镜像复用）
  --edge top     扒住上边框垂下来
  --edge bottom  从下边框探上来

生成图里都带了一条「边缘」线（模型的习惯）。贴到屏幕边上时这条线会露出来，
所以先抹掉再抠图。抹的方式要按方向来：竖边看列，横边看行。

侧边素材额外做**底部淡出**：贴在中段高度时，身体下方是硬切口，
不淡出就会悬着一条横线（贴在屏幕最下方时才被屏幕边缘挡住）。

用法：
  python make_peek.py --src peek.png --edge left \
      --png build/Jingxi/peek.png --webp ../frontend/src/assets/pet/peek.webp
"""
import argparse
import os
from collections import deque

from PIL import Image, ImageFilter

TOL = 40


def _pixels(im, x, y):
    r, g, b = im.getpixel((x, y))[:3]
    return r, g, b


def find_line(im, edge):
    """找那条「边缘线」。竖边扫列、横边扫行，取覆盖率最高的一条。"""
    w, h = im.size
    best_pos, best_score = None, 0.0
    if edge in ("left", "right"):
        for x in range(int(w * 0.10), int(w * 0.45)):
            score = 0
            for y in range(0, h, 3):
                r, g, b = _pixels(im, x, y)
                if abs(r - g) < 10 and abs(g - b) < 10 and 185 < r < 232:
                    score += 1
            ratio = score / (h / 3)
            if ratio > best_score:
                best_pos, best_score = x, ratio
    else:
        for y in range(0, int(h * 0.30)) if edge == "top" else \
                range(int(h * 0.72), int(h * 0.99)):
            score = 0
            for x in range(0, w, 3):
                r, g, b = _pixels(im, x, y)
                if abs(r - g) < 10 and abs(g - b) < 10 and 185 < r < 232:
                    score += 1
            ratio = score / (w / 3)
            if ratio > best_score:
                best_pos, best_score = y, ratio
    return best_pos, best_score


def erase_line(im, edge, pos, half=16):
    """抹掉边缘线及其淡出渐变。

    线是**带蓝调的浅灰**（约 188,188,207），最早按 |g-b|<10 判定会漏掉，
    残留一条灰条贴在边上。这里放宽到「亮度 >170 + 红绿接近 + 蓝不高于红太多」，
    同时避开皮肤（r-g 差值大）与深色发丝。
    """
    px = im.load()
    w, h = im.size
    removed = 0

    def wipe(x, y):
        nonlocal removed
        r, g, b = px[x, y][:3]
        if r > 170 and abs(r - g) < 10 and -4 < (b - r) < 32:
            px[x, y] = (255, 255, 255)
            removed += 1

    if edge in ("left", "right"):
        for x in range(max(0, pos - half), min(w, pos + half + 1)):
            for y in range(h):
                wipe(x, y)
    else:
        for y in range(max(0, pos - half), min(h, pos + half + 1)):
            for x in range(w):
                wipe(x, y)
    return im, removed


def robust_bbox(im, min_count=4):
    """按内容裁边，但忽略零星的游离像素。

    getbbox 只要有一个不透明像素就会把边界撑满 —— 实测上边缘素材因 2 个游离像素
    被撑成整幅宽，人物在画布里显得又小又偏。这里按「该行/列不透明像素数」
    过滤后再取边界。
    """
    a = im.getchannel("A")
    w, h = a.size
    px = a.load()
    cols = [x for x in range(w) if sum(1 for y in range(h) if px[x, y] > 24) >= min_count]
    rows = [y for y in range(h) if sum(1 for x in range(w) if px[x, y] > 24) >= min_count]
    if not cols or not rows:
        return im.getbbox()
    return cols[0], rows[0], cols[-1] + 1, rows[-1] + 1


def clean_top_gray(im, band=0.08):
    """清掉人物上方那块「墙」的残留。

    上边缘素材里，模型在她双手之间画了一块中性灰（148,147,153）当墙。
    它比背景暗得多，抠图容差够不到，于是留在画面上像块脏东西。
    只在顶部 8% 内按「中性且中灰」清理：皮肤 r 明显大于 g、头发偏蓝，
    都不会命中。
    """
    px = im.load()
    w, h = im.size
    n = 0
    for y in range(int(h * band)):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if abs(r - g) < 6 and abs(g - b) < 10 and 90 < r < 210:
                px[x, y] = (255, 255, 255)
                n += 1
    return im, n


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
    box = robust_bbox(im)
    return im.crop(box) if box else im


def despeckle(im, min_area=80):
    """去掉孤立的小噪点（按连通块面积）。

    抠图后常会留下几十个小黑点（多半是模型画的背景纹理）。它们散在人物周围，
    贴到屏幕上就是一些浮空的小污点。这里把面积小于阈值的连通块整块抹掉。
    """
    w, h = im.size
    px = im.load()   # 必须用 im.load()：getchannel("A") 拿到的是副本，改它不生效
    seen = bytearray(w * h)
    killed = 0
    for y0 in range(h):
        for x0 in range(w):
            i0 = y0 * w + x0
            if seen[i0] or px[x0, y0][3] <= 24:
                continue
            comp, dq = [], [(x0, y0)]
            seen[i0] = 1
            while dq:
                x, y = dq.pop()
                comp.append((x, y))
                for nx, ny in ((x+1,y), (x-1,y), (x,y+1), (x,y-1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and px[nx, ny][3] > 24:
                            seen[j] = 1
                            dq.append((nx, ny))
            if len(comp) < min_area:
                for x, y in comp:
                    r, g, b, _ = px[x, y]
                    px[x, y] = (r, g, b, 0)
                killed += 1
    return im, killed


def fade_bottom(im, ratio):
    """底部渐隐：侧边贴在中段时，身体下方的硬切口会悬空露出来。"""
    if ratio <= 0:
        return im
    w, h = im.size
    start = int(h * (1 - ratio))
    px = im.load()
    for y in range(start, h):
        k = 1.0 - (y - start) / max(1, h - start)
        for x in range(w):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, int(a * k))
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--edge", choices=["left", "right", "top", "bottom"], default="left")
    ap.add_argument("--png", required=True)
    ap.add_argument("--webp", required=True)
    ap.add_argument("--png-height", type=int, default=640)
    ap.add_argument("--webp-height", type=int, default=300)
    ap.add_argument("--fade-bottom", type=float, default=0.0,
                    help="底部渐隐比例（侧边素材建议 0.18）")
    args = ap.parse_args()

    im = Image.open(args.src).convert("RGB")
    pos, score = find_line(im, args.edge)
    print(f"[peek] {args.edge} 边缘线位置 {pos}（覆盖率 {score:.0%}）")
    if score <= 0.4:
        pos = None
        print("[peek] 未找到明显边缘线，按普通裁边处理")

    # 边缘线有时是更深的中灰（约 105），浅灰判据够不到。这里按「低饱和中灰」
    # 在边缘带内直接刷白：皮肤 r 明显大于 g、深蓝袖口 b 远高于 r，都不会命中。
    if pos is not None:
        px = im.load()
        w0, h0 = im.size
        n = 0

        def wipe(x, y):
            nonlocal n
            r, g, b = px[x, y][:3]
            if abs(r - g) < 8 and abs(g - b) < 12 and 80 < r < 240:
                px[x, y] = (255, 255, 255)
                n += 1

        if args.edge in ("left", "right"):
            for x in range(max(0, pos - 14), min(w0, pos + 15)):
                for y in range(h0):
                    wipe(x, y)
        else:
            for y in range(max(0, pos - 14), min(h0, pos + 15)):
                for x in range(w0):
                    wipe(x, y)
        print(f"[peek] 擦除边缘线 {n} 像素")

    art = cutout(im)

    # 擦完线再按线裁：线已成白色、会被抠图吃掉，所以裁在线上不会留边；
    # 而手指扒在线的内侧，裁完仍在。
    if pos is not None:
        w, h = art.size
        if args.edge == "left":
            art = art.crop((min(w, pos), 0, w, h))
        elif args.edge == "right":
            art = art.crop((0, 0, max(1, pos), h))
        elif args.edge == "top":
            art = art.crop((0, min(h, pos), w, h))
        else:
            art = art.crop((0, 0, w, max(1, pos)))
        art = art.crop(robust_bbox(art))

    art, killed = despeckle(art)
    if killed:
        print(f"[peek] 去掉 {killed} 个噪点块")
    art = fade_bottom(art, args.fade_bottom)
    print(f"[peek] 裁剪后 {art.size}（fade={args.fade_bottom}）")

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
