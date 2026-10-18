# 鲸汐 · 桌面宠物（pet/）

以角色三视图（正 / 侧 / 背 / 演唱姿势）为素材的 Windows 桌宠，是本仓库的第三个产品，
与 `backend/`（灵搜）、`video-mind/`（视频笔记）平级但**互不依赖**：
它不导入任何后端/前端代码，独立打包成 exe。

功能对标「DeepSeek 鲸鱼娘桌宠」的**基础陪伴交互**，不含 AI 对话与语音合成（见文末差异表）。

---

## 怎么用

双击 `Jingxi.exe`（成品在 `桌面\桌宠\Jingxi\`）。

| 操作 | 效果 |
|---|---|
| **自动走动** | 每隔 6~14 秒自己走一段（2.5~6 秒），走到屏幕边缘会转身，鼠标悬停即停 |
| 拖拽 | 移动位置，**拖拽时呈「被举起」姿态**（手臂上举、双腿悬空），松手记忆位置 |
| 单击 | 戳一戳：**切到演唱姿势** + 弹跳 + 随机台词气泡 |
| 按住 0.7 秒 | 摸头：演唱姿势 + 连续小跳 + 害羞台词 |
| 双击 | **转身**（切到背面姿势）+ 撒娇台词 |
| **滚轮** | **无级缩放（20%~200%，约 6% 一档），停顿 0.4 秒自动保存** |
| 右键 → 尺寸 | 小 140px / 中 200px / 大 280px / 超大 380px / 自定义像素 |
| 右键 → 其它 | 更换形象 / 说句话 / 待机动画 / 开机自启 / 隐藏到托盘 / 退出 |
| 托盘图标 | 点击恢复显示 |

动作结束后自动回到正面待机姿势。首次启动有 1~3 秒延迟，是 onefile 解压，属正常。

### 自动走动

参数在 `pet_config.json` 的 `walk` 里，改完重启即生效，不用重新打包：

```json
"walk": { "frames": [4,5,6,7], "speed": 46, "pause": [6,14], "duration": [2.5,6.0], "fps": 7.5 }
```

- `speed`：像素/秒。1080p 上 46 大约是「慢慢晃过去」的速度。
- `pause` / `duration`：两次走动的间隔、单次走动的时长（都取区间随机，避免机械感）。
- `fps`：迈步换帧频率。四个走路帧循环播放。
- **悬停即停**：鼠标移到她身上会站住，方便点击；移开一会儿再继续。
- 拖拽、做反应、气泡显示期间都不会走动，避免和用户"抢"位置。
- 朝左走时用**水平镜像**实现（素材只有一个朝向），不会出现两个人影。

### 关于尺寸

- 默认高度 ≈ **可用屏幕高度的 23%**（1080p 上约 237px）。
- 上限 200%、下限 20%，超出范围会被夹住；缩小时底边不动，放大时向上长，不会「陷进任务栏」。
- 尺寸写进 `pet_config.json` 的 `scale`，与位置一起持久化。

---

## 目录结构

```
pet/
├── assets/
│   ├── deepseek-chan-sheet.jpg   角色三视图（构建输入）
│   ├── gen/                      AI 补生成的素材：走路精灵图 / 被举起姿态
│   ├── preview.png               四姿态深底预览
│   └── fonts/
│       ├── pet-bubble.ttf        气泡用手写体（53KB 子集）
│       └── OFL.txt               字体授权（SIL Open Font License 1.1）
├── build-tools/
│   ├── pet_app.py                桌宠主程序模板（多姿态/走动/互动/尺寸）
│   ├── make_poses.py             三视图 → 多姿态帧（抠底/对齐/统一画布）+ 配置与图标
│   ├── add_frames.py             追加走路帧与「被举起」帧，并同步配置
│   ├── make_bubble_font.py       按台词表裁剪字体子集（改台词后需重跑）
│   ├── make_cutout.py            单张白底图抠图（换单张形象时用）
│   ├── check_geometry.py         几何探针：打印窗口/绘制尺寸，排查显示异常
│   └── build_exe.py              PyInstaller 打包 + 成品组装 + 启动自检
└── build/Jingxi/                 构建工作区（不入库）
    ├── frames/f000..f008.png     正 / 侧 / 背 / 演唱 / 走路×4 / 被举起
    ├── fonts/pet-bubble.ttf      气泡字体（打包时整目录复制到成品）
    ├── pet_config.json           名字 / 姿态映射 / 走动参数 / 尺寸 / 位置
    └── dist/Jingxi.exe           打包产物（约 35MB）
