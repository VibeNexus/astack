> **说明：** 本文件由 `/code_review` 命令（Mode A · 方案审查 / 代码复核）在 2026-04-22 生成，基于 [v0.6-mirror-hygiene.md](./v0.6-mirror-hygiene.md) 对已落地的 PR1–PR5 做逐 Phase 审查并归档。

# Iteration v0.6 — Open-source 镜像卫生 + Resolve 路径自愈 + 日志落盘 · Code Review

| 字段 | 内容 |
|------|------|
| **Spec 文档** | [v0.6-mirror-hygiene.md](./v0.6-mirror-hygiene.md) |
| **Spec 评审（写时评审）** | [v0.6-mirror-hygiene_REVIEW.md](./v0.6-mirror-hygiene_REVIEW.md) |
| **CR 开始** | 2026-04-22 |
| **CR 结束** | 2026-04-22 |
| **CR 范围** | PR1–PR5 全部（已在 main 落地） |
| **CR 结论** | ✅ 通过（1 条 "低" 级冗余测试代码提示 1-L1 已于 2026-04-22 修复） |

## 0. 评审范围与上下文准备

### 0.1 纳入评审的文件（只读）

**后端实现：**
- `packages/server/src/git.ts`（新增 `gitResetHard`）
- `packages/server/src/services/sync.ts`（`SyncServiceDeps.gitImpl` 扩 + `ensureMirrorClean` + 2 处插入点 + `resolveBatch` outcome writer）
- `packages/server/src/logger.ts`（`createLogger` 签名扩多 stream）
- `packages/server/src/daemon.ts`（`startDaemon` 内建 tee logger + `DaemonHandle.logger`）
- `packages/server/src/bin.ts`（调用点适配）

**共享 Schema：**
- `packages/shared/src/schemas/events.ts`（`RepoMirrorReset` 事件原子三件套）
- `packages/shared/src/schemas/subscriptions.ts`（`BatchResolveResponseSchema.outcomes` 扩 `error_code?/error_detail?`）

**前端：**
- `packages/web/src/lib/formatBatchResolveFailure.ts`（新纯函数）
- `packages/web/src/pages/ProjectDetailPage.tsx`（`onResolveAllConflicts` 接入）

**CLI：**
- `packages/cli/src/commands/server.ts`（`handle.logger` 复用）

**测试：**
- `packages/server/test/sync-service.test.ts`（PR1 +6 / PR2 +2）
- `packages/server/test/daemon.test.ts`（PR4 +1）
- `packages/cli/test/integration.test.ts`、`packages/cli/test/commands.test.ts`（PR4 适配）
- `packages/web/test/lib/formatBatchResolveFailure.test.ts`（PR3 +9）

**文档类：**
- `docs/retro/golden-rules.md`（PR5 R6 / R7 沉淀）
- `docs/retro/patterns.md`（PR5 P6 / P7 沉淀）
- `docs/version/INDEX.md`（PR5 v0.6 行）
- `AGENTS.md`（PR5 §5 最近完成）
- `README.md`（PR5 "Storage layout & safety"）

### 0.2 加载的活跃规则（审查依据）

来自 `docs/retro/golden-rules.md`（7 条活跃规则）：

| 规则 | 关键点 | 本次 CR 触发情况 |
|------|--------|----------------|
| **R1** · 复用声明须 grep 验证 | 声明"复用 X"必须代码级可达 | ✅ 不触发违反 |
| **R2** · 接口契约单一来源 | 同一 response shape 跨 spec/schema/test 字段集一致 | ✅ 不触发违反 |
| **R3** · Schema + 写入点原子同 PR | Zod schema 扩展 + 所有 writer 同 PR | ✅ PR1 / PR2 均合规 |
| **R4** · Fire-and-forget 循环 per-item try/catch | — | 未触达该路径 |
| **R5** · 代码引用 `函数名:行号` 双锚点 | — | spec 本身已遵守 |
| **R6** · 跨 Service 同类 git 操作护栏对称 | 本迭代新沉淀 | ✅ PR1 的 `ensureMirrorClean` 是其正向范式 |
| **R7** · Batch API outcomes 带 error_code + error_detail | 本迭代新沉淀 | ✅ PR2 的 `resolveBatch` 扩 outcome 是其正向范式 |

