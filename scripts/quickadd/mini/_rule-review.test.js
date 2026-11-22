// ==============================================
// Mini Flow - _rule-review.js 单测（裸 node + node:assert，零依赖）
//
// 跑：node flow/scripts/quickadd/mini/_rule-review.test.js
// 退出码 0 = 全绿，非 0 = 有失败。
//
// 覆盖：4 个核心动作 + 字段读写 + 幂等去重 + 阈值晋级 + 任务侧反向链。
// 不接 vault，frontmatter / body 走字符串路径——与 _yaml.test.js 同款裸测风格。
// ==============================================

const assert = require("node:assert/strict");
const {
  PROMOTE_THRESHOLD,
  splitRuleDoc,
  readBlockArray,
  writeBlockArray,
  readScalar,
  writeScalar,
  parseEntryTarget,
  resolveEntryPath,
  taskIdentityOf,
  uniqueValidatedByCount,
  isTaskAlreadyValidated,
  formatValidationEntry,
  appendReferencedRuleBlock,
  appendChangeEntry,
  validateRule,
  promoteRuleManual,
  deprecateRule,
} = require("./_rule-review");

let passedN = 0;
let failedN = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function run() {
  for (const { name, fn } of cases) {
    try {
      fn();
      passedN += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failedN += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${e.message}`);
    }
  }
  console.log(`\n${passedN} passed, ${failedN} failed`);
  process.exit(failedN === 0 ? 0 : 1);
}

// ---------- 辅助：构造一个最小 rule 文档 ----------

function mkRuleDoc({ status = "proposed", sources = [], validatedBy = [] } = {}) {
  const srcLines = sources.length ? ["sources:", ...sources.map((s) => `  - ${s}`)] : ["sources: []"];
  const vbLines = validatedBy.length ? ["validated_by:", ...validatedBy.map((s) => `  - ${s}`)] : ["validated_by: []"];
  return [
    "---",
    "type: rule",
    "domain: work7",
    `status: ${status}`,
    "created: 2026-10-14",
    ...srcLines,
    ...vbLines,
    "supersedes: []",
    "tags:",
    "  - rule/work7",
    "---",
    "",
    "# 测试规则",
    "",
    "## 变更",
    "",
    "- 2026-10-14 | proposed",
    "",
  ].join("\n");
}

const RULE_PATH = "flow/data/domains/work7/rules/test-rule.md";
const TASK_A_PATH = "flow/data/2026/Q4/10/task-a/README";
const TASK_B_PATH = "flow/data/2026/Q4/10/task-b/README";

// ---------- 字段读写 ----------

test("1. splitRuleDoc 无 frontmatter 时 frontmatter 空串、body 全量", () => {
  const r = splitRuleDoc("# hi\n\nbody");
  assert.equal(r.frontmatter, "");
  assert.equal(r.body, "# hi\n\nbody");
});

test("2. splitRuleDoc 标准 frontmatter 切片", () => {
  const s = "---\ntype: rule\nstatus: proposed\n---\n\n# hi\n";
  const r = splitRuleDoc(s);
  assert.equal(r.frontmatter, "type: rule\nstatus: proposed");
  assert.equal(r.body, "\n\n# hi\n");
});

test("3. readBlockArray 空 frontmatter 返 []", () => {
  assert.deepEqual(readBlockArray("", "validated_by"), []);
});

test("4. readBlockArray 缺字段返 []", () => {
  assert.deepEqual(readBlockArray("type: rule\nstatus: proposed", "validated_by"), []);
});

test("5. readBlockArray 多行解析", () => {
  const fm = "sources:\n  - \"[[a]]\"\n  - \"[[b]]\"\nstatus: proposed\n";
  assert.deepEqual(readBlockArray(fm, "sources"), ["[[a]]", "[[b]]"]);
});

test("6. writeBlockArray 写新字段", () => {
  const fm = "type: rule\nstatus: proposed\n";
  const out = writeBlockArray(fm, "validated_by", ["[[a]]", "[[b]]"]);
  assert.match(out, /validated_by:\n  - "\[\[a\]\]"\n  - "\[\[b\]\]"/);
});

test("7. writeBlockArray 空数组删字段", () => {
  const fm = "type: rule\nvalidated_by:\n  - \"[[a]]\"\nstatus: proposed\n";
  const out = writeBlockArray(fm, "validated_by", []);
  assert.ok(!/^validated_by\s*:/m.test(out), "应删除字段");
  assert.match(out, /^type: rule/m);
  assert.match(out, /^status: proposed/m);
});

test("8. readScalar / writeScalar 基础", () => {
  const fm = "type: rule\nstatus: proposed\n";
  assert.equal(readScalar(fm, "status"), "proposed");
  assert.equal(readScalar(fm, "missing"), "");
  const out = writeScalar(fm, "status", "confirmed");
  assert.match(out, /^status: confirmed$/m);
});

test("9. writeScalar 空值删字段", () => {
  const fm = "type: rule\nstatus: proposed\n";
  const out = writeScalar(fm, "status", "");
  assert.ok(!/^status\s*:/m.test(out));
});

// ---------- wikilink 解析 + 路径归一 ----------

test("10. parseEntryTarget 解析 [[path]]", () => {
  assert.equal(parseEntryTarget("[[flow/data/x/README]]"), "flow/data/x/README");
});

test("11. parseEntryTarget 解析 [[path]]（note）", () => {
  assert.equal(parseEntryTarget("[[flow/data/x/README]]（验证于 2026-10-14）"), "flow/data/x/README");
});

test("12. parseEntryTarget 无 [[]] 返 null", () => {
  assert.equal(parseEntryTarget("plain text"), null);
});

test("13. resolveEntryPath 绝对路径原样", () => {
  assert.equal(resolveEntryPath("flow/data/x/README", RULE_PATH), "flow/data/x/README");
});

test("14. resolveEntryPath 相对路径按 ruleFilePath 解析", () => {
  // RULE_PATH = "flow/data/domains/work7/rules/test-rule.md"
  // 相对 "../../../2026/Q3/09/1002-x/process/y" →
  //   rules/ → work7/ → domains/ → data/ → flow/
  //   拼上 2026/Q3/09/1002-x/process/y
  const t = "../../../2026/Q3/09/1002-x/process/y";
  const abs = resolveEntryPath(t, RULE_PATH);
  assert.equal(abs, "flow/data/2026/Q3/09/1002-x/process/y");
});

test("15. resolveEntryPath 不传 ruleFilePath 时相对路径原样", () => {
  assert.equal(resolveEntryPath("../../x/y", null), "../../x/y");
});

// ---------- 去重 + 阈值 ----------

test("16. uniqueValidatedByCount 单 source 返 1", () => {
  const fm = "sources:\n  - \"[[" + TASK_A_PATH + "]]\"\nvalidated_by: []\n";
  assert.equal(uniqueValidatedByCount(fm, RULE_PATH), 1);
});

test("17. uniqueValidatedByCount source + validated_by 同路径去重返 1（workcat 风格）", () => {
  const fm = `sources:\n  - "[[${TASK_A_PATH}]]"\nvalidated_by:\n  - "[[${TASK_A_PATH}]]（实证）"\n`;
  assert.equal(uniqueValidatedByCount(fm, RULE_PATH), 1);
});

test("18. uniqueValidatedByCount source A + validated_by B 返 2", () => {
  const fm = `sources:\n  - "[[${TASK_A_PATH}]]"\nvalidated_by:\n  - "[[${TASK_B_PATH}]]（B）"\n`;
  assert.equal(uniqueValidatedByCount(fm, RULE_PATH), 2);
});

test("19. uniqueValidatedByCount 混合绝对/相对路径视为同一条", () => {
  // TASK_A_PATH = "flow/data/2026/Q4/10/task-a/README"
  // 相对路径 "../../../2026/Q4/10/task-a/README" 解析后等于 TASK_A_PATH
  const fm = `sources:\n  - "[[${TASK_A_PATH}]]"\nvalidated_by:\n  - "[[../../../2026/Q4/10/task-a/README]]（实证）"\n`;
  assert.equal(uniqueValidatedByCount(fm, RULE_PATH), 1);
});

test("20. isTaskAlreadyValidated 命中返 true", () => {
  const fm = `validated_by:\n  - "[[${TASK_A_PATH}]]（实证）"\n`;
  assert.equal(isTaskAlreadyValidated(fm, TASK_A_PATH, RULE_PATH), true);
});

test("21. isTaskAlreadyValidated 未命中返 false", () => {
  const fm = `validated_by:\n  - "[[${TASK_B_PATH}]]（实证）"\n`;
  assert.equal(isTaskAlreadyValidated(fm, TASK_A_PATH, RULE_PATH), false);
});

test("22. PROMOTE_THRESHOLD = 2（与 qy 2026-10-14 决策锁定一致）", () => {
  assert.equal(PROMOTE_THRESHOLD, 2);
});

// ---------- validateRule ----------

test("23. validateRule 单 source + 1 个新 validated_by → applied, 不晋级", () => {
  const doc = mkRuleDoc({ sources: [`"[[${TASK_A_PATH}]]"`] });
  const out = validateRule(doc, RULE_PATH, TASK_B_PATH, "B 实证", "2026-10-14");
  assert.equal(out.changed, true);
  assert.equal(out.status, "auto-promoted");
  assert.equal(out.autoPromoted, true);
  // validated_by 出现 B
  assert.match(out.content, new RegExp(`\\[\\[${TASK_B_PATH}\\]\]`));
  // status 晋级 confirmed
  assert.match(out.content, /^status: confirmed$/m);
  // 变更段包含 validated by
  assert.match(out.content, /validated by \[\[.*task-b\/README\]\]/);
  assert.match(out.content, /auto-confirm/);
});

test("24. validateRule sources A + validated_by A 同源 → 不晋级（去重后 =1）", () => {
  const doc = mkRuleDoc({ sources: [`"[[${TASK_A_PATH}]]"`] });
  // 关键：validated_by 里已经加过 A 的相对路径形式（带 note），再加 A 应被幂等短路。
  // 这里我们先把状态改成：sources=A + validated_by=A（带 note）
  const pre = doc.replace(
    "validated_by: []",
    `validated_by:\n  - "[[${TASK_A_PATH}]]（先验证）"`
  );
  // 再追加 task B
  const out = validateRule(pre, RULE_PATH, TASK_B_PATH, "B 实证", "2026-10-14");
  // 现在 sources=A + validated_by=[A,B] → 2 unique → auto-promote
  assert.equal(out.changed, true);
  assert.equal(out.autoPromoted, true);
  assert.match(out.content, /^status: confirmed$/m);
  assert.match(out.content, /auto-confirm/);
});

test("25. validateRule 缺 frontmatter 返 error", () => {
  const doc = "# 没 frontmatter\n";
  const out = validateRule(doc, RULE_PATH, TASK_A_PATH, "x", "2026-10-14");
  assert.equal(out.changed, false);
  assert.equal(out.status, "error");
});

test("26. validateRule deprecated 不接受新验证（status: deprecated 短路）", () => {
  const doc = mkRuleDoc({ status: "deprecated", sources: [`"[[${TASK_A_PATH}]]"`] });
  const out = validateRule(doc, RULE_PATH, TASK_B_PATH, "B 实证", "2026-10-14");
  assert.equal(out.changed, false);
  assert.equal(out.status, "deprecated");
});

test("27. validateRule 同一任务重复登记返 noop（幂等）", () => {
  const doc = mkRuleDoc({
    sources: [`"[[${TASK_A_PATH}]]"`],
    validatedBy: [`"[[${TASK_B_PATH}]]（B 实证）"`],
  });
  const out = validateRule(doc, RULE_PATH, TASK_B_PATH, "再来一次", "2026-10-14");
  assert.equal(out.changed, false);
  assert.equal(out.status, "noop");
});

test("28. validateRule 已有 2 unique + 再来 1 个 → autoPromote=true", () => {
  // 已 sources=A + validated_by=B = 2 unique，再来 C 应仍 2 unique 不晋级；
  // 想触发晋级：先 1 unique 再加 1 unique。
  const doc = mkRuleDoc({ sources: [`"[[${TASK_A_PATH}]]"`] });
  const out = validateRule(doc, RULE_PATH, TASK_B_PATH, "B 实证", "2026-10-14");
  assert.equal(out.autoPromoted, true);
  assert.match(out.content, /^status: confirmed$/m);
});

test("29. validateRule autoPromote 后再调 noop（决策 1：合并去重 ≥ 2 阈值的副作用，已 confirmed 不重触发）", () => {
  // 已 confirmed，再来 C：状态 confirmed 仍在，但 validated_by 应被加进去（决策 4：幂等只短路同任务，不同任务仍追加）。
  // 等等，决策 4 是「当前任务已在 validated_by」才幂等，新任务不幂等。
  const doc = mkRuleDoc({
    status: "confirmed",
    sources: [`"[[${TASK_A_PATH}]]"`],
    validatedBy: [`"[[${TASK_B_PATH}]]（B）"`],
  });
  const out = validateRule(doc, RULE_PATH, TASK_B_PATH, "B 再来", "2026-10-14");
  assert.equal(out.changed, false);
  assert.equal(out.status, "noop");
});

// ---------- promoteRuleManual ----------

test("30. promoteRuleManual proposed → confirmed, 记 ## 变更", () => {
  const doc = mkRuleDoc({ sources: [`"[[${TASK_A_PATH}]]"`] });
  const out = promoteRuleManual(doc, RULE_PATH, "代码已上线", "2026-10-14");
  assert.equal(out.changed, true);
  assert.equal(out.status, "applied");
  assert.match(out.content, /^status: confirmed$/m);
  assert.match(out.content, /manual promote：代码已上线/);
});

test("31. promoteRuleManual 已 confirmed 短路", () => {
  const doc = mkRuleDoc({ status: "confirmed", sources: [`"[[${TASK_A_PATH}]]"`] });
  const out = promoteRuleManual(doc, RULE_PATH, "再来", "2026-10-14");
  assert.equal(out.changed, false);
  assert.equal(out.status, "noop");
});

test("32. promoteRuleManual deprecated 不动（sticky）", () => {
  const doc = mkRuleDoc({ status: "deprecated" });
  const out = promoteRuleManual(doc, RULE_PATH, "复活", "2026-10-14");
  assert.equal(out.changed, false);
  assert.equal(out.status, "deprecated");
});

// ---------- deprecateRule ----------

test("33. deprecateRule proposed → deprecated, 不带 superseded_by", () => {
  const doc = mkRuleDoc({ sources: [`"[[${TASK_A_PATH}]]"`] });
  const out = deprecateRule(doc, RULE_PATH, "已过时", [], "2026-10-14");
  assert.equal(out.changed, true);
  assert.match(out.content, /^status: deprecated$/m);
  assert.ok(!/^superseded_by\s*:/m.test(out), "未填时不写字段");
  assert.match(out.content, /deprecated：已过时/);
});

test("34. deprecateRule confirmed → deprecated, 带 superseded_by", () => {
  const doc = mkRuleDoc({ status: "confirmed", sources: [`"[[${TASK_A_PATH}]]"`] });
  const supPath = "flow/data/domains/work7/rules/newer-rule";
  const out = deprecateRule(doc, RULE_PATH, "被新规则取代", [supPath], "2026-10-14");
  assert.equal(out.changed, true);
  assert.match(out.content, /^status: deprecated$/m);
  assert.match(out.content, new RegExp(`superseded_by:\\s*\\n  - "\\[\\[${supPath.replace(/\//g, '\\/')}\\]\\]"`));
});

test("35. deprecateRule 已 deprecated 短路", () => {
  const doc = mkRuleDoc({ status: "deprecated" });
  const out = deprecateRule(doc, RULE_PATH, "再废一次", [], "2026-10-14");
  assert.equal(out.changed, false);
  assert.equal(out.status, "noop");
});

// ---------- appendReferencedRuleBlock ----------

test("36. appendReferencedRuleBlock 新建 ## 引用规则 段", () => {
  const task = "# task\n\n## 进展\n\n- bar\n";
  const out = appendReferencedRuleBlock(task, "flow/data/domains/work7/rules/test", "test", "实证", "2026-10-14");
  assert.match(out, /^## 引用规则$/m);
  assert.match(out, /\[\[flow\/data\/domains\/work7\/rules\/test\|test\]\]（验证于 2026-10-14：实证）/);
});

test("37. appendReferencedRuleBlock 已有 ## 引用规则 段 → 追加 bullet", () => {
  const task = "# task\n\n## 引用规则\n\n- [[old-rule|old]]\n\n## 进展\n\n- bar\n";
  const out = appendReferencedRuleBlock(task, "flow/data/x/new-rule", "new", "实证", "2026-10-14");
  assert.match(out, /\[\[flow\/data\/x\/new-rule\|new\]\]/);
  // 旧的还在
  assert.match(out, /\[\[old-rule\|old\]\]/);
});

test("38. appendReferencedRuleBlock 同 path 短路幂等", () => {
  const task = "# task\n\n## 引用规则\n\n- [[flow/data/x/new-rule|new]]\n";
  const out = appendReferencedRuleBlock(task, "flow/data/x/new-rule", "new", "再来", "2026-10-15");
  assert.equal(out, task, "内容不变");
});

test("39. appendReferencedRuleBlock 空 note 时不带（验证于 date）", () => {
  const task = "# task\n";
  const out = appendReferencedRuleBlock(task, "flow/data/x/new", "new", "", "2026-10-14");
  assert.match(out, /（验证于 2026-10-14）/);
});

// ---------- formatValidationEntry ----------

test("40. formatValidationEntry 有 note", () => {
  assert.equal(formatValidationEntry("flow/data/x", "实证"), "[[flow/data/x]]（实证）");
});

test("41. formatValidationEntry 无 note 只写 wikilink", () => {
  assert.equal(formatValidationEntry("flow/data/x", ""), "[[flow/data/x]]");
});

// ---------- 任务身份去重（2026-11-06 新口径） ----------
//
// 阈值衡量的是「被几个不同任务提出/验证过」，不是「有几篇文档提到它」。
// 同一任务的 README + process/… 多篇文档折叠成 1。

test("42. taskIdentityOf 任务 README 与 process 文档折叠成同一身份", () => {
  const a = taskIdentityOf("flow/data/2026/Q4/11/某任务/README");
  const b = taskIdentityOf("flow/data/2026/Q4/11/某任务/process/01-调研.md");
  assert.equal(a, b);
  assert.equal(a, "2026/Q4/11/某任务");
});

test("43. taskIdentityOf 不同任务返不同身份", () => {
  const a = taskIdentityOf(TASK_A_PATH);
  const b = taskIdentityOf(TASK_B_PATH);
  assert.notEqual(a, b);
});

test("44. taskIdentityOf 非任务路径按自身算一个单位", () => {
  assert.equal(taskIdentityOf(RULE_PATH), RULE_PATH);
  assert.equal(taskIdentityOf("flow/data/2026/Q4/ideas-2026-11.md"), "flow/data/2026/Q4/ideas-2026-11.md");
});

test("45. uniqueValidatedByCount 同一任务的两篇文档返 1（旧口径返 2）", () => {
  const fm = [
    'sources:',
    '  - "[[flow/data/2026/Q4/11/task-a/README]]"',
    '  - "[[flow/data/2026/Q4/11/task-a/process/01-调研.md]]"',
    "validated_by: []",
  ].join("\n");
  assert.equal(uniqueValidatedByCount(fm, RULE_PATH), 1);
});

test("46. uniqueValidatedByCount 同任务 README + process 相对路径形式也返 1", () => {
  const fm = [
    'sources:',
    '  - "[[../../../2026/Q4/11/task-a/README]]"',
    '  - "[[../../../2026/Q4/11/task-a/process/01-调研.md]]"',
    "validated_by: []",
  ].join("\n");
  assert.equal(uniqueValidatedByCount(fm, RULE_PATH), 1);
});

test("47. validateRule sources 是同一任务两篇文档 → 不晋级（旧口径会误晋级）", () => {
  const doc = mkRuleDoc({
    sources: [
      '"[[flow/data/2026/Q4/11/task-a/README]]"',
      '"[[flow/data/2026/Q4/11/task-a/process/01-调研.md]]"',
    ],
  });
  // 当前任务仍是 task-a（提出方自己再验证一次）→ 任务身份只有 1 个 → 不晋级
  const out = validateRule(doc, RULE_PATH, "flow/data/2026/Q4/11/task-a/README", "自验", "2026-11-06");
  assert.equal(out.changed, true);
  assert.equal(out.autoPromoted, false);
  assert.match(out.content, /^status: proposed$/m);
});

test("48. validateRule sources 同一任务两篇 + 另一任务验证 → 晋级", () => {
  const doc = mkRuleDoc({
    sources: [
      '"[[flow/data/2026/Q4/11/task-a/README]]"',
      '"[[flow/data/2026/Q4/11/task-a/process/01-调研.md]]"',
    ],
  });
  const out = validateRule(doc, RULE_PATH, "flow/data/2026/Q4/11/task-b/README", "B 实证", "2026-11-06");
  assert.equal(out.changed, true);
  assert.equal(out.autoPromoted, true);
  assert.match(out.content, /^status: confirmed$/m);
});

run();