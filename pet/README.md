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
| **拖到屏幕任一边缘** | **吸附并只露头**（双手扒着边缘探头），点击即钻回页面内 |
| 拖拽 | 移动位置，**拖拽时呈「被举起」姿态**（手臂上举、双腿悬空），松手记忆位置 |
| 单击 | 戳一戳：**切到演唱姿势** + 弹跳 + 随机台词气泡 |
| 按住 0.7 秒 | 摸头：演唱姿势 + 连续小跳 + 害羞台词 |
| 双击 | **转身**（切到背面姿势）+ 撒娇台词 |
| **滚轮** | **无级缩放（20%~200%，约 6% 一档），停顿 0.4 秒自动保存** |
| 右键 → 尺寸 | 小 140px / 中 200px / 大 280px / 超大 380px / 自定义像素 |
| 右键 → 其它 | 更换形象 / 说句话 / 待机动画 / 开机自启 / 隐藏到托盘 / 退出 |
| 托盘图标 | 点击恢复显示 |

动作结束后自动回到正面待机姿势。首次启动有 1~3 秒延迟，是 onefile 解压，属正常。

### 贴边露头（四边任意位置）

把她拖到**屏幕左 / 右 / 上 / 下任意一条边**松手，会自动吸附成「只露头」的形态：
半个身子留在屏幕外，扒着边缘看着你。点一下（或按住直接拖）就会钻回页面里。

- **同一条边上可以停在任意位置**：竖边记住纵向落点，横边记住横向落点，
  所以能贴在她旁边的窗口高度上，而不只是屏幕最下方。
- **取最近的一条边**：贴着上边但稍微偏左，也会判成上边吸附 ——
  按「先判左右再判上下」的顺序会贴错边，落点跟预期对不上。
- 判定容差 28px：松手时窗口离某条边 28px 以内就算贴上。
- 贴边期间**不自动走动** —— 从屏幕边缘自己滑走会很怪。
- 上下两条边各用一张素材（扒住上边框垂下来 / 从下边框探上来）；
  左右共用「侧边探头」，右侧靠**水平镜像**复用，不会出现两个朝向的图。
- 贴边位置**不写进配置**：下次启动她会回到你上次放她的地方，而不是一直挂在边上。

素材处理见 `build-tools/make_peek.py`：生成图里带了一条「墙的边缘」竖线，
贴到屏幕边缘会露出来，脚本会按「亮度高 + 红绿接近 + 蓝不高于红太多」的判据
抹掉它（避开皮肤与深色发丝），再从人物的裁切边裁紧 —— 那条边正好被屏幕边缘吃掉。

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
│   ├── gen/                      AI 补生成的素材：走路精灵图 / 被举起 / 探头×3
│   ├── preview.png               四姿态深底预览
│   └── fonts/
│       ├── pet-bubble.ttf        气泡用手写体（53KB 子集）
│       └── OFL.txt               字体授权（SIL Open Font License 1.1）
├── build-tools/
│   ├── pet_app.py                桌宠主程序模板（多姿态/走动/互动/尺寸）
│   ├── make_poses.py             三视图 → 多姿态帧（抠底/对齐/统一画布）+ 配置与图标
│   ├── add_frames.py             追加走路帧与「被举起」帧，并同步配置
│   ├── make_peek.py              处理「贴边露头」素材（抹掉图的墙边线 + 抠底）│   ├── make_bubble_font.py       按台词表裁剪字体子集（改台词后需重跑）
│   ├── make_cutout.py            单张白底图抠图（换单张形象时用）
│   ├── check_geometry.py         几何探针：打印窗口/绘制尺寸，排查显示异常
│   └── build_exe.py              PyInstaller 打包 + 成品组装 + 启动自检
└── build/Jingxi/                 构建工作区（不入库）
    ├── frames/f000..f008.png     正 / 侧 / 背 / 演唱 / 走路×4 / 被举起
    ├── peek.png                  贴边露头素材（左 / 右共用，右侧镜像）
    ├── peek-top.png               贴边露头素材（扒住上边框）
    ├── peek-bottom.png            贴边露头素材（从下边框探上来）
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
"poses": { "idle": 0, "drag": 8, "double": 2, "poke": 3, "pat": 3 }
```

贴边素材同样在配置里声明，四边各一项（缺哪张也不会崩，会退回 `side`）：

```json
"peek": { "side": "peek.png", "top": "peek-top.png", "bottom": "peek-bottom.png" }
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

# 2.5 贴边露头素材：左/右、上、下各处理一次（AI 生成图自带「墙边线」，脚本会抹掉）
$PET_PY build-tools/make_peek.py --src assets/gen/peek-source.png --edge left \
  --png build/Jingxi/peek.png --webp ../frontend/src/assets/pet/peek.webp --fade-bottom 0.18
