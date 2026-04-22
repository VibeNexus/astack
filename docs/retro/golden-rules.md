# 黄金法则

> 从历次评审和开发中提炼的正面规则。
> spec_review / code_review **仅加载「活跃规则」区域**，归档区域不加载。
> 活跃规则上限 15 条，超出时应将低频规则移入归档。
> 编号全局唯一递增（R1, R2, ...），归档后编号不回收。

## 活跃规则

> ⚡ 以下规则在每次评审/CR 时自动加载。保持精简。

### Spec 设计规则

#### R1 · 复用声明必须 grep 验证

> 关联反模式：P1

Spec 中任何"复用现有 X"的描述（SSE 事件类型、scanner 配置、Service 方法、domain 常量），必须在写入 spec 时 grep 代码验证 X 的实际存在和完整形状，不能凭对系统的印象编写。

**机制：**
- 引用事件类型 → 对照 `packages/shared/src/schemas/events.ts` 的 `EventType` 枚举
- 引用常量（如 `DEFAULT_SCAN_CONFIG`）→ 对照 domain 源文件的实际字段列表
- 引用 Service 方法 → 对照类定义，确认签名、返回类型、是否抛错
- 引用表字段 → 对照 DB migration / 对应 Repository class 的 SELECT 列

**反例：** "复用 `subscription.added` SSE 事件"（该事件不存在）、"`DEFAULT_SCAN_CONFIG` 涵盖 agents"（实际不含）

---

#### R2 · 接口契约单一来源

> 关联反模式：P2

同一个 API / Service 方法的 request/response shape 在 spec 里**只允许有一处权威定义**（通常放在"架构决策"或"接口定义"段），其余段落（数据流图、测试用例、前端使用点）只能**引用**这个定义，不能重新描述字段集。

**机制：**
- 第一次出现时用完整 TypeScript 接口写下（或 Zod schema）
- 后续引用用 "见 §A4 定义的 `ApplyResolutionsResponse`" 这种指针式描述
- 测试用例只断言 shape 的**子集**，不再复述整个 shape

**反例：** `applyResolutions` response 在 §A4 / §3.3 / PR3 test 三段分别列出不同字段集

---

#### R3 · Schema 扩展与其所有写入点原子绑定

> 关联反模式：P3

当 spec 扩展一个数据 schema 的字段（manifest 新字段、DB 表新列），**必须在同一个 PR** 内同步改造**所有**会写入该 schema 的路径，确保字段不被其他写入者清空。

**机制：**
- 扩展 manifest → 同 PR 改 `writeManifest` 的所有调用者（尤其 `rewriteManifest`）
- 扩展 DB 表 → 同 PR 改 `upsert` / `insert` 的 SET 子句
- 若改动量大需要切 PR，则**schema 扩展不应独立成 PR**，而应和最大的写入点一起走

**检查点：** PR1 只描述 "schema 加字段" 而不带 rewriteManifest 改造 → 触发警报

---

### 代码实现规则

#### R4 · Fire-and-forget 路径的循环内必须 per-item try/catch

> 关联反模式：P4

事件订阅 handler、`.catch(swallow)` 的 void promise、定时任务 —— 这类无"上游能接住异常"的路径里，若循环调用会抛错的 service 方法，**每次迭代内部必须独立 try/catch**，把错误归入结构化的 `failed[]` 收集而非 raise。

**机制：**
- 复用现有 `subscribeBatch:287-313` 的 per-ref try/catch 模式
- 顶层再加一层 `.catch(safeLog)` 兜底 logger 故障
- 绝不允许 "这个场景不会出现所以不写 try/catch"

**反例：** 假设 "collision 不应出现" 就不在 autoSubscribeMatched 循环里加 try/catch → collision 真出现时抛出 AstackError 进 fire-and-forget 路径

---

#### R6 · 跨 Service 的同类 git 操作必须复用同一护栏或显式声明放行

> 关联反模式：P6

同一个 git 操作（`git.pull` / `git.push` / `git.reset` 等）如果在 Service A 的某条路径上已有**脏态守门 / 自愈 / 锁**等护栏，则 Service B 调用相同 git 操作时**必须复用该护栏**，或在代码里**显式声明**"B 场景允许这种状态"（不仅仅在 spec 里口头说）。不允许"A 防了 B 没防"。

