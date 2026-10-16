# 协作开发指南 · 灵搜 LingoSeek

欢迎加入。这份文档是团队唯一的协作契约，请**先读完再写第一行代码**。

---

## 0. 三十秒速览

| 项目 | 约定 |
|---|---|
| 主分支 | `master`（随时可发布），`develop`（集成分支） |
| 开发分支 | `feat/xxx`、`fix/xxx`、`platform/xxx` |
| 提交信息 | Conventional Commits：`feat(search): 支持按时长筛选` |
| 合并方式 | Squash Merge；默认禁止直接 push 到 `master` / `develop`（例外见 §1.1） |
| 代码审查 | 每个 PR 至少 1 人 Approve |
| 语言 | 代码注释与文档用中文，标识符用英文 |

---

## 1. 分支模型

```
master      ← 稳定版，只允许从 release/* 或 hotfix/* 合并，受分支保护
  ↑
develop     ← 集成分支，日常 PR 的目标分支
  ↑
feat/xxx    ← 新功能      fix/xxx   ← 缺陷修复
platform/xxx← 新平台接入   chore/xxx ← 依赖/工具
```

规则：

1. `master` 与 `develop` **开启分支保护**，任何人（含 owner）都不得直接 push
   ——**例外见 §1.1：本机 `AGENTS.md` 声明了 `master` 角色的使用者可以直接推 `master`**。
2. 一切改动从 `develop` 切出，PR 回到 `develop`。
3. 分支名用小写英文 + 连字符，前缀表明性质：`feat/search-filter`、`fix/bili-wbi-403`。
4. 分支生命期尽量短：**3 天内合并或关闭**，避免长期分支产生巨型冲突。
5. 合入后立刻删除远程分支。

```bash
git switch develop && git pull --rebase
git switch -c feat/my-feature
# ... 开发 ...
git push -u origin feat/my-feature   # 然后开 PR 到 develop
```

### 1.1 例外：本机 `AGENTS.md` 可授予 master 角色

`AGENTS.md` **不在版本库里**——它已被 `.gitignore` 忽略，是每位使用者**只保存在本机**
的工作约定文件，用来承载本指南无法统一的个性化规则（本机环境、权限、习惯等）。

若某位使用者在自己本机的 `AGENTS.md` 里声明了角色：

```markdown
角色：master
```

那么该使用者**可以直接 push `master`**，无需走分支 + PR。
没有声明该角色的使用者，仍然按上面的规则从 `develop` 切分支、PR 回 `develop`。

**为什么这样设计**：分支保护是为「多人互相 review」准备的。当一个人既是唯一提交者
又是最终决策者时，强制 PR 只是给自己加一次空白审批——所以需要一个逃生口。
但逃生口**不能写进仓库**：写进仓库等于对所有 clone 的人生效，保护就形同虚设。
放在不入库的 `AGENTS.md` 里，权限就**跟着机器走**——换一个人 clone 下来，
默认仍是受约束的普通角色，保护规则原样生效。

> 注：`AGENTS.md` 与 `CONTRIBUTING.md` 冲突时，以**本机 `AGENTS.md`** 为准
> （它离使用者更近，也更清楚这台机器上的实际情况）。

---

## 2. 本地环境

### 后端（Python 3.11+，Windows 用 PowerShell / Git Bash）

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium          # 抖音浏览器检索依赖，必装
cp .env.example .env                 # 可选，全部字段都有默认值
uvicorn main:app --reload --port 8000
```

健康检查：浏览器打开 <http://127.0.0.1:8000/api/health>，`platforms` 应返回已注册平台。

### 前端（Node 20+）

```bash
cd frontend
npm install
npm run dev        # http://127.0.0.1:5173，已代理 /api → 8000
```

### 首次克隆后必做

```bash
git config core.autocrlf false     # 配合 .gitattributes 统一 LF
git config pull.rebase true        # 保持线性历史
git config user.name  "你的 GitHub 用户名"
git config user.email "你的提交邮箱"
```

---

## 3. 提交规范

格式：`<类型>(<范围>): <中文简述>`，简述用祈使句、结尾不加句号，控制在 50 字内。

```
feat(search): 搜索结果支持按时长筛选
fix(bilibili): 修复 wbi 签名在整点后 403
perf(paging): 批间延迟从 0.8s 降到 0.45s
docs(readme): 补充分页取数策略表格
refactor(recommend): 抽出语义指纹计算函数
platform(douyin): 接入抖音图文检索
```

常用类型：`feat` `fix` `perf` `refactor` `docs` `test` `build` `ci` `chore` `revert`

要求：

- **一个提交只做一件事**。改了缩进又改逻辑？拆成两个提交。
- 正文（可选）写「为什么」而不是「改了什么」，代码本身就是「改了什么」。
- 破坏性变更在正文写 `BREAKING CHANGE: ...`。

---

## 4. Pull Request 规范

**标题**即提交标题，`feat`/`fix` 开头；关联 Issue 用 `Closes #12`。

