// 真机冒烟驱动（裸 node + 字符串加载，等同 QuickAdd 沙箱入参）
//
// 跑：node flow/scripts/quickadd/mini/_smoke.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 这一份是把 QuickAdd 触发宏的"前置"段模拟一遍——验证阶段 1-5 的
// 模块化抽取没破坏任意一个命令的 imports / top-level require / parseCaptureLine 约定。
//
// 真实命令触发仍然需要人工在 Obsidian 内通过 QuickAdd 跑（自动跑不了），
// 本驱动断言:
//   (a) 所有 mini/*.js top-level parse 都没 syntax error
//   (b) 阶段 1-5 新增的模块 exports 形态正确
//   (c) parseCaptureLine 在 monthly file 的所有现成行上未爆（_rewriteStatus 边界）

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

// scripts/quickadd/mini/_smoke.js 跑时,__dirname 是 mini/；其下文件直接 join。
// 需要 vault 内路径的两处（插件 main.js、月度 ideas 文件）走 _vault-root.js 定位——
// 挂载后 __dirname 上溯推不出 vault 根。
const { resolveVaultRoot } = require("./_vault-root.js");
const VAULT_ROOT = resolveVaultRoot();

let passed = 0;
let failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

async function run() {
  for (const { name, fn } of cases) {
    try {
      const r = fn();
      if (r && typeof r.then === "function") {
        // 2026-09-20 起允许 async test 函数（需 mock vault 异步 read 的测例）。
        await r;
      }
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// 简易字符串加载（同 QuickAdd 沙箱范式）
function loadModule(name) {
  const src = fs.readFileSync(path.join(__dirname, name), "utf8");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
function loadAll(names) {
  return names.map(loadModule);
}

// ---------- 用例 ----------

// (a) top-level syntax + exports sanity
// 阶段 1-5 接触过的文件(必跑)+ mini 主链路核心文件。
const TOUCHED_BY_STAGES_1_TO_5 = [
  // 阶段 1
  "_status.js", "_ui.js", "task-capture.js", "task-edit.js",
  // 阶段 3
  "_yaml.js",
  // 阶段 4
  "_ui.js",
  // 阶段 5
  "_capture-line-rewrite.js", "task-edit.js",
];
const CORE_MINI = [
  "_capture.js", "_capture-line.js", "_clipboard.js", "_index.js", "_infer.js",
  "_naming.js", "_rename.js", "_rule.js", "_rule-review.js", "_tab-title.js",
  "_task.js", "_walk.js", "_workflow.js",
  "rule-capture.js", "rule-validate.js", "rule-promote.js", "rule-deprecate.js",
  "task-delete.js", "task-finish-gui.js",
];
const ASSERT_PARSE = [...new Set([...TOUCHED_BY_STAGES_1_TO_5, ...CORE_MINI])];

test(`A1. 阶段 1-5 接触过的核心文件 + 主链路 mini/*.js 顶层语法 parse 通过（${ASSERT_PARSE.length} 份）`, () => {
  const { execSync } = require("node:child_process");
  for (const name of ASSERT_PARSE) {
    const fp = path.join(__dirname, name);
    execSync(`node --check "${fp}"`, { stdio: "pipe" });
  }
});

test("A2. _status 导出 STATUSES + 已有 keywords", () => {
  const m = loadModule("_status.js");
  assert.ok(Array.isArray(m.STATUSES), "_status 必须导出 STATUSES 数组");
  assert.equal(m.STATUSES.length, 2, "STATUSES 必须是 2 态（active/finish）");
  for (const v of ["active", "finish"]) {
    assert.ok(m.STATUSES.some((s) => s.value === v && typeof s.label === "string"),
      `STATUSES 必须含 ${v} 档`);
  }
  // NOW_KEYWORDS / NEXT_KEYWORDS / TEST_KEYWORDS 已在 2026-09-14 三次状态/测试机制收敛时
  // 全部从 _status.js 移除——capture 状态无自动推断，测试任务机制已删。
});

test("A3. _ui 导出 applyChipHighlight + getCssVar + initI18n；8 个 topic helper 已下线", () => {
  const m = loadModule("_ui.js");
  assert.equal(typeof m.applyChipHighlight, "function");
  assert.equal(typeof m.getCssVar, "function");
  assert.equal(typeof m.initI18n, "function");
  // 2026-11-23 砍 topic：下列 8 个随 topic 轴一并删除，断言它们**不在**导出里（防回归）。
  for (const gone of [
    "applyAllTopicsFilter", "matchTopicByQuery", "buildTopicTree", "findTopicRoot",
    "renderFlatChips", "applyTopicSubtreeFilter", "applyTreeTopicsFilter", "createTopicSection",
  ]) {
    assert.equal(m[gone], undefined, `_ui 不应再导出 ${gone}`);
  }
});

test("A4. _yaml 导出 getDomain；topic 原语已下线", () => {
  const m = loadModule("_yaml.js");
  assert.equal(typeof m.getDomain, "function");
  // 2026-11-23 砍 topic：getTopic / setTopic / getTopicsLegacy 已删，断言它们不在（防回归）。
  for (const gone of ["getTopic", "setTopic", "getTopicsLegacy"]) {
    assert.equal(m[gone], undefined, `_yaml 不应再导出 ${gone}`);
  }
});

test("A5. _capture-line-rewrite 导出四个函数", () => {
  const m = loadModule("_capture-line-rewrite.js");
  for (const fn of ["normalizeCheckbox", "normalizeStatusTags", "ensureCompletion", "rewriteStatus"]) {
    assert.equal(typeof m[fn], "function", `_capture-line-rewrite 缺 ${fn}`);
  }
});

// (c) parseCaptureLine 真实 monthly 行 parse 回归
test("A6. task-edit / task-capture 把 STATUSES 与 applyChipHighlight 注入 Modal 实例(避免闭包 scope 漂移)", () => {
  // 真机 bug 回归:阶段 1 抽提后,Modal class 定义在模块顶层、const STATUSES /
  // const { applyChipHighlight } 在 async 入口函数体内,class 方法闭包看不到 →
  // QuickAdd 真机报 "STATUSES is not defined"。修复:全部走 this. 注入。
  for (const file of ["task-edit.js", "task-capture.js"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(src, /this\.STATUSES = opts\.STATUSES;/,
      `${file} constructor 必须保存 opts.STATUSES`);
    // class 方法内不得裸调 STATUSES(只允许 this.STATUSES)。
    const classBody = src.slice(src.indexOf("class "));
    const nakedStatus = classBody.match(/[^\w.]STATUSES\b(?!\s*=)/g) || [];
    assert.equal(nakedStatus.filter((m) => !m.includes("this.") && !m.includes("opts.")).length, 0,
      `${file} class 内不得裸引用 STATUSES,必须 this.STATUSES`);
  }
  // task-capture.js: applyChipHighlight 同样从模块顶层函数移进了 async 作用域,class 内必须 this.
  const ideaSrc = fs.readFileSync(path.join(__dirname, "task-capture.js"), "utf8");
  const ideaClass = ideaSrc.slice(ideaSrc.indexOf("class IdeaModal"));
  const nakedChip = ideaClass.match(/(^|[^.\w])applyChipHighlight\(/g) || [];
  assert.equal(nakedChip.filter((m) => !m.includes("this.")).length, 0,
    "task-capture.js IdeaModal 内不得裸调 applyChipHighlight,必须 this.applyChipHighlight");
  assert.match(ideaSrc, /this\.applyChipHighlight = opts\.applyChipHighlight;/);
});

// (c-bis) miniflow 插件 main.js 的 ConvertIdeaModal：与 task-edit / task-capture
// 同形态（this.STATUSES / this.applyChipHighlight 注入、class 方法体不得裸调）。plugin 文件
// 不在 mini/ 目录（它在 .obsidian/plugins/miniflow/），不在 A1 parse 白名单内，
// 单独走 path.join 读源码字符串做字符扫描。
const PLUGIN_MAIN_PATH = path.join(VAULT_ROOT, ".obsidian", "plugins", "miniflow", "main.js");
test("A12. miniflow main.js 内 ConvertIdeaModal 注入 STATUSES + applyChipHighlight(避免闭包 scope 漂移)", () => {
  if (!fs.existsSync(PLUGIN_MAIN_PATH)) {
    console.log(`    (skip: ${PLUGIN_MAIN_PATH} not exist)`);
    return;
  }
  const src = fs.readFileSync(PLUGIN_MAIN_PATH, "utf8");
  // 必须有 ConvertIdeaModal class。
  const classMatch = src.match(/class\s+ConvertIdeaModal\b[\s\S]*?\n\}\s*\n/);
  assert.ok(classMatch, "main.js 必须定义 ConvertIdeaModal class");
  const classBody = classMatch[0];
  // constructor 必须保存 opts.STATUSES / opts.applyChipHighlight 到 this。
  assert.match(classBody, /this\.STATUSES\s*=\s*opts\.STATUSES;/,
    "ConvertIdeaModal constructor 必须 this.STATUSES = opts.STATUSES");
  assert.match(classBody, /this\.applyChipHighlight\s*=\s*opts\.applyChipHighlight;/,
    "ConvertIdeaModal constructor 必须 this.applyChipHighlight = opts.applyChipHighlight");
  // class 方法体内不得裸引用 STATUSES(只允许 this.STATUSES / opts.STATUSES)。
  const nakedStatus = classBody.match(/[^\w.]STATUSES\b(?!\s*=)/g) || [];
  const nakedStatusOffenders = nakedStatus.filter((m) => !m.includes("this.") && !m.includes("opts."));
  assert.equal(nakedStatusOffenders.length, 0,
    `ConvertIdeaModal class 内不得裸引用 STATUSES,必须 this.STATUSES; offenders=${nakedStatusOffenders.join("|")}`);
  // class 方法体内不得裸调 applyChipHighlight(只允许 this.applyChipHighlight)。
  const nakedChip = classBody.match(/(^|[^.\w])applyChipHighlight\(/g) || [];
  const nakedChipOffenders = nakedChip.filter((m) => !m.includes("this."));
  assert.equal(nakedChipOffenders.length, 0,
    `ConvertIdeaModal class 内不得裸调 applyChipHighlight,必须 this.applyChipHighlight; offenders=${nakedChipOffenders.join("|")}`);
});

// 规则评审机制(2026-10-14):_rule-review 导出 4 个核心动作 + 字段读写 + 阈值常量;
// rule-validate / rule-promote / rule-deprecate 三个 QuickAdd 命令 module.exports 必须存在。
test("A13. _rule-review 导出 4 核心动作 + 字段读写 + 阈值常量(规则评审机制)", () => {
  const m = loadModule("_rule-review.js");
  for (const fn of [
    "validateRule", "promoteRuleManual", "deprecateRule",
    "appendReferencedRuleBlock", "appendChangeEntry",
    "splitRuleDoc", "readBlockArray", "writeBlockArray",
    "readScalar", "writeScalar",
    "parseEntryTarget", "resolveEntryPath", "taskIdentityOf",
    "uniqueValidatedByCount", "isTaskAlreadyValidated",
    "formatValidationEntry",
  ]) {
    assert.equal(typeof m[fn], "function", `_rule-review 缺 ${fn}`);
  }
  assert.equal(m.PROMOTE_THRESHOLD, 2, "PROMOTE_THRESHOLD 必须锁定 2（与 qy 2026-10-14 决策）");
  for (const cmd of ["rule-validate.js", "rule-promote.js", "rule-deprecate.js"]) {
    const c = loadModule(cmd);
    assert.equal(typeof c, "function", `${cmd} 必须 module.exports 一个 async 函数`);
  }
});

test("A7. _capture-line.parseCaptureLine 对 ideas-2026-08.md 每行解析不抛", () => {
  const lineMod = loadModule("_capture-line.js");
  assert.equal(typeof lineMod.parseCaptureLine, "function");
  const target = path.join(VAULT_ROOT, "flow", "data", "2026", "Q3", "ideas-2026-08.md");
  if (!fs.existsSync(target)) {
    console.log("    (skip: ideas-2026-08.md not exist)");
    return;
  }
  const content = fs.readFileSync(target, "utf8");
  const lines = content.split("\n");
  let parsedCount = 0;
  let emptyCount = 0;
  for (const ln of lines) {
    const r = lineMod.parseCaptureLine(ln, target);
    if (r === null) emptyCount++;
    else parsedCount++;
    // 关键:每行要么 parse 出 capture,要么 null,绝不应抛错或返未定义对象。
    assert.ok(r === null || typeof r === "object");
  }
  console.log(`       parsed=${parsedCount}, empty=${emptyCount}`);
});
// 2026-11-23 砍 topic：A8/A9（_workflow.listTopicChoices 数据契约）、A10/A11（buildTopicTree +
// applyTreeTopicsFilter）全部随 topic 轴落地下线——listTopicChoices 与 _ui 的 topic helper 已删，
// 用例留着只会红。topic 的「已下线」由 A3/A4 的 `undefined` 断言守。

test("A14. _clipboard 导出 + fullPathOf 退化链（桌面绝对路径 / 无 API / 抛错 / 空串 / 裸 node 不 reject）", async () => {
  const clip = loadModule("_clipboard.js");
  for (const fn of ["copyReadmePath", "fullPathOf", "execCommandCopy"]) {
    assert.equal(typeof clip[fn], "function", `_clipboard 必须导出 ${fn}`);
  }
  // 桌面端：直接采用 adapter.getFullPath 的返回值（Windows 反斜杠由 Obsidian 内部
  // path.join(basePath, rel) 保证，这里不复刻那层，只断言走了 adapter）。
  const app = { vault: { adapter: { getFullPath: (rel) => `E:\\vault\\${rel.replace(/\//g, "\\")}` } } };
  assert.equal(clip.fullPathOf(app, "flow/data/a/README.md"), "E:\\vault\\flow\\data\\a\\README.md");
  // 移动端 / adapter 无 getFullPath：退化 vault 相对路径，不抛。
  assert.equal(clip.fullPathOf({ vault: { adapter: {} } }, "flow/data/a/README.md"), "flow/data/a/README.md");
  // getFullPath 抛错：同样退化，不把异常带出去。
  assert.equal(
    clip.fullPathOf({ vault: { adapter: { getFullPath() { throw new Error("boom"); } } } }, "x.md"),
    "x.md",
  );
  assert.equal(clip.fullPathOf(app, ""), "");
  // 裸 node 没有 navigator/document：copyReadmePath 必须 resolve false 而不是 reject。
  assert.equal(await clip.copyReadmePath(app, "x.md"), false);
});

run();
