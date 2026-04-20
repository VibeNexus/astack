#!/bin/bash
# init-harness.sh — Harness 研发流程初始化
#
# 在项目根目录运行，自动检测项目状态并初始化 harness 基础设施：
#   - fresh：   全新项目，从 templates/ 渲染全套治理文档
#   - migrate： 已有 AGENTS.md 但无 INDEX.md，备份 AGENTS.md 并创建空骨架，等待 AI 接手语义迁移
#   - patch：   已初始化，补齐缺失文件
#
# 模板来源：与本脚本同目录的 ../templates/*.tpl
# 占位符：{{PROJECT_NAME}}、{{PROJECT_DESC}}（仅 AGENTS.md.tpl 使用）
#
# 用法:
#   bash <skill-dir>/scripts/init-harness.sh [选项]
#
# 选项:
#   --name <项目名>     项目名称（不提供则交互式询问，仅 fresh 模式需要）
#   --desc <描述>       一句话项目描述（仅 fresh 模式需要）
#   --dry-run           只输出计划，不实际修改
#   --force             覆盖已存在的治理文档
#   --help              显示帮助

set -euo pipefail

# ── 定位脚本与模板目录 ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$SKILL_DIR/templates"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── 参数解析 ──
PROJECT_NAME=""
PROJECT_DESC=""
DRY_RUN=false
FORCE=false
CREATED_FILES=()

while [[ $# -gt 0 ]]; do
    case $1 in
        --name) PROJECT_NAME="$2"; shift 2 ;;
        --desc) PROJECT_DESC="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --force) FORCE=true; shift ;;
        --help)
            head -22 "$0" | tail -20
            exit 0
            ;;
        *) echo "未知参数: $1 (运行 --help 查看用法)"; exit 1 ;;
    esac
done

# ── 工具函数 ──

info() { echo -e "${CYAN}▸${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
action() { echo -e "${BOLD}→${NC} $1"; }

# 从模板渲染到目标路径
# 参数: <template_name> <target_path>
render_template() {
    local tpl_name="$1"
    local target="$2"
    local tpl_path="$TEMPLATES_DIR/$tpl_name"

    if [ ! -f "$tpl_path" ]; then
        warn "模板缺失: $tpl_path"
        return 1
    fi

    if [ -f "$target" ] && [ "$FORCE" != true ]; then
        warn "$target 已存在，跳过（使用 --force 覆盖）"
        return 1
    fi

    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] 将从 $tpl_name 渲染 → $target"
        return 0
    fi

    mkdir -p "$(dirname "$target")"

    # 占位符替换：用 awk 以避免 sed 对特殊字符的转义问题
    awk -v name="${PROJECT_NAME:-}" -v desc="${PROJECT_DESC:-}" '
        { gsub(/\{\{PROJECT_NAME\}\}/, name); gsub(/\{\{PROJECT_DESC\}\}/, desc); print }
    ' "$tpl_path" > "$target"

    CREATED_FILES+=("$target")
    success "创建 $target"
}

# ── 状态检测 ──

echo ""
echo -e "${BOLD}🏗️  Harness 初始化${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

HAS_AGENTS_MD=false
HAS_INDEX_MD=false
HAS_BOUNDARIES_MD=false
HAS_GOLDEN_RULES=false
HAS_PATTERNS=false

[ -f "AGENTS.md" ] && HAS_AGENTS_MD=true
[ -f "docs/version/INDEX.md" ] && HAS_INDEX_MD=true
[ -f "docs/version/BOUNDARIES.md" ] && HAS_BOUNDARIES_MD=true
[ -f "docs/retro/golden-rules.md" ] && HAS_GOLDEN_RULES=true
[ -f "docs/retro/patterns.md" ] && HAS_PATTERNS=true

info "项目目录: $(pwd)"
info "Skill 目录: $SKILL_DIR"
info "AGENTS.md: $( [ "$HAS_AGENTS_MD" = true ] && echo '已存在' || echo '不存在' )"
info "docs/version/INDEX.md: $( [ "$HAS_INDEX_MD" = true ] && echo '已存在' || echo '不存在' )"
info "docs/version/BOUNDARIES.md: $( [ "$HAS_BOUNDARIES_MD" = true ] && echo '已存在' || echo '不存在' )"
info "docs/retro/golden-rules.md: $( [ "$HAS_GOLDEN_RULES" = true ] && echo '已存在' || echo '不存在' )"
info "docs/retro/patterns.md: $( [ "$HAS_PATTERNS" = true ] && echo '已存在' || echo '不存在' )"
echo ""

# 检查模板目录
if [ ! -d "$TEMPLATES_DIR" ]; then
    echo -e "${RED}错误${NC}: 模板目录不存在: $TEMPLATES_DIR"
    echo "请确认脚本位于 skills/harness-init/scripts/ 下，并且 templates/ 与其同级。"
    exit 1
fi

# ── 判断模式 ──

if [ "$HAS_AGENTS_MD" = true ] && [ "$HAS_INDEX_MD" = true ]; then
    info "检测到已完成 harness 初始化，将检查并补全缺失文件"
    MODE="patch"
elif [ "$HAS_AGENTS_MD" = true ]; then
    info "检测到已有 AGENTS.md，将执行迁移瘦身（备份原文件 + 创建空骨架）"
    MODE="migrate"
else
    info "全新项目，将从零初始化"
    MODE="fresh"
fi

echo ""

# ── 收集项目信息（仅 fresh 模式需要） ──

