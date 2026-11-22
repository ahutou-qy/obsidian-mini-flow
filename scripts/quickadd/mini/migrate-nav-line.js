#!/usr/bin/env node
// ==============================================
// 一次性迁移：统一任务 README 的「领域」nav 行
//
// 背景：领域 nav 行历史上由三个写入端产出过三种形态，2026-09-29 清扫时统计：
//   - 旧 `> **Domain:** {slug}（领域：{label}）`  —— 外部同步 CLI yunxiao/tasks.rs 写的
//   - `> **领域：** [[domains/<域>/README|…]]`    —— 各域 README.md 被删后成死链
//     （f150c0a4 把规约入口归口到 CLAUDE.md，4aeaf76b 删 work5/README.md）
//   - `> **领域：** [[domains/<域>/CLAUDE|…]]`    —— 现行 _task.js 形态，正确
//
// 本脚本按任务 frontmatter 的 `domain:` 重算唯一权威形态（label 取 flow.json#label，
// 与 _task.js#domainMeta / tasks.rs#label_of 同源）。
// （2026-11-16 起不再补 `domain/<slug>` tag：tags 段整体删除，task-upgrade 改读 `domain:` 标量。）
// 无 nav 行的任务按 _task.js 的落位补一整块（「来源：」行后，无来源行则 H1 后）。
//
// 不臆造 domain：frontmatter 无 `domain:` 或域目录不存在的一律只报不改。
//
// 用法：node migrate-nav-line.js [--apply | --stage] [--log PATH]
//   默认       dry-run，只打印将要做的改动与分组统计，不写盘。
//   --apply    直接改工作区文件。
//   --stage    只把「HEAD 版本 + 本迁移」的结果写进 git index，不动工作区。
//              用途：工作区里混着其它会话未提交的改动时，避免 git add 连坐。
// ==============================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DOMAINS_ROOT = "flow/data/domains";
const DATA_ROOT = "flow/data";
const VAULT = process.cwd();

const MODE = process.argv.includes("--stage") ? "stage" : process.argv.includes("--apply") ? "apply" : "report";
const logArgIdx = process.argv.indexOf("--log");
const LOG_PATH =
  logArgIdx !== -1 && process.argv[logArgIdx + 1]
    ? process.argv[logArgIdx + 1]
    : path.join(__dirname, "migrate-nav-line.log");
const LOG_OFF = LOG_PATH === "-";

function log(line) {
  if (!LOG_OFF) fs.appendFileSync(LOG_PATH, line + "\n");
  process.stdout.write(line + "\n");
}

function labelOf(domain) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(VAULT, DOMAINS_ROOT, domain, "flow.json"), "utf8"));
    return (j.label && String(j.label).trim()) || domain;
  } catch {
    return null; // 域不存在 → dangling，不改
  }
}

