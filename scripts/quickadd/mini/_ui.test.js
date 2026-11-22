// _ui.test.js —— _ui 模块单测（裸 node + node:assert/strict）
//
// 跑：node flow/scripts/quickadd/mini/_ui.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 覆盖：
// - getCssVar 在无 window 环境下的鲁棒性（裸 node 跑时 window undefined）。
// - getCssVar 在传入空字符串 / 缺 fallback 名字下的行为。
// - applyChipHighlight 接受 null/undefined 入参不爆。

const assert = require("node:assert/strict");
const { applyChipHighlight, getCssVar, applyAllTopicsFilter, matchTopicByQuery, buildTopicTree, applyTreeTopicsFilter, applyTopicSubtreeFilter, findTopicRoot } = require("./_ui");

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

// ---------- 阶段 4：applyAllTopicsFilter / matchTopicByQuery ----------

const topicChoices = [
  { id: "WORK7", label: "WORK7", auto_keywords: ["WORK7", "work7", "rfid", "plu"] },
  { id: "WORK10", label: "WORK10", auto_keywords: ["work10", "plu"] },
  { id: "fitness", label: "fitness", auto_keywords: ["fitness", "running"] },
  { id: "YYS", label: "YYS", auto_keywords: ["阴阳师"] },
];

test("5. matchTopicByQuery 空 query → 全 true", () => {
  for (const t of topicChoices) {
    assert.equal(matchTopicByQuery(t, ""), true);
    assert.equal(matchTopicByQuery(t, "   "), true);
    assert.equal(matchTopicByQuery(t, null), true);
    assert.equal(matchTopicByQuery(t, undefined), true);
  }
});

test("6. matchTopicByQuery 子串命中 label（大小写不敏感）", () => {
  assert.equal(matchTopicByQuery(topicChoices[0], "work7"), true);
  assert.equal(matchTopicByQuery(topicChoices[0], "WORK"), true);
  assert.equal(matchTopicByQuery(topicChoices[2], "fit"), true);
  assert.equal(matchTopicByQuery(topicChoices[2], "fitness"), true);
  assert.equal(matchTopicByQuery(topicChoices[3], "yys"), true);
});

test("7. matchTopicByQuery label 不命中但 auto_keywords 命中", () => {
  // "阴" 在 label "YYS" 中不命中,但 "阴阳师" 在 auto_keywords 里命中。
  assert.equal(matchTopicByQuery(topicChoices[3], "阴"), true);
  // "rfid" label 不含,但 auto_keywords 含 → 命中。
  assert.equal(matchTopicByQuery(topicChoices[0], "rfid"), true);
});

test("8. matchTopicByQuery 都不命中 → false", () => {
  assert.equal(matchTopicByQuery(topicChoices[0], "zzz"), false);
  assert.equal(matchTopicByQuery(topicChoices[1], "fitness"), false);
});

test("9. applyAllTopicsFilter 顺序与 choices 一致（与 DOM 切 style.display 同步）", () => {
  // query "work" 命中 WORK7 + WORK10,其他不命中。
  const mask = applyAllTopicsFilter(topicChoices, "work");
  assert.deepEqual(mask, [true, true, false, false]);
});

test("10. applyAllTopicsFilter 空 query → 全 true", () => {
  assert.deepEqual(applyAllTopicsFilter(topicChoices, ""), [true, true, true, true]);
});

test("11. applyAllTopicsFilter choices 非数组兜底", () => {
  assert.deepEqual(applyAllTopicsFilter(null, "x"), []);
  assert.deepEqual(applyAllTopicsFilter(undefined, "x"), []);
  assert.deepEqual(applyAllTopicsFilter("foo", "x"), []);
});

// ---------- 阶段 5：buildTopicTree / applyTreeTopicsFilter ----------
//
// 三级父子 + 多父多子数据,验证 N 级递归建树与树形过滤的可见性规则。
const treeChoices = [
  { id: "work5", label: "work5", auto_keywords: ["work5", "p541"], parent_id: "work" },
  { id: "work7", label: "work7", auto_keywords: ["work7", "rfid", "plu"], parent_id: "work" },
  { id: "work10", label: "work10", auto_keywords: ["work10", "plu"], parent_id: "work" },
  { id: "work", label: "work", auto_keywords: ["work"], parent_id: "" },
  { id: "work7-extra", label: "work7-extra", auto_keywords: ["work7-extra"], parent_id: "work7" },
  { id: "algo", label: "algo", auto_keywords: ["algo"], parent_id: "" },
  { id: "fitness", label: "fitness", auto_keywords: ["fitness"], parent_id: "" },
];

