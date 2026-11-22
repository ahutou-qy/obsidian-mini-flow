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
        // 2026-09-20 起允许 async test 函数（listTopicChoices parent_id 测例需 mock vault 异步 read）。
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
  "task-delete.js", "task-finish-gui.js", "topic.js",
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

test("A3. _ui 导出 applyChipHighlight + getCssVar + applyAllTopicsFilter + matchTopicByQuery + buildTopicTree + findTopicRoot + renderFlatChips + applyTopicSubtreeFilter + applyTreeTopicsFilter", () => {
  const m = loadModule("_ui.js");
  assert.equal(typeof m.applyChipHighlight, "function");
  assert.equal(typeof m.getCssVar, "function");
  assert.equal(typeof m.applyAllTopicsFilter, "function");
  assert.equal(typeof m.matchTopicByQuery, "function");
  assert.equal(typeof m.buildTopicTree, "function", "_ui 应导出 buildTopicTree(N 级父子递归)");
  assert.equal(typeof m.findTopicRoot, "function", "_ui 应导出 findTopicRoot(2026-09-20 两层 UI 推父)");
  assert.equal(typeof m.renderFlatChips, "function", "_ui 应导出 renderFlatChips(平铺渲染)");
  assert.equal(typeof m.applyTopicSubtreeFilter, "function", "_ui 应导出 applyTopicSubtreeFilter(选中联动子树过滤)");
  assert.equal(typeof m.applyTreeTopicsFilter, "function", "_ui 应导出 applyTreeTopicsFilter(关键词过滤两遍)");
  assert.equal(typeof m.createTopicSection, "function", "_ui 应导出 createTopicSection(capture/edit 共用两层主题区)");
});

