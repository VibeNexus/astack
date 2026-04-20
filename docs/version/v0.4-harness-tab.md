# v0.4 — Harness Tab + 系统级 Skill 首次落地

> 工程评审 Spec（/plan-eng-review 产出 → 需求调整 revise v2）
> 创建于 2026-04-20，分支 main
> 状态：评审进行中（v2）

## 0. 迭代缘起

v0.3 把 Web 升级成了"完整管理界面"，但订阅只能来自**用户注册的 git repo**。这套流程有两个缺口：

1. **新项目 bootstrap 有鸡生蛋的门槛**。`astack subscribe <skill>` 之前，项目得先有 `.claude/` 目录 + 治理文档骨架（`AGENTS.md`、`docs/version/INDEX.md` 等）。用户当前只能去终端运行独立脚本，操作链条长。
2. **astack 自己的治理规范（Harness）是一套代码里已存在的系统级 skill**（`scripts/harness-init/`），但 Web 看不到它、订阅模型装不下它 —— 它不是来自"注册 repo"，而是 astack 自带的。

v0.4 解决这两个缺口：

- 引入一类**系统 skill**（system skill），astack 代码自带，不走 repo 扫描路径
- 项目详情页加 **Harness tab**，显示当前项目的 harness skill 安装状态 + 一键重装
- 注册项目时自动把 harness-init seed 到 `<project>/.claude/skills/harness-init/`
- **内置版本即真相源**：项目本地的 seed 目录不允许修改；被修改时 UI 诚实告知"drift"；用户点 "Re-install" 或重新注册项目时被内置版本覆盖

### v2 相对 v1 的变更

（v1 → v2，基于用户决策"harness 系统级 skill 不做自动删除、不做自动同步"）

| 删除 | 原 v1 语义 |
|---|---|
| 自动清理已初始化项目的 seed 目录 | 检测 `AGENTS.md + INDEX.md` 存在就 `rm -rf` seed |
| "hash mismatch 不清理" 护栏 | 已无必要（不会自动清理） |
| `installed_external` 状态 | "项目已手工初始化、未 seed" 这个概念合并进 `installed`（有 seed 目录就是 installed） |
| `seeded_missing / seeded_orphan` 状态 | 简化：目录不见就 `missing`，目录存在就看 hash |
| 60s reconcile 节流 + `sync.completed` 触发 | Tab 打开 = 纯 read，不再带写副作用 |

| 新增 | 目的 |
|---|---|
| "drift" 状态 + UI 告知"will be overwritten" | 用户改过 seed 目录的诚实提示 |
| "Re-install" 按钮 = 强制覆盖 | 给用户唯一的写触发点 |
| Scanner 过滤重名 repo skill + SymlinkService 兜底（A9） | 防止用户导入 repo 的同名 skill 污染系统 skill 命名空间 |

| 保留 | 说明 |
|---|---|
| 注册时 fire-and-forget seed | 语义不变，仍是主要写触发点 |
| `.astack/system-skills.json` 存根 | 保留，用于记录"上次 seed 的内置版本 hash"（未来 v0.5 升级检测用） |
| SSE `harness.changed` | 保留，但只在注册 / install 真触发变化时发 |

## 1. 本次迭代的边界

### In scope（本迭代做）

**后端 — 新的 SystemSkill 抽象**

1. `packages/shared/src/domain.ts`：新增 `SystemSkill`（独立于 `Skill` —— 它不来自 repo）+ `HarnessStatus` enum
2. `packages/server/src/services/system-skill.ts`：新服务，负责
   - 启动时枚举所有内置系统 skill（v0.4 只有 `harness-init`）并预计算目录 hash
   - `seed(projectId)` —— 把内置 skill 目录**覆盖写**到 `<project>/.claude/skills/<name>/`（非幂等意义上的"有就跳过"，是"有也重写"）
   - `seedIfMissing(projectId)` —— 只在目录完全不存在时 seed（注册路径用；已有任何内容时跳过，避免给已治理项目做破坏性覆盖 —— 这是唯一一次"保留用户现状"的地方）
   - `inspect(projectId)` —— 纯读：返回当前 status（installed / drift / missing / seed_failed）
   - 写 / 读存根 `.astack/system-skills.json`
3. `packages/server/src/http/routes.projects.ts`：新增 2 个端点
   - `GET /api/projects/:id/harness` —— 纯 inspect，返回当前状态，**不写**
   - `POST /api/projects/:id/harness/install` —— 调用 `seed(projectId)` 强制覆盖
4. `ProjectService.register`：注册成功后通过**事件订阅**触发 `SystemSkillService.seedIfMissing(projectId)`（fire-and-forget，失败不阻塞注册，见 A4）

**后端 — 系统 skill 源文件打包**

5. 搬运 `scripts/harness-init/` → `packages/server/system-skills/harness-init/`
6. `packages/server/package.json` 加 `"files": ["dist", "system-skills"]`，保证 npm publish 带上
7. `packages/server/src/system-skills/paths.ts`：`systemSkillsRoot()` 复用 `http/app.ts:locateDashboard()` 的 `createRequire + package resolve + dev fallback` 三段式模式
8. Scanner 不扫系统 skills 目录（避免把 harness-init 当成 repo skill 暴露到订阅流）
9. **Scanner 过滤重名的 repo skill**：`scanRepo` 新增可选参数 `systemSkillIds: Set<string>`；返回 skills 前把 `id ∈ systemSkillIds` 的条目剔除 + 加入 `warnings[]`；`RepoService.scanAndUpsert` 从 `SystemSkillService.list()` 拉取 id 列表注入（见 A9）