test("12. buildTopicTree 多父多子 + 三级链正确建树", () => {
  const roots = buildTopicTree(treeChoices);
  // 根主题按 label zh 排序:algo < fitness < work
  assert.equal(roots.length, 3, "应识别 3 张根主题(algo / fitness / work)");
  assert.equal(roots[0].topic.id, "algo");
  assert.equal(roots[1].topic.id, "fitness");
  assert.equal(roots[2].topic.id, "work");
  // work 的 children:按 label zh 排,实际顺序 work10 < work5 < work7(拼音读"十"<"五"<"七")
  const workChildren = roots[2].children.map((n) => n.topic.id);
  assert.deepEqual(workChildren, ["work10", "work5", "work7"]);
  // work7 在排序后位于 index 2: work10 < work5 < work7
  const work7Children = roots[2].children[2].children.map((n) => n.topic.id);
  assert.deepEqual(work7Children, ["work7-extra"]);
  // work7-extra 无 children
  assert.equal(roots[2].children[2].children[0].children.length, 0);
  // algo / fitness 无 children
  assert.equal(roots[0].children.length, 0);
  assert.equal(roots[1].children.length, 0);
});

test("13. buildTopicTree 孤儿(parent_id 指向不存在 topic)升级为根,不抛错", () => {
  const orphanChoices = [
    { id: "ghost", label: "ghost", auto_keywords: [], parent_id: "nonexistent" },
    { id: "real", label: "real", auto_keywords: [], parent_id: "" },
  ];
  const roots = buildTopicTree(orphanChoices);
  assert.equal(roots.length, 2, "孤儿应升级为根,与真根并列");
  const ids = roots.map((n) => n.topic.id).sort();
  assert.deepEqual(ids, ["ghost", "real"]);
});

test("14. buildTopicTree 空 choices / 非数组兜底", () => {
  assert.deepEqual(buildTopicTree([]), []);
  assert.deepEqual(buildTopicTree(null), []);
  assert.deepEqual(buildTopicTree(undefined), []);
});

test("15. applyTreeTopicsFilter 空 query → 全 true", () => {
  const roots = buildTopicTree(treeChoices);
  const mask = applyTreeTopicsFilter(roots, "");
  for (const t of treeChoices) assert.equal(mask[t.id], true, `${t.id} 应可见`);
});

test("16. applyTreeTopicsFilter 输入父名 → 父与所有 descendants 全 visible", () => {
  // "work" 命中 work 自身 → pass1: work 可见 → pass2: 所有 work 子树全可见。
  const roots = buildTopicTree(treeChoices);
  const mask = applyTreeTopicsFilter(roots, "work");
  for (const id of ["work", "work5", "work7", "work10", "work7-extra"]) {
    assert.equal(mask[id], true, `${id} 应可见(父或子孙)`);
  }
  assert.equal(mask["algo"], false);
  assert.equal(mask["fitness"], false);
});

test("17. applyTreeTopicsFilter 输入子关键词 → 命中节点 + 所有 ancestors 可见", () => {
  // "rfid" 在 work7 的 auto_keywords 里 → pass1: work7 可见 + work(因 childVisible)可见 → pass2: work 子树全展开。
  const roots = buildTopicTree(treeChoices);
  const mask = applyTreeTopicsFilter(roots, "rfid");
  // work 子树全可见(祖先 + 自身 + 子树传播)
  for (const id of ["work", "work7", "work5", "work10", "work7-extra"]) {
    assert.equal(mask[id], true, `${id} 应可见`);
  }
  // 其它根主题仍隐藏
  assert.equal(mask["algo"], false);
  assert.equal(mask["fitness"], false);
});

test("18. applyTreeTopicsFilter 无命中 → 全 false", () => {
  const roots = buildTopicTree(treeChoices);
  const mask = applyTreeTopicsFilter(roots, "zzz");
  for (const t of treeChoices) {
    assert.equal(mask[t.id], false, `${t.id} 应隐藏`);
  }
});

test("19. applyTreeTopicsFilter 三级链:work7-extra 命中关键词时 work7 与 work 也可见", () => {
  const roots = buildTopicTree(treeChoices);
  const mask = applyTreeTopicsFilter(roots, "work7-extra");
  // work7-extra 命中自身;work7 祖先(因 childVisible);work 更高祖先(因 childVisible);
  // pass2 让 work 子树全展开。
  for (const id of ["work7-extra", "work7", "work5", "work10", "work"]) {
    assert.equal(mask[id], true, `${id} 应可见`);
  }
  assert.equal(mask["algo"], false);
  assert.equal(mask["fitness"], false);
});

test("20. applyTreeTopicsFilter null/undefined roots 兜底", () => {
  assert.deepEqual(applyTreeTopicsFilter(null, "x"), {});
  assert.deepEqual(applyTreeTopicsFilter(undefined, ""), {});
  assert.deepEqual(applyTreeTopicsFilter("not-array", "x"), {});
});