```

`build/` 与 `dist/` 已被根 `.gitignore` 覆盖，**不要把 exe 提交进仓库**。

### 多姿态是怎么对齐的

三视图里每个姿势的尺寸与基线并不一致，直接当独立图片切换会「跳一下」。
`make_poses.py` 做了三件事：

1. **按列投影自动切图**（不写死坐标），再按行收紧 bbox；
2. **边界泛洪抠白底**：种子取所有接近白色的边框像素，只清理与边框连通的像素，
   所以头发、围裙这些内部白色不会被误吃；
3. **统一缩放 + 按脚底居中贴到同尺寸画布**（704×820），此后切换帧只是换像素内容，
   位置和比例完全不变。

姿态映射写在 `pet_config.json` 的 `poses` 里，改映射不用重新打包：

```json
"poses": { "idle": 0, "drag": 1, "double": 2, "poke": 3, "pat": 3 }
```

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

# 1. 三视图 → 4 个基础姿态 + pet_config.json + icon.ico（加 --preview 出预览图）
$PET_PY build-tools/make_poses.py --sheet assets/deepseek-chan-sheet.jpg \
  --out build/Jingxi --name 鲸汐 --preview

# 2. 追加走路循环与「被举起」姿态（会同步更新 poses / walk 配置）
$PET_PY build-tools/add_frames.py --build build/Jingxi \
  --walk-sheet assets/gen/walk-sheet.png --walk-count 4 \
  --extra assets/gen/grab-pose.png

# 3. 气泡字体子集（改了 LINES 台词就必须重跑，否则新字的字形会回退系统字体）
$PET_PY build-tools/make_bubble_font.py --src <霞鹜文楷完整字体.ttf> \
  --out assets/fonts/pet-bubble.ttf
cp assets/fonts/pet-bubble.ttf build/Jingxi/fonts/

# 4. 打包（--smoke 10 会启动 exe 存活 10 秒作为验收）
$PET_PY build-tools/build_exe.py --dir build/Jingxi --exe-name Jingxi --smoke 10 --smoke-kill
```

`--exe-name` 必须 ASCII（PyInstaller 限制），中文名写在 `--name`（进配置与托盘提示）。

**改台词**：编辑 `build-tools/pet_app.py` 顶部 `LINES` 字典，
`poke` / `pat` / `double` / `talk` 四组分别对应四种互动。

**换形象**：右键「更换形象…」选单张图（程序会现场抠白底）；
要用新的三视图，改 `--sheet` 重跑步骤 1 即可，帧数与映射会自动适配。

---

## 与 DeepSeek 娘的差异（如实说明）

| 能力 | 鲸汐 | DeepSeek 娘 |
|---|---|---|
| 透明置顶 / 拖拽 / 位置记忆 | ✅ | ✅ |
| 多姿态切换 | ✅ 9 帧（正/侧/背/演唱/走路×4/被举起） | ✅ 多状态动画 |
| 自动走动 | ✅ 定时走动、边缘转身、悬停暂停 | ✅ 随机行为链 |
| 尺寸可调 | ✅ 滚轮无级 + 预设 + 自定义像素 | ✅ 多档 |
| 待机动画 | ✅ 呼吸 / 漂浮 / 摇摆 / 静止 | ✅ 多状态 + 待机变体轮换 |
| 戳一戳 / 长按摸头 / 双击 | ✅ | ✅ |
| 台词气泡 | ✅ 手写体气泡 + 35 条离线台词 | ✅ 预合成语音 + 气泡 |
| 语音（TTS） | ❌ 未做 | ✅ edge-tts 预合成 49 条人声 |
| 任务状态联动 | ❌ 不适用 | ✅ 联动 DSH 的 AI 任务进度 |
| AI 对话 | ❌ 不适用 | ⚠️ 部分版本支持 |

台词全部离线硬编码：日常互动要零延迟零成本，接大模型反而会让「戳一下」等上两秒。

---

## 技术要点

- **PyQt6 + PyInstaller onefile**；`FramelessWindowHint | WindowStaysOnTopHint | Tool`
  + `WA_TranslucentBackground` 实现透明置顶，且不占任务栏。
- 气泡是**独立窗口**而非控件内绘制 —— 桌宠窗口按图片尺寸自适应，气泡超界会被裁掉。
  绘制区要给测量宽度留几像素余量，否则取整会让最后一行溢出、被裁掉半行。
- **姿态切换走 130ms 交叉淡化**：旧帧保持不透明、新帧按 smoothstep 渐入。
  硬切会「闪一下」；而时间拉长到 200ms 以上，两张全身像会叠出明显重影，反而更怪。
- **气泡字体是霞鹜文楷的子集**（53KB，仅含台词用到的 223 个字符），随 exe 分发。
  OFL 的保留字体名（RFN）要求修改版改名，所以子集已重命名为 `PetBubble Sans` ——
  不要用原字体名再分发，也不要把完整字体塞进仓库。
- 气泡出现/消失都有约 120~160ms 的淡入淡出，避免突然弹出来扎眼。
- 交互判定靠**位移阈值**：按下到松开位移 > 4px 视为拖拽，否则才判点击；
  拖拽中取消长按计时，避免「拖远了停住」被误判成摸头。
- 滚轮连滚时按 400ms 防抖写盘，避免每一格都触发一次 JSON 落盘。
- 打包脚本会把配置里的 `frames/xxx.png` 改写成扁平文件名（资源被复制到成品根目录），
  这个改写**必须写回成品目录**：只写回构建目录的话，成品启动时找不到图片会直接退出。
