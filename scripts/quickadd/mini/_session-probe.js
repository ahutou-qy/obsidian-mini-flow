// ==============================================
// Mini Flow - 本机 Claude Code 会话探针（2026-11-23 新增）
//
// 数据源：Claude Code 的**实时会话注册表** `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`
// （缺省 `~/.claude/sessions`）。一条会话一个文件，字段含 pid / sessionId / cwd /
// name / status / startedAt / updatedAt。同目录的 `<pid>.<sha>.key` 是会话间消息认证
// 令牌，**不要读、不要展示**（本模块只收 `.json`，见 parseSessions）。
//
// 为什么要它：Home「🏠 事务」卡要显示「本机是否开着该任务的 claude 会话」。
// 其它候选源都不行——`~/.claude/projects/<转义目录名>/` 把中文全换成 `-`，反查不回
// 任务；hook 落盘要另接 Stop/Notification 才能拿到 busy/idle/waiting；进程枚举的
// CommandLine 只有 `--name`、拿不到 cwd。注册表是唯一现成且带 cwd 与 status 的源。
//
// 边界（本模块**只读、不写盘、不跨设备**）：
//   - 零 require（插件侧用 `new Function` 字符串加载，没有 require）：fs / os / process
//     全部由调用方注入，裸 node 可单测。
//   - 注册表是**未公开**的运行时格式，字段可能随版本漂 → 解析失败/缺字段/未知 status
//     一律跳过，**绝不让卡面报错**（上层再兜一层空对象）。
//   - 崩溃或强杀会残留死 pid 的 json（正常退出由 process.on("exit") 删文件），所以
//     读侧必须做 pid 存活校验（isAlive 注入）。
//   - 匹配口径：**只按 cwd**（会话工作目录落在任务根或其子目录内即命中）。不按会话名
//     兜底——名字不保证唯一，重名会误报。
//
// 与卡片的关系：判据（谁算命中、代表状态取哪档）在本文件；**显示形态**（emoji、面板）
// 在插件与 Home.md 侧，但 icon 映射也放这里——多处消费同一份，别各写一份。
// ==============================================

// status 四档（Claude Code 运行时字段）：busy=模型正在跑 / idle=会话开着等你下一条 /
// waiting=在等你输入或授权（附 waitingFor）/ shell=shell 模式。
const STATUSES = ["busy", "idle", "waiting", "shell"];

// 显示映射（单一真源，插件的会话面板与 Home 卡的徽标共用这份）。
// shell 与 idle 对人的意义一致（会话开着、等下一条输入），故**并入 idle**，
// 不在卡面多占一个图例。
const STATUS_ICONS = {
  busy: "🟢",     // 模型正在跑
  idle: "💤",     // 会话开着，等你下一条
  waiting: "⏳",  // 在等你输入 / 授权
  shell: "💤",    // 并入 idle（见上）
};

const STATUS_LABELS = {
  busy: "运行中（模型正在跑）",
  idle: "空闲（等你下一条）",
  waiting: "等你输入 / 授权",
  shell: "空闲（shell 模式）",
};

// 卡面 chip 的**显示档**：shell 与 idle 同义（同为「开着等你下一条」），卡面 chip
// 与样式修饰类都按这份归一——「并入 idle」这件事因此只有一处定义，
// 图标（STATUS_ICONS）、chip 修饰类（STATUS_DISPLAY）、面板文案（STATUS_LABELS）各司其职。
const STATUS_DISPLAY = {
  busy: "busy",
  idle: "idle",
  waiting: "waiting",
  shell: "idle",
};

// 多会话取代表档的优先级：**waiting 最需要人看**（唯一可动作信号），其次 busy，
// 再次 shell，最后 idle。
const STATUS_PRIORITY = { waiting: 3, busy: 2, shell: 1, idle: 0 };

// 会话注册表目录：CLAUDE_CONFIG_DIR 优先，缺省 ~/.claude/sessions。
// 拿不到 home 目录 → null（调用方按「无会话源」处理，不抛）。
function sessionDir(env, homedir) {
  const cfg = String((env && env.CLAUDE_CONFIG_DIR) || "").trim();
  const base = cfg
    ? cfg.replace(/[\\/]+$/, "")
    : (homedir ? String(homedir).replace(/[\\/]+$/, "") + "/.claude" : "");
  if (!base) return null;
  return base + "/sessions";
}

