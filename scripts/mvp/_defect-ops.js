// ==============================================
// Mini Flow - mf.js 的 `defect` 子命令组：预缺陷单（一缺陷一文件）的 CLI 面（2026-11-23 改造）
//
// 背景：AI 在 work 代码预分析阶段发现缺陷时**禁止直接改码**，改为落一张缺陷单 + 把三个选项
// 交产品拍板。约束写在 vault 根 `CLAUDE.md`「预识别缺陷处理」段，本文件只是它的执行面。
//
// 形态照 `rule` 组：薄分发 + 显式入参 + 复用既有写面，不另写一套解析——缺陷单的骨架 /
// 解析 / 状态流转 / 话术全在 `quickadd/mini/_defect.js`（与 Home 卡共用同一份）。
// 数据模型见任务 `flow/data/2026/Q4/11/预缺陷单改造-一缺陷一文件与CNMI六节结构/process/02-设计.md`。
//
// 用法（统一走 mf.js 入口）：
//   node flow/scripts/mvp/mf.js defect create  --json <file|-> [--now YYYY-MM-DD]
//       payload: {title, module, phenomenon, risk, scope, rootCause, suggestion, regression,
//                 path:'A'|'B', task?, reqId?, changeScope?, sideEffects?, attach?, reproduced?}
//       path=A 时 task 必填（取其 frontmatter `req_id` 填 `req_id`，只读——写手是 qy）
//   node flow/scripts/mvp/mf.js defect list    [--status s] [--path a|b] [--risk P0..P3]
//                                             [--task <任务目录|README>] [--module <子串>]
//   node flow/scripts/mvp/mf.js defect show    --id PD-YYYYMMDD-NN
//   node flow/scripts/mvp/mf.js defect decide  --id PD-... --choice include|defer|archive
//                                             [--by "<谁>"] [--note "<备注>"] [--now YYYY-MM-DD]
//
// 退出码沿用 mf.js：0 成功 / 2 usage / 3 数据冲突或解析失败 / 4 IO。
// 幂等：已是目标状态且已记过该决策 → ok:true + status:"noop"（agent 重放不判失败）。
//
// 边界：
//   - **不开隔离草稿分支、不建云效工单**——那两件是人的动作（agent 不 push、不手改云效）。
//     本命令只写缺陷单与话术，话术由调用方贴给产品。
//   - 落点常量在 `_defect.js#DEFECT_DIR`，**不按 domain 派生**（`work-family` 没有
//     `rules/`，照抄 `_rule-ops.js` 的 domain 回落校验会直接失败）。
// ==============================================

const path = require("node:path");

const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const defectModule = require(path.join(MINI, "_defect.js"));
const yaml = require(path.join(MINI, "_yaml.js"));
const review = require(path.join(MINI, "_rule-review.js"));
const taskPath = require("./_task-path.js");
const { CliError, readJsonSource } = require("./agent-capture.js");

// yaml helper 注入写面单源（`_defect.js` 保持零 require，插件侧才 loadModule 得动）。
const defect = defectModule.makeDefectApi(yaml);

const USAGE = "usage: mf.js defect <create|list|show|decide> "
  + "[--json f | --status s --path a|b --risk P0|P1|P2|P3 --task p --module s "
  + "| --id PD-... [--choice include|defer|archive --by s --note s]] [--now YYYY-MM-DD]";

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function die(code, msg) {
  throw new CliError(code, msg);
}

function todayOf(args) {
  const now = defectModule.normalizeNow(flag(args, "--now"));
  if (!now) die(2, `--now 需要 YYYY-MM-DD，收到 ${flag(args, "--now")}`);
  return now;
}

// ---------- 目录 IO ----------
//
// 两套 vault 适配器：CLI 用 `_fs-vault.js`（`vault.list`），Obsidian 侧只有
// `vault.adapter.list`。两个都探一遍，形状都是 `{files, folders}`。

async function listDir(vault, rel) {
  if (vault && typeof vault.list === "function") return await vault.list(rel);
  if (vault && vault.adapter && typeof vault.adapter.list === "function") {
    return await vault.adapter.list(rel);
  }
  return { files: [], folders: [] };
}

// 目录下全部 md 单：`[{path, content}]`。目录不存在 → 空数组（首次 create 时自然发生）。
async function readDefectFiles(vault) {
  const { files } = await listDir(vault, defectModule.DEFECT_DIR);
  const out = [];
  for (const rel of files || []) {
    if (!/\.md$/i.test(rel)) continue;
    const file = vault.getAbstractFileByPath(rel);
    if (!file) continue;
    out.push({ path: rel, content: await vault.read(file) });
  }
  return out;
}