**描述**按模板填写（`.github/PULL_REQUEST_TEMPLATE.md` 会自动带出），重点说清：

- 动机与方案取舍
- 影响到的接口 / 前端交互 / 配置
- 自测过程（关键词、批次、结果条数）

**合并前自查清单**：

- [ ] 本地 `npm run build` 与后端启动均无报错
- [ ] 没有提交 `backend/data/`、`.env`、`.secret_key`、`*.db`、截图里的 Cookie
- [ ] 新增配置已同步进 `backend/.env.example`
- [ ] 前后端联动常量已同步修改（见下）
- [ ] 平台接口字段变更已在代码注释中标明来源
- [ ] README 中相关描述已同步更新

### 协作红线（本项目特有）

1. **禁止重排平台原生顺序**。服务端一律不重排，`recommend(rerank=True)` 仅供实验，前端不展示分数。
2. **不要用「删除」实现多样性**。作者配额只作极端刷屏兜底（当前 50），不得再收紧。
3. **分页常量前后端必须一致**：`PAGE_BATCH = 4`（`App.tsx` 与 `SearchRequest.pages`）、`RESULT_BATCH_SIZE = 60`、`MAX_OUTPUT_SIZE = 100`、`MAX_FETCH_PAGES = 30`。改一处必须改另一处，并在 PR 里写明。
4. **并发翻页会静默丢页**：`PAGING_CONCURRENCY` 上限 3、批间 0.45s，不要为了提速调高并发。
5. **评论是可选能力**：适配器未实现 `fetch_comments` 时前端自动隐藏，不要抛错。

---

## 5. 代码规范

**Python**：行宽 100，4 空格缩进，导入排序由 ruff 的 `I` 规则管理；公共函数写中文 docstring；类型注解用 `from __future__ import annotations` 风格。

```bash
pip install ruff
ruff check .          # 全量检查
ruff format .         # 格式化（提交前建议跑一次）
```

**TypeScript / React**：2 空格缩进，组件文件名 PascalCase，函数组件优先；避免 `any`，接口定义集中在 `src/api/client.ts` 的类型里。

```bash
cd frontend
npx prettier --write .
npm run build         # 等价于 tsc + vite build 校验
```

**CI 会在 PR 上自动跑这两套检查**，见 `.github/workflows/ci.yml`。

---

## 6. 安全红线

本项目会保存用户登录后的平台凭据，一旦泄露相当于交出账号。

- 绝不提交：`backend/data/**`、`.env`、`.secret_key`、`*.db`、含 Cookie / SESSDATA 的日志与截图。
- 提交前用 `git status` + `git diff --stat` 过一遍，确认没有意外文件。
- 调试时打印的响应体，合并前必须删除或降级为 `logger.debug`。
- 一旦误提交密钥：**立即吊销该凭据**并改写历史（`git filter-repo`），仅删除文件是不够的。

---

## 7. 新增一个平台适配器

架构已为多平台预留插槽，接入新平台的标准动作：

1. 新建 `backend/app/platforms/<平台>/`，实现 `adapter.py`（继承 `app/platforms/base.py`）与 `client.py`。
2. 至少实现 `search`；`fetch_comments`、`hot`、`login` 按需实现，未实现的能力前端会自动隐藏。
3. 在 `backend/main.py` 的生命周期「平台注册区」追加注册。
4. 前端 `src/components` 中补充平台选项，不支持的内容形态（如抖音无图文）置灰。
5. 在 README 的平台支持表中补一行，并说明该平台的排序 / 分页限制。

---

## 8. 测试与验收

当前测试是手工脚本（`backend/test_douyin_browser.py`），PR 请附**可复现的自测记录**：

- 使用的关键词（建议用《美国老爹》这类有明确归属的番剧名，能同时验证跑题过滤）
- 连续加载 3 批以上的结果条数与耗时
- 全局去重后的条数（用于确认没有静默丢页或重复）

新增核心逻辑（打分、去重、相关性判断）时，**请补一个 pytest 用例**，哪怕只覆盖一条 happy path。

---

## 9. 发版

1. 从 `develop` 切 `release/x.y.z`，只做版本号、文档与 bugfix。
2. 验证通过后分别合入 `master` 与 `develop`。
3. 在 `master` 打 tag：`git tag -a v0.1.0 -m "v0.1.0"`。
4. 线上紧急问题从 `master` 切 `hotfix/xxx`，修复后同时合回 `master` 与 `develop`。

---

## 10. Issue 与任务

- 开工前先在 Issue 认领（`assignees`），避免两人撞车。
- Bug 用「Bug 反馈」模板，必须包含：复现步骤、关键词、期望与实际结果、后端日志片段。
- 超过一天未完成的任务，在 Issue 里留一句进度，方便别人接手。

---

## 11. 维护者附加职责

仓库设置相关的操作（邀请协作者、分支保护、规则集）见 `docs/GITHUB_SETUP.md`。