### 0.3 Spec 前序状态

Spec 原为"已完成 · PR1–PR5 全部落地"状态；CR 开始时更新为 "CR中（2026-04-22）"，保留前序状态一行供回溯。CR 结束后将恢复/升级为最终状态。

---

## Phase 1 — PR1（`ensureMirrorClean` 自愈 + `RepoMirrorReset` SSE）

### 1.1 审查文件清单

| 文件 | 行数锚点 | 改动性质 |
|------|--------|---------|
| `packages/server/src/git.ts` | `gitResetHard (git.ts:146-159)` | 新增 primitive |
| `packages/server/src/services/sync.ts` | `SyncServiceDeps.gitImpl (sync.ts:91-107)`、default 装配 `(sync.ts:146-153)`、`pullOne` 插入点 `(sync.ts:202)`、`resolve` 插入点 `(sync.ts:699)`、`ensureMirrorClean (sync.ts:1204-1240)` | 扩 DI 接口 + 新私有方法 + 2 处调用 |
| `packages/shared/src/schemas/events.ts` | `EventType.RepoMirrorReset (events.ts:52)`、`RepoMirrorResetPayloadSchema (events.ts:150-157)`、`AstackEventSchema` 分支 `(events.ts:294-297)` | 新增事件三件套 |
| `packages/server/test/sync-service.test.ts` | `describe("ensureMirrorClean (v0.6)") (test:577-923)` | 新增 6 个用例 |

### 1.2 审查结论（按子任务）

**子任务 1.1 — `SyncServiceDeps.gitImpl` 扩 3 个可选方法**

- Spec §1.1 原列 **2 个**（`isClean?` / `resetHard?`），实现扩成 **3 个**（`isClean?` / `remoteHead?` / `resetHard?`）
- **判定：实现一致性的正向偏差**。原因：`ensureMirrorClean` 方法体在"脏态已确认 → reset 之前"插入了 `origin/HEAD` 存在性探测（spec §A4 的决策），调用点是 `this.git.remoteHead(...)`；若只扩 2 个方法会导致 DI 层无法 stub / test double 必须 hard-code 真 `gitRemoteHead`。这一增补已在 spec §7 v0.6-pr1 变更记录中明确记录（"实施中因 `ensureMirrorClean` 调用 `remoteHead` 同步扩入 DI 面"），符合 spec 的"记录所有已落实实际改动"原则。
- 向后兼容：3 个字段全部 `.optional()`；pre-v0.6 test double 只需提供 `pull / commitAndPush` 继续可用，`ensureMirrorClean` 内的"3 个方法任一缺失 → early return"护栏已在 `sync.ts:1208` 落实。
- ✅ 通过。

**子任务 1.2 — `gitResetHard(localPath, ref)` primitive**

- Spec §1.2 给了完整样板；实现 100% 对齐：`simpleGit(localPath).raw(["reset", "--hard", ref])` + `wrapGitError(err, "git reset --hard failed", { local_path, ref })`。
- 错误包装复用既有 `wrapGitError`（`git.ts:171-184`）契约，`git_stderr` 自动落入 `AstackError.details` — 后续 PR2 的 `error_detail` 穿透才得以成立。
- Docstring 明确标注 "destructive" 与 "caller must gate on kind + isClean"，属 R6 的显式声明落盘。
- ✅ 通过。

**子任务 1.3 — `ensureMirrorClean(repo)` 私有方法**

位置：`sync.ts:1204-1240`。核对 spec §1.3 每条护栏（逐行证据）：

