// 新增 CLI 子命令的裸 node 单测：node --test flow/scripts/mvp/actions-ops.test.js
//
// 覆盖 2026-11-23 接入的三组动作（都不是 rule）：
//   ① idea  —— 闪念写入 flow/ideas-home.txt（格式/落点与 idea-capture.js 一致）
//   ② topic —— **已下线**（2026-11-23 砍 topic：阶段二删 _topic-ops.js 与 mf.js topic 分发，
//              本文件的 topic create/list 用例一并移除；下线行为由 set --topic 的 code 2 用例守）
//   ③ rename/set —— Task Edit 的 CLI 面：改标题三处写 + 全库链接重写；换域（--topic 已下线）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFsVault } = require("./_fs-vault.js");
const { CliError } = require("./agent-capture.js");
const { ideaAdd } = require("./_idea-ops.js");
const { taskMetaCommand } = require("./_task-meta-ops.js");
const { run } = require("./mf.js");

const Q = "flow/data/2026/Q4";
const TASKS = `${Q}/11`;
const SENTINEL = "<!-- _task.js render: nav line — 不要手改 -->";

function readme({ title = "T 任务", domain = "vault" } = {}) {
  return [
    "---",
    "type: task-folder",
    'source: "[[../../ideas-2026-11#^cap-t]]"',
    `domain: ${domain}`,
    "milestones:",
    "  - {date: '2026-11-01', type: create}",
    'topic: "MiniFlow"',
    "---",
    "",
    `# ${title}`,
    "",
    "来源：[[../../ideas-2026-11#^cap-t]]",
    SENTINEL,
    `> **领域：** [[flow/data/domains/${domain}/CLAUDE|Vault 基建 规则库]]`,
    "> **主题：** [[flow/data/topics/MiniFlow|MiniFlow]]",
    "",
    "## 进展",
    "",
  ].join("\n");
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-actions-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  };
  write("flow/ideas-home.txt", "- 旧闪念\n");
  write("flow/data/domains/vault/flow.json", JSON.stringify({ label: "Vault 基建", work: true }));
  write("flow/data/domains/growth/flow.json", JSON.stringify({ label: "个人", work: false }));
  write("flow/data/topics/MiniFlow.md", [
    "---", "type: topic", 'topic_id: "MiniFlow"', "status: active", "---", "", "# MiniFlow", "",
  ].join("\n"));
  write(`${Q}/ideas-2026-11.md`, [
    "---", "tags: ideas", "---", "", "## Capture", "",
    `- [[11/T/README|T 任务]] #active ^cap-t`,
    `- [[11/U/README|U 任务]] #active ^cap-u`,
    "",
  ].join("\n"));
  write(`${TASKS}/T/README.md`, readme());
  write(`${TASKS}/T/process/01-x.md`, [
    "---", "type: note", "---", "", "# 过程",
    "", "引用自己 [[flow/data/2026/Q4/11/T/README|T]] 与兄弟 [[01-x|自链]]。", "",
  ].join("\n"));
  write(`${TASKS}/U/README.md`, [
    "---",
    "type: task-folder",
    'source: "[[../../ideas-2026-11#^cap-u]]"',
    "domain: vault",
    "milestones:",
    "  - {date: '2026-11-01', type: create}",
    "chain:",
    `  parent: ${TASKS}/T/README`,
    "  step: 2",
    "  total: 4",
    "---",
    "",
    "# U 任务",
    "",
    `- 拆自 [[${TASKS}/T/README|T 任务]] 第 2 步`,
    "",
  ].join("\n"));
  return { root, vault: createFsVault(root) };
}

const ctxOf = (root) => ({ vaultRoot: root });
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

// ---------- idea ----------

test("idea：追加一行到 ideas-home.txt，格式与 idea-capture.js 一致", async () => {
  const { root, vault } = makeVault();
  const r = await ideaAdd(vault, ["--text", "记一条新闪念"], ctxOf(root));
  assert.equal(r.ok, true);
  assert.equal(r.path, "flow/ideas-home.txt");
  assert.equal(r.count, 2);
  assert.equal(read(root, "flow/ideas-home.txt"), "- 旧闪念\n- 记一条新闪念\n");
  // 文件不存在时新建
  const second = await ideaAdd(vault, ["--text", "另一条"], ctxOf(root));
  assert.equal(second.count, 3);
});

test("idea：空内容 / 多行 → code 2", async () => {
  const { root, vault } = makeVault();
  await assert.rejects(() => ideaAdd(vault, [], ctxOf(root)), (e) => e instanceof CliError && e.code === 2);
  await assert.rejects(() => ideaAdd(vault, ["--text", "a\nb"], ctxOf(root)), (e) => e.code === 2);
});

// ---------- set（topic 已下线 / domain） ----------

test("set --domain：frontmatter 与正文导航行一起改（label 取 flow.json）", async () => {
  const { root, vault } = makeVault();
  const r = await taskMetaCommand(vault, ["set", "--path", `${TASKS}/T`, "--domain", "growth"], ctxOf(root));
  assert.equal(r.changed, true);
  assert.equal(r.domain, "growth");
  const text = read(root, `${TASKS}/T/README.md`);
  assert.match(text, /^domain: growth$/m);
  assert.match(text, /> \*\*领域：\*\* \[\[flow\/data\/domains\/growth\/CLAUDE\|个人 规则库\]\]/);
  // 主题行原样保留
  assert.match(text, /> \*\*主题：\*\* \[\[flow\/data\/topics\/MiniFlow\|MiniFlow\]\]/);
});

