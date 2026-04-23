# 迭代边界规则

> 每个迭代的范围边界，防止跨迭代的范围蔓延。由 `/spec` 命令自动维护。
> spec_review 评审时作为迭代边界遵守（A3）的评审基准。

## v0.8 — Auto-adopt Reflow（后加 repo 能重分类已兜底 LocalSkill）

**本迭代做：**
- `ProjectBootstrapService.scanRaw` 的 `adoptedLocalKeys` 过滤缩紧为仅 `origin='adopted'`；`origin='auto'` 的 LocalSkill 行允许重新参与 `matched / ambiguous / unmatched` 三元分类
- `ProjectBootstrapService.scanAndAutoSubscribe` 在持 `projectBootstrapLockKey` 锁内追加 snapshot + flip 流程：subscribe 成功后把对应 `origin='auto'` LocalSkill 行翻 `status='name_collision'`（§A6 反方向契约）
- `LocalSkillService.markNameCollisionUnderLock(projectId, refs)` 新方法，与 `autoAdoptFromUnmatched` 对称的无锁下游接口；翻转数 > 0 时 emit 一次 `local_skills.changed`
- `ProjectDetailPage.loadBootstrap` 从 `api.inspectBootstrap`（纯读）切到 `api.scanBootstrap`（幂等写），每次打开项目页自动触发重分类收敛
- 测试：更新 PR4 test 3 注释；新增 v0.8 test 7（auto → 后加 repo → subscribe + name_collision）+ v0.8 test 8（adopted 后加 repo 不翻转）
- retro 沉淀 R8（兜底标记不应被当作永久 ownership）+ P8（兜底决策的永久化）

**本迭代不做（延后到 v0.9+）：**
- name_collision 的用户裁决 UI（一键 unadopt / 退订）
- `origin='auto'` 匹配成功后自动 unadopt（决策：保留让用户决定）
- 反向修复已订阅 skill 被 adopt 后的顺序一致性（§A6 正方向已覆盖，未见盲区再加）
- Daemon 启动时对所有项目 re-run scanAndAutoSubscribe
- 非 `.claude` primary_tool 的 bootstrap 重分类
- 把 `origin='auto'` LocalSkill 纳入 Subscriptions 面板的 ambiguous 面板
- CLI 层对 "rescan after new repo" 的命令入口（跟其他 CLI 一致性统一迭代）

## v0.7 — Local Skills as First-Class Citizens

**本迭代做：**
- 新增 `LocalSkill` 领域概念 + 独立 `local_skills` SQLite 表（`origin: adopted | auto`、`status: present | missing | modified | name_collision`、`content_hash`），不进 `skills` / `subscriptions` / `system_skills` 任何既有表
- `LocalSkillService`：`list / adopt / unadopt / rescan / suggestFromUnmatched` 五个方法；`unadopt` 默认不删 fs 文件，可选 `delete_files: true` 显式删除；`rescan` 只刷新已 adopted 条目的 hash/status，不导入新文件（A7）
- 5 个 HTTP 端点：`GET /local-skills`（纯读）/ `POST /local-skills/adopt` / `unadopt` / `rescan` / `GET /local-skills/suggestions`；response shape 对齐 v0.5 `ApplyResolutionsResult`（`succeeded + failed[]` 带 error_code + message，遵 R7）
- `ProjectBootstrapService.scanAndAutoSubscribe` 扩展 auto-adopt：扫描出 `unmatched` 中符合 heuristic（scanner 合法 + 不在 `ignored_local` + 无订阅）的条目自动 adopt 为 `origin: "auto"` LocalSkill；`scanRaw` 在三元分类前加过滤 "已 adopt LocalSkill"（与 `ignored_local` / 已订阅并列）
- 1 个新 SSE 事件：`local_skills.changed`（coarse-grained，payload 含 `summary: { added, removed, modified, missing }`；不新增分项事件）
- A9 跨服务锁扩展：LocalSkill 三条写路径（adopt / unadopt / rescan）复用 v0.5 `projectBootstrapLockKey(projectId)` 锁，与 ProjectBootstrapService / SyncService.syncProject 共用
- A8 进程内锁：`inflightRescan: Map<projectId, Promise>` 防并发 rescan
- 前端：新 `Local Skills` tab（位于 Subscriptions 之后）+ `LocalSkillsPanel` + `AdoptDrawer` + api 层 5 个方法 + `useQuery(['local-skills', projectId])`；`SubscriptionsPanel` 的 `UnmatchedEmptyState` 条件放宽为 `unmatched.length > 0`（原为 `subscriptions.length === 0 && unmatched.length > 0`），copy 改为 "N local skills not tracked → [Manage in Local Skills tab]"
- E2E ≥ 3 scenario（legacy register 触发 auto-adopt / 手动 adopt+unadopt / rescan 发现 missing）

