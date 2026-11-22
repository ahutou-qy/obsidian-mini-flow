// ==============================================
// Mini Flow - mf：MCP / CLI 侧的**统一入口**（2026-11-19 段 3）
//
// 形态「CLI 为主、命令面为辅」：Obsidian 的 `POST /commands/{id}/` 无 request body（拿不到
// 参数）且 fire-and-forget（取不到返回值），所以「读 + 带参 + 取结果」只能在 CLI 这侧成立。
// 调用方只学一个命令形态：
//
//   node flow/scripts/mvp/mf.js <子命令> [参数]
//
//   propose --title "<标题>" [--now YYYY-MM-DD]     只读，推断落点/域/撞名（转调 agent-capture）
//   create  --json <file|-> [--now YYYY-MM-DD]      建 folder 任务 + 月度行（转调 agent-capture）
//   finish  --path <任务目录或 README 路径>          结案：月度行 + README finish 里程碑 + 进展归档
//   reopen  --path <p>                              重开：月度行回 active + README reopen 里程碑
//   progress --path <p> --text "<一行进展>"          追加 `## 进展` 一条（与 GUI 打卡同一算法）
//   delete  --path <p>                              删任务：留底行降级 → 清双链 → 删文件（无确认）
//   query   [--status active|finish|all] [--domain <slug>] [--yunxiao] [--dep]
//                                                   读面：任务集合 / 字段（判据与 Home 卡同源）
//
// 输出：**stdout 恒为 JSON**（成功 `{"ok":true,...}`；失败 `{"ok":false,"error":...}` 走 stderr），
// 退出码沿用 agent-capture：0 成功 / 2 usage / 3 数据冲突或解析失败 / 4 IO 或未预期异常。
//
// 硬约束（flow/CLAUDE.md「MCP 对接面」）：
//   - 写动作一律走 MF 现有写面（`_capture.js` / `_task.js` / `_set-status.js`），本文件不另写一套；
//   - 读面判据走 `_home-fields.js`（插件 Home 卡调同一份），不在这里自己解析 YAML；
//   - **MCP 侧不许用 vault_write / vault_patch 直接改 MF 状态文件**——绕过写面会产出
//     「看起来改了、其实状态没改」的文件（月度行与 milestones 两处必须同写）。
//   - `agent-capture.js` 保留兼容，本文件内部转调它，不删。
// ==============================================

const path = require("node:path");

// MINI 走同目录相对路径：共享仓布局（scripts/mvp → ../quickadd/mini）与 vault 布局
// （flow/scripts/mvp → ../quickadd/mini）同形，代码放在哪边都对。
// vault 根不能再靠 __dirname 上溯——挂载后 Node 把 junction 解析成共享仓的真实路径，
// 上溯几层都到不了 vault；定位交给 _vault-root.js（见该文件头注）。
const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const { resolveVaultRoot } = require(path.join(MINI, "_vault-root.js"));
const VAULT_ROOT = resolveVaultRoot();

const { createFsVault } = require("./_fs-vault.js");
const agentCapture = require("./agent-capture.js");
const { setStatus } = require("./_set-status.js");
const { deleteTask } = require("./_delete-task.js");
const yamlHelpers = require(path.join(MINI, "_yaml.js"));
const lineHelpers = require(path.join(MINI, "_capture-line.js"));
const homeFields = require(path.join(MINI, "_home-fields.js"));
const progressHelpers = require(path.join(MINI, "_progress.js"));

const { CliError } = agentCapture;

