# RealVideoWebSite — Agent 协作约定

> 本文件是本仓库的**最高行动准则**。任何 Agent（含子 Agent、后台 Agent）在开始任何
> 代码工作之前，必须先读完本文件并严格遵守。有冲突时以本文件为准。
>
> 本仓库**有多个使用者**都会通过 WorkBuddy 开发和维护它。因此下面所有权限规则
> 都是**按「角色」划分，而不是按「人」划分**——换谁坐在键盘前，规则都一样。

---

## 0. 仓库与权限（红线）

| 项 | 值 |
|---|---|
| 仓库 | `git@github.com:2333up/RealVideoWebSite.git` |
| 账号 | `2333up` |
| 主干分支 | `master` |
| 默认远端 | `origin` |

### 角色定义

| 角色 | 是谁 | 推送权限 |
|---|---|---|
| **主 Agent** | 任一会话中负责任务编排、直接与使用者对话的那个 WorkBuddy 主智能体。**它是一个角色，不是某个固定的人**——任何使用者启动的会话里，那个主智能体就是主 Agent | ✅ 唯一可以 push `master` |
| **其他 Agent** | 主 Agent 派生出的子 Agent、并行 Agent、后台 Agent，以及任何非编排角色的智能体 | ❌ 禁止 push `master`，只能推分支 |

### 推送权限（不可协商的红线）

- **只有主 Agent 可以 push 到主干 `master`**（不论这次会话的使用者是谁）。
- **其他任何 Agent 一律禁止 push `master`**，也不得对 `master` 做 force push、
  rebase 后强推、删除远端分支等操作。
- 其他 Agent 只能：`git checkout -b feature/<简述>` → 提交 → `git push -u origin <分支名>`
  → **创建 PR**，由主 Agent review 后合并进 `master`。

### 多使用者带来的额外要求

正因为不止一个人在用，下面这几条比单人项目更要紧：

- **push 前先同步**：`git fetch origin && git pull --rebase origin master`，
  避免各自本地历史分叉后互相覆盖。
- **推送后立刻核对**：`git log --oneline -1` 与 `git ls-remote --heads origin` 比对，
  确认远端 HEAD 与本地一致。
- **先沟通再动主干**：若发现远端已有别人（或别的会话）新推的提交而自己本地落后，
  先对齐，不要抢推。
- **不得提交密钥**：`.env`、`.secret_key`、`*.db`、模型文件等一律不得入库（见第 5 节）。
- 涉及删除用户文件、发邮件、公开发布等**外部动作，必须先征求使用者同意**。

### 其它共同约束

- **禁止 `--force` / `--no-verify`**：不做强制推送，不跳过钩子。
- **禁止改写已推送的历史**（rebase/reset --hard 后强推）。

---

## 1. 技术栈与架构

本仓库含**两个互相独立的产品**，共享一个仓库，但目录、依赖、端口完全隔离：

```
RealVideoWebSite/
├── backend/                灵搜 LingoSeek · FastAPI 后端（端口 8000）
│   ├── app/platforms/      平台适配器：bilibili / douyin / xiaohongshu
│   ├── app/routers/        embed（服务端代理嵌入）· download
│   └── app/services/       account_service（Cookie 加密存储）
├── frontend/               灵搜 · React + Vite（端口 5173）
└── video-mind/             另一个独立产品：本地视频 → 章节 → 时间戳思维导图
    ├── backend/            FastAPI + SQLAlchemy + SQLite（端口 8600）
    │   ├── core/           config / models / database / files_dialog / compat
    │   ├── providers/      asr（faster-whisper / 云端）· llm（DeepSeek 等）
    │   ├── pipeline/       media / chapter / mindmap / runner
    │   └── routers/        videos / folders / files / jobs / settings / usage
    └── frontend/           React 18 + TS + Vite + Tailwind + ReactFlow（端口 5273）
```

**端口分配（绝不能共用，踩过事故）：**

| 产品 | 后端 | 前端 |
|---|---|---|
| 灵搜 LingoSeek | 8000 | 5173 |
| video-mind | 8600 | 5273 |

前端一律配 `strictPort: true` + `host: 127.0.0.1`，端口被占要**直接报错**，不允许静默漂移。
启动服务前先 `netstat -ano | grep :端口` 确认没有残留进程。

---

## 2. Agent 分工

| Agent | 负责 | 禁止触碰 |
|---|---|---|
| 主 Agent（当前会话的编排者） | 全仓；**唯一可 push `master` 的角色**（不论使用者是谁）；负责 PR review 与合并 | — |
| 子 Agent · 后端 | `backend/`、`video-mind/backend/` | `frontend/`、`video-mind/frontend/` |
| 子 Agent · 前端 | `frontend/`、`video-mind/frontend/src/` | `backend/`、`video-mind/backend/` |
| 子 Agent · 调研/文档 | 只读探索、README、调研报告 | 不得直接改业务代码 |

