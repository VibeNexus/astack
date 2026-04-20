---
name: harness-init
description: |
  初始化或迁移项目的 Harness 研发流程治理基础设施（AGENTS.md 导航 + docs/version/ 版本治理 + docs/retro/ 评审沉淀），
  为后续使用 `/spec` `/spec_review` `/dev` `/code_review` `/mr` `/retro` 等命令体系打底。
  当用户说"初始化 harness / 搭建 spec 治理 / 接入研发流程规范 / 给这个项目加上 AGENTS.md / 把旧的 AGENTS.md 拆分瘦身 / setup harness / init harness / bootstrap governance docs"时触发。
  也可在用户尝试使用 `/spec` 等命令但工作区缺失 `AGENTS.md` / `docs/version/INDEX.md` 时主动建议使用本 Skill。
  支持三种模式：全新项目从零初始化（fresh）、已有 AGENTS.md 迁移瘦身（migrate）、已初始化但缺文件的补齐（patch）。
---

# Harness 治理初始化

为项目搭建或迁移 Harness 研发流程的治理文档骨架。本 Skill 配合 `/spec` `/spec_review` `/dev` `/code_review` `/mr` `/retro` 等命令使用——这些命令都依赖统一的治理文档位置（`AGENTS.md`、`docs/version/`、`docs/retro/`），本 Skill 负责把这些位置搭建好或从旧结构迁移过来。

## 何时使用

1. **全新项目**：工作区没有 `AGENTS.md`，用户想接入 Harness 研发流程
2. **迁移项目**：已有 `AGENTS.md` 但内容膨胀（混入迭代状态表、边界规则、变更记录等），需要瘦身为导航结构
3. **补齐项目**：已有 `AGENTS.md` 和 `docs/version/INDEX.md`，但个别治理文件缺失

本 Skill 有两部分能力：**机械化脚手架**（由 `scripts/init-harness.sh` 完成）+ **语义级迁移**（由 AI 在本次会话中完成）。纯机械化工作不需要 AI 理解内容，语义级迁移需要 AI 识别旧 `AGENTS.md` 的章节语义并重排。

## 执行流程

### 第 1 步：运行脚手架脚本

在项目根目录运行：

```bash
bash {SKILL_DIR}/scripts/init-harness.sh
```

> `{SKILL_DIR}` 是本 Skill 所在目录的绝对路径，执行时请替换为实际路径。常见路径为 `skills/harness-init/` 或用户 IDE 缓存路径。

脚本会自动检测项目状态并选择模式：

| 检测条件 | 模式 | 脚本行为 |
|---|---|---|
| 无 `AGENTS.md` | `fresh` | 询问项目名/描述，从 `templates/` 渲染全套治理文档 |
| 有 `AGENTS.md`，无 `docs/version/INDEX.md` | `migrate` | 备份 `AGENTS.md` → `AGENTS.md.bak`，创建空的 `INDEX.md` / `BOUNDARIES.md` / `golden-rules.md` / `patterns.md`，**等待 AI 接手迁移语义** |
| 有 `AGENTS.md` 且有 `docs/version/INDEX.md` | `patch` | 只补齐缺失的治理文件，不动已存在的 |

**常用脚本参数：**

- `--name <项目名>`：非交互式指定项目名（fresh 模式用）
- `--desc <描述>`：非交互式指定一句话描述（fresh 模式用）
- `--dry-run`：只打印计划不实际修改，用于预演
- `--force`：覆盖已存在的治理文档（危险，慎用）

脚本执行完会输出 `模式: fresh|migrate|patch` 和已创建文件列表。根据模式决定是否进入第 2 步。

### 第 2 步（仅 `migrate` 模式）：AI 接手语义迁移

脚本只能机械创建空模板。旧 `AGENTS.md` 的内容需要 AI 按语义识别并迁移——这是脚本无法完成的部分。

**迁移目标：把旧 `AGENTS.md` 从"百科全书"瘦身为"导航地图"**。

#### 2.1 识别膨胀章节

读取 `AGENTS.md.bak`（脚本已备份）的完整内容，按**内容语义**识别以下要素（不依赖固定章节编号或标题）：

| 语义特征 | 迁移目标 |
|---|---|
| 迭代状态表（含迭代编号和状态的表格） | `docs/version/INDEX.md` 主表格 |
| 迭代边界（描述每个迭代范围约束的列表） | `docs/version/BOUNDARIES.md` |
| 变更记录（含日期和变更说明的表格） | `docs/version/INDEX.md` 底部的 `## 变更记录` 段落 |
| 黄金法则/沉淀规则（如有） | `docs/retro/golden-rules.md` 活跃规则区 |
| 反模式/踩坑记录（如有） | `docs/retro/patterns.md` 对应分类 |

