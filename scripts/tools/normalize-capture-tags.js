#!/usr/bin/env node
// ==============================================
// normalize-capture-tags.js —— 一次性归一器：月度 Capture 行的历史状态标签 → 现行档
//
// 为什么需要：状态机收窄为 active / finish 两档后，存量月度 ideas 文件里还留着
// #now / #next / #dev_done / #archive 这些旧标签。它们**宽读兼容**（解析时按
// STATUS_ALIAS 归一），所以显示层不出错；但「按现行档统计 / 过滤」的口径会分裂
// ——同一批行在不同口径下算出不同的活跃数。一次性把它们改写成现行档，语义不翻：
//   #now / #next / #dev_done → #active   （都表示「还在办」）
//   #archive                 → #finish   （带完成日期的完成态）
//
// 写面复用（**不另写一份**）：标签与 checkbox 的改写唯一实现在
// quickadd/mini/_capture-line-rewrite.js 的 normalizeStatusTags / normalizeCheckbox；
// 「什么算一条 Capture 行」唯一实现在 quickadd/mini/_capture-line.js 的
// extractAnchor；vault 根定位唯一实现在 quickadd/mini/_vault-root.js。
// 本脚本只做「批量 + 文件级」编排。
//
// 刻意**不调用** ensureCompletion：批量归一不能给历史行伪造完成日期。
// 旧档行本来就自带 [completion:: 日期]（旧档语义即完成态），缺的那几行保持缺，
// 不拿当天日期补——补了就是把「不知道哪天完成的」写成「今天完成的」。
//
// 作用范围（口径写在前面，免得批量改错东西）：
//   1. 只动 `## Capture` 段内的行（读者 listRecentTasks 也只扫这一段）；
//   2. 只动「行首 `- ` 且带 `^cap-` 锚点」的行——这是 Capture 行的判据。
//      比读者口径宽：读者（parseCaptureLine）还要求行内有 [[链接]]，所以**已删任务的
//      留底行**（链接被降级成纯文本）也被本脚本覆盖——它们读不到，但盘面上同样是
//      历史档标签，一并归一更干净；
//   3. 段内的自由散文行（没有锚点的旧三档 bullet、文件头说明）**一律不动**。
//
// 用法（在 vault 根跑；vault 根定位见 quickadd/mini/_vault-root.js）：
//   node <共享仓>/scripts/tools/normalize-capture-tags.js           # 干跑：打印将要改哪些行
//   node <共享仓>/scripts/tools/normalize-capture-tags.js --apply   # 真改
//   node <共享仓>/scripts/tools/normalize-capture-tags.js --check   # 只判定：还有历史档则退出码 1
//
// 幂等：归一后再跑一次 = 0 处改动。
// ==============================================

const fs = require("node:fs");
const path = require("node:path");

const { extractAnchor } = require("../quickadd/mini/_capture-line.js");
const { normalizeCheckbox, normalizeStatusTags } = require("../quickadd/mini/_capture-line-rewrite.js");
const { resolveVaultRoot } = require("../quickadd/mini/_vault-root.js");

// 历史别名 → 现行档。与 _capture-line.js 的 STATUS_ALIAS 同源（那份是读侧归一表）。
const HISTORY_TO_CURRENT = {
  now: "active",
  next: "active",
  dev_done: "active",
  archive: "finish",
};
// 行内状态标签的正则（与解析器同款：只认状态字典的整词）。
const STATUS_RE = /(?:^|\s)#(active|now|next|dev_done|archive|finish)(?=\s|$)/;
// 段边界：与读者一致——`## Capture` 起，同级标题止。
const CAPTURE_HEAD_RE = /^##\s+Capture\s*$/;
const ANY_HEAD_RE = /^##\s/;

// ---------- 纯函数（可单测） ----------

// 这行是不是一条 Capture 行？判据 = 行首 "- " 且带 cap- 锚点。
function isCaptureRow(line) {
  if (!/^\s*-\s/.test(String(line))) return false;
  const a = extractAnchor(String(line));
  return !!(a && /^cap-/.test(a));
}

// 行内原始状态标签（无则空串）。
function rawStatusOf(line) {
  const m = String(line).match(STATUS_RE);
  return m ? m[1] : "";
}

// 这行要不要归一？历史档标签才要。
function needsNormalize(line) {
  const raw = rawStatusOf(line);
  return !!(raw && Object.prototype.hasOwnProperty.call(HISTORY_TO_CURRENT, raw));
}

