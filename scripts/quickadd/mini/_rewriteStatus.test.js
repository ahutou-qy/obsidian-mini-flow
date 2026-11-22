// ==============================================
// Mini Flow - rewriteStatus 单测（裸 node + node:assert/strict）
//
// 跑：node flow/scripts/quickadd/mini/_rewriteStatus.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 覆盖 _capture-line-rewrite.js 三个纯函数 + rewriteStatus 薄壳。
// 抽到独立模块避免 task-edit.js 顶层 require("obsidian") 在裸 node 下炸。
//
// 2026-11-12 状态档收敛：目标档 now/next → active（单活跃档）。历史别名
// （#now/#next/#dev_done/#archive）仍被 writer 识别并清理，本文件保留并扩写
// 它们的清理用例——老行被 rewrite 后必须只剩一个状态标签。
// ==============================================

const assert = require("node:assert/strict");
const { normalizeCheckbox, normalizeStatusTags, ensureCompletion, rewriteStatus } = require("./_capture-line-rewrite");

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

// ---------- 三个纯函数单元测试 ----------

test("1. normalizeCheckbox active → 任意符号变 [ ]", () => {
  for (const ch of ["x", "X", "o", "O", "/", ">", "-", " "]) {
    const line = `- [${ch}] [[…]] #active ^cap-abc`;
    assert.equal(normalizeCheckbox(line, "active"),
      "- [ ] [[…]] #active ^cap-abc", `failed for symbol '${ch}'`);
  }
});

test("2. normalizeCheckbox finish → 任意符号变 [x]", () => {
  for (const ch of [" ", "x", "X", "o", "O", "/", ">", "-"]) {
    const line = `- [${ch}] [[…]] #active ^cap-abc`;
    assert.equal(normalizeCheckbox(line, "finish"),
      "- [x] [[…]] #active ^cap-abc", `failed for symbol '${ch}'`);
  }
});

test("3. normalizeCheckbox 无 checkbox 形态不补", () => {
  const line = "[[…]] #active ^cap-abc";
  assert.equal(normalizeCheckbox(line, "finish"), line);
  assert.equal(normalizeCheckbox(line, "active"), line);
});

test("4. normalizeStatusTags 全局替换 - 修复历史 #now #archive 残留", () => {
  // 字典已不产历史档，但老 capture 行可能残留，作为清理目标。
  const dirty = "- [ ] [[…]] #now #archive [completion:: 2026-08-01] ^cap-abc";
  assert.equal(normalizeStatusTags(dirty, "finish"),
    "- [ ] [[…]] #finish [completion:: 2026-08-01] ^cap-abc");
});

test("5. normalizeStatusTags 多状态全部清干净", () => {
  const dirty = "[[…]] #now #next #archive ^cap-abc";
  assert.equal(normalizeStatusTags(dirty, "active"),
    "[[…]] #active ^cap-abc");
});

test("6. normalizeStatusTags 无 status 标签时锚点前插", () => {
  const line = "- [ ] [[…]] ^cap-abc";
  assert.equal(normalizeStatusTags(line, "active"),
    "- [ ] [[…]] #active ^cap-abc");
});

test("7. normalizeStatusTags 无锚点无 status → 行尾追加", () => {
  const line = "- [ ] [[…]]";
  assert.equal(normalizeStatusTags(line, "finish"),
    "- [ ] [[…]] #finish");
});

test("8. ensureCompletion finish 路径补 completion（唯一 closed 态）", () => {
  // archive 档删除后，finish 是唯一 closed 态，统一补 [completion:: 日期]。
  const line = "- [x] [[…]] #finish ^cap-abc";
  assert.equal(ensureCompletion(line, "finish", "2026-08-18"),
    "- [x] [[…]] #finish [completion:: 2026-08-18] ^cap-abc");
});

test("9. ensureCompletion finish 已有 completion 不补（去重）", () => {
  const line = "- [x] [[…]] #finish [completion:: 2026-08-10] ^cap-abc";
  assert.equal(ensureCompletion(line, "finish", "2026-08-18"), line);
});

test("11. ensureCompletion active 剥 completion", () => {
  const line = "- [ ] [[…]] #active [completion:: 2026-08-10] ^cap-abc";
  assert.equal(ensureCompletion(line, "active", "2026-08-18"),
    "- [ ] [[…]] #active ^cap-abc");
});

