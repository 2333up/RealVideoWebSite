"""按需抽取 cuBLAS DLL，避免为两个文件下载半个 GB。

背景：ctranslate2 的 Windows wheel 自带 cuDNN 9，但**不含** cuBLAS，
缺少它时「模型能加载、一开始推理就炸」：

    RuntimeError: Library cublas64_12.dll is not found or cannot be loaded

官方补法是 `pip install nvidia-cublas-cu12`，但那个 wheel 有 553MB，
其中 `cublasLt64_12.dll` 一个就占了 474MB。我们真正需要的
`cublas64_12.dll` 压缩后只有 79MB，而且**正好排在 zip 的开头**。

zip 的成员是独立 deflate 流，且尾部有中央目录记录每个成员的偏移与长度，
因此可以只把那一段字节范围取回来单独解压——流量直接降到 1/7。

用法：
    python scripts/fetch_cublas.py                # 抽取 cublas64_12.dll
    python scripts/fetch_cublas.py --with-lt      # 连 cublasLt 一起（体积大）
    python scripts/fetch_cublas.py --check        # 只检查是否已就绪
"""

from __future__ import annotations

import argparse
import struct
import sys
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

#: 12.9.2.10 是带 Windows wheel 的最新版本；换版本只需改这里
WHEEL_PATH = (
    "packages/20/e2/fc9a0e985249d873150276d5afb02e39a66817fedbf1a385724393e505ed/"
    "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl"
)

#: 同一个文件的多个来源。实测国内直连 PyPI 只有 0.3 MB/s，
#: 而清华镜像能到 1.9 MB/s——差 6 倍，值得先花两秒钟探一下。
MIRRORS = [
    "https://pypi.tuna.tsinghua.edu.cn/",
    "https://mirrors.aliyun.com/pypi/",
    "https://files.pythonhosted.org/",
]

WHEEL_URL = MIRRORS[0] + WHEEL_PATH  # 启动时会被 _pick_fastest_mirror 覆盖

MEMBERS = {
    "cublas": "nvidia/cublas/bin/cublas64_12.dll",
    "lt": "nvidia/cublas/bin/cublasLt64_12.dll",
}

# 并发不是越高越好：实测 24 并发会把 TLS 连接打崩
# （SSL: UNEXPECTED_EOF_WHILE_READING），8 并发 + 重试反而更快更稳。
CONNECTIONS = 8
MAX_RETRY = 5
TAIL_BYTES = 4 * 1024 * 1024  # 装下中央目录通常绰绰有余


def _pick_fastest_mirror() -> str:
    """各自拉 2MB 比速度，选最快的源。

    失败的源直接跳过（国外镜像在某些网络下根本连不上，不该让整个流程卡住）。
    """
    best, best_speed = MIRRORS[0], -1.0
    for base in MIRRORS:
        url = base + WHEEL_PATH
        try:
            with httpx.Client(timeout=20, follow_redirects=True) as c:
                t = time.time()
                n = 0
                with c.stream("GET", url, headers={"Range": "bytes=0-2097151"}) as r:
                    for chunk in r.iter_bytes(65536):
                        n += len(chunk)
                        if n >= 2 * 1024 * 1024:
                            break
                speed = n / 1e6 / max(time.time() - t, 1e-6)
            print(f"   源 {base:42s} {speed:5.2f} MB/s")
            if speed > best_speed:
                best, best_speed = base, speed
        except Exception as exc:  # noqa: BLE001
            print(f"   源 {base:42s} 不可用（{type(exc).__name__}）")
    print(f"→ 选用 {best}")
    return best + WHEEL_PATH


def _dest_dir() -> Path:
    """DLL 放哪：当前 Python 的 site-packages，与 pip 安装位置保持一致。

    注意不能用 site.getsitepackages()——在 venv 里它返回的是 venv 根目录
    而不是 Lib/site-packages，装进去的东西谁也找不到。
    """
    import sysconfig

    purelib = sysconfig.get_paths().get("purelib")
    return Path(purelib) if purelib else Path(sysconfig.get_paths()["stdlib"]) / "site-packages"


def _http() -> httpx.Client:
    return httpx.Client(timeout=60, follow_redirects=True, limits=httpx.Limits(max_connections=CONNECTIONS))


def _parse_central_directory(client: httpx.Client, total: int) -> dict[str, tuple[int, int, int]]:
    """读 zip 尾部拿到 {成员名: (本地头偏移, 压缩大小, 原始大小)}。"""
    tail_start = max(0, total - TAIL_BYTES)
    resp = client.get(WHEEL_URL, headers={"Range": f"bytes={tail_start}-{total - 1}"})
    resp.raise_for_status()
    tail = resp.content

    eocd = tail.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise RuntimeError("wheel 尾部找不到 End of Central Directory，文件可能不是 zip")

    count = struct.unpack("<H", tail[eocd + 10 : eocd + 12])[0]
    cd_size, cd_off = struct.unpack("<II", tail[eocd + 12 : eocd + 20])
    # 处理 zip64：字段为 0xFFFFFFFF 时真值在 zip64 EOCD 里，这里按常规大小处理
    cd = tail[cd_off - tail_start : cd_off - tail_start + cd_size]

    out: dict[str, tuple[int, int, int]] = {}
    pos = 0
    for _ in range(count):
        if struct.unpack("<I", cd[pos : pos + 4])[0] != 0x02014B50:
            break
        csize, usize = struct.unpack("<II", cd[pos + 20 : pos + 28])
        nlen, elen, clen = struct.unpack("<HHH", cd[pos + 28 : pos + 34])
        lho = struct.unpack("<I", cd[pos + 42 : pos + 46])[0]
        name = cd[pos + 46 : pos + 46 + nlen].decode("utf-8", "replace")
        out[name] = (lho, csize, usize)
        pos += 46 + nlen + elen + clen
    return out