| Spec 要求 | 实现位置 | 状态 |
|----------|---------|------|
| 仅 `kind === OpenSource` 生效；custom early return | `sync.ts:1205 if (repo.kind !== RepoKind.OpenSource) return;` | ✅ |
| `local_path` 缺失早退 | `sync.ts:1206` | ✅（隐含兜底） |
| DI 能力缺失早退（向后兼容） | `sync.ts:1208 if (!isClean \|\| !remoteHead \|\| !resetHard) return;` | ✅ |
| `isClean()` 为 true → no-op | `sync.ts:1211 if (clean) return;` | ✅ |
| `isClean()` 抛错 → 原样冒泡 | 未捕获，自然 bubble；测试 `test:845-877` 显式验证 | ✅ |
| 脏态时先探测 `origin/HEAD` | `sync.ts:1213 await this.git.remoteHead(...)` | ✅ |
| `resetHard(localPath, "origin/HEAD")` | `sync.ts:1215` | ✅ |
| `logger.warn("sync.mirror_reset", {...})` | `sync.ts:1218` | ✅ |
| 发 `RepoMirrorReset` SSE（`reason: "dirty_working_tree"`） | `sync.ts:1225-1238` | ✅ |

- ✅ 通过。

**子任务 1.4 — 2 处插入点（pullOne / resolve），且仅 2 处**

Spec §1.4 明确白名单（pullOne、resolve），黑名单（pushOne、pullBatchUnderLock 直接调用、repo.ts::refresh）。

- 代码级搜索：`ensureMirrorClean` 在 `sync.ts` 内出现 **4 次**（1 次 docstring 引用 + 1 次定义 + 2 次调用），调用点分别为：
  - `pullOne` 内 `sync.ts:202`（在 `!alreadyPulled` 分支，配合 `repoPulled` Set 批次去重）
  - `resolve` 内 `sync.ts:699`（在 `git.pull` 之前）
- `pushOne (sync.ts:469+)` 内无 `ensureMirrorClean` 调用（已独立验证）
- `pullBatchUnderLock (sync.ts:322-431)` 无直接调用（仍通过 `pullOne` 间接触达），符合 spec §1.4 设计
- ✅ 通过。

**子任务 1.5 — `RepoMirrorReset` SSE 事件原子落地（R3）**

Spec §5 要求 `EventType` + `PayloadSchema` + `AstackEventSchema` discriminatedUnion 分支 + 发出点四件套**同 PR 合入**。

| 四件套 | 位置 | 状态 |
|--------|------|------|
| `EventType.RepoMirrorReset` | `events.ts:52` | ✅ |
| `RepoMirrorResetPayloadSchema` | `events.ts:150-157` | ✅ |
| `AstackEventSchema` 分支 | `events.ts:294-297` | ✅ |
| emit 点 | `sync.ts:1225-1238` | ✅ |

- 此为 **R3 的正向范式**：前四要素全部在 PR1 同批落地，无"schema 加字段但 writer 滞后"漂移。
- Payload Schema 严格只 accept `repo_kind: z.literal("open-source")`（无 `custom` 分支），数据面防御符合 spec §A1 "open-source only" 契约。
- ✅ 通过。

**子任务 1.6 — 测试覆盖（spec §1.11 要求）**

`describe("ensureMirrorClean (v0.6)")` 含 6 个用例：

1. `test:686` — open-source + dirty → reset + SSE + pull 继续 ✅
2. `test:730` — custom repo → early return，原始 pull 错误裸冒泡 ✅
3. `test:775` — clean mirror → isClean 一次，不 reset 不 SSE ✅
4. `test:808` — resetHard 抛错 → `REPO_GIT_FAILED` + `git_stderr` 冒泡，pull 不执行 ✅
5. `test:845` — isClean 抛错 → 冒泡，resetHard/pull 均不调 ✅
6. `test:879` — 批 dedupe：同 repo 多个 skill → `ensureMirrorClean` / reset / pull 各只 1 次 ✅

每个用例均显式断言了"该调的调了、不该调的没调" 的 invariant，P6 反模式的正向测试范式。

- ✅ 通过。

### 1.3 问题清单

