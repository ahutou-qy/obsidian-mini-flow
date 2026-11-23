// agent-capture 的裸 node 单测：node --test flow/scripts/mvp/agent-capture.test.js
//
// fixture vault 用合成 domains（不依赖真实 flow.json 关键词），模板从仓内复制。
// 覆盖：propose 推断与落点、create 产出形状、### 调研 注入、撞名冲突。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFsVault } = require("./_fs-vault.js");
const { propose, create, parseNow, CliError } = require("./agent-capture.js");

// 模板取自真实 vault（flow/templates/task/folder-readme.md）；挂载后该路径是
// 指向共享仓的 junction，仍能直接读——但 vault 根要靠 _vault-root.js 定位，
// 不能靠 __dirname 上溯（挂载后那是共享仓的真实路径）。
const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const { resolveVaultRoot } = require(path.join(MINI, "_vault-root.js"));
const REPO_ROOT = resolveVaultRoot();

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-agent-capture-"));

  // 模板：直接复制仓内真实骨架，保证与 capture 产出一致。
  const tplDir = path.join(root, "flow", "templates", "task");
  fs.mkdirSync(tplDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "flow", "templates", "task", "folder-readme.md"),
    path.join(tplDir, "folder-readme.md"),
  );

  // domains：合成两个域，关键词确定，便于断言推断。
  const domains = {
    growth: { label: "个人", work: false, keywords: ["读书", "学习"] },
    work7: { label: "work7", work: true, keywords: ["work7", "设备"] },
  };
  for (const [slug, wf] of Object.entries(domains)) {
    const dir = path.join(root, "flow", "data", "domains", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify(wf), "utf8");
  }

  // topics：一张主题卡。
  const topicsDir = path.join(root, "flow", "data", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.writeFileSync(
    path.join(topicsDir, "work.md"),
    ["---", "topic_id: work", "label: work", "parent_topic: \"\"", "---", "", "# work", ""].join("\n"),
    "utf8",
  );

  return { root, vault: createFsVault(root) };
}

const NOW = new Date(2026, 10, 9); // 2026-11-09，本地时区

test("parseNow：YYYY-MM-DD 按本地时区解析，非法返回 null", () => {
  const d = parseNow("2026-11-09");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 9);
  assert.equal(parseNow("2026/11/09"), null);
});

test("propose：work 域命中 → 域正确，落点为当月目录", async () => {
  const { vault } = makeVault();
  const r = await propose(vault, { title: "work7 设备报警排查", now: NOW });

  assert.equal(r.domain, "work7");
  assert.equal(r.status, "active");
  assert.equal("isWork" in r, false, "isWork 已下线（domain 派生量，不落 frontmatter）");
  assert.equal("kind" in r, false, "kind 已下线");
  assert.equal(r.monthFolder, "flow/data/2026/Q4/11");
  assert.equal(r.targetFolder, "flow/data/2026/Q4/11/work7设备报警排查");
  assert.equal(r.conflict, null);
  // 2026-11-23 砍 topic：propose 不再返回 topics 字段。
  assert.equal("topics" in r, false, "topics 已下线");
});

test("propose：零命中兜底到 personal 域", async () => {
  const { vault } = makeVault();
  const r = await propose(vault, { title: "随便写点什么", now: NOW });
  assert.equal(r.domain, "growth");
});

