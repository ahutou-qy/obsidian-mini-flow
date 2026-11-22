// ==============================================
// MVP - 共享逻辑：把 task README 状态切到指定 #status 标签。
//
// 由 task-now.js / task-finish-cli.js 两个薄 CLI 调用；standalone 不依赖 Obsidian runtime。
//
// 输入：vaultRoot（vault 根绝对路径）、taskPath（任务目录绝对路径）、targetStatus（active/finish）
// 流程（**两处写面**，与 GUI 侧 `task-finish-gui.js#runFinish` 同款，2026-11-19 段 2 补齐）：
//   1. 读 <taskPath>/README.md，提取 frontmatter 的 source: [[ideas-YYYY-MM#^cap-xxx]]
//   2. 在 <vaultRoot>/flow/data/<year>/Q*/ 下找匹配的 ideas-<YYYY-MM>.md（一年通常只一份）
//   3. 在月度文件里定位含 ^cap-xxx 的行
//   4. finish 时先做 `## 进展` 收口（超 5 条归档 process/R-进展历史.md，_finish.js 同一套）
//   5. 调 _capture-line-rewrite.js#rewriteStatus 改 #status 标签（active 剥 completion / finish 补 completion）
//   6. 写回月度文件（替换原行）
//   7. **写 README frontmatter milestones**（_task.js#appendMilestone，幂等键 {date,type}）：
//      finish → {date, type: finish}；finish → active 的重开 → {date, type: reopen}
//
// 为什么第 7 步不可省：qy 侧 `read_miniflow_status` 先扫 README 的 finish 里程碑，只改月度行
// 会让它落到 `unmaterialized`（P1）。月度行已是 #finish 但 README 缺里程碑的**存量任务**，
// 这里按行内 `[completion:: 日期]` 回填（不是记成今天），幂等重跑不会重复写。
//
// 异步：第 4/7 步复用 Obsidian 侧 helper（async vault 接口），所以本函数是 async，
// 两个薄 CLI 用 `.catch` 收口。fsVault（`_fs-vault.js`）适配 read/modify/create/getAbstractFileByPath。
//
// 退出码（透传给 外部同步 CLI）：
//   0 = 成功
//   2 = usage（参数缺失 / README 缺 source / 路径不存在）
//   3 = parse（source 格式不对 / 找不到 anchor / 找不到 ideas 文件）
//   4 = IO（read / write 失败）
// ==============================================

const fs = require("fs");
const path = require("path");

const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const { rewriteStatus } = require(path.join(MINI, "_capture-line-rewrite.js"));
const { parseCaptureLine } = require(path.join(MINI, "_capture-line.js"));
const { isReopenTransition } = require(path.join(MINI, "_status.js"));
const taskHelpers = require(path.join(MINI, "_task.js"));
const yamlHelpers = require(path.join(MINI, "_yaml.js"));
const finishHelpers = require(path.join(MINI, "_finish.js"));
const { createFsVault } = require("./_fs-vault.js");

const VALID_STATUSES = new Set(["active", "finish"]);

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 错误抛而不是直接 process.exit（2026-11-19 段 3 改）：`mf.js` 要把错误出成 JSON、
// 两个薄 CLI 要出文本，退出码语义两边一致。调用方在 catch 里按 `e.code` 退码。
class SetStatusError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

function err(code, msg) {
  throw new SetStatusError(code, msg);
}

// 简单的 --- 包围 frontmatter 提取（不依赖 Obsidian metadataCache）。
// 必须容忍 CRLF：vault 里任务 README 普遍是 CRLF 行尾（Windows autocrlf），只认 \n 会让
// 所有这类任务 headless finish 报"frontmatter 提取失败"（2026-11-10 修）。
function extractFrontmatter(text) {
  const m = /(^|\r?\n)---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  return m[2];
}

