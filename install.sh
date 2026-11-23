#!/usr/bin/env bash
# ==============================================================================
# install.sh — macOS 侧把 Mini Flow 共享仓挂载进 Obsidian vault
#
# 与 install.ps1（Windows）**共用同一张挂载表 mounts.json**（唯一真源），
# 不另写一份路径判据。改挂载点只改 mounts.json。
#
# 用法：
#   ./install.sh --vault ~/vaults/my-vault
#   ./install.sh --vault ~/vaults/my-vault --dry-run     # 只看将做什么
#   ./install.sh --vault ~/vaults/my-vault --verify      # 只读核对
#   ./install.sh --vault ~/vaults/my-vault --uninstall   # 拆挂载并还原
#
# 行为（与 install.ps1 对齐）：
#   - 幂等：已挂载且指向正确的条目跳过，连跑两次第二次全 skip
#   - 目录与单文件都用 symlink（macOS 没有 junction 概念，也不需要管理员权限）
#   - 替换 vault 里的真实内容前先备份到 <vault>/.miniflow-backup/<时间戳>/
#   - --uninstall：移除挂载点，并从备份还原；备份里没有的（安装时内容本就一致）
#     从共享仓补回——两边逐字节一致，补回来就是原样
#   - 装完写共享仓根的 .miniflow-local.json（本机定位文件，逐机器、不进 git）：
#     代码抽走后「vault 在哪」不能从代码位置推（Node 把 symlink 解析成真实路径），
#     由这个文件兜底，见 scripts/quickadd/mini/_vault-root.js
#
# 与 Windows 版的差别：mac 侧**不需要 --refresh**——它从 git pull 拿最新，
# 不存在「vault 里有比共享仓更新的改动」这种情况（win 侧首挂才有）。
#
# 依赖：bash + node（解析 mounts.json；mac 上跑 Claude Code 就有 node）。
#       node 不在时用 python3 兜底。
# 退出码：0 成功 / 1 有错误 / 2 用法错误。
# ==============================================================================
set -euo pipefail

usage() {
  cat <<'EOF'
用法：install.sh --vault <vault 根> [--shared <共享仓根>] [--dry-run|--verify|--uninstall]
  --vault     Obsidian vault 根目录（含 .obsidian/ 与 flow/ 的那一层）；不给则用当前目录
  --shared    共享仓根目录，默认取本脚本所在目录
  --dry-run   只打印将执行的动作，零副作用
  --verify    只读核对：每条挂载是否指向正确目标、配置是否漂移
  --uninstall 移除挂载点并还原挂载前的内容
EOF
}

VAULT=""
SHARED="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
VERIFY=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --vault)   VAULT="${2:-}"; shift 2 ;;
    --shared)  SHARED="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --verify)  VERIFY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$VAULT" ] || VAULT="$PWD"
VAULT="$(cd "$VAULT" && pwd)"
SHARED="$(cd "$SHARED" && pwd)"

if [ "$UNINSTALL" -eq 1 ] && [ "$VERIFY" -eq 1 ]; then
  echo "--uninstall 与 --verify 不能同时用。" >&2; exit 2
fi
if [ ! -d "$VAULT" ]; then
  echo "vault 根目录不存在：$VAULT" >&2; exit 2
fi
if [ ! -f "$SHARED/mounts.json" ]; then
  echo "找不到挂载表 $SHARED/mounts.json" >&2; exit 2
fi

# ---------- JSON 读取（node 优先，python3 兜底） ----------

JSON_READER=""
if command -v node >/dev/null 2>&1; then
  JSON_READER="node"
elif command -v python3 >/dev/null 2>&1; then
  JSON_READER="python3"
else
  echo "需要 node 或 python3 来解析 mounts.json，两个都没有。" >&2; exit 1
fi

