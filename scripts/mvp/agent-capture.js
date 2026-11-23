// ==============================================
// Mini Flow - agent-capture：AI 侧建任务的 standalone CLI（2026-11-09 起）
//
// 让 Claude Code 等 CLI agent 在「先问用户」之后等价执行 Task Capture：
// 复用 `_capture.js#captureIdea()` + `_task.js#buildFolderReadme()` 这条唯一写面，
// 不弹 Obsidian Modal、不手抄 README 骨架。
//
// 用法（vault 根由 _vault-root.js 定位，任意 cwd 都可跑）：
//   node flow/scripts/mvp/agent-capture.js propose --title "<任务标题>" [--now YYYY-MM-DD]
//   node flow/scripts/mvp/agent-capture.js create --json <file|-> [--now YYYY-MM-DD]
//
// propose：只读，输出推断结果 JSON，供 AskUserQuestion 面板展示（domain / 目标目录 /
//          撞名冲突 / 主题候选）。不写盘。
// create ：读 JSON（字段见下），建 folder 任务 + 月度 Capture 行 + 写 `### 调研`，输出结果 JSON。
//          {title, domain?, topic?, status?, research?}
//          domain 缺省时沿用 capture 的 inferDomain；status 缺省 active（capture 只产活跃态）。
//          isWork / kind 已下线（2026-11-16）：两者都由 domain 的 flow.json 派生，不落 frontmatter。
//
// 退出码：0 成功 / 2 usage / 3 数据或撞名冲突 / 4 IO。
// 规约：vault 根 CLAUDE.md「任务系统」capture 边界、flow/CLAUDE.md「AI 自动 capture」。
// ==============================================

const fs = require("node:fs");
const path = require("node:path");

// MINI 走同目录相对路径（共享仓布局与 vault 布局同形）；vault 根交给 _vault-root.js
// 定位——挂载后 __dirname 是共享仓的真实路径，上溯推不出 vault 根。
const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const { resolveVaultRoot } = require(path.join(MINI, "_vault-root.js"));
const VAULT_ROOT = resolveVaultRoot();

const { createFsVault } = require("./_fs-vault.js");
const capture = require(path.join(MINI, "_capture.js"));
const taskHelpers = require(path.join(MINI, "_task.js"));
const naming = require(path.join(MINI, "_naming.js"));
// 配置：CLI 能直接 require（与被 loadModule 字符串加载的脚本不同，那些只能走 loadHelper）。
// loadSync 用上面已解析出的 VAULT_ROOT，不靠 cwd / 环境变量猜；读不到回落默认值。
const CONFIG = require(path.join(MINI, "_config.js")).loadSync(VAULT_ROOT);
const workflow = require(path.join(MINI, "_workflow.js"));
const { inferDomain } = require(path.join(MINI, "_infer.js"));

const CAPTURE_STATUSES = new Set(["active"]);

class CliError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