**前端**

9. `packages/web/src/components/project/HarnessPanel.tsx`：Harness tab 内容
10. `packages/web/src/pages/ProjectDetailPage.tsx`：加第 5 个 tab `Harness`
11. `packages/web/src/lib/api.ts`：加 `api.inspectHarness(projectId)` / `api.installHarness(projectId)`

**SSE**

12. 新事件类型 `harness.changed { project_id, status }` —— 在 `seed` / `seedIfMissing` 真改动 fs 时广播；pure inspect 绝不广播

**测试**

13. SystemSkillService 单测 ≥ 10 case（见 PR2 详单）
14. HTTP 端点测试 ≥ 5 case
15. HarnessPanel 单测 ≥ 5
16. E2E ≥ 3 scenario（注册 → installed、手动改 seed → drift → Re-install → installed、已治理项目注册 → installed）

### Out of scope（明确延后）

| 项 | 理由 |
|---|---|
| 一键在 Web 上运行 `init-harness.sh` | 需要后端执行 shell，安全边界单独设计；v0.5 |
| 多系统 skill 的市场 / 管理 UI | v0.4 只 1 个系统 skill |
| 版本升级检测（内置版本升级后提示项目 Re-install）| 存根已存 hash，v0.5 加 "built-in version updated, Re-install to sync" 提示 |
| Daemon 启动时扫描全部项目覆盖 drift | 简化起见不做；用户打开 Harness tab 会看到 drift 状态，点 Re-install 覆盖。v0.5 可加后台扫 |
| CLI `astack harness status/install` | 首版只 Web；v0.5 补 CLI 一致性 |
| 非 `.claude` primary_tool 的 harness-init 适配 | `init-harness.sh` 硬编码 `.claude`；primary_tool 定制时跳过 seed（UI 提示）|
| Dialog primitive 抽象（v0.4 review Issue 8）| 挂 T8 待 v0.5 |
| 系统 skill 支持 symlink / 嵌套 skill | 当前 harness-init 是纯文件目录，无此需求 |

### 已知情接受的风险

1. **"覆盖用户修改"有数据丢失风险**：用户明确要求"原则上永远以内置版本为主，不允许项目修改"，所以覆盖是预期行为。缓解：UI 在 drift 状态下明示"will be overwritten on next Re-install"，给用户 advance warning；不提供 "keep local" 选项（违背该原则）。
2. **注册后自动 seed = 文件系统副作用**：跟 v0.3 之前的"astack 不动 FS"承诺有冲突。缓解：仅 `seedIfMissing` 路径会自动写，且只在目标目录完全不存在时；已有目录（哪怕 1 byte 内容）就跳过。
3. **系统 skill 资源路径在 pnpm workspace / npm global install 下要都能定位**：复用 `locateDashboard` 的 `createRequire` 模式（A8）。
4. **Seed 存根文件 `.astack/system-skills.json` 在 .gitignore 之外**：建议项目加到 .gitignore，文档提示但不强制。commit 也 OK（元数据无敏感信息）。

## 2. 架构决策

### A1 · SystemSkill 与 Skill 完全分离

**决策：不复用 `subscriptions` 表，新增独立机制。**

候选方案：
- **A（采纳）**：SystemSkill 是独立概念；无 DB 表，代码里是 registry 常量；项目侧用 `.astack/system-skills.json` 存根
- B：复用 `skills` + `subscriptions`，给 `repo_id` 留特殊值（如 `-1` 表示"系统 repo"）
- C：给每个系统 skill 跑一次假 repo 注册流程

**选 A 的原因：**
- `skills` 表假设行来自 `scanRepo(local_path)`，记录 `repo_id`、`path`、`version`（git commit hash）—— 系统 skill 没有 repo，强塞这些字段语义膨胀
- `subscriptions` 的 subscribe / unsubscribe / pinned_version / sync / push 动词对系统 skill 全无意义
- 订阅列表 UI 绝不能出现 harness-init（它是 bootstrap 基础设施）
- 未来系统 skill 的语义可能继续分化 —— 独立抽象不绑死

### A2 · 状态机简化为 4 态

v1 的 7 态状态机（installed / installed_external / seeded / seeded_missing / seeded_orphan / not_seeded / seed_failed）包含了"项目 initialized 与 seed 目录组合"的 8 种情形，其中大量的分支来自"自动清理语义"。v2 放弃自动清理后，状态只取决于 seed 目录本身：

| status | 条件 | UI 文案 | 可用动作 |
|---|---|---|---|
| `installed` | seed 目录存在 **且** content hash **等于**内置 hash | ✅ Harness skill is installed | Re-install (重新覆盖) |
| `drift` | seed 目录存在 **但** content hash **不等于**内置 hash | ⚠ Your local copy was modified — it will be overwritten on next Re-install | Re-install (覆盖) |
| `missing` | seed 目录不存在（且存根显示曾 seed 过，或根本没存根）| ➕ Not installed | Install (seed) |
| `seed_failed` | 上次 seed 时 fs 抛错，存根里记了 `last_error` | ❌ Last install failed: <reason> | Retry install |

**不再需要：** 解析 `AGENTS.md + docs/version/INDEX.md` 的存在性 —— 这是个跟 harness skill 安装状态无关的正交信号（项目可以不用 harness 命令体系但保留 `AGENTS.md`，反之亦然）。

### A3 · Seed 存根文件 `.astack/system-skills.json`