test("12. ensureCompletion active 多个 completion 仅剥一个（行为记录）", () => {
  // 极端:行内两个 completion(数据污染)。当前正则无 g,只剥首个。
  // 此行为记录,不修——避免引入 regex 全局副作用。
  const line = "- [ ] [[…]] #active [completion:: 2026-08-01] [completion:: 2026-08-10] ^cap-abc";
  assert.equal(ensureCompletion(line, "active", "2026-08-18"),
    "- [ ] [[…]] #active [completion:: 2026-08-10] ^cap-abc");
});

// ---------- rewriteStatus 薄壳回归 ----------

test("R1. rewriteStatus 残留 #archive → active 归一化 + 清 completion（reader-side 容错）", () => {
  // 历史 capture 行可能含 #archive，整段应被规整为 #active + 剥 completion。
  const line = "- [x] [[…]] #archive [completion:: 2026-08-01] ^cap-abc";
  assert.equal(rewriteStatus(line, "active", "2026-08-18"),
    "- [ ] [[…]] #active ^cap-abc");
});

test("R2. rewriteStatus active → finish 勾选 + 补 completion（对称语义）", () => {
  const line = "- [ ] [[…]] #active ^cap-abc";
  assert.equal(rewriteStatus(line, "finish", "2026-08-18"),
    "- [x] [[…]] #finish [completion:: 2026-08-18] ^cap-abc");
});

test("R3. rewriteStatus 任意 → finish 同步 [x] + 补 completion", () => {
  // 历史 #next 行推进到完成，一样折成单 #finish。
  const line = "- [ ] [[…]] #next ^cap-abc";
  assert.equal(rewriteStatus(line, "finish", "2026-08-18"),
    "- [x] [[…]] #finish [completion:: 2026-08-18] ^cap-abc");
});

test("R4. rewriteStatus 老 checkbox 符号 → finish（勾选 + 补 completion）", () => {
  for (const ch of ["/", ">", "-", "o", "O", "X"]) {
    const line = `- [${ch}] [[…]] #active ^cap-abc`;
    assert.equal(rewriteStatus(line, "finish", "2026-08-18"),
      "- [x] [[…]] #finish [completion:: 2026-08-18] ^cap-abc",
      `failed for symbol '${ch}'`);
  }
});

test("R5. rewriteStatus 多 status 残留修复（bug 1 回归，含历史 #archive）", () => {
  const dirty = "- [x] [[…]] #now #archive [completion:: 2026-08-01] ^cap-abc";
  assert.equal(rewriteStatus(dirty, "active", "2026-08-18"),
    "- [ ] [[…]] #active ^cap-abc");
});

test("R6. rewriteStatus 空白归一保留锚点在行尾", () => {
  // 单行首部缩进 + #active 与锚点间多空格 → 最终单空格,锚点行尾。
  const line = "  - [ ] [[…]]    #active    ^cap-abc  ";
  const out = rewriteStatus(line, "finish", "2026-08-18");
  assert.match(out, /\^cap-abc$/);
  assert.match(out, /^ {0,2}-\s\[x\]/);
  assert.match(out, /\[completion:: 2026-08-18\]/);
  // 不应有双空格
  assert.doesNotMatch(out, /  /);
});

// task-edit Modal 的 active 态改写（2026-11-12 起单活跃档，没有互切了）
test("R7. rewriteStatus active → active 幂等：剥 completion，checkbox 保持 [ ]", () => {
  const line = "- [ ] [[…]] #active [completion:: 2026-08-12] ^cap-yyy";
  assert.equal(rewriteStatus(line, "active", "2026-08-18"),
    "- [ ] [[…]] #active ^cap-yyy");
});

// task-edit 支持 finish → active reopen：剥 completion、[x]→[ ]、#finish→#active。
test("R9. rewriteStatus finish → active(reopen):剥 completion,checkbox [x]→[ ]", () => {
  const line = "- [x] [[…]] #domain/work7 #finish [completion:: 2026-08-20] ^cap-oh7fxzpe";
  assert.equal(rewriteStatus(line, "active", "2026-08-24"),
    "- [ ] [[…]] #domain/work7 #active ^cap-oh7fxzpe");
});

test("R10. rewriteStatus 历史 #next 行 → active（单活跃档归一）", () => {
  const line = "- [ ] [[…]] #next ^cap-abc";
  assert.equal(rewriteStatus(line, "active", "2026-08-24"),
    "- [ ] [[…]] #active ^cap-abc");
});

