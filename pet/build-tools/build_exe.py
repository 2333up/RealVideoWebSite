# -*- coding: utf-8 -*-
r"""desktop-pet-maker 打包脚本：PyInstaller 打包 + 桌面成品组装 + 启动自检

用法：
  python build_exe.py --dir <构建目录> --exe-name MyPet --smoke 8 --smoke-kill

流程：复制 pet_app.py → main.py；PyInstaller --onefile --noconsole 打包；
把 exe + 配置 + 图片 + icon + main.py + 启动源码版.bat 组装到 桌面\桌宠\<exe名>\；
--smoke N 启动 exe 存活 N 秒视为通过（--smoke-kill 则随后关闭）。
stdout 打印 [build] 开头的关键行（BUILD / FINAL / SMOKE 等）供调用方解析。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(SKILL_DIR, "pet_app.py")

# cp1252 等非中文控制台打印含中文的路径（如 桌面\桌宠\）时不崩
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def log(key, value):
    print(f"[build] {key}={value}")


def desktop_dir():
    if sys.platform == "win32":
        import ctypes
        buf = ctypes.create_unicode_buffer(300)
        # CSIDL_DESKTOP = 0（跟随资源管理器的重定向，如 D:\桌面 / OneDrive）
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0, None, 0, buf) == 0 and buf.value:
            return buf.value
    return os.path.join(os.path.expanduser("~"), "Desktop")


def build(build_dir, exe_name):
    main_py = os.path.join(build_dir, "main.py")
    shutil.copyfile(TEMPLATE, main_py)
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile",
           "--noconsole", "--name", exe_name,
           "--distpath", os.path.join(build_dir, "dist"),
           "--workpath", os.path.join(build_dir, "_build"),
           "--specpath", os.path.join(build_dir, "_build")]
    icon = os.path.join(build_dir, "icon.ico")
    if os.path.exists(icon):
        cmd += ["--icon", icon]
    cmd.append(main_py)
    proc = subprocess.run(cmd, cwd=build_dir, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        with open(os.path.join(build_dir, "build_error.log"), "w",
                  encoding="utf-8") as f:
            f.write(proc.stdout or "")
            f.write("\n--- stderr ---\n")
            f.write(proc.stderr or "")
        return None
    exe = os.path.join(build_dir, "dist", exe_name + ".exe")
    return exe if os.path.exists(exe) else None


def assemble(build_dir, exe_name, exe_path):
    final = os.path.join(desktop_dir(), "桌宠", exe_name)
    os.makedirs(final, exist_ok=True)
    shutil.copyfile(exe_path, os.path.join(final, exe_name + ".exe"))

    with open(os.path.join(build_dir, "pet_config.json"), encoding="utf-8") as f:
        cfg = json.load(f)

    def copy_resource(rel):
        src = rel if os.path.isabs(str(rel)) else os.path.join(build_dir, str(rel))
        if not os.path.exists(src):
            return None
        name = os.path.basename(str(rel))
        shutil.copyfile(src, os.path.join(final, name))
        return name

    img = cfg.get("image")
    if isinstance(img, list):
        cfg["image"] = [copy_resource(n) for n in img]
    elif img:
        cfg["image"] = copy_resource(img)

    for fname in ("pet_config.json", "icon.ico", "main.py"):
        p = os.path.join(build_dir, fname)
        if os.path.exists(p):
            shutil.copyfile(p, os.path.join(final, fname))
    with open(os.path.join(build_dir, "pet_config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    bat = os.path.join(final, "启动源码版.bat")
    with open(bat, "w", encoding="ascii", newline="\r\n") as f:
        f.write('@echo off\r\nstart "" pythonw "%~dp0main.py"\r\n')
    return final


def smoke(exe_path, seconds, kill):
    proc = subprocess.Popen([exe_path])
    time.sleep(seconds)
    alive = proc.poll() is None
    if alive and kill:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/F", "/T"],
                       capture_output=True)
        time.sleep(1)
    return alive, proc.poll()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="构建目录（prep_assets.py 的 --out）")
    ap.add_argument("--exe-name", required=True, help="exe 名，必须 ASCII")
    ap.add_argument("--smoke", type=int, default=8,
                    help="启动自检秒数，0 跳过")
    ap.add_argument("--smoke-kill", action="store_true", help="自检通过后关闭 exe")
    args = ap.parse_args()

    if not args.exe_name.isascii():
        log("ERROR", "exe-name 必须是 ASCII")
        return 1
    build_dir = os.path.abspath(args.dir)
    if not os.path.exists(os.path.join(build_dir, "pet_config.json")):
        log("ERROR", f"{build_dir} 里没有 pet_config.json，先跑 prep_assets.py")
        return 1

    log("STEP", "pyinstaller running (1-3 min)...")
    exe = build(build_dir, args.exe_name)
    if exe is None:
        log("BUILD", "failed")
        log("LOG", os.path.join(build_dir, "build_error.log"))
        return 2
    log("BUILD", "ok")
    log("EXE", exe)

    final = assemble(build_dir, args.exe_name, exe)
    log("FINAL", final)

    if args.smoke > 0:
        alive, rc = smoke(os.path.join(final, args.exe_name + ".exe"),
                          args.smoke, args.smoke_kill)
        log("SMOKE", "alive" if alive else f"exited rc={rc}")
        return 0 if alive else 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