# 输出每行：id <TAB> type <TAB> vault相对路径 <TAB> 共享仓相对路径
list_mounts() {
  if [ "$JSON_READER" = "node" ]; then
    node -e '
      const t = require(process.argv[1]);
      for (const m of t.mounts) console.log([m.id, m.type, m.vault, m.shared].join("\t"));
    ' "$SHARED/mounts.json"
  else
    python3 - "$SHARED/mounts.json" <<'PY'
import json, sys
t = json.load(open(sys.argv[1], encoding="utf-8"))
for m in t["mounts"]:
    print("\t".join([str(m["id"]), m["type"], m["vault"], m["shared"]]))
PY
  fi
}

# 输出：vault相对路径 <TAB> 共享仓相对路径（配置不挂载，单独核对）
config_pair() {
  if [ "$JSON_READER" = "node" ]; then
    node -e '
      const t = require(process.argv[1]);
      if (t.config) console.log([t.config.vault, t.config.shared].join("\t"));
    ' "$SHARED/mounts.json"
  else
    python3 - "$SHARED/mounts.json" <<'PY'
import json, sys
t = json.load(open(sys.argv[1], encoding="utf-8"))
c = t.get("config")
if c:
    print("\t".join([c["vault"], c["shared"]]))
PY
  fi
}

# 把（可能相对的）链接目标解析成绝对路径；不要求目标存在
abs_target() {
  if [ "$JSON_READER" = "node" ]; then
    node -e 'const p=require("path");console.log(p.resolve(process.argv[1],process.argv[2]))' "$1" "$2"
  else
    python3 - "$1" "$2" <<'PY'
import os, sys
print(os.path.abspath(os.path.join(sys.argv[1], sys.argv[2])))
PY
  fi
}

# 配置键集合比对（2026-11-21 改，与 install.ps1 / _config.test.js 同款判据）：
# **只比键集合、不比取值**——deliveryDomains 等业务口径项与 paths 组各机必然不同，
# 比取值会把「按自己的 vault 填配置」报成漂移。输出差异的组名，空 = 一致。
# 组名单取**两边出现过的全部顶层键**，不写死（2026-11-23 改）：此前硬编码
# modules/behavior/paths 三组，example 2026-11-22 新增 `i18n` 顶层组后，缺它的机器
# 照样报「键集合一致」——mac 那次就是这么漏掉的。标量值没有键，按「无键」参与比较。
config_keyset_drift() {
  if [ "$JSON_READER" = "node" ]; then
    node -e '
      const fs = require("fs");
      const load = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch (_e) { return {}; } };
      const keyset = (o, g) => {
        const v = o[g];
        return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().join(",") : "";
      };
      const A = load(process.argv[1]), B = load(process.argv[2]);
      const groups = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
      const bad = groups.filter((g) => keyset(A, g) !== keyset(B, g));
      if (bad.length) console.log(bad.join("、"));
    ' "$1" "$2"
  else
    python3 - "$1" "$2" <<'PY'
import json, sys
def load(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}
def keyset(o, g):
    v = o.get(g)
    return ",".join(sorted(v)) if isinstance(v, dict) else ""
A, B = load(sys.argv[1]), load(sys.argv[2])
groups = sorted(set(A) | set(B))
bad = [g for g in groups if keyset(A, g) != keyset(B, g)]
if bad:
    print("、".join(bad))
PY
  fi
}

# ---------- 状态探测 ----------

# 打印：symlink / dir / file / missing
kind_of() {
  if [ -L "$1" ]; then echo "symlink"
  elif [ -d "$1" ]; then echo "dir"
  elif [ -f "$1" ]; then echo "file"
  else echo "missing"; fi
}

# 内容是否一致（目录逐文件比，单文件比字节）
same_content() {
  if [ -d "$1" ] && [ -d "$2" ]; then
    diff -rq "$1" "$2" >/dev/null 2>&1
  elif [ -f "$1" ] && [ -f "$2" ]; then
    cmp -s "$1" "$2"
  else
    return 1
  fi
}

BACKUP_ROOT=""
ensure_backup_root() {
  if [ -z "$BACKUP_ROOT" ]; then
    BACKUP_ROOT="$VAULT/.miniflow-backup/$(date +%Y%m%d-%H%M%S)"
  fi
}