// 单个会话 json → 会话对象。坏 json / 缺 pid / 缺 cwd / status 不在四档内 → null（跳过）。
function parseSession(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const pid = Number(obj.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cwd = typeof obj.cwd === "string" ? obj.cwd.trim() : "";
  if (!cwd) return null;
  const status = typeof obj.status === "string" ? obj.status.trim().toLowerCase() : "";
  if (!STATUSES.includes(status)) return null;
  return {
    pid,
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "",
    cwd,
    name: typeof obj.name === "string" ? obj.name : "",
    status,
    startedAt: Number(obj.startedAt) || 0,
    updatedAt: Number(obj.updatedAt) || 0,
  };
}

// 一批 {name, text} → 会话列表。只收 `.json`（`.key` 认证令牌、`.fleetview-heartbeat`
// 心跳文件一律不读）；点开头的文件跳过；单个文件坏掉只跳过它，不影响其它。
function parseSessions(entries) {
  const out = [];
  for (const e of entries || []) {
    if (!e || typeof e.text !== "string") continue;
    const name = String(e.name || "");
    if (name.startsWith(".")) continue;
    if (!name.toLowerCase().endsWith(".json")) continue;
    const s = parseSession(e.text);
    if (s) out.push(s);
  }
  return out;
}

// 路径归一：反斜杠→斜杠、去尾分隔符、可选大小写归一（Windows 大小写不敏感；
// macOS/Linux 默认按大小写敏感处理，别把不同目录并成同一个）。
function pathKey(p, caseInsensitive) {
  let s = String(p == null ? "" : p).replace(/\\/g, "/").replace(/\/+$/, "");
  if (caseInsensitive) s = s.toLowerCase();
  return s;
}

// 会话 cwd 是否落在任务根下（相等，或以其为前缀的子目录）。
function underTask(cwdKey, taskKey) {
  if (!cwdKey || !taskKey) return false;
  return cwdKey === taskKey || cwdKey.startsWith(taskKey + "/");
}

// 一组 status 里取代表档（见 STATUS_PRIORITY）。
function pickStatus(statuses) {
  let best = null;
  for (const s of statuses || []) {
    if (!STATUSES.includes(s)) continue;
    if (best === null || STATUS_PRIORITY[s] > STATUS_PRIORITY[best]) best = s;
  }
  return best;
}

// 会话 × 任务根 → { <任务根原串>: { count, status, sessions:[…] } }。
//
// opts.caseInsensitive：路径比较是否忽略大小写（Windows 传 true）。
// opts.isAlive(pid)：pid 存活校验（进程已死 → 该会话不计，崩溃残留的 json 就不会
// 造成假徽标）。不传则不做校验。
// 命中的任务根才出现在返回值里（没有会话的任务不出键）。
function matchSessions(sessions, taskRoots, opts) {
  const o = opts || {};
  const ci = !!o.caseInsensitive;
  const isAlive = typeof o.isAlive === "function" ? o.isAlive : null;
  const alive = (sessions || []).filter((s) => s && (!isAlive || isAlive(s.pid)));
  const out = {};
  for (const raw of taskRoots || []) {
    if (!raw) continue;
    const key = pathKey(raw, ci);
    if (!key) continue;
    const hit = alive.filter((s) => underTask(pathKey(s.cwd, ci), key));
    if (!hit.length) continue;
    const status = pickStatus(hit.map((s) => s.status));
    out[raw] = {
      count: hit.length,
      status,
      sessions: hit.map((s) => ({
        pid: s.pid,
        name: s.name,
        status: s.status,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        cwd: s.cwd,
      })),
    };
  }
  return out;
}

module.exports = {
  STATUSES,
  STATUS_ICONS,
  STATUS_LABELS,
  STATUS_DISPLAY,
  STATUS_PRIORITY,
  sessionDir,
  parseSession,
  parseSessions,
  pathKey,
  underTask,
  pickStatus,
  matchSessions,
};
