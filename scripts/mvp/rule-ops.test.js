// _rule-ops.js 的裸 node 单测：node --test flow/scripts/mvp/rule-ops.test.js
//
// 验收锁：
//   ① 四个规则动作在**无 GUI**下带参跑通，写面与 Obsidian 交互面同一份
//      （`_rule.js` / `_rule-review.js`）——规则骨架、validated_by、## 变更 段、
//      任务侧 `## 产出规则` / `## 引用规则` 块；
//   ② 幂等：已登记 / 已 confirmed / 已 deprecated → ok:true + status:"noop"，不是错误；
//      数据冲突（规则已 deprecated 不接受验证、不能手动晋级、规则已存在）→ code 3；
//   ③ 显式参数契约：`--domain` 缺省回落任务 frontmatter 的 domain；`--task` 收目录 /
//      README / 单文件 .md 三种形态；缺参 / 越界路径 → code 2 / 3；
//   ④ 建规则写的 `validated_by: []`（inline 空数组）在首次登记验证时被**替换**，
//      不在 frontmatter 里留下第二个 `validated_by:` 块（重复 YAML 键）。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFsVault } = require("./_fs-vault.js");
const { CliError } = require("./agent-capture.js");
const { ruleCommand } = require("./_rule-ops.js");
const { run } = require("./mf.js");

const DOMAINS = "flow/data/domains";
const TASKS = "flow/data/2026/Q4/11";

function taskReadme({ type = "task-folder", domain = "work7" } = {}) {
  return [
    "---",
    `type: ${type}`,
    'source: "[[../ideas-2026-11#^cap-x]]"',
    `domain: ${domain}`,
    "milestones:",
    "  - {date: '2026-11-01', type: create}",
    "---",
    "",
    "# 任务",
    "",
  ].join("\n");
}

function ruleFile({ status = "proposed", validatedBy = "validated_by: []" } = {}) {
  return [
    "---",
    "type: rule",
    `domain: work7`,
    `status: ${status}`,
    "created: 2026-11-01",
    "sources:",
    '  - "[[flow/data/2026/Q4/11/T/README]]"',
    validatedBy,
    "---",
    "",
    "# 既有规则",
    "",
    "## 规则",
    "一句话。",
    "",
    "## 变更",
    "- 2026-11-01 | proposed from [[flow/data/2026/Q4/11/T/README]]",
    "",
  ].join("\n");
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rule-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  };
  write(`${DOMAINS}/work7/flow.json`, JSON.stringify({ label: "work7", work: true }));
  write(`${DOMAINS}/work7/rules/既有规则.md`, ruleFile());
  write(`${DOMAINS}/growth/rules/.keep`, "");
  write(`${TASKS}/T/README.md`, taskReadme());
  write(`${TASKS}/T2/README.md`, taskReadme());
  write(`${TASKS}/S.md`, taskReadme({ type: "task" }));
  return { root, vault: createFsVault(root) };
}

const ctxOf = (root) => ({ vaultRoot: root });

function readRule(root, slug) {
  return fs.readFileSync(path.join(root, DOMAINS, "work7", "rules", `${slug}.md`), "utf8");
}

// ---------- rule list ----------

test("rule list：列出全部域 / 按域 / 按状态过滤，带 uniqueCount", async () => {
  const { root, vault } = makeVault();
  const all = await ruleCommand(vault, ["list"], ctxOf(root));
  assert.equal(all.ok, true);
  assert.equal(all.count, 1);
  assert.equal(all.rules[0].status, "proposed");
  assert.equal(all.rules[0].uniqueCount, 1); // sources 只有 T 一个任务

  const byDomain = await ruleCommand(vault, ["list", "--domain", "work7"], ctxOf(root));
  assert.equal(byDomain.count, 1);
  const byStatus = await ruleCommand(vault, ["list", "--status", "confirmed"], ctxOf(root));
  assert.equal(byStatus.count, 0);

  await assert.rejects(
    () => ruleCommand(vault, ["list", "--status", "now"], ctxOf(root)),
    (e) => e instanceof CliError && e.code === 2);
  await assert.rejects(
    () => ruleCommand(vault, ["list", "--domain", "不存在"], ctxOf(root)),
    (e) => e instanceof CliError && e.code === 3);
});

// ---------- rule capture ----------