backup_existing() { # $1=vault绝对路径 $2=vault相对路径
  ensure_backup_root
  local dest="$BACKUP_ROOT/$2"
  mkdir -p "$(dirname "$dest")"
  cp -R "$1" "$dest"
  echo "    已备份到 $dest"
}

remove_link() { # 只删链接本身，不碰目标
  rm "$1"
}

write_local_locator() {
  # 不写 BOM：Node 的 JSON.parse 吃不下 BOM 前缀
  printf '{\n  "vault_root": "%s"\n}\n' "$VAULT" > "$SHARED/.miniflow-local.json"
  echo "本机定位文件：$SHARED/.miniflow-local.json"
}

# ---------- 安装 ----------

do_install() {
  local created=0 skipped=0 problems=0
  while IFS="$(printf '\t')" read -r id type vrel srel; do
    [ -n "$id" ] || continue
    local vpath="$VAULT/$vrel" spath="$SHARED/$srel"
    local label="[$id] $vrel"

    if [ ! -e "$spath" ]; then
      echo "WARN $label 跳过：共享仓里没有 $srel" >&2
      problems=$((problems+1))
      continue
    fi

    local kind; kind="$(kind_of "$vpath")"
    # 期望目标也过同一解析器：链接里存的路径形式（相对/绝对、平台写法）可能与
    # $spath 的字面形式不同，直接比字符串会误判成「指向别处」→ 幂等失效。
    local expected; expected="$(abs_target "$SHARED" "$srel")"

    if [ "$kind" = "symlink" ]; then
      local target; target="$(readlink "$vpath")"
      local resolved; resolved="$(abs_target "$(dirname "$vpath")" "$target")"
      if [ "$resolved" = "$expected" ]; then
        echo "$label 已挂载，跳过（幂等）"
        skipped=$((skipped+1))
        continue
      fi
      echo "$label 原挂载点指向别处（$target），改指共享仓"
      [ "$DRY_RUN" -eq 1 ] || remove_link "$vpath"
      kind="missing"
    fi

    if [ "$kind" = "dir" ] || [ "$kind" = "file" ]; then
      if same_content "$vpath" "$spath"; then
        echo "$label vault 内容与共享仓一致，直接替换为挂载点"
      else
        echo "WARN $label vault 内容与共享仓有差异，先备份再替换" >&2
        if [ "$DRY_RUN" -eq 0 ]; then
          backup_existing "$vpath" "$vrel"
        fi
      fi
      if [ "$DRY_RUN" -eq 0 ]; then
        rm -rf "$vpath"
      fi
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
      echo "$label [dry-run] 将建立 symlink -> $srel"
      continue
    fi

    mkdir -p "$(dirname "$vpath")"
    ln -s "$spath" "$vpath"
    echo "$label 已建立 symlink -> $srel"
    created=$((created+1))
  done < <(list_mounts)

  if [ -n "$BACKUP_ROOT" ]; then
    echo ""
    echo "备份目录：$BACKUP_ROOT"
    echo "（--uninstall 会从这里还原；该目录应列入 vault .gitignore，不进仓）"
  fi
  echo ""
  echo "汇总：新建 $created 条 / 跳过 $skipped 条"
  [ "$problems" -eq 0 ] || return 1
  return 0
}

# ---------- 核对 ----------

