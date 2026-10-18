# -*- coding: utf-8 -*-
"""desktop-pet-maker 通用桌宠程序模板（PyQt6，仅 Windows 设计）。

从本文件（或打包后的 exe）同目录读取 pet_config.json：
{
  "name": "团子",            # 名字（托盘提示、自启项命名用）
  "image": "pet.png",       # str；frames 模式下为 str 列表（相对本目录）
  "mode": "static",         # static | gif | frames
  "animation": "breathe",   # breathe | bob | sway | none
  "speed": 1.0,             # 动画速度倍率
  "scale": 1.0,             # 用户缩放 0.5~2.0
  "pos": null,              # [x, y] 位置记忆
  "autostart": false        # 开机自启（HKCU Run）
}

功能：透明无边框置顶窗、拖拽移动、待机动画（底部中心锚点）、右键菜单
（更换形象/缩放/动画/开机自启/退出）、系统托盘。运行期改动全部写回配置。
"""

import json
import math
import os
import random
import shutil
import sys
import time
from collections import deque

from PyQt6.QtCore import Qt, QPoint, QRectF, QSize, QTimer
from PyQt6.QtGui import (QAction, QActionGroup, QColor, QFont, QFontMetrics,
                         QGuiApplication, QIcon, QImage, QMovie, QPainter,
                         QPainterPath, QPen, QPixmap, QTextOption)
from PyQt6.QtWidgets import (QApplication, QFileDialog, QInputDialog, QMenu,
                             QMessageBox, QSystemTrayIcon, QWidget)

IS_WINDOWS = sys.platform == "win32"
if IS_WINDOWS:
    import winreg

# cp1252 等非中文控制台打印含中文的路径/提示时不崩；--noconsole 打包后 stdout 为 None
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

CONFIG_NAME = "pet_config.json"
IMAGE_FILTER = "图片 (*.png *.jpg *.jpeg *.webp *.gif *.bmp);;所有文件 (*)"
ANIMATIONS = (("呼吸", "breathe"), ("漂浮", "bob"), ("摇摆", "sway"), ("静止", "none"))

# 尺寸预设按「目标像素高度」定义，而不是百分比。
# 用户想要的是「大概这么高」，百分比得先脑补原图尺寸才换算得出来；
# 而且素材一换（800px / 1200px），同一句「75%」显示出来的大小就变了。
HEIGHT_PRESETS = (("小 · 140px", 140), ("中 · 200px", 200),
                  ("大 · 280px", 280), ("超大 · 380px", 380))
MIN_SCALE, MAX_SCALE = 0.2, 2.0   # 200% 上限沿用旧行为，下限从 50% 放宽到 20%
WHEEL_STEP = 1.06                 # 滚轮每格的缩放倍率（约 6%，手感接近图片查看器）


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def load_config():
    path = os.path.join(app_dir(), CONFIG_NAME)
    data = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as exc:
            print("pet_config.json 解析失败:", exc)
    cfg = {"_path": path}
    cfg["name"] = str(data.get("name", "桌宠"))
    cfg["image"] = data.get("image", "pet.png")
    cfg["mode"] = data.get("mode", "static")
    cfg["animation"] = data.get("animation", "breathe")
    cfg["speed"] = float(data.get("speed", 1.0)) or 1.0
    try:
        cfg["scale"] = min(MAX_SCALE, max(MIN_SCALE, float(data.get("scale", 1.0))))
    except (TypeError, ValueError):
        cfg["scale"] = 1.0
    pos = data.get("pos")
    cfg["pos"] = [int(pos[0]), int(pos[1])] if isinstance(pos, (list, tuple)) and len(pos) == 2 else None
    cfg["autostart"] = bool(data.get("autostart", False))
    return cfg