**机制：**
- 新增一个跨 Service 共享的私有方法（如 `SyncService.ensureMirrorClean`），在每个需要该护栏的调用点之前统一触发，而不是复制粘贴 `if (isClean) ...` 到每条路径
- 若某条路径确实可以放行（例如 `pushOne` 对 custom 仓库路径，脏态是 commit+push 合法中间态），必须在该方法内部以"early return + 注释说明原因"的形式显式记录，让下一个改这条路径的人知道"这里放行不是漏了"
- 对不同 `kind`（`open-source` / `custom`）做路径差异化时，差异化逻辑集中在护栏方法里，不要把"某路径只对某种 kind 生效"散布到各调用点
- Code review 时对任何 `git.pull / git.push / git.reset` 新增或挪动调用必须问"这条路径有没有 A 已经建起的护栏该复用"

**反例：** v0.6 前 `services/repo.ts::refresh` 对 `open-source` 仓库有 `isClean` 跳过守门，而 `SyncService.pullOne` 与 `SyncService.resolve` 同样对 `open-source` 仓库裸调 `git.pull` —— 一次手工脏镜像静默卡住同一镜像上所有订阅的 pull / resolve。v0.6 PR1 引入 `ensureMirrorClean` 在 pull 前统一自愈解决此对称性。

---

### 跨层契约规则

#### R7 · Batch / bulk API 的 outcomes 元素必须带 error_code + error_detail，聚合计数不是契约

> 关联反模式：P7

一个返回"每项独立成败"的 batch/bulk HTTP 或 Service 方法（如 `resolveBatch` / `subscribeBatch` / `applyResolutions`），其 `outcomes[]` 元素**必须**同时暴露：
1. 人类可读的 `error?: string`（已有基线）
2. 结构化机器可读的 `error_code?: string`（来自 `AstackError.code` 枚举）
3. 原始技术细节 `error_detail?: string`（如 `AstackError.details.git_stderr` / stack head）

上层的 `errors: number` / `failed: number` 聚合计数字段**不构成足够的错误契约**——前端必须能不追加一次 REST 调用就向用户展示"第一条失败的具体原因"。

**机制：**
- Batch 路径的 writer 在 catch 里同步抽取三个字段（`AstackError` 实例走 `code` + `details.git_stderr` / `details.skill_name` 等结构化键；非 `AstackError` 走 `undefined` fallback 保持可序列化）
- `BatchXxxResponseSchema.outcomes` 的 Zod 定义把 `error_code` / `error_detail` 声明为 `.optional()`（兼容只带 `error` 的老消费方），前端代码里优先 `error_detail > error > 通用文案` 逐级降级
- 评审 checklist：任何新增 batch API，若 response 只有 `{ success, error }` 二元组就是违规——哪怕第一版用户看不到 detail，字段位置也要先留好，否则后续扩张是 schema breaking change

**反例：** v0.6 前 `BatchResolveResponse.outcomes` 元素只有 `{ skill_id, success, error? }`；`resolve-all-conflicts` 点击后 38 条失败的 toast 只能显示"Resolved 0, 38 failed"，用户无法判断究竟是"本地 drift + upstream 也动"还是"镜像脏态"还是"skill 被删"——需要额外 `GET /api/sync-logs/:repo_id?limit=1` 一跳才能定位。v0.6 PR2 + PR3 同时扩 schema + UI 展开首 3 条 `error_detail` 闭环。

---

### Spec 设计规则（续）

#### R5 · 代码引用必须 `函数名:行号` 双锚点

> 关联反模式：P5

Spec 中引用现有代码位置（如 "`sync.ts:471` 的 pull"）时，必须同时标注**所在函数名**和**行号**两个锚点；仅行号会在文件内邻近函数间张冠李戴（尤其是 500+ 行的 service 文件，多个 `async fooOne() { await this.git.pull(...) }` 模式会出现在不同函数中）。

**机制：**
- 写 spec 时对每个行号引用执行两步验证：① 行号对应的语句确实是想引用的调用 ② 该行所在的最近 `async methodName(` 声明与 spec 描述的函数名一致
- 引用格式统一为 `functionName (file.ts:line)` 而非 `file.ts:line`
- 批量引用时加一张锚点表（"所有 `git.pull` 调用点：`pullOne (sync.ts:177)` / `pushOne (sync.ts:471)` / `resolve (sync.ts:670)`"）

**反例：** v0.6-mirror-hygiene §1.4 把 `sync.ts:471` 标注为 "`pullBatchUnderLock` 的内层 pull"；实际该行位于 `pushOne` 内部，`pullBatchUnderLock` 通过 `pullOne` 间接 pull。后续 `ensureMirrorClean` 会被插到错误函数，还会为 custom 仓库 push 流程的合法 commit+push 中间态引入误 reset

---



## 归档规则

> 📦 已归档的规则不参与评审加载，但保留供查阅和检索。
> 归档原因通常为：连续 5 个迭代未被触发 / 相关模块已重构 / 被更精确的新规则替代。

（待积累）
