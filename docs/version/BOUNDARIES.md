# 迭代边界规则

> 每个迭代的范围边界，防止跨迭代的范围蔓延。由 `/spec` 命令自动维护。
> spec_review 评审时作为迭代边界遵守（A3）的评审基准。

## v0.4 — Harness Tab + 系统级 Skill 首次落地

**本迭代做：**
- `SystemSkill` 领域类型（独立于 `Skill` / `Subscription`，不进 `subscriptions` 表）
- 搬运 `scripts/harness-init` → `packages/server/system-skills/harness-init/`，npm publish 带上
- 注册项目时通过事件订阅 fire-and-forget seed 到 `<project>/.claude/skills/harness-init/`（仅当目标目录不存在时 seed，不覆盖已有内容）
- `.astack/system-skills.json` stub 文件记录 seed 时的内置 hash + seeded_at + last_error
- `Project Detail` 新增 **Harness** tab（4 状态：`installed / drift / missing / seed_failed`）
- **内置版本即真相源**：用户不允许修改 seed 目录；被修改时 UI 显示 `drift` 诚实告知"will be overwritten on next Re-install"；点 Re-install 强制覆盖
- Sidebar "Skill Matrix" 重命名为 "Matrix"（纯文案）
- 新 SSE 事件：`harness.changed`（仅在 seed/install 真改动 fs 时广播；inspect 不广播）
- Scanner 过滤系统 skill 同名的 repo skill（`scanRepo` 注入 `systemSkillIds` 黑名单）+ SymlinkService 兜底 guard，防止命名空间污染
- E2E 覆盖：installed happy path / drift overwrite / legacy 项目不被 seedIfMissing 覆盖 / 污染 repo 被 scanner 剔除

**本迭代不做（延后到 v0.5+）：**
- 自动清理 seed 目录 / 基于 `AGENTS.md+INDEX.md` 的项目 initialized 检测（需求 v2 决策取消）
- `GET /harness` 等 read 路径带写副作用（v2 改为纯读）
- 60s reconcile 节流 + `sync.completed` 触发 reconcile（v2 决策：无 reconcile 概念）
- Daemon 启动时扫全部项目做 drift 覆盖（v0.5 配合版本升级语义一起做）
- SystemSkill 版本升级检测（存根存 `built_in_hash` 预留，v0.5 加 "Built-in updated, Re-install" UI 提示）
- 多个系统级 skill 的管理 UI（仅 harness-init 一个，但类型设计保留扩展位）
- Harness 子命令（`/spec`、`/dev` 等）的健康检测（只管 skill 目录 hash）
- `astack.json` 里声明系统 skill 依赖（用独立 stub 文件，见 A1）
- CLI `astack harness install/status`（v0.5 跟其他 CLI 一致性补齐）
- 非 `.claude` primary_tool 的 seed 适配（UI 提示，不 seed）
- Dialog primitive 抽象（T8 待 v0.5）
- Windows 路径兼容（沿用 v0.3 决策）

## v0.3 — 项目详情页重设计 + Web 端完整管理能力

**本迭代做：**
- ProjectDetailPage 重写为 Tabs 布局（Subscriptions / Linked Dirs / Sync History / Settings）
- `Tabs` + `Drawer` 两个 UI primitive
- `BrowseSkillsDrawer`（Web 端订阅入口）+ `SyncResultCard`（Sync 可视化）
- 后端 `GET /api/projects/:id/sync-logs` + `LinkedDir.target_path` + batch subscribe partial-success
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
- Custom linked dir path（先 3 个预设 dropdown）
- DESIGN.md 单一事实来源（独立跑 `/design-consultation`）

## v0.2 — sqlite 换底 + 多仓库目录兼容

已 SHIPPED，见 [v0.2-sqlite-and-multi-repo.md](./v0.2-sqlite-and-multi-repo.md) § 1。
