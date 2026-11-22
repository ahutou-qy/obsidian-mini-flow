// ==============================================
// Mini Flow - _tab-title 单测（node --test 或裸 node 都能跑）
//
// 跑：node flow/scripts/quickadd/mini/_tab-title.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 覆盖 taskLabelForReadmeFile：folder 任务 README 的显示标题映射。
// 判据来自 _task.js#taskFolderPrefixOf，这里让它跑真身（不打桩），
// 保证「周记目录不算任务」「月目录根 README 不改名」这类边界与索引侧一致。
// ==============================================

const assert = require("node:assert/strict");
const { taskLabelForReadmeFile } = require("./_tab-title.js");
const { taskFolderPrefixOf } = require("./_task.js");

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

const file = (parentPath, basename = "README") => ({ basename, parentPath });
const label = (parentPath, basename) =>
  taskLabelForReadmeFile(file(parentPath, basename), taskFolderPrefixOf);

test("任务根 README → 任务目录名", () => {
  assert.equal(label("flow/data/2026/Q4/10/1002-示例客户"), "1002-示例客户");
});

test("任务内子目录 README → 任务名/子目录", () => {
  assert.equal(label("flow/data/2026/Q4/10/1002-示例客户/design"), "1002-示例客户/design");
  assert.equal(label("flow/data/2026/Q4/10/1002-示例客户/process/输入"), "1002-示例客户/process/输入");
});

test("非 README 文件不接管（普通笔记标题仍按文件名）", () => {
  assert.equal(label("flow/data/2026/Q4/10/1002-示例客户", "02-设计"), "");
  assert.equal(label("flow/data/2026/Q4/10/1002-示例客户", "1002-示例客户"), "");
});

test("周记目录 <月目录>/W<n>/README.md 不算任务", () => {
  assert.equal(label("flow/data/2026/Q4/10/W44"), "");
});

test("月目录自身 README.md 不算任务", () => {
  assert.equal(label("flow/data/2026/Q4/10"), "");
});

test("任务树之外（vault 根、其它区）不改名", () => {
  assert.equal(label("notes/读书"), "");
  assert.equal(label(""), "");
  assert.equal(label("flow/data/2026/Q3"), "");
});

test("缺 helper / 缺参数时返回空串（退回 Obsidian 默认 basename）", () => {
  assert.equal(taskLabelForReadmeFile(file("flow/data/2026/Q4/10/x")), "");
  assert.equal(taskLabelForReadmeFile(null, taskFolderPrefixOf), "");
  assert.equal(taskLabelForReadmeFile({ basename: "README" }, taskFolderPrefixOf), "");
});

let passed = 0;
let failed = 0;
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
if (failed > 0) process.exit(1);