test("A4. _yaml 导出 getDomain", () => {
  const m = loadModule("_yaml.js");
  assert.equal(typeof m.getDomain, "function");
  // 旧 export 不破
  assert.equal(typeof m.getTopic, "function");
  assert.equal(typeof m.setTopic, "function");
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

// (d) 两级主题(2026-09-20 改造):listTopicChoices 返回结构含 parent_id 字段。
// 测例 mock 最小 vault(fake getAbstractFileByPath + fake async read),跑端到端解析。
test("A8. _workflow.listTopicChoices 返回 parent_id 字段(根主题空串 / 子主题为父 topic_id)", async () => {
  const wf = loadModule("_workflow.js");
  assert.equal(typeof wf.listTopicChoices, "function");
  // fake vault:2 张卡,1 张根主题 alpha(parent_topic 空)、1 张子主题 beta(parent_topic: work)
  const fakeChild1 = { name: "alpha.md", path: "flow/data/topics/alpha.md" };
  const fakeChild2 = { name: "beta.md", path: "flow/data/topics/beta.md" };
  const fakeRoot = { children: [fakeChild1, fakeChild2] };
  const fmAlpha = '---\ntopic_id: alpha\nstatus: active\nparent_topic: ""\n---\n';
  const fmBeta = '---\ntopic_id: beta\nstatus: active\nparent_topic: "work"\n---\n';
  const fakeVault = {
    getAbstractFileByPath: (p) => (p === "flow/data/topics" ? fakeRoot : null),
    read: async (file) => {
      if (file === fakeChild1) return fmAlpha;
      if (file === fakeChild2) return fmBeta;
      throw new Error(`unexpected read ${file && file.path}`);
    },
  };
  const choices = await wf.listTopicChoices(fakeVault);
  const alpha = choices.find((c) => c.id === "alpha");
  const beta = choices.find((c) => c.id === "beta");
  assert.ok(alpha, "应返回 alpha");
  assert.ok(beta, "应返回 beta");
  assert.equal(alpha.parent_id, "", "根主题 parent_id 应为空串");
  assert.equal(beta.parent_id, "work", "子主题 parent_id 应为 'work'");
});

// (e) 两级主题分组依据(2026-09-20):多父多子场景下,parent_id 字段为 capture/edit
// 树形渲染提供可索引的分组依据(父过滤 parent_id==''、子按 parent_id 命中父)。
// 测例覆盖 2 父 + 各自 1 子,验证 filter / parent_id 索引能正确归类。
test("A9. _workflow.listTopicChoices 树形分组依据:多父多子下 parent_id 可稳定过滤", async () => {
  const wf = loadModule("_workflow.js");
  const fakeRoot = {
    children: [
      { name: "alpha.md", path: "flow/data/topics/alpha.md" },
      { name: "beta.md", path: "flow/data/topics/beta.md" },
      { name: "gamma.md", path: "flow/data/topics/gamma.md" },
      { name: "delta.md", path: "flow/data/topics/delta.md" },
    ],
  };
  const fmAlpha = '---\ntopic_id: alpha\nstatus: active\nparent_topic: ""\n---\n';
  const fmBeta = '---\ntopic_id: beta\nstatus: active\nparent_topic: "alpha"\n---\n';
  const fmGamma = '---\ntopic_id: gamma\nstatus: active\nparent_topic: ""\n---\n';
  const fmDelta = '---\ntopic_id: delta\nstatus: active\nparent_topic: "gamma"\n---\n';
  const fakeVault = {
    getAbstractFileByPath: (p) => (p === "flow/data/topics" ? fakeRoot : null),
    read: async (file) => {
      const m = { "alpha.md": fmAlpha, "beta.md": fmBeta, "gamma.md": fmGamma, "delta.md": fmDelta };
      return m[file.name] || "";
    },
  };
  const choices = await wf.listTopicChoices(fakeVault);
  assert.equal(choices.length, 4, "应返回全部 4 张卡(deprecated 已被源端过滤,本测无 deprecated)");
  // 父主题判定:parent_id 为空串或缺省。
  const parents = choices.filter((c) => !c.parent_id);
  assert.equal(parents.length, 2, "应识别 2 张父主题");
  // 子主题按父分组:tree 渲染走 childrenByParent.get(parentId) 索引,索引命中预期关键。
  const childOfAlpha = choices.filter((c) => c.parent_id === "alpha");
  const childOfGamma = choices.filter((c) => c.parent_id === "gamma");
  assert.equal(childOfAlpha.length, 1, "alpha 应有 1 张子主题(beta)");
  assert.equal(childOfAlpha[0].id, "beta");
  assert.equal(childOfGamma.length, 1, "gamma 应有 1 张子主题(delta)");
  assert.equal(childOfGamma[0].id, "delta");
  // 父无对应子时 childrenByParent.get(parentId) 应返空数组,不应抛错。
  // 模拟渲染层 `childrenByParent.get(p.id) || []` 行为:无子主题的父仍能渲染。
  const parentsWithNoChildren = parents.filter((p) => choices.filter((c) => c.parent_id === p.id).length === 0);
  // 本测故意让 alpha / gamma 各有 1 子,验证以上不命中情况需在真实场景由 listTopicChoices
  // 自然返回(parent_id 字段空串 / 字段缺省视为根主题,过滤分支在本 cover 内由 done 测试);
  // 此处断言不命中数=0 与后续不重复渲染无关。
  assert.equal(parentsWithNoChildren.length, 0, "本测故意构造 2 父各 1 子,无空子父");
});

// (f) N 级父子递归(2026-09-20 嵌套强化)：buildTopicTree + applyTreeTopicsFilter
// 端到端 mock vault:3 根 + 1 三级链,验证 N 级递归不丢层 + 过滤保留树关系。
// 本测只覆盖 _ui helper,与 A8/A9 的 listTopicChoices 数据契约测试互补。
test("A10. _ui.buildTopicTree + applyTreeTopicsFilter 端到端 N 级父子不丢层", () => {
  const ui = loadModule("_ui.js");
  const choices = [
    { id: "work", label: "work", auto_keywords: ["work"], parent_id: "" },
    { id: "work5", label: "work5", auto_keywords: ["work5", "p541"], parent_id: "work" },
    { id: "work7", label: "work7", auto_keywords: ["work7", "rfid"], parent_id: "work" },
    { id: "work7-extra", label: "work7-extra", auto_keywords: ["work7-extra"], parent_id: "work7" },
    { id: "algo", label: "algo", auto_keywords: ["algo"], parent_id: "" },
  ];
  const roots = ui.buildTopicTree(choices);
  // 三级链:work → work7 → work7-extra
  assert.equal(roots.length, 2, "应有 2 个根主题(algo + work)");
  const workRoot = roots.find((n) => n.topic.id === "work");
  assert.ok(workRoot, "应识别 work 为根主题");
  const work7Node = workRoot.children.find((c) => c.topic.id === "work7");
  assert.ok(work7Node, "work 下应识别 work7 子主题");
  const work7ExtraNode = work7Node.children.find((c) => c.topic.id === "work7-extra");
  assert.ok(work7ExtraNode, "work7 下应识别 work7-extra 三级子主题(N 级递归不丢层)");
  assert.equal(work7ExtraNode.children.length, 0);

  // 过滤 "rfid" → 仅在 work7 关键字:验证祖先保留 + 子树传播
  const mask = ui.applyTreeTopicsFilter(roots, "rfid");
  for (const id of ["work", "work5", "work7", "work7-extra"]) {
    assert.equal(mask[id], true, `${id} 应可见(祖先保留 + 子树传播)`);
  }
  assert.equal(mask["algo"], false, "algo 不应被波及");
});

test("A11. _ui.applyTreeTopicsFilter 跨代际(三级链)→ work7-extra 命中时 work 全家展开", () => {
  const ui = loadModule("_ui.js");
  const choices = [
    { id: "work", label: "work", auto_keywords: [], parent_id: "" },
    { id: "work7", label: "work7", auto_keywords: [], parent_id: "work" },
    { id: "work7-extra", label: "work7-extra", auto_keywords: ["独家"], parent_id: "work7" },
    { id: "algo", label: "algo", auto_keywords: [], parent_id: "" },
  ];
  const roots = ui.buildTopicTree(choices);
  const mask = ui.applyTreeTopicsFilter(roots, "独家");
  // 命中 work7-extra → work7 祖先 + work 更祖先 + 子树全展开
  for (const id of ["work7-extra", "work7", "work"]) {
    assert.equal(mask[id], true);
  }
  assert.equal(mask["algo"], false);
});

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
