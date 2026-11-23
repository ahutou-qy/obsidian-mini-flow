// _launch-claude.js 的回归单测。`node --test _launch-claude.test.js` 跑。
//
// 两半：
//   1. resolveTarget —— 纯函数（只吃 vault 相对路径 + 注入的 getFullPath），决定「点 Home 上的
//      ▶ 按钮 / 按 pageHeader 的 Open Claude，claude 的 cwd 落在哪」。落错就是会话开在月目录
//      或 vault 根、README 相对路径与 git 基准全偏，所以每种路径形态都钉一个用例。
//   2. launchClaude 的 argv —— 起终端的命令行。Windows 侧有两条「别照直觉改回去」的实测约束
//      （见 _launch-claude.js 的 launchOnWindows 注释：wt 必须经 cmd 的 start 拉起、内部命令
//      必须拆成独立 argv），这里把它们钉成断言，免得下次重构把整条命令塞回一个字符串。
//
// window 桩必须在 require **之前**装好：模块在加载期就读 window.require。
const { test } = require("node:test");
const assert = require("node:assert/strict");

// ---------- window / child_process 桩 ----------
const calls = [];
let platform = "win32";
let wtAvailable = true;

global.window = {
  require(name) {
    if (name === "process") return { env: process.env };
    if (name === "os") return { platform: () => platform };
    if (name === "child_process") {
      return {
        execFile(cmd, args, opts, cb) {
          calls.push({ cmd, args, opts });
          const isWhere = cmd === "where.exe";
          setImmediate(() => {
            if (isWhere && !wtAvailable) cb(new Error("not found"), "", "");
            else cb(null, "", "");
          });
        },
      };
    }
    throw new Error(`window.require 出现意外模块: ${name}`);
  },
};

const { resolveTarget, sanitizeWinName, PERM_MODES, permMode, launchClaude } = require("./_launch-claude.js");

// getFullPath 桩：与 Obsidian FileSystemAdapter 一致（path.resolve(base, p)，空/`.` → base）。
const VAULT = "E:/vault";
const gfp = (p) => (p === "" || p === "." ? VAULT : `${VAULT}/${p}`);
const app = { vault: { adapter: { getFullPath: gfp } } };
const TASK = "flow/data/2026/Q4/11/某任务/README";
const TASK_ROOT = "E:/vault/flow/data/2026/Q4/11/某任务";

// ============================================================
// 1. resolveTarget
// ============================================================

test("folder 任务 README：cwd = 任务根，会话名 = 任务目录名", () => {
  const t = resolveTarget("flow/data/2026/Q4/11/obsidian-home-工作事务的显示优化-现在存在任务/README", gfp);
  assert.equal(t.cwd, "E:/vault/flow/data/2026/Q4/11/obsidian-home-工作事务的显示优化-现在存在任务");
  assert.equal(t.sessionName, "obsidian-home-工作事务的显示优化-现在存在任务");
  assert.equal(t.isTaskLayout, true);
});

test("带 .md 后缀的 folder 任务 README 同解（Home 卡 linkTarget 不带 .md，容错）", () => {
  const a = resolveTarget("flow/data/2026/Q4/11/某任务/README", gfp);
  const b = resolveTarget("flow/data/2026/Q4/11/某任务/README.md", gfp);
  assert.deepEqual(a, b);
});

test("任务 process/ 子目录里的笔记：上抬到任务根（不留在深层子目录）", () => {
  const t = resolveTarget("flow/data/2026/Q4/11/某任务/process/01-调研与协议", gfp);
  assert.equal(t.cwd, TASK_ROOT);
  assert.equal(t.sessionName, "某任务");
});

test("任务 output/ 子目录同上抬", () => {
  const t = resolveTarget("flow/data/2026/Q4/11/某任务/output/交付清单", gfp);
  assert.equal(t.cwd, TASK_ROOT);
});

test("单文件任务（6 段，没有任务目录）：落月目录，会话名仍是任务名", () => {
  const t = resolveTarget("flow/data/2026/Q4/11/单文件任务", gfp);
  assert.equal(t.cwd, "E:/vault/flow/data/2026/Q4/11");
  assert.equal(t.sessionName, "单文件任务");
  assert.equal(t.isTaskLayout, true);
});

test("月度 ideas 文件：落月目录，会话名 = ideas-2026-11", () => {
  const t = resolveTarget("flow/data/2026/Q4/11/ideas-2026-11", gfp);
  assert.equal(t.cwd, "E:/vault/flow/data/2026/Q4/11");
  assert.equal(t.sessionName, "ideas-2026-11");
});

test("vault 根笔记 Home.md：落 vault 根（与旧实现 path.dirname 一致）", () => {
  const t = resolveTarget("Home.md", gfp);
  assert.equal(t.cwd, VAULT);
  assert.equal(t.sessionName, "Home");
  assert.equal(t.isTaskLayout, false);
});

test("非 flow/data 的普通笔记：落笔记父目录", () => {
  const t = resolveTarget("agents/global/platform-win.md", gfp);
  assert.equal(t.cwd, "E:/vault/agents/global");
  assert.equal(t.sessionName, "platform-win");
});

test("反斜杠路径归一（adapter 偶发给 Windows 形态）", () => {
  const t = resolveTarget("flow\\data\\2026\\Q4\\11\\某任务\\README", gfp);
  assert.equal(t.cwd, TASK_ROOT);
});

test("空路径抛错，不静默落 vault 根", () => {
  assert.throws(() => resolveTarget("", gfp), /没有可启动的路径/);
  assert.throws(() => resolveTarget(null, gfp), /没有可启动的路径/);
});