function fmDomain(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const d = /^domain\s*:\s*(.*?)\s*$/m.exec(m[1]);
  if (!d) return "";
  return d[1].trim().replace(/^['"]|['"]$/g, "");
}

const SENTINEL = "<!-- _task.js render: nav line — 不要手改 -->";
const SENTINEL_RE = /^<!-- _task\.js render: (?:domain|nav) line — 不要手改 -->\s*$/;
// 兼容现行「> **领域：** [[…]]」与 外部同步 CLI 的「> **Domain:** x（领域：y）」，冒号全/半角都吃
const NAV_RE = /^\s*>\s*\*\*(?:领域|Domain)\s*[：:]?\*\*/;

const canonicalNav = (domain, label) => `> **领域：** [[${DOMAINS_ROOT}/${domain}/CLAUDE|${label} 规则库]]`;

// 统一 nav 块。status ∈ ok | updated | no-sentinel | no-nav-line | misplaced
function rewriteNav(text, domain, label) {
  const lines = text.split("\n");
  const want = canonicalNav(domain, label);
  const si = lines.findIndex((l) => SENTINEL_RE.test(l));
  if (si === -1) {
    const qi = lines.findIndex((l) => NAV_RE.test(l));
    return qi === -1 ? { status: "no-nav-line" } : { status: "no-sentinel", next: lines[qi] };
  }
  const qi = si + 1;
  if (qi >= lines.length || !NAV_RE.test(lines[qi]))
    return { status: "misplaced", next: lines[qi] === undefined ? "<EOF>" : lines[qi] };
  if (lines[si] === SENTINEL && lines[qi] === want) return { status: "ok" };
  const from = lines[qi];
  lines[si] = SENTINEL;
  lines[qi] = want;
  return { status: "updated", text: lines.join("\n"), from, to: want };
}

// 补缺失的 nav 块，落位对齐 _task.js：紧跟「来源：…」行，无来源行则紧跟 H1。
function insertNav(text, domain, label) {
  const lines = text.split("\n");
  let anchor = lines.findIndex((l) => /^来源[:：]/.test(l));
  if (anchor === -1) anchor = lines.findIndex((l) => /^#\s/.test(l));
  if (anchor === -1) return { status: "no-anchor" };
  lines.splice(anchor + 1, 0, SENTINEL, canonicalNav(domain, label));
  return { status: "inserted", text: lines.join("\n") };
}

// 单文件完整迁移。返回 { action, text?, desc?, reason? }
// action ∈ ok | updated | inserted | skipped-no-domain | skipped-dangling | blocked
function transform(text) {
  if (!/^type:\s*task-folder\s*$/m.test(text)) return { action: "skip-not-task" };
  const domain = fmDomain(text);
  if (domain === null) return { action: "blocked", reason: "无 frontmatter" };
  if (domain === "") return { action: "skipped-no-domain" };
  const label = labelOf(domain);
  if (label === null) return { action: "skipped-dangling", reason: domain };

  let nav = rewriteNav(text, domain, label);
  if (nav.status === "no-sentinel") return { action: "blocked", reason: `有领域行但无哨兵：${nav.next}` };
  if (nav.status === "misplaced") return { action: "blocked", reason: `哨兵后不是领域行：${nav.next}` };

  let out = text;
  let desc = "";
  if (nav.status === "updated") {
    out = nav.text;
    desc = `${nav.from}\n      → ${nav.to}`;
  } else if (nav.status === "no-nav-line") {
    const ins = insertNav(text, domain, label);
    if (ins.status !== "inserted") return { action: "blocked", reason: "无 nav 行且找不到插入锚点" };
    out = ins.text;
    desc = "（补 nav 行）";
  }

  return out === text ? { action: "ok" } : { action: nav.status === "no-nav-line" ? "inserted" : "updated", text: out, desc };
}

function* walkTaskReadmes(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkTaskReadmes(p);
    else if (e.name === "README.md") yield p;
  }
}

const git = (args, input) =>
  execFileSync("git", args, { cwd: VAULT, input, maxBuffer: 1 << 28 }).toString();

const summary = { ok: 0, updated: 0, inserted: 0, noDomain: [], dangling: [], blocked: [], untracked: [] };
const planned = [];

for (const p of walkTaskReadmes(path.join(VAULT, DATA_ROOT))) {
  const rel = path.relative(VAULT, p);
  let src;
  if (MODE === "stage") {
    // 不在 HEAD 的文件（新任务尚未提交）无从算「HEAD + 本迁移」，跳过交回其属主提交
    try {
      src = git(["show", `HEAD:${rel}`]);
    } catch {
      summary.untracked.push(rel);
      continue;
    }
  } else {
    src = fs.readFileSync(p, "utf8");
  }
  const r = transform(src);
  if (r.action === "ok" || r.action === "skip-not-task") {
    if (r.action === "ok") summary.ok++;
    continue;
  }
  if (r.action === "skipped-no-domain") { summary.noDomain.push(rel); continue; }
  if (r.action === "skipped-dangling") { summary.dangling.push([rel, r.reason]); continue; }
  if (r.action === "blocked") { summary.blocked.push([rel, r.reason]); continue; }
  summary[r.action]++;
  planned.push([p, rel, r.text, r.desc]);
}

log(`\n===== ${new Date().toISOString()} | node ${process.argv.slice(1).join(" ")} | vault=${VAULT} | MODE=${MODE} =====`);
log(`nav 改写 ${summary.updated}｜补 nav 行 ${summary.inserted}｜已最新 ${summary.ok}｜无 domain 字段 ${summary.noDomain.length}｜悬空域 ${summary.dangling.length}｜结构异常 ${summary.blocked.length}｜不在 HEAD ${summary.untracked.length}`);

if (planned.length) {
  log("\n--- 待改 ---");
  for (const [, rel, , desc] of planned) log(`  ${rel}\n      ${desc}`);
}
for (const [k, label] of [["noDomain", "无 domain 字段（跳过）"], ["dangling", "悬空域（跳过）"], ["untracked", "不在 HEAD（跳过）"], ["blocked", "结构异常（跳过）"]]) {
  if (summary[k].length) {
    log(`\n--- ${label} ---`);
    for (const item of summary[k]) log(`  ${Array.isArray(item) ? item.join("  ::  ") : item}`);
  }
}

if (MODE === "report") {
  log("\nDRY-RUN，未写盘。--apply 改工作区，--stage 只写 index。");
} else if (MODE === "apply") {
  for (const [p, , out] of planned) fs.writeFileSync(p, out);
  log(`\nAPPLY 完成：写盘 ${planned.length} 个文件。`);
} else {
  for (const [, rel, out] of planned) {
    const sha = git(["hash-object", "-w", "--stdin"], out).trim();
    git(["update-index", "--cacheinfo", `100644,${sha},${rel}`]);
  }
  log(`\nSTAGE 完成：仅把「HEAD + 本迁移」写进 index ${planned.length} 个文件（工作区的其它改动未动）。`);
}
