// ==============================================
// Mini Flow - 启动 claude 会话的核心实现（Open Claude 的单源，2026-11-19 抽出）。
//
// 两个调用方共用这一份，不许各写一套：
//   - QuickAdd 宏「Open Claude」→ open-claude.js（薄壳，只负责取**活动笔记**的路径）
//   - miniflow 插件 `api.launchClaude(vaultPath)` → Home「🏠 事务」行内 ▶ 按钮
//     （按钮传的是**点中那条任务**的路径）
//
// 为什么抽：open-claude.js 原先读 `app.workspace.activeEditor` 的文件，在 Home.md 上按
// pageHeader 那颗按钮时 cwd 落 vault 根、而不是任务目录——行内按钮要的正是「点哪条任务
// 就进哪个任务根」。抽出后行为对 QuickAdd 宏完全不变（同一段启动逻辑）。
//
// 行为：
// - 起一个新终端跑 `claude --permission-mode <mode> --name <会话名>`，cwd 钉到任务根。
//   macOS：osascript 让 iTerm 执行；Windows：Windows Terminal 新 tab，没装则回落 cmd.exe。
//   不带 -c/--continue：每次起全新会话、不加载该目录历史，避免旧上下文随续接累积膨胀。
//   确要续旧会话时自己在终端 claude -c / --resume。
// - 会话名走 `--name`：Claude Code 2.1.306 的 -n/--name 会把名字写进终端标签标题
//   （内部优先级 sessionTitle 最高，不会被后面自动生成的话题标题盖掉），同一名字也进
//   resume 选择器与提示框显示名。**不自己拼 OSC `]0;` 转义序列**——wt 的 --title 只是
//   初始标题，claude 启动时自己写一遍会盖掉它。
// - cwd 上抬到任务根：活动笔记可能在 process/output 子目录，直接以其所在目录起 claude
//   会让工作目录落在深层子目录。Mini Flow 任务固定布局 flow/data/<年>/<Qn>/<MM>/<任务>/，
//   命中就把 cwd 上抬到任务根，保证从 README/process/output 任意笔记打开，claude 都在
//   任务根跑（README、相对路径、git 都以任务根为基准）。单文件任务没有任务目录（6 段），
//   落月目录；非 flow/data 笔记落笔记父目录。
// - macOS 有窗：在当前窗口开新 tab，claude 跑进新 tab；不写当前会话 stdin，也不改它的
//   布局（分屏会挤压当前 pane 宽度，当前会话跑全屏 TUI 时观感挤）。
//   tab 只能用 default profile：iTerm 字典里 session 只暴露只读 profile name、没有 profile
//   GUID，也没有 "create tab with current profile"。实测（2026-09-29）会话报的 profile
//   name 'Chat' 喂回 create tab with profile 报 "No profile exists named 'Chat'"——名字
//   不可寻址。代价：新 tab 用 default profile，外观/env 未必与当前会话一致。
// - macOS 无窗（或 iTerm 没运行）：建窗口，claude 跑进该窗唯一会话。
// - macOS 在当前（iTerm 默认）shell 里直接敲 claude。冒烟环境已验证该 shell 能解析到
//   nvm 下的 claude；不额外套 zsh -ic，避免 claude 退出后窗口立刻关闭看不到收尾输出。
// - Windows 见 launchOnWindows 的注释（wt 新 tab，回落 cmd 新窗口）。
//
// 边界：
// - 仅桌面端（window.require 存在）。非桌面端由调用方提示，本模块只抛 Error。
// - **本模块不碰 Notice / obsidian**：QuickAdd 沙盒与插件字符串加载两个上下文里
//   `Notice` 的可见性不一样，错误一律以抛出形态交回调用方，由它各自提示（文案单源在
//   插件的 launchClaude 与 open-claude.js 的 reportFail 两处，都是短句）。
// - 总开新 tab/窗口，**启动器本身**不探测该任务是否已有 claude 在跑。两条会话各写独立
//   jsonl（不写坏），但两个 agent 同改一棵树，撞「工作目录互斥」——所以 2026-11-23 起
//   **Home「🏠 事务」卡**加了一颗会话状态徽标（读本机会话注册表，判据在
//   `_session-probe.js`），「已有会话在跑」这件事在卡面上可见了；启动器仍总开新 tab
//   （人点了就是要开新会话），不在这里拦。
// - 新 tab 被选中、终端抢到前台（分屏同样如此）；来源笔记与 claude 会话不能同屏对照。
// - macOS：同 bundle id 存在多个 iTerm 实例时，AppleScript 会路由到无窗的旧实例，count
//   of windows 误判为 0 而退化成建窗——这不是脚本能在脚本内修的，需清掉残留 iTerm 进程
//   保持单实例。
// - macOS 首次运行触发自动化授权（Obsidian 控制 iTerm）。被拒时 osascript 返回非 0
//   （-1743/-1746），提示去 系统设置 → 隐私与安全性 → 自动化 开启。
// - Windows 需要 PATH 里有 claude（本机在 %USERPROFILE%\.vfox\sdks\nodejs\claude.cmd）；
//   Obsidian 继承的是它启动时的用户环境，新装的运行时/PATH 改动要重启 Obsidian 才可见。
//   注意这与 `zc`（pwsh 函数，走 profile）的环境**不完全相同**，换工具链后实测一次。
// ==============================================