// dev_done 档已于 2026-10-22 从状态机删除。历史 capture 行可能残留 #dev_done：
// reader-side 归一为 active，writer 侧当历史别名清掉。
const { parseCaptureLine } = require("./_capture-line");

test("L1. parseCaptureLine 历史 #dev_done → active（reader-side 宽读）", () => {
  const parsed = parseCaptureLine(
    "- [[10/x/README|x]] #domain/work7 #dev_done #prio/高 ^cap-abc",
    "ideas-2026-10.md");
  assert.equal(parsed.status, "active");
});

test("L2. rewriteStatus 残留 #dev_done → active（清成单标签）", () => {
  const line = "- [ ] [[…]] #dev_done ^cap-abc";
  assert.equal(rewriteStatus(line, "active", "2026-10-22"),
    "- [ ] [[…]] #active ^cap-abc");
});

test("L3. rewriteStatus 双标签 #dev_done + #finish 折叠成单 #finish（1002 行回归）", () => {
  const dirty = "- [ ] [[…]] #dev_done #prio/中 #finish [completion:: 2026-10-21] ^cap-abc";
  assert.equal(rewriteStatus(dirty, "finish", "2026-10-22"),
    "- [x] [[…]] #finish #prio/中 [completion:: 2026-10-21] ^cap-abc");
});

test("L4. normalizeCheckbox #dev_done 行 → active 符号归 [ ]", () => {
  for (const ch of [" ", "x", "X", "o", "O", "/", ">", "-"]) {
    const line = `- [${ch}] [[…]] #dev_done ^cap-abc`;
    assert.equal(normalizeCheckbox(line, "active"),
      "- [ ] [[…]] #dev_done ^cap-abc", `failed for symbol '${ch}'`);
  }
});

// ---------- reader-side 历史别名归一表（2026-11-12） ----------

test("L5. parseCaptureLine 历史 #now / #next → active", () => {
  for (const tag of ["now", "next"]) {
    const parsed = parseCaptureLine(
      `- [[10/x/README|x]] #domain/work7 #${tag} ^cap-abc`,
      "ideas-2026-10.md");
    assert.equal(parsed.status, "active", `#${tag} 应归一为 active`);
  }
});

test("L6. parseCaptureLine 新档 #active 原样", () => {
  const parsed = parseCaptureLine(
    "- [[10/x/README|x]] #domain/work7 #active ^cap-abc",
    "ideas-2026-10.md");
  assert.equal(parsed.status, "active");
});

test("L7. parseCaptureLine 历史 #archive → finish（语义已并入 finish）", () => {
  const parsed = parseCaptureLine(
    "- [[10/x/README|x]] #domain/work7 #archive [completion:: 2026-08-01] ^cap-abc",
    "ideas-2026-08.md");
  assert.equal(parsed.status, "finish");
});

test("L8. parseCaptureLine #finish 原样", () => {
  const parsed = parseCaptureLine(
    "- [[10/x/README|x]] #domain/work7 #finish [completion:: 2026-08-01] ^cap-abc",
    "ideas-2026-08.md");
  assert.equal(parsed.status, "finish");
});

// ---------- 写面收敛（2026-11-19）：历史档位剥离 + 唯一实现等价性 ----------
//
// 背景：月度行改写原有两份实现——本模块的 rewriteStatus（CLI / task-edit 走）与
// _finish.js#rewriteStatusLine（Task Finish / 插件队列走）。语义不等价：后者剥
// #urgent/#blocked/#later、checkbox 只在 finish 时 [ ]→[x]；前者不剥、两态都归一。
// 收敛口径（用户 2026-11-19 拍板）：**统一剥 + checkbox 两态归一**，_finish.js 那份
// 改成转调本模块。下面的用例既锁口径，也锁「不再有第二份实现」。

const finishHelpers = require("./_finish.js");
const lineRewriteModule = require("./_capture-line-rewrite.js");

test("U1. normalizeStatusTags 剥历史档位 #urgent/#blocked/#later", () => {
  for (const tag of ["urgent", "blocked", "later"]) {
    const line = `- [ ] [[…]] #${tag} #active ^cap-abc`;
    assert.equal(normalizeStatusTags(line, "finish"),
      "- [ ] [[…]] #finish ^cap-abc", `#${tag} 应被剥掉`);
  }
});

