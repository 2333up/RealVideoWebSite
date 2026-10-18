# -*- coding: utf-8 -*-
"""给已有的姿态帧追加新姿态（走路循环 / 被抓姿态）。

为什么不直接塞图：桌宠所有帧必须共用**同一画布 + 同一脚底基线**，
否则切换姿态时窗口会跳、大小会变。所以这里统一做三件事：
  1. 抠白底（边界泛洪，只清理与边框连通的像素）；
  2. 缩放到同一角色高度；
  3. 取所有帧的并集画布，逐帧「底部居中」重新合成。

用法：
  python add_frames.py --build build/Jingxi \
      --walk-sheet assets/gen/walk.png --walk-count 4 \
      --extra assets/gen/grab.png
"""
import argparse
import os
from collections import deque

from PIL import Image, ImageFilter

# 容差要覆盖「假透明」背景：图像模型有时会把棋盘格画进图里（灰格约 228），
# 用 18 只能抠掉纯白格，抠不干净。40 能吃掉灰格，而白色围裙/头饰属于
# 内部区域、不与边框连通，泛洪到不了那里，不会被误伤。
TOL = 40
MIN_COL_RUN = 20


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
    return im.crop(box) if box else im


def _trim(im):
    box = im.getbbox()
    return im.crop(box) if box else im


def slice_columns(im, count):
    """按列投影把精灵图切成 count 段；切不准时退回等分。

    无论走哪条路，最后都要按内容裁紧：等分切出来的每段会带着相邻角色的
    一缕头发，不裁的话拼接后帧与帧之间会出现「多余的半个人」。
    """
    w, h = im.size
    mask = im.getchannel("A").point(lambda a: 255 if a > 24 else 0)
    col = list(mask.resize((w, 1), Image.BOX).getdata())

    runs, start = [], None
    for x, v in enumerate(col):
        if v > 1 and start is None:
            start = x
        elif v <= 1 and start is not None:
            if x - start >= MIN_COL_RUN:
                runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, w))

    if len(runs) == count:
        return [_trim(im.crop((a, 0, b, h))) for a, b in runs]

    print(f"[add] 列投影得到 {len(runs)} 段，与期望的 {count} 不等 -> 改为等分")
    step = w / count
    return [_trim(im.crop((round(i * step), 0, round((i + 1) * step), h)))
            for i in range(count)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", required=True)
    ap.add_argument("--walk-sheet")
    ap.add_argument("--walk-count", type=int, default=4)
    ap.add_argument("--extra", action="append", default=[],
                    help="追加的单张姿态（可多次指定）")
    ap.add_argument("--target-h", type=int, default=820)
    ap.add_argument("--tol", type=int, default=TOL, help="抠图容差")
    args = ap.parse_args()

    frames_dir = os.path.join(args.build, "frames")
    names = sorted(f for f in os.listdir(frames_dir) if f.startswith("f") and f.endswith(".png"))
    frames = [Image.open(os.path.join(frames_dir, n)).convert("RGBA") for n in names]
    print(f"[add] 已有 {len(frames)} 帧，画布 {frames[0].size}")

    new_frames = []
    if args.walk_sheet:
        sheet = cutout(Image.open(args.walk_sheet), args.tol)
        parts = slice_columns(sheet, args.walk_count)
        print(f"[add] 走路精灵图切成 {len(parts)} 帧: {[p.size for p in parts]}")
        new_frames.extend(parts)
    for path in args.extra:
        new_frames.append(cutout(Image.open(path), args.tol))
        print(f"[add] 追加姿态 {os.path.basename(path)} {new_frames[-1].size}")

    if not new_frames:
        print("[add] ERROR=没有新帧")
        return 1

    # 统一角色高度：以已有帧的内容高度为准，新增帧按同一比例缩放，
    # 这样切换姿态时角色不会突然变大变小。
    base_h = args.target_h
    scaled_new = []
    for im in new_frames:
        f = base_h / im.height
        scaled_new.append(im.resize((max(1, round(im.width * f)), base_h), Image.LANCZOS))

    all_frames = frames + scaled_new
    cw = max(f.width for f in all_frames)
    ch = max(f.height for f in all_frames)
    print(f"[add] 并集画布 {cw}x{ch}")

    for i, im in enumerate(all_frames):
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        canvas.alpha_composite(im, ((cw - im.width) // 2, ch - im.height))
        canvas.save(os.path.join(frames_dir, f"f{i:03d}.png"))

    print(f"[add] 共写出 {len(all_frames)} 帧 -> {frames_dir}")

    # ---- 同步配置：姿态映射 + 走路帧 ----
    import json

    cfg_path = os.path.join(args.build, "pet_config.json")
    cfg = {}
    if os.path.exists(cfg_path):
        with open(cfg_path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
    cfg["image"] = [f"frames/f{i:03d}.png" for i in range(len(all_frames))]
    cfg["mode"] = "poses"
    poses = dict(cfg.get("poses") or {"idle": 0, "double": 2, "poke": 3, "pat": 3})
    base = len(frames)                      # 新帧起点
    walk_count = max(0, len(new_frames) - len(args.extra))
    if walk_count:
        cfg["walk"] = {
            "frames": list(range(base, base + walk_count)),
            "speed": 46,                    # 像素/秒，横向游走速度
            "pause": [6, 14],               # 两次走动的间隔区间（秒）
            "duration": [2.5, 6.0],         # 单次走动时长区间（秒）
            "fps": 7.5,                     # 迈步换帧频率
        }
    if args.extra:
        poses["drag"] = base + walk_count   # 最后一个 extra 用于「被抓住」
    cfg["poses"] = poses
    # 四边贴边素材：左右共用「侧边探头」（右侧运行期镜像），上下各一张。
    # 缺哪张就只保留有的，运行期会退回 side，不会因为有缺口而崩。
    peek = {}
    for key, fname in (("side", "peek.png"),
                       ("top", "peek-top.png"),
                       ("bottom", "peek-bottom.png")):
        if os.path.exists(os.path.join(args.build, fname)):
            peek[key] = fname
    if peek:
        cfg["peek"] = peek
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"[add] 配置已更新：poses={poses} walk={cfg.get('walk')}")

    print(f"[add] 索引：已有 0..{len(frames) - 1}，"
          f"新增 {len(frames)}..{len(all_frames) - 1}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