// 归一这一行：复用写面的两个纯函数；**不**调用 ensureCompletion（不伪造完成日期）。
// 尾部空白收尾与 rewriteStatus 同款，保证批量归一后的行形态与单条改写一致。
function normalizeRow(line) {
  const target = HISTORY_TO_CURRENT[rawStatusOf(line)];
  if (!target) return String(line);
  let out = normalizeCheckbox(String(line), target);
  out = normalizeStatusTags(out, target);
  return out.replace(/\s+/g, " ").replace(/\s+(\^cap-)/, " $1").trimEnd();
}

// ---------- 文件级 ----------

// 列出 vault 内全部月度 ideas 文件（flow/data/**/ideas-YYYY-MM.md）。
function listMonthlyFiles(root) {
  const base = path.join(root, "flow", "data");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^ideas-\d{4}-\d{2}\.md$/.test(e.name)) out.push(p);
    }
  };
  walk(base);
  return out.sort();
}

// 逐行处理一个文件内容：只在 `## Capture` 段内归一 Capture 行。
// 返回 { lines, stats }；lines 是新行数组（未改动时与原行数组等价）。
function transformContent(text) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const stats = { rows: 0, history: 0, changed: 0, inCaptureRows: 0 };
  let inCapture = false;
  const out = lines.map((line) => {
    if (CAPTURE_HEAD_RE.test(line)) {
      inCapture = true;
      return line;
    }
    if (ANY_HEAD_RE.test(line)) {
      inCapture = false;
      return line;
    }
    if (!inCapture) return line;
    if (!isCaptureRow(line)) return line;
    stats.rows += 1;
    if (!needsNormalize(line)) return line;
    stats.history += 1;
    const next = normalizeRow(line);
    if (next !== line) stats.changed += 1;
    return next;
  });
  return { lines: out, stats, nl };
}

function main(argv) {
  const apply = argv.includes("--apply");
  const check = argv.includes("--check");
  const vaultIdx = argv.indexOf("--vault");
  let root;
  if (vaultIdx >= 0 && argv[vaultIdx + 1]) {
    root = path.resolve(argv[vaultIdx + 1]);
  } else {
    root = resolveVaultRoot();
  }
  if (!fs.existsSync(path.join(root, "flow", "data"))) {
    console.error(`[normalize] 目标不是 Mini Flow vault（缺 flow/data/）：${root}`);
    process.exit(2);
  }

  const mode = apply ? "应用" : check ? "检查" : "干跑";
  console.log(`[normalize] 目标 vault 根：${root}`);
  console.log(`[normalize] 模式：${mode}\n`);

  const files = listMonthlyFiles(root);
  let tRows = 0, tHist = 0, tChanged = 0, tFiles = 0;
  const changedFiles = [];
  const details = [];

  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    const text = fs.readFileSync(f, "utf8");
    const { lines, stats, nl } = transformContent(text);
    if (!stats.rows && !stats.history) continue;
    tRows += stats.rows;
    tHist += stats.history;
    tChanged += stats.changed;
    if (stats.changed) {
      tFiles += 1;
      changedFiles.push(rel);
      if (apply) fs.writeFileSync(f, lines.join(nl), "utf8");
    }
    // 记逐行前后（改动量小，全量打出来便于人工过目）
    const before = text.split(/\r?\n/);
    lines.forEach((l, i) => {
      if (l !== before[i]) details.push({ rel, line: i + 1, before: before[i], after: l });
    });
    console.log(
      `[normalize] ${rel} · Capture 行 ${stats.rows} · 历史档 ${stats.history} · 改动 ${stats.changed}`
    );
  }

  console.log(`\n[normalize] 合计：Capture 行 ${tRows} · 历史档 ${tHist} · 需改动 ${tChanged} · 涉及文件 ${tFiles}`);
  if (details.length) {
    console.log("\n=== 逐行前后 ===");
    for (const d of details) {
      console.log(`  ${d.rel}:${d.line}`);
      console.log(`    - ${d.before}`);
      console.log(`    + ${d.after}`);
    }
  }
  if (apply && changedFiles.length) {
    console.log(`\n[normalize] 已写入 ${changedFiles.length} 个文件：`);
    changedFiles.forEach((f) => console.log(`  ${f}`));
  } else if (!apply && changedFiles.length) {
    console.log(`\n[normalize] 干跑：以上 ${tChanged} 处改动未落盘（加 --apply 才写）。`);
  } else {
    console.log("\n[normalize] 无需改动（已是现行档）。");
  }
  if (check) process.exit(tHist > 0 ? 1 : 0);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("[normalize] 失败：", e && e.message ? e.message : e);
    process.exit(2);
  }
}

module.exports = {
  HISTORY_TO_CURRENT,
  isCaptureRow,
  rawStatusOf,
  needsNormalize,
  normalizeRow,
  listMonthlyFiles,
  transformContent,
};
