# v0.8 — Auto-adopt Reflow：后续注册仓库能重分类已兜底的 LocalSkill

> **文档状态：已完成（单 PR 落地）· 2026-04-23**
>
> 创建于 2026-04-23，分支 main
>
> **前置依赖：** v0.7 已落地（`LocalSkillService` / `local_skills` 表 / `origin: 'adopted' | 'auto'` / `status: 'name_collision'` 枚举就位）；v0.5 已落地（`ProjectBootstrapService.scanAndAutoSubscribe` 的锁 + inflight dedup + `autoAdoptFromUnmatched` 存在性过滤）。
>
> **触发事件（2026-04-23）：** 用户先注册一个裸项目（尚未注册任何 repo），bootstrap 把 `.claude/commands/*.md` 全部 auto-adopt 为 `origin='auto'` 的 LocalSkill（v0.7 §3.1 语义）。之后用户再注册一个提供同名 command 的 repo，期望 Subscriptions 列表自动出现对应订阅 + Local Skills 侧给出 name_collision 标识；但实际打开项目页 UI 完全没变，只能手动 unadopt 再让系统重扫才恢复。根因是 `scanRaw` 把**所有** LocalSkill（含 `origin='auto'`）作为前置过滤项，后来的 repo 永远进不了 `matched` —— auto-adopt 兜底标记被误当作永久 ownership。
>
> **本迭代性质：** 纯 bug 修复 + 契约澄清。非新功能，不扩 schema，不改 SSE 事件集。

## 0. 迭代缘起

v0.7 把 `LocalSkill` 做成了一等公民域概念，并把 bootstrap 的 "unmatched 不消失" 问题补上 —— 扫描器发现 `.claude/**` 下未被任何 repo 提供的文件，就 auto-adopt 成 `origin='auto'` 的 LocalSkill 行，UI 至少能看到。

但 v0.7 spec 在两个关键点**没有明确说清**：

1. **auto-adopt 是"标记"还是"决定"？** §A2 只写了"auto-adopt 的 heuristic"（scanner 合法 + 不在 `ignored_local` + 无订阅），没写"被 auto-adopt 之后，如果前提 3（'无订阅'）后续不成立了（用户新注册了 repo），行为该怎么演化"。
2. **§A6 说 `LocalSkillService.upsert 写入前查 subscriptions 表：若 (project_id, type, name) 已存在订阅，status 置 name_collision`**，这是"LocalSkill 后写" 方向的 collision；但**反方向**（LocalSkill 先存在、订阅后到）在 v0.7 里完全没有触发点。

这两个歧义的后果在 2026-04-23 由用户行为曝出：先注册空项目 → auto-adopt → 后注册 repo。按自然预期，**LocalSkill 应该从 `present` 翻到 `name_collision`**（让用户知道存在可替代的 repo 源，可选择 unadopt 或保留），**Subscriptions 里应该自动出现 repo 订阅**。实际行为是两者都不变 —— `scanRaw` 里 `adoptedLocalKeys` 把 auto row 永久过滤了，后续任何 repo 匹配永远看不到它。

v0.8 的定位：**把 auto-adopt 严格限定为"可撤销的兜底标记"，保证一旦上游能承接，分类能收敛到 repo 订阅 + LocalSkill 行被降级提示。** 用户手动 adopt（`origin='adopted'`）的语义不变（明示 ownership，repo 匹配不介入）。

### 为什么现在能做

