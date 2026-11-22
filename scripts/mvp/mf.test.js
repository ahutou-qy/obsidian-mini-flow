// mf.js / _home-fields.js 的裸 node 单测：node --test flow/scripts/mvp/mf.test.js
//
// 段 3 的验收锁：
//   ① `query --status active` 的集合与 Home「🏠 工作事务」活跃卡**逐条一致**——
//      测试里独立复现下沉前 Home 块的口径（listRecentTasks → 滤 yunxiao → taskFields → 成形），
//      与 activeNodes 的产出比对 path/title/domain/parent/step/total/dep；
//   ② 判据同源：结案判定（末位 reopen 不算结案）、domain 标签、状态归一都只有一处实现；
//   ③ CLI 形态：--domain / --dep / --status 过滤、resolveTaskDir 的四种入参、usage 退码 2。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFsVault } = require("./_fs-vault.js");
const { query, resolveTaskDir, VAULT_ROOT } = require("./mf.js");
const { CliError } = require("./agent-capture.js");

const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const yaml = require(path.join(MINI, "_yaml.js"));
const line = require(path.join(MINI, "_capture-line.js"));
const fields = require(path.join(MINI, "_home-fields.js"));

const MONTH_DIR = "flow/data/2026/Q4";
const IDEAS = `${MONTH_DIR}/ideas-2026-11.md`;

function taskReadme({ type = "task-folder", domain = "vault", milestones = [], dep = "", chain = null }) {
  const ms = ["  - {date: '2026-11-01', type: create}", ...milestones];
  const fm = [
    "---",
    `type: ${type}`,
    'source: "[[../ideas-2026-11#^cap-x]]"',
    `domain: ${domain}`,
    "milestones:",
    ...ms,
  ];
  if (dep) fm.push(`external_dep: "${dep}"`);
  if (chain) {
    fm.push("chain:");
    fm.push(`  parent: ${chain.parent}`);
    fm.push(`  step: ${chain.step}`);
    fm.push(`  total: ${chain.total}`);
  }
  fm.push("---", "", "# T", "");
  return fm.join("\n");
}

// fixture：6 条 capture 行覆盖 active / finish / 历史别名 / yunxiao / 无链接 / README 别名。
function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-query-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  };

  for (const [slug, cfg] of Object.entries({
    vault: { label: "Vault 基建", work: true },
    growth: { label: "个人", work: false },
  })) {
    write(`flow/data/domains/${slug}/flow.json`, JSON.stringify(cfg));
  }

  const rows = [
    `- [[11/A/README|A 任务]] #active ^cap-a`,
    `- [[11/B/README|B 任务]] #next ^cap-b`,                       // 历史别名 → active
    `- [[11/C/README|C 任务]] #finish [completion:: 2026-11-02] ^cap-c`,
    `- [[11/D/README|D 任务]] #yunxiao #active ^cap-d`,            // 云效项，活跃卡滤掉
    `- [[11/E/README|README]] #active ^cap-e`,                     // 别名是 README → 退目录名
    `- 纯文本没有链接 #active ^cap-f`,                              // 无 linkTarget → 丢弃
    `- [[11/G/README|G 任务]] #active ^cap-g`,                     // 有 dep
    `- [[11/H/README|H 任务]] #active ^cap-h`,                     // README 已 finish（仍进活跃集合）
  ];
  write(IDEAS, ["---", "tags: ideas", "---", "", "## Capture", "", ...rows, ""].join("\n"));

  write(`${MONTH_DIR}/11/A/README.md`, taskReadme({ domain: "vault" }));
  write(`${MONTH_DIR}/11/B/README.md`, taskReadme({ domain: "growth" }));
  write(`${MONTH_DIR}/11/C/README.md`, taskReadme({ milestones: ["  - {date: '2026-11-02', type: finish}"] }));
  write(`${MONTH_DIR}/11/D/README.md`, taskReadme({ domain: "vault" }));
  write(`${MONTH_DIR}/11/E/README.md`, taskReadme({ domain: "growth" }));
  write(`${MONTH_DIR}/11/G/README.md`, taskReadme({
    domain: "vault", dep: "等厂商给协议文档，找张三，期望 11-25",
    chain: { parent: `${MONTH_DIR}/11/A/README`, step: 2, total: 4 },
  }));
  write(`${MONTH_DIR}/11/H/README.md`, taskReadme({ milestones: ["  - {date: '2026-11-03', type: finish}"] }));
  // 单文件任务 + dep + 无 capture 行：只应出现在 depOutside（差集），不在活跃集合。
  write(`${MONTH_DIR}/11/single.md`, taskReadme({ type: "task", dep: "等客户确认口径" }));
  // 已结案且有 dep：差集也不该收它。
  write(`${MONTH_DIR}/11/I/README.md`, taskReadme({
    dep: "早就解决了", milestones: ["  - {date: '2026-11-04', type: finish}"],
  }));

  return { root, vault: createFsVault(root) };
}

