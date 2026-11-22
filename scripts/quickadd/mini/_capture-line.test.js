// ==============================================
// Mini Flow - _capture-line 单测（裸 node + node:assert/strict）
//
// 跑：node flow/scripts/quickadd/mini/_capture-line.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 覆盖纯函数 demoteCaptureLink / taskNameFromTarget ——
// 「删任务、留底行」时把行内 wiki 降级为纯文本，避免留下死链
// （Home 里点死链会被 Obsidian 当「链接不存在」新建空笔记）。
// ==============================================

const assert = require("node:assert/strict");
const { demoteCaptureLink, taskNameFromTarget, parseCaptureLine } = require("./_capture-line");

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

// ---------- taskNameFromTarget ----------

test("1. taskNameFromTarget 去掉尾部 README 段", () => {
  assert.equal(taskNameFromTarget("10/部署-提示：槽01被任务work7-p888-empty-tr/README"), "部署-提示：槽01被任务work7-p888-empty-tr");
});

test("2. taskNameFromTarget 去掉 .md 后缀（单文件任务）", () => {
  assert.equal(taskNameFromTarget("08/某任务.md"), "某任务");
});

test("3. taskNameFromTarget 只有 README 段时退回原串", () => {
  assert.equal(taskNameFromTarget("README"), "README");
});

// ---------- demoteCaptureLink ----------

test("4. demoteCaptureLink 有别名 → 保留别名、去掉 wiki 语法", () => {
  const line = "- [[10/某任务/README|某任务]] #domain/work7 #next ^cap-abc123";
  assert.equal(demoteCaptureLink(line), "- 某任务 #domain/work7 #next ^cap-abc123");
});

test("5. demoteCaptureLink 无别名 → 用反推的任务名", () => {
  const line = "- [[10/部署-提示：槽01被任务work7-p888-empty-tr/README]] #next ^cap-abc123";
  assert.equal(
    demoteCaptureLink(line),
    "- 部署-提示：槽01被任务work7-p888-empty-tr #next ^cap-abc123",
  );
});

test("6. demoteCaptureLink 只动第一个 wiki，follows 因果边保持原样", () => {
  const line = "- [[10/某任务/README|某任务]] #next [follows:: [[10/别的任务/README|别的]]] ^cap-abc123";
  assert.equal(
    demoteCaptureLink(line),
    "- 某任务 #next [follows:: [[10/别的任务/README|别的]]] ^cap-abc123",
  );
});

test("7. demoteCaptureLink 无 wiki 的行原样返回", () => {
  const line = "- 纯文本留底 #next ^cap-abc123";
  assert.equal(demoteCaptureLink(line), line);
});

test("8. demoteCaptureLink 降级后不再含 wiki（Home 的 capture 行过滤条件）", () => {
  const line = "- [[10/某任务/README|某任务]] #domain/work7 #next ^cap-abc123";
  assert.ok(!/^\s*\[\[/.test(demoteCaptureLink(line)));
});

// ---------- parseCaptureLine 的 yunxiao 位（Home 活跃卡滤云效项） ----------

test("9. parseCaptureLine 认出行内 #yunxiao", () => {
  const p = parseCaptureLine(
    "- [[10/某任务/README|某任务]] #domain/work7 #yunxiao #active ^cap-abc123",
    "flow/data/2026/Q4/ideas-2026-10.md",
  );
  assert.equal(p.yunxiao, true);
  assert.equal(p.status, "active");
});

test("10. parseCaptureLine 无 #yunxiao 时为 false（别名里的子串不算）", () => {
  const p = parseCaptureLine(
    "- [[10/某任务/README|某任务]] #active ^cap-abc123",
    "flow/data/2026/Q4/ideas-2026-10.md",
  );
  assert.equal(p.yunxiao, false);
});

run();
