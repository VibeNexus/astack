# TODOS

> 评审产出的 "deferred but captured" 项。每项含 What / Why / Context / Depends on。
> 不是 bug tracker 的替代品，只记录**跨迭代延后**的工程决策。

## v0.4 候选

### T1 · `GET /api/skills?q=&type=&repo_id=` 聚合查询 endpoint

- **What:** 一次性返回所有 repo 的 skills，支持 search / type filter / 分页
- **Why:** v0.3 的 BrowseSkillsDrawer 用 `Promise.all(listRepoSkills(repo.id))` 并发拉取，是 N+1。本地 HTTP/2 下 20 个 repo ≈ 1s，可接受但浪费
- **Pros:** Drawer 打开速度 ↑；未来跨 repo 搜索/排序一致
- **Cons:** 需要新路由 + zod schema + 前端替换；有 ~2h 工作
- **Context:** 当前 N+1 已在 v0.3 PR7 验收（本地可接受）。公开 astack 或多人共享 daemon 时此问题会放大。
- **Depends on:** —
- **Source:** v0.3 Eng Review Perf-4A

### T7 · Pin version UI（⋯ → "Pin to version…"）

- **What:** SubscriptionRow 的 ⋯ 菜单加 "Pin to version…"，弹 dialog 选 commit
- **Why:** 后端 `subscriptions.pinned_version` 字段已存在、service 已支持；Web 层没暴露
- **Pros:** 用户可锁版本（例如业务团队钉住 audit 过的 skill 版本）
- **Cons:** 需要新 `PATCH /api/projects/:id/subscriptions/:skill_id` endpoint（或放 v0.3b 合入）；commit 选择 UI 要设计
- **Context:** v0.3 主线里把 Pin UI 标为 Out of scope，防止迭代膨胀。可作为 v0.3b 小补丁或 v0.4 正式做
- **Depends on:** —

## v0.5 候选

### T2 · `sync_logs` 过期清理

- **What:** daemon 每天跑一次清理，删除 > N 天（默认 30）的 sync_logs 行；N 在 Settings 配置
- **Why:** 当前 append-only，10 sync/天 × 1 年 = 36k 行；用户用 3 年 = 10 万行
- **Pros:** 磁盘占用有界、Sync History tab 查询快
- **Cons:** 增加 daemon 的 cron 机制；决策默认保留几天
- **Context:** 10 万行 sync_logs 实际也就几 MB；不是紧急问题
- **Depends on:** daemon 的 scheduler 抽象（当前没有）

### T3 · 3-way merge UI

- **What:** 替换当前 `/resolve/:pid/:sid` 的"keep-local / use-remote / manual" 三选为真正的 3-way diff viewer
- **Why:** 当前 resolve 体验粗糙——用户看不到具体差异就要做决定
- **Pros:** 冲突解决体验大幅提升
- **Cons:** ocean 级工作（语法高亮、行级选 side、文件树）；至少 1-2 周
- **Context:** 现有 `/resolve` 页已能跑通基本流程；v0.3 不动
- **Depends on:** 可能需要引入 `monaco-editor` 或 `codemirror`

## 独立 / 无时间表

### T4 · Bulk actions（多选 sync / unsubscribe）

- **What:** Subscriptions table 加 checkbox + 底部 "Sync N / Unsubscribe N" 批量按钮
- **Why:** 12+ 订阅的用户一条条点累
- **Pros:** 效率提升
- **Cons:** 需要观察真实用户使用是否有此需求；增加 UI 复杂度
- **Context:** 未验证真需求，先不做
- **Depends on:** —

### T5 · Windows junction 兼容（替代 symlink）

- **What:** `SymlinkService` 在 Windows 上用 `fs.symlinkSync(target, link, "junction")`
- **Why:** Windows 非管理员无法建 symlink，只能建 junction（目录 only）
- **Pros:** 支持 Windows
- **Cons:** junction 只能指目录、行为与 symlink 有细微差异；需要 Windows 机器测试
- **Context:** 当前 astack 实际没支持 Windows（symlink 在非管理员会报权限错误）
- **Depends on:** Windows CI runner

### T6 · DESIGN.md — 单一设计系统事实来源

- **What:** 跑 `/design-consultation`，产出 `docs/asset/DESIGN.md`（color / typography / spacing / motion / component inventory）
- **Why:** 当前 Graphite UI token 在代码里、组件注释里、review 文档里散落；plan-design-review 没有权威基准
- **Pros:** 未来所有 UI 变更有 debug 对齐锚点
- **Cons:** 独立工作，需要设计师式思考（gstack `/design-consultation` 能辅助）
- **Context:** v0.3 plan-design-review 明确 flag 为 gap
- **Depends on:** —
