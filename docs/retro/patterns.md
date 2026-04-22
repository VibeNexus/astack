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

---

## 设计类反模式（续）

### P5 · "同文件邻近函数的行号张冠李戴"

**现象：** Spec 声称 "`ServiceX.methodA` 在 `file.ts:471` 调用 `git.pull`"，但实际 `file.ts:471` 所在函数是 `methodB`，`methodA` 根本不直接调该操作（可能通过另一路径间接触达）。当 spec 要求"在 methodA 的 pull 前插入护栏"时，研发会照行号实现，结果护栏加在 `methodB` 内，语义完全错位。

**根因：** Spec 作者凭"大概印象 + 搜索行号"编写引用，未核对该行号所在的最近 `async methodName(` 声明；500+ 行的 service 文件里多个函数体内都有 `await this.git.pull(...)` 的相似模式，仅凭行号无法消歧。

**危害：**
- 护栏/修复被加到错误函数体内，原目标场景未被覆盖
- 可能在"合法的中间态"场景误触发破坏性操作（如 push 流程 pre-pull 的 dirty 是 commit+push 中间态，若被误识别为 pullBatchUnderLock 的脏态而 reset，会清掉用户待 push 的改动）
- 评审不够细致时很难发现（代码引用看上去精确）

**案例：**
- v0.6-mirror-hygiene §1.4 把 `sync.ts:471` 标注为 "`pullBatchUnderLock` 的内层 pull"；实际 `sync.ts:322–431` 的 `pullBatchUnderLock` 不直接调 `git.pull`，而是通过 `pullOne`（line 359 → 177）间接调用；`sync.ts:471` 真实位于 `pushOne`（line 443 开始）内部，是 push 前对 upstream 的刷新

**关联黄金法则：** R5

---

## 实现类反模式（续）

### P6 · "A 防了 B 没防" — 同一 git 操作在多 Service 间护栏不对称

**现象：** Service A 的某路径对 `git.pull / push / reset` 加了脏态守门或自愈逻辑（`if (!isClean) skip` / `if (!isClean) reset`），Service B 的路径走同一 git 操作却没有任何守门，两个 Service 在同一资源（同一镜像 / 同一 working copy）上并存；用户从 B 路径触发操作时，A 建起的不变式被悄悄击穿。

**根因：** 护栏通常在 Service A 中因某次 bug 而补上，但作者未做"该 git 操作的全局调用点盘点 + 对称性检查"；Service B 被加进来或后来扩展时，reviewer 只审 B 的改动 diff，看不到 A 已经建立的 invariant，以为"正常调 pull 就行"。

**危害：**
- 一次手工 / 脚本 / 外部工具留下的状态异常（脏 working copy / detached HEAD / 未合并的 merge）**只在 A 路径被正确处理**，用户无意中走到 B 路径时整个资源"静默卡住"
- 因为错误通常被 AstackError 抛出后再在 batch outcome 聚合层糊成"failed: N"（见 P7），用户甚至无法从 UI 感知根因
- 自测永远覆盖不到：A 服务的测试套件保证 A 健壮，B 服务的测试用 clean fixture 启动，A 建立的 invariant 对 B 是隐式假设

**案例：**
- v0.6-mirror-hygiene 触发事件：`services/repo.ts::refresh (repo.ts:262-280)` 对 `kind=open-source` 仓库有 `isClean()` 跳过（脏态 → `repo.refresh.dirty_skip` warn + skip pull），而 `SyncService.pullOne (sync.ts:177)` 与 `SyncService.resolve (sync.ts:670)` 同样对 `open-source` 仓库裸调 `git.pull` —— PrivSeal 项目"Use remote (38)"点击后所有 38 个订阅因 `~/.astack/repos/gstack/qa/SKILL.md` 一行手工追加而全部 fail

**正向参考：** v0.6 PR1 引入 `SyncService.ensureMirrorClean(repo)` 私有方法，在 pull 前统一做 `kind` 路由（custom early-return）+ `isClean()` 探测 + `reset --hard` 自愈 + SSE 广播，把对称性收敛到一个方法内。

**关联黄金法则：** R6

---

## 流程类反模式（续）

### P7 · "文档声称有但代码没落地" — 配置字段 / 命令 / 扩展点在代码里悬空

**现象：** 配置文件定义了某字段（如 `config.logFile: "~/.astack/daemon.log"`），文档 / `--help` / config schema 里都提到它"的用途是 X"，但代码从未真正读取或消费该字段；或相反，代码里有某能力但 deploy 配置 / 用户文档从未提及。字段存在 → 用户有合理预期 → 触发场景时发现行为和文档不一致，靠 `grep` 源码才定位到"从未被 open"。

**根因：**
- 早期实现时"先建 config schema 占位，下个迭代接"—— 下个迭代忘了或 descope 了，但 config 字段保留下来像已落地
- 重构时把某能力从一个 Service 挪到另一个，原 Service 的 config 字段忘了清除
- 文档驱动开发时先写了 `--log-file`，实现时只 wire 了内存 logger

**危害：**
- 用户排障时走入死胡同：`tail -f ~/.astack/daemon.log` → "no such file"，去查 `astack server logs` → "no log file yet"，只能额外跑 strace / dtrace 才发现根本没写过
- 让 `/code_review` 的"配置 → 实现 → 文档"三面检查失灵；类似字段可能还有多个，维护成本递增
- 用户信任受损："他们文档里的别的字段也可能不生效？"

**案例：**
- v0.6-mirror-hygiene 触发事件：`config.logFile = "~/.astack/daemon.log"` 从 v0.1 config schema 起就存在，文档 `/README.md` 与 `astack server logs` help 都暗示该日志文件会被写入；但 `createLogger` 默认只写 `process.stderr`（`logger.ts:50`），`startDaemon` 从未把 logger stream 重定向到 `config.logFile`（`daemon.ts:76`）—— 用户第一次真正需要排障时 `astack server logs` 永远返回 "no log file yet"，被迫用 `nohup astack server start > daemon-restart.log 2>&1` 这种 shell 侧的 workaround

**正向参考：** v0.6 PR4 `startDaemon` 内部 `fs.createWriteStream(config.logFile, {flags:"a"})` + `createLogger(level, [process.stderr, logFileStream])` tee；新增测试断言 `config.logFile` 真的被写入 `daemon.started` + `daemon.stopped`，防止未来回归。

**关联规则：** 尚无专用黄金法则（R* 位置保留）；临时检查项："每次 `/code_review` 对 config schema 做一次字段级 grep，确认每个字段至少有 1 个读取点"。

---

