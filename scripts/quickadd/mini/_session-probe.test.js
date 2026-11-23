// _session-probe.js 的回归单测。`node --test _session-probe.test.js` 跑。
//
// 钉的是四类容易静默失效的点：
//   1. 注册表解析：坏 json / 缺字段 / 未知 status 一律跳过（**不抛**）——注册表是未公开
//      的运行时格式，漂了只能少出徽标，不能让 Home 卡报错。
//   2. 文件筛选：`.key`（会话间认证令牌）与 `.fleetview-heartbeat` 这类非 `.json`
//      文件绝不能被读进来。
//   3. 路径归一与匹配：反斜杠 / 尾分隔符 / 大小写；命中含子目录（process/、output/）。
//   4. 死 pid 残留：崩溃或强杀会留下 json，读侧必须按 isAlive 过滤掉。
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  STATUSES,
  STATUS_ICONS,
  STATUS_LABELS,
  STATUS_DISPLAY,
  sessionDir,
  parseSession,
  parseSessions,
  pathKey,
  underTask,
  pickStatus,
  matchSessions,
} = require("./_session-probe.js");

// ---------- sessionDir ----------

test("sessionDir：CLAUDE_CONFIG_DIR 优先", () => {
  assert.equal(
    sessionDir({ CLAUDE_CONFIG_DIR: "D:/cfg" }, "C:/Users/qy"),
    "D:/cfg/sessions",
  );
});

test("sessionDir：缺省走 ~/.claude/sessions", () => {
  assert.equal(sessionDir({}, "C:\\Users\\qy"), "C:\\Users\\qy/.claude/sessions");
});

test("sessionDir：空串配置视同没配（不拼出 //sessions）", () => {
  assert.equal(sessionDir({ CLAUDE_CONFIG_DIR: "   " }, "/home/qy"), "/home/qy/.claude/sessions");
});

test("sessionDir：没有 home 目录 → null（调用方按无源处理）", () => {
  assert.equal(sessionDir({}, ""), null);
  assert.equal(sessionDir({}, null), null);
});

// ---------- parseSession ----------

test("parseSession：正常会话取字段", () => {
  const s = parseSession(JSON.stringify({
    pid: 26408,
    sessionId: "abc",
    cwd: "E:\\vault\\flow\\data\\2026\\Q4\\11\\任务",
    name: "任务",
    status: "busy",
    startedAt: 1795418075413,
    updatedAt: 1795418077452,
  }));
  assert.equal(s.pid, 26408);
  assert.equal(s.cwd, "E:\\vault\\flow\\data\\2026\\Q4\\11\\任务");
  assert.equal(s.status, "busy");
  assert.equal(s.name, "任务");
});

test("parseSession：坏 json → null（不抛）", () => {
  assert.equal(parseSession("{not json"), null);
  assert.equal(parseSession(""), null);
});

test("parseSession：缺 pid / 缺 cwd / status 不在四档 → null", () => {
  assert.equal(parseSession(JSON.stringify({ cwd: "/x", status: "busy" })), null);
  assert.equal(parseSession(JSON.stringify({ pid: 1, status: "busy" })), null);
  assert.equal(parseSession(JSON.stringify({ pid: 1, cwd: "/x", status: "zombie" })), null);
  assert.equal(parseSession(JSON.stringify({ pid: 1, cwd: "/x" })), null);
});

// ---------- parseSessions ----------

test("parseSessions：只收 .json，跳过 .key / 点文件 / 坏文件", () => {
  const sessions = parseSessions([
    { name: "26408.json", text: JSON.stringify({ pid: 1, cwd: "/x", status: "idle" }) },
    { name: "26408.abc.key", text: "SECRET-TOKEN" },
    { name: ".fleetview-heartbeat", text: "{}" },
    { name: "39796.json", text: "{broken" },
    { name: "39968.json", text: JSON.stringify({ pid: 2, cwd: "/y", status: "waiting" }) },
  ]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.pid), [1, 2]);
});

// ---------- 路径归一与匹配 ----------

test("pathKey：反斜杠归一 + 去尾分隔符 + 可选大小写", () => {
  assert.equal(pathKey("E:\\vault\\task\\", false), "E:/vault/task");
  assert.equal(pathKey("E:/Vault/Task", true), "e:/vault/task");
  assert.equal(pathKey("E:/Vault/Task", false), "E:/Vault/Task");
});

