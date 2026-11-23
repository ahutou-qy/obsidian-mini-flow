// _defect-ops.js / `mf.js defect` 的裸 node 单测：
//   node --test flow/scripts/mvp/defect-ops.test.js
//
// 验收锁（2026-11-23 一缺陷一文件改造后）：
//   ① 四个子命令在**无 GUI** 下带参跑通，写面只有 `_defect.js` 一份（本文件不重复实现）；
//   ② `path=A` 必须挂当前需求（取任务 frontmatter `req_id` 填 `req_id`）；**req_id 缺失
//      时留空并回 `reqIdMissing:true`，绝不用本地临时号冒充 `work-<n>`**（会撞提交编号闸）；
//   ③ 目录不存在时 create 自动建，不单独提供 init；同日第二条编号顺延；
//   ④ decide 幂等（noop 不是错误）、未知 id → code 3、非法 choice / 缺参 → code 2；
//   ⑤ `mf.js` 的 case 分发真的接上了（`run(["defect", ...])`）。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFsVault } = require("./_fs-vault.js");
const { defectCommand } = require("./_defect-ops.js");
const { run } = require("./mf.js");

const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const defectModule = require(path.join(MINI, "_defect.js"));
const yaml = require(path.join(MINI, "_yaml.js"));
const defect = defectModule.makeDefectApi(yaml);

const DIR = defectModule.DEFECT_DIR;
const TASK_REL = "flow/data/2026/Q4/11/某需求任务/README.md";

function taskReadme({ reqId = "work-5698", domain = "work7" } = {}) {
  const lines = [
    "---",
    "type: task-folder",
    'source: "[[../../ideas-2026-11#^cap-x]]"',
    `domain: ${domain}`,
    "milestones:",
    "  - {date: '2026-11-01', type: create}",
  ];
  // req_id 是 qy 写的（云效 serialNumber 归一）；手建任务没有该字段。
  if (reqId) lines.push(`req_id: ${reqId}`);
  lines.push("---", "", "# 某需求任务", "");
  return lines.join("\n");
}

function makeVault(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-defect-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return { root, vault: createFsVault(root) };
}

const PAYLOAD = {
  title: "调度前置任务无指令时报错",
  module: "调度",
  phenomenon: "取货非目标位阻挡时无指令报错",
  risk: "P1",
  scope: "示例客户单工单台轨道车",
  rootCause: "前置任务判据缺一条空指令分支",
  suggestion: "前置判空 + 单测覆盖边界",
  regression: "构造无指令前置任务，断言不报错且任务可重派",
  path: "A",
  task: TASK_REL.replace(/\.md$/, ""),
};