```json
{
  "version": 1,
  "seeded": {
    "harness-init": {
      "seeded_at": "2026-04-20T21:00:00Z",
      "built_in_hash": "sha256 hex of the built-in source dir at seed time",
      "source_path": "/abs/path/to/packages/server/system-skills/harness-init",
      "last_error": null
    }
  }
}
```

存在于 `.astack/` 子目录（与 `.claude/` 同级），避免和 primary_tool 变化耦合。
用户可选加入 .gitignore；不强制（commit 也 OK，元数据无敏感信息）。

`built_in_hash` 字段的用途（v0.4 + v0.5）：
- v0.4：反查 inspect 时对比 seed 目录 **当前** hash（三方比较：内置当前 hash / seed 目录当前 hash / 存根记录的 seed 时内置 hash）
- v0.5：升级提示，当内置 hash 跟存根记录的不一致时显示 "Built-in version updated, Re-install to sync"

### A4 · 注册时自动 seed 的错误处理

**决策：fire-and-forget + 事件驱动 + seed 失败不阻塞注册。**

流程：
```
POST /api/projects
  → ProjectService.register(input)
    → projects.insert (DB)
    → events.emit('project.registered', { project })
    ← 返回 201 { project }
  [ 独立 microtask ]
  SystemSkillService 订阅了 'project.registered' 事件:
    handler(project) {
      if (project.primary_tool !== '.claude') { skip; return; }
      try {
        this.seedIfMissing(project.id, 'harness-init');
      } catch (err) {
        safeLog('harness.seed_failed', err);
        this.writeStubLastError(project.path, err);
        events.emit('harness.changed', { project_id, status: 'seed_failed' });
      }
    }
```

**关键点（来自 v1 review Issue 1 + Issue 7 决议）：**
- SystemSkillService **不在 ProjectService 构造依赖里**（避免循环依赖）；改用 EventBus 订阅
- handler 用同步 try/catch 包住 seedIfMissing 的调用点，防止构造 promise 前 throw 漏出
- `safeLog` 是 logger 的 wrapper：`try { logger.warn(...); } catch {}` —— 防止 logger 本身故障产生 unhandledRejection
- 注册路径用 `seedIfMissing`（目标目录任何内容都跳过），非 `seed`（强制覆盖） —— 避免对已有 `.claude/skills/harness-init/` 目录的项目做破坏性覆盖

### A5 · 触发点总览（简化版，取消 reconcile 概念）

| 触发源 | 动作 | 写 fs？ | 广播 SSE？ |
|---|---|---|---|
| `POST /api/projects` | `seedIfMissing`（via event） | 只在目录缺失时 | 是（真写入时） |
| `POST /api/projects/:id/harness/install` | `seed`（强制覆盖） | 是 | 是 |
| `GET /api/projects/:id/harness` | `inspect` | **否** | **否** |
| `GET /api/projects/:id/status` | 不看 harness（正交） | 否 | 否 |
| SSE `sync.completed` | 不再触发 harness | 否 | 否 |

**没有 reconcile 概念，没有 60s 节流，没有 SSE 触发的 reconcile loop。** 读路径纯读、写路径显式、SSE 只在真写时发 —— 解决了 v1 review Issue 4 + Issue 6 的所有并发 / 无限循环风险。

### A6 · "drift 检测" 算法 —— inspect 的实现

```
inspect(projectId, skillId):
  stub = readStub(project.path)  // 可能为 null
  seedDir = <project>/.claude/skills/<skillId>/
  seedExists = fs.existsSync(seedDir) && fs.statSync(seedDir).isDirectory()

  if (stub?.seeded[skillId]?.last_error) {
    return { status: 'seed_failed', last_error: stub.seeded[skillId].last_error }
  }
  if (!seedExists) {
    return { status: 'missing' }
  }
  actualHash = hashDirectory(seedDir)
  builtInHash = registry[skillId].content_hash  // 启动时预计算
  if (actualHash === builtInHash) {
    return { status: 'installed', seeded_at: stub?.seeded[skillId]?.seeded_at ?? null }
  }
  return { status: 'drift', seeded_at: stub?.seeded[skillId]?.seeded_at ?? null }
```

inspect **只 read**，不修存根、不写目录、不发 SSE。

### A7 · 目录 content hash 算法（来自 v1 review Issue 3 决议）

单一实现在 `packages/server/src/system-skills/hash.ts`，两处调用（启动时算内置 hash、inspect 时算项目 seed hash）：

```ts
export async function hashDirectory(absDir: string): Promise<string> {
  const entries = await collectFilesRecursive(absDir);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath, "en"));

  const rootHash = crypto.createHash("sha256");
  for (const entry of entries) {
    const fileHash = crypto.createHash("sha256");
    fileHash.update(await fs.promises.readFile(entry.absPath));  // raw bytes, no newline conversion
    rootHash.update(entry.relPath);
    rootHash.update("\0");
    rootHash.update(fileHash.digest("hex"));
    rootHash.update("\n");
  }
  return rootHash.digest("hex");
}
```

**算法规范：**
1. 遍历：`fs.readdirSync(dir, { recursive: true })` 后按 `relPath` `localeCompare("en")` 稳定排序（跨 OS 一致）
2. 包含：所有常规文件
3. 排除：`.DS_Store`、`.git/**`（防御性；harness-init 里没有但未来 skill 可能有）
4. 软链接：遇到时 warn + 跳过（harness-init 不含 symlink）
5. 空目录：不参与 hash（空目录是 fs layout 细节，不是内容）
6. 文件名：纳入 hash（`<relPath>\0<file_sha256>\n` 的形式）
7. 换行符：读 raw bytes，**不做 LF/CRLF 转换** —— 防御 git autocrlf