test("季度/年份不合布局时不误判成任务根（只认 flow/data/YYYY/Qn/MM）", () => {
  const t = resolveTarget("flow/data/2026/Q4/README", gfp);
  assert.equal(t.isTaskLayout, false);
  assert.equal(t.cwd, "E:/vault/flow/data/2026/Q4");
});

test("会话名不带扩展名", () => {
  assert.equal(resolveTarget("notes/todo.md", gfp).sessionName, "todo");
});

test("sanitizeWinName 挡 cmd 元字符（会话名要过 start 一层）", () => {
  assert.equal(sanitizeWinName('a&b|c<d>e^f%g!h"i'), "a-b-c-d-e-f-g-h-i");
  assert.equal(sanitizeWinName("正常任务名"), "正常任务名");
});

test("权限模式白名单与 default 归一", () => {
  assert.deepEqual(PERM_MODES, ["manual", "default", "acceptEdits", "dontAsk", "plan", "auto"]);
});

test("permMode：缺省 auto、default 归一 manual、白名单外回落 auto", () => {
  const saved = process.env.ZC_PERMISSION_MODE;
  try {
    delete process.env.ZC_PERMISSION_MODE;
    assert.equal(permMode(), "auto");
    process.env.ZC_PERMISSION_MODE = "default";
    assert.equal(permMode(), "manual");
    process.env.ZC_PERMISSION_MODE = "plan";
    assert.equal(permMode(), "plan");
    process.env.ZC_PERMISSION_MODE = "manual";
    assert.equal(permMode(), "manual", "显式退回逐条审批要能生效");
    process.env.ZC_PERMISSION_MODE = "nope";
    assert.equal(permMode(), "auto");
  } finally {
    if (saved === undefined) delete process.env.ZC_PERMISSION_MODE;
    else process.env.ZC_PERMISSION_MODE = saved;
  }
});

// ============================================================
// 2. launchClaude 的 argv（起终端那条命令）
// ============================================================

test("Windows：有 wt 时走当前窗口新 tab，cwd 与 claude 参数原样透传", async () => {
  calls.length = 0;
  platform = "win32";
  wtAvailable = true;
  await launchClaude({ app, vaultPath: TASK });

  assert.equal(calls.length, 2, "应先探 wt、再 start");
  const [where, start] = calls;
  assert.equal(where.cmd, "where.exe");
  assert.deepEqual(where.args, ["wt.exe"]);

  // 内部命令必须拆成独立 argv（整条塞进一个带空格的字符串会经 start 整条丢失）。
  assert.equal(start.cmd, "cmd.exe");
  const a = start.args;
  assert.deepEqual(a.slice(0, 5), ["/c", "start", "", "wt.exe", "-w"]);
  assert.equal(a[5], "0");
  assert.equal(a[6], "nt");
  const dIdx = a.indexOf("-d");
  assert.ok(dIdx > 0, "wt 少了 -d <cwd>");
  assert.equal(a[dIdx + 1], TASK_ROOT, "wt -d 必须是任务根");
  assert.deepEqual(
    a.slice(dIdx + 2),
    ["cmd", "/k", "claude", "--permission-mode", "auto", "--name", "某任务"],
    "claude 的选项不能被 wt 当自己的选项吞掉（也不要加 -- 分隔符）",
  );
  // 进程工作目录也钉到任务根：路径里的 & % ^ 不经 cmd 解析。
  assert.equal(start.opts.cwd, TASK_ROOT);
});

test("Windows：没有 wt 时回落 cmd 新窗口（同样靠 cwd 继承，不拼 cd）", async () => {
  calls.length = 0;
  platform = "win32";
  wtAvailable = false;
  await launchClaude({ app, vaultPath: TASK });

  assert.equal(calls.length, 2);
  const start = calls[1];
  assert.deepEqual(start.args, [
    "/c", "start", "", "cmd.exe", "/k", "claude", "--permission-mode", "auto", "--name", "某任务",
  ]);
  assert.equal(start.opts.cwd, TASK_ROOT);
});

test("macOS：走 osascript 让 iTerm 写 cd + claude（shell 单引号转义）", async () => {
  calls.length = 0;
  platform = "darwin";
  await launchClaude({ app, vaultPath: TASK });

  assert.equal(calls.length, 1, "macOS 只发一条 osascript");
  const [osa] = calls;
  assert.equal(osa.cmd, "/usr/bin/osascript");
  assert.deepEqual(osa.args.slice(0, 1), ["-e"]);
  const script = osa.args[1];
  assert.ok(script.includes("tell application \"iTerm\""), "没走 iTerm");
  assert.ok(
    script.includes(`cd '${TASK_ROOT}' && claude --permission-mode auto --name '某任务'`),
    `命令串不对：${script.slice(0, 300)}`,
  );
  assert.equal(osa.opts.cwd, TASK_ROOT);
});

test("macOS：路径里的单引号做 shell 转义，且 escCmd 再给它上一层 AppleScript 转义", async () => {
  calls.length = 0;
  platform = "darwin";
  await launchClaude({ app, vaultPath: "flow/data/2026/Q4/11/it's-a-task/README" });
  const script = calls[0].args[1];
  // shell 层先把 ' 转成 '\''（→ `it'\''s-a-task`），escCmd 再把其中的 \ 加倍（AppleScript
  // 字符串字面量解析时 \\ 退回 \），最终 shell 收到的正是 `it'\''s-a-task`。
  // 少任一层都会把 cd 的引号串截断——断言写的是**进 AppleScript 之前**的源码形态。
  assert.ok(
    script.includes(`cd 'E:/vault/flow/data/2026/Q4/11/it'\\\\''s-a-task'`),
    `单引号转义链不对：${script.slice(0, 400)}`,
  );
  assert.ok(script.includes(`--name 'it'\\\\''s-a-task'`), "会话名的单引号没转义");
});
