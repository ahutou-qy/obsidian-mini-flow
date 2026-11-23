// ==============================================
// Mini Flow - _yaml.js 单测（裸 node + node:assert，零依赖）
//
// 跑：node flow/scripts/quickadd/mini/_yaml.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
// ==============================================

const assert = require("node:assert/strict");
const path = require("node:path");
const { getMilestones, setMilestones, addMilestone, serializeMilestone, getDomain, getYunxiaoId, getReqId, getChain, setChain, getExternalDep, setExternalDep } = require("./_yaml");

let passed = 0;
let failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function run() {
  for (const { name, fn } of cases) {
    try {
      fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------- 用例 ----------

test("1. 空 frontmatter 解析为空数组", () => {
  assert.deepEqual(getMilestones(""), []);
  assert.deepEqual(getMilestones(null), []);
  assert.deepEqual(getMilestones("---\ntitle: x\n---"), []);
});

test("2. 同 date 不同 type 各保留", () => {
  const fm = [
    "---",
    "title: x",
    "milestones:",
    "  - {date: '2026-08-13', type: create}",
    "  - {date: '2026-08-13', type: finish}",
    "---",
  ].join("\n");
  const list = getMilestones(fm);
  assert.equal(list.length, 2);
  assert.equal(list[0].date, "2026-08-13");
  assert.equal(list[0].type, "create");
  assert.equal(list[1].type, "finish");
});

test("3. 同 date 同 type 同 note 重复 addMilestone noop（行数不增）", () => {
  const fm = [
    "---",
    "milestones:",
    "  - {date: '2026-08-13', type: create}",
    "---",
  ].join("\n");
  const next = addMilestone(fm, { date: "2026-08-13", type: "create", note: "" });
  const list = getMilestones(next);
  assert.equal(list.length, 1);
});

test("4. 同 date 同 type 不同 note → 升级 note（不新增）", () => {
  const fm = [
    "---",
    "milestones:",
    "  - {date: '2026-08-13', type: finish, note: \"a\"}",
    "---",
  ].join("\n");
  const next = addMilestone(fm, { date: "2026-08-13", type: "finish", note: "b" });
  const list = getMilestones(next);
  assert.equal(list.length, 1);
  assert.equal(list[0].note, "b");
});

test("5. 含不相关字段不被重排/丢失", () => {
  const fm = [
    "---",
    "title: 'x'",
    "tags:",
    "  - a",
    "  - b",
    "milestones:",
    "  - {date: '2026-08-13', type: create}",
    "domain: personal",
    "---",
  ].join("\n");
  const next = addMilestone(fm, { date: "2026-08-14", type: "finish", note: "" });
  assert.match(next, /title: 'x'/);
  assert.match(next, /domain: personal/);
  assert.match(next, /^\s+- a$/m);
  assert.match(next, /^\s+- b$/m);
  const list = getMilestones(next);
  assert.equal(list.length, 2);
  assert.equal(list[0].date, "2026-08-13");
  assert.equal(list[1].date, "2026-08-14");
  // 字段顺序保持：title, tags, milestones, domain
  const fmLines = next.split("\n");
  const idxTitle = fmLines.findIndex((l) => /^title:/.test(l));
  const idxTags = fmLines.findIndex((l) => /^tags:/.test(l));
  const idxMs = fmLines.findIndex((l) => /^milestones:/.test(l));
  const idxDomain = fmLines.findIndex((l) => /^domain:/.test(l));
  assert.ok(idxTitle < idxTags);
  assert.ok(idxTags < idxMs);
  assert.ok(idxMs < idxDomain);
});

test("6. 中文 note roundtrip 一致", () => {
  const fm = "---";
  const added = addMilestone(fm, { date: "2026-08-13", type: "finish", note: "范围优先改造落地" });
  const list = getMilestones(added);
  assert.equal(list.length, 1);
  assert.equal(list[0].note, "范围优先改造落地");
  // 冒号 / 全角逗号也保留
  const added2 = addMilestone(fm, { date: "2026-08-13", type: "manual", note: "关键：测试、中文、标点。" });
  const list2 = getMilestones(added2);
  assert.equal(list2[0].note, "关键：测试、中文、标点。");
});

test("6.5. 历史 type: archive 仍可解析(reader-side 宽别名保留)", () => {
  // 2026-08-19 archive 档从 STATUSES 与 MILESTONE_TYPE 删除(write narrow)，
  // 但 _yaml.js 不做 enum 校验，历史 README 前端里残留的 type: archive 仍透传。
  const fm = [
    "---",
    "milestones:",
    "  - {date: '2026-08-10', type: archive, note: \"v1 数据迁移前\"}",
    "---",
  ].join("\n");
  const list = getMilestones(fm);
  assert.equal(list.length, 1);
  assert.equal(list[0].type, "archive"); // 字面透传，不是 fallback
  assert.equal(list[0].note, "v1 数据迁移前");
  // 再 addMilestone 一个同 date 不同 type 也不报错（archive 仍可作为字面 token 写入）
  const next = addMilestone(fm, { date: "2026-08-12", type: "archive", note: "trailing" });
  const list2 = getMilestones(next);
  assert.equal(list2.length, 2);
  assert.equal(list2[1].type, "archive");
});

test("7. setMilestones([]) 删除整个字段", () => {
  const fm = [
    "---",
    "title: x",
    "milestones:",
    "  - {date: '2026-08-13', type: create}",
    "---",
  ].join("\n");
  const next = setMilestones(fm, []);
  assert.equal(getMilestones(next).length, 0);
  assert.match(next, /title: x/);
  assert.doesNotMatch(next, /^milestones:/m);
});

test("8. serializeMilestone 基本形态（统一 2 空格缩进）", () => {
  assert.equal(
    serializeMilestone({ date: "2026-08-13", type: "create" }),
    `  - {date: '2026-08-13', type: create}`
  );
  assert.equal(
    serializeMilestone({ date: "2026-08-13", type: "manual", note: "plain ascii" }),
    `  - {date: '2026-08-13', type: manual, note: plain ascii}`
  );
  assert.equal(
    serializeMilestone({ date: "2026-08-13", type: "manual", note: "中文：带冒号" }),
    `  - {date: '2026-08-13', type: manual, note: "中文：带冒号"}`
  );
  // 守卫：不得产顶格 `- {` 行（与 tags 同款，Obsidian frontmatter 对顶格序列判过无效属性）
  assert.ok(
    !/^- \{/m.test(serializeMilestone({ date: "2026-08-13", type: "create" })),
    "serializeMilestone 必须产出缩进行"
  );
});

// ---------- domain 标量字段（阶段 3 接入） ----------

test("9. getDomain 解析标量字段", () => {
  assert.equal(getDomain(""), "");
  assert.equal(getDomain(null), "");
  assert.equal(getDomain("---\ntitle: x\n---"), "");
  assert.equal(getDomain("---\ndomain: work7\n---"), "work7");
  assert.equal(getDomain("---\ndomain: growth\n---\ntitle: x"), "growth");
  // 引号形式也支持
  assert.equal(getDomain('---\ndomain: "work7"\n---'), "work7");
});

// yunxiao_id：**云效工作项 OID**（24 位 hex），写手是 外部同步 CLI 的云效物化，MF 侧只有读面
// （交付证据软闸消费）。走 getDomain 同一个 getScalarField，所以边界行为必须一致。
// 样例值用真实形态——本文件旧样例写成 `work-5698`（那是 req_id 的值），2026-11-23 订正。
test("9b. getYunxiaoId 解析标量字段（无写手，只读）", () => {
  assert.equal(getYunxiaoId(""), "");
  assert.equal(getYunxiaoId(null), "");
  assert.equal(getYunxiaoId("---\ndomain: work7\n---"), "");
  assert.equal(getYunxiaoId("---\nyunxiao_id: f04a0e91973c8709a7ef5cf048\n---"),
    "f04a0e91973c8709a7ef5cf048");
  assert.equal(getYunxiaoId('---\nyunxiao_id: "9ad19b9d392dc7fbf8ee611bf6"\n---'),
    "9ad19b9d392dc7fbf8ee611bf6");
  // 手建任务没有这个字段 → 空串（不是 undefined，调用方直接判真值）
  assert.equal(getYunxiaoId("---\ntype: task\nmilestones:\n  - {date: '2026-11-20', type: create}\n---"), "");
});

// req_id：**结构化需求编号**（`work-<数字>`），写手是 qy（云效 serialNumber 归一）。
// 读者是 qy 的 commit 标题闸与 `defect` 组的「需求单号」字段。与上面的 OID 是两个字段。
test("9c. getReqId 解析标量字段（无写手，只读）", () => {
  assert.equal(getReqId(""), "");
  assert.equal(getReqId(null), "");
  assert.equal(getReqId("---\ndomain: work7\n---"), "");
  assert.equal(getReqId("---\nreq_id: work-5698\n---"), "work-5698");
  assert.equal(getReqId('---\nreq_id: "work-5668"\n---'), "work-5668");
  // 两个字段并存时各取各的，互不串味
  assert.equal(
    getReqId("---\nyunxiao_id: f04a0e91973c8709a7ef5cf048\nreq_id: work-5698\n---"),
    "work-5698",
  );
  assert.equal(
    getYunxiaoId("---\nyunxiao_id: f04a0e91973c8709a7ef5cf048\nreq_id: work-5698\n---"),
    "f04a0e91973c8709a7ef5cf048",
  );
});

// ---------- reopen 类型（2026-11-04 task-edit 重开 writer） ----------

test("R1. addMilestone 写 reopen 类型（枚举槽接上 writer）", () => {
  const fm = "---";
  const added = addMilestone(fm, { date: "2026-11-04", type: "reopen" });
  const list = getMilestones(added);
  assert.equal(list.length, 1);
  assert.equal(list[0].type, "reopen");
  assert.match(added, /type: reopen/);
  // 缩进形态与其他类型一致（2 空格）
  assert.match(added, /^ {2}- \{date: '2026-11-04', type: reopen\}/m);
});

test("R2. 同日重开两次幂等（键 {date,type}，只留一条）", () => {
  const once = addMilestone("---", { date: "2026-11-04", type: "reopen" });
  const twice = addMilestone(once, { date: "2026-11-04", type: "reopen" });
  assert.equal(getMilestones(twice).length, 1);
  assert.equal(twice, once); // 完全 noop，不重排
});

test("R3. create → finish → reopen → finish(次日)：四条都在，append 顺序保持", () => {
  let fm = "---";
  fm = addMilestone(fm, { date: "2026-10-01", type: "create" });
  fm = addMilestone(fm, { date: "2026-10-20", type: "finish" });
  fm = addMilestone(fm, { date: "2026-11-04", type: "reopen" });
  fm = addMilestone(fm, { date: "2026-11-06", type: "finish" });
  const list = getMilestones(fm);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((m) => m.type), ["create", "finish", "reopen", "finish"]);
  // 末位 = 最后一次事件（Home「已完成」卡按末位是不是 reopen 判定在不在已完成）
  assert.equal(list[list.length - 1].type, "finish");
});

// ---------- chain（任务链：父任务 + 步号，2026-11-12） ----------

test("C1. getChain 解析块形式（parent / step / total）", () => {
  const fm = ["---", "chain:", "  parent: flow/data/2026/Q4/11/父任务/README", "  step: 2", "  total: 4", "---"].join("\n");
  assert.deepEqual(getChain(fm), { parent: "flow/data/2026/Q4/11/父任务/README", step: 2, total: 4 });
});

test("C2. 缺 step/total → null；无 parent → 整段视为无链", () => {
  const fm = ["---", "chain:", "  parent: a/b/README", "---"].join("\n");
  assert.deepEqual(getChain(fm), { parent: "a/b/README", step: null, total: null });
  assert.equal(getChain("---\nkind: x\n---"), null);
  assert.equal(getChain("---\nchain:\n  step: 2\n---"), null);
});

test("C3. setChain 新增 / 替换 / 清空，不动相邻字段", () => {
  const withChain = setChain("---\nkind: x\n---", { parent: "a/b/README", step: 2, total: 4 });
  assert.equal(withChain, "---\nkind: x\nchain:\n  parent: a/b/README\n  step: 2\n  total: 4\n---");
  const replaced = setChain(withChain, { parent: "c/d/README", step: 1 });
  assert.equal(replaced, "---\nkind: x\nchain:\n  parent: c/d/README\n  step: 1\n---");
  assert.equal(setChain(replaced, null), "---\nkind: x\n---");
});

test("C4. 中文路径引号包裹、roundtrip 与原路径一致", () => {
  const fm = setChain("---\nkind: x\n---", { parent: "flow/data/2026/Q4/11/父任务/README", step: 3 });
  assert.match(fm, /parent: "flow\/data\/2026\/Q4\/11\/父任务\/README"/);
  assert.equal(getChain(fm).parent, "flow/data/2026/Q4/11/父任务/README");
  assert.equal(getChain(fm).step, 3);
  assert.equal(getChain(fm).total, null);
});

test("D1. getExternalDep 读标量；无字段 / 空值 → 空串", () => {
  assert.equal(getExternalDep("---\nexternal_dep: \"缺官方 jar，找张工\"\n---"), "缺官方 jar，找张工");
  assert.equal(getExternalDep("---\ndomain: x\n---"), "");
  assert.equal(getExternalDep("---\nexternal_dep:\n---"), "");
  assert.equal(getExternalDep(""), "");
});

test("D2. setExternalDep 新增 / 替换 / 清空，不动相邻字段", () => {
  const added = setExternalDep("---\ndomain: x\n---", "缺官方 jar");
  assert.equal(added, "---\ndomain: x\nexternal_dep: \"缺官方 jar\"\n---");
  const replaced = setExternalDep(added, "等现场回传日志");
  assert.equal(replaced, "---\ndomain: x\nexternal_dep: \"等现场回传日志\"\n---");
  assert.equal(setExternalDep(replaced, ""), "---\ndomain: x\n---");
});

test("D3. 内容段（无围栏）也能增删；roundtrip 一致", () => {
  const added = setExternalDep("domain: x", "等回复");
  assert.equal(added, "domain: x\nexternal_dep: \"等回复\"");
  assert.equal(getExternalDep(added), "等回复");
  assert.equal(setExternalDep(added, ""), "domain: x");
});

run();
