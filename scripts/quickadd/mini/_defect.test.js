// _defect.js 的裸 node 单测：node --test flow/scripts/quickadd/mini/_defect.test.js
//
// 验收锁（2026-11-23 一缺陷一文件改造后）：
//   ① 骨架六节齐全、顺序固定，frontmatter 标量往返不变（含中文与全角冒号）；
//   ② 文件名即身份；frontmatter `id` 与文件名不一致时报 idMismatch（不自动改）；
//   ③ P0–P3 全收，P4 拒绝；`reproduced` 两种文案；
//   ④ 决策写三处（status / decided / 决策记录），幂等、终态锁定；
//   ⑤ 双话术：full 含根因/回归/副作用/三选项，chat 5 行内；现象只在头部给一次；
//   ⑥ summarize 默认只取「待产品决策」、跳过坏文件、剥 taskPath。

const test = require("node:test");
const assert = require("node:assert/strict");

const defectModule = require("./_defect.js");
const yaml = require("./_yaml.js");

const defect = defectModule.makeDefectApi(yaml);

const DIR = "flow/data/domains/work-family/defects";
const ID = "PD-20261123-01";
const FILE = `${DIR}/${ID}.md`;

const SAMPLE = {
  id: ID,
  title: "Socket 缓存路径 socketDO 判空缺失：每轮调度必 NPE",
  risk: "P1",
  module: "平台 xxl-job 调度（Socket 客户端连接定时器）",
  path: "B",
  reqId: "",
  task: "flow/data/2026/Q4/11/某任务/README",
  created: "2026-11-23",
  decided: "",
  reproduced: false,
  phenomenon: "connectCachedConfigs() 遍历 cachedSocketMap 时给 connection() 传 socketDO=null。",
  scope: "work10 槽 01/03/04；所有走 registerSocket 缓存路径的驱动。",
  rootCause: "connection() 内无条件执行 socketDO.getDisabled()。",
  suggestion: "判据改成 socketDO != null && socketDO.getDisabled()。",
  changeScope: "单文件单方法。",
  regression: "注册缓存 socket 配置后等 xxl-job job 4 触发，断言无 NPE 且设备有 Connecting 日志。",
  sideEffects: "数据库配置路径不受影响。",
  attach: "代码位置 xxx；复现条件 xxx。",
};

function note(overrides = {}) {
  return defect.buildDefectNote({ ...SAMPLE, ...overrides });
}

function parsed(overrides = {}, file = FILE) {
  return defect.parseDefectFile(note(overrides), file);
}

test("buildDefectNote：六节齐全、顺序固定、带决策记录段", () => {
  const text = note();
  const heads = [
    "## 一、缺陷现象",
    "## 二、影响范围",
    "## 三、根因分析",
    "## 四、建议修复方案",
    "### 4.1 方案简述",
    "### 4.2 修改范围",
    "### 4.3 测试与回归用例",
    "### 4.4 风险评估（副作用）",
    "## 五、给产品的三选项",
    "## 六、附件",
    "## 决策记录",
  ];
  let last = -1;
  for (const h of heads) {
    const idx = text.indexOf(`\n${h}\n`);
    assert.ok(idx > last, `${h} 缺失或顺序错`);
    last = idx;
  }
});

test("frontmatter 标量往返不变（中文与全角冒号要引号包）", () => {
  const e = parsed();
  assert.equal(e.title, SAMPLE.title);
  assert.equal(e.module, SAMPLE.module);
  assert.equal(e.risk, "P1");
  assert.equal(e.path, "B");
  assert.equal(e.created, "2026-11-23");
  assert.equal(e.reproduced, false);
  // 引号必须真的写进文件，否则 Obsidian 的 YAML 解析会截断
  const text = note();
  assert.match(text, /^title: ".*"$/m);
  assert.match(text, /^created: "2026-11-23"$/m);
});

test("文件名即身份：frontmatter id 与文件名一致时不报 mismatch", () => {
  const e = parsed();
  assert.equal(e.id, ID);
  assert.equal(e.fileId, ID);
  assert.equal(e.idMismatch, false);
});