function die(code, msg) {
  throw new CliError(code, msg);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function has(args, name) {
  return args.includes(name);
}

// --path 收任务目录或 README 路径，vault 相对或绝对都行 → 绝对任务目录。
// `_set-status.js` 要的是目录（它自己拼 README.md）。
function resolveTaskDir(raw, root = VAULT_ROOT) {
  if (!raw) die(2, "需要 --path <任务目录或 README 路径>");
  let p = String(raw).replace(/\\/g, "/").replace(/\/+$/, "");
  if (/\.md$/i.test(p)) p = p.replace(/\/[^/]+\.md$/i, "");
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  // 统一成平台原生分隔符（上面把 `\` 归一成 `/` 只为判形态），返回值口径唯一。
  return path.resolve(abs);
}

// query 的读面。active 走 `_home-fields.js#activeNodes`（与 Home「🏠 工作事务」卡同一份
// 成形判据，集合由构造保证一致）；finish/all 按 capture 行状态取，**与 Home「✅ 已完成」卡
// 口径不同**（那张卡按 README milestones 聚合、含时段追溯），别把两者的数字直接对比。
async function query(vault, args) {
  const status = flag(args, "--status") || "active";
  if (!["active", "finish", "all"].includes(status)) {
    die(2, `--status 只收 active|finish|all，收到 ${status}`);
  }
  const domain = flag(args, "--domain");
  const includeYunxiao = has(args, "--yunxiao");
  const labels = await homeFields.domainLabels(vault);

  let nodes;
  if (status === "active") {
    nodes = await homeFields.activeNodes(vault, yamlHelpers, lineHelpers, { includeYunxiao });
  } else {
    const statuses = status === "finish" ? ["finish"] : null;
    const rows = await lineHelpers.listRecentTasks(vault, {
      limit: Infinity, statuses, sort: false,
    });
    const filtered = includeYunxiao ? rows : rows.filter((r) => !r.yunxiao);
    const fields = await Promise.all(
      filtered.map((r) => homeFields.taskFields(vault, yamlHelpers, r.linkTarget || "")));
    nodes = filtered.filter((r) => r.linkTarget).map((r, i) => {
      const f = fields[i];
      const ch = f && f.chain;
      return {
        path: r.linkTarget,
        title: (r.title && !/^readme$/i.test(r.title)) ? r.title : homeFields.nameOfPath(r.linkTarget),
        domain: (f && f.domain) || r.domain || "未分类",
        parent: ch ? ch.parent : "",
        step: ch && ch.step ? ch.step : 0,
        total: ch && ch.total ? ch.total : 0,
        dep: (f && f.externalDep) || "",
        finished: !!(f && f.finished),
        anchor: r.anchor,
        monthLabel: r.monthLabel,
        status: r.status,
        completion: r.completion || "",
        yunxiao: !!r.yunxiao,
      };
    });
  }

  if (domain) nodes = nodes.filter((n) => n.domain === domain);
  if (has(args, "--dep")) nodes = nodes.filter((n) => n.dep);

  const out = {
    ok: true,
    status,
    count: nodes.length,
    // 域标签随结果给出，调用方不必再读 flow.json（判据同源）。
    domains: labels,
    tasks: nodes.map((n) => ({ ...n, domainLabel: (labels[n.domain] && labels[n.domain].label) || n.domain })),
  };

  // 兜底差集：有 dep 却不在活跃集合里的任务（Home 卡尾那行灰字的数据源）。
  if (status === "active") {
    const depRows = await homeFields.depTasks(vault, yamlHelpers, lineHelpers);
    const inSet = new Set(nodes.map((n) => n.path));
    out.depOutside = depRows.filter((r) => !inSet.has(r.path));
  }
  return out;
}

// opts 只为单测注入 fixture vault；生产入口一律用真实 vault 根。
async function run(argv, { vaultRoot = VAULT_ROOT, vault = createFsVault(VAULT_ROOT) } = {}) {
  const [sub, ...rest] = argv;

  switch (sub) {
    case "propose": {
      const title = flag(rest, "--title");
      if (!title) die(2, "propose 需要 --title");
      const now = agentCapture.parseNow(flag(rest, "--now"));
      if (!now) die(2, "--now 需要 YYYY-MM-DD");
      return agentCapture.propose(vault, { title, now });
    }
    case "create": {
      const now = agentCapture.parseNow(flag(rest, "--now"));
      if (!now) die(2, "--now 需要 YYYY-MM-DD");
      // payload 读取沿用 agent-capture 的 CLI（--json <file|->）：它自己读 stdin/文件，
      // 这里把整条子命令原样转调，避免第二份 JSON 读取实现。
      return agentCapture.main(["create", ...rest]);
    }
    case "finish": {
      const taskPath = resolveTaskDir(flag(rest, "--path"), vaultRoot);
      // quiet：人读那行文本不能混进 stdout（本 CLI 的 stdout 恒为 JSON）。
      return setStatus({ vaultRoot, taskPath, targetStatus: "finish", quiet: true });
    }
    case "reopen": {
      const taskPath = resolveTaskDir(flag(rest, "--path"), vaultRoot);
      // 重开 = 目标态 active；`_set-status.js` 判 finish→active 才写 reopen 里程碑。
      return setStatus({ vaultRoot, taskPath, targetStatus: "active", quiet: true });
    }
    case "progress": {
      const taskPath = resolveTaskDir(flag(rest, "--path"), vaultRoot);
      const body = String(flag(rest, "--text") || "").trim();
      if (!body) die(2, "progress 需要 --text <一行进展>");
      if (/[\r\n]/.test(body)) die(2, "--text 只能是单行（进展 bullet 一行一条）");
      const rel = path.relative(vaultRoot, path.join(taskPath, "README.md")).replace(/\\/g, "/");
      const file = vault.getAbstractFileByPath(rel);
      if (!file) die(2, `README.md 不存在：${rel}`);
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const prev = await vault.read(file);
      const { content, appendedLine } = progressHelpers.ensureProgressSection(prev, today, body);
      await vault.modify(file, content);
      const total = progressHelpers.countProgressBullets(content);
      return {
        ok: true,
        path: rel,
        date: today,
        appendedLine,
        total,
        softLimit: progressHelpers.SOFT_LIMIT,
        // 超阈不阻断（与 GUI 的 soft-warning 同款）：结案时会自动归档最早 N 条。
        willArchiveOnFinish: Math.max(0, total - progressHelpers.SOFT_LIMIT),
      };
    }
    case "delete": {
      const raw = flag(rest, "--path");
      if (!raw) die(2, "delete 需要 --path <任务目录或 README 路径>");
      // 单文件任务（`<任务名>.md`）也要能删：resolveTaskDir 会把 .md 剥掉，这里先判形态。
      const asFile = String(raw).replace(/\\/g, "/").replace(/\/+$/, "");
      const absFile = path.isAbsolute(asFile) ? asFile : path.resolve(vaultRoot, asFile);
      const isSingle = /\.md$/i.test(asFile) && !/\/README\.md$/i.test(asFile);
      const taskPath = isSingle ? absFile.replace(/\.md$/i, "") : resolveTaskDir(raw, vaultRoot);
      return deleteTask({ vaultRoot, taskPath, vault });
    }
    case "query":
      return query(vault, rest);
    default:
      die(2, "usage: mf.js <propose|create|finish|reopen|progress|delete|query> "
        + "[--title t | --json f | --path p [--text t] | --status s --domain d --yunxiao --dep]");
  }
}

// stdout 只出 JSON。create 走 agentCapture.main（它自己写 stdout），所以返回 undefined 时不重复输出。
async function main(argv) {
  const result = await run(argv);
  if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    // CliError（本文件 / agent-capture）与 SetStatusError（_set-status）都带 code，语义一致。
    const code = typeof (e && e.code) === "number" ? e.code : 4;
    const msg = typeof (e && e.code) === "number" ? e.message : `未预期异常：${(e && e.stack) || e}`;
    process.stderr.write(JSON.stringify({ ok: false, error: msg, code }) + "\n");
    process.exit(code);
  });
}

module.exports = { main, run, query, resolveTaskDir, VAULT_ROOT };