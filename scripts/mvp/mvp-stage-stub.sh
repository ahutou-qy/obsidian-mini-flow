#!/usr/bin/env bash
# ==============================================
# MVP - stage-stub：mock 子 claude，按 STAGE_ID 输出固定 snapshot 文本。
#
# 由 `qy task spawn-stage ... --claude-bin <此 stub>` 调用；透传 claude CLI flag
# （--print --dangerously-skip-permissions -p <prompt>），从 prompt 文本 grep
# `阶段 N` 识别 STAGE_ID，按 stage 输出固定 snapshot + exit 0。
#
# **不真写 task README ## 过程 段**（真实链路靠子 claude + obsidian-snapshot
# skill 触发；M4 mock 验证范围 = 串行调度 + audit 落盘 + shlock + prompt 注入
# 路径，snapshot 累计需真跑验证）。plan §M4 验判据降级。
# ==============================================

set -euo pipefail

PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --print|--dangerously-skip-permissions|-p)
      shift
      ;;
    *)
      PROMPT="$1"
      shift
      ;;
  esac
done

STAGE_ID="$(grep -oE '阶段 [0-9]+' <<<"$PROMPT" | head -1 | grep -oE '[0-9]+' || echo "0")"

case "$STAGE_ID" in
  1)
    cat <<'EOF'
阶段 1 snapshot：
  状态：调研完成
  下一步：spawn 阶段 2 实现
  未决：无
  别重蹈：无
EOF
    ;;
  2)
    cat <<'EOF'
阶段 2 snapshot：
  状态：MVPTestDriver.java 已写
  下一步：spawn 阶段 3 验证
  未决：无
  别重蹈：无
EOF
    ;;
  3)
    cat <<'EOF'
阶段 3 snapshot：
  状态：验证完成
  下一步：MVP 整体跑通判据达成
  未决：无
  别重蹈：无
EOF
    ;;
  *)
    cat <<EOF
阶段 ${STAGE_ID} snapshot（未定义 stub 行为）：
  状态：unknown
  下一步：N/A
  未决：无
  别重蹈：无
EOF
    ;;
esac

exit 0