test("create：建 folder + 月度 Capture 行 + ### 调研 注入", async () => {
  const { root, vault } = makeVault();
  const research = "需求：让 AI 先问后建任务。\n- 现状：规约禁止。";

  const r = await create(vault, {
    now: NOW,
    payload: { title: "work7 设备报警排查", topic: "work", research },
  });

  assert.equal(r.ok, true);
  assert.equal(r.domain, "work7");
  assert.equal(r.status, "active");
  assert.equal(r.taskPath, "flow/data/2026/Q4/11/work7设备报警排查/README.md");

  // 目录骨架齐全
  for (const sub of ["input", "process", "output"]) {
    assert.ok(fs.existsSync(path.join(root, path.dirname(r.taskPath), sub)), `${sub}/ 应存在`);
  }

  const readme = fs.readFileSync(path.join(root, r.taskPath), "utf8");
  assert.match(readme, /^domain: work7$/m);
  // 2026-11-16 精简：这些派生/零读者字段不再写
  for (const gone of ["kind:", "created:", "code_locs:", "refs:"]) {
    assert.ok(!new RegExp(`^${gone}`, "m").test(readme), `${gone} 不应再出现`);
  }
  assert.ok(!/^tags:/m.test(readme), "tags 段不应再出现");
  // 2026-11-23 砍 topic（阶段一停写）：不再写 topic 字段，正文也不出主题导航行。
  // payload 仍可传 topic（agent-capture.js 的存在性校验留到阶段二一并下线），
  // 但 buildFolderReadme 已忽略该形参。
  assert.ok(!/^topic\s*:/m.test(readme), "topic 字段不应再出现");
  assert.ok(!/> \*\*主题：\*\*/.test(readme), "主题导航行不应再出现");
  // 回归守卫（2026-11-23 发现）：renderTemplate 对**未传的 key 原样保留** {{KEY}}，
  // 所以模板里的占位符必须与 buildFolderReadme 的参数表同步删；漏一个就会把字面
  // `{{XXX}}` 渲进新任务 README。这条断言兜住所有同类漏项。
  assert.ok(!/\{\{\w+\}\}/.test(readme), "渲染后不应残留任何 {{...}} 占位符");
  // 2026-11-22：前缀是两级 `../../`（README 在 Qn/MM/<dir>/，月度文件在 Qn/）
  assert.match(readme, /source: "\[\[\.\.\/\.\.\/ideas-2026-11#\^cap-[a-z0-9]+\]\]"/);

  // 调研内容在该小节内、分析之前
  const iResearch = readme.indexOf("### 调研");
  const iContent = readme.indexOf("需求：让 AI 先问后建任务。");
  const iAnalyze = readme.indexOf("### 分析");
  assert.ok(iResearch >= 0 && iContent > iResearch && iAnalyze > iContent, "调研内容应落在 ### 调研 段内");

  // 两张溯源表自带骨架（CMMI 环节 2，2026-11-19）：登记表在调研段、四列表在设计段
  const iReg = readme.indexOf("| 未决项 | 谁确认 | 结论 | 日期 |");
  assert.ok(iReg > iResearch && iReg < iAnalyze, "未决项登记表应落在 ### 调研 段内");
  const iDesign = readme.indexOf("### 设计");
  const iMap = readme.indexOf("| 需求条目 | 功能点 | 设计位置 | 验证位置 |");
  assert.ok(iMap > iDesign && iMap < readme.indexOf("### 实现"), "四列映射表应落在 ### 设计 段内");

  // 月度 Capture 行（行内不再打 #domain/<域>；月文件头说明里提到该字面不算）
  const month = fs.readFileSync(path.join(root, r.monthFilePath), "utf8");
  assert.match(month, /- \[\[11\/work7设备报警排查\/README\|work7 设备报警排查\]\] #active \^cap-[a-z0-9]+/);
  const capLine = month.split("\n").find((l) => l.startsWith("- [[11/work7设备报警排查/README|"));
  assert.ok(capLine && !capLine.includes("#domain/"), `capture 行不再打 #domain/<域>：${capLine}`);
});

test("create：显式 domain 覆盖推断，status=active 可用", async () => {
  const { root, vault } = makeVault();
  const r = await create(vault, {
    now: NOW,
    payload: { title: "work7 设备协议调研", domain: "growth", status: "active" },
  });
  const readme = fs.readFileSync(path.join(root, r.taskPath), "utf8");
  assert.match(readme, /^domain: growth$/m);
});

test("create：同名任务再建 → CliError(code 3)", async () => {
  const { vault } = makeVault();
  const payload = { title: "work7 设备报警排查" };
  await create(vault, { now: NOW, payload });
  await assert.rejects(
    () => create(vault, { now: NOW, payload }),
    (e) => e instanceof CliError && e.code === 3 && /同名任务目录已存在/.test(e.message),
  );
});

test("create：非法 status 报 CliError(code 3)；topic 已下线不再校验", async () => {
  const { vault } = makeVault();
  await assert.rejects(
    () => create(vault, { now: NOW, payload: { title: "x", status: "finish" } }),
    (e) => e instanceof CliError && e.code === 3 && /status 非法/.test(e.message),
  );
  // 2026-11-23 砍 topic：payload.topic 不再校验、不落 frontmatter——传非法值也被忽略。
  const r = await create(vault, { now: NOW, payload: { title: "topic 已下线验证", topic: "不存在" } });
  assert.equal(r.ok, true);
  assert.equal("topic" in r, false, "返回值不再带 topic");
});
