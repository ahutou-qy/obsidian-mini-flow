// ==============================================
// Mini Flow - task-finish-gui.js 单测（裸 node + node:assert，零依赖）
//
// 跑：node flow/scripts/quickadd/mini/task-finish-gui.test.js
// ==============================================

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// 盘面纯函数在 _finish.js（task-finish 与 miniflow 共用），交互相关留在
// task-finish-gui.js 的 __test。
const {
  countProgressBullets,
  extractProgressOverflow,
  nextAction,
  rewriteStatusLine,
  emptyEvidenceSections,
  isDeliveryTask,
  evidenceWarning,
} = require("./_finish");
const taskFinishGui = require("./task-finish-gui");
const { buildConfirmPrompt, shouldFocusHome } = taskFinishGui.__test;
const { runFinish } = taskFinishGui;

let passed = 0;
let failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

async function run() {
  for (const { name, fn } of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.stack || error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------- countProgressBullets / extractProgressOverflow ----------

test("countProgressBullets：空段返回 0", () => {
  const src = ["# 标题", "", "## 进展", "", "> 提示 blockquote", "", "## 输入"].join("\n");
  assert.equal(countProgressBullets(src), 0);
});

test("countProgressBullets：5 条 bullet 返回 5", () => {
  const lines = ["# t", "", "## 进展", ""];
  for (let i = 1; i <= 5; i += 1) lines.push(`- 2026-09-0${i} | bullet ${i}`);
  lines.push("", "## 输入");
  assert.equal(countProgressBullets(lines.join("\n")), 5);
});

test("countProgressBullets：AI 协作标记（· opus）也算 bullet", () => {
  const src = ["## 进展", "", "- 2026-09-15 · opus | 协作条目", "- 2026-09-16 | 人写条目", ""].join("\n");
  assert.equal(countProgressBullets(src), 2);
});

test("countProgressBullets：带空格的模型名（· Opus 5 / Sonnet 5.5）也算 bullet", () => {
  const src = [
    "## 进展",
    "",
    "- 2026-10-12 · Opus 5 | 7 线自测样板跑通",
    "- 2026-10-12 · Sonnet 5.5 | 别的一条",
    "- 2026-10-10 | 人写条目",
    "",
  ].join("\n");
  assert.equal(countProgressBullets(src), 3);
});

test("extractProgressOverflow：4 条不超、movedCount=0", () => {
  const lines = ["## 进展", ""];
  for (let i = 1; i <= 4; i += 1) lines.push(`- 2026-09-0${i} | b${i}`);
  const src = lines.join("\n");
  const { content, archived, movedCount } = extractProgressOverflow(src);
  assert.equal(movedCount, 0);
  assert.deepEqual(archived, []);
  assert.equal(content, src);
});

test("extractProgressOverflow：6 条移最早 1 条、README 留 5 条", () => {
  const lines = ["## 进展", ""];
  for (let i = 1; i <= 6; i += 1) lines.push(`- 2026-09-0${i} | bullet ${i}`);
  lines.push("", "## 内化", "内容");
  const src = lines.join("\n");
  const { content, archived, movedCount } = extractProgressOverflow(src);
  assert.equal(movedCount, 1);
  assert.equal(archived.length, 1);
  assert.equal(archived[0], "- 2026-09-01 | bullet 1");
  assert.ok(!content.includes("2026-09-01"));
  assert.ok(content.includes("2026-09-02"));
  assert.ok(content.includes("2026-09-06"));
  // 段末 ## 内化 不丢
  assert.ok(content.includes("## 内化"));
});

test("extractProgressOverflow：边界——段首非 bullet 行（提示 blockquote）不计入", () => {
  const src = [
    "## 进展",
    "",
    "> 人写的过程叙事...",
    "",
    "- 2026-09-01 | a",
    "- 2026-09-02 | b",
    "- 2026-09-03 | c",
    "- 2026-09-04 | d",
    "- 2026-09-05 | e",
    "- 2026-09-06 | f",
    "",
  ].join("\n");
  const { archived, movedCount } = extractProgressOverflow(src);
  assert.equal(movedCount, 1);
  assert.equal(archived.length, 1);
  assert.equal(archived[0], "- 2026-09-01 | a");
});

test("extractProgressOverflow：混合写法（· Opus 5 / · Sonnet 5.5 / 人写）6 条移最早 1 条", () => {
  const src = [
    "## 进展",
    "",
    "- 2026-10-01 · Opus 5 | a",
    "- 2026-10-02 | b",
    "- 2026-10-03 · Sonnet 5.5 | c",
    "- 2026-10-04 · Opus 5 | d",
    "- 2026-10-05 | e",
    "- 2026-10-06 · Opus 5 | f",
    "",
    "## 输入",
  ].join("\n");
  const { content, archived, movedCount } = extractProgressOverflow(src);
  assert.equal(movedCount, 1);
  assert.deepEqual(archived, ["- 2026-10-01 · Opus 5 | a"]);
  assert.ok(!content.includes("2026-10-01"));
  assert.ok(content.includes("- 2026-10-06 · Opus 5 | f"));
  assert.ok(content.includes("## 输入"));
});

test("extractProgressOverflow：无 ## 进展 段时 no-op", () => {
  const src = "# t\n\n## 输入\n\nx";
  const { content, movedCount } = extractProgressOverflow(src);
  assert.equal(movedCount, 0);
  assert.equal(content, src);
});

// ---------- T1. nextAction 三态 ----------

test("nextAction：已 finish 返回 null", () => {
  assert.equal(nextAction({ status: "finish" }), null);
});

test("nextAction：active/无状态/archive 都返回 finish action", () => {
  for (const status of ["active", undefined, "archive"]) {
    const action = nextAction({ status });
    assert.ok(action, `status=${status} 应返回 action`);
    assert.equal(action.status, "finish");
    assert.equal(action.milestone, "完成");
    assert.equal(action.type, "finish");
    assert.ok(action.notice.includes("完成"));
  }
});

// ---------- T2. rewriteStatusLine ----------

test("rewriteStatusLine：已是 #finish 替换为 finish（幂等）", () => {
  const out = rewriteStatusLine("- 任务 #finish [completion:: 2026-09-17] ^cap-abc",
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-09-17");
  assert.ok(out.includes("#finish"));
  assert.ok(out.includes("[completion:: 2026-09-17]"));
  // 不应有双标签
  assert.equal((out.match(/#finish/g) || []).length, 1);
});

test("rewriteStatusLine：active → finish + completion", () => {
  const out = rewriteStatusLine("- 任务 #active ^cap-abc",
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-09-17");
  assert.ok(out.includes("#finish"));
  assert.ok(!out.includes("#active"));
  assert.ok(out.includes("[completion:: 2026-09-17]"));
  assert.ok(out.includes("^cap-abc"));
});

test("rewriteStatusLine：checkbox [ ]→[x] 同步", () => {
  const out = rewriteStatusLine("- [ ] 任务 #active ^cap-abc",
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-09-17");
  assert.ok(out.includes("- [x]"));
  assert.ok(!out.includes("- [ ]"));
});

test("rewriteStatusLine：无锚点的纯标题行也正常", () => {
  const out = rewriteStatusLine("- 任务 #active",
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-09-17");
  assert.ok(out.includes("#finish"));
  assert.ok(out.includes("[completion:: 2026-09-17]"));
});

// ---------- T5. buildConfirmPrompt ----------

test("buildConfirmPrompt：now 入口文案含 #finish 与 Esc 提示", () => {
  const out = buildConfirmPrompt(
    { title: "1002 任务", status: "active", checkbox: false },
    { status: "finish", milestone: "完成", type: "finish", notice: "任务已标记完成" },
    "2026-09-17",
  );
  assert.ok(out.includes("1002 任务"));
  assert.ok(out.includes("active"));
  assert.ok(out.includes("finish"));
  assert.ok(out.includes("#finish"));
  assert.ok(out.includes("Esc"));
});

test("buildConfirmPrompt：checkbox 形态提示勾选同步", () => {
  const out = buildConfirmPrompt(
    { title: "t", status: "active", checkbox: true },
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-09-17",
  );
  assert.ok(out.includes("[x]"));
  assert.ok(out.includes("checkbox"));
});

test("buildConfirmPrompt：无状态行 label 用「活跃」", () => {
  const out = buildConfirmPrompt(
    { title: "t", status: undefined, checkbox: false },
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-09-17",
  );
  assert.ok(out.includes("活跃"));
});

test("buildConfirmPrompt：finish action 必含 completion 文案", () => {
  const out = buildConfirmPrompt(
    { title: "t", status: "active", checkbox: false },
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-09-17",
  );
  assert.ok(out.includes("[completion:: 2026-09-17]"));
  assert.ok(out.includes("milestones"));
});

// ---------- 交付证据软闸（设计 / 自测段） ----------
//
// 判据三条见 `_finish.js`「交付证据软闸」段：交付任务口径同溯源链卡、
// 「空」= 段在但无正文（段被删 = 不适用）、提示不拦。

// 模板骨架原样：两段各只有引用行，设计段还带四列表说明行 + 空表。
const EMPTY_EVIDENCE_README = [
  "---",
  "type: task-folder",
  "domain: work7",
  "---",
  "",
  "# t",
  "",
  "## 内化",
  "",
  "### 设计",
  "",
  "> 方案、数据链、落地形态、行为契约、验收口径。",
  "",
  "需求 → 功能四列映射（逐条需求对到功能点；设计/验证位置写 `路径::符号`；验证位置自测阶段回填；不适用整表删掉）：",
  "",
  "| 需求条目 | 功能点 | 设计位置 | 验证位置 |",
  "| --- | --- | --- | --- |",
  "|  |  |  |  |",
  "",
  "### 自测",
  "",
  "> 测试流程、用例、点位对账、结论签字、未覆盖边界。",
  "> 验证结论（跑了什么命令、哪些点位、结论与未覆盖边界）是链上后继步骤的放行依据。",
  "",
].join("\n");

// 自测段写了正文（设计段仍是骨架）。
const TEST_FILLED_README = EMPTY_EVIDENCE_README.replace(
  "> 验证结论（跑了什么命令、哪些点位、结论与未覆盖边界）是链上后继步骤的放行依据。",
  "跑了 `node --test`，覆盖 3 个点位；未覆盖：真实云效网络。",
);

// 设计段只填了四列表的一行（引用行与说明行仍在）。
const TABLE_FILLED_README = EMPTY_EVIDENCE_README.replace(
  "|  |  |  |  |",
  "| 登记缺陷 | finish 软闸 | _finish.js::evidenceWarning | task-finish-gui.test.js |",
);

// 段整个不存在（旧单文件任务 / 被手工删掉）→ 不适用。
const NO_SECTIONS_README = ["# t", "", "## 进展", "", "- 2026-11-20 | a", ""].join("\n");

test("emptyEvidenceSections：只有模板骨架 → 两段都算空", () => {
  assert.deepEqual(emptyEvidenceSections(EMPTY_EVIDENCE_README), ["设计", "自测"]);
});

test("emptyEvidenceSections：段被整段删掉 → 不算空（不适用、不提示）", () => {
  assert.deepEqual(emptyEvidenceSections(NO_SECTIONS_README), []);
});

test("emptyEvidenceSections：自测段有正文 → 只报设计段", () => {
  assert.deepEqual(emptyEvidenceSections(TEST_FILLED_README), ["设计"]);
});

test("emptyEvidenceSections：设计段四列表填了一行 → 不算空", () => {
  assert.deepEqual(emptyEvidenceSections(TABLE_FILLED_README), ["自测"]);
});

test("emptyEvidenceSections：CRLF 行尾照样认段头（autocrlf 陷阱）", () => {
  assert.deepEqual(emptyEvidenceSections(EMPTY_EVIDENCE_README.replace(/\n/g, "\r\n")),
    ["设计", "自测"]);
});

test("emptyEvidenceSections：设计/自测都写了正文 → 空数组", () => {
  const both = TABLE_FILLED_README.replace(
    "> 验证结论（跑了什么命令、哪些点位、结论与未覆盖边界）是链上后继步骤的放行依据。",
    "跑了 smoke 5 条。",
  );
  assert.deepEqual(emptyEvidenceSections(both), []);
});

// 交付口径来自配置（behavior.deliveryDomains / deliveryExcludeDomains），夹具用中性域名——
// 判据本身不认识任何人的业务域，测试也不该把某个 vault 的域名写死。
const DELIVERY_CFG = {
  deliveryDomains: ["sample-work", "sample-family"],
  deliveryExcludeDomains: ["vault", "growth"],
};

test("isDeliveryTask：与溯源链卡同源的三条口径", () => {
  // ① 配置里的交付线域（不看有没有交付物）
  assert.equal(isDeliveryTask({ domain: "sample-work", ...DELIVERY_CFG }), true);
  assert.equal(isDeliveryTask({ domain: "sample-work", outputs: [], ...DELIVERY_CFG }), true);
  assert.equal(isDeliveryTask({ domain: "sample-family", ...DELIVERY_CFG }), true);
  // ② 云效物化（有 yunxiao_id，域随便）
  assert.equal(isDeliveryTask({ domain: "", yunxiaoId: "demo-1001", ...DELIVERY_CFG }), true);
  assert.equal(isDeliveryTask({ domain: "vault", yunxiaoId: "demo-1", ...DELIVERY_CFG }), true);
  // ③ 有交付物，但排除域除外
  assert.equal(isDeliveryTask({ domain: "personal", outputs: ["a.md"], ...DELIVERY_CFG }), true);
  assert.equal(isDeliveryTask({ domain: "vault", outputs: ["a.md"], ...DELIVERY_CFG }), false);
  assert.equal(isDeliveryTask({ domain: "growth", outputs: ["a.md"], ...DELIVERY_CFG }), false);
  // 都不占 → 不是交付任务
  assert.equal(isDeliveryTask({ domain: "personal", outputs: [], ...DELIVERY_CFG }), false);
  assert.equal(isDeliveryTask({ ...DELIVERY_CFG }), false);
});

test("isDeliveryTask：配置缺省时退化为「有 yunxiao_id 或有交付物」", () => {
  // 两项皆空（开源默认）：域名清单不再命中，但另两条口径照常生效——软闸不会整体失效。
  assert.equal(isDeliveryTask({ domain: "sample-work" }), false);
  assert.equal(isDeliveryTask({ domain: "anything", outputs: ["a.md"] }), true);
  assert.equal(isDeliveryTask({ domain: "", yunxiaoId: "demo-1" }), true);
  assert.equal(isDeliveryTask({ domain: "anything", outputs: [] }), false);
  // 逗号分隔字符串形态也认（设置页文本框写进来的是字符串）
  assert.equal(isDeliveryTask({ domain: "sample-work", deliveryDomains: "sample-work, sample-family" }), true);
});

test("evidenceWarning：非交付任务 → 空串（不打扰）", () => {
  assert.equal(evidenceWarning({ text: EMPTY_EVIDENCE_README, domain: "vault", outputs: [], ...DELIVERY_CFG }), "");
  assert.equal(evidenceWarning({ text: EMPTY_EVIDENCE_README, domain: "growth", ...DELIVERY_CFG }), "");
});

test("evidenceWarning：交付任务 + 骨架段 → 提示带段名与「未留验证证据」", () => {
  const msg = evidenceWarning({ text: EMPTY_EVIDENCE_README, domain: "sample-work", outputs: [], ...DELIVERY_CFG });
  assert.ok(msg, "交付任务的空段必须出提示");
  assert.ok(msg.includes("### 设计") && msg.includes("### 自测"), msg);
  assert.ok(msg.includes("未留验证证据"), msg);
});

test("evidenceWarning：交付任务但两段都写了 → 空串（已填段不打扰）", () => {
  const both = TABLE_FILLED_README.replace(
    "> 验证结论（跑了什么命令、哪些点位、结论与未覆盖边界）是链上后继步骤的放行依据。",
    "跑了 smoke 5 条。",
  );
  assert.equal(evidenceWarning({ text: both, domain: "sample-work", outputs: [], ...DELIVERY_CFG }), "");
});

test("buildConfirmPrompt：带 evidence 时内联进确认框", () => {
  const out = buildConfirmPrompt(
    { title: "t", status: "active", checkbox: false },
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-11-20",
    "⚠ 结案提醒：本交付任务的 ### 自测 段仍是模板骨架（无正文），未留验证证据。",
  );
  assert.ok(out.includes("结案提醒"));
  assert.ok(out.includes("只提示不拦截"));
  assert.ok(out.includes("按 Esc"));
});

test("buildConfirmPrompt：不带 evidence 时文案与改动前一致", () => {
  const out = buildConfirmPrompt(
    { title: "t", status: "active", checkbox: false },
    { status: "finish", milestone: "完成", type: "finish", notice: "x" },
    "2026-11-20",
  );
  assert.ok(!out.includes("结案提醒"));
  assert.ok(!out.includes("只提示不拦截"));
});

// ---------- shouldFocusHome（关 README 后的落点判据）----------

const README = "flow/data/2026/Q4/10/某任务/README.md";

test("shouldFocusHome：活动页就是被关的 README → true", () => {
  assert.equal(shouldFocusHome(README, README), true);
});

test("shouldFocusHome：活动页是月度 Capture 行文件 → false（不抢焦点）", () => {
  assert.equal(shouldFocusHome("flow/data/2026/Q4/ideas-2026-10.md", README), false);
});

test("shouldFocusHome：活动页是别的任务 README → false", () => {
  assert.equal(shouldFocusHome("flow/data/2026/Q4/10/另一任务/README.md", README), false);
});

test("shouldFocusHome：无活动文件（null/undefined/空串）→ false", () => {
  assert.equal(shouldFocusHome(null, README), false);
  assert.equal(shouldFocusHome(undefined, README), false);
  assert.equal(shouldFocusHome("", README), false);
});

test("shouldFocusHome：readme 缺失 → false（README 未解析出来时不跳）", () => {
  assert.equal(shouldFocusHome(README, null), false);
  assert.equal(shouldFocusHome(README, undefined), false);
});

// ---------- runFinish（QuickAdd 宏与插件 headless 命令共用的编排） ----------
//
// 这组用例就是本任务的验收面：不传 confirm 时**不会**碰 window.confirm（Node 下
// 没有 window，一旦误引用直接 ReferenceError），且两处写面照样落。

const VAULT_ROOT = require("./_vault-root.js").resolveVaultRoot(); // 挂载后 __dirname 上溯推不出 vault 根
const IDEAS_PATH = "flow/data/2026/Q4/ideas-2026-11.md";
const README_PATH = "flow/data/2026/Q4/11/测试任务/README.md";
const CAPTURE_LINE = "- [[11/测试任务/README|测试任务]] #active ^cap-finish01";
const IDEAS_ORIGINAL = ["## Capture", CAPTURE_LINE, ""].join("\n");

// 假 vault：文件表 + 记录写盘；adapter.read 走真盘（loadHelper 要读 _task.js 等脚本）。
// domain / evidenceSections：交付证据软闸的接线用（domain 决定算不算交付任务，
// evidenceSections 决定 README 里有没有那两段骨架）。
function makeFixture({ activePath = IDEAS_PATH, domain = "", evidenceSections = false } = {}) {
  const ideaLines = IDEAS_ORIGINAL.split("\n");
  const files = new Map();
  const ideasFile = { path: IDEAS_PATH };
  const readmeFile = { path: README_PATH, parent: { path: "flow/data/2026/Q4/11/测试任务" } };
  files.set(IDEAS_PATH, IDEAS_ORIGINAL);
  const readmeLines = [
    "---",
    "type: task-folder",
    ...(domain ? [`domain: ${domain}`] : []),
    "milestones:",
    "  - {date: '2026-11-19', type: create}",
    "---",
    "",
    "# 测试任务",
    "",
    "## 进展",
    "",
  ];
  if (evidenceSections) {
    readmeLines.push(
      "## 内化",
      "",
      "### 设计",
      "",
      "> 方案、数据链、落地形态、行为契约、验收口径。",
      "",
      "### 自测",
      "",
      "> 测试流程、用例、点位对账、结论签字、未覆盖边界。",
      "",
    );
  }
  files.set(README_PATH, readmeLines.join("\n"));

  const vault = {
    async read(f) { return files.get(f.path); },
    async modify(f, content) { files.set(f.path, content); },
    getAbstractFileByPath(p) {
      if (p === README_PATH) return readmeFile;
      if (p === IDEAS_PATH) return ideasFile;
      return null;
    },
    adapter: {
      async read(p) {
        // 配置**由夹具给**，不读运行机器的那份（2026-11-21）：交付口径走
        // behavior.deliveryDomains 后，读本机配置会让这两条软闸用例在「配置里没填交付域」
        // 的机器上静默失败（开源包默认就是空）。脚本仍从真实仓读——那本来就是被测代码。
        if (p === "flow/config/miniflow.json") {
          return JSON.stringify({
            behavior: { deliveryDomains: ["sample-work"], deliveryExcludeDomains: ["vault", "growth"] },
          });
        }
        return fs.readFileSync(path.join(VAULT_ROOT, p), "utf8");
      },
    },
    async create(p, content) { files.set(p, content); },
    async createFolder() {},
  };

  const app = {
    vault,
    workspace: {
      activeEditor: {
        editor: {
          getCursor: () => ({ line: 1 }),
          getLine: (i) => ideaLines[i] || "",
        },
      },
      getActiveFile: () => ({ path: activePath }),
      getLeavesOfType: () => [],
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  };
  return { app, files };
}

test("runFinish 不传 confirm：跳过确认、两处写面都落", async () => {
  const { app, files } = makeFixture();
  const result = await runFinish(app, { today: "2026-11-20" });
  assert.equal(result.status, "done");
  const ideas = files.get(IDEAS_PATH);
  assert.match(ideas, /#finish/);
  assert.match(ideas, /\[completion:: 2026-11-20\]/);
  assert.doesNotMatch(ideas, /#active/);
  const readme = files.get(README_PATH);
  assert.match(readme, /type: finish/);
});

test("runFinish 传 confirm 且拒绝：cancelled，两处写面都不动", async () => {
  const { app, files } = makeFixture();
  let asked = 0;
  const result = await runFinish(app, {
    today: "2026-11-20",
    confirm: async () => { asked += 1; return false; },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(asked, 1, "拒绝路径也要真弹一次（GUI 路径的语义不能丢）");
  assert.equal(files.get(IDEAS_PATH), IDEAS_ORIGINAL, "月度行不该被改写");
  assert.doesNotMatch(files.get(README_PATH), /type: finish/, "不该追加 finish 里程碑");
});

test("runFinish 传 confirm 且同意：done，确认文案带目标态", async () => {
  const { app } = makeFixture();
  let asked = 0;
  const result = await runFinish(app, {
    today: "2026-11-20",
    confirm: async (prompt) => {
      asked += 1;
      assert.match(prompt, /推进到/);
      return true;
    },
    afterFinish: async () => {},
  });
  assert.equal(result.status, "done");
  assert.equal(asked, 1);
});

test("runFinish：注入 afterFinish 才收到 README，不注入则完全不碰 tab", async () => {
  const withHook = makeFixture();
  const closed = [];
  const r1 = await runFinish(withHook.app, {
    today: "2026-11-20",
    afterFinish: async (readme) => { closed.push(readme && readme.path); },
  });
  assert.equal(r1.status, "done");
  assert.deepEqual(closed, [README_PATH], "GUI 路径：关 tab 的钩子要拿到 README");

  // headless 默认不传 afterFinish —— 不关 tab、不回 Home，但 readme 仍回传给调用方。
  const headless = makeFixture();
  const r2 = await runFinish(headless.app, { today: "2026-11-20" });
  assert.equal(r2.status, "done");
  assert.equal(r2.readme && r2.readme.path, README_PATH);
});

test("runFinish：活动文件既不是月度 ideas 也不是任务 README → no-target", async () => {
  const { app } = makeFixture({ activePath: "Home.md" });
  const result = await runFinish(app, { today: "2026-11-20" });
  assert.equal(result.status, "no-target");
});

// ---------- 交付证据软闸的三个接线点（runFinish 侧） ----------
//
// 提示挂哪：有 confirm → 并进确认框；无 confirm（headless / MCP）→ opts.notify。
// 默认 notify 是 Notice，裸 node 下静默跳过（Notice 全局不存在）。

test("软闸·headless：交付任务骨架段 → notify 收到提示，结案照常落", async () => {
  const { app, files } = makeFixture({ domain: "sample-work", evidenceSections: true });
  const notified = [];
  const result = await runFinish(app, { today: "2026-11-20", notify: (m) => notified.push(m) });
  assert.equal(result.status, "done", "软闸不拦——状态机照常推进");
  assert.equal(notified.length, 1, `应发一条提示，实发 ${notified.length}`);
  assert.ok(notified[0].includes("### 自测"), notified[0]);
  assert.ok(notified[0].includes("未留验证证据"), notified[0]);
  // 不硬拦的另一半证据：两处写面照样落
  assert.match(files.get(IDEAS_PATH), /#finish/);
  assert.match(files.get(README_PATH), /type: finish/);
});

test("软闸·GUI：提示并进确认框，不另发 Notice", async () => {
  const { app } = makeFixture({ domain: "sample-work", evidenceSections: true });
  const notified = [];
  const prompts = [];
  const result = await runFinish(app, {
    today: "2026-11-20",
    notify: (m) => notified.push(m),
    confirm: async (prompt) => { prompts.push(prompt); return true; },
    afterFinish: async () => {},
  });
  assert.equal(result.status, "done");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("结案提醒"), "提示要出现在确认框里");
  assert.equal(notified.length, 0, "GUI 路径已有确认框，不叠第二条横幅");
});

test("软闸：确认框里拒绝 → cancelled，提示已给过、状态不动", async () => {
  const { app, files } = makeFixture({ domain: "sample-work", evidenceSections: true });
  const result = await runFinish(app, {
    today: "2026-11-20",
    confirm: async (prompt) => { assert.ok(prompt.includes("结案提醒")); return false; },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(files.get(IDEAS_PATH), IDEAS_ORIGINAL);
  assert.doesNotMatch(files.get(README_PATH), /type: finish/);
});

test("软闸：非交付任务 → 不出提示", async () => {
  const { app } = makeFixture({ evidenceSections: true }); // 无 domain、无 yunxiao_id、无 output/
  const notified = [];
  const result = await runFinish(app, { today: "2026-11-20", notify: (m) => notified.push(m) });
  assert.equal(result.status, "done");
  assert.deepEqual(notified, []);
});

test("软闸：交付任务但段被删掉（不适用）→ 不出提示", async () => {
  const { app } = makeFixture({ domain: "sample-work" }); // 段不存在
  const notified = [];
  const result = await runFinish(app, { today: "2026-11-20", notify: (m) => notified.push(m) });
  assert.equal(result.status, "done");
  assert.deepEqual(notified, []);
});

run();
