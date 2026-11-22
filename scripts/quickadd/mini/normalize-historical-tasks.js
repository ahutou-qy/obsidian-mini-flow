// Mini Flow - 历史任务格式审计 / 规范化（分期 8）。
//
// 新任务正文由 _task.js 的 builder 直接生成，没有模板文件。本脚本核对月目录任务树下
// 的存量任务与定稿段结构的差距，按三档输出：
//   自动补（只加不删不改值）、自动挪（保留原内容移位）、人工清单（脚本不猜）。
//
// 用法：
//   node normalize-historical-tasks.js            # dry-run，打印段级 diff，不写盘
//   node normalize-historical-tasks.js --apply    # 执行自动档改写
//
// 只读 frontmatter 与段落标题，不解析正文语义；脏 source / domain 归属只报告不改。

const fs = require("fs");
const path = require("path");

const { resolveVaultRoot } = require("./_vault-root.js");
const VAULT_ROOT = resolveVaultRoot(); // 挂载后 __dirname 上溯推不出 vault 根
const DATA_ROOT = path.join(VAULT_ROOT, "flow/data");
const APPLY = process.argv.includes("--apply");

// 任务树只认 flow/data/YYYY/Qn/MM。返回该月下的任务分类。
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function parseFrontmatter(text) {
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/);
  if (!m) return { raw: "", fields: {}, bodyStart: 0 };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const fm = line.match(/^([A-Za-z_][\w]*):(.*)$/);
    if (fm) fields[fm[1].trim()] = fm[2].trim();
  }
  return { raw: m[1], fields, bodyStart: m[0].length };
}

// 任务树只认 flow/data/YYYY/Qn/MM。返回该月下的任务分类。
function isMonthDir(p) {
  return /flow\/data\/\d{4}\/Q[1-4]\/(0[1-9]|1[0-2])$/.test(p.replace(/\\/g, "/"));
}

function listTaskFiles() {
  const tasks = [];
  for (const year of fs.readdirSync(DATA_ROOT)) {
    const yp = path.join(DATA_ROOT, year);
    if (!/^\d{4}$/.test(year) || !fs.statSync(yp).isDirectory()) continue;
    for (const q of fs.readdirSync(yp)) {
      const qp = path.join(yp, q);
      if (!/^Q[1-4]$/.test(q) || !fs.statSync(qp).isDirectory()) continue;
      for (const m of fs.readdirSync(qp)) {
        const mp = path.join(qp, m);
        if (!isMonthDir(mp) || !fs.statSync(mp).isDirectory()) continue;
        classifyMonth(mp, tasks);
      }
    }
  }
  return tasks;
}

function classifyMonth(monthDir, tasks) {
  for (const name of fs.readdirSync(monthDir)) {
    const p = path.join(monthDir, name);
    const st = fs.statSync(p);
    if (st.isFile() && name.endsWith(".md")) {
      tasks.push({ path: p, kind: "root-file", ...readTask(p) });
    } else if (st.isDirectory()) {
      const readme = path.join(p, "README.md");
      if (fs.existsSync(readme)) tasks.push({ path: readme, kind: "root-folder", ...readTask(readme) });
      // 阶段任务：epic folder 内直接子级 NN-*.md（type task 带 stage）。
      for (const sub of fs.readdirSync(p)) {
        const sp = path.join(p, sub);
        if (sub.endsWith(".md") && fs.statSync(sp).isFile() && sub !== "README.md") {
          tasks.push({ path: sp, kind: "nested", ...readTask(sp) });
        }
      }
    }
  }
}

