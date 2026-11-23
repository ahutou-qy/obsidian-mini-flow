// ==============================================
// Mini Flow - mf.js 的 `idea` 子命令：闪念写入（CLI 面，2026-11-23）
//
// 对应 Obsidian 的 Idea Capture（`idea-capture.js`）。落点与格式**完全一致**：
// `flow/ideas-home.txt`（或配置 `paths.ideasFile`），每条 `- 内容`，不写日期时间。
//
// 为什么不能走 `vault.modify` 的 Obsidian 事件面：那个文件刻意不是 `.md`——一旦被
// Dataview 索引到，Home 里所有 dataviewjs 块都会重跑（render 先 innerHTML=""），
// 表现为「一闪」。CLI 侧走 fs 直写本来就不会触发 Obsidian 的 modify 事件，与
// Obsidian 侧 `adapter.write` 的语义一致。
//
// 唯一的差别：Obsidian 侧写完 `dispatchEvent(miniflow:ideas-changed)` 让 Home 闪念块
// 局部重绘；CLI 进程派发不了 DOM 事件。写完请调插件命令 `miniflow:ideas-reload`
// （`command_execute`），否则 Home 卡片要等下一次重渲染才更新。
// ==============================================

const path = require("node:path");

const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const configMod = require(path.join(MINI, "_config.js"));
const { CliError } = require("./agent-capture.js");

const DEFAULT_IDEAS_PATH = "flow/ideas-home.txt";

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function die(code, msg) {
  throw new CliError(code, msg);
}

function countIdeaLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s+/.test(l)).length;
}

async function ideaAdd(vault, args, ctx = {}) {
  const body = String(flag(args, "--text") || "").trim();
  if (!body) die(2, 'idea 需要 --text "<闪念内容>"');
  if (/[\r\n]/.test(body)) die(2, "闪念只能是单行（要写多行请拆成多条或建任务）");

  const cfg = configMod.loadSync(ctx.vaultRoot);
  const ideasPath = (cfg && cfg.paths && cfg.paths.ideasFile) || DEFAULT_IDEAS_PATH;

  let prev = "";
  try {
    prev = await vault.read(ideasPath);
  } catch (_e) {
    // 不存在则新建（与 Obsidian 侧同款）
  }
  const line = `- ${body}`;
  const next = `${prev.replace(/\s*$/, "") || ""}${prev.trim() ? "\n" : ""}${line}\n`;
  await vault.modify(ideasPath, next);

  return {
    ok: true,
    action: "idea.add",
    path: ideasPath,
    line,
    count: countIdeaLines(next),
    // Home 闪念块靠 DOM 事件重绘，CLI 进程派发不了——调用方需再执行插件命令。
    hint: "跑 `miniflow:ideas-reload`（command_execute）让 Home 闪念块立刻重绘",
  };
}

module.exports = { ideaAdd };
