# -*- coding: utf-8 -*-
"""把桌宠帧导出成网页可用的 WebP，并生成前端消费的清单。

为什么不能直接引用桌宠的 PNG：
  9 帧 704×820 的 PNG 合计 5.1MB，而整个前端 JS 包才 500KB 左右。
  网页实际只显示约 240px 高，按 2x（480px）导 WebP 即可，体积降到几百 KB。

产出：
  frontend/src/assets/pet/f00N.webp     帧图（Vite 会给它们加 hash）
  frontend/src/assets/pet/pet-bubble.woff2  气泡字体（从 ttf 转，网页体积更小）
  frontend/src/components/webPet/manifest.json  姿态映射 / 走动参数 / 台词

用法：
  python export_web_frames.py --build build/Jingxi --fe ../frontend
"""
import argparse
import ast
import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PET_APP = os.path.join(HERE, "pet_app.py")
EXTRA = ("，。！？：；“”‘’（）《》…—～·、℃°①②③④⑤★☆♥♪")


def collect_lines(app_py):
    """从 pet_app.py 里取 LINES，保证网页与桌面版台词同源。"""
    with open(app_py, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(getattr(t, "id", None) == "LINES" for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit("在 pet_app.py 里没找到 LINES")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", required=True, help="桌宠构建目录（含 frames/ 与 pet_config.json）")
    ap.add_argument("--fe", required=True, help="前端根目录")
    ap.add_argument("--height", type=int, default=480, help="导出帧的高度（px，2x）")
    ap.add_argument("--quality", type=int, default=88)
    args = ap.parse_args()

    frames_dir = os.path.join(args.build, "frames")
    out_assets = os.path.join(args.fe, "src", "assets", "pet")
    out_meta = os.path.join(args.fe, "src", "components", "webPet")
    os.makedirs(out_assets, exist_ok=True)
    os.makedirs(out_meta, exist_ok=True)

    names = sorted(n for n in os.listdir(frames_dir) if n.endswith(".png"))
    total_in = total_out = 0
    exported = []
    for i, name in enumerate(names):
        src = os.path.join(frames_dir, name)
        im = Image.open(src).convert("RGBA")
        f = args.height / im.height
        im = im.resize((max(1, round(im.width * f)), args.height), Image.LANCZOS)
        dst_name = f"f{i:03d}.webp"
        dst = os.path.join(out_assets, dst_name)
        im.save(dst, format="WEBP", quality=args.quality, method=6)
        total_in += os.path.getsize(src)
        total_out += os.path.getsize(dst)
        exported.append(dst_name)
        print(f"[web] {name} -> {dst_name}  {im.size}  "
              f"{os.path.getsize(src) // 1024}KB -> {os.path.getsize(dst) // 1024}KB")

    # 字体：优先 ttf -> woff2（体积再小一截）；缺 brotli 时直接拷 ttf，
    # 53KB 的 ttf 对网页也可以接受，不值得为它多装一个依赖。
    font_src = os.path.join(os.path.dirname(HERE), "assets", "fonts", "pet-bubble.ttf")
    font_name = ""
    if os.path.exists(font_src):
        try:
            from fontTools.ttLib import TTFont
            f = TTFont(font_src)
            f.flavor = "woff2"
            font_name = "pet-bubble.woff2"
            f.save(os.path.join(out_assets, font_name))
        except Exception as exc:  # noqa: BLE001 - 缺 brotli 等，降级即可
            import shutil
            font_name = "pet-bubble.ttf"
            shutil.copyfile(font_src, os.path.join(out_assets, font_name))
            print(f"[web] woff2 转换不可用（{type(exc).__name__}），改用 ttf")
        print(f"[web] 字体 -> {font_name}  "
              f"{os.path.getsize(os.path.join(out_assets, font_name)) // 1024}KB")
    else:
        print("[web] 未找到气泡字体，网页会回退系统字体")

    with open(os.path.join(args.build, "pet_config.json"), encoding="utf-8-sig") as f:
        cfg = json.load(f)

    first = Image.open(os.path.join(args.build, "frames", names[0]))
    # 气泡锚点：画布里角色并非水平居中（左右有透明留白），
    # 直接用 50% 会让气泡偏到人物旁边。取各帧内容中心的平均值。
    centers = []
    for name in names:
        src = Image.open(os.path.join(args.build, "frames", name)).convert("RGBA")
        box = src.getbbox()
        if box:
            centers.append(((box[0] + box[2]) / 2) / src.width)
    anchor = sum(centers) / len(centers) if centers else 0.5

    manifest = {
        "canvas": {"w": first.width, "h": first.height},
        "frameHeight": args.height,
        "bubbleAnchor": round(anchor, 4),
        "frames": exported,
        "font": font_name,
        "poses": cfg.get("poses", {}),
        "walk": cfg.get("walk", {}),
        "lines": {k: list(v) if isinstance(v, (tuple, list)) else [v]
                  for k, v in collect_lines(PET_APP).items()},
    }
    with open(os.path.join(out_meta, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"[web] 合计 {total_in / 1024 / 1024:.1f}MB -> {total_out / 1024:.0f}KB "
          f"（{total_out / total_in:.1%}）")
    print(f"[web] 清单 {os.path.join(out_meta, 'manifest.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
