// _set-status 的裸 node 单测：node --test flow/scripts/mvp/_set-status.test.js
//
// 段 2（P1）的验收锁：CLI 结案/重开必须写**两处**写面——月度 Capture 行 + README
// frontmatter milestones。只写前者会让 qy 侧 read_miniflow_status 落到 unmaterialized。
//
// 覆盖：finish 两处写面 + qy 判据对账（含 P1 证伪）、reopen 里程碑、幂等、
// 存量任务按 completion 日期回填、`## 进展` 超 5 条归档（CRLF 行尾）、active→active 不写里程碑。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { setStatus, completionDateOf } = require("./_set-status.js");

const TASK_REL = path.join("flow", "data", "2026", "Q4", "11", "T");
const IDEAS_REL = path.join("flow", "data", "2026", "Q4", "ideas-2026-11.md");
const ANCHOR = "^cap-t1";

function readmeText({
  milestones = ["  - {date: '2026-11-19', type: create}"],
  progress = [],
  eol = "\n",
  domain = "vault",
  sections = false, // 交付证据软闸：带 ### 设计 / ### 自测 两段模板骨架
} = {}) {
  const lines = [
    "---",
    "type: task-folder",
    'source: "[[../ideas-2026-11#^cap-t1]]"',
    `domain: ${domain}`,
    "milestones:",
    ...milestones,
    "---",
    "",
    "# T",
    "",
    "## 进展",
    "",
    ...progress,
    "",
    "## 输入",
    "",
  ];
  if (sections) {
    lines.push(
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
  return lines.join(eol);
}

function ideasText({ line = `- [[11/T/README|T]] #active ${ANCHOR}`, eol = "\n" } = {}) {
  return ["---", "tags: ideas", "---", "", "## Capture", "", line, ""].join(eol);
}

function makeVault(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-set-status-"));
  const taskDir = path.join(root, TASK_REL);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "README.md"), readmeText(opts), "utf8");
  fs.writeFileSync(path.join(root, IDEAS_REL), ideasText(opts), "utf8");
  // 交付口径走配置（behavior.deliveryDomains / deliveryExcludeDomains，2026-11-21 起）：
  // 夹具写一份真配置，顺带验 CLI 侧 loadSync(vaultRoot) 这条传导链——不写就退化成
  // 「有 yunxiao_id 或有交付物」，软闸的域名那条口径根本没被测到。
  const cfgDir = path.join(root, "flow", "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "miniflow.json"), JSON.stringify({
    behavior: {
      deliveryDomains: ["sample-work"],
      deliveryExcludeDomains: ["vault", "growth"],
    },
  }, null, 2), "utf8");
  return { root, taskDir, readme: path.join(taskDir, "README.md"), ideas: path.join(root, IDEAS_REL) };
}

const read = (p) => fs.readFileSync(p, "utf8");
const captureLine = (ideas) => read(ideas).split(/\r?\n/).find((l) => l.includes(ANCHOR)) || "";
const milestoneLines = (readme) => read(readme).split(/\r?\n/).filter((l) => /^\s*-\s*\{date:/.test(l));

// qy 侧判据的等价副本（外部同步 CLI/src/modules/yunxiao/tasks.rs#read_miniflow_status）：
// ① README 含 `type: finish` 里程碑 → finish；② 否则月度行 #active（含历史别名）→ active；
// ③ 都没有 → unmaterialized。**只读对账用，不是第二份写面。**
function qyMiniflowStatus(readme, ideas) {
  if (/type:\s*finish/.test(read(readme))) return "finish";
  const line = captureLine(ideas);
  if (/#(active|now|next|dev_done)(?=\s|$)/.test(line)) return "active";
  return "unmaterialized";
}

test("finish：月度行 + README finish 里程碑两处都写，qy 判据解析成 finish", async () => {
  const v = makeVault();
  assert.equal(qyMiniflowStatus(v.readme, v.ideas), "active", "前置：活跃");

  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });

  assert.equal(r.ok, true);
  assert.equal(r.lineChanged, true);
  assert.equal(r.prevStatus, "active");
  assert.match(captureLine(v.ideas), /#finish \[completion:: \d{4}-\d{2}-\d{2}\]/);
  // 本地日期，与 `_set-status.js#todayIso()` 同源。**不能用 toISOString()**——那是 UTC，
  // 本机 UTC+8，本地 00:00–08:00 这段窗口里它比实现少一天，跨天跑测试必红
  // （2026-11-21 00:01 实测：expected 2026-11-20 / actual 2026-11-21）。
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  assert.deepEqual(r.milestone, { date: localToday, type: "finish" });
  assert.equal(milestoneLines(v.readme).filter((l) => /type: finish/.test(l)).length, 1);
  assert.equal(qyMiniflowStatus(v.readme, v.ideas), "finish");
});

test("P1 证伪：只改月度行（旧行为）→ qy 判据落 unmaterialized", async () => {
  const v = makeVault();
  // 手工模拟旧 CLI 的产物：只把月度行改成 #finish，README 不动。
  const text = read(v.ideas).replace(`#active ${ANCHOR}`, `#finish [completion:: 2026-11-19] ${ANCHOR}`);
  fs.writeFileSync(v.ideas, text, "utf8");
  assert.equal(qyMiniflowStatus(v.readme, v.ideas), "unmaterialized");

  // 新实现补上里程碑后立刻变 finish（这就是段 2 要修的东西）。
  await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  assert.equal(qyMiniflowStatus(v.readme, v.ideas), "finish");
});

test("存量回填：月度行已 #finish，里程碑按行内 completion 日期而不是今天", async () => {
  const v = makeVault({ line: `- [[11/T/README|T]] #finish [completion:: 2026-11-01] ${ANCHOR}` });
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });

  assert.equal(r.lineChanged, false, "月度行已是目标态，不重写");
  assert.deepEqual(r.milestone, { date: "2026-11-01", type: "finish" });
  assert.match(milestoneLines(v.readme).join("\n"), /date: '2026-11-01', type: finish/);
  assert.equal(qyMiniflowStatus(v.readme, v.ideas), "finish");
});

