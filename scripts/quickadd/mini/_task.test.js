// _task.js sourceLink 拼法的回归单测。`node --test _task.test.js` 跑。
// 任务 README 视角：flow/data/YYYY/Qn/MM/<dir>/
// capture 月度文件：flow/data/YYYY/Qn/ideas-YYYY-MM.md
// 相对路径必须加 `../` 前缀，vault 根不放 capture 月度文件（保持日期为存储主轴单一真源）。
//
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildSourceLink } = require("./_task.js");

test("buildSourceLink 拼 ../ 相对路径", () => {
  assert.equal(
    buildSourceLink("ideas-2026-10", "#^cap-1rt7ua9i"),
    "[[../ideas-2026-10#^cap-1rt7ua9i]]",
  );
});

test("buildSourceLink 无 sourceFile 返空字符串（不是 `[[../]]`）", () => {
  assert.equal(buildSourceLink("", "#^cap-xxx"), "");
  assert.equal(buildSourceLink(null, "#^cap-xxx"), "");
  assert.equal(buildSourceLink(undefined, "#^cap-xxx"), "");
});

test("buildSourceLink 无 sourceAnchor 也保留 `../` 前缀（边界：锚点由 capture 阶段写）", () => {
  assert.equal(
    buildSourceLink("ideas-2026-10", ""),
    "[[../ideas-2026-10]]",
  );
  assert.equal(
    buildSourceLink("ideas-2026-10", undefined),
    "[[../ideas-2026-10]]",
  );
});

test("buildSourceLink 守卫：绝不能产 vault 根 `[[ideas-...]]` 形式（回归保护）", () => {
  // 防止有人后续把 `../` 前缀去掉回到旧 bug 状态。
  const out = buildSourceLink("ideas-2026-10", "#^cap-1rt7ua9i");
  assert.ok(out.startsWith("[[../"), "must start with [[../");
  assert.ok(!out.startsWith("[[ideas-"), "must NOT start with [[ideas-");
});
