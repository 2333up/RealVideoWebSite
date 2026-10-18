# 灵搜 LingoSeek

**主动推荐式视频/图文搜索引擎** —— 输入关键词，引擎替你把不值得看的内容筛掉。

当前已接入 **哔哩哔哩、抖音、小红书、YouTube** 四个平台。四者能力差别很大，
下表如实列出（**勿夸大**，各平台的限制与坑点见后文对应小节）：

| 平台 | 内容形态 | 检索方式 | 登录 | 评论 | 互动量门槛 | 下载 |
|---|---|---|---|---|---|---|
| 哔哩哔哩 | 视频 + 图文 | HTTP（WBI 签名） | 扫码登录（可选） | ✅ | ✅ | ✅ 最高 1080P |
| 抖音 | 仅视频 | Playwright 浏览器自动化 | 手动注入 Cookie（搜索必需） | ❌ | ❌ | ❌ |
| 小红书 | 视频 + 图文 | Playwright 浏览器自动化 | 手动注入 Cookie（必需） | ❌ | ❌ | ❌ |
| YouTube | 仅视频 | HTTP（SSR 直出，无需签名） | 无需登录 | ❌ | ❌ | ✅ yt-dlp |

> 「无评论 / 无门槛过滤」不是没做完，而是平台侧拿不到对应数据：
> 适配器未实现 `fetch_comments` 时前端自动隐藏评论区，`supports_thresholds=False`
> 时前端不渲染那两个下拉框 —— 而不是发出注定返回空列表的请求。

---

## 它和普通搜索有什么不同？

| 普通平台搜索 | 灵搜 |
|---|---|
| 视频与图文分属不同入口 | 一次搜索同时召回视频与专栏图文，按 3:1 交错呈现 |
| 单页卡在 20 条 | 自动分批翻页，每批给足 60 条，可持续「加载更多」 |
| 只包含一个平台 | 多平台适配器架构，横向扩展只需新增一个文件 |
| 重复搬运号刷屏 | 精确去重 + 标题去重 + 作者配额三级过滤 |
| 每条难辨优劣 | 紧凑列表排版，一屏容纳显著更多结果 |

> 关于排序：**沿用平台的原生排序**，服务端一律不重排，与平台网页端观感一致。
> 内部仍保留五维打分器，通过 `recommend(rerank=True)` 开启；前端不展示分数。

### 排序跑题是怎么解决的：语义指纹保序过滤

平台在「最多播放 / 最新发布」下**不再考虑相关性**，只把蹭到关键词子串的高播放内容顶上来：

```
搜索《美国老爹》→ 吹牛老爹案终于开庭！(257万)   ← 艺人 Diddy 的社会新闻
                  FBI突袭！吹牛老爹被捕！(230万)  ← 同上，与动画无关
```

解决办法（`backend/app/recommend/relevance.py`）：平台的「综合相关度」排序本身是对相关性
的权威判断，先用它抓 1 页种子，提炼该关键词的**内容指纹** —— 创作者集合 + 高频标签
（《美国老爹》对应 Stan / AmericanDad / 搞笑美漫）。

三条判据任一命中即保留，**只剔除、不重排**，因此顺序严格保持平台原生：

1. 作者曾在相关种子中出现
2. 标题 / 简介 / 标签包含完整关键词
3. 携带至少一个种子高频标签

仅在 `order != relevance` 时启用。实测 hot 排序下输出 24 条全为《美国老爹》剧集，噪声清零。

> 另有一条设计红线：**不要用「删除」来实现多样性**。作者配额曾让「仅视频+不限时长」
> 从 60 条暴跌到 19 条 —— 番剧场景下一个 UP 主承包整季，而那正是用户想看的。
> 现在配额放宽到 50，仅作「单一 UP 主刷屏」的极端兜底。

### 实测容量：平台返回的不止 40 条

平台限制的是**每页 20 条**，而非总量。实测「美国老爹」一路可翻到 50 页以上且几乎无重复：

```
page=1~6 连续抓取 → 每页均 20 条，累计 140 条，全局去重后仍为 140 条（零重复）
```

因此本项目的取数策略是**分批翻页**而非一次性拉完：

