// ==============================================
// Mini Flow - mf.js 的 `rule` 子命令组：规则库操作的 CLI 面（2026-11-23）
//
// 背景：规则库的四个动作此前只有 Obsidian 交互面——plugin/main.js 的 ACTIONS 表里
// 注册的 Rule Capture / Rule Validate / Rule Promote / Rule Deprecate 四条脚本。
// 那四条靠「当前活动文件」定位目标、靠 `quickAddApi.inputPrompt` 取参，而 MCP 的
// `command_execute` 只收 commandId（Obsidian 的 POST /commands/{id}/ 无 request body、
// fire-and-forget），agent 因此调不动它们。
//
// 本文件把四个动作搬到 CLI 面：**入参全部显式**，判据与写面**复用既有那两份**
// （`_rule.js` 记录落盘 / `_rule-review.js` 评审），不另写一份实现：
//   - 规则骨架              → `_rule.js#buildRuleNote`
//   - 任务侧「产出规则」块  → `_rule.js#appendProducedRuleBlock`
//   - 任务侧「引用规则」块  → `_rule-review.js#appendReferencedRuleBlock`
//   - 登记验证 / 晋级 / 废弃 → `_rule-review.js#validateRule` / `promoteRuleManual` /
//     `deprecateRule`（三者内部各自写 `## 变更` 段，幂等键是 date + head）
//   - 规则路径 / 标题 / 状态 → `_rule-review.js#splitRuleDoc` / `readScalar`
//
// 用法（统一走 mf.js 入口）：
//   node flow/scripts/mvp/mf.js rule list     [--domain <slug>] [--status proposed|confirmed|deprecated|all]
//   node flow/scripts/mvp/mf.js rule capture   --title "<短标题>" --task <任务目录|README 路径>
//                                               [--domain <slug>] [--statement "<一句话>"]
//                                               [--tags "子方向a,子方向b"] [--supersedes "旧规则路径1,路径2"]
//                                               [--now YYYY-MM-DD]
//   node flow/scripts/mvp/mf.js rule validate  --rule <规则路径> --task <任务目录|README 路径>
//                                               [--note "<一句话实证>"] [--now YYYY-MM-DD]
//   node flow/scripts/mvp/mf.js rule promote   --rule <规则路径> [--reason "<理由>"] [--now YYYY-MM-DD]
//   node flow/scripts/mvp/mf.js rule deprecate --rule <规则路径> [--reason "<理由>"]
//                                               [--superseded-by "新规则路径1,路径2"] [--now YYYY-MM-DD]
//
// 退出码沿用 mf.js：0 成功 / 2 usage / 3 数据冲突或解析失败 / 4 IO。
//
// 幂等语义（与 Obsidian 交互面的 Notice 一致，但出口不同）：已登记过 / 已是 confirmed /
// 已是 deprecated → **成功**（ok:true, changed:false, status:"noop"）——agent 重放同一条
// 命令不该被判失败。「规则已 deprecated，不接受新验证」「不能手动晋级」是**数据冲突**
// → code 3。
//
// 边界：
//   - 本文件只做 CLI 侧。Obsidian 侧那四条交互命令**保留**（人点的手感在），两边共用
//     上面那两份纯逻辑；本文件不替代它们、不改它们的注册。
//   - 规则文件与任务文件都必须落在 vault 内；路径给绝对或相对都收（相对按 vault 根）。
//   - `--domain` 缺省时回落**任务 frontmatter 的 domain**（且该域须已有 rules/ 目录），
//     回落不成立则报 usage 错并列出现有域——不猜。
// ==============================================

const path = require("node:path");

const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const rule = require(path.join(MINI, "_rule.js"));
const review = require(path.join(MINI, "_rule-review.js"));
const naming = require(path.join(MINI, "_naming.js"));
const configMod = require(path.join(MINI, "_config.js"));
const { CliError } = require("./agent-capture.js");
const taskPath = require("./_task-path.js");

// ---------- 参数与路径小工具 ----------

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function has(args, name) {
  return args.includes(name);
}

function die(code, msg) {
  throw new CliError(code, msg);
}

// 路径归一与任务文件定位在 `_task-path.js`（与任务元数据编辑那半边共用一份）。
const toRel = taskPath.toRel;
async function resolveTaskFile(vault, raw, root) {
  return taskPath.resolveTaskFile(vault, raw, root, die);
}