1. `LocalSkillRepository` 已有 `updateStatus(id, {status, content_hash, last_seen_at})` 能力（v0.7 PR2 就位），无需扩 schema 就能翻 status。
2. `ProjectBootstrapService.scanAndAutoSubscribe` 已在 `projectBootstrapLockKey(projectId)` 持锁内调用 `LocalSkillService.autoAdoptFromUnmatched`（后者签名就写明"调用方必须已持锁"）。我们只需在同一锁 scope 内追加一个"markNameCollisionUnderLock"的无锁下游方法，和 `autoAdoptFromUnmatched` 对称。
3. `LocalSkillService.emitChanged` 已有成熟 SSE 通道（`local_skills.changed` 事件，payload 是 delta `summary`）；status 翻转只是 `modified` bucket +1 —— 不需要新事件类型，前端 listener 已经对 `local_skills.changed` 做全量刷新。
4. 前端 `ProjectDetailPage.loadBootstrap` 从一开始就是"打开 tab 刷一次"的幂等时点；把它从纯读 `inspectBootstrap` 切到幂等写 `scanBootstrap`（同 `projectBootstrapLockKey` 防并发）代价只是一次多的 DB 读扫，就能把"后注册 repo 的收敛"无侵入地挂上。

## 1. 本次迭代的边界

### In scope（本迭代做）

**后端 — 重分类与 name_collision 翻转**

1. `packages/server/src/services/project-bootstrap.ts::scanRaw`：把 `adoptedLocalKeys` 的前置过滤集从"所有 LocalSkill"缩紧为"仅 `origin === 'adopted'` 的 LocalSkill"。`origin === 'auto'` 的行重新参与 `matched / ambiguous / unmatched` 三元分类。
   - 幂等性不变：`autoAdoptFromUnmatched` 内部早已有 `repo.findByRef` 存在性过滤，二次 scan 不会 re-upsert auto row。
   - 契约 "用户明示 adopt 不被 repo 覆盖" 由 `origin === 'adopted'` 的过滤分支保留。

2. `packages/server/src/services/project-bootstrap.ts::scanAndAutoSubscribe`：在持锁 scope 内的执行顺序改为：
   - **snapshot**：遍历 `result.matched`，记录哪些条目对应 `origin='auto'` 的现存 LocalSkill → `autoAdoptedMatchKeys`
   - `subscribeMatched(projectId, result.matched)`
   - **flip**：取 `subscribed` 交集 `autoAdoptedMatchKeys`，调新方法 `LocalSkillService.markNameCollisionUnderLock(projectId, refs)` 把对应 LocalSkill 行 status 改为 `name_collision`
   - 继续既有 `autoAdoptFromUnmatched(projectId, result.unmatched)`
   - 继续既有 `emitPostScanEvent(...)`
   - 全部 flip 调用用 try/catch 包住 + `safeLog`（R4：fire-and-forget 降级），不让 localSkills 分支抛错打断 subscribe + SSE 的主契约

3. `packages/server/src/services/local-skill.ts`：新增 public 方法
   ```ts
   markNameCollisionUnderLock(projectId: Id, refs: LocalSkillRef[]): number
   ```
   - 调用方 MUST 已持 `projectBootstrapLockKey(projectId)`（内部不 acquire，避免与 `autoAdoptFromUnmatched` 对称死锁）
   - 对每个 ref 查 `findByRef`；存在且 `status !== 'name_collision'` → 调 `repo.updateStatus(row.id, { status: 'name_collision', content_hash: row.content_hash, last_seen_at: nowISO })`
   - 翻转数 > 0 时调 `emitChanged(projectId, { added:0, removed:0, modified: flipped, missing:0 })`；零翻转时不发事件（避免打扰 SSE）
   - 返回翻转计数（供调用方日志 / 测试断言）

**前端 — 打开项目页主动触发幂等 scan**

4. `packages/web/src/pages/ProjectDetailPage.tsx::loadBootstrap`：`api.inspectBootstrap(projectId)` → `api.scanBootstrap(projectId)`；`res: ScanAndAutoSubscribeResult`，用 `res.result` 回写 `bootstrap` state（字段形状与 `inspectBootstrap` 返回一致）。
   - 失败时沿用原 swallow 分支（bootstrap 是 tab 的非关键 slice）
   - 复用 bootstrap 的 `inflightScan`（单飞行）+ `projectBootstrapLockKey`（跨 Service 锁）+ `autoAdoptFromUnmatched` 存在性过滤三重幂等防护，确保重复打开 tab 不会写爆

**测试覆盖**