**本迭代不做（延后到 v0.8+）：**
- LocalSkill → git repo 的 "Promote to repo" 向导（跨迭代 UX，涉及 repo 创建流程）
- LocalSkill 内容编辑器（Web 里改 `.claude/commands/dev.md`）—— 文件所有权原则，astack 只读+索引，编辑走 IDE
- LocalSkill 的跨项目复制 / 借用（是 fs copy，不需 astack 介入）
- LocalSkill 发分项 SSE 事件（adopted / unadopted / modified 分离）—— coarse `.changed` 足够
- CLI `astack local adopt / unadopt / list` —— 本迭代只 Web，CLI 一致性 v0.8 补齐
- 非 `.claude` primary_tool 的 LocalSkill 支持 —— 同 v0.4 / v0.5 保持 `.claude` only
- LocalSkill 与 `ignored_local` 合并 —— 保持独立，`ignored_local` 专指 bootstrap ambiguous 不订阅
- 把 LocalSkill 纳入 Sync 流程 / 头部 `1 skill · 0 tools` 计数（A10）
- Team 协作 UI / 跨开发者 LocalSkill 同步（本质 per-machine；靠 git 的 `.claude/**` 文件 + auto-adopt heuristic 幂等性）
- Daemon 启动时全项目 rescan
- name_collision 的自动裁决按钮（仅标状态，让用户看到）
- v0.5 `ignored_local` 字段迁移到 `local_skills` 表（两表语义不同：§A3）
- `BOOTSTRAP_SCAN_CONFIG` 与 `DEFAULT_SCAN_CONFIG` 的全局合并（同 v0.5 Out of scope #8）

## v0.6 — Open-source 镜像卫生 + Resolve 路径自愈 + 日志落盘

**本迭代做：**
- `SyncService.ensureMirrorClean(repo)` 私有方法：对 `kind=open-source` 仓库 pull 前 `isClean()` 探测；脏态则 `git reset --hard origin/HEAD` 自愈 + `sync.mirror_reset` warn 日志 + `repo.mirror_reset` SSE；`kind=custom` 仓库 short-circuit 不自愈（见 A1）；`isClean()` 自身抛错原样冒泡不尝试 reset（P1-2）
- 插入点：`sync.ts` **2 处** `git.pull` 之前（`pullOne (sync.ts:177)` / `resolve (sync.ts:670)`）；**不插入** `pushOne (sync.ts:471)`（该路径只对 custom 仓库触达，dirty 是 push 流程合法中间态）；**不插入** `pullBatchUnderLock`（不直接调 pull，通过 `pullOne` 间接触达，由 `repoPulled` Set 去重）；**不改** `services/repo.ts::refresh (repo.ts:285)` 既有 skip+warn 语义
- `git.ts` 新增 `gitResetHard(localPath, ref)`；`SyncServiceDeps.gitImpl` 扩 `isClean?` / `resetHard?` optional（保持向后兼容，测试 double 不必改）
- 新 SSE 事件 `repo.mirror_reset`，payload `{ repo_id, repo_name, repo_kind: "open-source", reason: "dirty_working_tree" }`；`RepoMirrorResetPayloadSchema` Zod 定义在 `shared/schemas/events.ts`
- `BatchResolveResponseSchema` outcomes 元素扩 `error_code?` + `error_detail?` 两个 optional 字段（R3 原子：schema 扩 + `resolveBatch` 组装点同 PR）；前端 `ProjectDetailPage::onResolveAllConflicts` toast 展开首 3 条 `error_detail`
- `logger.ts::createLogger(minLevel, stream | stream[])` 扩签名为单 stream 或多 stream（向后兼容）；`daemon.ts::startDaemon` 移除外部 `logger` 参数、内部打开 `config.logFile` WritableStream 并构造 tee logger；`DaemonHandle` 新增 `logger` 字段；`handle.close()` 尾部 `logFileStream.end()`；`cli/commands/server.ts::runServerStart` 改用 `handle.logger`
- 按 5 个 PR 切分（PR1 自愈核心 + SSE schema 原子 / PR2 error_detail 穿透 R3 原子 / PR3 前端 toast / PR4 日志落盘（独立，可并行）/ PR5 文档 + retro 沉淀）
- 测试覆盖：5 个 ensureMirrorClean 用例（open-source 脏自愈 / custom 脏不自愈 / open-source clean no-op / resetHard 失败冒泡 / isClean 自身抛错冒泡）+ 1 pullOne batch `repoPulled` 去重 + 1 resolve-batch outcomes 带 error_code/error_detail + 1 daemon.log 含 daemon.started + 1 前端 toast 展开

**本迭代不做（延后到 v0.7+）：**
- CLI `astack mirror doctor` 主动健康检查所有镜像（价值次级）
- 把 pull / push 路径所有错误结构化到前端（仅 resolve-batch 的 outcomes 聚合层有此损耗，单条路径走 AstackError 已够用）
- daemon.log 轮转（logrotate / size-based rotation；保留策略单独讨论）
- 修改 `services/repo.ts::refresh` 现有的 "skip + warn" 语义（refresh 的语义对用户调试友好，不强制改自愈）
- Scanner / subscribe 路径加相同镜像护栏（它们不调 `git.pull`，不受脏态影响）
- 为 `resetHard` 行为开 safety switch（open-source 镜像 dirty 本身异常，不留 escape hatch）
- CLI `astack subscribe` / `astack sync` batch 失败展开错误（CLI 是 streaming，问题只在 Web toast 聚合层）
- Tee logger 加异步 queue / back-pressure（单用户本地日志，无需过度工程化）