const nodeRequire =
  typeof window !== "undefined" && typeof window.require === "function"
    ? window.require
    : null;

// 权限模式：与机器级 zc / cc 共用 ZC_PERMISSION_MODE，默认 auto。
// auto 在第三方端点上能不能用，取决于 CLAUDE_CODE_AUTO_MODE_SERVER：置 0 时判定改走本地
// 分类器（role=arbiterWithLocalFallback），不再向服务端发那个请求；不置则走服务端判定，
// 而第三方 relay 转发不了它，每个动作都降级人工审批并弹「auto mode can't check actions」。
// 两端 cc-switch 通用配置都已置 0（mac 2026-11-22 落，Windows 更早），所以这里默认 auto。
// 换到没置 0 的机器上要么补该 env，要么设 ZC_PERMISSION_MODE=default 退回逐条审批。
// default 归一成 manual：CLI 的 Ck() 把 manual 映射回 default，两者等价。
// 取值走白名单——macOS 分支要把它拼进 shell 命令串，不能让环境变量带任意字符进来。
const PERM_MODES = ["manual", "default", "acceptEdits", "dontAsk", "plan", "auto"];

function envOf() {
  if (nodeRequire) {
    try {
      const p = nodeRequire("process");
      if (p && p.env) return p.env;
    } catch { /* 落到下面的兜底 */ }
  }
  // 裸 node（单测）里没有 window.require，但有全局 process。
  return (typeof process !== "undefined" && process.env) || {};
}

function permMode() {
  const raw = (envOf().ZC_PERMISSION_MODE || "auto").trim();
  if (!PERM_MODES.includes(raw)) return "auto";
  return raw === "default" ? "manual" : raw;
}

// ---------- 纯函数：路径 → { cwd, sessionName, isTaskLayout } ----------
//
// 只吃 vault 相对路径（`/` 分隔、可带可不带 .md），不碰 fs、不碰 window —— 裸 node 可测
// （_launch-claude.test.js）。`getFullPath` 由调用方注入（Obsidian adapter.getFullPath）。
//
// 上抬规则（与文件头「cwd 上抬到任务根」对应）：
//   flow/data/<年>/<Qn>/<MM>/<任务>[/...]  且段数 > 6 → cwd = 前 6 段（任务根）
//   同布局但段数 = 6（单文件任务 / 月度 ideas 文件）   → cwd = 前 5 段（月目录）
//   其它                                            → cwd = 去掉末段（笔记父目录）
function resolveTarget(vaultPath, getFullPath) {
  const rel = String(vaultPath == null ? "" : vaultPath)
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .replace(/\/+$/, "");
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length) throw new Error("没有可启动的路径");

  const isTaskLayout =
    parts.length >= 5 &&
    parts[0] === "flow" &&
    parts[1] === "data" &&
    /^\d{4}$/.test(parts[2]) &&
    /^Q[1-4]$/i.test(parts[3]) &&
    /^\d{2}$/.test(parts[4]);

  let cwdRel;
  let rawName;
  if (isTaskLayout && parts.length > 6) {
    cwdRel = parts.slice(0, 6).join("/");
    rawName = parts[5];
  } else if (isTaskLayout) {
    cwdRel = parts.slice(0, 5).join("/");
    rawName = parts[5] || parts[4];
  } else {
    cwdRel = parts.slice(0, -1).join("/");
    rawName = parts[parts.length - 1];
  }

  // 末段是文件名时去掉扩展名（Home.md → Home；README → README）。
  const name = String(rawName || "claude").replace(/\.[^.\/]+$/, "");
  return {
    // 空串交给 getFullPath 自己归一到 vault 根（FileSystemAdapter 走 path.resolve(base, ".")）。
    cwd: getFullPath(cwdRel || "."),
    sessionName: name,
    isTaskLayout,
  };
}