### A8 · 资源定位（复用 locateDashboard 模式）

`packages/server/src/system-skills/paths.ts`:

```ts
export function systemSkillsRoot(): string {
  const require_ = createRequire(import.meta.url);
  const candidates: string[] = [];

  // 1. 通过 package 自身 export（生产 npm install 场景）
  try {
    const pkg = require_.resolve("@astack/server/package.json");
    candidates.push(path.join(path.dirname(pkg), "system-skills"));
  } catch { /* ignore */ }

  // 2. 相对于 src 目录（dev 场景：pnpm workspace + tsx 运行）
  try {
    const dev = new URL("../../system-skills", import.meta.url);
    candidates.push(dev.pathname);
  } catch { /* ignore */ }

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "harness-init", "SKILL.md"))) return c;
  }
  throw new AstackError(
    ErrorCode.INTERNAL_ERROR,
    "system-skills directory not found; astack install may be broken",
    { candidates }
  );
}
```

启动时 `SystemSkillService` 构造器调 `systemSkillsRoot()` → 内部再枚举 `<root>/*/SKILL.md` → 读 SKILL.md frontmatter（v0.4 **不解析**，走 v1 review Issue 5 决议 B：`name / description` 硬编码在 `registry.ts` 常量，当前只 1 个 skill 无需动态解析）。

### A9 · Scanner 过滤重名 repo skill（防污染系统 skill 命名空间）

**问题：** 用户导入的 repo 若含有和系统 skill 同名的条目（例如 `skills/harness-init/SKILL.md`），scanner 会把它当成正常 repo skill 收录 → 用户可 subscribe → SymlinkService 会在 `<project>/.claude/skills/harness-init/` 建 symlink，与系统 seed 目录冲突（EEXIST 或 seed 覆盖 symlink）。更严重的是：用户可能以为自己在用系统 harness-init，实际用的是 repo 里某个污染版本。

**决策：在 scanner 层排除，而不是 repo service 层。**

候选方案：
- **A（采纳）** scanner/index.ts 的 `scanRepo` 新增可选参数 `systemSkillIds?: ReadonlySet<string>`，命中则剔除 + 加 warning；`RepoService.scanAndUpsert` 从 `SystemSkillService.list()` 拉 id 列表注入
- B 在 `RepoService.scanAndUpsert` 里收到 scanner 结果后再过滤 —— 只有 repo 路径生效；若未来增加其他 scanner 调用方（诊断端点、预览端点）要每处重复过滤
- C 在 `SymlinkService.create` 运行时拒绝 system-skill id —— 治标不治本，用户仍能 subscribe 成功但 sync 失败

**选 A 原因：**
- 在源头剔除 = 用户根本看不到这个 skill（Browse Drawer / subscriptions 搜索 / API `GET /api/repos/:id/skills` 全都不会出现）—— 语义上它"不属于 repo"，和 scanner 的 `yield valid skills` contract 一致
- 过滤器通过依赖注入 —— 未来加新系统 skill 自动生效，无需改 scanner 代码
- warning 用现有 `ScanResult.warnings` 通道，`RepoService.scanAndUpsert` 已经会 log warnings（见 repo.ts:413），无需新增 observability
- 测试友好：单测可注入任意 `Set`，不依赖真 SystemSkillService

**命名空间匹配规则：**
- 仅匹配 `(type=skill, name ∈ systemSkillIds)` —— commands / agents 即便重名也不拦截（它们落在 `.claude/commands/*.md`、`.claude/agents/*.md`，跟系统 skill 目录不冲突）
- 大小写敏感（filesystem 行为不一致，但 systemSkillIds 本来就是小写 id 常量）
- 比较 `name`，不比较 `relPath` —— 同名在任意 repo 路径下都拦

**SymlinkService 兜底（深度防御）：** 虽然 scanner 已经在源头挡了，SymlinkService.create 仍加一道 guard —— 若 target_path 指向 `<project>/.claude/skills/<id>` 且 id 是 system skill id，拒绝 + 报 `ErrorCode.VALIDATION_FAILED` 含清晰错误 "`<id>` is a reserved system skill name"。用途：防御 API 直接调 `POST /api/projects/:id/tool-links` 绕过 subscribe 流程的场景（内部使用 / 未来批量工具）。

**测试（纳入 PR0.5 或 PR1）：**
1. `scanRepo(repoPath, config, new Set(['harness-init']))` + repo 含同名 skill → 返回 skills 不含 harness-init + warnings 含 "filtered system-skill-reserved name"
2. repo 含 `commands/harness-init.md` → 不过滤（type=command，不在命名空间）
3. `systemSkillIds = new Set()` 或 omit → 行为跟 v0.3 一致（回归保护）
4. `RepoService.scanAndUpsert` 集成测试：预置 repo 含污染 skill，sync 后 `skills` 表无 harness-init 行，logger.warn 被调用
5. SymlinkService.create 收到 `skill_id=harness-init` → throw VALIDATION_FAILED

## 3. 数据流图

### 3.1 注册项目 + 自动 seedIfMissing