$PET_PY build-tools/make_peek.py --src assets/gen/peek-source-top.png --edge top \
  --png build/Jingxi/peek-top.png --webp ../frontend/src/assets/pet/peek-top.webp
$PET_PY build-tools/make_peek.py --src assets/gen/peek-source-bottom.png --edge bottom \
  --png build/Jingxi/peek-bottom.png --webp ../frontend/src/assets/pet/peek-bottom.webp

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

## 网页版（嵌入前端网站）

同一个形象也以**网页形式**嵌在前端里：任意页面右下角悬浮一只，走动、戳一戳、
长按摸头、双击转身、气泡台词、拖拽换位都与桌面版一致。

**它与 exe 是两套实现，共用素材与台词**：浏览器里做不到「透明置顶盖住其他软件」，
但页面内的悬浮与互动可以完整复刻。

| 差异点 | 桌面版 exe | 网页版 |
|---|---|---|
| 透明置顶盖住其他程序 | ✅ | ❌ 浏览器限制 |
| 走动 / 戳 / 长按 / 双击 / 气泡 | ✅ | ✅ |
| 拖拽换位置 | ✅ | ✅（同时支持触摸） |
| 贴边露头 | ✅ 屏幕四边任意位置 | ✅ 视口四边任意位置，点击钻回 |
| 缩放 | 滚轮无级 | 按屏幕宽度自适应固定档，不支持滚轮（会抢页面滚动） |
| 台词 / 姿态 / 走动参数 | 读 `pet_config.json` | 读导出的 `manifest.json`（同源） |

- 代码：`frontend/src/components/webPet/WebPet.tsx`，挂在 `App.tsx` 路由之外，
  切换页面不重新挂载；`z-40` 低于各种弹窗（`z-50`），不会挡住登录/详情/设置。
- 尺寸：≥1280px 屏 200px 高，≥900 是 170，≥640 是 140，更小的屏直接不显示。
- 位置记在 `localStorage` 的 `lingoseek.pet.pos`。
- 遵循 `prefers-reduced-motion`：系统开启「减少动态效果」时不自动走动。

**素材导出**（改了桌宠素材或台词后必须重跑）：

```bash
$PET_PY build-tools/export_web_frames.py --build build/Jingxi --fe ../frontend
```

会把 `frames/*.png` 按 480px 高导成 WebP（**5.0MB → 376KB**）写进
`frontend/src/assets/pet/`，同时生成 `frontend/src/components/webPet/manifest.json`
（帧列表 / 姿态映射 / 走动参数 / 台词 / 气泡锚点）。

> 为什么必须导出而不是直接引用 PNG：9 帧原始 PNG 合计 5MB，而整个前端 JS 包才 500KB。
> 网页实际只显示 200px 高，按 2x 导 WebP 就够。

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
- **换姿势走 90ms 交叉淡化，走路逐帧动画则硬切**。这两件事必须分开：
  走路的换帧间隔只有 1/fps≈133ms，如果也做淡化，上一帧还没淡完下一帧就来了，
  全程半透明叠加就会看起来「一直有重影」；sprite 动画本来也是硬切的。
  换姿势（站立 ↔ 举手 / 被举起）才需要过渡，否则硬切会闪一下。
- **气泡字体是霞鹜文楷的子集**（53KB，仅含台词用到的 223 个字符），随 exe 分发。
  OFL 的保留字体名（RFN）要求修改版改名，所以子集已重命名为 `PetBubble Sans` ——
  不要用原字体名再分发，也不要把完整字体塞进仓库。
- 气泡出现/消失都有约 120~160ms 的淡入淡出，避免突然弹出来扎眼。
- 交互判定靠**位移阈值**：按下到松开位移 > 4px 视为拖拽，否则才判点击；
  拖拽中取消长按计时，避免「拖远了停住」被误判成摸头。
- **贴边那一维不要走「夹回可用区」**：`QRect::right()` 返回的是**最后一个像素**
  的坐标（`left + width - 1`），所以「紧贴右边缘」的 x 是 `right() - w + 1`，
  比 `right() - w` 多 1。若再用 `right() - w` 去夹，这 1px 会被减掉，
  边缘就露出一条缝，探头图的切口正好看得见 —— 只有沿边滑动的那一维才需要夹取。
- 滚轮连滚时按 400ms 防抖写盘，避免每一格都触发一次 JSON 落盘。
- 打包脚本会把配置里的 `frames/xxx.png` 改写成扁平文件名（资源被复制到成品根目录），
  这个改写**必须写回成品目录**：只写回构建目录的话，成品启动时找不到图片会直接退出。