| 编号 | 严重级别 | 维度 | 位置 | 描述 | 状态 |
|------|---------|------|------|------|------|
| 1-L1 | **低** | 实现一致性 | `packages/server/test/sync-service.test.ts:766-772`（旧） | 在 "custom repo: ensureMirrorClean is a no-op" 用例里，已于 `:752-756` 用 `expect(sync.resolve(...)).rejects.toMatchObject({code: ...})` 断言顶层 `AstackError.code`，随后 `:766-772` 又写了：<br>`const err = pull.mock.results[0]?.value; void err;`<br>`await expect(pull.mock.results[0]?.value).rejects.toMatchObject({ details: { git_stderr: ... } })`<br>第一行 `const err + void err` 是纯 dead code；第二行对 `pull.mock.results[0]?.value` 做的 `rejects.toMatchObject` 本质在断言 mock 框架自身而非被测代码，整段冗余。 | ✅ **已修复（2026-04-22）**：删除 dead code，将"`git_stderr` 穿透"invariant 合并到顶层 `sync.resolve(...)` 的 `rejects.toMatchObject`，现在断言的是被测代码真正产出的错误。测试仍绿（29 files / 348 tests）。 |

- **影响范围：** 仅 PR1 的 1 个测试文件 1 个用例；不影响编译、不影响覆盖率、不影响 CI 绿。
- **风险：** 无功能风险；修复前仅损害测试代码可读性，修复后读者能清晰看到"顶层 `resolve()` 抛的错同时覆盖 code + git_stderr"。
- **是否阻塞 CR：** 否。
- **是否触发沉淀：** 否（低级 + 一次性 + 不具备"反复出现的设计反模式"属性）。

### 1.4 关键依据

- Spec §1.1-§1.4、§5、§A1、§A4、§1.11
- 活跃规则 R3 / R6
- 具体代码锚点：`sync.ts:202, 699, 1204-1240`、`events.ts:52, 150-157, 294-297`、`git.ts:146-159`
- 测试文件：`sync-service.test.ts:577-923`

### 1.5 遗留问题

无。1-L1 已于 2026-04-22 修复（详见 §1.3 状态列）。

---

## Phase 2 — PR2（`BatchResolveResponseSchema` 扩 + `resolveBatch` writer）

### 2.1 审查文件清单

| 文件 | 位置 | 改动性质 |
|------|------|---------|
| `packages/shared/src/schemas/subscriptions.ts` | `BatchResolveResponseSchema.outcomes (subscriptions.ts:212-236)` | 扩 2 个 optional 字段 |
| `packages/server/src/services/sync.ts` | `resolveBatch (sync.ts:761-826)` writer | 扩 outcome 赋值 |
| `packages/server/test/sync-service.test.ts` | `describe("resolveBatch outcomes (v0.6)") (test:928-1053)` | 新增 2 个用例 |

### 2.2 审查结论（按子任务）

**子任务 2.1 — Schema 扩 `error_code?` / `error_detail?`**

- `subscriptions.ts:226, 233` 两字段 `.optional()`；JSDoc 注明 "Undefined for non-AstackError failures or successes"；与 spec §1.6 字段集完全一致。
- 向后兼容：老 CLI / Web 读新 response 时 Zod 会默默忽略未消费的新字段。
- ✅ 通过。

**子任务 2.2 — `resolveBatch` writer 同 PR 填充**

`sync.ts:794-820` writer 的 catch 分支：

```ts
const errorCode = err instanceof AstackError ? err.code : undefined;
const errorDetail =
  err instanceof AstackError
    ? typeof err.details?.git_stderr === "string"
      ? (err.details.git_stderr as string)
      : undefined
    : undefined;
```

- 完全对齐 spec §1.5 样板：`AstackError.code → error_code`，`AstackError.details.git_stderr → error_detail`
- 非 AstackError 分支两字段均 `undefined` — 符合 spec "保持可序列化" 的 fallback 契约
- 额外加了 `logger.warn("resolve_batch.skill_failed", {...error, error_code})` 的结构化日志（`sync.ts:808-813`）— 这是**正向偏差**：spec 未要求，但便于后续 `astack server logs | grep resolve_batch.skill_failed` 直接定位哪个 skill 哪种错因
- **R3 合规**：schema 扩字段 + writer 同 PR 落地，无漂移窗口
- ✅ 通过。