// 抛错而不是直接 process.exit：单测可断言错误，CLI 入口在 main 的 catch 里统一退码。
function die(code, msg) {
  throw new CliError(code, msg);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

// YYYY-MM-DD → 本地时区 Date（避免 new Date("2026-11-09") 的 UTC 偏移）。
function parseNow(value) {
  if (!value) return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function readJsonSource(arg) {
  const raw = arg === "-" || arg === undefined ? fs.readFileSync(0, "utf8") : fs.readFileSync(arg, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(3, `--json 解析失败：${String(e).slice(0, 120)}`);
  }
}

// task-capture.js 里 hydrateDomainChoices 的同款平铺（keywords 从 flow.json 抽到 choice 顶层）。
async function domainChoices(vault) {
  const raw = await workflow.listDomainChoices(vault);
  return raw.map((c) => ({
    slug: c.slug,
    label: c.label,
    work: !!c.work,
    domain: c.domain || c.slug,
    keywords: c.workflow && Array.isArray(c.workflow.keywords) ? c.workflow.keywords : [],
  }));
}

async function propose(vault, { title, now }) {
  const cleanedTitle = naming.cleanTitle(title);
  if (!cleanedTitle) die(3, "任务名为空（cleanTitle 后为空）");

  const choices = await domainChoices(vault);
  const inferred = inferDomain(cleanedTitle, choices);
  if (!inferred) die(3, "没有任何可用领域（flow/data/domains/*/flow.json 缺失）");

  const maxLen = CONFIG.behavior.maxFilenameLength;
  const stem = naming.buildFileName(cleanedTitle, maxLen);
  const monthFolder = taskHelpers.inferTasksDir(null, now);
  const unique = naming.findUniquePath(vault, monthFolder, stem, maxLen);
  const targetFolder = unique.createPath.replace(/\.md$/, "");
  const readmePath = `${targetFolder}/README.md`;
  let conflict = null;
  if (vault.getAbstractFileByPath(targetFolder) || vault.getAbstractFileByPath(readmePath)) {
    conflict = `同名任务目录已存在：${targetFolder}`;
  }

  return {
    ok: true,
    title: String(title),
    cleanedTitle,
    stem,
    domain: inferred.domain,
    domainLabel: inferred.label,
    status: "active",
    monthFolder,
    targetFolder,
    conflict,
  };
}

async function create(vault, { now, payload }) {
  if (!payload || typeof payload !== "object") die(3, "create 需要 JSON 对象");
  const title = typeof payload.title === "string" ? payload.title : "";
  if (!naming.cleanTitle(title)) die(3, "title 缺失或清洗后为空");

  const choices = await domainChoices(vault);
  let choice = null;
  if (payload.domain) {
    choice = choices.find((c) => c.domain === payload.domain || c.slug === payload.domain) || null;
    if (!choice) die(3, `domain 不存在：${payload.domain}`);
  } else {
    choice = inferDomain(naming.cleanTitle(title), choices);
    if (!choice) die(3, "无法推断 domain（flow/data/domains/*/flow.json 缺失）");
  }
  const status = payload.status == null || payload.status === "" ? "active" : String(payload.status);
  if (!CAPTURE_STATUSES.has(status)) die(3, `status 非法：${status}（capture 只产 active）`);

  // 2026-11-23 砍 topic：payload.topic 已下线（不再校验、不再落 frontmatter）。
  const research = typeof payload.research === "string" ? payload.research : "";

  const result = await capture.captureIdea(vault, { naming, task: taskHelpers, config: CONFIG }, {
    title,
    status,
    now,
    domain: choice.domain,
    research,
  });

  if (result && result.conflict) {
    die(3, result.conflict);
  }
  return {
    ok: true,
    taskPath: result.taskPath,
    monthFilePath: result.monthFilePath,
    anchor: result.anchor,
    domain: choice.domain,
    domainLabel: choice.label,
    status,
    created: result.created,
  };
}

async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || (sub !== "propose" && sub !== "create")) {
    die(2, "usage: agent-capture.js <propose|create> [--title <t>] [--json <file|->] [--now YYYY-MM-DD]");
  }
  const now = parseNow(flag(rest, "--now"));
  if (!now) die(2, "--now 需要 YYYY-MM-DD");
  const vault = createFsVault(VAULT_ROOT);

  if (sub === "propose") {
    const title = flag(rest, "--title");
    if (!title) die(2, "propose 需要 --title");
    process.stdout.write(JSON.stringify(await propose(vault, { title, now }), null, 2) + "\n");
    return;
  }

  const payload = readJsonSource(flag(rest, "--json"));
  process.stdout.write(JSON.stringify(await create(vault, { now, payload }), null, 2) + "\n");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof CliError) {
      process.stderr.write(`agent-capture: ${e.message}\n`);
      process.exit(e.code);
    }
    process.stderr.write(`agent-capture: 未预期异常：${(e && e.stack) || e}\n`);
    process.exit(4);
  });
}

// readJsonSource 导出给 `defect` 组复用（2026-11-23）：`--json <file|->` 的读取与解析只此一份，
// 新子命令不许再写第二份（stdin / 文件两种形态 + 解析失败 code 3 的语义都在这里）。
module.exports = { main, propose, create, parseNow, readJsonSource, VAULT_ROOT, CliError };
