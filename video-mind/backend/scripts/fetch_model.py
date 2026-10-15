"""下载 faster-whisper 模型到本地目录。

为什么需要它：
    HuggingFace 官方客户端在弱网/镜像环境下容易把 model.bin 下成一截断的文件，
    而 ctranslate2 加载时只会报一句含糊的「model.bin is incomplete」，
    排查起来很费劲。这里改成：并行分段下载 + 逐文件校验 Content-Length + 落盘后复核。

用法：
    python scripts/fetch_model.py large-v3              # 默认走魔搭（国内快）
    python scripts/fetch_model.py base --parts 8        # 指定并发数
    python scripts/fetch_model.py large-v3 --source hf  # 改用 HuggingFace

下载后的模型放在 data/models/faster-whisper/<模型名>/，
FasterWhisperProvider 会优先从这里加载，命中后不再走网络。
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import DATA_DIR  # noqa: E402

MIRROR = os.getenv("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
HF_REPO_TEMPLATE = "Systran/faster-whisper-{name}"

# 魔搭（ModelScope）是国内镜像，实测比 HuggingFace 系列镜像快一个数量级
# （单连接 5.8 MB/s vs 190 KB/s），且支持 Range 并行。默认走它。
MODELSCOPE_API = "https://www.modelscope.cn/api/v1/models"
MODELSCOPE_REPOS = {
    "large-v3": "pengzhendong/faster-whisper-large-v3",
}
# 两个来源的文件名略有差异（HF 用 vocabulary.txt，魔搭用 vocabulary.json），
# 逐个尝试，取不到的跳过——faster-whisper 只需要其中一种。
FILES = [
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
    "vocabulary.txt",
    "vocabulary.json",
    "model.bin",
]
REQUIRED = ["config.json", "tokenizer.json", "model.bin"]
TIMEOUT = httpx.Timeout(120.0, connect=30.0)


def _hf_url(repo: str, filename: str) -> str:
    return f"{MIRROR}/{repo}/resolve/main/{filename}"


def _ms_url(repo: str, filename: str) -> str:
    return f"{MODELSCOPE_API}/{repo}/repo?Revision=master&FilePath={filename}"


def _remote_size(url: str) -> int:
    """返回远程文件大小；文件不存在返回 -1。"""
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as c:
        r = c.head(url)
        if r.status_code == 404:
            return -1
        if r.status_code >= 400:
            # 部分对象存储不接受 HEAD，退一步用带 Range 的 GET 探测
            r = c.get(url, headers={"Range": "bytes=0-0"})
            cr = r.headers.get("content-range", "")
            if "/" in cr:
                return int(cr.split("/")[-1])
            return int(r.headers.get("content-length", 0) or 0)
        return int(r.headers.get("content-length", 0) or 0)


def _download_range(url: str, start: int, end: int, dest: Path, retries: int = 8) -> int:
    """下载 [start, end] 闭区间，支持断点续传；返回该分片最终字节数。"""
    expected = end - start + 1
    for attempt in range(1, retries + 1):
        try:
            have = dest.stat().st_size if dest.exists() else 0
            if have > expected:
                dest.unlink(missing_ok=True)
                have = 0
            if have == expected:
                return expected

            is_resume = have > 0
            headers = {"Range": f"bytes={start + have}-{end}"}
            with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as c:
                with c.stream("GET", url, headers=headers) as resp:
                    # 续传时若服务端忽略 Range 返回 200（整个文件），
                    # 追加进去会让分片超出预期长度，必须丢弃重来
                    if is_resume and resp.status_code == 200:
                        dest.unlink(missing_ok=True)
                        raise RuntimeError("服务端忽略 Range（返回 200），已丢弃重来")
                    if resp.status_code not in (200, 206):
                        raise RuntimeError(f"HTTP {resp.status_code}")

                    remaining = expected - have
                    with dest.open("ab" if is_resume else "wb") as f:
                        for chunk in resp.iter_bytes(chunk_size=64 * 1024):
                            if remaining <= 0:
                                break
                            if len(chunk) > remaining:
                                chunk = chunk[:remaining]
                            f.write(chunk)
                            remaining -= len(chunk)

            if dest.stat().st_size == expected:
                return expected
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"分片不完整 {dest.stat().st_size}/{expected}")
        except Exception as exc:
            if attempt >= retries:
                raise RuntimeError(f"分片 {start}-{end} 下载失败：{exc}") from exc
            time.sleep(min(2 * attempt, 10))
    return 0


def download_file(url: str, dest: Path, parts: int, label: str = "") -> bool:
    """下载单个文件。返回 True 表示成功；文件在远端不存在时返回 False。"""
    total = _remote_size(url)
    if total < 0:
        print(f"  {label or dest.name}：远端不存在，跳过")
        return False
    if total == 0:
        raise RuntimeError(f"无法获取文件大小：{url}")
    if dest.exists() and dest.stat().st_size == total:
        print(f"  {label or dest.name}：已存在且大小一致，跳过")
        return True

    # 小文件直接下，大文件并行分段
    if total < 32 * 1024 * 1024 or parts <= 1:
        _download_range(url, 0, total - 1, dest)
        print(f"  {label or dest.name}：{total / 1024 / 1024:.1f} MB 完成")
        return True

    part_dir = dest.parent / (dest.name + ".parts")
    part_dir.mkdir(parents=True, exist_ok=True)
    chunk = (total + parts - 1) // parts
    tasks = []
    for i in range(parts):
        s = i * chunk
        e = min(s + chunk - 1, total - 1)
        if s >= total:
            break
        tasks.append((i, s, e))

    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=parts) as pool:
        futs = {
            pool.submit(_download_range, url, s, e, part_dir / f"p{i:04d}"): i
            for i, s, e in tasks
        }
        for fut in as_completed(futs):
            n = fut.result()
            done += n
            el = time.time() - t0
            spd = done / el / 1024 / 1024 if el > 0 else 0
            print(
                f"\r  {label or dest.name}：{done / total * 100:5.1f}%  "
                f"{done / 1024 / 1024:7.1f}/{total / 1024 / 1024:.1f} MB  {spd:.2f} MB/s   ",
                end="",
                flush=True,
            )

    print()
    with dest.open("wb") as out:
        for i, _, _ in tasks:
            p = part_dir / f"p{i:04d}"
            with p.open("rb") as f:
                while True:
                    buf = f.read(8 * 1024 * 1024)
                    if not buf:
                        break
                    out.write(buf)
            p.unlink(missing_ok=True)
    try:
        part_dir.rmdir()
    except OSError:
        pass

    actual = dest.stat().st_size
    if actual != total:
        dest.unlink(missing_ok=True)
        raise RuntimeError(f"{dest.name} 大小不符：{actual} != {total}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="下载 faster-whisper 模型到本地")
    ap.add_argument("model", nargs="?", default="large-v3", help="模型名，如 large-v3 / medium / base")
    ap.add_argument("--parts", type=int, default=16, help="大文件并行分段数")
    ap.add_argument(
        "--source", choices=["modelscope", "hf"], default="modelscope",
        help="下载源；魔搭在国内通常快得多（默认）",
    )
    ap.add_argument("--repo", default=None, help="自定义仓库名，覆盖内置映射")
    args = ap.parse_args()

    use_ms = args.source == "modelscope"
    if args.repo:
        repo = args.repo
    elif use_ms:
        repo = MODELSCOPE_REPOS.get(args.model)
        if not repo:
            print(f"魔搭上没有登记「{args.model}」的仓库映射。")
            print("可用：%s" % ", ".join(MODELSCOPE_REPOS))
            print("或改用 --source hf（走 HuggingFace），或用 --repo 手动指定。")
            return 1
    else:
        repo = HF_REPO_TEMPLATE.format(name=args.model)

    url_fn = _ms_url if use_ms else _hf_url
    out_dir = DATA_DIR / "models" / "faster-whisper" / args.model
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"下载源 ：{'魔搭 ModelScope' if use_ms else 'HuggingFace'}")
    print(f"仓库   ：{repo}")
    print(f"目标   ：{out_dir}")
    print(f"并发   ：{args.parts}")
    print()

    for fname in FILES:
        download_file(url_fn(repo, fname), out_dir / fname, args.parts, label=fname)

    # 落盘后复核必需文件
    missing = [f for f in REQUIRED if not (out_dir / f).exists() or (out_dir / f).stat().st_size == 0]
    if missing:
        print(f"\n!! 缺少必需文件：{missing}")
        return 1

    print()
    print(f"✓ 模型就绪：{out_dir}")
    for f in REQUIRED:
        print(f"  {f} {(out_dir / f).stat().st_size / 1024 / 1024:.1f} MB")
    print("\n在设置页把「模型大小」设为该模型名即可，程序会优先从本地目录加载。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