// `--json -` 读 stdin，单测里改成把 payload 写临时文件再传路径（同一 readJsonSource 两形态）。
function withPayloadFile(payload, fn) {
  const tmp = path.join(os.tmpdir(), `mf-defect-payload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      try {
        fs.unlinkSync(tmp);
      } catch (_e) {
        /* 已删 */
      }
    });
}

async function createWithPayload(vault, root, overrides = {}, now = "2026-11-23") {
  const payload = { ...PAYLOAD, ...overrides };
  return withPayloadFile(payload, (file) =>
    defectCommand(vault, ["create", "--json", file, "--now", now], { vaultRoot: root }));
}

test("create：目录不存在时自动建，产一张单，path=A 带出 req_id，返回双话术", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  const r = await createWithPayload(vault, root);

  assert.equal(r.ok, true);
  assert.equal(r.action, "create");
  assert.equal(r.id, "PD-20261123-01");
  assert.equal(r.file, `${DIR}/PD-20261123-01.md`);
  assert.equal(r.entry.reqId, "work-5698");
  assert.equal(r.entry.task, TASK_REL.replace(/\.md$/, ""));
  assert.equal(r.reqIdMissing, false);

  const written = fs.readFileSync(path.join(root, r.file), "utf8");
  assert.match(written, /^type: defect$/m);
  assert.match(written, /^id: "PD-20261123-01"$/m);
  assert.match(written, /## 一、缺陷现象/);
  assert.match(written, /## 六、附件/);
  assert.match(written, /## 决策记录/);

  assert.ok(r.scripts.full.includes("根因"));
  assert.ok(r.scripts.chat.split("\n").length <= 5);
});

test("create：req_id 缺失时留空 + 回 reqIdMissing，不冒充 work 号", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme({ reqId: "" }) });
  const r = await createWithPayload(vault, root);
  assert.equal(r.entry.reqId, "");
  assert.equal(r.reqIdMissing, true);
  const written = fs.readFileSync(path.join(root, r.file), "utf8");
  assert.match(written, /^req_id: ""$/m);
});

test("create：path=B 不要求 task，话术标明非本次需求触发", async () => {
  const { root, vault } = makeVault({});
  const r = await createWithPayload(vault, root, { path: "B", task: undefined, reqId: "" });
  assert.equal(r.ok, true);
  assert.equal(r.entry.path, "B");
  assert.equal(r.entry.task, "");
  assert.match(r.scripts.full, /非本次需求触发/);
});

test("create：path=A 缺 task → code 2（拿不到需求关联就无从谈「与本次需求强相关」）", async () => {
  const { root, vault } = makeVault({});
  await assert.rejects(
    () => createWithPayload(vault, root, { task: undefined }),
    (e) => e.code === 2 && /path=A 需要/.test(e.message),
  );
});

test("create：缺必填（rootCause / regression）/ 非法 risk / 非法 path → code 2", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  await assert.rejects(
    () => createWithPayload(vault, root, { rootCause: "" }),
    (e) => e.code === 2 && /rootCause/.test(e.message),
  );
  await assert.rejects(
    () => createWithPayload(vault, root, { regression: "" }),
    (e) => e.code === 2 && /regression/.test(e.message),
  );
  await assert.rejects(
    () => createWithPayload(vault, root, { risk: "P4" }),
    (e) => e.code === 2 && /risk 只收/.test(e.message),
  );
  await assert.rejects(
    () => createWithPayload(vault, root, { path: "C" }),
    (e) => e.code === 2 && /path 只收/.test(e.message),
  );
});

test("create：P3 接受（代码健壮性优化档）", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  const r = await createWithPayload(vault, root, { risk: "P3" });
  assert.equal(r.entry.risk, "P3");
});

test("create：同日第二条编号顺延 02", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  const a = await createWithPayload(vault, root);
  const b = await createWithPayload(vault, root);
  assert.equal(a.id, "PD-20261123-01");
  assert.equal(b.id, "PD-20261123-02");
});

test("list：按 status / risk / path / module 过滤，排序与计数正确", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  await createWithPayload(vault, root, { risk: "P1", module: "调度" });
  await createWithPayload(vault, root, { risk: "P3", module: "平台 xxl-job" });
  await createWithPayload(vault, root, { risk: "P1", module: "调度", path: "B", task: undefined });

  const all = await defectCommand(vault, ["list"], { vaultRoot: root });
  assert.equal(all.count, 3);
  assert.equal(all.skipped, 0);
  assert.equal(all.idMismatch, 0);
  // 同日按 id 倒序（新的在前）
  assert.deepEqual(all.entries.map((e) => e.id), [
    "PD-20261123-03", "PD-20261123-02", "PD-20261123-01",
  ]);

  const p1 = await defectCommand(vault, ["list", "--risk", "P1"], { vaultRoot: root });
  assert.equal(p1.count, 2);
  const b = await defectCommand(vault, ["list", "--path", "b"], { vaultRoot: root });
  assert.equal(b.count, 1);
  const mod = await defectCommand(vault, ["list", "--module", "xxl"], { vaultRoot: root });
  assert.equal(mod.count, 1);
  const pending = await defectCommand(vault, ["list", "--status", "待产品决策"], { vaultRoot: root });
  assert.equal(pending.count, 3);
});

test("list：坏文件计入 skipped，id 不一致计入 idMismatch", async () => {
  const { root, vault } = makeVault({
    [`${DIR}/PD-20261123-01.md`]: defect.buildDefectNote({
      ...PAYLOAD, id: "PD-20261123-01", created: "2026-11-23", reproduced: false,
    }),
    [`${DIR}/PD-20261123-02.md`]: "# 手写的、没有 frontmatter\n",
    [`${DIR}/PD-20261123-03.md`]: defect.buildDefectNote({
      ...PAYLOAD, id: "PD-20261123-09", created: "2026-11-23", reproduced: false,
    }),
    [`${DIR}/README.md`]: "# 目录说明\n",
  });
  const r = await defectCommand(vault, ["list"], { vaultRoot: root });
  assert.equal(r.count, 2);
  assert.equal(r.skipped, 2);
  assert.equal(r.idMismatch, 1);
});

test("show：返回六节与决策记录；未知 id → code 3", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  const c = await createWithPayload(vault, root);
  const r = await defectCommand(vault, ["show", "--id", c.id], { vaultRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.file, c.file);
  assert.match(r.sections.rootCause, /前置任务判据/);
  assert.deepEqual(r.decisions, []);
  assert.ok(r.scripts.full.length > 0);

  await assert.rejects(
    () => defectCommand(vault, ["show", "--id", "PD-20261123-99"], { vaultRoot: root }),
    (e) => e.code === 3 && /不存在/.test(e.message),
  );
  await assert.rejects(
    () => defectCommand(vault, ["show", "--id", "not-an-id"], { vaultRoot: root }),
    (e) => e.code === 2,
  );
});

test("decide：回写 status + decided + 决策记录；重复触发 → noop（不是错误）", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  const c = await createWithPayload(vault, root);

  const first = await defectCommand(
    vault,
    ["decide", "--id", c.id, "--choice", "include", "--by", "产品", "--note", "纳入本次", "--now", "2026-11-25"],
    { vaultRoot: root },
  );
  assert.equal(first.changed, true);
  assert.equal(first.status, "本次一并修复");
  assert.equal(first.decided, "2026-11-25");

  const written = fs.readFileSync(path.join(root, c.file), "utf8");
  assert.match(written, /^status: "本次一并修复"$/m);
  assert.match(written, /^decided: "2026-11-25"$/m);
  assert.match(written, /## 决策记录\n\n- 2026-11-25 · 产品 · 本次一并修复 · 纳入本次/);

  const again = await defectCommand(
    vault,
    ["decide", "--id", c.id, "--choice", "include", "--now", "2026-11-25"],
    { vaultRoot: root },
  );
  assert.equal(again.noop, true);
  assert.equal(again.changed, false);

  // list 不传 --status 时返回全部（口径同旧版）；按状态过滤才只收待决策的
  const all = await defectCommand(vault, ["list"], { vaultRoot: root });
  assert.equal(all.count, 1);
  assert.equal(all.entries[0].status, "本次一并修复");
  const pending = await defectCommand(vault, ["list", "--status", "待产品决策"], { vaultRoot: root });
  assert.equal(pending.count, 0);
  const included = await defectCommand(vault, ["list", "--status", "本次一并修复"], { vaultRoot: root });
  assert.equal(included.count, 1);
});

test("decide：未知 id → code 3；非法 choice / 缺参 → code 2", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  const c = await createWithPayload(vault, root);

  await assert.rejects(
    () => defectCommand(vault, ["decide", "--id", "PD-20261123-99", "--choice", "include"], { vaultRoot: root }),
    (e) => e.code === 3,
  );
  await assert.rejects(
    () => defectCommand(vault, ["decide", "--id", c.id, "--choice", "bogus"], { vaultRoot: root }),
    (e) => e.code === 2,
  );
  await assert.rejects(
    () => defectCommand(vault, ["decide", "--choice", "include"], { vaultRoot: root }),
    (e) => e.code === 2,
  );
  await assert.rejects(
    () => defectCommand(vault, ["decide", "--id", c.id], { vaultRoot: root }),
    (e) => e.code === 2,
  );
});

test("mf.js 分发真的接上了 defect 组", async () => {
  const { root, vault } = makeVault({ [TASK_REL]: taskReadme() });
  const list = await run(["defect", "list"], { vaultRoot: root, vault });
  assert.equal(list.ok, true);
  assert.equal(list.action, "list");

  await assert.rejects(
    () => run(["defect", "nope"], { vaultRoot: root, vault }),
    (e) => e.code === 2 && /未知的 defect 子命令/.test(e.message),
  );
});

test("usage 未知子命令仍走 code 2（接线没破坏既有错误面）", async () => {
  const { root, vault } = makeVault({});
  await assert.rejects(
    () => run(["defect"], { vaultRoot: root, vault }),
    (e) => e.code === 2 && /defect <create\|list\|show\|decide>/.test(e.message),
  );
});
