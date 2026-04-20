# {{PROJECT_NAME}}

> 本文件是项目的导航地图，详细内容通过链接指向对应文档。

## 1. 项目定位

{{PROJECT_DESC}}

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
| [`docs/version/INDEX.md`](docs/version/INDEX.md) | 迭代状态表 + 变更记录 | `/spec`、`/mr` 自动维护 |
| [`docs/version/BOUNDARIES.md`](docs/version/BOUNDARIES.md) | 迭代边界规则 | `/spec` 自动维护 |
| [`docs/retro/golden-rules.md`](docs/retro/golden-rules.md) | 黄金法则（活跃规则） | `/spec_review`、`/code_review` 自动沉淀 |
| [`docs/retro/patterns.md`](docs/retro/patterns.md) | 反模式库 | 同上 |

## 5. 当前活跃迭代

（无活跃迭代）