if [ "$MODE" = "fresh" ]; then
    if [ -z "$PROJECT_NAME" ]; then
        DEFAULT_NAME=$(basename "$(pwd)")
        read -p "项目名称 [$DEFAULT_NAME]: " INPUT_NAME
        PROJECT_NAME="${INPUT_NAME:-$DEFAULT_NAME}"
    fi

    if [ -z "$PROJECT_DESC" ]; then
        read -p "一句话项目描述: " PROJECT_DESC
        PROJECT_DESC="${PROJECT_DESC:-待补充}"
    fi
fi

# ── 1. 创建目录结构 ──

action "创建目录结构"

if [ "$DRY_RUN" = true ]; then
    info "[dry-run] mkdir -p docs/version docs/retro"
else
    mkdir -p docs/version docs/retro
    success "docs/version/"
    success "docs/retro/"
fi

echo ""

# ── 2. 创建/迁移 AGENTS.md ──

if [ "$MODE" = "fresh" ]; then
    action "创建 AGENTS.md"
    render_template "AGENTS.md.tpl" "AGENTS.md" || true

elif [ "$MODE" = "migrate" ]; then
    action "迁移 AGENTS.md"

    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] 将备份 AGENTS.md → AGENTS.md.bak"
        info "[dry-run] AGENTS.md 迁移需要 AI 辅助执行，请在 Skill 会话中继续"
    else
        cp AGENTS.md AGENTS.md.bak
        success "备份 AGENTS.md → AGENTS.md.bak"
        warn "AGENTS.md 的内容迁移（章节识别、拆分、重写）需要 AI 辅助"
        warn "请返回 Skill 会话，按 SKILL.md 的「第 2 步：AI 接手语义迁移」继续"
        echo ""
    fi
fi

echo ""

# ── 3-6. 从模板渲染治理文档（仅缺失时） ──

[ "$HAS_INDEX_MD" = false ]       && action "创建 docs/version/INDEX.md"       && render_template "INDEX.md.tpl"       "docs/version/INDEX.md"       || true
[ "$HAS_BOUNDARIES_MD" = false ]  && action "创建 docs/version/BOUNDARIES.md"  && render_template "BOUNDARIES.md.tpl"  "docs/version/BOUNDARIES.md"  || true
[ "$HAS_GOLDEN_RULES" = false ]   && action "创建 docs/retro/golden-rules.md"  && render_template "golden-rules.md.tpl" "docs/retro/golden-rules.md" || true
[ "$HAS_PATTERNS" = false ]       && action "创建 docs/retro/patterns.md"      && render_template "patterns.md.tpl"    "docs/retro/patterns.md"      || true

echo ""

# ── 7. 检查命令配置 ──

action "检查命令配置"

REQUIRED_COMMANDS=("spec.md" "spec_review.md" "dev.md" "code_review.md" "mr.md" "retro.md")
MISSING_COMMANDS=()

# 支持 .claude/commands/ 和 commands/ 两种位置
CMD_DIR=""
[ -d ".claude/commands" ] && CMD_DIR=".claude/commands"
[ -z "$CMD_DIR" ] && [ -d "commands" ] && CMD_DIR="commands"

if [ -z "$CMD_DIR" ]; then
    warn "未找到命令目录（.claude/commands/ 或 commands/）"
else
    for cmd in "${REQUIRED_COMMANDS[@]}"; do
        if [ ! -f "$CMD_DIR/$cmd" ]; then
            MISSING_COMMANDS+=("$cmd")
        fi
    done

    if [ ${#MISSING_COMMANDS[@]} -eq 0 ]; then
        success "所有核心命令已就绪: ${REQUIRED_COMMANDS[*]}"
    else
        warn "在 $CMD_DIR/ 下缺少以下命令: ${MISSING_COMMANDS[*]}"
        warn "请将 harness 命令集复制到 $CMD_DIR/"
    fi
fi

echo ""

# ── 汇报 ──

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}📋 初始化完成${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[dry-run 模式] 未实际修改任何文件${NC}"
    echo ""
fi

echo "模式: $MODE"

if [ ${#CREATED_FILES[@]} -gt 0 ]; then
    echo ""
    echo "创建的文件:"
    for f in "${CREATED_FILES[@]}"; do
        echo "  + $f"
    done
fi

if [ ${#MISSING_COMMANDS[@]} -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}待处理:${NC}"
    echo "  - 复制缺失的命令到 $CMD_DIR/"
fi

if [ "$MODE" = "migrate" ] && [ "$DRY_RUN" != true ]; then
    echo ""
    echo -e "${YELLOW}待处理:${NC}"
    echo "  - 返回 Skill 会话完成 AGENTS.md 的语义迁移（脚本只做了机械备份）"
    echo "  - 迁移完成后可删除 AGENTS.md.bak"
fi

echo ""
echo "项目结构:"
echo "  ."
[ -f "AGENTS.md" ] && echo "  ├── AGENTS.md"
echo "  └── docs/"
echo "      ├── version/"
[ -f "docs/version/INDEX.md" ] && echo "      │   ├── INDEX.md"
[ -f "docs/version/BOUNDARIES.md" ] && echo "      │   └── BOUNDARIES.md"
echo "      └── retro/"
[ -f "docs/retro/golden-rules.md" ] && echo "          ├── golden-rules.md"
[ -f "docs/retro/patterns.md" ] && echo "          └── patterns.md"

echo ""
if [ "$MODE" = "fresh" ]; then
    echo -e "下一步: 运行 ${CYAN}/spec${NC} 创建第一个迭代"
fi
echo ""
