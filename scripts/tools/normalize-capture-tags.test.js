// normalize-capture-tags 的裸 node 单测（node --test scripts/tools/normalize-capture-tags.test.js）
//
// 覆盖批量归一最容易出错的四处：映射对不对、留底行算不算 Capture 行、
// 段外/散文行会不会被误伤、CRLF 会不会被改掉，以及幂等。
const test = require("node:test");
const assert = require("node:assert");

const {
  isCaptureRow,
  rawStatusOf,
  needsNormalize,
  normalizeRow,
  transformContent,
} = require("./normalize-capture-tags.js");

test("行判据：行首 '- ' 且带 cap- 锚点才算 Capture 行", () => {
  assert.ok(isCaptureRow("- [[a/README|x]] #active ^cap-abc"));
  // 留底行：链接已降级为纯文本，仍算 Capture 行（锚点还在）
  assert.ok(isCaptureRow("- 标题 #next ^cap-abc"));
  // 没有锚点的散文行不算
  assert.ok(!isCaptureRow("- 只是一条笔记 #next"));
  // 不是行首 '- ' 的不算
  assert.ok(!isCaptureRow("> - [[a/README|x]] #next ^cap-abc"));
});

test("状态标签识别：只认状态字典的整词", () => {
  assert.equal(rawStatusOf("- x #active ^cap-a"), "active");
  assert.equal(rawStatusOf("- x #next ^cap-a"), "next");
  assert.equal(rawStatusOf("- x #archive ^cap-a"), "archive");
  assert.equal(rawStatusOf("- x ^cap-a"), "");
  // 标题里的 C# 不该被当状态
  assert.equal(rawStatusOf("- C# 笔记 #active ^cap-a"), "active");
});

test("归一映射：now/next/dev_done → active，archive → finish", () => {
  assert.equal(needsNormalize("- x #next ^cap-a"), true);
  assert.equal(needsNormalize("- x #active ^cap-a"), false);
  assert.ok(normalizeRow("- [[a/README|x]] #next ^cap-a").includes("#active"));
  assert.ok(normalizeRow("- [[a/README|x]] #now ^cap-a").includes("#active"));
  assert.ok(normalizeRow("- [[a/README|x]] #dev_done ^cap-a").includes("#active"));
  assert.ok(normalizeRow("- [[a/README|x]] #archive ^cap-a").includes("#finish"));
});

test("归一不伪造完成日期：旧档行自带 completion 的原样保留，没有的不补", () => {
  const withComp = normalizeRow("- [[a/README|x]] #archive [completion:: 2026-08-19] ^cap-a");
  assert.ok(withComp.includes("[completion:: 2026-08-19]"));
  assert.ok(!withComp.includes("2026-11-23"));
  const without = normalizeRow("- [[a/README|x]] #archive ^cap-a");
  assert.ok(!/\[completion::/.test(without));
});

test("checkbox 与状态一致：active → [ ]，finish → [x]", () => {
  assert.ok(normalizeRow("- [ ] [[a/README|x]] #now ^cap-a").startsWith("- [ ] "));
  assert.ok(normalizeRow("- [x] [[a/README|x]] #archive ^cap-a").startsWith("- [x] "));
});

test("段外与散文行不动；段内 Capture 行与留底行都归一", () => {
  const text = [
    "## Capture",
    "- [[a/README|x]] #domain/foo #next ^cap-a",   // 段内 Capture 行 → 归一
    "- 留底行 #now ^cap-b",                            // 段内留底行 → 也归一
    "- 只是一条笔记 #next",                            // 段内散文行 → 不动
    "",
    "## 已升级",
    "- [[b/README|y]] #next ^cap-c",                   // 段外 → 不动
    "",
  ].join("\n");
  const { lines, stats } = transformContent(text);
  assert.equal(stats.rows, 2);
  assert.equal(stats.history, 2);
  assert.equal(stats.changed, 2);
  assert.ok(lines[1].includes("#active"));
  assert.ok(lines[2].includes("#active"));
  assert.equal(lines[3], "- 只是一条笔记 #next"); // 散文行原样
  assert.equal(lines[6], "- [[b/README|y]] #next ^cap-c"); // 段外原样
});

test("CRLF 原样保留", () => {
  const text = "## Capture\r\n- [[a/README|x]] #next ^cap-a\r\n";
  const { lines, nl } = transformContent(text);
  assert.equal(nl, "\r\n");
  assert.ok(lines[1].includes("#active"));
  assert.equal(lines.join("\r\n"), "## Capture\r\n- [[a/README|x]] #active ^cap-a\r\n");
});

test("幂等：归一后再跑一次 0 改动", () => {
  const text = "## Capture\n- [[a/README|x]] #next ^cap-a\n- [[b/README|y]] #archive [completion:: 2026-08-19] ^cap-b\n";
  const first = transformContent(text);
  assert.equal(first.stats.changed, 2);
  const second = transformContent(first.lines.join("\n"));
  assert.equal(second.stats.history, 0);
  assert.equal(second.stats.changed, 0);
});