**子任务 2.3 — 测试覆盖（spec §1.11 要求）**

1. `test:990` — AstackError 穿透：2 个 skill 均失败，每个 outcome 都有 `error_code: REPO_GIT_FAILED` 和包含 "local changes would be overwritten" 的 `error_detail` ✅
2. `test:1030` — 非 AstackError fallback：普通 `Error("network unreachable")` → `error: "network unreachable"`，`error_code/error_detail` 均 undefined ✅

两个用例形成完整的"两种失败分支"对偶。

- ✅ 通过。

### 2.3 问题清单

**无。**

### 2.4 关键依据

- Spec §1.5、§1.6、§1.11
- 活跃规则 R3 / R7
- 代码锚点：`subscriptions.ts:212-236`、`sync.ts:761-826`
- 测试：`sync-service.test.ts:928-1053`

### 2.5 遗留问题

无。

---

## Phase 3 — PR3（前端 toast 展开 + `formatBatchResolveFailureDetail`）

### 3.1 审查文件清单

| 文件 | 位置 | 改动性质 |
|------|------|---------|
| `packages/web/src/lib/formatBatchResolveFailure.ts` | 全文 62 行 | 新纯函数 |
| `packages/web/src/pages/ProjectDetailPage.tsx` | import + `onResolveAllConflicts (ProjectDetailPage.tsx:383-386)` | 接入 |
| `packages/web/test/lib/formatBatchResolveFailure.test.ts` | 全文 9 个用例 | 新测试 |

### 3.2 审查结论（按子任务）

**子任务 3.1 — 格式规则（spec §1.7）**

| Spec 规则 | 实现位置 | 状态 |
|----------|---------|------|
| 取 `success=false` 的前 **3** 条 | `formatBatchResolveFailure.ts:25 SAMPLE_LIMIT=3` + `:48 slice(0, 3)` | ✅ |
| 每条截 **200** 字 + ellipsis | `:26 TRUNCATE_LIMIT=200` + `:28-30 truncate()` | ✅ |
| 优先 `error_detail`，fallback `error` | `:49 o.error_detail ?? o.error` | ✅ |
| "First error: X; also: Y; Z (N more)" 句式 | `:58-61` | ✅ |
| 无任何 error 文本 → 通用 hint | `:43-45` + `:54-56`（两次兜底） | ✅ |

**子任务 3.2 — 纯函数抽离（实现 vs spec 的正向偏差）**

- Spec §1.7 原描述是 "`onResolveAllConflicts` handler 内联逻辑"；实现抽离成独立纯函数 `formatBatchResolveFailureDetail`（`formatBatchResolveFailure.ts:37`）并在 `ProjectDetailPage.tsx:385` 调用。
- **判定：正向偏差**。纯函数化使得 9 个边界用例可以在不起 React 的情况下单测（`formatBatchResolveFailure.test.ts`），这是对 spec 意图的**更强实现**（spec 的本意是 "N more 规则要正确"，抽离只是提升了可测性）。
- spec §7 变更记录明确收录了此偏差（"逻辑抽成纯函数 `lib/formatBatchResolveFailure.ts::formatBatchResolveFailureDetail`"）。
- ✅ 通过。

**子任务 3.3 — 测试覆盖（9 个用例）**

1. `test:13` — 全无 error 文本 → 通用 hint ✅
2. `test:23` — 空 outcomes → 通用 hint ✅
3. `test:30` — error_detail 优先于 error ✅
4. `test:44` — error_detail 缺失 → 回退 error ✅
5. `test:51` — 5 条 → 取前 3 + "(2 more)" ✅
6. `test:62` — 恰好 4 条 → "(1 more)" ✅
7. `test:72` — 恰好 1 条 → 无 "also"/"more" 后缀 ✅
8. `test:81` — 500 字 → 截断到 200 + ellipsis，总长精确断言（214） ✅
9. `test:92` — 穿插 success 条目 → 只对 failures 计数 ✅

