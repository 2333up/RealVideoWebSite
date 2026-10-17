# video-mind

把本地长视频变成**可导航的知识地图**：自动语音转写 → 智能分章节 → 生成思维导图，
点击导图的任意节点或章节卡片，播放器立刻跳到对应时间点。

## 它解决什么问题

看一个两小时的讲座录像，最痛苦的不是「看」，而是**回看**——
想找某段内容时只能凭记忆拖进度条。video-mind 把视频内容结构化成一张带时间戳的
思维导图，让「找内容」变成「点一下」。

## 核心交互：三向联动

```
   思维导图节点  ──┐
   章节卡片      ──┼──►  播放器跳转到对应时间戳并自动播放
   逐字稿任意行  ──┘
```

反过来，播放器播放时也会高亮当前所处的章节与导图节点。

## 快速开始

video-mind 的前端已合并进仓库根目录的统一前端工程（`frontend/`），
后端由主应用挂载在 `/videomind` 子路径下。**全仓只有一个前端服务（5173）
和一个后端服务（8000）**，从仓库根目录启动：

```bash
# 后端（8000，内含挂载的 video-mind 子应用）
cd backend && pip install -r requirements.txt
python -m uvicorn main:app --port 8000

# 前端（5173，/videomind/* 路由即 video-mind）
cd frontend && npm install && npm run dev
```

浏览器打开：

- 灵搜 LingoSeek：http://127.0.0.1:5173/
- video-mind：http://127.0.0.1:5173/videomind/

两个入口在同一页面内互相跳转，不需要再记第二个地址。
Windows 用户可用仓库根目录的 `start.bat` 一键启动（本机脚本，未入库）。

> 单独的 `video-mind/frontend` 工程已不存在；其源码位于
> `frontend/src/videomind/`， API 基地址为 `/videomind/api`。

### 配置大模型

复制 `backend/.env.example` 为 `backend/.env`，填入 Key（推荐 DeepSeek，
1 小时视频的分析成本约几分钱）。也可以在应用的「设置」页面里填。

前提：系统 PATH 中需要有 `ffmpeg` 与 `ffprobe`。

## 使用流程

1. **导入视频**：左侧点「选择视频文件导入」或「选择文件夹批量导入」，
   会弹出操作系统原生的选择窗口（可多选）。浏览器拿不到文件的绝对路径，
   所以这一步由后端进程代劳。若本机弹不出窗口（精简版 Python 等），
   侧栏会自动退回「粘贴完整路径」的手工方式（Shift + 右键 →「复制文件地址」）。
   只登记路径、不复制文件，不额外占用磁盘空间。
2. **分类**：侧栏中部「＋ 新建」可建分类文件夹；把视频拖上去即归组，
   也可在选中视频后用「移动到」下拉。文件夹批量导入会按目录名自动建同名分类。
   删除分类只会把视频退回「未分类」，不会删视频和分析结果。
3. **开始分析**：点击「开始分析」，后台依次执行抽音频 → 转写 → 分章节 → 生成导图。
4. **导航**：在右侧思维导图上点击节点，或在中间点击章节卡片，播放器立即跳转。

## 架构

```
video-mind/
└── backend/                    FastAPI + SQLite（由主后端挂载到 /videomind）
    ├── core/                   配置、数据模型、数据库
    ├── providers/
    │   ├── asr/                ASR 双通道：本地 faster-whisper / 云端
    │   └── llm/                大模型：DeepSeek / 通义 / 豆包 / OpenAI / 自定义
    ├── pipeline/
    │   ├── media.py            ffmpeg：探测、抽音频、截关键帧
    │   ├── chapter.py          分章节（含防幻觉三道防线）
    │   ├── mindmap.py          生成思维导图
    │   └── runner.py           流水线编排与进度回写
    └── routers/                videos / jobs / settings

前端源码在仓库根目录的 frontend/src/videomind/（已与灵搜合并为单一工程）：
├── VideoMindApp.tsx           应用根组件（路由 /videomind/*）
├── api.ts                     API 客户端（基地址 /videomind/api）
├── components/                VideoPlayer / MindMap / ChapterList / Transcript …
└── lib/                       mindmapLayout（自建布局算法）/ seekRequest
```

### 处理流水线

```
本地视频
  │ ffmpeg 抽 16kHz 单声道 MP3
  ▼
ASR 转写（带时间戳的片段）
  │ 渲染成 [mm:ss] 文本喂给 LLM
  ▼
LLM 分章节（长视频走 Map-Reduce）
  │ 时间戳吸附 + 结构修复
  ▼
LLM 生成思维导图（从章节而非原始转写，省 token 且继承已校验的时间戳）
  │
  ▼
前端渲染 + 三向联动
```

## 几个关键设计

### 时间戳防幻觉

「点导图跳播放器」的体验完全建立在时间戳准确之上，而 LLM 会编造转写里不存在的
时间点。这里设了三道防线：

1. **提示词约束**：要求 start / end 必须取自转写文本中真实出现的时间戳
2. **吸附校正**：`snap_timestamp()` 把任何输出值吸附到最近的真实语音起点
3. **结构修复**：单调性、覆盖性、最小时长校验，不满足就修，修不好就报错

### 云端 ASR 的诚实取舍

多数云端 ASR（含硅基流动 SenseVoice）只返回纯文本、不带时间戳。
本项目**拒绝用估算值填充**——没有精确时间戳，跳转就会变成随机跳转，比没有更糟。
拿不到 segments 时直接报错并引导改用本地 Whisper。

### 视频流必须支持 Range