5. `packages/server/test/project-bootstrap-service.test.ts`：
   - 更新 PR4 test 3 的注释（语义变：原 "scanRaw 看不见 auto row" → "autoAdoptFromUnmatched 过滤已存在行"；断言和流程不变，行为仍幂等）
   - 新增 **v0.8 test 7**：复现 bug — 先 auto-adopt → insertRepoSkill → 第二次 scanAndAutoSubscribe 应 `subscribed.length === 1`，且 LocalSkill 行 `origin` 保持 `auto`、`status` 变为 `name_collision`、`id` 保持不变（未被删重建）
   - 新增 **v0.8 test 8**：契约反向守护 — `origin='adopted'` 的行后续加 matching repo，`scanAndAutoSubscribe` 不 auto-subscribe，也不翻转 status（`present` 稳定），LocalSkill 行一条都不动
   - 新增 **v0.8 test 7b**：交集算法守护 — 两条 matched 同时进入 subscribe（一条有 `origin='auto'` pre-row，一条无 LocalSkill row），验证 `markNameCollisionUnderLock` 只翻前者 status、后者既不翻状态也不创建新 LocalSkill 行

### Out of scope（本迭代不做，延后到 v0.9+）

- **name_collision 的用户裁决 UI**（一键 unadopt / 一键退订）。目前 UI 只"展示"状态，裁决靠现有 LocalSkill 面板的 unadopt + Subscriptions 面板的 unsubscribe 两个独立入口合成。
- **`origin='auto'` 的 LocalSkill 在 repo 匹配成功后是否应自动 unadopt**。当前决策是**保留**（翻 name_collision 等用户决定）；自动 unadopt 是"静默修改用户可见状态"，违反"最小意外"。
- **反向修复：已订阅 skill 被 adopt 后的顺序一致性**。§A6 原始方向（LocalSkill 后写），在 v0.7 已覆盖；v0.8 补的是反方向。如发现其他顺序组合有盲区，等真实场景触发再评估。
- **Daemon 启动时对所有项目 re-run scanAndAutoSubscribe**（"重启收敛"）。当前入口是"用户打开项目页"，频率足够；Daemon 级扫描是 v0.5 以来持续 descope 的大题，不在本 PR 解决。
- **非 `.claude` primary_tool 的 bootstrap 重分类**。沿用 v0.4/v0.5/v0.7 的 `.claude` only 约束。
- **把 `origin='auto'` LocalSkill 纳入 Subscriptions 面板的 ambiguous 面板**。当前 LocalSkill 面板已是独立一等公民 tab，面板内状态显示即足够。
- **CLI 层对 "rescan after new repo" 的命令入口**。按 v0.5/v0.7 节奏，CLI 一致性批量走未来专门迭代。

## 2. 架构决策

### §A1 — auto-adopt 是"可撤销的兜底标记"，不是"永久 ownership"

**决策：** `origin='auto'` 的 LocalSkill 行在后续 bootstrap 时必须允许被 `scanRaw` 重新纳入 `matched / ambiguous / unmatched` 分类；`origin='adopted'` 行则继续作为前置过滤排除。

**理由：**
- auto-adopt 的 heuristic 本身就是"无 repo 能承接时的兜底"（v0.7 §A2 heuristic #3：`未被任何 subscription 引用`）。前提 3 后续不成立时，兜底语义不再适用 —— 继续屏蔽 = 把一次性的兜底判断永久化。
- 用户从未表达过"我想把 `dev.md` 作为 local-only"，只是注册项目那一刻没 repo 可匹配。把这种"默认兜底"当作 "user 明示 ownership" 是严重的 UX 断层。
- `origin='adopted'` 承担"用户明示"语义：只有用户主动点过 adopt 的行才被永久屏蔽重分类，尊重用户 intent。

**反面选项（已否决）：**
- "保持 v0.7 行为，用户想要新 repo 接管就先 unadopt 再 scan" —— UX 断层明显，用户心智模型里"新注册 repo 就应该接管对应命令"是默认期望。
- "把 `origin='auto'` 转成 `origin='adopted'` 再继续过滤" —— 比原 bug 更糟，把系统的兜底决策伪装成用户决策。