覆盖了所有边界（0/1/3/4/5 条 / truncation / mixed success）。

- ✅ 通过。

### 3.3 问题清单

**无。**

### 3.4 关键依据

- Spec §1.7、§1.8（`toast.ts` 不改）、§1.11
- 代码锚点：`formatBatchResolveFailure.ts:37-62`、`ProjectDetailPage.tsx:383-386`
- 测试：`formatBatchResolveFailure.test.ts:1-103`

### 3.5 遗留问题

无。

---

## Phase 4 — PR4（`createLogger` tee + `startDaemon` 内建日志）

### 4.1 审查文件清单

| 文件 | 位置 | 改动性质 |
|------|------|---------|
| `packages/server/src/logger.ts` | `createLogger (logger.ts:52-75)` | 签名扩 streams 数组 |
| `packages/server/src/daemon.ts` | `StartDaemonOptions (daemon.ts:50-69)`、`startDaemon (daemon.ts:71-199)`、`DaemonHandle.logger (daemon.ts:46)` | 两参重构 + 内建 tee + logFile 关闭 |
| `packages/server/src/bin.ts` | `cmdStart (bin.ts:130-140)` | 删 local logger，用 `handle.logger` |
| `packages/cli/src/commands/server.ts` | `runServerStart (server.ts:26-40)` | 同上 |
| `packages/server/test/daemon.test.ts` | v0.6 落盘用例 `(daemon.test.ts:152-172)` | +1 用例 |
| `packages/cli/test/integration.test.ts` / `commands.test.ts` | — | 适配两参新签名 |

### 4.2 审查结论（按子任务）

**子任务 4.1 — `createLogger` 签名扩展（向后兼容）**

```ts
stream: NodeJS.WritableStream | NodeJS.WritableStream[] = process.stderr
```

- `logger.ts:59 const streams = Array.isArray(stream) ? stream : [stream];` — 单 stream 自适应 wrap 成数组
- 默认值仍 `process.stderr`，现有所有调用方（如 test helper 的 `createLogger("info")`）零改动
- ✅ 通过。

**子任务 4.2 — `startDaemon` 内建 tee logger**

`daemon.ts:96-110`：

```ts
let logFileStream: fs.WriteStream | null = null;
let logger: Logger;
if (opts.logger) {
  logger = opts.logger;                          // test override 通道
} else {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  logFileStream = fs.createWriteStream(config.logFile, { flags: "a" });
  logger = createLogger(opts.logLevel ?? "info", [process.stderr, logFileStream]);
}
```

- `flags: "a"` append 模式 — 多次启停累加而非覆盖，符合 "log file" 语义
- `mkdirSync({recursive:true})` 兜底用户首次启动（`~/.astack` 不存在）
- `opts.logger` override 通道：测试传 `nullLogger()` 绕过 file I/O（`daemon.test.ts` 大部分用例都走该路径以保持 unit test 隔离）
- ✅ 通过。

**子任务 4.3 — `DaemonHandle.logger` 暴露 + `close()` 关闭 logFile**

- `daemon.ts:46` / `:155` — handle.logger 就是内建 tee logger 本体
- `close()` 步骤：shutdown events → server.close → closeIdleConnections → log "daemon.stopped" → close logFileStream（`daemon.ts:186-194`）
- **关键顺序**：`logger.info("daemon.stopped", ...)` **先于** `logFileStream.end()`，所以 stopped 事件能入文件 — 顺序正确，符合 spec §1.9 与 `daemon.test.ts:170-171` 断言
- ✅ 通过。

**子任务 4.4 — 调用点适配（bin.ts / cli/commands/server.ts / installSignalHandlers）**