// 本地今天（YYYY-MM-DD）；--now 给了就用给的。
function todayOf(args) {
  const raw = flag(args, "--now");
  if (!raw) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) die(2, `--now 需要 YYYY-MM-DD，收到 ${raw}`);
  return s;
}

// 逗号分隔列表（兼容中英文逗号）；空串 → 空数组。
function splitList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 规则路径归一：剥 `[[ ]]`、剥 `.md` 后缀 → vault 相对（不含扩展名）。
function normalizeRulePath(raw, root) {
  let p = toRel(raw, root);
  if (!p) die(2, "需要 --rule <规则路径>");
  p = p.replace(/^\[\[/, "").replace(/\]\]$/, "");
  p = p.replace(/\.md$/i, "");
  return p;
}

// 定位任务文件（folder 任务 README 或单文件任务）：实现在 `_task-path.js`，
// 本文件只注入自己的 CliError 版 die。

// 读任务文件的 frontmatter 与正文。
async function readTaskInfo(vault, rel) {
  const content = await vault.read(rel);
  const { frontmatter } = review.splitRuleDoc(content);
  return {
    content,
    type: review.readScalar(frontmatter, "type"),
    domain: review.readScalar(frontmatter, "domain"),
  };
}

// 定位规则文件并校验它是 rule（type: rule）。
async function resolveRuleFile(vault, raw, root) {
  const rel = normalizeRulePath(raw, root);
  const file = vault.getAbstractFileByPath(`${rel}.md`);
  if (!file || file.children) {
    die(3, `规则文件不存在：${rel}.md`);
  }
  const content = await vault.read(`${rel}.md`);
  const { frontmatter } = review.splitRuleDoc(content);
  const type = review.readScalar(frontmatter, "type");
  if (type !== "rule") {
    die(3, `不是规则文件（type=${type || "无"}）：${rel}.md`);
  }
  const title = (String(content).match(/^#\s+(.+?)\s*$/m) || [])[1] || rel.split("/").pop();
  return { path: `${rel}.md`, pathNoExt: rel, content, frontmatter, title };
}

// ---------- rule list（读面） ----------

async function ruleList(vault, args, ctx) {
  const statusFilter = flag(args, "--status") || "all";
  if (!["all", "proposed", "confirmed", "deprecated"].includes(statusFilter)) {
    die(2, `--status 只收 all|proposed|confirmed|deprecated，收到 ${statusFilter}`);
  }
  const only = flag(args, "--domain");
  const domains = await rule.listDomains(vault);
  if (only && !domains.includes(only)) {
    die(3, `域不存在或没有 rules/ 目录：${only}（现有：${domains.join("、") || "无"}）`);
  }
  const targets = only ? [only] : domains;
  const out = [];
  for (const domain of targets) {
    const folder = vault.getAbstractFileByPath(rule.rulesFolder(domain));
    const children = (folder && folder.children) || [];
    for (const child of children) {
      if (!child || child.name.startsWith("_") || !child.name.endsWith(".md")) continue;
      let content;
      try {
        content = await vault.read(child);
      } catch (_e) {
        continue;
      }
      const { frontmatter } = review.splitRuleDoc(content);
      const status = review.readScalar(frontmatter, "status") || "proposed";
      if (statusFilter !== "all" && status !== statusFilter) continue;
      const title = (String(content).match(/^#\s+(.+?)\s*$/m) || [])[1] || child.basename;
      out.push({
        path: child.path,
        domain,
        slug: child.basename,
        title,
        status,
        // 阈值判定的当前值：sources + validated_by 合并去重后的 unique 任务数。
        uniqueCount: review.uniqueValidatedByCount(frontmatter, child.path),
      });
    }
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title, "zh"));
  return { ok: true, action: "list", status: statusFilter, count: out.length, rules: out };
}

// ---------- rule capture（沉淀新规则） ----------

async function ruleCapture(vault, args, ctx) {
  const titleInput = flag(args, "--title");
  if (!titleInput) die(2, "rule capture 需要 --title <规则短标题>");
  const taskRel = await resolveTaskFile(vault, flag(args, "--task"), ctx.vaultRoot);
  const task = await readTaskInfo(vault, taskRel);
  if (task.type !== "task" && task.type !== "task-folder") {
    die(3, `不是任务文件（type=${task.type || "无"}）：${taskRel}`);
  }

  // 域：显式 --domain 优先；缺省回落任务 frontmatter 的 domain（该域须已有 rules/ 目录）。
  const domains = await rule.listDomains(vault);
  let domain = flag(args, "--domain");
  if (!domain && task.domain && domains.includes(task.domain)) domain = task.domain;
  if (!domain) {
    die(2, `rule capture 需要 --domain <slug>（缺省回落任务 frontmatter 的 domain，`
      + `该域须已有 rules/ 目录）。现有域：${domains.join("、") || "无"}`);
  }
  if (!domains.includes(domain)) {
    die(3, `域不存在或没有 rules/ 目录：${domain}（现有：${domains.join("、") || "无"}）`);
  }

  const title = naming.cleanTitle(titleInput);
  if (!title) die(2, "标题为空，未创建规则");
  const cfg = configMod.loadSync(ctx.vaultRoot);
  const maxLen = cfg && cfg.behavior ? cfg.behavior.maxFilenameLength : undefined;
  const fileName = naming.buildFileName(title, maxLen);
  const targetPath = rule.rulePath(domain, fileName);
  if (vault.getAbstractFileByPath(targetPath)) {
    die(3, `规则已存在：${targetPath}`);
  }

  const statement = String(flag(args, "--statement") || "").trim();
  const subtags = splitList(flag(args, "--tags")).map((s) => naming.sanitize(s));
  const supersedes = splitList(flag(args, "--supersedes")).map((p) => normalizeRulePath(p, ctx.vaultRoot));

  const created = todayOf(args);
  const taskPathNoExt = taskRel.replace(/\.md$/, "");
  const note = rule.buildRuleNote({
    title,
    statement,
    domain,
    subtags,
    created,
    sourceTaskPathNoExt: taskPathNoExt,
    supersedes,
  });

  // 规则文件
  const rulesDir = rule.rulesFolder(domain);
  if (!vault.getAbstractFileByPath(rulesDir)) {
    await ensureFolder(vault, rulesDir);
  }
  await vault.create(targetPath, note);

  // 任务侧「产出规则」块
  const updatedTask = rule.appendProducedRuleBlock(task.content, targetPath.replace(/\.md$/, ""), title);
  if (updatedTask !== task.content) await vault.modify(taskRel, updatedTask);

  // supersede 联动：把每条旧规则跑一遍 deprecateRule（存在性/状态判据在纯逻辑里）。
  const superseded = [];
  if (supersedes.length) {
    const newRulePathNoExt = targetPath.replace(/\.md$/, "");
    for (const oldPath of supersedes) {
      const oldRel = `${oldPath}.md`;
      const oldFile = vault.getAbstractFileByPath(oldRel);
      if (!oldFile || oldFile.children) {
        superseded.push({ path: oldRel, status: "error", message: "文件不存在" });
        continue;
      }
      let oldContent;
      try {
        oldContent = await vault.read(oldRel);
      } catch (e) {
        superseded.push({ path: oldRel, status: "error", message: String(e).slice(0, 80) });
        continue;
      }
      const supResult = review.deprecateRule(
        oldContent,
        oldRel,
        `被新规则 [[${newRulePathNoExt}]] 取代`,
        [newRulePathNoExt],
        created,
      );
      if (supResult.changed) {
        await vault.modify(oldRel, supResult.content);
        superseded.push({ path: oldRel, status: "deprecated" });
      } else {
        superseded.push({ path: oldRel, status: supResult.status, message: supResult.message || "" });
      }
    }
  }

  return {
    ok: true,
    action: "capture",
    rule: { path: targetPath, title, domain, status: "proposed" },
    task: { path: taskRel },
    date: created,
    superseded,
  };
}

// ---------- rule validate（登记验证） ----------

async function ruleValidate(vault, args, ctx) {
  const target = await resolveRuleFile(vault, flag(args, "--rule"), ctx.vaultRoot);
  const taskRel = await resolveTaskFile(vault, flag(args, "--task"), ctx.vaultRoot);
  const task = await readTaskInfo(vault, taskRel);
  if (task.type !== "task" && task.type !== "task-folder") {
    die(3, `不是任务文件（type=${task.type || "无"}）：${taskRel}`);
  }
  const note = String(flag(args, "--note") || "").trim();
  const date = todayOf(args);
  const taskPathNoExt = taskRel.replace(/\.md$/, "");

  const result = review.validateRule(target.content, target.path, taskPathNoExt, note, date);
  if (result.status === "deprecated") {
    die(3, result.message || "规则已 deprecated，不接受新验证");
  }
  if (result.status === "error") {
    die(3, result.message || "校验规则失败");
  }
  if (result.status === "noop") {
    return {
      ok: true,
      action: "validate",
      changed: false,
      status: "noop",
      message: result.message,
      rule: { path: target.path, title: target.title },
      task: { path: taskRel },
    };
  }

  await vault.modify(target.path, result.content);

  // 任务侧反向链「引用规则」块
  const updatedTask = review.appendReferencedRuleBlock(task.content, target.pathNoExt, target.title, note, date);
  if (updatedTask !== task.content) await vault.modify(taskRel, updatedTask);

  return {
    ok: true,
    action: "validate",
    changed: true,
    status: result.status, // applied | auto-promoted
    autoPromoted: !!result.autoPromoted,
    rule: { path: target.path, title: target.title },
    task: { path: taskRel },
    date,
  };
}

// ---------- rule promote（手动晋级 confirmed） ----------

async function rulePromote(vault, args, ctx) {
  const target = await resolveRuleFile(vault, flag(args, "--rule"), ctx.vaultRoot);
  const reason = String(flag(args, "--reason") || "").trim();
  const date = todayOf(args);

  const result = review.promoteRuleManual(target.content, target.path, reason, date);
  if (result.status === "deprecated") {
    die(3, result.message || "规则已 deprecated，不能手动晋级");
  }
  if (result.status === "error") {
    die(3, result.message || "晋级失败");
  }
  if (result.status === "noop") {
    return {
      ok: true,
      action: "promote",
      changed: false,
      status: "noop",
      message: result.message,
      rule: { path: target.path, title: target.title },
    };
  }
  await vault.modify(target.path, result.content);
  return {
    ok: true,
    action: "promote",
    changed: true,
    status: "applied",
    rule: { path: target.path, title: target.title, status: "confirmed" },
    date,
  };
}

// ---------- rule deprecate（废弃） ----------

async function ruleDeprecate(vault, args, ctx) {
  const target = await resolveRuleFile(vault, flag(args, "--rule"), ctx.vaultRoot);
  const reason = String(flag(args, "--reason") || "").trim();
  const supersededBy = splitList(flag(args, "--superseded-by"))
    .map((p) => normalizeRulePath(p, ctx.vaultRoot));
  const date = todayOf(args);

  const result = review.deprecateRule(target.content, target.path, reason, supersededBy, date);
  if (result.status === "error") {
    die(3, result.message || "废弃失败");
  }
  if (result.status === "noop") {
    return {
      ok: true,
      action: "deprecate",
      changed: false,
      status: "noop",
      message: result.message,
      rule: { path: target.path, title: target.title },
    };
  }
  await vault.modify(target.path, result.content);
  return {
    ok: true,
    action: "deprecate",
    changed: true,
    status: "applied",
    rule: { path: target.path, title: target.title, status: "deprecated" },
    supersededBy,
    date,
  };
}

// ---------- 分发 ----------

const ACTIONS = {
  list: ruleList,
  capture: ruleCapture,
  validate: ruleValidate,
  promote: rulePromote,
  deprecate: ruleDeprecate,
};

const USAGE = "usage: mf.js rule <list|capture|validate|promote|deprecate> "
  + "[--rule <规则路径> | --title t --task p | --domain d --task p] "
  + "[--statement s | --tags a,b | --supersedes p1,p2 | --superseded-by p1,p2 | --note n | --reason r] "
  + "[--status s] [--now YYYY-MM-DD]";

async function ruleCommand(vault, args, ctx = {}) {
  const [op, ...rest] = args;
  if (!op) die(2, USAGE);
  const fn = ACTIONS[op];
  if (!fn) die(2, `未知的 rule 子命令：${op}\n${USAGE}`);
  return fn(vault, rest, ctx);
}

// 逐级建目录（Obsidian 的 createFolder 不递归，fsVault 的递归；这段两边都成立）。
async function ensureFolder(vault, folderPath) {
  let current = "";
  for (const part of String(folderPath).split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

module.exports = { ruleCommand, ruleList, ruleCapture, ruleValidate, rulePromote, ruleDeprecate, USAGE };
