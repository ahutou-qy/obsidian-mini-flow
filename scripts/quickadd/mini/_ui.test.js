// _ui.test.js —— _ui 模块单测（裸 node + node:assert/strict）
//
// 跑：node flow/scripts/quickadd/mini/_ui.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 覆盖：
// - getCssVar 在无 window 环境下的鲁棒性（裸 node 跑时 window undefined）。
// - getCssVar 在传入空字符串 / 缺 fallback 名字下的行为。
// - applyChipHighlight 接受 null/undefined 入参不爆。
//
// 2026-11-23 砍 topic：原测试 5-28（matchTopicByQuery / applyAllTopicsFilter /
// buildTopicTree / applyTreeTopicsFilter / applyTopicSubtreeFilter / findTopicRoot）
// 随 _ui.js 的 8 个 topic helper 一并删除——功能没了，用例留着只会红。

const assert = require("node:assert/strict");
const { applyChipHighlight, getCssVar } = require("./_ui");

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

test("1. getCssVar 在无 window 环境下抛错兜底 → 返回空串", () => {
  // 裸 node：window 不存在。getCssVar 内部 try/catch,应返回 '' 而非抛错。
  assert.equal(typeof window, "undefined");
  const result = getCssVar("--interactive-accent");
  assert.equal(result, "");
});

test("2. getCssVar 任意名字都不抛错", () => {
  // 鲁棒性：非 CSS 标准名字也不应抛,统一返回空串。
  assert.doesNotThrow(() => getCssVar("--foo-bar-not-exist"));
  assert.equal(getCssVar("--foo-bar-not-exist"), "");
  assert.equal(getCssVar(""), "");
  assert.equal(getCssVar(null), "");
});

test("3. applyChipHighlight 入参为 null/undefined 不爆", () => {
  // 主题色填充对 null/undefined 入参应静默跳过,不抛错（modal 卸载时 chip 已 detach）。
  assert.doesNotThrow(() => applyChipHighlight(null, true));
  assert.doesNotThrow(() => applyChipHighlight(undefined, true));
  assert.doesNotThrow(() => applyChipHighlight(null, false));
  assert.doesNotThrow(() => applyChipHighlight(undefined, false));
});

test("4. applyChipHighlight 在 browser-less 环境下对真 stub 写样式不抛", () => {
  // 模拟一个 stub btn,验证 on=true 时不抛错（getCssVar 会兜底返回空,但 inline 分支进了）。
  const stub = {
    style: {
      backgroundColor: "",
      color: "",
      borderColor: "",
    },
  };
  // 没有 document.body 也没有 window → getCssVar 内 try/catch 返回 '' 兜底,fallback '#5bdef'/'#fff'。
  assert.doesNotThrow(() => applyChipHighlight(stub, true));
  assert.equal(stub.style.backgroundColor, "#5b8def");
  assert.equal(stub.style.color, "#ffffff");
  assert.equal(stub.style.borderColor, "#5b8def");

  // on=false 还原为空串。
  assert.doesNotThrow(() => applyChipHighlight(stub, false));
  assert.equal(stub.style.backgroundColor, "");
  assert.equal(stub.style.color, "");
  assert.equal(stub.style.borderColor, "");
});

run();