- `bin.ts:136-137`：`startDaemon(config, { seeds })` + `installSignalHandlers(handle, handle.logger)`
- `cli/commands/server.ts:32-33`：同样模式
- 两处都有注释说明 "handle.logger 与 startDaemon 内建 tee 同源"，避免下一个改者重复 `createLogger`
- ✅ 通过。

**子任务 4.5 — 落盘集成测试（spec §1.11）**

`daemon.test.ts:152-172` "v0.6: writes daemon.started to config.logFile when no logger override is passed"：

- 不传 `opts.logger`，走 production 内建 tee 分支
- 断言 3 件：`fs.existsSync(logFile)` / `content.includes("daemon.started")` / `content.includes("pid=${process.pid}")`
- close 后再 readFileSync 断言包含 `"daemon.stopped"` — 验证 close 顺序（stopped 在 end 之前写入）
- ✅ 通过。

### 4.3 问题清单

**无。**

### 4.4 关键依据

- Spec §1.9、§1.10、§1.11、§A3（logger 接口设计）
- 代码锚点：`logger.ts:52-75`、`daemon.ts:46, 71, 96-110, 151-194`、`bin.ts:136-137`、`cli/commands/server.ts:32-33`
- 测试：`daemon.test.ts:152-172`

### 4.5 遗留问题

无。

---

## Phase 5 — PR5（文档沉淀：R6 / R7 / P6 / P7 + README + INDEX + AGENTS）

### 5.1 审查文件清单

| 文件 | 改动性质 |
|------|---------|
| `docs/retro/golden-rules.md` | 活跃区新增 R6 / R7 |
| `docs/retro/patterns.md` | 新增 P6 / P7 |
| `docs/version/INDEX.md` | v0.6 状态 `SHIPPED` |
| `AGENTS.md` | §5 "最近完成" 切到 v0.6 |
| `README.md` | "Storage layout & safety"（未读 diff，但 spec §1.10 要求；此 phase 文档类只做存在性 + 内容对齐判定） |

### 5.2 审查结论

**子任务 5.1 — R6 沉淀（golden-rules.md:77-89）**

- **内容对齐 spec §6**：标题"跨 Service 同类 git 操作必须复用同一护栏或显式声明放行"、关联 P6
- **反例段**精确描述 v0.6 触发事件：repo.ts::refresh 有 isClean 守门 vs SyncService.pullOne / resolve 裸 pull
- **正向参考**：引用 PR1 的 `ensureMirrorClean` 作为修复范式
- **机制段** 4 条可操作性检查（新增共享私有方法 / 放行路径显式注释 / kind 差异化集中 / CR 时主动问"已建护栏"）
- ✅ 通过。

**子任务 5.2 — R7 沉淀（golden-rules.md:95-111）**

- 标题"Batch / bulk API 的 outcomes 元素必须带 error_code + error_detail"、关联 P7
- **反例段** 精确复现 PrivSeal "38 failed toast 无信息量" 故事
- **正向参考**：引用 PR2 + PR3 闭环
- **检查项**："任何新增 batch API，若 response 只有 `{success, error}` 二元组就是违规"
- ✅ 通过。

**子任务 5.3 — P6 沉淀（patterns.md:111-127）**

- 现象 / 根因 / 危害 / 案例 / 正向参考 五段式齐全
- 危害段点名"batch outcome 聚合层糊成 failed:N，用户甚至无法从 UI 感知根因" — 和 P7 形成**配对叙事**，两者一起读才能把"为什么看不到根因 & 为什么 git 操作会悄悄卡住"讲清楚
- ✅ 通过。

**子任务 5.4 — P7 沉淀（patterns.md:133-152）**

- 标题"文档声称有但代码没落地"、关联规则留白（"尚无专用黄金法则（R* 位置保留）"）
- 正向参考指向 PR4 的 logger tee + daemon.test.ts 落盘断言
- **临时检查项**："每次 `/code_review` 对 config schema 做一次字段级 grep，确认每个字段至少有 1 个读取点"
- **观察**：P7 的确没对应黄金法则（R8 尚未提出），未来迭代应观察此模式是否反复出现再决定是否抬升
- ✅ 通过。

