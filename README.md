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

## Requirements

- **Node.js ≥ 22.13.0**（v0.2 起用 Node 自带的 `node:sqlite`，v22.13 之前没有此模块）
- **pnpm ≥ 10.0.0**

守卫已加在 `astack-server start`：版本不符会立即退出并打印升级指引，不会出现模糊的 `node:sqlite not found` 错误。

## Storage layout & safety

- **`~/.astack/repos/<repo>/` 是只读镜像**。open-source 类型仓库（`kind=open-source`）由 daemon 按 `origin/HEAD` 自动同步维护；**手工修改会在下次 sync / resolve 时被 `git reset --hard` 覆盖**（v0.6 起自愈机制，脏态会发出 `repo.mirror_reset` SSE 事件 + warn 日志）。所有订阅的实际 working copy 在 `<project>/.claude/skills/<skill>/` 的 symlink 目标——要改 skill 请通过订阅路径，或直接在 `kind=custom` 的可写仓库里改。
- **`~/.astack/daemon.log`**（v0.6 起实装）：daemon 运行日志 tee 到此文件（同时仍输出 stderr），`astack server logs` / `tail -f ~/.astack/daemon.log` 可查看。

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