do_verify() {
  local problems=0
  while IFS="$(printf '\t')" read -r id type vrel srel; do
    [ -n "$id" ] || continue
    local vpath="$VAULT/$vrel" spath="$SHARED/$srel"
    local kind; kind="$(kind_of "$vpath")"
    local expected; expected="$(abs_target "$SHARED" "$srel")"
    if [ "$kind" = "symlink" ]; then
      local target; target="$(readlink "$vpath")"
      local resolved; resolved="$(abs_target "$(dirname "$vpath")" "$target")"
      if [ "$resolved" = "$expected" ]; then
        echo "OK   [$id] $vrel -> $srel"
      else
        echo "WARN [$id] $vrel 指向别处（$resolved）" >&2
        problems=$((problems+1))
      fi
    else
      echo "WARN [$id] $vrel 不是挂载点（$kind）" >&2
      problems=$((problems+1))
    fi
    if [ ! -e "$spath" ]; then
      echo "     共享仓侧缺 $srel" >&2
      problems=$((problems+1))
    fi
  done < <(list_mounts)

  # 配置不挂载（方案 §五），单独做一致性核对
  local pair; pair="$(config_pair)"
  if [ -n "$pair" ]; then
    local cv cs; cv="${pair%%$'\t'*}"; cs="${pair##*$'\t'}"
    if [ -f "$VAULT/$cv" ] && [ -f "$SHARED/$cs" ]; then
      local drift; drift="$(config_keyset_drift "$VAULT/$cv" "$SHARED/$cs")"
      if [ -z "$drift" ]; then
        echo "OK   配置键集合一致：$cv == $cs（取值各机自定，不比）"
      else
        echo "WARN 配置键集合漂移：$drift 组两边键不同（加了键忘了同步另一边）" >&2
        problems=$((problems+1))
      fi
    else
      echo "WARN 配置核对跳过：共享仓或 vault 侧缺配置文件" >&2
    fi
  fi

  echo ""
  if [ "$problems" -eq 0 ]; then
    echo "核对通过：全部挂载点指向正确，无漂移。"
    return 0
  fi
  echo "核对发现 $problems 处问题。" >&2
  return 1
}

# ---------- 卸载 ----------

do_uninstall() {
  while IFS="$(printf '\t')" read -r id type vrel srel; do
    [ -n "$id" ] || continue
    local vpath="$VAULT/$vrel"
    local kind; kind="$(kind_of "$vpath")"
    if [ "$kind" = "symlink" ]; then
      remove_link "$vpath"
      echo "[$id] $vrel 挂载点已移除"
    elif [ "$kind" = "dir" ] || [ "$kind" = "file" ]; then
      echo "[$id] $vrel 不是挂载点，未动"
    fi
  done < <(list_mounts)

  # 还原：备份里有就还原；没有（安装时内容一致、没触发备份）就从共享仓补回
  local latest=""
  if [ -d "$VAULT/.miniflow-backup" ]; then
    latest="$(ls -1 "$VAULT/.miniflow-backup" 2>/dev/null | sort | tail -1)"
    [ -n "$latest" ] && latest="$VAULT/.miniflow-backup/$latest"
  fi
  [ -n "$latest" ] && { echo ""; echo "从备份还原：$latest"; }

  while IFS="$(printf '\t')" read -r id type vrel srel; do
    [ -n "$id" ] || continue
    local vpath="$VAULT/$vrel" spath="$SHARED/$srel"
    [ "$(kind_of "$vpath")" = "missing" ] || continue
    if [ -n "$latest" ] && [ -e "$latest/$vrel" ]; then
      mkdir -p "$(dirname "$vpath")"
      cp -R "$latest/$vrel" "$vpath"
      echo "  已从备份还原 $vrel"
    elif [ -e "$spath" ]; then
      mkdir -p "$(dirname "$vpath")"
      if [ -d "$spath" ]; then
        mkdir -p "$vpath"
        cp -R "$spath/." "$vpath/"
      else
        cp "$spath" "$vpath"
      fi
      echo "  已从共享仓补回 $vrel（安装时内容一致，未触发备份）"
    else
      echo "WARN $vrel 无备份且共享仓也没有该路径，未能还原" >&2
    fi
  done < <(list_mounts)

  [ -n "$latest" ] && echo "（备份目录本身保留，确认无误后可自行删除）"
  echo ""
  echo "卸载完成：共享仓内容未受影响（挂载点只解除，共享仓目录原样保留）。"
}

# ---------- 入口 ----------

echo "共享仓：$SHARED"
echo "vault ：$VAULT"
echo ""

if [ "$VERIFY" -eq 1 ]; then
  do_verify
  exit $?
fi

if [ "$UNINSTALL" -eq 1 ]; then
  do_uninstall
  exit 0
fi

if do_install; then
  [ "$DRY_RUN" -eq 1 ] || write_local_locator
  exit 0
fi
exit 1
