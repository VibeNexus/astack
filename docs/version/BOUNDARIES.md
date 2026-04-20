# 迭代边界规则

> 每个迭代的范围边界，防止跨迭代的范围蔓延。由 `/spec` 命令自动维护。
> spec_review 评审时作为迭代边界遵守（A3）的评审基准。

## v0.3 — 项目详情页重设计 + Web 端完整管理能力

**本迭代做：**
- ProjectDetailPage 重写为 Tabs 布局（Subscriptions / Linked Tools / Sync History / Settings）
- `Tabs` + `Drawer` 两个 UI primitive
- `BrowseSkillsDrawer`（Web 端订阅入口）+ `SyncResultCard`（Sync 可视化）
- 后端 `GET /api/projects/:id/sync-logs` + `ToolLink.target_path` + batch subscribe partial-success
- `ui.tsx` → `ui/` 目录 + `useProjectActions` hook（纯重构，作为前置）
- `packages/web` Playwright E2E 脚手架
- 移动端响应式 + CommandPalette 扩展 + a11y 专项测试

**本迭代不做（延后到 v0.4+）：**
- Pin version UI（后端字段保留，UI 延后）
- Bulk actions（多选 sync / unsubscribe）
- 3-way merge UI
- `sync_logs` 过期清理 cron
- `GET /api/skills?q=` 聚合查询（Browse Drawer 当前接受 N+1）
- Windows junction 兼容
- Custom tool link path（先 3 个预设 dropdown）
- DESIGN.md 单一事实来源（独立跑 `/design-consultation`）

## v0.2 — sqlite 换底 + 多仓库目录兼容

已 SHIPPED，见 [v0.2-sqlite-and-multi-repo.md](./v0.2-sqlite-and-multi-repo.md) § 1。
