# -*- coding: utf-8 -*-
"""把「白底 + 主体触边」的图抠成透明 PNG。

为什么不用技能自带的 cutout：它用四角判断背景是否统一，本图人物头发触到底边，
四角颜色不一致就直接判 complex 放弃抠图。但背景其实很干净（纯白），
只是种子点不能只取四角 —— 改为「所有接近背景色的边框像素」一起泛洪即可。
边界泛洪还能保住白色女仆头饰这类内部大面积白色（不与边框连通就不会被吃）。
"""
import sys
from collections import deque

from PIL import Image, ImageFilter

SRC = sys.argv[1]
DST = sys.argv[2]
TOL = int(sys.argv[3]) if len(sys.argv) > 3 else 16
MAX_SIDE = 1000

im = Image.open(SRC).convert("RGBA")
if max(im.size) > MAX_SIDE:
    im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
w, h = im.size
px = im.load()

BG = (255, 255, 255)


def near(c):
    return (abs(c[0] - BG[0]) <= TOL and abs(c[1] - BG[1]) <= TOL
            and abs(c[2] - BG[2]) <= TOL)


seen = bytearray(w * h)
dq = deque()
seeds = 0
for x in range(w):
    for y in (0, h - 1):
        if near(px[x, y]):
            dq.append((x, y))
            seeds += 1
for y in range(h):
    for x in (0, w - 1):
        if near(px[x, y]):
            dq.append((x, y))
            seeds += 1

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

# 收边：MinFilter 削掉一圈半透明白晕，再轻微高斯柔化锯齿
alpha = im.getchannel("A").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
im.putalpha(alpha)

box = im.getbbox()
if box:
    pad = 6
    im = im.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                  min(w, box[2] + pad), min(h, box[3] + pad)))

im.save(DST)
opaque = sum(1 for p in im.getdata() if p[3] > 8)
total = im.width * im.height
print(f"[cut] seeds={seeds} size={im.size} 不透明占比={opaque / total:.1%} -> {DST}")
