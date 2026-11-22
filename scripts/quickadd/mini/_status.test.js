// ==============================================
// Mini Flow - _status.js 单测（裸 node + node:assert/strict）
//
// 跑：node flow/scripts/quickadd/mini/_status.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 覆盖状态字典（STATUSES 两档 active/finish）与重开判定（isReopenTransition）。
// 2026-11-04：task-edit 的重开路径靠它决定要不要写 reopen 里程碑。
// ==============================================

const assert = require("node:assert/strict");
const { STATUSES, isReopenTransition } = require("./_status");

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

// ---------- 状态字典 ----------

test("1. STATUSES 两档 active / finish（now/next 已并入 active，archive/dev_done 已下线）", () => {
  assert.deepEqual(STATUSES.map((s) => s.value), ["active", "finish"]);
});

// ---------- 重开判定 ----------

test("2. finish → active 是重开", () => {
  assert.equal(isReopenTransition("finish", "active"), true);
});

test("3. active → active / active → finish 不是重开", () => {
  assert.equal(isReopenTransition("active", "active"), false);
  assert.equal(isReopenTransition("active", "finish"), false);
});

test("4. finish → finish / 空态 / 未知态都不是重开", () => {
  assert.equal(isReopenTransition("finish", "finish"), false);
  assert.equal(isReopenTransition("finish", ""), false);
  assert.equal(isReopenTransition("", "active"), false);
  assert.equal(isReopenTransition("archive", "active"), false);
  assert.equal(isReopenTransition("dev_done", "active"), false);
});

test("5. 历史别名不误判成重开起点（reader-side 归一在 parseCaptureLine 侧做）", () => {
  // parseCaptureLine 把 #now/#next/#dev_done 归一为 active、#archive 归一为 finish；
  // 落到本函数时起点只可能是 active/finish/""，其余一律不算重开。
  assert.equal(isReopenTransition("dev_done", "active"), false);
  assert.equal(isReopenTransition("archive", "active"), false);
  assert.equal(isReopenTransition("now", "active"), false);
  assert.equal(isReopenTransition("next", "active"), false);
});

run();