// Windows cmd.exe 会解析 & | < > ^ % 等元字符（会话名进 wt 的 argv，但仍过 cmd 一层）。
function sanitizeWinName(name) {
  return String(name).replace(/[&|<>^%!"]/g, "-");
}

// macOS 侧**不**在这里做转义：会话名进的是 shell 单引号串，转义由 launchMacIterm 的
// `.replace(/'/g, "'\\''")`（shell 层）+ escCmd（AppleScript 双引号串层）两级各自负责。
// 在这里先转一遍会让两层重复转义（`"` 变成 `a\"b` 落进 shell），别加。

// ---------- 启动 ----------
//
// 返回 Promise：命令已派发成功则 resolve，派发失败则 reject(Error)。
// 「终端起来了但 claude 不在 PATH」这类**不**算失败（cmd /k 会留在窗口里报错给人看），
// 与原实现一致——start 本来就拿不到子进程退出码。

function launchClaude({ app, vaultPath }) {
  if (!nodeRequire) return Promise.reject(new Error("仅桌面端可用（没有 window.require）"));
  const adapter = app && app.vault && app.vault.adapter;
  if (!adapter || typeof adapter.getFullPath !== "function") {
    return Promise.reject(new Error("当前 vault 不支持本地路径"));
  }
  let target;
  try {
    target = resolveTarget(vaultPath, (p) => adapter.getFullPath(p));
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const { execFile } = nodeRequire("child_process");
  const opts = { cwd: target.cwd, timeout: 8000 };
  if (nodeRequire("os").platform() === "win32") {
    return launchOnWindows({
      execFile,
      opts,
      cwd: target.cwd,
      sessionName: sanitizeWinName(target.sessionName),
    });
  }
  return launchMacIterm({
    execFile,
    opts,
    cwd: target.cwd,
    sessionName: target.sessionName,
  });
}

// ---------- macOS：osascript 让 iTerm 执行 ----------
function launchMacIterm({ execFile, opts, cwd, sessionName }) {
  const safeDir = cwd.replace(/'/g, "'\\''");
  const cmd = `cd '${safeDir}' && claude --permission-mode ${permMode()} --name '${sessionName.replace(/'/g, "'\\''")}'`;
  // AppleScript 双引号字符串里转义反斜杠和双引号；单引号原样透传给 shell。
  const escCmd = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // 有窗：当前窗口 create tab（default profile，见文件头为何不能沿用当前会话 profile），
  // 命令写进新 tab 的 current session；不动当前会话 stdin、不改其布局。
  // 无窗：建窗后写它唯一会话。
  const osa = `tell application "iTerm"
  activate
  if (count of windows) = 0 then
    create window with default profile
    set targetSession to current session of current window
  else
    tell current window
      set newTab to (create tab with default profile)
      set targetSession to current session of newTab
    end tell
  end if
  tell targetSession
    write text "${escCmd}"
  end tell
end tell`;

  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", osa], opts, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || err).trim()));
      else resolve();
    });
  });
}

// ---------- Windows：新开终端跑 claude ----------
// 不拼 `cd <dir> && claude` 这类命令行字符串，而是把目标目录交给 execFile 的 cwd 选项——
// 新控制台继承父进程工作目录，路径里的 & % ^ ! 等 cmd 元字符因此完全不经 shell 解析
// （vault 路径经 _naming.sanitize 过滤后仍可能含 & %）。命令行只剩固定的
// `claude --permission-mode <mode> --name <会话名>`，mode 取白名单内的 ZC_PERMISSION_MODE
// （见 permMode()），没有一处自由文本插值。
//
// 两条实测约束（2026-10-08 本机 Win11 实测，别照直觉改回去）：
// ① wt.exe 是商店「应用执行别名」，Node 的 execFile 直接 spawn 会 ENOENT（fs.existsSync
//    也查不到该文件），必须经 cmd 的 `start`（走 ShellExecute）才拉得起来。所以探测 wt
//    存在性只能问 `where.exe`。
// ② 内部命令必须拆成独立 argv 传给 start，不能整条塞进一个带空格的字符串——那样经 start
//    传递会整条丢失（实测新窗口起来但命令没执行）。拆开后 `--permission-mode <mode>` 不会被
//    wt 当自己的选项吞掉（实测透传正确）；反过来加 `--` 分隔符会让整条命令失效，别加。
function launchOnWindows({ execFile, opts, cwd, sessionName }) {
  return new Promise((resolve, reject) => {
    const report = (e, se) => (e ? reject(new Error(String(se || e.message || e).trim())) : resolve());
    const claudeArgs = ["--permission-mode", permMode(), "--name", sessionName];
    // 有 Windows Terminal：复用当前窗口开新 tab（-w 0），观感与 macOS 侧一致。
    const launchWt = () =>
      execFile(
        "cmd.exe",
        ["/c", "start", "", "wt.exe", "-w", "0", "nt", "-d", cwd, "cmd", "/k", "claude", ...claudeArgs],
        opts,
        report,
      );
    // 没有 Windows Terminal：普通控制台新窗口，功能等价、观感差一档。conhost 不认 OSC
    // 标题序列，claude 走 OSC 写标题时这一支可能不生效（未在本机验证）。
    const launchCmd = () =>
      execFile(
        "cmd.exe",
        ["/c", "start", "", "cmd.exe", "/k", "claude", ...claudeArgs],
        opts,
        report,
      );
    execFile("where.exe", ["wt.exe"], { timeout: 4000, windowsHide: true }, (err) =>
      err ? launchCmd() : launchWt(),
    );
  });
}

module.exports = {
  PERM_MODES,
  permMode,
  resolveTarget,
  sanitizeWinName,
  launchClaude,
};
