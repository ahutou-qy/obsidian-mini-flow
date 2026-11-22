// ==============================================
// Mini Flow - progress-checkin.js 单测（裸 node + node:assert，零依赖）
//
// 跑：node flow/scripts/quickadd/mini/progress-checkin.test.js
// ==============================================

const assert = require("node:assert/strict");
const { ensureProgressSection, countProgressBullets } = require("./progress-checkin").__test;

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
      console.log(`       ${error.stack || error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

test("有 ## 进展：追加到段末，不越界到下个 ##", () => {
  const src = [
    "# 标题",
    "",
    "## 进展",
    "",
    "> 人写的过程叙事，按 `- 日期 | 事` 追加。",
    "",
    "- 2026-08-18 | 旧条目",
    "",
    "## 内化",
    "",
    "### 调研",
    "内容",
  ].join("\n");
  const { content } = ensureProgressSection(src, "2026-08-21", "新进展");
  const lines = content.split("\n");
  const progressIdx = lines.findIndex((l) => l === "## 进展");
  const internalizeIdx = lines.findIndex((l) => l === "## 内化");
  const slice = lines.slice(progressIdx, internalizeIdx).join("\n");
  assert.ok(slice.includes("- 2026-08-18 | 旧条目"));
  assert.ok(slice.includes("- 2026-08-21 | 新进展"));
  // 新条目应在 旧条目 之后、## 内化 之前
  assert.ok(slice.indexOf("旧条目") < slice.indexOf("新进展"));
  // 不重复插提示 blockquote
  assert.equal((content.match(/^> 人写的过程叙事/gm) || []).length, 1);
});

test("无 ## 进展但有 ## 输入：段插在 ## 输入 之前，带提示", () => {
  const src = [
    "# 标题",
    "来源：x",
    "",
    "## 输入",
    "原始资料",
  ].join("\n");
  const { content, appendedLine } = ensureProgressSection(src, "2026-08-21", "开干");
  const progressIdx = content.indexOf("## 进展");
  const inputIdx = content.indexOf("## 输入");
  assert.ok(progressIdx >= 0 && progressIdx < inputIdx);
  assert.ok(content.includes("> 人写的过程叙事"));
  assert.ok(content.includes("- 2026-08-21 | 开干"));
  assert.equal(content.split("## 进展").length - 1, 1);
  assert.ok(appendedLine >= 0);
  assert.equal(content.split("\n")[appendedLine], "- 2026-08-21 | 开干");
});

test("无任何 ## 段：追加到文末", () => {
  const src = "# 只有标题\n\n一些散文字。";
  const { content } = ensureProgressSection(src, "2026-08-21", "文末进展");
  assert.ok(content.indexOf("## 进展") > content.indexOf("一些散文字"));
  assert.ok(content.endsWith("\n\n") || content.trimEnd().endsWith("- 2026-08-21 | 文末进展"));
});

test("幂等：连续两次追加得到两条 bullet、仍只有一个段头", () => {
  let { content } = ensureProgressSection("# t\n\n## 输入\nx", "2026-08-21", "第一次");
  content = ensureProgressSection(content, "2026-08-21", "第二次").content;
  assert.equal(content.split("## 进展").length - 1, 1);
  assert.ok(content.includes("第一次"));
  assert.ok(content.includes("第二次"));
});

test("countProgressBullets：带空格的模型名（· Opus 5）也计入（与 task-finish 同款正则）", () => {
  const src = [
    "## 进展",
    "",
    "- 2026-10-12 · Opus 5 | a",
    "- 2026-10-11 | b",
    "- 2026-10-10 · Sonnet 5.5 | c",
    "- 2026-10-09 | d",
    "- 2026-10-08 | e",
    "- 2026-10-07 · Opus 5 | f",
    "",
    "## 输入",
  ].join("\n");
  assert.equal(countProgressBullets(src), 6);
});

run();
