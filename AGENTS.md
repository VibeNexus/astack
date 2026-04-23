# astack

> 本文件是项目的导航地图，详细内容通过链接指向对应文档。

## 1. 项目定位

待补充

## 2. 核心开发原则

1. Spec 驱动：先设计后编码，所有功能变更必须有对应 Spec
2. 文档即权威：Spec 文档是开发和评审的唯一权威依据
3. 最小改动：只修改方案涉及的文件和模块，不扩散重构
4. 机械校验优于人工约定：能用 lint 检查的规则不靠自觉遵守
5. 知识回流：评审和 CR 中的发现自动沉淀为团队知识

## 3. 权威文档

- `docs/version/` — 版本设计文档（Spec）
- `docs/retro/golden-rules.md` — 黄金法则（评审自动沉淀）

## 4. 导航索引

| 文档 | 内容 | 维护方式 |
|------|------|---------|
| [`docs/version/INDEX.md`](docs/version/INDEX.md) | 迭代状态表 | `/spec`、`/mr` 自动维护 |
| [`docs/version/BOUNDARIES.md`](docs/version/BOUNDARIES.md) | 迭代边界规则 | `/spec` 自动维护 |
| [`docs/retro/golden-rules.md`](docs/retro/golden-rules.md) | 黄金法则（活跃规则） | `/spec_review`、`/code_review` 自动沉淀 |
| [`docs/retro/patterns.md`](docs/retro/patterns.md) | 反模式库 | 同上 |

### 4.1 `docs/version/` 文件命名规范

所有迭代相关文档统一使用 `v<major>.<minor>-<kebab-slug>` 作为 **slug**，按用途区分后缀：

| 文件类型 | 命名模板 | 举例 | 谁生产 |
|---------|---------|------|--------|
| Spec 正文（迭代设计文档，权威） | `v0.X-<slug>.md` | `v0.7-local-skills.md` | `/spec` |
| Spec 评审记录（sidecar） | `v0.X-<slug>_REVIEW.md` | `v0.7-local-skills_REVIEW.md` | `/spec_review` |
| 代码评审报告（sidecar） | `v0.X-<slug>_CR.md` | `v0.6-mirror-hygiene_CR.md` | `/code_review` |
| 其他专项报告 | `v0.X-<slug>_<UPPER_SNAKE>.md`（如 `_SPIKE`、`_POSTMORTEM`） | `v0.2-spike-report.md`（历史遗留，新增统一用后缀式） | 人工或对应命令 |

**规则：**

1. **slug 不变**：同一迭代的 spec / REVIEW / CR 共用同一 slug，`ls v0.X-*.md` 一把捞齐该迭代全部文档。
2. **sidecar 不进 INDEX 主列**：`INDEX.md` 的主行只链 spec 正文；sidecar 通过 spec 文档内部引用或 INDEX 的状态列内联链接。
3. **禁止新的风格**：不再使用 `IterationX.Y_PascalSlug_*.md` 之类的风格，历史文件已在 v0.8 / 2026-04-23 统一 rename。
4. **不在 `docs/version/` 下放非迭代文档**：泛技术笔记走 `docs/<topic>/`，不占 `v0.X` 命名空间。

## 5. 当前活跃迭代

**最近完成：** v0.8 — Auto-adopt Reflow（2026-04-23，[spec](docs/version/v0.8-bootstrap-reflow.md)）— 修复"先注册项目→后加 repo→UI 不更新"的闭环 bug：`origin='auto'` LocalSkill 允许被 scanRaw 重分类，subscribe 成功后翻 `name_collision`；前端 `loadBootstrap` 切到幂等写；R8 / P8 沉淀至 retro

**历史完成：**
- v0.7 — Local Skills as First-Class Citizens（2026-04-23，[spec](docs/version/v0.7-local-skills.md)）— PR1–PR6 全部落地，LocalSkill 作为一等公民域概念上线；UnmatchedBanner 常驻 / auto-adopt 仅 bootstrap 触发 / jsdom 测试坑已沉淀 retro
- v0.6 — Open-source 镜像卫生 + Resolve 路径自愈 + 日志落盘（2026-04-22，[spec](docs/version/v0.6-mirror-hygiene.md)）— PR1–PR5 全部落地，R6/R7/P6/P7 已沉淀至 retro
- v0.5 — Subscription Bootstrap for Legacy Projects（2026-04-21，[spec](docs/version/v0.5-subscription-bootstrap.md)）— PR1–PR5 已落地，PR6 E2E 规划中
- v0.4 — Harness Tab + 系统级 Skill 首次落地（2026-04-20，[spec](docs/version/v0.4-harness-tab.md)）

## 6. gstack

Use the `/browse` skill from gstack for **all web browsing**. Never use `mcp__claude-in-chrome__*` tools.

### Available Skills

- `/office-hours`
- `/plan-ceo-review`
- `/plan-eng-review`
- `/plan-design-review`
- `/design-consultation`
- `/design-shotgun`
- `/design-html`
- `/review`
- `/ship`
- `/land-and-deploy`
- `/canary`
- `/benchmark`
- `/browse`
- `/connect-chrome`
- `/qa`
- `/qa-only`
- `/design-review`
- `/setup-browser-cookies`
- `/setup-deploy`
- `/retro`
- `/investigate`
- `/document-release`
- `/codex`
- `/cso`
- `/autoplan`
- `/plan-devex-review`
- `/devex-review`
- `/careful`
- `/freeze`
- `/guard`
- `/unfreeze`
- `/gstack-upgrade`
- `/learn`
