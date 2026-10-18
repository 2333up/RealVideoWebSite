# -*- coding: utf-8 -*-
"""把霞鹜文楷裁剪成「只含台词用字」的小字体，供气泡使用。

为什么需要子集：完整字体 14MB，而气泡只用到几十个字。
子集后通常 100~300KB，打进 exe 几乎不增加体积。

⚠️ 改了 pet_app.py 的 LINES 之后要重跑本脚本，否则新台词里没被收录的
汉字会回退到系统字体（Qt 会按字符回退，只是字形会混）。

用法：
  python make_bubble_font.py --src assets/fonts/LXGWWenKaiLite-Regular.ttf \
                             --out assets/fonts/pet-bubble.ttf
"""
import argparse
import ast
import os
import string
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PET_APP = os.path.join(os.path.dirname(HERE), "build-tools", "pet_app.py")

# 除台词外还要保留的字符：ASCII、中英文标点、常用符号
EXTRA = (string.printable
         + "，。！？：；“”‘’（）《》…—～·、℃°"
         + "①②③④⑤★☆♥♪")


def collect_chars(app_py):
    """从 pet_app.py 的 LINES 字典里抽出所有用到的字符。"""
    with open(app_py, encoding="utf-8") as f:
        tree = ast.parse(f.read())

    chars = set(EXTRA)
    for node in tree.body:
        targets = getattr(node, "targets", [])
        if not isinstance(node, ast.Assign):
            continue
        if not any(getattr(t, "id", None) == "LINES" for t in targets):
            continue
        data = ast.literal_eval(node.value)
        for value in data.values():
            items = value if isinstance(value, (tuple, list)) else [value]
            for s in items:
                if isinstance(s, str):
                    chars.update(s)
    return chars


def rename_font(path, family):
    """给子集字体改名。

    霞鹜文楷使用 OFL 的保留字体名（RFN）：允许的名字只覆盖「网页字体」场景，
    而我们是把子集嵌进桌面程序。合规做法是**改名**，不能用原字体名分发。
    顺带让 Qt 里的 family 名变成我们自己的，便于排查是否加载成功。
    """
    from fontTools.ttLib import TTFont

    f = TTFont(path)
    name = f["name"]
    full = f"{family} Regular"
    mapping = {1: family, 3: f"{family}-Regular;1.0", 4: full, 6: f"{family}-Regular"}
    for rec in list(name.names):
        if rec.nameID in mapping:
            rec.string = mapping[rec.nameID]
        elif rec.nameID in (16, 17):
            rec.string = family if rec.nameID == 16 else "Regular"
    f.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="完整字体 ttf/otf")
    ap.add_argument("--out", required=True, help="输出的子集字体")
    ap.add_argument("--app", default=PET_APP)
    ap.add_argument("--family", default="PetBubble Sans",
                    help="子集字体族名（默认避开原字体的保留名）")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        print(f"[font] ERROR=找不到源字体 {args.src}")
        return 1

    chars = collect_chars(args.app)
    text = "".join(sorted(chars))
    print(f"[font] 收录 {len(chars)} 个字符（含标点与 ASCII）")

    # 用字体自带的子集工具；--layout-features 留空可显著减小体积
    from fontTools import subset

    argv = [
        args.src,
        f"--output-file={args.out}",
        f"--text={text}",
        "--layout-features=",
        "--drop-tables+=DSIG",
        "--no-hinting",
        "--desubroutinize",
    ]
    subset.main(argv)
    rename_font(args.out, args.family)

    size = os.path.getsize(args.out)
    src_size = os.path.getsize(args.src)
    print(f"[font] {args.out}  {size / 1024:.0f}KB（原 {src_size / 1024 / 1024:.1f}MB，"
          f"压缩到 {size / src_size:.1%}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