## v0.5 — Subscription Bootstrap for Legacy Projects

**本迭代做：**
- `ProjectBootstrapService`：注册 legacy 项目时自动扫 `<project>/<primary_tool>/`，跟已注册 repo 的 skill 按 `(type, name)` pair 匹配
- 三元分类：`matched`（单 repo 唯一命中，自动订阅）/ `ambiguous`（多 repo 同名，UI 让用户选）/ `unmatched`（无 repo 提供，保持 pure local）
- `BOOTSTRAP_SCAN_CONFIG`：在 `DEFAULT_SCAN_CONFIG`（skills + commands）基础上叠加 `agents/` root，bootstrap 场景专用，**不改全局 DEFAULT_SCAN_CONFIG**
- `.astack.json` 扩展 `ignored_local: Array<{type, name, ignored_at?}>` 字段（带 default `[]`，向后兼容）；PR1 原子改动必须同时扩展 `rewriteManifest` 保留该字段
- 4 个 HTTP 端点：`GET /bootstrap`（纯读）/ `POST /bootstrap/scan`（扫+自动订阅 matched）/ `POST /bootstrap/resolve`（用户选择应用）/ `POST /bootstrap/ignore`（显式忽略）
- 统一 response shape：`ApplyResolutionsResult = {subscribed, ignored, failed, remaining_ambiguous}`；partial success 用 HTTP 200 + `failed[]` 结构化错误
- Subscriptions tab 新增 `BootstrapBanner` + `ResolveBootstrapDrawer`；`ProjectDetailPage` 独立 `useQuery(['bootstrap', projectId])`
- 2 个新 SSE 事件：`subscriptions.bootstrap_needs_resolution`、`subscriptions.bootstrap_resolved`（**不复用也不新增 `subscription.added`**，前端靠 bootstrap_* 事件 invalidate `['status']` + `['bootstrap']` 两个 query key）
- 订阅 `project.registered` 事件做 fire-and-forget 自动扫描 + auto-subscribe matched（失败不阻塞注册）
- A8 per-project 进程内 promise 锁（Map<projectId, Promise>）避免并发 scan 交错
- A9 LockManager 跨服务锁：`project-bootstrap-${projectId}` 由 bootstrap 的所有写入路径 + `SyncService.syncProject` 共同 acquire，防止 `reconcileFromManifest` 与 bootstrap 写入交错（PR2 搭便车修 1 行 `sync.ts`）
- `autoSubscribeMatched` / `applyResolutions` 强制 per-item try/catch（对齐 `subscribeBatch:287-313`），AstackError 归入 `failed[]`，非 AstackError 向上冒泡
- 复用 v0.4 A9 的 `systemSkillIds` 过滤：`harness-init` 等系统 skill 永远不进 bootstrap 任何分类
- E2E 覆盖：pure empty / all matched happy path / ambiguous → resolved / unmatched → ignored

**本迭代不做（延后到 v0.6+）：**
- 自动 sync bootstrap 后的订阅（覆盖本地 drift）—— 违背"不覆盖用户内容"原则
- 按内容 hash 匹配 / smart 匹配提示"内容 95% 相似"—— 命中率低 / 实现复杂
- Bootstrap 时自动建 `linked_dirs`（`.cursor` → `.claude` 等）—— 正交问题，LinkedDirsPanel 已有独立入口
- "重新匹配"已订阅的 skill（换 repo）—— 走现有 unsubscribe + subscribe 流程
- CLI `astack bootstrap scan/resolve/ignore` —— v0.6 跟其他 CLI 一致性补齐
- Team 协作 UI（多人对同一 ambiguous 的解决结果实时同步）—— 靠 git 提交 `.astack.json` 隐式同步
- Daemon 启动时 re-scan 所有项目的 bootstrap —— 注册 + 手动 Re-scan 两个触发点已足够
- 扩展 `SubscriptionState` 枚举新增 `imported` 等状态 —— 沿用现有状态
- 非 `.claude` primary_tool 的 bootstrap —— bootstrap handler 跳过，同 v0.4 A4
- 全局扩展 `DEFAULT_SCAN_CONFIG` 为三 root（让 repo scan 也覆盖 agents）—— 本迭代只做 bootstrap 场景专用 `BOOTSTRAP_SCAN_CONFIG`，避免扩大 blast radius
- Sidebar 项目列表上 pending ambiguous 的 badge —— UX 加分项，v0.6
- Settings tab 的 "Ignored local skills" 管理 UI（un-ignore）—— v0.6 补
- "Bootstrap baseline" 内容 hash 快照（诊断用）—— 价值有但非必须

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
