// ==============================================
// Mini Flow - _infer.js 单测（裸 node + node:assert,零依赖）
//
// 跑：node flow/scripts/quickadd/mini/_infer.test.js
// 退出码 0 = 全绿,非 0 = 有失败。
//
// 覆盖：inferDomain 兜底 / work 优先 / 返回结构含 keywords。
// 2026-09-14 取消 topic 自动召回（task-capture.js 改为手动选 chip），
// inferTopics / topicNameHit 删除，对应 12 case 一并下架。
// ==============================================

const assert = require("node:assert/strict");
const { inferDomain } = require("./_infer");

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

test("1. inferDomain v1 行为不变（兜底 / work 优先）", () => {
  const choices = [
    { slug: "growth", label: "个人", work: false, domain: "growth", keywords: ["健身", "饮食"] },
    { slug: "work7", label: "WORK7", work: true, domain: "work7", keywords: ["work7", "rfid"] },
    { slug: "work10", label: "WORK10", work: true, domain: "work10", keywords: ["work10", "plu"] },
  ];
  // work 命中:work7(1 hit)
  assert.equal(inferDomain("work7 调度文档", choices).slug, "work7");
  // personal 命中
  assert.equal(inferDomain("健身计划", choices).slug, "growth");
  // 零命中兜底到 growth（排序后第一个 work=false）
  assert.equal(inferDomain("随便写点啥", choices).slug, "growth");
});

test("2. inferDomain 返回含 keywords 字段（其它消费方可读）", () => {
  const choices = [
    { slug: "growth", label: "个人", work: false, domain: "growth", keywords: ["健身"] },
    { slug: "work7", label: "WORK7", work: true, domain: "work7", keywords: ["work7", "rfid"] },
  ];
  const result = inferDomain("work7 调度", choices);
  assert.ok(Array.isArray(result.keywords));
  assert.ok(result.keywords.length > 0);
  assert.ok(result.keywords.includes("work7"));
});

run();