| 环节 | 参数 | 位置 |
|---|---|---|
| 每批抓取页数 | `PAGE_BATCH = 4`（前后端一致） | `App.tsx` / `SearchRequest.pages` |
| 每批结果条数 | 60 | `App.tsx RESULT_BATCH_SIZE` |
| 单批次 rocks Victoria 上限 | 100 | `service.MAX_OUTPUT_SIZE` |
| 单次最多页数 | 30 | `adapter.MAX_FETCH_PAGES` |

实测「美国老爹」连续加载 5 批（page 1/5/9/13/17）累计 **275 条**不重复结果，单批约 2.8~3.4 秒。

> **踩过的坑：并发翻页会静默丢页。**
> 一次性 `gather` 全部页码时，B 站会对高频并发限流，把某些页直接返回**空 result**（且不报错）。
> 实测串行慢速 6 页零失败，而整批并发时第 4 页返回 0 条。
> 现策略：批大小上限 3（`PAGING_CONCURRENCY`）、批间留 0.45s、检测到空/异常页串行补抓一次。

### UI 排版刻意对齐平台网页端

结果条目采用紧凑横向布局：左侧 185×104 缩略图 + 右侧标题/UP主/播放/弹幕/时间，
单条高度约 110px（旧版四列大卡片约 320px），同等屏幕高度下可见结果数提升约 3 倍。

---

## 快速开始

### 方式一：一键脚本（Windows）

双击项目根目录的 `start.bat`，脚本会自行检测依赖、拉起前后端并打开浏览器。

### 方式二：手动启动

**后端（FastAPI · :8000）**

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate    # Windows
pip install -r requirements.txt
playwright install chromium                       # 抖音 / 小红书检索依赖（只搜 B 站可跳过）
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

> **哪些依赖是「按需」的？** 只想搜 B 站的话，装完 `requirements.txt` 就能跑；
> 下表说明其余依赖各自影响什么、不装会怎样：
>
> | 依赖 | 影响 | 不装的后果 |
> |---|---|---|
> | `playwright` + chromium | 抖音、小红书检索 | 这两个平台会返回「需要浏览器」类的错误，B 站不受影响 |
> | `yt-dlp`（已在 requirements） | YouTube 取流与下载 | YouTube 搜索/详情正常，点下载才失败 |
> | `ffmpeg` | B 站 1080P 与 YouTube 音视频合并 | 高画质档位置灰，低画质直链照常 |
> | `YOUTUBE_PROXY`（`.env`） | YouTube 连通性 | 国内网络下 YouTube 一律超时 |

**前端（Vite · :5173）**

```bash
cd frontend
npm install
npm run dev
```

浏览器访问 <http://127.0.0.1:5173>

---

## 账号登录

右上角头像 → 选择「哔哩哔哩」→ **+ 添加** → 用 App 扫码即可。

- 二维码由后端本地渲染，不外发给任何第三方图床
- Cookie 经 Fernet 对称加密后存入 SQLite，密钥落在 `backend/data/.secret_key`
- 登录态过期时自动降级为游客检索，不会中断使用
- 可在账号面板随时体检、切换默认、删除

> 登录的价值：绕过游客风控、获得更完整的搜索配额与个性化结果。不登录也能正常使用。

> **只有哔哩哔哩支持扫码登录。** 抖音、小红书没有可用的扫码流程，只能手动粘贴
> 浏览器 Cookie（见后文各平台小节）；YouTube 无需登录。

---

## 项目结构