#### 2.2 迁移内容到拆分文档

将识别到的内容**追加**到对应文件中（脚本已创建空模板骨架）：

- 迭代状态表 → 按 `INDEX.md` 表头格式规范化，状态值标准化：
  - `待开发` → `🔜 待开发`
  - `开发中` → `🔄 开发中`
  - `已完成` → `✅ 已完成`
  - `已挂起` → `⏸️ 已挂起`
- 迭代边界 → 保留原描述追加到 `BOUNDARIES.md`
- 变更记录 → 追加到 `INDEX.md` 底部 `## 变更记录` 区域

#### 2.3 重写 `AGENTS.md`

把 `AGENTS.md` 重写为 **≤120 行的导航结构**：

- **保留**：项目定位、核心开发原则、权威文档列表等不膨胀的章节原文
- **替换**：已迁移的章节替换为导航索引表（参考 `templates/AGENTS.md.tpl` 中 `## 4. 导航索引` 的格式）
- **新增**：`## 5. 当前活跃迭代` 章节，仅列出状态为 🔜 待开发 / 🔄 开发中 的 1-3 个迭代，减少读者扫描负担

#### 2.4 迁移验证

完成后检查：

1. 拆分文档中的迭代条数 ≥ 原 `AGENTS.md` 迭代状态表行数（不丢失信息）
2. 新 `AGENTS.md` 行数 ≤ 120 行
3. 所有导航链接指向的文件存在
4. 旧 `AGENTS.md` 中的非膨胀章节内容完整保留

### 第 3 步：汇报

无论哪种模式，最后输出：

1. 执行的模式（fresh / migrate / patch）
2. 创建或更新的文件清单
3. 未来操作指引：
   - fresh：`下一步可运行 /spec 创建第一个迭代`
   - migrate：`迁移完成后可删除 AGENTS.md.bak`
   - patch：`已补齐缺失文件`
4. 核心命令（`/spec`、`/spec_review`、`/dev`、`/code_review`、`/mr`、`/retro`）的就绪情况——脚本会检查 `.claude/commands/` 或 `commands/` 下是否有对应文件，缺失则在汇报中提醒

## 目录约定（本 Skill 产出的目标结构）

```
.
├── AGENTS.md                    # 项目导航地图（≤120 行）
└── docs/
    ├── version/
    │   ├── INDEX.md             # 迭代状态总表 + 变更记录
    │   ├── BOUNDARIES.md        # 迭代边界规则
    │   └── Iteration{N}_*.md    # 具体迭代 Spec（由 /spec 命令创建）
    └── retro/
        ├── golden-rules.md      # 黄金法则（活跃 + 归档）
        └── patterns.md          # 反模式库
```

## 关键约束

1. **不丢失信息**：迁移模式下，所有迁出的内容必须完整出现在拆分文档中，可通过行数或条目数对比验证
2. **不改语义**：迁移是搬运，不修改内容含义，措辞可微调但不增减信息
3. **不动业务代码**：本 Skill 只操作 Markdown 文档和治理目录
4. **幂等安全**：拆分文档中已存在的条目不重复添加（patch 模式每次运行都安全）
5. **尊重用户选择**：`--force` 只在用户明确要求时使用；默认保留已存在的文件

## 与命令体系的协作关系

| 命令 | 依赖本 Skill 产出的文件 |
|---|---|
| `/spec` | `docs/version/INDEX.md`、`docs/version/BOUNDARIES.md`、`docs/retro/*`（设计护栏加载） |
| `/spec_review` | `AGENTS.md`、`docs/version/BOUNDARIES.md`、`docs/retro/*`（评审基准） |
| `/dev` | `AGENTS.md`（开发原则） |
| `/code_review` | `docs/retro/golden-rules.md`、`docs/retro/patterns.md`（CR 规则） |
| `/mr` | `docs/version/INDEX.md`（状态流转 + 变更记录） |
| `/retro` | `docs/retro/*`（知识沉淀落点） |

**所以 Harness 命令体系使用前，必须先由本 Skill 搭好治理文档骨架。**

## 参考文件

- `scripts/init-harness.sh` — 机械化脚手架脚本（可通过 `--help` 查看所有参数）
- `templates/` — 治理文档模板，脚本和 AI 共享同一套模板：
  - `AGENTS.md.tpl`
  - `INDEX.md.tpl`
  - `BOUNDARIES.md.tpl`
  - `golden-rules.md.tpl`
  - `patterns.md.tpl`

模板中的 `{{PROJECT_NAME}}`、`{{PROJECT_DESC}}` 等占位符由脚本在渲染时替换。若需要调整模板内容，编辑 `templates/` 下对应文件即可，脚本会自动读取最新版本。