// 从 frontmatter 文本里抠 `source: "[[ideas-YYYY-MM#^cap-xxx]]"`（允许 `../` 相对路径前缀）。
function extractSource(fm) {
  // source 字段值里包双引号 + 双方括号；接受单/双引号包法；capture 写面按层级生成相对链接，
  // 前缀形态（[[../ideas-YYYY-MM#…]]）在 vault 里很常见，正则只认无前缀会让这类任务 headless finish 直接报格式错（2026-11-09 修）。
  const m = /source:\s*["']?\[\[(?:\.\.\/)*(ideas-\d{4}-\d{2})#(\^cap-[A-Za-z0-9-]+)\]\]["']?/.exec(fm);
  if (!m) return null;
  return { file: m[1], anchor: m[2] };
}

// 在 <vaultRoot>/flow/data/<year>/Q*/ 下找匹配 ideas-YYYY-MM.md 的文件。
// 一年正常只一份；极小概率撞多份（手工复制错误）报错让用户处理。
function findIdeasFile(vaultRoot, ideasName) {
  const year = ideasName.slice(6, 10); // "ideas-2026-09" -> "2026"
  const dataDir = path.join(vaultRoot, "flow", "data", year);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) return [];
  const matches = [];
  for (const entry of fs.readdirSync(dataDir)) {
    if (!/^Q\d+$/.test(entry)) continue;
    const candidate = path.join(dataDir, entry, ideasName + ".md");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) matches.push(candidate);
  }
  return matches;
}

// 在文件内容里找第一个含 anchor 的行（行内 substring 匹配）。返回行号（0-based）或 -1。
function findAnchorLine(content, anchor) {
  const lines = content.split("\n");
  return lines.findIndex((l) => l.includes(anchor));
}

// 行内 [completion:: YYYY-MM-DD] 的日期（无则 null）。存量回填里程碑用它，不记成今天。
function completionDateOf(line) {
  const m = /\[completion::\s*(\d{4}-\d{2}-\d{2})\s*\]/i.exec(String(line || ""));
  return m ? m[1] : null;
}

// 绝对路径 → vault 相对路径（`/` 分隔，fsVault 的口径）。
function vaultRel(vaultRoot, absPath) {
  return path.relative(path.resolve(vaultRoot), absPath).replace(/\\/g, "/");
}