test("rule capture：建 proposed 规则 + 任务侧 ## 产出规则；--domain 回落任务 frontmatter", async () => {
  const { root, vault } = makeVault();
  const r = await ruleCommand(vault, [
    "capture", "--title", "新规则标题", "--task", `${TASKS}/T`,
    "--statement", "在 X 下必须 Y", "--tags", "上报,异步", "--now", "2026-11-23",
  ], ctxOf(root));

  assert.equal(r.ok, true);
  assert.equal(r.rule.status, "proposed");
  assert.equal(r.rule.domain, "work7"); // 任务 frontmatter domain 回落
  const text = readRule(root, "新规则标题");
  assert.match(text, /^status: proposed$/m);
  assert.match(text, /^created: 2026-11-23$/m);
  assert.match(text, /"\[\[flow\/data\/2026\/Q4\/11\/T\/README\]\]"/);
  assert.match(text, /rule\/work7\/上报/);

  const task = fs.readFileSync(path.join(root, TASKS, "T", "README.md"), "utf8");
  assert.match(task, /## 产出规则/);
  assert.match(task, /\[\[flow\/data\/domains\/work7\/rules\/新规则标题\|新规则标题\]\]/);
});

test("rule capture：单文件任务（<名>.md）也认；撞名 → code 3", async () => {
  const { root, vault } = makeVault();
  const r = await ruleCommand(vault, [
    "capture", "--title", "单文件来源", "--task", `${TASKS}/S`,
    "--domain", "work7", "--now", "2026-11-23",
  ], ctxOf(root));
  assert.equal(r.task.path, `${TASKS}/S.md`);
  assert.match(readRule(root, "单文件来源"), /"\[\[flow\/data\/2026\/Q4\/11\/S\]\]"/);

  await assert.rejects(
    () => ruleCommand(vault, ["capture", "--title", "单文件来源", "--task", `${TASKS}/S`, "--domain", "work7"], ctxOf(root)),
    (e) => e instanceof CliError && e.code === 3);
});

test("rule capture：--supersedes 联动把旧规则标 deprecated", async () => {
  const { root, vault } = makeVault();
  const r = await ruleCommand(vault, [
    "capture", "--title", "替代者", "--task", `${TASKS}/T`, "--domain", "work7",
    "--supersedes", `${DOMAINS}/work7/rules/既有规则`, "--now", "2026-11-23",
  ], ctxOf(root));
  assert.deepEqual(r.superseded.map((s) => s.status), ["deprecated"]);
  const old = readRule(root, "既有规则");
  assert.match(old, /^status: deprecated$/m);
  assert.match(old, /superseded_by:\n  - "\[\[flow\/data\/domains\/work7\/rules\/替代者\]\]"/);
});

// ---------- rule validate ----------

test("rule validate：写 validated_by 块（不留重复键）+ 任务侧 ## 引用规则；跨任务达阈值自动晋级", async () => {
  const { root, vault } = makeVault();
  const r = await ruleCommand(vault, [
    "validate", "--rule", `${DOMAINS}/work7/rules/既有规则`, "--task", `${TASKS}/T2`,
    "--note", "实测通过", "--now", "2026-11-23",
  ], ctxOf(root));

  assert.equal(r.ok, true);
  assert.equal(r.status, "auto-promoted");
  assert.equal(r.autoPromoted, true);

  const text = readRule(root, "既有规则");
  // 建规则时是 inline `validated_by: []`；写后必须只有一个 validated_by 键（块形式）。
  assert.equal((text.match(/^validated_by\s*:/gm) || []).length, 1);
  assert.match(text, /validated_by:\n  - "\[\[flow\/data\/2026\/Q4\/11\/T2\/README\]\]/);
  assert.match(text, /^status: confirmed$/m);
  assert.match(text, /## 变更[\s\S]*validated by/);
  assert.match(text, /auto-confirm/);

  const task = fs.readFileSync(path.join(root, TASKS, "T2", "README.md"), "utf8");
  assert.match(task, /## 引用规则/);
  assert.match(task, /\[\[flow\/data\/domains\/work7\/rules\/既有规则\|既有规则\]\]（验证于 2026-11-23：实测通过）/);
});

test("rule validate：同一任务重复登记 → noop（不是错误）；规则已 deprecated → code 3", async () => {
  const { root, vault } = makeVault();
  await ruleCommand(vault, [
    "validate", "--rule", `${DOMAINS}/work7/rules/既有规则`, "--task", `${TASKS}/T`,
  ], ctxOf(root));
  const again = await ruleCommand(vault, [
    "validate", "--rule", `${DOMAINS}/work7/rules/既有规则`, "--task", `${TASKS}/T`,
  ], ctxOf(root));
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.status, "noop");

  fs.writeFileSync(path.join(root, DOMAINS, "work7", "rules", "既有规则.md"),
    ruleFile({ status: "deprecated" }), "utf8");
  await assert.rejects(
    () => ruleCommand(vault, ["validate", "--rule", `${DOMAINS}/work7/rules/既有规则`, "--task", `${TASKS}/T2`], ctxOf(root)),
    (e) => e instanceof CliError && e.code === 3);
});

// ---------- rule promote / deprecate ----------

test("rule promote：手动晋级 confirmed；再晋级 → noop；deprecated 规则 → code 3", async () => {
  const { root, vault } = makeVault();
  const r = await ruleCommand(vault, [
    "promote", "--rule", `${DOMAINS}/work7/rules/既有规则`, "--reason", "人工评审", "--now", "2026-11-23",
  ], ctxOf(root));
  assert.equal(r.status, "applied");
  assert.match(readRule(root, "既有规则"), /^status: confirmed$/m);
  assert.match(readRule(root, "既有规则"), /manual promote：人工评审/);

  const again = await ruleCommand(vault, ["promote", "--rule", `${DOMAINS}/work7/rules/既有规则`], ctxOf(root));
  assert.equal(again.status, "noop");
  assert.equal(again.changed, false);

  fs.writeFileSync(path.join(root, DOMAINS, "work7", "rules", "既有规则.md"),
    ruleFile({ status: "deprecated" }), "utf8");
  await assert.rejects(
    () => ruleCommand(vault, ["promote", "--rule", `${DOMAINS}/work7/rules/既有规则`], ctxOf(root)),
    (e) => e instanceof CliError && e.code === 3);
});

test("rule deprecate：写 deprecated + superseded_by；重复 → noop", async () => {
  const { root, vault } = makeVault();
  const r = await ruleCommand(vault, [
    "deprecate", "--rule", `${DOMAINS}/work7/rules/既有规则`, "--reason", "被取代",
    "--superseded-by", `${DOMAINS}/work7/rules/新规则`, "--now", "2026-11-23",
  ], ctxOf(root));
  assert.equal(r.status, "applied");
  const text = readRule(root, "既有规则");
  assert.match(text, /^status: deprecated$/m);
  assert.match(text, /superseded_by:\n  - "\[\[flow\/data\/domains\/work7\/rules\/新规则\]\]"/);

  const again = await ruleCommand(vault, ["deprecate", "--rule", `${DOMAINS}/work7/rules/既有规则`], ctxOf(root));
  assert.equal(again.status, "noop");
});

// ---------- 参数与错误面 ----------

test("缺参 / 未知子命令 / 规则不是 type: rule → 各自退码", async () => {
  const { root, vault } = makeVault();
  await assert.rejects(() => ruleCommand(vault, [], ctxOf(root)), (e) => e.code === 2);
  await assert.rejects(() => ruleCommand(vault, ["nope"], ctxOf(root)), (e) => e.code === 2);
  await assert.rejects(() => ruleCommand(vault, ["validate", "--rule", `${DOMAINS}/work7/rules/既有规则`], ctxOf(root)),
    (e) => e.code === 2);
  await assert.rejects(() => ruleCommand(vault, ["validate", "--rule", `${DOMAINS}/work7/rules/不存在`, "--task", `${TASKS}/T`], ctxOf(root)),
    (e) => e.code === 3);
  // 拿任务文件当规则文件 → type 不符
  await assert.rejects(
    () => ruleCommand(vault, ["promote", "--rule", `${TASKS}/T/README`], ctxOf(root)),
    (e) => e.code === 3);
  await assert.rejects(
    () => ruleCommand(vault, ["capture", "--title", "x", "--task", `${TASKS}/不存在`, "--domain", "work7"], ctxOf(root)),
    (e) => e.code === 2);
});

test("mf.js 分发：run([\"rule\", ...]) 走同一条实现", async () => {
  const { root } = makeVault();
  const r = await run(["rule", "list", "--status", "proposed"],
    { vaultRoot: root, vault: createFsVault(root) });
  assert.equal(r.ok, true);
  assert.equal(r.action, "list");
  assert.equal(r.count, 1);
});