test("idMismatch：文件名与 frontmatter id 不一致时报出来（不自动改名）", () => {
  const e = parsed({ id: "PD-20261123-09" });
  assert.equal(e.idMismatch, true);
});

test("缺 frontmatter / 非 defect 类型 → null（list 计入 skipped）", () => {
  assert.equal(defect.parseDefectFile("", FILE), null);
  assert.equal(defect.parseDefectFile("# 随便一个 md\n", FILE), null);
  const notDefect = note().replace("type: defect", "type: rule");
  assert.equal(defect.parseDefectFile(notDefect, FILE), null);
});

test("六节正文解析 + 4.1–4.4 拆段", () => {
  const e = parsed();
  assert.match(e.sections.phenomenon, /connectCachedConfigs/);
  assert.match(e.sections.scope, /work10 槽/);
  assert.match(e.sections.rootCause, /socketDO\.getDisabled/);
  assert.match(e.sections.attachments, /代码位置/);
  assert.equal(e.sections.fixParts.suggestion, SAMPLE.suggestion);
  assert.equal(e.sections.fixParts.changeScope, SAMPLE.changeScope);
  assert.equal(e.sections.fixParts.regression, SAMPLE.regression);
  assert.equal(e.sections.fixParts.sideEffects, SAMPLE.sideEffects);
});

test("人手改节标题措辞不影响解析（按中文序号定位）", () => {
  const text = note().replace("## 三、根因分析", "## 三、根因（人工改写过）");
  const e = defect.parseDefectFile(text, FILE);
  assert.match(e.sections.rootCause, /socketDO\.getDisabled/);
});

test("reproduced 两种文案", () => {
  assert.match(note({ reproduced: false }), /尚未现场复现（结论来自代码逻辑推演）/);
  assert.match(note({ reproduced: true }), /已现场复现/);
});

test("P0–P3 全收，P4 拒绝", () => {
  for (const r of ["P0", "P1", "P2", "P3"]) {
    assert.equal(parsed({ risk: r }).risk, r);
  }
  assert.throws(() => note({ risk: "P4" }), /risk 只收/);
  assert.deepEqual(defectModule.RISKS, ["P0", "P1", "P2", "P3"]);
});

