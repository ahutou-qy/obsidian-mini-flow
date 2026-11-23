// ==============================================
// Mini Flow - CLI 侧任务路径解析（2026-11-23 从 _rule-ops.js 抽出）
//
// `mf.js` 的多个子命令都要「给目录 / 给 README / 给单文件 <名>.md，统一落到
// vault 相对的任务文件路径」。三条链路（rule 操作、任务元数据编辑）共用这一份，
// 别各写一套——三种形态的判定顺序错了会静默落到错文件。
//
// 只做定位，不读 frontmatter、不判 type（那是调用方的事）。
// ==============================================

const path = require("node:path");

// vault 相对路径归一：统一 `/`、去首尾斜杠、剥掉 vault 根前缀（用户可能给绝对路径）。
function toRel(raw, root) {
  let p = String(raw == null ? "" : raw).replace(/\\/g, "/").trim();
  if (!p) return "";
  const r = root ? String(root).replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) p = p.slice(r.length + 1);
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

// 定位任务文件（folder 任务 README 或单文件任务）：给目录 / 给 .md 都收。
// 返回 vault 相对路径（带 .md）。三种形态的候选顺序：
//   带 .md 的入参 → 只按它找（不猜它是目录）
//   不带 .md      → 先当目录 <p>/README.md，再当单文件 <p>.md
// 找不到 → CliError(2)（调用方注入 die，保持各自的错误类）。
function resolveTaskFile(vault, raw, root, die) {
  if (!raw) die(2, "需要 --task/--path <任务目录或 README 路径>");
  const rel = toRel(raw, root);
  if (!rel) die(2, "需要 --task/--path <任务目录或 README 路径>");
  const candidates = /\.md$/i.test(rel)
    ? [rel]
    : [`${rel}/README.md`, `${rel}.md`];
  for (const c of candidates) {
    const f = vault.getAbstractFileByPath(c);
    if (f && !f.children) return c; // children 只在目录上有
  }
  die(2, `任务文件不存在：${rel}（试过 ${candidates.join("、")}）`);
}

// 任务文件形态：folder 任务的 README vs 单文件任务。
function taskKindOf(rel) {
  return /(?:^|\/)README\.md$/i.test(rel) ? "folder" : "single";
}

// vault 相对任务文件的目录（folder 任务 = 任务根；单文件 = 所在月目录）。
function taskDirOf(rel) {
  return String(rel).replace(/\/[^/]+$/, "");
}

module.exports = { toRel, resolveTaskFile, taskKindOf, taskDirOf, posix: path.posix };
