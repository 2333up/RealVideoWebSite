# 鲸汐 · 桌面宠物（pet/）

以蓝发女仆形象为原型的 Windows 桌宠，是本仓库的第三个产品，与 `backend/`（灵搜）、
`video-mind/`（视频笔记）平级但**互不依赖**：它不导入任何后端/前端代码，独立打包成 exe。

功能对标「DeepSeek 鲸鱼娘桌宠」的**基础陪伴交互**，不含 AI 对话与语音合成（见文末差异表）。

---

## 怎么用

双击 `Jingxi.exe`（成品在 `桌面\桌宠\Jingxi\`）。

| 操作 | 效果 |
|---|---|
| 拖拽 | 移动位置，松手自动记忆，下次启动回到原位 |
| 单击 | 戳一戳：弹跳 + 随机台词气泡 |
| 按住 0.7 秒 | 摸头：连续小跳 + 害羞台词 |
| 双击 | 撒娇转圈 |
| **滚轮** | **无级缩放（20%~200%，约 6% 一档），停顿 0.4 秒自动保存** |
| 右键 → 尺寸 | 小 140px / 中 200px / 大 280px / 超大 380px / 自定义像素 |
| 右键 → 其它 | 更换形象 / 说句话 / 待机动画 / 开机自启 / 隐藏到托盘 / 退出 |
| 托盘图标 | 点击恢复显示 |

首次启动有 1~3 秒延迟，是 onefile 解压，属正常。

### 关于尺寸

- 默认高度 ≈ **可用屏幕高度的 23%**（1080p 上约 237px），比早期版本（45%、约 464px）小一半。
- 上限 200%、下限 20%，超出范围会被夹住；缩小时底边不动，放大时向上长，不会「陷进任务栏」。
- 尺寸写进 `pet_config.json` 的 `scale`，与位置一起持久化。

---

## 目录结构

```
pet/
├── assets/
│   ├── jingxi-src.jpg        原图（白底）
│   ├── jingxi-cutout.png     抠好的透明 PNG（构建输入）
│   └── preview.png           深色底效果预览
├── build-tools/
│   ├── pet_app.py            桌宠主程序模板（技能模板 + 互动/尺寸扩展）
│   ├── make_cutout.py        白底泛洪抠图（技能脚本对本图判 complex，故自备）
│   ├── check_geometry.py     几何探针：打印窗口/绘制尺寸，排查显示异常
│   └── build_exe.py          PyInstaller 打包 + 成品组装 + 启动自检
└── build/Jingxi/             构建工作区（不入库）
    ├── pet.png / icon.ico / pet_config.json / main.py
    └── dist/Jingxi.exe       打包产物（约 35MB，不入库）
```

`build/` 与 `dist/` 已被根 `.gitignore` 覆盖，**不要把 exe 提交进仓库**。

---

## 开发与打包

依赖装在仓库外的隔离环境（不污染项目）：

```bash
~/.workbuddy/binaries/python/versions/3.13.12/python.exe -m venv \
  ~/.workbuddy/binaries/python/envs/pet
~/.workbuddy/binaries/python/envs/pet/Scripts/python.exe -m pip install \
  -i https://mirrors.aliyun.com/pypi/simple/ PyQt6 pyinstaller pillow
```

> 用阿里源：清华源在本机会返回「无可用版本」，pypi.org 直连约 9s/请求。

```bash
PET_PY="C:/Users/momo/.workbuddy/binaries/python/envs/pet/Scripts/python.exe"
cd pet

# 1. 需要的话重做抠图
$PET_PY build-tools/make_cutout.py assets/jingxi-src.jpg assets/jingxi-cutout.png 16

# 2. 生成素材与配置
$PET_PY "$USERPROFILE/.workbuddy/skills/desktop-pet-maker/scripts/prep_assets.py" \
  --src assets/jingxi-cutout.png --out build/Jingxi --name 鲸汐 --animation breathe

# 3. 打包（--smoke 10 会启动 exe 存活 10 秒作为验收）
$PET_PY build-tools/build_exe.py --dir build/Jingxi --exe-name Jingxi --smoke 10 --smoke-kill
```

`--exe-name` 必须 ASCII（PyInstaller 限制），中文名写在 `--name`（进配置与托盘提示）。

**改台词**：编辑 `build-tools/pet_app.py` 顶部 `LINES` 字典，
`poke` / `pat` / `double` / `talk` 四组分别对应四种互动。

**换形象**：右键「更换形象…」；或先用 `make_cutout.py` 抠成透明 PNG 再选，质量更可控。

---

## 与 DeepSeek 娘的差异（如实说明）

| 能力 | 鲸汐 | DeepSeek 娘 |
|---|---|---|
| 透明置顶 / 拖拽 / 位置记忆 | ✅ | ✅ |
| 尺寸可调 | ✅ 滚轮无级 + 预设 + 自定义像素 | ✅ 多档 |
| 待机动画 | ✅ 呼吸 / 漂浮 / 摇摆 / 静止 | ✅ 多状态 + 待机变体轮换 |
| 戳一戳 / 长按摸头 / 双击 | ✅ | ✅ |
| 台词气泡 | ✅ 35 条离线台词 | ✅ 预合成语音 + 气泡 |
| 语音（TTS） | ❌ 未做 | ✅ edge-tts 预合成 49 条人声 |
| 任务状态联动 | ❌ 不适用 | ✅ 联动 DSH 的 AI 任务进度 |
| AI 对话 | ❌ 不适用 | ⚠️ 部分版本支持 |

台词全部离线硬编码：日常互动要零延迟零成本，接大模型反而会让「戳一下」等上两秒。

---

## 技术要点

- **PyQt6 + PyInstaller onefile**；`FramelessWindowHint | WindowStaysOnTopHint | Tool`
  + `WA_TranslucentBackground` 实现透明置顶，且不占任务栏。
- 气泡是**独立窗口**而非控件内绘制 —— 桌宠窗口按图片尺寸自适应，气泡超界会被裁掉。
- 抠图用**边界泛洪**：种子点取所有接近背景色的边框像素（不只四角），
  这样人物触底、四角不同色的图也能抠；只清理与边框连通的像素，内部白色（女仆头饰）不会被误吃。
- 交互判定靠**位移阈值**：按下到松开位移 > 4px 视为拖拽，否则才判点击；
  拖拽中取消长按计时，避免「拖远了停住」被误判成摸头。
- 滚轮连滚时按 400ms 防抖写盘，避免每一格都触发一次 JSON 落盘。