```
POST /api/projects { path: /foo/bar, primary_tool: '.claude' }
  → ProjectService.register(input)
    → projects.insert (DB)
    → events.emit('project.registered', { project })
    ← 201 { project } （不等 seed）

[ microtask 边界 ]
  SystemSkillService 的 event subscriber handler 执行:
    try {
      const seedDir = <project>/.claude/skills/harness-init/
      if (fs.existsSync(seedDir)) {
        // seedIfMissing: 目录已存在就跳过，不覆盖
        return;  // 保留用户现状，不发 SSE
      }
      mkdir -p <project>/.claude/skills/ (recursive)
      mkdir -p <project>/.astack/ (recursive)
      cpRecursive(
        <server>/system-skills/harness-init/,
        <project>/.claude/skills/harness-init/
      )
      writeStub(project.path, {
        'harness-init': {
          seeded_at: now(),
          built_in_hash: registry['harness-init'].content_hash,
          source_path: <server>/system-skills/harness-init,
          last_error: null
        }
      })
      events.emit('harness.changed', { project_id, status: 'installed' })
    } catch (err) {
      safeLog('harness.seed_failed', err)
      writeStubLastError(project.path, err.message)
      events.emit('harness.changed', { project_id, status: 'seed_failed' })
    }
```

**SeedIfMissing 的"存在就跳过"语义细节：**
- 检查 **目标目录** `<project>/.claude/skills/harness-init/` 的 isDirectory
- 任何内容（哪怕 0 字节空目录）都视为"已存在" → 跳过
- 这是唯一一处"保留项目现状"的分支 —— 专为"用户 register 一个 legacy .claude 结构的项目"场景设计
- 用户想强制覆盖：点 "Install" 按钮走 `POST /harness/install` → 调 `seed`（强制覆盖）

### 3.2 打开 Harness tab（纯读）

```
Web ProjectDetailPage → tab='harness' (URL ?tab=harness)
  → HarnessPanel mount
  → api.inspectHarness(projectId)
    → GET /api/projects/:id/harness
      → SystemSkillService.inspect(projectId, 'harness-init')
        [ 4 步纯读，见 A6 伪代码 ]
      ← { status, seeded_at, last_error?, built_in_hash, actual_hash? }
  → 渲染对应状态的 UI

用户在项目本地修改了 seed 目录：
  → 下次用户打开 Harness tab → inspect → hash 不一致 → status: 'drift'
  → UI 显示 "⚠ Your local copy was modified — will be overwritten on next Re-install"
  → 用户点 "Re-install" → POST /harness/install → seed (强制覆盖)
  → SSE harness.changed { status: 'installed' } → UI 更新
```

### 3.3 Re-install（用户手动强制覆盖）

```
User clicks [Re-install] in HarnessPanel
  → api.installHarness(projectId)
    → POST /api/projects/:id/harness/install
      → SystemSkillService.seed(projectId, 'harness-init')
        (不检查目标是否存在 → 直接覆盖)
        rmIfExists(<project>/.claude/skills/harness-init/)  // 先清，再写
        cpRecursive(<server>/system-skills/harness-init/, <project>/.claude/skills/harness-init/)
        writeStub(project.path, {...})
        events.emit('harness.changed', { project_id, status: 'installed' })
      ← 200 { status: 'installed', seeded_at }
```

## 4. PR 路线图

**可并行：** Lane A（后端 service + domain）→ Lane B（HTTP + events schema）→ Lane C（前端）。

### 状态

| PR | Lane | 状态 |
|---|---|---|
| PR0 — 搬运 harness-init 源到 `packages/server/system-skills/` + package.json files + paths.ts | A | ⏳ |
| PR1 — SystemSkill domain + schemas + events schema + registry 常量 | A | ⏳ |
| PR2 — hashDirectory + SystemSkillService (seed / seedIfMissing / inspect) + 单测 | A | ⏳ |
| PR2.5 — Scanner 过滤 + SymlinkService 兜底 guard（A9） | A | ⏳ |
| PR3 — `GET/POST /api/projects/:id/harness/*` 2 个端点 + 测试 | B | ⏳ |
| PR4 — SystemSkillService 订阅 `project.registered` 事件（fire-and-forget seedIfMissing） | A | ⏳ |
| PR5 — HarnessPanel 组件 + ProjectDetailPage 加第 5 个 tab + api.ts | C | ⏳ |
| PR6 — E2E 覆盖（installed / drift-overwritten / legacy-skipped / polluted-repo-excluded） | C | ⏳ |

**最短关键路径：** PR0 → PR1 → PR2 → PR3 → PR5。PR2.5 / PR4 / PR6 在主路径之后追加。

---

### PR0 — 搬运 + 打包 + 资源定位

**范围：** 仓库根 + `packages/server/`。

**改动：**

- `mv scripts/harness-init packages/server/system-skills/harness-init` （保留 `.sh` exec bit —— 虽然 SKILL.md 指导用 `bash <path>` 不依赖 exec bit，但保留良好卫生）
- `packages/server/package.json`:
  ```json
  "files": ["dist", "system-skills"]
  ```
- `packages/server/src/system-skills/paths.ts`：`systemSkillsRoot()`（见 A8）
- `packages/server/src/system-skills/registry.ts`：硬编码常量
  ```ts
  export const SYSTEM_SKILLS: Array<{ id: string; name: string; description: string }> = [
    {
      id: "harness-init",
      name: "Harness governance bootstrap",
      description: "初始化或迁移项目的 Harness 研发流程治理基础设施（AGENTS.md + docs/version/ + docs/retro/），为 /spec /dev /code_review /mr /retro 等命令体系打底。"
    }
  ];
  ```
