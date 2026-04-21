# 反模式库

> 从历次评审和开发中识别的反模式，每条关联对应的黄金法则。
> 编号全局唯一递增（P1, P2, ...）。

## 设计类反模式

### P1 · "幻象复用" — 声称复用的能力其实不存在

**现象：** Spec 说"复用现有的 `subscription.added` SSE 事件" / "复用 `DEFAULT_SCAN_CONFIG` 涵盖所有 root"，但代码里该事件未定义 / 配置不含声称的字段。

**根因：** spec 作者凭对系统的"大致印象"编写复用计划，未在写 spec 时逐一 grep 代码验证。

**危害：**
- 研发按 spec 实现时突然撞墙（测试用例"SSE 发 1 次"写不出来）
- 评审过不了 C 维度（代码可达性）
- 轻则返工，重则整个 PR 阻塞

**案例：**
- v0.5-subscription-bootstrap spec §A7 假设复用 `subscription.added` → 代码里 `EventType` 枚举（`schemas/events.ts:32-76`）不含该成员，`subscription.ts` 全文 `events.emit` 0 命中
- v0.5-subscription-bootstrap spec §A6 声称 `DEFAULT_SCAN_CONFIG` "涵盖 skills + commands + agents" → `domain.ts:202-207` 实际只含 skills + commands

**关联黄金法则：** R1

---

### P2 · "同一接口三处定义不一致"

**现象：** 同一个 API / Service 方法的 response/request shape 在 spec 的决策段、数据流图、测试用例段出现不同字段集。

**根因：** spec 迭代过程中某一段落的改动未同步到其他相关段落；或不同作者分段写导致契约漂移。

**危害：**
- 研发写 schema 时不知道该信哪个
- 前端和后端按不同版本的 spec 实现，集成时才发现契约断裂
- Reviewer 无法判断哪个是"作者真正的意图"

**案例：**
- v0.5-subscription-bootstrap `applyResolutions` response：§A4 写 `{subscribed, failed}`、§3.3 写 `{subscribed, ignored, failed}`、PR3 test 4 又隐含需要 `ignored_local` 写入路径；三处字段集互不相同

**关联黄金法则：** R2

---

### P3 · "写路径横跨多个 PR 的 schema 漂移"

**现象：** 数据 schema 扩展（如加新字段）放在 PR1，但某个必须同步改造的写入点（如 `rewriteManifest` 必须保留新字段）被放到 PR2。PR1 落地后到 PR2 前的时间窗内，存在"其他写路径会清空新字段"的 bug。

**根因：** PR 切片按"功能模块"而非"数据一致性边界"切分；搭便车改动没有被识别为 schema 扩展的原子部分。

**危害：**
- PR1 单独 merge 后系统处于不一致状态，任何依赖该字段的路径都有回归风险
- 集成测试不覆盖中间态就很难发现

**案例：**
- v0.5-subscription-bootstrap PR1 只加 `ignored_local` schema；PR2 才改 `rewriteManifest` 保留该字段 — PR1 merge 后任何 subscribe/unsubscribe 触发的 rewriteManifest 会清空 `ignored_local`

**关联黄金法则：** R3

---

## 实现类反模式

### P4 · "未 try/catch 的 fire-and-forget 路径里调用会抛错的下游"

**现象：** 事件订阅 handler 或 `void promise.catch(swallow)` 路径内，调用一个会抛 `AstackError` 的 service 方法，且循环里没有 per-item try/catch。

**根因：** spec 假定"这个场景不会出现"（如 "collision 不应出现，如出现 = bug"），所以没写降级。但 fire-and-forget 路径的 bug 难于 debug（unhandledRejection），"不应出现"的防御缺失代价很高。

**危害：**
- 生产环境出现一次异常就导致 daemon 侧日志污染，长期运行可能累积 unhandledRejection 触发 Node 崩溃
- 测试里 mock 一个错误输入就能让 handler 挂起

**案例：**
- v0.5-subscription-bootstrap `autoSubscribeMatched` 调 `SubscriptionService.subscribe` 时 `ensureNoFileCollision` 会抛 AstackError；spec §A4 写"不 raise" 但没说谁来 try/catch

**正向参考：** `subscription.ts:287-313` `subscribeBatch` 的 per-ref try/catch 模式

**关联黄金法则：** R4

---

## 流程类反模式

（待积累）