```
RealVideoWebSite/
├── backend/
│   ├── main.py                      # FastAPI 入口与生命周期
│   ├── app/
│   │   ├── core/                    # 配置 / 数据库 / 凭据加密 / ffmpeg 探测与合并
│   │   ├── models/account.py        # 平台账号 ORM（跨平台通用表）
│   │   ├── platforms/
│   │   │   ├── base.py              # ★ 平台抽象契约 ContentItem / PlatformAdapter
│   │   │   ├── bilibili/
│   │   │   │   ├── client.py        # HTTP 客户端 · Cookie · 指纹 · 重试
│   │   │   │   ├── wbi.py           # WBI 签名算法
│   │   │   │   ├── login.py         # 扫码登录全流程
│   │   │   │   └── adapter.py       # 视频/图文检索与结构归一化
│   │   │   ├── douyin/
│   │   │   │   ├── adapter.py       # 热榜 + 浏览器自动化搜索
│   │   │   │   └── browser_search.py  # Playwright 绕过 a_bogus
│   │   │   ├── xiaohongshu/
│   │   │   │   ├── adapter.py       # 笔记检索与结构归一化
│   │   │   │   └── browser_search.py  # Playwright 绕过 X-s/X-t
│   │   │   └── youtube/
│   │   │       └── adapter.py       # SSR 解析 + 游标翻页 + yt-dlp 取流（本仓最重的适配器）
│   │   ├── recommend/
│   │   │   ├── scorer.py            # 五维打分 + 质量体检
│   │   │   ├── dedup.py             # 精确/模糊/作者配额三级去重
│   │   │   ├── relevance.py         # 语义指纹（保序去噪）
│   │   │   └── service.py           # 推荐流水线编排
│   │   ├── routers/                 # search · account · hot · embed · download
│   │   ├── schemas/api.py           # API 契约
│   │   └── services/                # 账号增删改查与登录态体检
│   └── data/app.db                  # SQLite（首次运行自动生成）
├── frontend/                        # 统一前端（唯一的前端服务）
│   ├── src/
│   │   ├── App.tsx                  # 路由分发：/ → 灵搜，/videomind/* → video-mind
│   │   ├── LingoSeekApp.tsx         # 灵搜主界面
│   │   ├── api/client.ts            # 灵搜 API 客户端
│   │   ├── videomind/               # video-mind 全部源码（原独立工程）
│   │   │   ├── VideoMindApp.tsx     #   video-mind 应用根组件
│   │   │   ├── api.ts               #   API 客户端（基地址 /videomind/api）
│   │   │   ├── components/          #   VideoPlayer / MindMap / ChapterList …
│   │   │   └── lib/                 #   mindmapLayout / seekRequest
│   │   └── components/
│   │       ├── ResultCard.tsx       # 结果卡片 + 评分解释
│   │       ├── VideoDetailModal.tsx # 详情浮层：自绘详情 + 评论 + 播放器
│   │       ├── CommentSection.tsx   # 评论区（最热/最新、楼中楼、分页）
│   │       ├── LoginModal.tsx       # 扫码登录浮窗
│   │       └── AccountPanel.tsx     # 账号管理抽屉
│   ├── scripts/                     # 实跑验收脚本（无单测，靠它兜底）
│   │   ├── e2e-smoke.mjs            # 端到端冒烟：搜索/浮层/video-mind 分流
│   │   ├── check-layout.mjs         # 导图布局几何断言
│   │   └── probe-mindmap.mjs        # 导图交互探针
│   └── vite.config.ts               # /api 与 /videomind/* 反向代理到 :8000
├── video-mind/
│   └── backend/                     # video-mind 后端（由主后端挂载到 /videomind）
├── pet/                             # 鲸汐 · 桌面宠物（PyQt6 独立 exe，不参与 web 服务）
│   ├── assets/                      #   原图 / 抠好的透明 PNG / 效果预览
│   └── build-tools/                 #   桌宠程序模板 + 抠图 / 打包脚本
└── start.bat                        # 一键启动
```

> **服务拓扑**：全仓只有一个前端服务（:5173）和一个后端服务（:8000）。
> 浏览器访问 <http://127.0.0.1:5173> 是灵搜；
> <http://127.0.0.1:5173/videomind/> 是 video-mind（本地视频分章节 + 思维导图），
> 两者在同一页面内互相跳转。
>
> `pet/` 不在这两个服务里：它是独立的 Windows 桌面程序，打包成 exe 后与本仓库的
> web 服务完全解耦，源码只是放在同一个仓库里维护。

---

## 关键技术

**WBI 签名** —— B 站自 2023 年起对搜索类 API 启用 wbi 鉴权，缺失签名统一返回 `-352`。
本项目实现了完整的签名链路：从 `/x/web-interface/nav` 提取两张密码图文件名 → 拼成 64 位原始串 →
按 64 项乱序表重排取前 32 位作为 mixin_key → 参数加 `wts` 后按字典序编码 → MD5 得出 `w_rid`。
mixin_key 每 10 分钟刷新一次，且在网络返回 `-352/-403` 时自动失效重试。