- `.gitignore` 不改（根目录 `scripts/` 整体保留；搬走的只是 `scripts/harness-init/`）

**测试：** `paths.test.ts` 一个 case：`systemSkillsRoot()` 返回路径存在且 `<root>/harness-init/SKILL.md` 存在。

---

### PR1 — domain + schemas + events

**范围：** `packages/shared/`。

- `domain.ts`:
  ```ts
  export interface SystemSkill {
    id: string;                 // 唯一 id，同目录名，如 "harness-init"
    name: string;               // 人话名
    description: string;        // 描述
    source_path: string;        // 服务器本地源路径（绝对）
    content_hash: string;       // 启动时计算的目录 hash
  }

  export const HarnessStatus = {
    Installed: "installed",
    Drift: "drift",
    Missing: "missing",
    SeedFailed: "seed_failed"
  } as const;
  export type HarnessStatusT = (typeof HarnessStatus)[keyof typeof HarnessStatus];

  export interface ProjectHarnessState {
    project_id: number;
    skill: SystemSkill;
    status: HarnessStatusT;
    seeded_at: string | null;
    /** 存根里记录的内置 hash；用于 v0.5 升级检测 */
    stub_built_in_hash: string | null;
    /** seed 目录当前实际 hash（drift 时诊断用；installed/missing 场景不算）*/
    actual_hash: string | null;
    last_error: string | null;
  }
  ```
- `schemas/harness.ts`：`ProjectHarnessStateSchema` + request/response schema
- `schemas/events.ts`：`HarnessChangedPayloadSchema = { project_id, status, seeded_at?, last_error? }`

---

### PR2 — hashDirectory + SystemSkillService

**范围：** `packages/server/src/system-skills/hash.ts`、`packages/server/src/services/system-skill.ts` + tests。

**hashDirectory 实现规范：** 见 A7。单测覆盖：
- 空目录 → 稳定 hash
- 同内容跨 CRLF / LF → 同 hash（raw bytes 保证）
- 文件顺序不影响（filesystem 返回顺序变化不改 hash）
- 文件重命名会改 hash
- 嵌套子目录稳定

**SystemSkillService API：**
```ts
export class SystemSkillService {
  private registry: Map<string, SystemSkill>;
  constructor(deps: { logger: Logger; events: EventBus; projects: ProjectService });

  list(): SystemSkill[];               // v0.4 返回 [harness-init]
  get(id: string): SystemSkill | null;

  stubPath(projectPath: string): string;
  readStub(projectPath: string): StubData | null;
  writeStub(projectPath: string, data: StubData): void;
  writeStubLastError(projectPath: string, err: string): void;

  /** inspect — 纯读 */
  async inspect(projectId: number, skillId: string): Promise<ProjectHarnessState>;

  /** seed — 强制覆盖 */
  async seed(projectId: number, skillId: string): Promise<ProjectHarnessState>;

  /** seedIfMissing — 仅目录不存在时 seed */
  async seedIfMissing(projectId: number, skillId: string): Promise<ProjectHarnessState>;
}
```

**测试 (≥ 10 case)：**

1. `inspect` missing + 无存根 → status='missing'
2. `inspect` seed 目录存在 + hash 匹配 → status='installed'
3. `inspect` seed 目录存在 + 用户改过（hash 不匹配）→ status='drift'（不写 fs、不发 SSE）
4. `inspect` seed_failed 状态（存根 last_error 存在）→ status='seed_failed'
5. `seed` 从 missing → installed（文件真实写入、hash 匹配、SSE 发 1 次）
6. `seed` 从 drift → installed（旧内容被清掉后覆盖，hash 最终匹配）
7. `seed` 幂等：已 installed 再 seed → 目录重写但内容相同，hash 仍匹配，SSE 发 1 次（诚实报告"又被 touch 过"）
8. `seedIfMissing` + 目标目录存在（任何内容）→ 跳过，不发 SSE，inspect 结果取决于目录内容
9. `seedIfMissing` + 目标目录不存在 → 等同 `seed`
10. `seed` 失败（fs.mkdir 抛 EACCES）→ last_error 存入存根，SSE 发 seed_failed
11. 启动时 registry 加载：`systemSkillsRoot()` → 扫到 harness-init → `content_hash` 预计算一次
12. 并发 2 个 seed 同 projectId → 串行化（内存级 per-project mutex），最终状态 installed，SSE 发 2 次（每次都是真写）

**关键实现点：**
- 并发保护：`Map<projectId, Promise>` 做 per-project mutex（两个并发 seed 串行执行，避免 cp 途中被 rm）
- 存根写入原子：先写 `.astack/system-skills.json.tmp` → rename —— 防止 ENOSPC 导致 JSON 半截
- `rmIfExists + cpRecursive` 顺序：先 rm 后 cp，避免残留旧文件混入

---

### PR2.5 — Scanner 过滤 + SymlinkService 兜底（A9）

**范围：** `packages/server/src/scanner/index.ts` + `packages/server/src/services/repo.ts` + `packages/server/src/services/symlink.ts` + tests。

**改动：**