def _download_range(client: httpx.Client, start: int, end: int, out: Path) -> None:
    """并行分段拉取 [start, end)；服务端返回 200（不支持 Range）时立即放弃。"""
    length = end - start
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        f.truncate(length)  # 预分配：各段可以乱序写入同一文件

    chunk = max(length // CONNECTIONS, 1)
    ranges = []
    pos = start
    while pos < end:
        stop = min(pos + chunk, end)
        ranges.append((pos, stop))
        pos = stop

    def _one(r: tuple[int, int]) -> int:
        s, e = r
        want = e - s
        last: Exception | None = None
        for attempt in range(MAX_RETRY):
            try:
                resp = client.get(WHEEL_URL, headers={"Range": f"bytes={s}-{e - 1}"})
                if resp.status_code != 206:
                    raise RuntimeError(
                        f"服务端不支持 Range 续传（HTTP {resp.status_code}），无法分段下载"
                    )
                data = resp.content
                if len(data) != want:
                    # 长度不对就重试：宁可多下几次也不要写坏文件
                    last = RuntimeError(f"分段 {s}-{e} 长度不符：{len(data)} != {want}")
                    continue
                with out.open("r+b") as f:
                    f.seek(s - start)
                    f.write(data)
                return len(data)
            except Exception as exc:  # noqa: BLE001 - 网络错误必须重试
                last = exc
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"分段 {s}-{e} 重试 {MAX_RETRY} 次仍失败：{last}") from last

    done = 0
    with ThreadPoolExecutor(max_workers=CONNECTIONS) as pool:
        for n in pool.map(_one, ranges):
            done += n
            print(f"\r   已下载 {done / 1e6:7.1f} / {length / 1e6:.1f} MB", end="", flush=True)
    print()


def _inflate_member(blob: bytes) -> bytes:
    """从「本地文件头 + deflate 数据」里还原成员内容。"""
    if blob[:4] != b"PK\x03\x04":
        raise RuntimeError("成员本地头签名不对，抽取的字节范围可能错了")
    nlen, elen = struct.unpack("<HH", blob[26:30])
    data = blob[30 + nlen + elen :]
    return zlib.decompressobj(-zlib.MAX_WBITS).decompress(data)


def fetch(name: str, force: bool = False) -> Path:
    dest_root = _dest_dir()
    rel = MEMBERS[name]
    dest = dest_root / Path(rel.replace("/", "\\"))
    if dest.exists() and dest.stat().st_size > 0 and not force:
        print(f"已存在，跳过：{dest}（{dest.stat().st_size / 1e6:.1f} MB）")
        return dest

    with _http() as client:
        head = client.head(WHEEL_URL)
        head.raise_for_status()
        total = int(head.headers["content-length"])
        print(f"wheel 总大小 {total / 1e6:.1f} MB，正在读取成员表…")

        table = _parse_central_directory(client, total)
        if rel not in table:
            raise RuntimeError(f"wheel 里找不到成员 {rel}；实际有：{list(table)[:5]} …")
        lho, csize, usize = table[rel]

        # 成员本地头紧随其后，多取 1KB 保证把头也拿全
        need = csize + 30 + 1024
        end = min(lho + need, total)
        tmp = dest.with_suffix(".part")
        print(f"下载 {rel}：{(end - lho) / 1e6:.1f} MB（占整个 wheel 的 {(end - lho) / total:.0%}）…")
        _download_range(client, lho, end, tmp)

        blob = tmp.read_bytes()
        raw = _inflate_member(blob)
        if len(raw) != usize:
            raise RuntimeError(f"解压后大小不符：{len(raw)} != {usize}，文件可能损坏")
        tmp.unlink()

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(raw)
    print(f"✅ 写入 {dest}（{len(raw) / 1e6:.1f} MB）")
    return dest


def check() -> int:
    root = _dest_dir()
    ok = True
    for key, rel in MEMBERS.items():
        p = root / Path(rel.replace("/", "\\"))
        mark = "✅" if p.exists() and p.stat().st_size > 0 else ("⬜" if key == "lt" else "❌")
        size = f"{p.stat().st_size / 1e6:.1f} MB" if p.exists() else "缺失"
        print(f"{mark} {rel:42s} {size}")
        if key == "cublas" and not p.exists():
            ok = False
    print(f"\n搜索目录：{root}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="按需抽取 cuBLAS DLL")
    ap.add_argument("--check", action="store_true", help="只检查是否已就绪")
    ap.add_argument("--force", action="store_true", help="已存在也重新下载")
    ap.add_argument("--with-lt", dest="with_lt", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.check:
        return check()

    global WHEEL_URL
    print("探测下载源…")
    WHEEL_URL = _pick_fastest_mirror()

    fetch("cublas", force=args.force)
    # cublas64_12.dll 的静态导入表里就有 cublasLt64_12.dll，
    # 只装前者会报「找不到模块（或它的某个依赖项）」，所以 Lt 是必需的。
    fetch("lt", force=args.force)
    if args.with_lt:
        fetch("lt", force=args.force)
    print("\n验证：")
    return check()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"❌ {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