**Credentials 回落** —— 每个接口都可独立指定是否携带登录 Cookie，
配合「指定账号 → 默认账号 → 游客」三级回落，让多账号共存与优雅降级同时成立。

---

## 接入新平台

三步，无需改动业务层：

1. 新建 `backend/app/platforms/<新平台>/adapter.py`，实现 `PlatformAdapter` 抽象类的五个方法
2. 在 `main.py` 的 `lifespan` 中 `registry.register(YourAdapter())`
3. 前端自动读取 `/api/platforms` 渲染出新的平台入口

推荐引擎、去重逻辑、路由层、前端界面均无需任何修改 —— 这是这套架构的核心承诺。

### 抖音平台的真实能力（重要，勿夸大）

抖音已按同样架构接入（`app/platforms/douyin/adapter.py`），但其 Web 端主力接口受
`a_bogus` 签名保护：JSVMP 虚拟机混淆 + WASM + msToken/ttwid 会话令牌 + TLS 指纹，
且数据中心 IP 被直接封禁（业内评级 4~5/5 难度）。本项目**不逆向签名算法**，
而是用 **Playwright 浏览器自动化**绕开它：

| 能力 | 状态 | 实现方式 |
|---|---|---|
| 热榜 `/aweme/v1/web/hot/search/list/` | ✅ 可用 | 无需签名，直接返回真实数据 |
| 关键词搜索 | ✅ 可用 | **浏览器自动化**：真实 Chromium 加载搜索页，页面 JS 自行生成 `a_bogus` |
| 账号登录 | ⚠️ 手动注入 | 无扫码流程，粘贴 Cookie 保留登录态 |

#### 抖音搜索：为什么必须走浏览器自动化（实测结论）

用**真实登录 Cookie** 逐项验证过纯 HTTP 路径：

| 阶段 | 现象 | 结论 |
|---|---|---|
| 无 Cookie | `status_code=2483`「请先登录，再继续搜索吧」 | 登录是门槛之一 |
| 注入真实 Cookie 后 | `status_code=0`，但 `data` 恒为 `[]` | **登录墙已过，但签名仍缺失** |
| 再补 `msToken` / `webid` / `verifyFp` | 四种组合全部 `status=0, data_len=0` | 补齐参数无效 |

这是抖音的**静默风控**：对缺 `a_bogus` 的请求不报错，只返回空结果。

因此搜索采用**双路径**：
1. 先走普通 HTTP（完整协议实现，一旦接入签名模块即可直接生效）
2. 被静默拦截（空结果 / 2483）时，**回退到 Playwright 浏览器自动化**：
   打开 `douyin.com/search/{keyword}`，在真实浏览器里输入关键词触发搜索，
   拦截 `/aweme/v1/web/general/search/single/` 接口的响应并解析。

浏览器路径依赖 `playwright + chromium`，已写入 `requirements.txt`；
首次需执行 `playwright install chromium` 下载浏览器内核。

> 已知限制：抖音搜索列表的 `statistics.play_count` 恒为 0（接口本身不返回播放量），
> 点赞/评论/收藏/分享数真实返回。我们如实展示，不伪造播放量。

### 抖音手动注入 Cookie

浏览器自动化搜索同样需要登录态（未登录时搜索页会跳登录墙），因此保留手动注入通道：

1. 浏览器打开 douyin.com 并**登录**
2. `F12` → Network → 任选一个请求 → Request Headers 里复制 `cookie` 的完整值
3. 右上角头像 → 平台账号 → 抖音 → **+ 注入 Cookie** → 粘贴保存

保存时后端会**真实试搜一次**，并把结论原样回显。Cookie 与 B 站账号一样加密存于本机 SQLite。

> 注意：热榜端点无需 Cookie 也能访问，所以**仅凭"能连通"无法证明已登录**。
> 后端会检查 `sessionid / sessionid_ss / sid_tt` 等登录态字段，缺失时明确告警。