async function ensureDir(vault) {
  if (vault.getAbstractFileByPath(defectModule.DEFECT_DIR)) return;
  try {
    await vault.createFolder(defectModule.DEFECT_DIR);
  } catch (e) {
    // 并发建目录 / 已存在：交给后续 create 报真错。
    if (!vault.getAbstractFileByPath(defectModule.DEFECT_DIR)) throw e;
  }
}

function defectPathOf(id) {
  return `${defectModule.DEFECT_DIR}/${id}.md`;
}

// ---------- 任务侧读面（只读） ----------

// 读任务 README 的 frontmatter → {rel, reqId, domain, title}。
// frontmatter 解析复用 `_rule-review.js#splitRuleDoc`（rule-ops 同款），不自己切 YAML。
async function readTaskInfo(vault, raw, root) {
  const rel = await taskPath.resolveTaskFile(vault, raw, root, die);
  const file = vault.getAbstractFileByPath(rel);
  if (!file) die(3, `任务文件不存在：${rel}`);
  const content = await vault.read(file);
  const { frontmatter } = review.splitRuleDoc(content);
  const reqId = yaml.getReqId(frontmatter) || "";
  const domain = yaml.getDomain(frontmatter) || "";
  const title = (String(content).match(/^#\s+(.+?)\s*$/m) || [])[1] || "";
  // 关联任务存**不含 .md 的 vault 相对路径**（与 rule 的 sources 同形态，wikilink 可解析）。
  const linkTarget = rel.replace(/\.md$/i, "");
  return { rel, linkTarget, reqId, domain, title };
}

// ---------- create ----------

const REQUIRED = ["title", "module", "phenomenon", "risk", "scope", "rootCause", "suggestion", "regression", "path"];

async function defectCreate(vault, args, ctx) {
  const payload = readJsonSource(flag(args, "--json"));
  if (!payload || typeof payload !== "object") die(3, "--json 需要一个对象");

  const missing = REQUIRED.filter((k) => !String(payload[k] == null ? "" : payload[k]).trim());
  if (missing.length) die(2, `create 缺必填字段：${missing.join(", ")}`);

  const risk = String(payload.risk).trim().toUpperCase();
  if (!defectModule.RISKS.includes(risk)) {
    die(2, `risk 只收 ${defectModule.RISKS.join("|")}，收到 ${payload.risk}`);
  }
  const p = String(payload.path).trim().toUpperCase();
  if (!defectModule.PATHS.includes(p)) die(2, `path 只收 A|B，收到 ${payload.path}`);

  // 路径 A 必须挂当前需求（否则「与本次需求强相关」无从谈起，也拿不到需求单号）。
  if (p === "A" && !String(payload.task || "").trim()) {
    die(2, "path=A 需要 payload.task（关联当前需求并取 req_id）");
  }

  let task = null;
  if (payload.task) {
    task = await readTaskInfo(vault, payload.task, ctx.vaultRoot);
    if (p === "A" && !task.reqId) {
      // 不硬失败：手建任务没有 req_id（写手是 qy 的云效物化），但要让调用方知道单号是空的。
      // 拿不到真号时**留空**，绝不用临时号冒充 `work-<n>`（会撞提交编号闸）。
    }
  }

  const date = todayOf(args);
  await ensureDir(vault);
  const existing = await readDefectFiles(vault);
  const taken = existing.map((f) => defectModule.idFromPath(f.path)).filter(Boolean);
  const id = defectModule.nextId(taken, date);

  const entry = {
    id,
    title: String(payload.title).trim(),
    risk,
    module: String(payload.module).trim(),
    path: p,
    reqId: p === "A" ? (task && task.reqId) || "" : String(payload.reqId || "").trim(),
    task: task ? task.linkTarget : "",
    created: date,
    decided: "",
    reproduced: payload.reproduced === true,
    phenomenon: String(payload.phenomenon).trim(),
    scope: String(payload.scope).trim(),
    rootCause: String(payload.rootCause).trim(),
    suggestion: String(payload.suggestion).trim(),
    changeScope: String(payload.changeScope || "").trim(),
    regression: String(payload.regression).trim(),
    sideEffects: String(payload.sideEffects || "").trim(),
    attach: String(payload.attach || "").trim(),
    status: defectModule.STATUS_PENDING,
    decisions: [],
  };

  const file = defectPathOf(id);
  await vault.create(file, defect.buildDefectNote(entry));

  return {
    ok: true,
    action: "create",
    id,
    file,
    entry,
    // 「发出去即算」验收的载体：full 贴评审 / 归档，chat 直接发群。
    scripts: defectModule.scriptsFor(entry),
    reqIdMissing: p === "A" && !entry.reqId,
  };
}

// ---------- list / show ----------

async function defectList(vault, args, ctx = {}) {
  const status = flag(args, "--status");
  const p = flag(args, "--path") ? String(flag(args, "--path")).toUpperCase() : null;
  const risk = flag(args, "--risk") ? String(flag(args, "--risk")).toUpperCase() : null;
  const taskRaw = flag(args, "--task");
  const moduleQ = flag(args, "--module");

  if (p && !defectModule.PATHS.includes(p)) die(2, `--path 只收 A|B，收到 ${p}`);
  if (risk && !defectModule.RISKS.includes(risk)) {
    die(2, `--risk 只收 ${defectModule.RISKS.join("|")}，收到 ${risk}`);
  }

  let taskTarget = null;
  if (taskRaw) {
    const t = await readTaskInfo(vault, taskRaw, ctx.vaultRoot || process.cwd());
    taskTarget = t.linkTarget;
  }

  const files = await readDefectFiles(vault);
  let skipped = 0;
  let idMismatch = 0;
  let entries = [];
  for (const f of files) {
    const e = defect.parseDefectFile(f.content, f.path);
    if (!e) {
      skipped += 1;
      continue;
    }
    if (e.idMismatch) idMismatch += 1;
    entries.push(e);
  }

  if (status) entries = entries.filter((e) => e.status === status);
  if (p) entries = entries.filter((e) => e.path === p);
  if (risk) entries = entries.filter((e) => e.risk === risk);
  if (taskTarget) entries = entries.filter((e) => e.task === taskTarget);
  if (moduleQ) {
    const q = String(moduleQ).trim();
    entries = entries.filter((e) => String(e.module || "").includes(q));
  }

  // 新的在前：created 倒序，同日按 id 倒序（id 含序号）。
  entries.sort((a, b) => String(b.created || "").localeCompare(String(a.created || ""))
    || String(b.id || "").localeCompare(String(a.id || "")));

  return {
    ok: true,
    action: "list",
    dir: defectModule.DEFECT_DIR,
    count: entries.length,
    skipped,
    idMismatch,
    entries: entries.map((e) => defect.rowOf(e)),
  };
}

async function defectShow(vault, args) {
  const id = flag(args, "--id");
  if (!id) die(2, "show 需要 --id PD-YYYYMMDD-NN");
  if (!defectModule.idFromPath(`${id}.md`)) die(2, `--id 形态不对：${id}（应为 PD-YYYYMMDD-NN）`);
  const file = defectPathOf(id);
  const abstract = vault.getAbstractFileByPath(file);
  if (!abstract) die(3, `缺陷单不存在：${file}`);
  const entry = defect.parseDefectFile(await vault.read(abstract), file);
  if (!entry) die(3, `不是缺陷单（缺 frontmatter 或 type 不是 defect）：${file}`);
  return {
    ok: true,
    action: "show",
    file,
    entry,
    sections: entry.sections,
    decisions: entry.decisions,
    scripts: defectModule.scriptsFor(entry),
  };
}

// ---------- decide ----------

async function defectDecide(vault, args) {
  const id = flag(args, "--id");
  if (!id) die(2, "decide 需要 --id PD-YYYYMMDD-NN");
  const choice = flag(args, "--choice");
  if (!choice) die(2, `decide 需要 --choice ${Object.keys(defectModule.DECISIONS).join("|")}`);
  if (!defectModule.DECISIONS[choice]) {
    die(2, `--choice 只收 ${Object.keys(defectModule.DECISIONS).join("|")}，收到 ${choice}`);
  }
  const file = defectPathOf(id);
  const abstract = vault.getAbstractFileByPath(file);
  if (!abstract) die(3, `缺陷单不存在：${file}`);

  const by = String(flag(args, "--by") || "产品").trim() || "产品";
  const note = String(flag(args, "--note") || "").trim();
  const date = todayOf(args);

  let result;
  try {
    result = defect.applyDecision(await vault.read(abstract), id, choice, { date, by, note });
  } catch (e) {
    die(typeof e.code === "number" ? e.code : 3, e.message);
  }
  if (result.changed) await vault.modify(abstract, result.content);

  const entry = defect.parseDefectFile(result.content, file);
  return {
    ok: true,
    action: "decide",
    id,
    file,
    status: result.status,
    noop: !!result.noop,
    changed: result.changed,
    decided: entry ? entry.decided : "",
    decisions: entry ? entry.decisions : [],
  };
}

// ---------- 分发 ----------

const ACTIONS = {
  create: defectCreate,
  list: defectList,
  show: defectShow,
  decide: defectDecide,
};

async function defectCommand(vault, args, ctx = {}) {
  const [op, ...rest] = args;
  if (!op) die(2, USAGE);
  const fn = ACTIONS[op];
  if (!fn) die(2, `未知的 defect 子命令：${op}\n${USAGE}`);
  return fn(vault, rest, ctx);
}

module.exports = { defectCommand, defectCreate, defectList, defectShow, defectDecide, USAGE };
