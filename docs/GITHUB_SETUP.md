# 维护者配置清单

给仓库 owner：以下操作在 GitHub 网页端完成一次即可，之后团队按 `CONTRIBUTING.md` 自行运转。

---

## 1. 邀请协作者

`Settings → Collaborators → Add people`

| 角色 | 适合谁 | 能做什么 |
|---|---|---|
| **Read** | 只看代码的人 | 只读 |
| **Triage** | 负责分诊 Issue 的人 | 管理 Issue/PR，不能改代码 |
| **Write**（推荐给多数开发者） | 常规开发 | push 分支、合并 PR |
| **Maintain** | 核心成员 | 额外可管理设置（不含安全与删除仓库） |
| **Admin** | 联合 owner | 全部权限 |

建议：日常开发给 **Write**，1～2 名核心成员给 **Maintain**。

## 2. 保护 `master` 与 `develop`

`Settings → Branches → Add branch ruleset`（推荐用 Ruleset，比经典保护更灵活），
匹配分支填 `master`、`develop`，勾选：

- [x] **Restrict deletions** — 禁止删分支
- [x] **Restrict force pushes** — 禁止强推
- [x] **Require a pull request before merging**
  - Required approvals: `1`
  - Dismiss stale approvals on new commits: 开启
  - Require review from Code Owners: 开启（配合 `.github/CODEOWNERS`）
- [x] **Require status checks to pass**
  - 添加检查项：`后端 · Python`、`前端 · Node`、`敏感信息扫描`
  - Require branches to be up to date before merging: 开启
- [x] **Require conversation resolution before merging**
- [x] **Block force pushes / creations**（Ruleset 里的 Target: branch）

> 关键一步：Ruleset 的 **Bypass list** 里不要加 Admin，否则 owner 自己会绕过所有检查。
> owner 也应走 PR，这样规则才对所有人有效，历史也更干净。

## 3. 统一合并策略

`Settings → General → Pull Requests`

- 只勾选 **Allow squash merging**（历史保持线性，一个 PR 一个提交）
- 取消 **Allow merge commits** 与 **Allow rebase merging**
- 勾选 **Automatically delete head branches**（合并后自动清理远程分支）
- 默认提交信息建议选 `Pull request title`

## 4. 建 `develop` 并设为默认分支

```bash
git switch -c develop master
git push -u origin develop
```

随后在 `Settings → General → Default branch` 把默认分支从 `master` 改为 `develop`。
好处：新协作者 clone 后就在集成分支上，开 PR 时目标分支也默认是 `develop`，不会误提给 `master`。

## 5. 其他可选开关

- `Settings → General → Features`：勾选 **Issues**，建议同时开 **Discussions**（方案讨论不污染 Issue）
- `Settings → Actions → General`：Workflow 权限设为 **Read repository contents**
- `Settings → Secrets and variables → Actions`：部署需要时才添加，本项目默认无需密钥

## 6. 新人上手指引（可直接发群里）

```bash
git clone git@github.com:2333up/RealVideoWebSite.git
cd RealVideoWebSite
git config core.autocrlf false && git config pull.rebase true
git switch develop
# 后端
cd backend && python -m venv .venv && source .venv/Scripts/activate
pip install -r requirements.txt && playwright install chromium
uvicorn main:app --reload --port 8000
# 前端（另开一个终端）
cd frontend && npm install && npm run dev
```

读三份文件即可开工：`README.md`（产品与技术决策）→ `CONTRIBUTING.md`（协作契约）→ `docs/GITHUB_SETUP.md`（本文件，仅 owner 需要）。