def save_config(cfg):
    out = {k: cfg[k] for k in ("name", "image", "mode", "animation", "speed",
                               "scale", "pos", "autostart")}
    try:
        with open(cfg["_path"], "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        print("配置保存失败:", exc)


def cutout_image(path, tol=30):
    """更换形象时的兜底抠图：四角取背景色 + 边界泛洪清除。复杂背景原样返回。"""
    img = QImage(path)
    if img.isNull():
        return None
    if img.width() > 800 or img.height() > 800:
        img = img.scaled(800, 800, Qt.AspectRatioMode.KeepAspectRatio,
                         Qt.TransformationMode.SmoothTransformation)
    img = img.convertToFormat(QImage.Format.Format_ARGB32)
    w, h = img.width(), img.height()
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    cols = [img.pixelColor(x, y) for x, y in pts]
    if any(c.alpha() < 250 for c in cols):
        return img
    bg = (sum(c.red() for c in cols) // 4,
          sum(c.green() for c in cols) // 4,
          sum(c.blue() for c in cols) // 4)
    if max(max(abs(c.red() - bg[0]), abs(c.green() - bg[1]), abs(c.blue() - bg[2]))
           for c in cols) > 12:
        return img

    def near_bg(c):
        return (abs(c.red() - bg[0]) <= tol and abs(c.green() - bg[1]) <= tol
                and abs(c.blue() - bg[2]) <= tol)

    seen = bytearray(w * h)
    dq = deque()
    for x in range(w):
        dq.append((x, 0))
        dq.append((x, h - 1))
    for y in range(h):
        dq.append((0, y))
        dq.append((w - 1, y))
    while dq:
        x, y = dq.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        c = img.pixelColor(x, y)
        if not near_bg(c):
            continue
        img.setPixelColor(x, y, QColor(c.red(), c.green(), c.blue(), 0))
        dq.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return img


# ---------------------------------------------------------------------------
# 互动台词（参考「DeepSeek 鲸鱼娘桌宠」的戳一戳 / 摸头反应）
#
# 全部离线硬编码：不联网、不调 AI、不消耗任何 Token —— 桌宠的日常互动应当是
# 零延迟零成本的，接大模型反而会让「戳一下」等上两秒。
# ---------------------------------------------------------------------------
LINES = {
    "poke": ("诶嘿～", "别戳啦，痒！", "在的在的～", "找我有事吗？", "唔…被你发现了",
             "戳一下要扣一颗糖哦", "干嘛呀（小声）"),
    "pat": ("呜哇…好舒服～", "再摸摸头嘛", "嘿嘿，最喜欢你了", "唔…要睡着啦",
            "头发要乱掉了啦"),
    "double": ("转圈圈～", "看我帅不帅！", "哼哼～", "闪亮登场！"),
    "idle": ("今天也要加油哦", "记得喝水～", "坐久了站起来动一动吧",
             "我一直在这里陪着你", "要不要听首歌？", "摸鱼也要适度哦"),
    "talk": ("嗯？我一直都在呀", "有问题随时叫我", "今天过得怎么样？"),
}

LONG_PRESS_MS = 700   # 按住超过这个时长算「摸头」
CLICK_SLOP = 4        # 位移小于该像素仍视为点击（区分拖拽）


class SpeechBubble(QWidget):
    """头顶台词气泡：独立透明置顶小窗，跟随桌宠、超时淡出。

    为什么不画在桌宠窗口内：桌宠窗口按图片尺寸自适应，气泡一旦超出边界就会被裁掉；
    单独开一个 Tool 窗口既能随意越界，也不会抢焦点（WindowTransparentForInput）。
    """

    MAX_W = 240
    PAD_X, PAD_Y = 11, 7
    TAIL = 7

    def __init__(self):
        super().__init__(None, Qt.WindowType.FramelessWindowHint
                         | Qt.WindowType.WindowStaysOnTopHint
                         | Qt.WindowType.Tool
                         | Qt.WindowType.WindowTransparentForInput)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self._text = ""
        self._font = QFont()
        self._font.setPointSize(9)
        self._fade = QTimer(self)
        self._fade.setInterval(40)
        self._fade.timeout.connect(self._step_fade)
        self._hold = QTimer(self)
        self._hold.setSingleShot(True)
        self._hold.timeout.connect(self._fade.start)

    def say(self, text, msec=2800):
        self._text = text
        self._fade.stop()
        fm = QFontMetrics(self._font)
        need = fm.boundingRect(0, 0, self.MAX_W, 4000,
                               int(Qt.TextFlag.TextWordWrap), text)
        w = max(76, need.width() + self.PAD_X * 2)
        h = need.height() + self.PAD_Y * 2 + self.TAIL
        self.resize(w, h)
        self.setWindowOpacity(1.0)
        self.show()
        self.raise_()
        self.update()
        self._hold.start(msec)

    def _step_fade(self):
        op = self.windowOpacity() - 0.12
        if op <= 0.02:
            self._fade.stop()
            self.hide()
            self._text = ""
            return
        self.setWindowOpacity(op)

    def paintEvent(self, _ev):
        if not self._text:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        body = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -self.TAIL - 0.5)
        path = QPainterPath()
        path.addRoundedRect(body, 10, 10)
        # 底部小三角指向桌宠
        tip = QPainterPath()
        cx = self.width() / 2.0
        tip.moveTo(cx - 6, body.bottom() - 1)
        tip.lineTo(cx, body.bottom() + self.TAIL)
        tip.lineTo(cx + 6, body.bottom() - 1)
        tip.closeSubpath()
        path.addPath(tip)
        p.setPen(QPen(QColor(188, 202, 224), 1))
        p.setBrush(QColor(255, 255, 255, 242))
        p.drawPath(path.simplified())
        p.setPen(QColor(48, 62, 88))
        p.setFont(self._font)
        opt = QTextOption()
        opt.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        p.drawText(body.adjusted(self.PAD_X, self.PAD_Y, -self.PAD_X, -self.PAD_Y),
                   self._text, opt)
        p.end()


class PetWidget(QWidget):
    def __init__(self, cfg):
        super().__init__(None, Qt.WindowType.FramelessWindowHint
                         | Qt.WindowType.WindowStaysOnTopHint
                         | Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.cfg = cfg
        self.movie = None
        self.frames = []
        self.frame_idx = 0
        self.base_pix = QPixmap()
        self.draw_pix = QPixmap()
        self.nat_w = self.nat_h = 0
        self.disp_w = self.disp_h = 0
        self.t = 0.0
        self._dragging = False
        self._drag_off = QPoint()
        # ---- 互动状态 ----
        self.bubble = SpeechBubble()
        self._press_ms = 0.0
        self._moved = False
        self._handled = False          # 长按已触发 → 松开时不再算「戳」
        self._react_kind = ""
        self._react_t0 = 0.0
        self._react_dur = 0.0
        self._long_timer = QTimer(self)
        self._long_timer.setSingleShot(True)
        self._long_timer.timeout.connect(self._on_long_press)
        self._load_payload()
        if self.base_pix.isNull():
            raise RuntimeError("没有可显示的桌宠图片（pet_config.json 的 image 无效）")
        self._fit_base()
        self._apply_scale()
        self._restore_pos()
        self._place_bubble()
        self.anim_timer = QTimer(self)
        self.anim_timer.timeout.connect(self._tick)
        self.anim_timer.start(33)
        if self.movie:
            self._start_movie()
        elif self.cfg["mode"] == "frames" and len(self.frames) > 1:
            self.frame_timer = QTimer(self)
            self.frame_timer.timeout.connect(self._next_frame)
            self.frame_timer.start(120)

    # ---------- 素材装载 ----------

    def _load_payload(self):
        d = app_dir()
        img = self.cfg["image"]
        if self.cfg["mode"] == "gif":
            p = img if os.path.isabs(str(img)) else os.path.join(d, str(img))
            if os.path.exists(p):
                mv = QMovie(p)
                mv.jumpToFrame(0)
                self.movie = mv
                self.base_pix = mv.currentPixmap()
                return
        names = img if isinstance(img, list) else [img]
        pixmaps = []
        for n in names:
            p = n if os.path.isabs(str(n)) else os.path.join(d, str(n))
            pm = QPixmap(p)
            if not pm.isNull():
                pixmaps.append(pm)
        if pixmaps:
            self.frames = pixmaps if self.cfg["mode"] == "frames" else pixmaps[:1]
            self.base_pix = self.frames[0]

    def _start_movie(self):
        try:
            self.movie.frameChanged.disconnect()
        except TypeError:
            pass
        self.movie.frameChanged.connect(self._on_movie_frame)
        self.movie.start()

    def _fit_base(self):
        pw, ph = self.base_pix.width(), self.base_pix.height()
        if pw <= 0 or ph <= 0:
            pw, ph = 200, 200
        g = QGuiApplication.primaryScreen().availableGeometry()
        # 基准尺寸取可用高度的 23%（1080p 上约 237px），而不是原来的 45%。
        # 45% 会让桌宠占掉小半屏，第一次打开就嫌大 —— 想要更大的用户
        # 滚一下滚轮即可，反过来「默认太大」却会让人第一眼就放弃。
        f = min((g.height() * 0.23) / ph, (g.width() * 0.4) / pw)
        f = max(f, 96.0 / ph)
        f = min(f, 1.6)
        self.nat_w, self.nat_h = int(pw * f), int(ph * f)

    def _apply_scale(self):
        self.disp_w = max(48, int(self.nat_w * self.cfg["scale"]))
        self.disp_h = max(48, int(self.nat_h * self.cfg["scale"]))
        self.resize(self.disp_w + 12, self.disp_h + 12)
        self._rescale_draw_pix()
        if self.movie:
            self.movie.setScaledSize(QSize(self.disp_w, self.disp_h))
        # 尺寸变了窗口也变了，气泡要重新贴回头顶
        self._place_bubble()

    def _rescale_draw_pix(self):
        if not self.base_pix.isNull():
            self.draw_pix = self.base_pix.scaled(
                self.disp_w, self.disp_h, Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation)

    def _restore_pos(self):
        pos = self.cfg.get("pos")
        if pos:
            x, y = pos
        else:
            g = QGuiApplication.primaryScreen().availableGeometry()
            # 贴住任务栏上沿。半身像素材底部是平切的，悬空会露出一条直线切口；
            # 让它落在可用区底边，切口就与任务栏边界重合，视觉上自然。
            x, y = g.right() - self.width() - 80, g.bottom() - self.height()
        anchor = QPoint(x + self.width() // 2, y + self.height() // 2)
        screen = QGuiApplication.screenAt(anchor) or QGuiApplication.primaryScreen()
        g = screen.availableGeometry()
        x = min(max(g.left(), x), max(g.left(), g.right() - self.width()))
        y = min(max(g.top(), y), max(g.top(), g.bottom() - self.height()))
        self.move(x, y)

    # ---------- 动画 ----------

    def _tick(self):
        self.t += 0.033 * self.cfg["speed"]
        self.update()

    def _on_movie_frame(self, _frame):
        self.base_pix = self.movie.currentPixmap()
        self._rescale_draw_pix()
        self.update()

    def _next_frame(self):
        self.frame_idx = (self.frame_idx + 1) % len(self.frames)
        self.base_pix = self.frames[self.frame_idx]
        self._rescale_draw_pix()
        self.update()

    def _anim_params(self):
        mode, t = self.cfg["animation"], self.t
        if mode == "breathe":
            s = 1.0 + 0.028 * math.sin(2 * math.pi * t / 2.4)
            return 0.0, s, s, 0.0
        if mode == "bob":
            return 8.0 * math.sin(2 * math.pi * t / 2.0), 1.0, 1.0, 0.0
        if mode == "sway":
            return 0.0, 1.0, 1.0, 3.5 * math.sin(2 * math.pi * t / 3.0)
        return 0.0, 1.0, 1.0, 0.0

    def paintEvent(self, _ev):
        if self.draw_pix.isNull():
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        dy, sx, sy, rot = self._anim_params()
        # 互动反应叠加在待机动画之上：待机负责「活着」，反应负责「被戳到了」
        rdy, rsx, rsy, rrot = self._reaction_params()
        dy += rdy
        sx *= rsx
        sy *= rsy
        rot += rrot
        if self._dragging:
            sx, sy = sx * 1.04, sy * 0.96
        p.translate(self.width() / 2.0, self.height())
        if rot:
            p.rotate(rot)
        p.scale(sx, sy)
        p.translate(0.0, dy)
        p.drawPixmap(QPoint(-self.draw_pix.width() // 2, -self.draw_pix.height()), self.draw_pix)
        p.end()

    # ---------- 交互 ----------

    def mousePressEvent(self, ev):
        if ev.button() != Qt.MouseButton.LeftButton:
            return
        self._dragging = True
        self._moved = False
        self._handled = False
        self._press_pos = ev.globalPosition().toPoint()
        self._press_ms = time.monotonic()
        self._drag_off = self._press_pos - self.frameGeometry().topLeft()
        self._long_timer.start(LONG_PRESS_MS)
        self.raise_()

    def mouseMoveEvent(self, ev):
        if not self._dragging:
            return
        cur = ev.globalPosition().toPoint()
        if (cur - self._press_pos).manhattanLength() > CLICK_SLOP:
            self._moved = True
            # 一旦开始拖拽就别再判摸头，否则「拖远了停住」会误触
            self._long_timer.stop()
        self.move(cur - self._drag_off)

    def mouseReleaseEvent(self, ev):
        if ev.button() != Qt.MouseButton.LeftButton or not self._dragging:
            return
        self._dragging = False
        self._long_timer.stop()
        elapsed = (time.monotonic() - self._press_ms) * 1000
        if self._moved:
            self._save_pos()
            return
        # 无位移：短按 = 戳一戳；长按已由计时器处理过，这里不再重复触发
        if not self._handled and elapsed < LONG_PRESS_MS:
            self._react("poke")

    def mouseDoubleClickEvent(self, ev):
        if ev.button() == Qt.MouseButton.LeftButton:
            self._long_timer.stop()
            self._handled = True
            self._react("double")

    def moveEvent(self, ev):
        super().moveEvent(ev)
        self._place_bubble()

    def hideEvent(self, ev):
        super().hideEvent(ev)
        self.bubble._fade.stop()
        self.bubble.hide()

    def _on_long_press(self):
        """按住不放 = 摸头；拖拽中的长按不算。"""
        if self._dragging and not self._moved:
            self._handled = True
            self._react("pat")

    def _react(self, kind):
        lines = LINES["talk"] if kind == "talk" else LINES.get(kind, LINES["idle"])
        self._react_kind = kind
        self._react_t0 = time.monotonic()
        # 摸头是连跳三下，戳一戳是单次弹跳
        self._react_dur = 1.15 if kind == "pat" else 0.62
        self.bubble.say(random.choice(lines))
        self._place_bubble()
        self.update()

    def _reaction_params(self):
        """返回反应附加的 (dy, sx, sy, rot)；结束或未触发时为零/1。"""
        if not self._react_kind:
            return 0.0, 1.0, 1.0, 0.0
        p = (time.monotonic() - self._react_t0) / max(self._react_dur, 1e-3)
        if p >= 1.0:
            self._react_kind = ""
            return 0.0, 1.0, 1.0, 0.0
        if self._react_kind == "pat":
            # squash & stretch：压扁回弹 + 左右轻晃，比整体缩放更像活物
            dy = -9.0 * abs(math.sin(p * math.pi * 3))
            sy = 1.0 + 0.05 * math.sin(p * math.pi * 6)
            sx = 1.0 - 0.035 * math.sin(p * math.pi * 6)
            rot = 3.0 * math.sin(p * math.pi * 6)
        else:
            dy = -16.0 * math.sin(p * math.pi)
            sy = 1.0 + 0.07 * math.sin(p * math.pi)
            sx = 1.0 - 0.05 * math.sin(p * math.pi)
            rot = -5.0 * math.sin(p * math.pi)
        return dy, sx, sy, rot

    def _place_bubble(self):
        """气泡永远贴在头顶，并夹在屏幕内（拖到屏幕边缘时不被截断）。"""
        if not getattr(self, "bubble", None) or not self.bubble.isVisible():
            return
        g = (QGuiApplication.screenAt(self.frameGeometry().center())
             or QGuiApplication.primaryScreen()).availableGeometry()
        bw, bh = self.bubble.width(), self.bubble.height()
        x = self.x() + (self.width() - bw) // 2
        y = self.y() - bh + 6
        x = min(max(g.left() + 4, x), max(g.left() + 4, g.right() - bw - 4))
        y = max(g.top() + 4, y)
        self.bubble.move(x, y)

    def closeEvent(self, _ev):
        self._save_pos()

    def _save_pos(self):
        self.cfg["pos"] = [self.x(), self.y()]
        save_config(self.cfg)

    def contextMenuEvent(self, ev):
        self._build_menu().exec(ev.globalPos())

    def _build_menu(self):
        menu = QMenu(self)
        a_change = QAction("更换形象…", menu)
        a_change.triggered.connect(self._change_image)
        menu.addAction(a_change)

        a_say = QAction("说句话", menu)
        a_say.triggered.connect(lambda: self._react("talk"))
        menu.addAction(a_say)

        size_menu = menu.addMenu("尺寸")
        cur_h = self._height_px()
        size_group = QActionGroup(size_menu)
        for label, h in HEIGHT_PRESETS:
            act = QAction(label, size_menu, checkable=True)
            act.setChecked(abs(cur_h - h) <= 3)
            act.triggered.connect(lambda _=False, v=h: self._set_height(v))
            size_group.addAction(act)
            size_menu.addAction(act)
        size_menu.addSeparator()
        a_custom = QAction(f"自定义…（当前 {cur_h}px）", size_menu)
        a_custom.triggered.connect(self._ask_height)
        size_menu.addAction(a_custom)
        # 滚轮是隐藏操作，菜单里点一句，否则没人会发现
        a_hint = QAction("滚轮可直接缩放", size_menu)
        a_hint.setEnabled(False)
        size_menu.addAction(a_hint)

        anim_menu = menu.addMenu("待机动画")
        anim_group = QActionGroup(anim_menu)
        for label, key in ANIMATIONS:
            act = QAction(label, anim_menu, checkable=True)
            act.setChecked(self.cfg["animation"] == key)
            act.triggered.connect(lambda _=False, k=key: self._set_anim(k))
            anim_group.addAction(act)
            anim_menu.addAction(act)

        a_auto = QAction("开机自启", menu, checkable=True)
        a_auto.setChecked(self.cfg["autostart"])
        a_auto.triggered.connect(self._toggle_autostart)
        menu.addAction(a_auto)

        menu.addSeparator()
        a_hide = QAction("隐藏到托盘", menu)
        a_hide.triggered.connect(self.hide)
        menu.addAction(a_hide)
        a_quit = QAction("退出", menu)
        a_quit.triggered.connect(self._quit)
        menu.addAction(a_quit)
        return menu

    def _set_scale(self, val, persist=True):
        val = min(MAX_SCALE, max(MIN_SCALE, float(val)))
        if abs(val - self.cfg["scale"]) < 1e-4:
            return
        old_h = self.height()
        self.cfg["scale"] = val
        self._apply_scale()
        # 底边对齐：放大时向上长、缩小时向下收，脚始终踩在原处
        self.move(self.x(), self.y() + old_h - self.height())
        if persist:
            self._save_pos()
        else:
            self._schedule_save()

    def _height_px(self):
        return int(round(self.nat_h * self.cfg["scale"]))

    def _set_height(self, h):
        """按目标像素高度设置；预设档与自定义输入都走这里。"""
        if self.nat_h <= 0:
            return
        self._set_scale(h / self.nat_h)

    def _ask_height(self):
        val, ok = QInputDialog.getInt(
            self, "桌宠尺寸", "高度（像素，80 ~ 900）：", self._height_px(), 80, 900, 10)
        if ok:
            self._set_height(val)

    def _schedule_save(self):
        """滚轮连滚时不要每格都写盘，停顿 400ms 再落盘。"""
        if not hasattr(self, "_save_timer"):
            self._save_timer = QTimer(self)
            self._save_timer.setSingleShot(True)
            self._save_timer.timeout.connect(self._save_pos)
        self._save_timer.start(400)

    def wheelEvent(self, ev):
        d = ev.angleDelta().y()
        if not d:
            return
        self._set_scale(self.cfg["scale"] * (WHEEL_STEP if d > 0 else 1 / WHEEL_STEP),
                        persist=False)
        ev.accept()

    def _set_anim(self, key):
        self.cfg["animation"] = key
        save_config(self.cfg)

    def _change_image(self):
        path, _ = QFileDialog.getOpenFileName(self, "选择桌宠形象", "", IMAGE_FILTER)
        if not path:
            return
        ext = os.path.splitext(path)[1].lower()
        d = app_dir()
        try:
            if ext == ".gif":
                dst = os.path.join(d, "pet_custom.gif")
                shutil.copyfile(path, dst)
                self.cfg["mode"], self.cfg["image"] = "gif", "pet_custom.gif"
            else:
                img = cutout_image(path)
                if img is None:
                    QMessageBox.warning(self, "桌宠", "图片读取失败，请换一张图片。")
                    return
                dst = os.path.join(d, "pet_custom.png")
                img.save(dst, "PNG")
                self.cfg["mode"], self.cfg["image"] = "static", "pet_custom.png"
            self.movie, self.frames, self.frame_idx = None, [], 0
            self._load_payload()
            if self.base_pix.isNull():
                QMessageBox.warning(self, "桌宠", "新形象无法显示，已保留原配置。")
                self.cfg["mode"], self.cfg["image"] = "static", "pet.png"
                self._load_payload()
                if self.base_pix.isNull():
                    raise RuntimeError("原图片也加载失败")
            self._fit_base()
            self._apply_scale()
            if self.movie:
                self._start_movie()
            save_config(self.cfg)
        except Exception as exc:
            QMessageBox.warning(self, "桌宠", f"更换形象失败：{exc}")

    def _toggle_autostart(self, checked):
        self.cfg["autostart"] = checked
        save_config(self.cfg)
        if not IS_WINDOWS:
            return
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        val_name = "DesktopPet-" + ("".join(c for c in self.cfg["name"] if c.isalnum()) or "Pet")
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0,
                                winreg.KEY_SET_VALUE) as k:
                if checked:
                    if getattr(sys, "frozen", False):
                        val = f'"{sys.executable}"'
                    else:
                        pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
                        val = f'"{pythonw}" "{os.path.abspath(__file__)}"'
                    winreg.SetValueEx(k, val_name, 0, winreg.REG_SZ, val)
                else:
                    try:
                        winreg.DeleteValue(k, val_name)
                    except FileNotFoundError:
                        pass
        except OSError as exc:
            QMessageBox.warning(self, "桌宠", f"开机自启设置失败：{exc}")
            self.cfg["autostart"] = not checked
            save_config(self.cfg)

    def _quit(self):
        self._save_pos()
        QApplication.quit()


def main():
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationName("DesktopPet")
    cfg = load_config()
    try:
        pet = PetWidget(cfg)
    except Exception as exc:
        QMessageBox.critical(None, "桌宠",
                             f"桌宠启动失败：{exc}\n"
                             "请确认 pet_config.json 与图片文件在本程序同目录。")
        return 2
    icon_path = os.path.join(app_dir(), "icon.ico")
    icon = QIcon(icon_path) if os.path.exists(icon_path) else QIcon(pet.base_pix)
    tray = QSystemTrayIcon(icon)
    tray.setToolTip(cfg["name"])
    tray.setContextMenu(pet._build_menu())
    tray.activated.connect(
        lambda reason: pet.show()
        if reason == QSystemTrayIcon.ActivationReason.Trigger else None)
    tray.show()
    pet.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