async function setStatus({ vaultRoot, taskPath, targetStatus, quiet = false }) {
  if (!VALID_STATUSES.has(targetStatus)) {
    err(2, `targetStatus 非法：${targetStatus}（期望 active/finish）`);
  }
  if (!vaultRoot) err(2, "缺少 vaultRoot");
  if (!taskPath) err(2, "缺少 taskPath");

  const readmePath = path.join(taskPath, "README.md");
  if (!fs.existsSync(readmePath)) err(2, `README.md 不存在：${readmePath}`);

  const readmeText = fs.readFileSync(readmePath, "utf8");
  const fm = extractFrontmatter(readmeText);
  if (!fm) err(2, `README frontmatter 提取失败：${readmePath}`);

  const source = extractSource(fm);
  if (!source) err(3, `README frontmatter source 字段缺失或格式不对（期望 [[ideas-YYYY-MM#^cap-xxx]]）`);

  const ideasFiles = findIdeasFile(vaultRoot, source.file);
  if (ideasFiles.length === 0) err(3, `找不到月度 ideas 文件：${source.file}.md（扫了 ${path.join(vaultRoot, "flow", "data", source.file.slice(6, 10))}/Q*/）`);
  if (ideasFiles.length > 1) err(3, `月度 ideas 文件撞多份：${ideasFiles.join(", ")}，人工处理`);

  const ideasPath = ideasFiles[0];
  const ideasText = fs.readFileSync(ideasPath, "utf8");
  const lines = ideasText.split("\n");
  const lineIdx = findAnchorLine(ideasText, source.anchor);
  if (lineIdx < 0) err(3, `anchor ${source.anchor} 在 ${ideasPath} 里找不到`);

  const today = todayIso();
  const original = lines[lineIdx];
  const parsed = parseCaptureLine(original, path.basename(ideasPath));
  const prevStatus = parsed && parsed.status ? parsed.status : null;

  const vault = createFsVault(vaultRoot);
  const readmeFile = vault.getAbstractFileByPath(vaultRel(vaultRoot, readmePath));
  if (!readmeFile) err(4, `fsVault 取不到 README：${readmePath}`);

  // 收口前置（与 GUI 同款：已 finish 的任务重复触发也做归档）。
  let archivedCount = 0;
  let evidenceWarning = "";
  if (targetStatus === "finish") {
    const before = await vault.read(readmeFile);
    // 上限从配置取（behavior.progressSoftLimit）。本文件是 node 模块（被 mf.js require），
    // 所以能直接 require 同目录树的 _config.js——这与被 loadModule 字符串加载的脚本不同
    // （那些只能走 loadHelper，见 _config.js 头注）。loadSync(vaultRoot) 用本函数已有的
    // vault 根，不靠 cwd / 环境变量猜；读不到就回落默认 5。
    const { loadSync } = require("../quickadd/mini/_config.js");
    const behavior = loadSync(vaultRoot).behavior;
    const progressSoftLimit = behavior.progressSoftLimit;
    archivedCount = finishHelpers.extractProgressOverflow(before, progressSoftLimit).movedCount;
    await finishHelpers.archiveOverflowProgress(vault, readmeFile, today, progressSoftLimit);
    // 交付证据软闸（判据与文案单源在 `_finish.js`）：这条是第四个 finish 写手
    // （mf.js finish / 两个薄 CLI），没有确认框可挂 → 提示进返回对象的
    // `evidenceWarning` 字段（mf.js 原样进 stdout JSON，调用方看得到），
    // 非 quiet 时再补一行人读文本。仍然**不拦**。
    evidenceWarning = await finishHelpers.evidenceWarningFor(vault, readmeFile, yamlHelpers, behavior);
  }

  // 写面一：月度 Capture 行。
  const rewritten = rewriteStatus(original, targetStatus, today);
  const lineChanged = rewritten !== original;
  if (lineChanged) {
    lines[lineIdx] = rewritten;
    fs.writeFileSync(ideasPath, lines.join("\n"), "utf8");
  }

  // 写面二：README frontmatter milestones（幂等键 {date,type}，appendMilestone 自带）。
  let milestone = null;
  if (targetStatus === "finish") {
    // 新推进记今天；已是 #finish 的存量任务按行内 completion 日期回填（缺失才兜今天）。
    milestone = { date: lineChanged ? today : (completionDateOf(rewritten) || today), type: "finish" };
  } else if (isReopenTransition(prevStatus, targetStatus)) {
    milestone = { date: today, type: "reopen" };
  }
  if (milestone) {
    await taskHelpers.appendMilestone(vault, readmeFile, yamlHelpers, milestone);
  }

  const lineMsg = lineChanged
    ? `${path.basename(ideasPath)} L${lineIdx + 1} → #${targetStatus}`
    : `已是 #${targetStatus}，月度行 no-op`;
  const msMsg = milestone ? `里程碑 ${milestone.type}@${milestone.date}` : "里程碑 no-op";
  const arMsg = archivedCount > 0 ? `进展归档 ${archivedCount} 条` : "";
  // quiet：`mf.js` 的 stdout 恒为 JSON，人读的那行文本不能混进去。
  if (!quiet) {
    process.stdout.write(`set-status: ${lineMsg}；${msMsg}${arMsg ? `；${arMsg}` : ""}\n`);
    if (evidenceWarning) process.stdout.write(`${evidenceWarning}\n`);
  }

  return {
    ok: true,
    targetStatus,
    prevStatus,
    lineChanged,
    ideasPath,
    lineIdx,
    milestone,
    archivedCount,
    evidenceWarning,
  };
}

module.exports = {
  setStatus,
  SetStatusError,
  extractFrontmatter,
  extractSource,
  findIdeasFile,
  findAnchorLine,
  completionDateOf,
};