test("可选字段为空时写（待补），不留空节", () => {
  const text = note({ changeScope: "", sideEffects: "", attach: "" });
  assert.match(text, /### 4\.2 修改范围\n\n（待补）/);
  assert.match(text, /### 4\.4 风险评估（副作用）\n\n（待补）/);
  assert.match(text, /## 六、附件\n\n（待补）/);
});

test("idFromPath：只认 PD-YYYYMMDD-NN", () => {
  assert.equal(defectModule.idFromPath(`${DIR}/PD-20261123-01.md`), ID);
  assert.equal(defectModule.idFromPath(`${DIR}\\PD-20261123-01.md`), ID);
  assert.equal(defectModule.idFromPath(`${DIR}/PD-YYYYMMDD-NN.md`), "");
  assert.equal(defectModule.idFromPath(`${DIR}/README.md`), "");
});

test("nextId 按日递增，撞号顺延", () => {
  assert.equal(defectModule.nextId([], "2026-11-23"), "PD-20261123-01");
  assert.equal(defectModule.nextId(["PD-20261123-01"], "2026-11-23"), "PD-20261123-02");
  assert.equal(
    defectModule.nextId(["PD-20261123-01", "PD-20261123-03"], "2026-11-23"),
    "PD-20261123-02",
  );
});

test("applyDecision：写 status + decided + 决策记录", () => {
  const r = defect.applyDecision(note(), ID, "include", { date: "2026-11-25", by: "产品", note: "纳入本次" });
  assert.equal(r.changed, true);
  assert.equal(r.status, "本次一并修复");
  const e = defect.parseDefectFile(r.content, FILE);
  assert.equal(e.status, "本次一并修复");
  assert.equal(e.decided, "2026-11-25");
  assert.deepEqual(e.decisions, ["2026-11-25 · 产品 · 本次一并修复 · 纳入本次"]);
});

test("applyDecision 幂等：同状态 + 已记过 → noop", () => {
  const once = defect.applyDecision(note(), ID, "defer", { date: "2026-11-25" }).content;
  const twice = defect.applyDecision(once, ID, "defer", { date: "2026-11-25" });
  assert.equal(twice.noop, true);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once);
});

test("applyDecision：已修复是终态；非法 choice 是 code 2", () => {
  const fixed = note({ status: "已修复" });
  assert.throws(() => defect.applyDecision(fixed, ID, "include", { date: "2026-11-26" }),
    (e) => e.code === 3);
  assert.throws(() => defect.applyDecision(note(), ID, "bogus", { date: "2026-11-26" }),
    (e) => e.code === 2);
});

test("决策记录段被删掉时自愈补段", () => {
  const noSection = note().replace(/\n## 决策记录\n\n$/, "\n");
  const r = defect.applyDecision(noSection, ID, "archive", { date: "2026-11-25" });
  assert.match(r.content, /## 决策记录\n\n- 2026-11-25 · 产品 · 不修归档/);
});

test("双话术：full 含根因/回归/副作用/三选项；chat 5 行内", () => {
  const s = defectModule.scriptsFor(parsed());
  assert.equal(s.path, "B");
  for (const kw of ["根因", "建议修复", "回归用例", "副作用评估", "三个选项"]) {
    assert.ok(s.full.includes(kw), `full 缺 ${kw}`);
  }
  assert.ok(s.full.includes("非本次需求触发"));
  const lines = s.chat.split("\n");
  assert.ok(lines.length <= 5, `chat ${lines.length} 行，超过 5 行`);
  assert.match(s.chat, /①本次一并修复 ②单独排期 ③暂不修复留痕/);
});

test("话术不重复现象（头部给一次，正文只引用）", () => {
  const s = defectModule.scriptsFor(parsed());
  const first = s.full.indexOf(SAMPLE.phenomenon);
  assert.ok(first >= 0);
  assert.equal(s.full.indexOf(SAMPLE.phenomenon, first + 1), -1);
});

test("话术不替产品拍板（路径 A 给两个动作、路径 B 只登记）", () => {
  const a = defectModule.scriptsFor(parsed({ path: "A" }));
  assert.match(a.full, /本次需求一并修复/);
  assert.match(a.full, /单独登记缺陷后续排期修复/);
  const b = defectModule.scriptsFor(parsed({ path: "B" }));
  assert.match(b.full, /云效缺陷工单请人工创建/);
});

test("summarize：默认只取待产品决策，跳过坏文件，剥 taskPath", () => {
  const files = [
    { path: FILE, content: note() },
    { path: `${DIR}/PD-20261123-02.md`, content: note({ id: "PD-20261123-02", status: "本次一并修复" }) },
    { path: `${DIR}/README.md`, content: "# 不是缺陷单" },
  ];
  const rows = defect.summarize(files);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, ID);
  assert.equal(rows[0].taskPath, SAMPLE.task);
  assert.equal(rows[0].taskLabel, "某任务");
  assert.equal(rows[0].file, FILE);

  const all = defect.summarize(files, { status: "*" });
  assert.equal(all.length, 2);
});

test("summarize：无关联任务时 taskPath 为空串（按钮据此隐藏）", () => {
  const rows = defect.summarize([{ path: FILE, content: note({ task: "" }) }]);
  assert.equal(rows[0].taskPath, "");
  assert.equal(rows[0].taskLabel, "");
});

test("makeDefectApi 缺 yaml 注入时立即抛错（不静默降级）", () => {
  assert.throws(() => defectModule.makeDefectApi(null), /需要注入 _yaml\.js/);
  assert.throws(() => defectModule.makeDefectApi({}), /需要注入 _yaml\.js/);
});