跨边界的改动（例如同时改后端接口和前端调用）**必须拆成多次提交**，并在 PR 描述里说明依赖关系。

---

## 3. 工作流

1. 开工前 `git pull` 拉取最新 `master`，再开分支。
2. 分支命名：`feature/<简述>`、`fix/<简述>`、`docs/<简述>`（简述用小写英文或拼音，不用中文）。
3. 提交遵循 **Conventional Commits**：`feat(scope): ...` / `fix(scope): ...` /
   `docs(...)` / `refactor(...)` / `test(...)` / `chore(...)`。
   scope 建议用 `lingoseek` 或 `video-mind`，便于区分两个产品。
4. 完成后 push 分支 → 创建 PR → 等主 Agent review 合并。
5. 合并后删除已合并的分支。

---

## 4. 提交规范

- **小步提交，一个 commit 只做一件事**；禁止一次 push 大量混杂改动。
- 提交信息正文写清「**为什么**」，不写「改了什么」（diff 里已经有了）。
- 提交前必须跑通自检清单（第 6 节）；跑不通就不许提交。
- 不要把调试产物、截图、临时 HTML、日志塞进提交。

---

## 5. 绝不能入库的文件

已由 `.gitignore` 覆盖，任何 Agent **不得**用 `git add -f` 强行加入：

| 文件/目录 | 原因 |
|---|---|
| `backend/data/.secret_key` | Fernet 密钥，泄露可解密已保存的平台账号 Cookie |
| `backend/data/*.db` | 内含加密后的平台凭据 |
| `video-mind/backend/.env` | API Key |
| `video-mind/data/` | SQLite 库 + 约 3GB 的 Whisper 模型 |
| `.venv/`、`node_modules/`、`dist/` | 依赖与构建产物 |
| `start.bat` | 含本机绝对路径，仅本机可用 |
| `.workbuddy/` | AI 助手工作记忆，非项目代码 |

提交前自检：

```bash
git diff --cached --name-only | grep -Ei "(\.env$|\.env\.|secret|key|\.db$|data/models|node_modules|dist/|\.venv|\.png$)"
# 有输出就要逐个确认；grep 密钥：(sk-xxx | API_KEY="..." | Bearer xxx)
```

---

## 6. 提交前自检清单

**video-mind：**

```bash
cd video-mind/backend && ./.venv/Scripts/python.exe -m pytest tests -q   # 全绿
cd video-mind/frontend && npx tsc --noEmit && npm run build               # 无报错
```

**灵搜 LingoSeek：** 改到哪个平台就实跑一次对应搜索/详情接口，确认没被风控误判为「功能坏了」。

任何 Agent 若发现测试挂了，**先修再提交**，不许用「跳过测试」的方式绕过。

---

## 7. 各产品的设计红线（改动前必须知道）

**video-mind：**

- 时间戳必须**精确**。ASR 若只返回纯文本不带时间戳 → **直接报错**，绝不用估算值填充。
- 视频**只登记路径、不复制文件**；删除分类文件夹只把视频退回「未分类」，**绝不删视频和分析结果**。
- `GET /api/videos/{id}/stream` **必须支持 HTTP Range（206）**，否则播放器拖不动进度条。
- ReactFlow 自定义节点**必须渲染 `<Handle />`**，否则边被静默丢弃且不报错。
- 同一时刻只跑一个处理任务（GPU 显存与 CPU 撑不住并行转写）。

**灵搜 LingoSeek：**

- 新增平台 = 实现适配器 + 注册一行，其余层零改动。
- 平台失败原因必须**透传到用户**（带具体错误），不能只报「未返回结果」。
- **绝不用「删除」实现多样性**（作者配额曾让结果从 60 条暴跌到 19 条）；过滤必须保序。
- 诚实披露能力边界，不用假数据糊弄（抖音搜索列表无播放量就显示 0，不伪造）。

---

## 8. 环境踩坑速查（改环境前先读）

- **端口**：两个产品前端端口冲突时，Vite 会静默漂到 IPv6 `[::1]`，表现为「页面不对劲」
  却查不出原因 → 必须 `strictPort` + `netstat` 核对。
- **PyAV ≥19 移除 `metadata_errors`**，而 faster-whisper 仍传它 → `core/compat.py` 运行时兼容层。
- **`cublas64_12.dll` 找不到**发生在开始推理时（模型加载正常）→ `scripts/fetch_cublas.py`
  按需抽取；`cublas64_12.dll` 还静态依赖 `cublasLt64_12.dll`，两个都要。
- **PowerShell 脚本必须 UTF-8 with BOM**：Windows PowerShell 5.1 默认按 ANSI 解码，
  没 BOM 时中文踩成乱码，报错还会指错方向。
- 排查工具：`python scripts/verify_integrity.py`（一键自检 DB/音频/视频/模型）、
  `python scripts/fetch_cublas.py --check`。