// ---------- 阶段 6：applyTopicSubtreeFilter(选中态联动子树过滤) ----------
//
// 2026-09-20 四次改造:全集 chip 平铺,选中某 topic 后只显其子树(含自身 + descendants)。
// 与 applyTreeTopicsFilter(关键词过滤)是两套独立 mask:前者由 selected 驱动,
// 后者由 query 驱动;本测只覆盖 selected-driven 路径。
test("21. applyTopicSubtreeFilter 空 selected → 全 true", () => {
  const roots = buildTopicTree(treeChoices);
  const mask = applyTopicSubtreeFilter(roots, "");
  for (const t of treeChoices) assert.equal(mask[t.id], true, `${t.id} 应可见`);
  assert.equal(mask["work7-extra"], true);
});

test("22. applyTopicSubtreeFilter 选 work → work 子树(work + work5/7/10 + work7-extra)可见,其它根主题隐藏", () => {
  const roots = buildTopicTree(treeChoices);
  const mask = applyTopicSubtreeFilter(roots, "work");
  // treeChoices 里 work 有 3 个子:work5/work7/work10;work7 下挂 work7-extra。
  for (const id of ["work", "work5", "work7", "work10", "work7-extra"]) {
    assert.equal(mask[id], true, `${id} 应可见(work 子树)`);
  }
  for (const id of ["algo", "fitness"]) {
    assert.equal(mask[id], false, `${id} 应隐藏(非 work 子树)`);
  }
});

test("23. applyTopicSubtreeFilter 选 work7 → work7 + 其 descendants(work7-extra)可见,同级兄弟与其它根主题隐藏", () => {
  const roots = buildTopicTree(treeChoices);
  const mask = applyTopicSubtreeFilter(roots, "work7");
  // work7 自身 + 其 descendants
  for (const id of ["work7", "work7-extra"]) {
    assert.equal(mask[id], true);
  }
  // work 父主题被隐藏(不在 work7 子树内,work7 子树 ≠ work 子树)
  assert.equal(mask["work"], false, "work 父不应被波及(只看 work7 子树)");
  // work7 的兄弟(work5/work10)也被隐藏
  for (const id of ["work5", "work10"]) {
    assert.equal(mask[id], false);
  }
  // 其它根主题隐藏
  assert.equal(mask["algo"], false);
  assert.equal(mask["fitness"], false);
});

test("24. applyTopicSubtreeFilter null/undefined/非数组 tree 兜底", () => {
  assert.deepEqual(applyTopicSubtreeFilter(null, "x"), {});
  assert.deepEqual(applyTopicSubtreeFilter(undefined, ""), {});
  assert.deepEqual(applyTopicSubtreeFilter("not-array", "work"), {});
});

test("25. applyTopicSubtreeFilter 选不存在的 id → 全 false(节点找不到)", () => {
  const roots = buildTopicTree(treeChoices);
  const mask = applyTopicSubtreeFilter(roots, "ghost");
  for (const t of treeChoices) assert.equal(mask[t.id], false, `${t.id} 应隐藏`);
});

// ---------- 阶段 7：findTopicRoot(两层 chip UI 推父节点) ----------
test("26. findTopicRoot 根主题 → 返回自身", () => {
  const roots = buildTopicTree(treeChoices);
  const workRoot = findTopicRoot(roots, "work");
  assert.ok(workRoot, "应找到 work 根节点");
  assert.equal(workRoot.topic.id, "work");
});

test("27. findTopicRoot 子主题 → 返回最顶层祖先", () => {
  const roots = buildTopicTree(treeChoices);
  const work7Root = findTopicRoot(roots, "work7");
  assert.ok(work7Root, "应找到 work7 的根祖先");
  assert.equal(work7Root.topic.id, "work", "work7 的根祖先应是 work");
  // 三级链同样有效
  const extraRoot = findTopicRoot(roots, "work7-extra");
  assert.equal(extraRoot.topic.id, "work", "三级 work7-extra 的根祖先也应是 work");
});

test("28. findTopicRoot 空 / 不存在 → null", () => {
  const roots = buildTopicTree(treeChoices);
  assert.equal(findTopicRoot(roots, ""), null);
  assert.equal(findTopicRoot(roots, null), null);
  assert.equal(findTopicRoot(roots, undefined), null);
  assert.equal(findTopicRoot(roots, "ghost"), null);
  // 非数组 tree 兜底
  assert.equal(findTopicRoot(null, "work"), null);
  assert.equal(findTopicRoot(undefined, ""), null);
  assert.equal(findTopicRoot("not-array", "x"), null);
});

run();