function readTask(p) {
  const text = fs.readFileSync(p, "utf8");
  const { fields } = parseFrontmatter(text);
  const headers = [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map(m => m[1].trim());
  return { type: (fields.type || "").toLowerCase(), stage: fields.stage || "", status: fields.status || "", source: fields.source || "", headers, text };
}

// 判定角色：folder/epic README、阶段笔记、单文件任务。非 task 类型跳过。
function roleOf(t) {
  if (t.type === "task-folder") return "folder";
  if (t.type === "task" && t.stage) return "stage";
  if (t.type === "task") return "task";
  return null;
}

// 完成真相在月度 ideas 的 Capture checkbox，不在任务 frontmatter status。
// 从 source "[[ideas-YYYY-MM#^cap-xxx]]" 解析锚点，去对应 ideas 文件读该行是否 [x]。
// 脏 source 解析不出 → 返回 null（无法判定，按未完成保守处理）。
const completedCache = new Map();
function isCaptureCompleted(t) {
  if (t.status === "done") return true;
  const m = String(t.source || "").match(/ideas-(\d{4}-\d{2})#\^?(cap-[a-z0-9]+)/);
  if (!m) return null;
  const [, ym, anchor] = m;
  const key = `${ym}|${anchor}`;
  if (completedCache.has(key)) return completedCache.get(key);
  const ideaPath = path.join(DATA_ROOT, ym.slice(0, 4), quarterOf(ym.slice(5, 7)), `ideas-${ym}.md`);
  let done = null;
  try {
    const text = fs.readFileSync(ideaPath, "utf8");
    const line = text.split(/\r?\n/).find(l => l.includes(anchor));
    if (line) done = /^\s*- \[[xX]\]/.test(line);
  } catch (_) { done = null; }
  completedCache.set(key, done);
  return done;
}

function quarterOf(month) {
  return "Q" + Math.ceil(Number(month) / 3);
}

// 必补段：folder 该有"文件索引"哨兵（auto-index 锁点）。
// 背景/目标/进展/笔记/目录结构不强制——老 folder 常有自定义业务段（TL;DR/决策日志等），不补空壳。
// AI 上下文段已于 2026-08-20 下线，不再补。
// 单文件任务与阶段笔记没有必补锁点段。
const REQUIRED = {
  task: [],
  folder: [],
  stage: [],
};

function analyze(t) {
  const role = roleOf(t);
  if (!role) return null;
  const has = h => t.headers.includes(h);
  const findings = [];

  // 完成态：Capture 已勾选（或 status:done）的任务不补空段。判据缺失（脏 source）
  // 时保守按未完成处理，但在人工清单标注。
  const completed = isCaptureCompleted(t) === true;
  const completionUnknown = isCaptureCompleted(t) === null;
  if (completed) {
    findings.push({ level: "manual", issue: "Capture 已勾选完成，跳过自动补段" });
    return { role, done: true, findings };
  }
  if (completionUnknown && role !== "stage") {
    // 完成状态判不出来（脏 source），不自动补段——可能是已完成任务，补空段是污染。
    // 阶段任务 source 指向 epic、不带 cap 锚点，完成真相在 frontmatter status，不受此限。
    findings.push({ level: "manual", issue: `完成状态未知（脏 source），不自动补段：${(t.source || "").slice(0, 60)}` });
    return { role, done: false, findings };
  }

  // --- 缺必补段（自动补，只加不删不改值）---
  const missing = REQUIRED[role].filter(h => !has(h));
  if (missing.length) findings.push({ level: "auto-add", missing });

  // folder 缺文件索引哨兵（有 ## 文件索引 段但没哨兵，或段都缺）。
  if (role === "folder" && (!has("文件索引") || !/<!-- auto-index:start -->/.test(t.text))) {
    findings.push({ level: "auto-add", need: "文件索引哨兵（补后需 task-refresh-index 重建列表）" });
  }

  // --- 空复盘段（可删，报告但不自动删——删内容属于不可逆，交人工确认）---
  if (has("复盘")) {
    const m = t.text.match(/^##[ \t]+复盘[ \t]*\r?\n([\s\S]*?)(?=\r?\n##[ \t]|\r?\n---\r?\n|$)/m);
    const body = m ? m[1].replace(/[-\s]/g, "") : "";
    findings.push({ level: "manual", issue: body ? "复盘段有内容，人工确认保留/移位" : "空复盘段（仅标题），可删" });
  }

  // --- 人工清单：脏 source ---
  // 标准：根任务 source 形如 [[ideas-YYYY-MM#^cap-xxx]]；阶段任务指向 epic README。
  if (role !== "stage" && t.source && !/\[\[ideas-\d{4}-\d{2}#\^cap-/.test(t.source)) {
    findings.push({ level: "manual", issue: `脏 source: ${t.source.slice(0, 70)}` });
  }

  // folder 的自定义业务段：只报告，明确保留原样。
  if (role === "folder") {
    const std = new Set(["背景","目标","下一步","进展","笔记","目录结构","文件索引","复盘","合入前 Review（WORK 代码）"]);
    const custom = t.headers.filter(h => !std.has(h));
    if (custom.length) findings.push({ level: "manual", issue: `自定义业务段，保留原样：${custom.join(" / ")}` });
  }

  return { role, done: completed, findings: findings.length ? findings : [] };
}

function rel(p) {
  return path.relative(VAULT_ROOT, p).replace(/\\/g, "/");
}

function main() {
  const tasks = listTaskFiles();
  const buckets = { "auto-add": [], "auto-move": [], "manual": [], clean: [] };
  let skipped = 0;
  for (const t of tasks) {
    const a = analyze(t);
    if (!a) { skipped++; continue; }
    if (!a.findings.length) { buckets.clean.push(t); continue; }
    for (const f of a.findings) {
      buckets[f.level].push({ ...t, role: a.role, done: a.done, finding: f });
    }
  }

  if (APPLY) {
    applyAutoAdds(buckets["auto-add"]);
    return;
  }

  console.log(`# 历史任务格式审计（dry-run）\n`);
  console.log(`任务文件总数 ${tasks.length}，非 task 类型跳过 ${skipped}，已合规 ${buckets.clean.length}\n`);

  for (const [level, label] of [["auto-add","自动补（只加不删不改值）"],["auto-move","自动挪（保留原内容）"],["manual","人工清单（脚本不猜）"]]) {
    console.log(`## ${label} — ${buckets[level].length} 项\n`);
    for (const t of buckets[level]) {
      console.log(`- [${t.role}${t.done ? "/done" : ""}] ${rel(t.path)}`);
      console.log(`    ${JSON.stringify(t.finding)}`);
    }
    console.log();
  }
}

// ---------- apply：只处理 auto-add，只加不删不改值 ----------

const FILE_INDEX_SECTION = [
  "## 文件索引",
  "<!-- auto-index:start -->",
  "<!-- auto-index:end -->",
  "",
].join("\n");

// 在指定段头后插入一段；找不到则追加末尾。
function insertAfterSection(text, header, section) {
  const re = new RegExp(`^##[ \\t]+${header}[ \\t]*$`, "m");
  const m = text.match(re);
  if (m) {
    const at = m.index + m[0].length;
    const rest = text.slice(at);
    const next = rest.match(/^##[ \t]+/m);
    const insertAt = next ? at + next.index : text.length;
    return text.slice(0, insertAt).replace(/\s*$/, "\n\n") + section + text.slice(insertAt);
  }
  return text.replace(/\s*$/, "") + "\n\n" + section;
}

function applyAutoAdds(items) {
  // 同一文件可能有多条 finding（如 folder 同时缺 AI 上下文+文件索引哨兵），按路径合并。
  const byPath = new Map();
  for (const t of items) {
    if (!byPath.has(t.path)) byPath.set(t.path, { ...t, needs: [] });
    byPath.get(t.path).needs.push(t.finding);
  }
  let changed = 0;
  for (const [p, t] of byPath) {
    let text = t.text;
    const before = text;
    for (const f of t.needs) {
      if (f.need && f.need.startsWith("文件索引哨兵") && !/<!-- auto-index:start -->/.test(text)) {
        if (/^##[ \t]+文件索引/m.test(text)) {
          text = text.replace(/^(##[ \t]+文件索引[ \t]*\r?\n)/, `$1<!-- auto-index:start -->\n<!-- auto-index:end -->\n`);
        } else {
          text = insertAfterSection(text, "目录结构", FILE_INDEX_SECTION);
        }
      }
    }
    if (text !== before) {
      fs.writeFileSync(p, text);
      changed++;
      console.log(`updated: ${rel(p)}`);
    }
  }
  console.log(`\n${changed} 个文件已更新（只加段，未删未改既有内容）。`);
  console.log("注意：补了文件索引哨兵的 folder，需在 Obsidian 内跑 task-refresh-index 重建列表。");
}

main();