// 下沉前 Home 块的口径（**测试内的独立复现**，用于对账，不是生产第二份实现）。
async function legacyHomeNodes(vault) {
  const rows = (await line.listRecentTasks(vault, {
    limit: Infinity, statuses: ["active"], app: null, sort: false,
  })).filter((r) => !r.yunxiao);
  const nameOfPath = (p) => p.split("/").slice(-2, -1)[0] || p;
  const out = [];
  for (const r of rows) {
    if (!r.linkTarget) continue;
    const f = await fields.taskFields(vault, yaml, r.linkTarget);
    const ch = f && f.chain;
    out.push({
      path: r.linkTarget,
      title: (r.title && !/^readme$/i.test(r.title)) ? r.title : nameOfPath(r.linkTarget),
      domain: (f && f.domain) || r.domain || "未分类",
      parent: ch ? ch.parent : "",
      step: ch && ch.step ? ch.step : 0,
      total: ch && ch.total ? ch.total : 0,
      dep: (f && f.externalDep) || "",
    });
  }
  return out;
}

const shape = (n) => ({
  path: n.path, title: n.title, domain: n.domain,
  parent: n.parent, step: n.step, total: n.total, dep: n.dep,
});

test("query active：与 Home 活跃卡老口径逐条一致（集合 + 七个字段）", async () => {
  const { vault } = makeVault();
  const r = await query(vault, ["--status", "active"]);
  const legacy = await legacyHomeNodes(vault);

  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks.map(shape), legacy.map(shape));
  // 云效行、无链接行都不在集合里；README 别名的那条退成目录名。
  assert.equal(r.tasks.some((t) => t.path.endsWith("/D/README")), false);
  assert.equal(r.tasks.some((t) => t.title === "E"), true);
  // README 已 finish 但 capture 行仍 active → 仍在活跃集合（finished 只作字段）。
  const h = r.tasks.find((t) => t.path.endsWith("/H/README"));
  assert.equal(h.finished, true);
});

test("query active：depOutside 收「有 dep 却不在活跃集合」的单文件任务，不收已结案的", async () => {
  const { vault } = makeVault();
  const r = await query(vault, ["--status", "active"]);
  const outside = r.depOutside.map((x) => x.path);
  assert.deepEqual(outside, [`${MONTH_DIR}/11/single`]);
  // 活跃集合内的 G 有 dep，但不该出现在差集里。
  assert.equal(outside.some((p) => p.endsWith("/G/README")), false);
});

test("query --domain / --dep 过滤", async () => {
  const { vault } = makeVault();
  const byDomain = await query(vault, ["--status", "active", "--domain", "growth"]);
  assert.deepEqual(byDomain.tasks.map((t) => t.title).sort(), ["B 任务", "E"]);
  const byDep = await query(vault, ["--status", "active", "--dep"]);
  assert.deepEqual(byDep.tasks.map((t) => t.title), ["G 任务"]);
  assert.equal(byDep.tasks[0].domainLabel, "Vault 基建");
});

test("query --status finish / all：按 capture 行状态取，带 completion", async () => {
  const { vault } = makeVault();
  const fin = await query(vault, ["--status", "finish"]);
  assert.deepEqual(fin.tasks.map((t) => t.title), ["C 任务"]);
  assert.equal(fin.tasks[0].completion, "2026-11-02");
  assert.equal(fin.depOutside, undefined, "差集只在 active 口径下给");
  const all = await query(vault, ["--status", "all", "--yunxiao"]);
  assert.equal(all.tasks.length > fin.tasks.length, true);
  assert.equal(all.tasks.some((t) => t.yunxiao), true);
});

test("query --status 非法 → CliError(2)", async () => {
  const { vault } = makeVault();
  await assert.rejects(() => query(vault, ["--status", "now"]), (e) => e instanceof CliError && e.code === 2);
});

test("finishedFromMilestones：末位 reopen 不算结案，无 finish 不算，空数组不算", () => {
  assert.equal(fields.finishedFromMilestones([{ type: "create" }]), false);
  assert.equal(fields.finishedFromMilestones([{ type: "create" }, { type: "finish" }]), true);
  assert.equal(fields.finishedFromMilestones([{ type: "finish" }, { type: "reopen" }]), false);
  assert.equal(fields.finishedFromMilestones([{ type: "finish" }, { type: "reopen" }, { type: "finish" }]), true);
  assert.equal(fields.finishedFromMilestones([]), false);
  assert.equal(fields.finishedFromMilestones(null), false);
});