`GET /api/videos/{id}/stream` 实现了 HTTP 206 Partial Content。
没有它，浏览器原生播放器无法拖动进度条。

### 跳转请求带唯一 ID

如果跳转只传「秒数」，连续点击同一个章节两次时 React 会因值未变而不触发副作用，
表现为「点了没反应」。因此每次跳转都生成带唯一 `requestId` 的请求对象。

## AI 用的是谁的 Key？多少钱？

**用你自己的。** 项目不内置任何密钥，也不代跑任何中转服务——
你的机器直接调用你配置的那家模型供应商，中间没有第三方。

| 环节 | 是否付费 | 说明 |
|---|---|---|
| 语音转写（本地 faster-whisper） | **免费** | 全在本机 GPU 上跑，音频不出电脑 |
| 分章节 + 生成思维导图 | 付费 | 需要你的 API Key |
| 云端 ASR（可选） | 付费 | 默认关闭；开启后音频会上传到供应商 |

### 成本估算

以 DeepSeek `deepseek-v4-flash` 现价估算（1 元/百万输入 token，2 元/百万输出 token）：

| 视频时长 | 转写字数 | 大致成本 |
|---|---|---|
| 10 分钟 | ~2 千字 | **不到 1 分钱** |
| 1 小时 | ~1.2 万字 | **约 3 分钱** |
| 3 小时 | ~3.6 万字 | 约 1 毛钱 |

> 价格会变动，且 DeepSeek 已公告将实施峰谷定价（高峰时段可能翻倍）。
> 具体以 [官方定价页](https://api-docs.deepseek.com/quick_start/pricing/) 为准。

### 密钥怎么保管

- 写在 `backend/.env`（已被 `.gitignore` 排除，不会进版本库），
  或在应用「设置」页填写——两者等价，设置页写入的也是同一个 `.env`。
- 密钥只存在于服务端进程内存里，**不写进数据库、不下发到前端**。
  设置页回显时一律遮掩成 `sk-xxx...wxyz`。

### 换供应商

设置页可一键切换 DeepSeek / 通义千问 / 豆包 / OpenAI / 自定义 OpenAI 兼容端点，
每家都提供了候选模型下拉（也允许手填）。切换只影响后续任务，已有结果不会丢。

> ⚠️ `deepseek-chat` / `deepseek-reasoner` 这两个模型名已于 **2026-07-24 弃用**，
> 现役为 `deepseek-v4-flash` 与 `deepseek-v4-pro`。本项目默认值已同步更新。

## 模型下载

本地 Whisper 首次运行需要模型文件（`large-v3` 约 3 GB）。HuggingFace 官方客户端
在弱网/镜像环境下容易把 `model.bin` 下成一截断的文件，而 CTranslate2 加载时只会
报一句含糊的「model.bin is incomplete」，很难排查。

因此项目自带一个更稳的下载器，**默认走魔搭 ModelScope**（国内实测单连接 5.8 MB/s，
比 HuggingFace 系列镜像常见的 190 KB/s 快一个数量级，且支持 Range 并行）：

```bash
cd backend
python scripts/fetch_model.py large-v3              # 默认魔搭，约 8 分钟
python scripts/fetch_model.py large-v3 --parts 24   # 加大并发
python scripts/fetch_model.py base --source hf      # 改用 HuggingFace
```

下载后的模型落在 `data/models/faster-whisper/<模型名>/`，程序会**优先从这里加载**，
命中后完全不走网络。

> 魔搭目前只登记了 `large-v3` 的仓库映射。其他模型请用 `--source hf`
> 或 `--repo <魔搭仓库名>` 手动指定。

## 已知限制

- **模型下载依赖网络可达 HuggingFace**：若所在网络屏蔽了 HF，
  需要自行把模型文件放到 `data/models/faster-whisper/<模型名>/` 下
  （需包含 `model.bin` / `config.json` / `tokenizer.json` / `vocabulary.txt`）。
- **同一时刻只处理一个任务**：GPU 显存与 CPU 都撑不住并行转写。
- **视频只登记路径不复制**：原文件被移动或删除后需要重新导入。
- **长视频处理较慢**：1 小时视频在 GPU 上转写约需 5-15 分钟，分析另需 1-2 分钟。
- **云端 ASR 需服务端返回时间戳**：只有支持 `verbose_json` 的端点可用，
  否则会报错而非估算（见上文设计说明）。

## 未验证项

以下部分在当前环境中**未能实测**，需要联网或密钥后才能确认：

| 项目 | 状态 | 验证条件 |
|---|---|---|
| 真实 Whisper 转写 | 未跑通 | 需下载模型文件（当前网络屏蔽 HF） |
| LLM 分章节 / 生成导图 | 未跑通 | 需配置 API Key；已用假 LLM 验证编排逻辑 |
| 浏览器内「点导图跳播放器」 | 未实测 | 需有真实章节数据后人工点击验证 |

管线各阶段的能力已通过如下方式验证：
ffmpeg 探测 / 抽音频 / 截关键帧 —— 实跑通过；
HTTP Range 视频流 —— 206 状态码与逐字节比对通过；
防幻觉与结构修复逻辑 —— 33 个单元与集成测试通过。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | FastAPI + SQLAlchemy 2.0 + SQLite |
| 转写 | faster-whisper (CTranslate2 / CUDA) |
| 大模型 | OpenAI 兼容协议（DeepSeek 默认，可切换） |
| 前端 | React 18 + TypeScript + Vite 5 + Tailwind 3 |
| 思维导图 | ReactFlow (@xyflow/react) + 自建树布局 |
