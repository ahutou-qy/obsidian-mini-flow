// ==============================================
// 契约守卫：afterFinish 的入参形态与接线形态
//
// 背景（2026-11-20 实测定位）：`opts.afterFinish` 的契约是 `(readme) => Promise<void>`
// （见 task-finish-gui.js 里 runFinish 的 opts 注释），而 `closeReadmeLeaf` 的签名是
// `(app, readme)`。**直接注入** `afterFinish: closeReadmeLeaf` 会让参数错位一格——
// app 收到 readme 对象、readme 收到 undefined，于是 `app.workspace` 是 undefined，
// 关 README tab 那步直接抛「Cannot read properties of undefined」，**任务完成了但
// README tab 永远关不掉**（QuickAdd 宏时代同一个坑，一直没被发现）。
//
// 为什么单测没抓到：`task-finish-gui.test.js` 里注入的一直是 `async (readme) => {...}`
// ——**按契约写**，所以 `runFinish` 那一层永远绿；断的是**接线**（module.exports 往
// runFinish 传了什么），没有测试覆盖到它。
//
// 本文件补的就是那道缝：读源码断言接线形态。手法与 `_rewriteStatus.test.js`
// （同样读源码断言）一致——接线形态是文本问题，用文本断言最直接，也最不容易被
// "重构得更优雅"顺手改回去。
// ==============================================
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");

const SRC = fs.readFileSync(path.join(__dirname, "task-finish-gui.js"), "utf8");

test("接线：afterFinish 注入点必须是以 readme 为唯一入参的箭头函数", () => {
  const m = SRC.match(/afterFinish:\s*(\(readme\)\s*=>[^\n]*)/);
  assert.ok(m, "源码里找不到 afterFinish 的注入点");
  assert.match(
    m[1],
    /closeReadmeLeaf\(\s*app\s*,\s*readme\s*\)/,
    "箭头里必须闭包捕获 app 并以 (app, readme) 调 closeReadmeLeaf——"
    + "直接注入 closeReadmeLeaf 会让 app 收到 readme、readme 收到 undefined，"
    + "关 tab 那步抛 undefined 属性错，README tab 关不掉",
  );
});

test("契约：runFinish 里所有 afterFinish(...) 调用都是单参 readme", () => {
  const calls = [...SRC.matchAll(/\bafterFinish\((\w*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `应至少两处调用（already 分支 + finally），实际 ${calls.length}`);
  for (const c of calls) {
    assert.equal(c, "readme", "afterFinish 必须单参调用（契约：(readme) => Promise<void>）");
  }
});

test("对照：closeReadmeLeaf 的签名仍是 (app, readme)——task-delete 按这个签名复用", () => {
  assert.match(
    SRC,
    /async function closeReadmeLeaf\(app, readme\)/,
    "closeReadmeLeaf 的签名不能改：task-delete.js 按 (app, file) 调它",
  );
});