test("fsVault.list：形状对齐 adapter.list，缺目录给空不抛", async () => {
  const { vault } = makeVault();
  const r = await vault.list(`${MONTH_DIR}/11`);
  assert.equal(r.folders.includes(`${MONTH_DIR}/11/A`), true);
  assert.equal(r.files.includes(`${MONTH_DIR}/11/single.md`), true);
  assert.deepEqual(await vault.list("flow/data/9999"), { files: [], folders: [] });
});

test("taskCandidateFiles：fsVault 侧按目录结构走，不递归进任务子目录", async () => {
  const { root, vault } = makeVault();
  const deep = `${MONTH_DIR}/11/A/input/sdk/deep.md`;
  fs.mkdirSync(path.dirname(path.join(root, deep)), { recursive: true });
  fs.writeFileSync(path.join(root, deep), "---\ntype: task\n---\n", "utf8");
  const files = (await fields.taskCandidateFiles(vault, line)).map((f) => f.path);
  assert.equal(files.includes(deep), false);
  assert.equal(files.includes(`${MONTH_DIR}/11/A/README.md`), true);
  assert.equal(files.includes(`${MONTH_DIR}/11/single.md`), true);
});

// ---------- 段 4：progress / reopen / delete ----------

const { run } = require("./mf.js");

// 带一条 capture 行的最小任务 fixture（delete 要验留底行与双链）。
function makeTaskVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-cmd-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  };
  write(`flow/data/domains/vault/flow.json`, JSON.stringify({ label: "Vault 基建", work: true }));
  write(IDEAS, [
    "---", "tags: ideas", "---", "", "## Capture", "",
    `- [[11/T/README|T 任务]] #active ^cap-t`,
    `- [[11/U/README|U 任务]] #active ^cap-u`,
    "",
  ].join("\n"));
  const readme = [
    "---", "type: task-folder", 'source: "[[../ideas-2026-11#^cap-t]]"',
    "domain: vault", "milestones:", "  - {date: '2026-11-01', type: create}", "---",
    "", "# T 任务", "", "## 进展", "", "## 输入", "",
  ].join("\n");
  write(`${MONTH_DIR}/11/T/README.md`, readme);
  write(`${MONTH_DIR}/11/T/process/01-x.md`, "过程文档");
  // 别的任务引用它：全路径链 + 短链两种形态，删除时都该被清掉。
  write(`${MONTH_DIR}/11/U/README.md`, [
    "---", "type: task-folder", 'source: "[[../ideas-2026-11#^cap-u]]"',
    "domain: vault", "milestones:", "  - {date: '2026-11-01', type: create}", "---",
    "", "# U 任务", "",
    `引用 [[${MONTH_DIR}/11/T/README|T]] 与短链 [[11/T/README]]，`,
    `以及不相关的 [[${MONTH_DIR}/11/U/README|自己]]。`, "",
  ].join("\n"));
  return { root, vault: createFsVault(root), taskDir: path.join(root, MONTH_DIR, "11", "T") };
}

test("progress：追加一条到 ## 进展，返回行号与条数；超阈只报不阻断", async () => {
  const { root, vault, taskDir } = makeTaskVault();
  const r = await run(["progress", "--path", taskDir, "--text", "第一段进展"], { vaultRoot: root, vault });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.willArchiveOnFinish, 0);
  const text = fs.readFileSync(path.join(taskDir, "README.md"), "utf8");
  // 追加位置与 GUI 打卡同款：段头后紧跟 bullet（算法会吃掉段头后的空白）。
  assert.match(text, /## 进展\n- \d{4}-\d{2}-\d{2} \| 第一段进展/);
  assert.ok(text.split("\n")[r.appendedLine].includes("第一段进展"));

  for (let i = 2; i <= 7; i += 1) {
    await run(["progress", "--path", taskDir, "--text", `第 ${i} 段`], { vaultRoot: root, vault });
  }
  const last = await run(["progress", "--path", taskDir, "--text", "第 8 段"], { vaultRoot: root, vault });
  assert.equal(last.total, 8);
  assert.equal(last.willArchiveOnFinish, 3, "超阈只报数，不在打卡时归档");
});

