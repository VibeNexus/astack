# Astack

> AI Coding 技能跨项目管理工具

一次维护、多处同步。把 `.claude/commands/` 和 `.claude/skills/` 从项目里解耦出来，集中到一个 git 仓库管理，用 CLI 和 Web 管控所有项目的订阅、同步、冲突。

**支持的 AI 工具：** Claude Code（主）→ Cursor、CodeBuddy（通过 symlink 自动同步）

## Status

v0.1.0 — 规划完成，进入实现阶段。设计文档在 `docs/asset/design.md`（1002 行，35 个决策锁定）。

## Architecture

```
┌─────────────────┐       ┌──────────────────┐       ┌────────────────┐
│   Web Dashboard │◀────▶│  Backend Daemon   │◀────▶│  Git Repos     │
│  (React + Vite) │  REST│  (Hono + SQLite)  │  git │  (元技能源)    │
└─────────────────┘ + SSE└──────────────────┘       └────────────────┘
                                   ▲
                                   │ REST
                         ┌─────────┴─────────┐
                         │  CLI (astack)     │
                         │  项目 .claude/    │
                         └───────────────────┘
```

## Packages

- **`@astack/shared`** — zod schemas, 错误码, API 契约（所有 package 的依赖）
- **`@astack/server`** — Hono 后端 + SQLite + git 操作 + SSE 推送
- **`@astack/cli`** — `astack` 命令行工具
- **`@astack/web`** — React + Tailwind dashboard

## Development

```bash
pnpm install           # 安装所有依赖
pnpm build             # 构建所有 package
pnpm test              # 跑所有测试
pnpm test:coverage     # 跑测试 + 覆盖率（门槛：lines 90% / branches 85%）
pnpm typecheck         # 类型检查
pnpm dev               # 并行启动所有 package 的 watch 模式
```

## Docs

- [Design Document](./docs/asset/design.md) — 完整设计（Office Hours + Eng Review + Design Review）
- [AGENTS.md](./AGENTS.md) — 项目导航
- [CLAUDE.md](./CLAUDE.md) — AI 工具路由规则

## License

MIT