- `scanner/index.ts`:
  ```ts
  export interface ScanOptions {
    /** 系统 skill id 黑名单；命中则剔除 + 加 warning（见 A9）*/
    systemSkillIds?: ReadonlySet<string>;
  }

  export function scanRepo(
    repoPath: string,
    config: ScanConfig = DEFAULT_SCAN_CONFIG,
    options: ScanOptions = {}
  ): ScanResult {
    // ... 现有实现 ...
    // 新增：去重之后、return 之前
    const blacklist = options.systemSkillIds ?? new Set<string>();
    const filtered: ScannedSkill[] = [];
    for (const s of deduped) {
      if (s.type === SkillType.Skill && blacklist.has(s.name)) {
        warnings.push(
          `skill '${s.name}' in ${s.relPath} conflicts with a reserved system skill name; excluded from repo skills`
        );
        continue;
      }
      filtered.push(s);
    }
    return { skills: filtered, warnings };
  }
  ```

- `services/repo.ts:scanAndUpsert` 传入黑名单（通过构造器注入的 SystemSkillService）：
  ```ts
  const systemSkillIds = new Set(this.deps.systemSkills.list().map((s) => s.id));
  const { skills, warnings } = scanRepo(localPath, config, { systemSkillIds });
  ```
  RepoServiceDeps 新增 `systemSkills: SystemSkillService`。

- `services/symlink.ts:create` 头部加 guard：
  ```ts
  if (this.deps.systemSkills.get(skillDirName)) {
    throw new AstackError(
      ErrorCode.VALIDATION_FAILED,
      `'${skillDirName}' is a reserved system skill name`,
      { skill_name: skillDirName }
    );
  }
  ```

**测试：**

Scanner 单测（`scanner/index.test.ts` 或新建 `scanner/system-skill-filter.test.ts`）:
1. 预置 repo 含 `skills/harness-init/SKILL.md` + `skills/foo/SKILL.md`，scanRepo with `systemSkillIds: new Set(['harness-init'])` → 返回仅 foo + warnings 含 "reserved system skill name"
2. 同 repo，不传 options → 返回 [harness-init, foo]（回归保护：已有调用方行为不变）
3. 预置 `commands/harness-init.md` + systemSkillIds=['harness-init'] → 不过滤（type=command）
4. 空 systemSkillIds `new Set()` + repo 无污染 → 行为跟 v0.3 一致

RepoService 集成测试（`services/repo.test.ts` 扩展）:
5. 构造 repo 含污染 skill → `syncRepo(repoId)` 完成后 skills 表查不到 harness-init 行 + logger.warn 被调用（mock logger spy）

SymlinkService 单测:
6. `create(projectId, 'harness-init')` → throw VALIDATION_FAILED

**打包依赖：** 依赖 PR1 的 `SystemSkillService.list()` —— `RepoService` 构造顺序调整：DI container 里 SystemSkillService 先于 RepoService 构造。

---

### PR3 — HTTP endpoints

**范围：** `packages/server/src/http/routes.projects.ts` + tests。

路由：
```
GET  /api/projects/:id/harness           → inspect（纯读，cache-control: no-store）
POST /api/projects/:id/harness/install   → seed
```

每个端点 404 走 `ProjectService.mustFindById`。

**测试 (≥ 5 case)：**
1. GET 正常返回 ProjectHarnessState
2. GET on drift → status='drift'，数据库/fs 未被修改（spy 验证）
3. POST install 成功 → 200 + 状态 installed
4. POST install 失败（mock fs 抛错）→ 500 + ErrorCode.INTERNAL_ERROR + 存根 last_error 已写
5. GET/POST 404 for unknown project

---

### PR4 — event-driven 注册后 seed

**范围：** `packages/server/src/daemon.ts`（或 service 构造阶段，看依赖链）+ `packages/server/src/services/system-skill.ts`。

关键点：SystemSkillService 构造时订阅 EventBus：

```ts
constructor(deps: { ..., events: EventBus, projects: ProjectService }) {
  this.registry = loadRegistry();
  deps.events.on(EventType.ProjectRegistered, ({ payload }) => {
    this.handleProjectRegistered(payload.project).catch((err) => {
      safeLog(deps.logger, "harness.subscriber_crash", err);
    });
  });
}

private async handleProjectRegistered(project: Project) {
  if (project.primary_tool !== ".claude") return;
  try {
    await this.seedIfMissing(project.id, "harness-init");
  } catch (err) {
    safeLog(this.deps.logger, "harness.seedIfMissing_failed", err);
    this.writeStubLastError(project.path, String(err));
    this.deps.events.emit({
      type: EventType.HarnessChanged,
      payload: { project_id: project.id, status: HarnessStatus.SeedFailed, last_error: String(err) }
    });
  }
}
```

`safeLog` helper（新增 `logger.ts` 或 `fs-util.ts`）：
```ts
export function safeLog(logger: Logger, msg: string, meta: unknown): void {
  try { logger.warn(msg, meta); } catch { /* swallow */ }
}
```

**测试 (3 case，放在 project.test.ts / system-skill.test.ts 里)：**
1. `register` 201 返回不被 seed 延迟阻塞（spy seedIfMissing 返回 pending promise，断言 201 先返）
2. `register` 后 50ms 内 harness.changed SSE 飞出（happy path）
3. `register` 后 seed 失败，201 仍正常返回；SSE 发 seed_failed（spy seedIfMissing 抛错）
4. **REGRESSION**：`register` 时 logger 本身抛错（mock logger.warn throw）→ register 仍 201 + 不产生 unhandledRejection（process.on 监听器 spy 验证）

---

### PR5 — HarnessPanel 前端

**范围：** `packages/web/src/components/project/HarnessPanel.tsx` + ProjectDetailPage + api.ts + 单测。

UI 各状态：