test("幂等：finish 跑两次只留一条 finish 里程碑", async () => {
  const v = makeVault();
  await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  const once = milestoneLines(v.readme).length;
  await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  assert.equal(milestoneLines(v.readme).length, once);
  assert.equal(milestoneLines(v.readme).filter((l) => /type: finish/.test(l)).length, 1);
});

test("reopen：finish → active 写 reopen 里程碑，finish 里程碑保留", async () => {
  const v = makeVault();
  await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "active" });

  assert.equal(r.prevStatus, "finish");
  assert.equal(r.milestone.type, "reopen");
  const ms = milestoneLines(v.readme).join("\n");
  assert.match(ms, /type: finish/);
  assert.match(ms, /type: reopen/);
  assert.match(captureLine(v.ideas), /#active/);
  assert.doesNotMatch(captureLine(v.ideas), /completion::/);
  // 重开后 qy 判据：README 仍有 finish 里程碑 → 仍报 finish（qy 侧口径如此，
  // MF 的「重开不算已完成」由 Home 卡按末位里程碑判定，两边判据不同，别在这里改 qy）。
  assert.equal(qyMiniflowStatus(v.readme, v.ideas), "finish");
});

test("active → active：不写任何里程碑", async () => {
  const v = makeVault();
  const before = milestoneLines(v.readme).length;
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "active" });
  assert.equal(r.milestone, null);
  assert.equal(milestoneLines(v.readme).length, before);
});

test("进展归档：7 条 bullet（CRLF 行尾）→ 剩 5 条，2 条进 process/R-进展历史.md", async () => {
  const progress = Array.from({ length: 7 }, (_, i) => `- 2026-11-0${i + 1} | 第 ${i + 1} 条`);
  const v = makeVault({ progress, eol: "\r\n" });

  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });

  assert.equal(r.archivedCount, 2, "CRLF 下也必须数出 bullet（段头正则容忍 \\r）");
  const kept = read(v.readme).split(/\r?\n/).filter((l) => /^- 2026-11-0\d \| /.test(l));
  assert.equal(kept.length, 5);
  assert.match(kept[0], /第 3 条/, "搬走的是最早两条");
  const history = path.join(v.taskDir, "process", "R-进展历史.md");
  assert.equal(fs.existsSync(history), true, "fsVault 的 parent 缺失会让归档静默 no-op");
  const h = read(history);
  assert.match(h, /第 1 条/);
  assert.match(h, /第 2 条/);
  assert.match(h, /## \d{4}-\d{2}-\d{2} 归档/);
});

test("进展未超阈：不建 process/R-进展历史.md", async () => {
  const v = makeVault({ progress: ["- 2026-11-19 | 只有一条"] });
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  assert.equal(r.archivedCount, 0);
  assert.equal(fs.existsSync(path.join(v.taskDir, "process", "R-进展历史.md")), false);
});

test("历史档位行：#urgent #next → finish 后单标签（段 1 口径在 CLI 侧生效）", async () => {
  const v = makeVault({ line: `- [[11/T/README|T]] #urgent #next ${ANCHOR}` });
  await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  const line = captureLine(v.ideas);
  assert.doesNotMatch(line, /#urgent/);
  assert.doesNotMatch(line, /#next/);
  assert.equal((line.match(/#finish/g) || []).length, 1);
});

// ---------- 交付证据软闸（第四个 finish 写手：mf.js finish / 两个薄 CLI） ----------
//
// 判据单源在 `_finish.js`；CLI 没有确认框，提示出在返回对象的 `evidenceWarning` 字段
// （mf.js 原样进 stdout JSON）。仍然不拦：状态机照常推进。

test("软闸：交付任务骨架段 → evidenceWarning 有值，结案照常落", async () => {
  const v = makeVault({ domain: "sample-work", sections: true });
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  assert.equal(r.ok, true, "软闸不拦");
  assert.ok(r.evidenceWarning, "交付任务的空段要出提示");
  assert.match(r.evidenceWarning, /### 自测/);
  assert.match(r.evidenceWarning, /未留验证证据/);
  // 不硬拦的另一半证据：两处写面照样落
  assert.match(captureLine(v.ideas), /#finish/);
  assert.match(read(v.readme), /type: finish/);
});

test("软闸：非交付任务（domain vault）→ 空串，不打扰", async () => {
  const v = makeVault({ domain: "vault", sections: true });
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  assert.equal(r.evidenceWarning, "");
});

test("软闸：交付任务但段不存在（不适用）→ 空串", async () => {
  const v = makeVault({ domain: "sample-work" });
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "finish" });
  assert.equal(r.evidenceWarning, "");
});

test("软闸：reopen（active）不检查证据", async () => {
  const v = makeVault({ domain: "sample-work", sections: true, line: `- [[11/T/README|T]] #finish [completion:: 2026-11-19] ${ANCHOR}` });
  const r = await setStatus({ vaultRoot: v.root, taskPath: v.taskDir, targetStatus: "active" });
  assert.equal(r.ok, true);
  assert.equal(r.evidenceWarning, "");
});

test("completionDateOf：取行内日期，无则 null", () => {
  assert.equal(completionDateOf("- x #finish [completion:: 2026-11-01] ^cap-a"), "2026-11-01");
  assert.equal(completionDateOf("- x #active ^cap-a"), null);
});