失败原因会**如实透传**给用户。单平台失败不会污染其他平台 ——
同时勾选 B 站与抖音时，B 站结果照常返回。

热榜已单独暴露为 `GET /api/platforms/douyin/hot`，可作为降级内容或灵感入口。

### 小红书平台的真实能力（重要，勿夸大）

小红书已按同样架构接入（`app/platforms/xiaohongshu/adapter.py`），其 Web 端主力搜索接口
`/api/sns/web/v1/search/notes` 受 `X-s` / `X-t` 动态签名保护 —— 小红书自研 JSVMP 混淆 SDK，
与抖音 `a_bogus` 同级别难度。本项目**不逆向签名算法**，同样采用 **Playwright 浏览器自动化**绕开：

| 能力 | 状态 | 实现方式 |
|---|---|---|
| 关键词搜索 | ✅ 可用（需登录态） | **浏览器自动化**：真实 Chromium 加载搜索页，页面 JS 自行生成 `X-s`/`X-t`，拦截 `search/notes` 响应 |
| 账号登录 | ⚠️ 手动注入 | 无扫码流程，粘贴 Cookie 保留登录态 |

#### 小红书搜索：强制登录（实测结论）

与抖音「游客态能看第一屏」不同，小红书搜索页在**未登录状态直接弹登录墙**
（`登录后查看搜索结果`），搜索接口请求根本不会发出。实测（headless + 无 Cookie）：

- 页面只触发 `search/recommend`（联想词）等公开请求，`search/notes` **零请求**
- 笔记卡片 DOM 为空，正文仅剩登录墙文案
- 必须注入含 `web_session` 的有效 Cookie，`search/notes` 才会被触发

因此搜索路径为：
1. 打开 `xiaohongshu.com/search_result?keyword={关键词}`
2. 页面 JS 自动发起 `search/notes`（带正确的 `X-s`/`X-t`），拦截其响应并解析
3. 未登录时**快速失败并如实告知**「需要登录」，不再做无意义的 3 次重试

#### 小红书手动注入 Cookie

1. 浏览器打开 xiaohongshu.com 并**登录**（小红书 App 扫码 / 手机号）
2. `F12` → Network → 任选一个 `edith.xiaohongshu.com` 请求 → Request Headers 里复制 `cookie` 的完整值
3. 右上角头像 → 平台账号 → 小红书 → **+ 注入 Cookie** → 粘贴保存

后端会检查 `web_session`（登录态核心）与 `a1` 等基础标识字段，缺失时明确告警。
Cookie 与 B 站/抖音账号一样经 Fernet 加密存于本机 SQLite。

> 已知限制：`search/notes` 返回的 `note_card` 不含播放量，笔记的点赞/收藏/评论/分享数真实返回。
> 我们如实展示，不伪造数据。详情接口 `fetch_detail` 同样受 `X-s` 保护，当前未实现。

### YouTube 平台的真实能力（重要，勿夸大）

YouTube 与抖音、小红书有**根本区别**：搜索结果是服务端渲染（SSR）直出的，
页面里就有一份完整的 `ytInitialData` JSON，**不需要任何签名、也不需要 Playwright** ——
普通 HTTP 抓取即可解析。本项目因此**没有**为它引入浏览器自动化。

| 能力 | 状态 | 实现方式 |
|---|---|---|
| 关键词搜索 | ✅ 可用 | 抓 `/results` 页面里的 `ytInitialData` |
| 翻页 / 加载更多 | ✅ 可用 | POST `/youtubei/v1/search` 走 continuation 游标 |
| 详情 | ✅ 可用 | `ytInitialPlayerResponse.videoDetails`（同样直出） |
| 下载 | ✅ 可用 | **交给 `yt-dlp`** 解签名取流，服务端流式转发 |
| 评论 / 登录 / 互动量门槛 | ❌ 未实现 | 前端自动隐藏，不发无用请求 |

#### 两个解析坑（YouTube 改版实证，2026-10）

1. **搜索结果节点换了类型。** 2025 起首屏同时存在新的 `lockupViewModel` 与老的
   `videoRenderer`，实测一屏 12 个 `videoRenderer` + 11 个 `lockupViewModel` ——
   只认老结构会**静默丢掉近一半结果**。现在两种都收集并打 `__node_kind` 标记，
   且 lockup 的文本形态是 `{"content": ...}`（不是 `simpleText`/`runs`），需单独取值函数。
