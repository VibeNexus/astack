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

## 5. 当前活跃迭代

**最近完成：** v0.7 — Local Skills as First-Class Citizens（2026-04-23，[spec](docs/version/v0.7-local-skills.md)）— PR1–PR6 全部落地，LocalSkill 作为一等公民域概念上线；UnmatchedBanner 常驻 / auto-adopt 仅 bootstrap 触发 / jsdom 测试坑已沉淀 retro

**历史完成：**
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