test("set --topic：已下线，显式传参报 usage 错（2026-11-23 砍 topic）", async () => {
  const { root, vault } = makeVault();
  // 不静默忽略——静默会让调用方以为主题改成功了。任意值（含空串/不存在）一律 code 2。
  await assert.rejects(
    () => taskMetaCommand(vault, ["set", "--path", `${TASKS}/T`, "--topic", "MiniFlow"], ctxOf(root)),
    (e) => e.code === 2 && /已下线/.test(e.message));
  await assert.rejects(
    () => taskMetaCommand(vault, ["set", "--path", `${TASKS}/T`, "--topic", "不存在"], ctxOf(root)),
    (e) => e.code === 2 && /已下线/.test(e.message));
  await assert.rejects(
    () => taskMetaCommand(vault, ["set", "--path", `${TASKS}/T`, "--topic", ""], ctxOf(root)),
    (e) => e.code === 2 && /已下线/.test(e.message));

  // 阶段一只停写：存量 topic 字段与主题导航行**原样保留**，由阶段三统一迁移。
  const text = read(root, `${TASKS}/T/README.md`);
  assert.match(text, /> \*\*领域：\*\*/, "领域导航行不受影响");

  // 同一 test 内的其余 set 校验（domain 不存在 → 3；完全不带参 → 2）
  await assert.rejects(
    () => taskMetaCommand(vault, ["set", "--path", `${TASKS}/T`, "--domain", "不存在"], ctxOf(root)),
    (e) => e.code === 3);
  await assert.rejects(
    () => taskMetaCommand(vault, ["set", "--path", `${TASKS}/T`], ctxOf(root)),
    (e) => e.code === 2);
});

// ---------- rename ----------

test("rename：目录改名 + H1 + 月度行 target/alias + 全库链接 + chain.parent", async () => {
  const { root, vault } = makeVault();
  const r = await taskMetaCommand(vault, ["rename", "--path", `${TASKS}/T`, "--title", "T 新名"], ctxOf(root));

  assert.equal(r.ok, true);
  assert.equal(r.renamed, true);
  assert.equal(r.newPath, `${TASKS}/T新名/README.md`);
  assert.equal(fs.existsSync(path.join(root, `${TASKS}/T`)), false);
  assert.equal(fs.existsSync(path.join(root, `${TASKS}/T新名`, "process", "01-x.md")), true);

  const own = read(root, `${TASKS}/T新名/README.md`);
  assert.match(own, /^# T 新名$/m);

  const ideas = read(root, `${Q}/ideas-2026-11.md`);
  assert.match(ideas, /\[\[11\/T新名\/README\|T 新名\]\] #active \^cap-t/);

  const u = read(root, `${TASKS}/U/README.md`);
  assert.match(u, /\[\[flow\/data\/2026\/Q4\/11\/T新名\/README\|T 任务\]\]/);
  assert.match(u, /parent: flow\/data\/2026\/Q4\/11\/T新名\/README/);

  // 被移动目录内部的自链：指向自己的绝对链接改成新路径
  const inner = read(root, `${TASKS}/T新名/process/01-x.md`);
  assert.match(inner, /\[\[flow\/data\/2026\/Q4\/11\/T新名\/README\|T\]\]/);
});

test("rename：磁盘名不变（同样短标题）时只改 H1 与 alias，不动磁盘", async () => {
  const { root, vault } = makeVault();
  const r = await taskMetaCommand(vault, ["rename", "--path", `${TASKS}/T`, "--title", "T"], ctxOf(root));
  assert.equal(r.renamed, false);
  assert.equal(fs.existsSync(path.join(root, `${TASKS}/T`, "README.md")), true);
  assert.match(read(root, `${TASKS}/T/README.md`), /^# T$/m);
  assert.match(read(root, `${Q}/ideas-2026-11.md`), /\[\[11\/T\/README\|T\]\]/);
});

test("rename：缺 --title / 非任务文件 → 退码", async () => {
  const { root, vault } = makeVault();
  await assert.rejects(
    () => taskMetaCommand(vault, ["rename", "--path", `${TASKS}/T`], ctxOf(root)),
    (e) => e.code === 2);
  await assert.rejects(
    () => taskMetaCommand(vault, ["rename", "--path", "flow/data/topics/MiniFlow", "--title", "x"], ctxOf(root)),
    (e) => e.code === 3);
});

test("mf.js 分发：idea / set / rename 三个子命令都可达（topic 已下线）", async () => {
  const { root } = makeVault();
  const v = createFsVault(root);
  const idea = await run(["idea", "--text", "从 mf.js 来"], { vaultRoot: root, vault: v });
  assert.equal(idea.action, "idea.add");
  // topic 子命令已删：分发落到 default → usage 错（code 2）
  await assert.rejects(
    () => run(["topic", "list"], { vaultRoot: root, vault: v }),
    (e) => e.code === 2);
  const set = await run(["set", "--path", `${TASKS}/T`, "--domain", "growth"], { vaultRoot: root, vault: v });
  assert.equal(set.action, "task.set");
  const renamed = await run(["rename", "--path", `${TASKS}/T`, "--title", "T2"], { vaultRoot: root, vault: v });
  assert.equal(renamed.action, "task.rename");
});