2. **翻页游标不在 `ytInitialData` 里。** SSR 首屏不再内嵌，`continuationCommand`
   出现在 **HTML 正文**里；翻页必须 POST `/youtubei/v1/search`
   （用 `/browse` 会**静默返回空**，不报错），且必须取**最后一个** token ——
   页面前面几个是筛选 chip 的 continuation，用它们只会拿到被筛过的子集。
   `apiKey` / `clientVersion` / `visitorData` 全部从首屏 `ytcfg.set()` 现取，写死必失效。

#### 下载：为什么不自研签名解密

`ytInitialPlayerResponse` 里的流**既没有 `url` 也没有 `signatureCipher`** ——
真实地址藏在播放器 JS 背后，需要解出签名并处理 `n` 参数 / PO token。
自建这套 decipher 是与 YouTube 长期对抗的维护陷阱，所以下载交给 `yt-dlp`，
本项目只负责「取直链 + 流式转发」。YouTube 的流是**音视频分离**的，
要拿到带声音的完整视频必须由 ffmpeg 合并（下载时 `format_id=merge`）。

#### 网络：代理必须显式配置

YouTube 在多数办公/家庭网络下无法直连。**不能依赖环境里的 `HTTP_PROXY`** ——
那类变量常指向只允许内网白名单的代理，访问 youtube.com 会直接返回 **502**。
因此代理必须显式写进 `backend/.env` 的 `YOUTUBE_PROXY`，且请求一律 `trust_env=False`，
避免被环境代理静默劫持。

#### 嵌入：只能服务端代理成同源

YouTube 的 `/watch` 带 `X-Frame-Options: SAMEORIGIN`，**无法跨域 iframe**；
`/embed/` 虽然没有该响应头，但实测仍起不来。要显示原网页只有一条路：服务端代理。
而只代理 HTML 又不够 —— 页面 JS 会 POST 到 `youtubei/v1/player`，从本站源发出属跨域，
YouTube 不会给 CORS 头，结果「页面出来了但播放器没数据」。解决办法是注入一段 shim，
把 youtube 域的 `fetch`/XHR/`sendBeacon` 改道到同源 `/api/platforms/youtube/proxy`。

> ⚠️ **安全红线**：`/api/platforms/youtube/proxy` 本质是「代用户取任意 URL」，
> 必须保留域名白名单（`youtube.com` / `ytimg.com` / `ggpht.com` / `googlevideo.com` /
> `gstatic.com`），否则等于把本机网络敞开给外部调用者（可探测内网、读云元数据）。
> 该白名单是 SSRF 防线，不要为了方便调试而放宽。

### 详情浮层：点击结果不跳走

点击结果卡片会在**居中浮层**内打开详情，而不是跳到平台页面。

**如何做到「屏蔽 B 站的推荐视频」**：

关键在于**绝不嵌入 `www.bilibili.com/video/xxx`** —— 那个页面通篇是推荐流。
实际做法分两层：

1. **播放器只用官方 embed 域名** `player.bilibili.com/player.html`（无侧边推荐栏）
2. **详情与评论全部自绘** —— 调平台接口取结构化数据后，由我们渲染标题、UP 主、
   播放/弹幕/点赞/投币/收藏/评论、时长、简介、标签，以及完整评论区

于是推荐内容在我们的页面上根本没有落脚点。

**评论区**同样走结构化取数（`GET /api/platforms/{key}/comments`）：
支持「最热 / 最新」切换、楼中楼嵌套回复（每条最多展开 3 条子回复）、
分页加载更多。评论是**可选能力**——平台适配器未实现 `fetch_comments` 时
自动隐藏评论区，而不是弹一个刺眼的错误（抖音当前即如此）。

> 需要说明的边界：播放器 iframe 内部（播放结束后可能出现 B 站推荐卡片）
> 属于跨域内容，前端无法干预。我们保证的是**自己渲染的区域零推荐**。

交互细节：左键开浮层，`Ctrl / Shift / 中键` 仍按浏览器习惯新窗口打开；
支持 `ESC` 与点击遮罩关闭，打开时锁定背景滚动。