```
[installed]
┌──────────────────────────────────────────────┐
│ Harness                                      │
│                                              │
│ Status: ● Installed                          │
│   Built-in harness-init skill is deployed.   │
│                                              │
│ Installed at: 2026-04-20 21:00 UTC           │
│ Source: packages/server/system-skills/harness-init │
│                                              │
│ [ Re-install ]  [ Show instructions ]        │
└──────────────────────────────────────────────┘

[drift]
┌──────────────────────────────────────────────┐
│ Harness                                      │
│                                              │
│ Status: ⚠ Drift detected                     │
│   Your local copy of this skill has been     │
│   modified. Astack treats the built-in       │
│   version as the source of truth — your      │
│   changes will be overwritten the next time  │
│   you click Re-install.                      │
│                                              │
│ [ Re-install now ]  [ Show instructions ]    │
└──────────────────────────────────────────────┘

[missing]
┌──────────────────────────────────────────────┐
│ Harness                                      │
│                                              │
│ Status: ➕ Not installed                      │
│                                              │
│ [ Install ]                                  │
└──────────────────────────────────────────────┘

[seed_failed]
┌──────────────────────────────────────────────┐
│ Harness                                      │
│                                              │
│ Status: ❌ Install failed                     │
│   Last error: <last_error>                   │
│                                              │
│ [ Retry install ]                            │
└──────────────────────────────────────────────┘
```

**Tab badge：**
- `installed` → 无 badge（OK 状态不打扰）
- `drift` → ⚠
- `missing` → ➕
- `seed_failed` → ❌

**Show instructions** —— 走 v1 review Issue 8 决议 B：**inline expand**，不新增 Dialog primitive：

点击后 Panel 底部展开一块：
```
To initialize Harness governance in this project, run:

  bash .claude/skills/harness-init/scripts/init-harness.sh

This creates AGENTS.md and docs/version/ scaffolding.

[ Copy command ]                               [ Hide ]
```

**组件单测 (≥ 5 case)：**
1. 各 4 态渲染正确
2. drift 时 Re-install 按钮可点击
3. Re-install 触发 api.installHarness + 乐观更新到 installed
4. seed_failed 时显示 last_error 内容
5. Show instructions 展开 / 折叠

---

### PR6 — E2E

`packages/web/e2e/harness.spec.ts`：

1. **installed happy path**：注册新空目录项目 → 打开 Harness tab → 显示 "Installed"
2. **drift overwrite**：注册 → 手动改 `.claude/skills/harness-init/SKILL.md`（appendFile 加一行）→ 刷新页面 → Harness tab 显示 "Drift detected" → 点 Re-install → 状态变 "Installed" + SKILL.md 恢复原始内容
3. **legacy 项目不被覆盖**：预先在目录里建好 `.claude/skills/harness-init/` 含一个假 SKILL.md → 注册 → Harness tab 显示 "Drift detected"（因为 hash 跟内置不匹配）→ seed 目录未被 register 自动覆盖（seedIfMissing 看到目录存在就跳过）→ 点 Re-install 后才被覆盖
4. **polluted repo excluded**：注册一个含 `skills/harness-init/SKILL.md` 的测试 repo → sync repo → BrowseSkillsDrawer 打开该 repo 分组 → harness-init **不在** skill 列表里（scanner 过滤生效）；daemon 日志包含 reserved name warning

## 5. 验收标准

- 注册新空目录项目 → 自动出现 `.claude/skills/harness-init/` 目录（完整文件）+ `.astack/system-skills.json` + Harness tab 状态 `installed`
- 注册已含 `.claude/skills/harness-init/` 的项目（legacy / 重复注册）→ **不覆盖**本地目录；状态根据 hash 是 `installed` or `drift`；无数据丢失
- 点 Re-install 按钮 → seed 目录被强制覆盖为内置版本，hash 一致，状态 `installed`
- 用户改了本地 seed 目录 → Harness tab 显示 `drift` + 明确告知"will be overwritten on next Re-install"
- 所有 inspect 端点（GET /harness）不写 fs、不发 SSE、不改数据库（spy 验证）
- **含污染名称的 repo 注册 + sync** → `skills` 表不含 harness-init 行；Browse Drawer / API `GET /api/repos/:id/skills` 均不显示 harness-init；daemon 日志有清晰 warning
- **直接调 `POST /api/projects/:id/tool-links` with skill_id='harness-init'** → 400 VALIDATION_FAILED（SymlinkService 兜底）
- 回归：typecheck 4/4 + server test pass + web test pass + E2E chromium pass
- primary_tool != `.claude` 的项目注册时：seed subscriber 跳过，UI 不显示 Harness tab（或显示"primary_tool not supported" 简短提示）

## 6. 未决定 / 待评审挑战（v0.4 不做 —— 留待 v0.5）

- SystemSkill "更新"语义：内置 harness-init 升级了（hash 变了），但项目里的 seed 还是老版本的 hash —— 存根里记的 `built_in_hash` 可以 detect，UI 加 "Built-in version updated, Re-install to sync" 提示。**倾向 v0.5 补做**
- Daemon 启动时扫全部已注册项目 drift 状态做后台补位覆盖。**v0.5 做，配合版本升级语义一起发**
- CLI `astack harness install/status` —— v0.5 跟其他 CLI 一致性补齐一起做
- 系统 skill 的管理 UI / sidebar 入口 —— 等 ≥ 3 个系统 skill 时再说
- Scanner 过滤语义扩展：未来若有多个 systemSkill id 冲突，考虑是否需要"仅在该 skill 已 seed 的项目"上剔除（当前是全局剔除，更严格但也更简单）