### §A2 — 反方向 name_collision 翻转在 bootstrap 层完成（不在 LocalSkillService 层主动探测）

**决策：** 反方向 collision（LocalSkill 在前 + 订阅在后）的翻转由 `ProjectBootstrapService` 在 subscribe 成功后显式调 `markNameCollisionUnderLock`。`SubscriptionService.subscribe` 不感知 LocalSkill 表，保持单向依赖（`ProjectBootstrap` 依赖 `SubscriptionService` 和 `LocalSkillService`，不让 Subscription 反依赖 LocalSkill）。

**理由：**
- `SubscriptionService.subscribe` 的语义是"记录一条订阅" —— 副作用扩到"翻别的表的 status"会把职责糊在一起，未来 adopt / auto-adopt 路径也写订阅时会引入多路触发点。
- `ProjectBootstrapService` 已是 LocalSkill + Subscription 的聚合入口（§v0.7 §A9 跨服务锁就绑在它身上），翻 status 是其"原本就负责协调"的职责。
- 测试可观察性：翻转发生在 bootstrap 的确定性流程内，用例清晰（先 subscribe 后 flip，顺序显式），而不是散在"subscribe 的监听方也可能是 LocalSkillService"这种隐式触发链里。

**反面选项（已否决）：**
- "在 `LocalSkillService.upsert` 里既查 subscribe 也查现有 LocalSkill 自动翻 status" —— 反方向触发需要一个"订阅新增时通知"的机制，当前无 `subscription.added` 事件（v0.5 P1 案例），新建这么一个事件专门给一种 status 翻转用，OOP。
- "把翻转做成 SubscriptionService 事件监听" —— fire-and-forget 路径难测，且违反服务职责隔离。

### §A3 — `markNameCollisionUnderLock` 的锁契约与 `autoAdoptFromUnmatched` 对称

**决策：** `markNameCollisionUnderLock` 是无锁下游方法，调用方 MUST 已持 `projectBootstrapLockKey(projectId)`。与 `autoAdoptFromUnmatched` 完全对称（v0.7 A9 建立的契约）。

**理由：**
- `scanAndAutoSubscribe` 是唯一调用方，已在 `locks.withLock(projectBootstrapLockKey(projectId), ...)` scope 内；内部再 acquire 同 key 会死锁。
- 名字显式带 `UnderLock` 后缀告知读者"这是协议契约方法，不是通用 API"，与 `autoAdoptFromUnmatched` 的行为约束（同样要求持锁）一致，降低新人误用概率。

### §A4 — 前端把 `loadBootstrap` 从纯读切到幂等写

**决策：** `ProjectDetailPage.loadBootstrap` 调 `api.scanBootstrap`（POST，写入路径）而非 `api.inspectBootstrap`（GET，纯读）。

**理由：**
- "后注册 repo 的收敛"需要一个触发点。候选：(a) 注册 repo 时主动 scan 全部项目，(b) 打开项目页时 scan 当前项目，(c) Daemon 轮询。
  - (a) 范围大、会触发未打开项目的 SSE 风暴
  - (c) 整体设计 descope
  - (b) 是现有习惯最少意外的插入点
- 幂等性由三层保证：`inflightScan` Map（单飞行，v0.5 A8）+ `projectBootstrapLockKey`（跨 Service，v0.5 A9）+ `autoAdoptFromUnmatched` 存在性过滤。重复打开不会写爆。
- 性能：一次 scan 本质是"读 manifest + 读 scanner + 读 DB"，单项目毫秒级；SSE 只在真有 delta 时才发。

**反面选项（已否决）：**
- "保留 `inspectBootstrap` + 加个按钮手动 Re-scan" —— 把系统应该 自动 收敛的状态推给用户点按钮，严重增加心智负担。
- "注册 repo 时遍历所有项目 scan" —— 破坏范围最小化原则，如果用户有 20 个项目每次注册 repo 都被推 20 次 SSE。

