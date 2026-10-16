## 这个 PR 做了什么

<!-- 一句话说清改动；关联 Issue 用 Closes #12 -->

## 为什么这么做

<!-- 背景、取舍、被否决的方案。没有这段，reviewer 只能猜你的意图。 -->

## 影响范围

- [ ] 后端接口（列出路径与字段变化）
- [ ] 前端交互
- [ ] 配置项（是否已同步 `.env.example`）
- [ ] 文档 / README

## 自测记录

<!-- 关键词、加载批次、结果条数、耗时。核心逻辑变动请附上去重后条数。 -->

- 关键词：
- 连续加载批次 / 结果条数：
- 平台（B 站 / 抖音）与排序方式：

## 合并前自查

- [ ] 后端可启动、`npm run build` 通过
- [ ] 未提交 `backend/data/`、`.env`、`.secret_key`、`*.db` 及含 Cookie 的日志截图
- [ ] 前后端联动常量已同步（`PAGE_BATCH` / `RESULT_BATCH_SIZE` / `MAX_OUTPUT_SIZE` / `MAX_FETCH_PAGES`）
- [ ] 未改动平台原生结果顺序（本项目设计红线）
- [ ] 提交信息符合 Conventional Commits
