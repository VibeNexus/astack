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

### 跨层契约规则

（待积累）

---

## 归档规则

> 📦 已归档的规则不参与评审加载，但保留供查阅和检索。
> 归档原因通常为：连续 5 个迭代未被触发 / 相关模块已重构 / 被更精确的新规则替代。

（待积累）