test("progress：--text 缺失 / 多行 → CliError(2)", async () => {
  const { root, vault, taskDir } = makeTaskVault();
  await assert.rejects(() => run(["progress", "--path", taskDir], { vaultRoot: root, vault }),
    (e) => e.code === 2);
  await assert.rejects(() => run(["progress", "--path", taskDir, "--text", "a\nb"], { vaultRoot: root, vault }),
    (e) => e.code === 2);
});

test("reopen：finish 后重开，月度行回 active + README 记 reopen", async () => {
  const { root, vault, taskDir } = makeTaskVault();
  await run(["finish", "--path", taskDir], { vaultRoot: root, vault });
  const r = await run(["reopen", "--path", taskDir], { vaultRoot: root, vault });
  assert.equal(r.targetStatus, "active");
  assert.equal(r.milestone.type, "reopen");
  const ideas = fs.readFileSync(path.join(root, IDEAS), "utf8");
  assert.match(ideas, /\[\[11\/T\/README\|T 任务\]\] #active \^cap-t/);
  const readme = fs.readFileSync(path.join(taskDir, "README.md"), "utf8");
  assert.match(readme, /type: finish/);
  assert.match(readme, /type: reopen/);
});

test("delete：留底行降级为纯文本、双链清掉、任务目录删除，别的链接不动", async () => {
  const { root, vault, taskDir } = makeTaskVault();
  const r = await run(["delete", "--path", taskDir], { vaultRoot: root, vault });

  assert.equal(r.ok, true);
  assert.equal(r.demoted, true);
  assert.equal(r.captureLineKept, true);
  assert.equal(fs.existsSync(taskDir), false);

  const ideas = fs.readFileSync(path.join(root, IDEAS), "utf8");
  // 留底行还在，但不再是 wikilink（否则 Home 点它会新建空笔记）。
  assert.match(ideas, /^- T 任务 #active \^cap-t$/m);
  assert.equal(ideas.includes("[[11/T/README"), false);
  // 别的任务的 capture 行不受影响。
  assert.match(ideas, /\[\[11\/U\/README\|U 任务\]\]/);

  const u = fs.readFileSync(path.join(root, MONTH_DIR, "11", "U", "README.md"), "utf8");
  assert.equal(u.includes("11/T/README"), false, "全路径链与短链都该清掉");
  assert.match(u, /\[\[flow\/data\/2026\/Q4\/11\/U\/README\|自己\]\]/, "不相关的链接保留");
  assert.deepEqual(r.backlinksCleaned, [`${MONTH_DIR}/11/U/README.md`]);
});

test("delete：单文件任务（<名>.md）也能删", async () => {
  const { root, vault } = makeTaskVault();
  const single = `${MONTH_DIR}/11/S.md`;
  const abs = path.join(root, single);
  fs.writeFileSync(abs, [
    "---", "type: task", 'source: "[[../ideas-2026-11#^cap-s]]"',
    "domain: vault", "milestones:", "  - {date: '2026-11-01', type: create}", "---", "", "# S", "",
  ].join("\n"), "utf8");
  const ideasPath = path.join(root, IDEAS);
  fs.writeFileSync(ideasPath, fs.readFileSync(ideasPath, "utf8").replace(
    "## Capture\n\n", "## Capture\n\n- [[11/S|S 任务]] #active ^cap-s\n"), "utf8");

  const r = await run(["delete", "--path", single], { vaultRoot: root, vault });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(abs), false);
  assert.match(fs.readFileSync(ideasPath, "utf8"), /^- S 任务 #active \^cap-s$/m);
});

test("delete：路径不存在 → code 2，且不动任何文件", async () => {
  const { root, vault } = makeTaskVault();
  const before = fs.readFileSync(path.join(root, IDEAS), "utf8");
  await assert.rejects(
    () => run(["delete", "--path", `${MONTH_DIR}/11/不存在`], { vaultRoot: root, vault }),
    (e) => e.code === 2);
  assert.equal(fs.readFileSync(path.join(root, IDEAS), "utf8"), before);
});

test("resolveTaskDir：目录 / README / 相对 / 绝对四种入参都归到绝对任务目录", () => {
  const abs = path.resolve(VAULT_ROOT, "flow/data/2026/Q4/11/T");
  assert.equal(resolveTaskDir("flow/data/2026/Q4/11/T"), abs);
  assert.equal(resolveTaskDir("flow/data/2026/Q4/11/T/README.md"), abs);
  assert.equal(resolveTaskDir(abs.replace(/\\/g, "/")), abs);
  assert.equal(resolveTaskDir(`${abs.replace(/\\/g, "/")}/README.md`), abs);
  assert.throws(() => resolveTaskDir(undefined), (e) => e instanceof CliError && e.code === 2);
});