> 实现备注：新版 `view` 接口**不再内联返回 tags**，需单独请求
> `/x/tag/archive/tags`；且该接口返回的是裸数组（非标准 `data` 段），
> 会被 `request_json` 包成 `result`，两种形态都要兼容。

### 交互行为

- **滚动到底部自动加载**：用 `IntersectionObserver` 监听底部哨兵，`rootMargin: 500px`
  提前触发，用户滚到底之前数据就已就位；「加载更多」按钮保留作为观察器失效时的兜底。
- **切换条件自动重搜**：平台 / 排序 / 类型 / 时长任一变化都会自动重新检索（420ms 防抖），
  无需再点搜索按钮。
- 平台不支持的内容形态（如抖音无图文检索）会自动置灰，避免发出注定无结果的请求。

---

## 打分公式（当前默认关闭）

```
最终得分 = (相关性×0.32 + 互动质量×0.26 + 热度×0.20 + 时效×0.12 + 时长适配×0.10)
           × 质量惩罚系数 × 100
```

权重集中在 `backend/app/recommend/scorer.py` 顶部的 `WEIGHTS`。

> **为何默认关闭**：实测发现「跑题过滤」与「重排序」在番剧类检索中会严重误伤。
> 例如搜索「美国老爹」，平台返回的单集如《兰利镇特色父女情深》《圣诞埋尸夜》
> 标题里并不出现片名，文本相关性为 0.0 —— 与真正的噪声（如「有哪些著名的设计失败的汽车？」）
> 完全无法区分。既然平台的排序本身已考虑内容归属，相关性判定应当信任平台。
> 相关开关位：`backend/app/recommend/service.py` 的 `RELEVANCE_GATE_ENABLED` 与 `recommend(rerank=...)`。

保留下来但不启用的另一处经验：连载剧集去重豁免。
`dedup.py` 的 `is_duplicate_pair` 会识别「第1集/第2集」「EP01/EP02」这类仅编号不同的标题，
判定为不同内容予以保留 —— 否则整季连载会被当成一条内容砍掉（实测相似度高达 0.86）。

---

## 桌面宠物（`pet/`）

同一个仓库里的第三个产品：一只透明置顶的 Windows 桌宠「鲸汐」，PyQt6 实现，
打包成独立 exe。**与灵搜、video-mind 没有任何代码依赖**，也不会被 web 服务加载。

- 形象：角色三视图（正 / 侧 / 背 / 演唱）+ AI 补生成的**四帧走路循环**与**被举起姿态**，
  共 9 帧，按脚底对齐后切换不跳动。
- 交互：**自动在桌面走动**（边缘转身、鼠标悬停即停）、拖拽时呈「被举起」形态、
  **拖到屏幕四边任一条会吸附成「只露头」，且能停在同一条边的任意位置**（点一下钻回）、
  单击戳一戳（切演唱姿势）、长按摸头、双击转身、**滚轮无级缩放**、右键菜单、托盘。
- 尺寸：默认约屏高 23%（1080p ≈ 237px），可在 20%~200% 间自由调节，位置与尺寸都会记忆。
- 打包产物输出到 `桌面\桌宠\Jingxi\`，`pet/build/` 与 `dist/` 不入库。
- **网页版**：同一形象也嵌在前端里（任意页面右下角，`frontend/src/components/webPet/`），
  走动/戳一戳/气泡/拖拽/**视口四边贴边**都能用；素材由 `pet/build-tools/export_web_frames.py`
  导成 WebP（5MB → 376KB）。浏览器做不到桌面版的「透明置顶盖住其他软件」。

构建命令、台词修改、素材抠图与技术细节见 [`pet/README.md`](pet/README.md)。

---

## 参与开发

团队协作的全部约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)：分支模型、提交规范、PR 与 Code Review、
代码风格、安全红线、新平台接入步骤。

AI 协作任务看板见 [`tasks/README.md`](tasks/README.md)：跨会话发布、认领、完成任务。

仓库维护者（协作者权限、分支保护、默认分支）请另外看 [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md)。

开源许可：[MIT](LICENSE)。