test("U2. rewriteStatus → finish：#urgent 不残留双标签", () => {
  const line = "- [ ] [[…]] #urgent #active ^cap-abc";
  assert.equal(rewriteStatus(line, "finish", "2026-11-19"),
    "- [x] [[…]] #finish [completion:: 2026-11-19] ^cap-abc");
});

test("U3. rewriteStatus → active：历史档位同样剥（两态一致）", () => {
  const line = "- [x] [[…]] #blocked #finish [completion:: 2026-11-01] ^cap-abc";
  assert.equal(rewriteStatus(line, "active", "2026-11-19"),
    "- [ ] [[…]] #active ^cap-abc");
});

test("U4. 非档位标签不受影响（#prio / #yunxiao 保留）", () => {
  const line = "- [ ] [[…]] #yunxiao #prio/高 #later #active ^cap-abc";
  assert.equal(rewriteStatus(line, "finish", "2026-11-19"),
    "- [x] [[…]] #yunxiao #prio/高 #finish [completion:: 2026-11-19] ^cap-abc");
});

// 等价性语料：覆盖两态 × 历史标签 × checkbox 符号 × 有无锚点 × 有无 completion。
const EQ_CORPUS = [
  "- [ ] [[11/x/README|x]] #active ^cap-abc",
  "- [x] [[11/x/README|x]] #finish [completion:: 2026-11-01] ^cap-abc",
  "- [ ] [[11/x/README|x]] #urgent #now #next ^cap-abc",
  "- [o] [[11/x/README|x]] #dev_done #prio/中 #finish [completion:: 2026-10-21] ^cap-abc",
  "- [/] [[11/x/README|x]] #blocked #archive [completion:: 2026-08-01] ^cap-abc",
  "- [>] [[11/x/README|x]] #later #active [completion:: 2026-09-09] ^cap-abc",
  "[[11/x/README|x]] #active",
  "- 任务 #finish [completion:: 2026-09-17] ^cap-abc",
  "  - [X] [[11/x/README|x]]    #active    ^cap-abc  ",
  "- [ ] [[11/x/README|x]] ^cap-abc",
];

test("E1. rewriteStatusLine 与 rewriteStatus 逐字节等价（两态 × 全语料）", () => {
  for (const status of ["finish", "active"]) {
    for (const line of EQ_CORPUS) {
      assert.equal(
        finishHelpers.rewriteStatusLine(line, { status }, "2026-11-19"),
        rewriteStatus(line, status, "2026-11-19"),
        `status=${status} line=${JSON.stringify(line)}`);
    }
  }
});

test("E2. 注入模块与省略（裸 node require）两条路结果一致", () => {
  const line = "- [ ] [[11/x/README|x]] #urgent #active ^cap-abc";
  assert.equal(
    finishHelpers.rewriteStatusLine(line, { status: "finish" }, "2026-11-19", lineRewriteModule),
    finishHelpers.rewriteStatusLine(line, { status: "finish" }, "2026-11-19"));
});

test("E3. Obsidian 字符串加载（无 require）不注入 → 明确报错，不静默走第二份实现", () => {
  // 复刻 loadHelper / loadModule 的加载方式：new Function("module","exports",src)。
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "_finish.js"), "utf8");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  const line = "- [ ] [[11/x/README|x]] #active ^cap-abc";
  assert.throws(() => moduleObj.exports.rewriteStatusLine(line, { status: "finish" }, "2026-11-19"),
    /需要注入 _capture-line-rewrite\.js/);
  // 注入后与直接 require 的实现同结果。
  assert.equal(
    moduleObj.exports.rewriteStatusLine(line, { status: "finish" }, "2026-11-19", lineRewriteModule),
    rewriteStatus(line, "finish", "2026-11-19"));
});

test("E4. _finish.js 不再自带状态标签正则（唯一实现的源码守卫）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "_finish.js"), "utf8");
  assert.doesNotMatch(src, /#\(active\|now\|next\|dev_done\|archive\|finish\)/,
    "_finish.js 又出现了状态标签正则——月度行改写只许在 _capture-line-rewrite.js");
  assert.doesNotMatch(src, /urgent\|blocked\|later/,
    "历史档位剥离只许在 _capture-line-rewrite.js");
});

run();