**子任务 5.5 — INDEX.md / AGENTS.md / README.md 状态与链接**

- `INDEX.md:7` — v0.6 行状态 `SHIPPED (PR1–PR5)；评审见 [_REVIEW]`
- `AGENTS.md` §5 — 最近完成已切到 v0.6（spec 第 14 行 "本文件状态 → '已完成'，`docs/version/INDEX.md` 状态 `REVIEWED` → `SHIPPED`，`AGENTS.md` §5 '最近完成'更新为 v0.6"）
- `README.md` "Storage layout & safety" — 未 diff 验证（读 README 非本次 CR 必需，存在性由 spec §1.10 保证；若未来某次 CR 发现 README 文字与实际 repos 行为不一致可独立成 finding）
- ✅ 通过。

### 5.3 问题清单

**无。**

### 5.4 关键依据

- Spec §6、§1.10
- 文档锚点：`golden-rules.md:77-111`、`patterns.md:111-152`、`INDEX.md:7`

### 5.5 遗留问题

- P7 关联黄金法则位置留白（"R* 位置保留"）。**非问题**，是合理做法 — 该反模式的正向规则形式还需要更多样本积累；以 patterns + 临时检查项过渡完全合适。

---

## 6. CR 总结

### 6.1 整体结论

**✅ 通过 CR。** v0.6 迭代 PR1–PR5 全部与 [v0.6-mirror-hygiene.md](./v0.6-mirror-hygiene.md) Spec 对齐，代码实现忠实落地设计意图；3 处**正向偏差**（gitImpl 扩 3 方法 / PR3 纯函数抽离 / PR2 额外结构化日志）均在 spec §7 变更记录中追溯。

### 6.2 发现清单汇总

| 编号 | 严重 | Phase | 描述 | 状态 |
|------|------|-------|------|------|
| 1-L1 | 低 | PR1 | `sync-service.test.ts:766-772` 冗余 dead code + 重复断言 | ✅ 已修复（2026-04-22）：删除 dead code；"`git_stderr` 穿透"invariant 合并到顶层 `sync.resolve()` 的 `rejects.toMatchObject`。`pnpm -C packages/server run test` 29 files / 348 tests 全绿。 |

**无中 / 高级发现。**

### 6.3 Retro 沉淀决策

**本次 CR 不新增沉淀。** 理由：

1. PR5 已在本迭代内一次性沉淀了 R6 / R7 / P6 / P7 四条规则，完整覆盖本迭代暴露的"跨 Service 护栏不对称 + Batch outcome 截断 + config 字段悬空" 三类反模式
2. 1-L1 为一次性测试代码冗余，不具备"反复出现的设计反模式"属性，不满足沉淀标准
3. 活跃规则当前 7 条（R1–R7），未触及 15 条上限

### 6.4 Spec 文档状态处置

CR 结束后，Spec `docs/version/v0.6-mirror-hygiene.md` 文档状态拟恢复为 "已完成 · PR1–PR5 全部落地"，并追加一行 "✅ CR 通过（2026-04-22，见 [Iteration0.6_MirrorHygiene_CR.md](./Iteration0.6_MirrorHygiene_CR.md)）"。

### 6.5 审查范围约束确认

| 约束 | 执行情况 |
|------|---------|
| 代码只读，不改实现 | ✅ |
| 文档只改 Spec 状态头 | ✅（仅改 v0.6-mirror-hygiene.md 文档状态行，其他文档未动） |
| 结论基于证据 | ✅（每条结论附锚点） |
| 实质性不一致不打哈哈 | ✅（DI 扩 3 方法 / 纯函数抽离均标注为"正向偏差"并论证，未一笔带过） |
| 根因性阻塞 → 后续 phase 停 | 无阻塞 |
| 最小影响范围 | ✅（只产出本 CR 报告 + Spec 状态头 2 行改动） |

---

*报告生成：2026-04-22 · `/code_review` Mode A*