test("underTask：相等或子目录命中，前缀相同但不同目录不命中", () => {
  assert.equal(underTask("e:/v/t", "e:/v/t"), true);
  assert.equal(underTask("e:/v/t/process", "e:/v/t"), true);
  assert.equal(underTask("e:/v/t2", "e:/v/t"), false);
  assert.equal(underTask("e:/v/t", "e:/v/t2"), false);
});

// ---------- pickStatus ----------

test("pickStatus：waiting > busy > shell > idle", () => {
  assert.equal(pickStatus(["idle", "busy", "waiting"]), "waiting");
  assert.equal(pickStatus(["idle", "busy"]), "busy");
  assert.equal(pickStatus(["idle", "shell"]), "shell");
  assert.equal(pickStatus(["idle"]), "idle");
  assert.equal(pickStatus([]), null);
});

// ---------- matchSessions ----------

const S = (pid, cwd, status) => ({ pid, cwd, status, name: `s${pid}`, startedAt: 1, updatedAt: 2 });

test("matchSessions：命中任务根与子目录，别的任务不算", () => {
  const out = matchSessions(
    [
      S(1, "E:\\vault\\flow\\data\\2026\\Q4\\11\\任务A", "busy"),
      S(2, "E:\\vault\\flow\\data\\2026\\Q4\\11\\任务A\\process", "idle"),
      S(3, "E:\\vault\\flow\\data\\2026\\Q4\\11\\任务B", "waiting"),
    ],
    ["E:\\vault\\flow\\data\\2026\\Q4\\11\\任务A"],
    { caseInsensitive: true },
  );
  const hit = out["E:\\vault\\flow\\data\\2026\\Q4\\11\\任务A"];
  assert.equal(hit.count, 2);
  assert.equal(hit.status, "busy"); // busy > idle
  assert.equal(hit.sessions.length, 2);
  assert.equal(out["E:\\vault\\flow\\data\\2026\\Q4\\11\\任务B"], undefined);
});

test("matchSessions：没有会话的任务不出键", () => {
  const out = matchSessions([S(1, "/x", "idle")], ["/y"], {});
  assert.deepEqual(out, {});
});

test("matchSessions：死 pid（崩溃残留）不计", () => {
  const out = matchSessions(
    [S(1, "/v/t", "busy"), S(2, "/v/t", "idle")],
    ["/v/t"],
    { isAlive: (pid) => pid === 1 },
  );
  assert.equal(out["/v/t"].count, 1);
  assert.equal(out["/v/t"].status, "busy");
});

test("matchSessions：大小写按开关处理", () => {
  const sessions = [S(1, "E:/Vault/Task", "idle")];
  assert.equal(matchSessions(sessions, ["E:/vault/task"], { caseInsensitive: true })["E:/vault/task"].count, 1);
  assert.equal(matchSessions(sessions, ["E:/vault/task"], { caseInsensitive: false })["E:/vault/task"], undefined);
});

test("matchSessions：多会话的代表档取最需要人看的", () => {
  const out = matchSessions(
    [S(1, "/v/t", "idle"), S(2, "/v/t", "busy"), S(3, "/v/t", "waiting")],
    ["/v/t"],
    {},
  );
  assert.equal(out["/v/t"].count, 3);
  assert.equal(out["/v/t"].status, "waiting");
});

// ---------- 显示映射 ----------

test("状态字典：四档齐全，shell 并入 idle 的图标", () => {
  assert.deepEqual(STATUSES, ["busy", "idle", "waiting", "shell"]);
  assert.equal(STATUS_ICONS.busy, "🟢");
  assert.equal(STATUS_ICONS.idle, "💤");
  assert.equal(STATUS_ICONS.waiting, "⏳");
  assert.equal(STATUS_ICONS.shell, STATUS_ICONS.idle);
  for (const s of STATUSES) assert.ok(STATUS_LABELS[s], `${s} 缺中文标签`);
});

test("显示档：shell 归到 idle（chip 修饰类用），其余各归各档", () => {
  assert.equal(STATUS_DISPLAY.busy, "busy");
  assert.equal(STATUS_DISPLAY.idle, "idle");
  assert.equal(STATUS_DISPLAY.waiting, "waiting");
  assert.equal(STATUS_DISPLAY.shell, "idle");
  // 「并入 idle」只有这一处定义：图标、chip 修饰类、面板文案三份都要跟着它
  for (const s of STATUSES) {
    assert.ok(STATUS_DISPLAY[s], `${s} 缺显示档`);
    assert.ok(STATUS_ICONS[s], `${s} 缺图标`);
    assert.ok(STATUS_LABELS[s], `${s} 缺中文标签`);
  }
});