## 3. 接口变更

### 3.1 新增 `LocalSkillService.markNameCollisionUnderLock`

```ts
markNameCollisionUnderLock(projectId: Id, refs: LocalSkillRef[]): number
```

- **锁契约：** 调用方 MUST 已持 `projectBootstrapLockKey(projectId)`
- **返回：** 实际翻转的行数
- **副作用：** 翻转数 > 0 时 emit `local_skills.changed` 一次，payload `summary = { added:0, removed:0, modified: flipped, missing:0 }`
- **错误语义：** `findByRef` / `updateStatus` 异常向上抛（调用方已用 try/catch 包了）；不 per-item swallow（因为这个方法的语义是"一批 refs 对应同一 subscribe 批次"，部分失败很罕见且不该静默）

### 3.2 无新增 HTTP 端点

- `/bootstrap/scan` 行为已经符合新契约，不改 API shape
- `/local-skills` 系列端点不改

### 3.3 无新增 SSE 事件

- 继续复用 `local_skills.changed`（v0.7 就位）和 bootstrap 既有事件集
- 前端 listener 无改动

## 4. PR 切分

**单 PR 落地**（bug 修复范围，无需切 PR）：

- 修 `scanRaw` 的过滤条件
- 扩 `scanAndAutoSubscribe` 的 snapshot + flip 流程
- 新增 `markNameCollisionUnderLock`
- 前端 `loadBootstrap` 切换
- 测试：更新 PR4 test 3 注释 + 新增 v0.8 test 7 + v0.8 test 8

## 5. 测试覆盖

| 测试 | 场景 | 关键断言 |
|------|------|---------|
| PR4 test 3（更新注释） | 二次 scan 幂等 | LocalSkill 行不变（`autoAdoptFromUnmatched` 过滤生效） |
| v0.8 test 7（新增） | auto-adopt → 后加 repo | `subscribed.length === 1`；LocalSkill `origin='auto'`、`status='name_collision'`、`id` 不变 |
| v0.8 test 7b（新增） | mixed matched（1 条 auto pre-row + 1 条无 pre-row） | `subscribed.length === 2`；只有 auto pre-row 被翻 `name_collision`，无 pre-row 的条目**不**生成 LocalSkill 行 |
| v0.8 test 8（新增） | adopted → 后加 repo | 无 subscribe；LocalSkill `origin='adopted'`、`status='present'` 不变 |

- `@astack/server`：410/410 tests passed（含 v0.8 test 7 / 7b / 8）
- `@astack/web` TypeScript build：通过
- `harness-panel.test.tsx` 既有失败与本次改动无关（git stash 基线也挂）

## 6. 知识沉淀

- 新黄金法则 **R8**（活跃区）：**"兜底标记不应被当作永久 ownership"** — auto-adopt / auto-* 前缀的决策，必须显式标注允许/不允许后续重分类，代码里过滤器必须按 origin 区分
- 新反模式 **P8**（`patterns.md`）：**"兜底决策的永久化"** — 系统为兜底一次性插入的标记，被当成前置过滤的永久屏蔽，后续条件变化时无法翻转
- `docs/version/INDEX.md` 新增 v0.8 行
- `docs/version/BOUNDARIES.md` 新增 v0.8 节
- `AGENTS.md` §5 "最近完成" 更新为 v0.8

## 7. 变更记录

| 日期 | 变更 | 产物 |
|------|------|------|
| 2026-04-23 | spec 起草 + 单 PR 落地 + retro 沉淀 | 本文件 / `scanRaw` / `scanAndAutoSubscribe` / `markNameCollisionUnderLock` / `loadBootstrap` / test 7/8 / R8 / P8 |
| 2026-04-23 | spec review 修复两条轻量建议 | `golden-rules.md` 分组说明补充 + R5 挪回 "Spec 设计规则" 正主分组 / 新增 v0.8 test 7b（交集算法守护）|
