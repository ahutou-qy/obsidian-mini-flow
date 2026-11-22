// ==============================================
// Mini Flow - Open Claude（QuickAdd 宏薄壳，2026-11-19 起）。
//
// 本文件只做一件事：**取活动笔记的路径**，把启动交给单源
// `flow/scripts/quickadd/mini/_launch-claude.js#launchClaude({ app, vaultPath })`。
//
// 为什么拆出去：启动逻辑有两个调用方——本宏（从**当前打开的笔记**起会话）与
// miniflow 插件的 `api.launchClaude(path)`（Home「🏠 工作事务」活跃卡的行内 ▶
// 按钮，从**点中的那条任务**起会话）。原先实现只认活动笔记，在 Home.md 上按 pageHeader
// 那颗按钮时 cwd 落 vault 根、不是任务目录。抽出后两者共用一份实现，行为对本宏不变。
//
// 加载方式：QuickAdd 沙盒的 `require` 是 `window.require` 的透传，**解析不到 vault 内的
// 相对路径**（它按 Electron 渲染进程的模块路径找），所以走与 task-edit.js 同款的
// 字符串加载（adapter.read + new Function），不写 `require("./_launch-claude.js")`。
//
// 行为摘要（细则见 _launch-claude.js 文件头）：
// - 起新终端跑 `claude --permission-mode <mode> --name <会话名>`，cwd 上抬到任务根。
//   mode 取 ZC_PERMISSION_MODE（白名单，默认 auto）。
// - 不带 -c/--continue：每次起全新会话，避免旧上下文随续接累积膨胀。要续就自己在终端
//   `claude -c` / `--resume`。
// - 总开新 tab/窗口，不探测该任务是否已有 claude 在跑——两个 agent 同改一棵树会撞
//   「工作目录互斥」，靠人别在任务会话还开着时重复打开。
//
// 反馈（按 flow/CLAUDE.md「Mini Flow 命令的 Notice 策略」）：成功**不发** Notice——终端
// 窗口/新 tab 自己就是反馈；只有失败（非桌面端、vault 不支持本地路径、派发失败）才弹。
// ==============================================

const nodeRequire =
  typeof window !== "undefined" && typeof window.require === "function"
    ? window.require
    : null;

const MINI_DIR = "flow/scripts/quickadd/mini/";

// 字符串加载 vault 内 helper（与 task-edit.js#loadHelper 同款；QuickAdd 的 require 解析不到）。
async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`${MINI_DIR}${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

module.exports = async ({ app }) => {
  if (!nodeRequire) {
    new Notice("Open Claude：仅桌面端可用", 4000);
    return;
  }

  const active = app.workspace.activeEditor || app.workspace.activeLeaf;
  const file = active && active.file;
  if (!file) {
    new Notice("Open Claude：没有活动文件，先打开一个笔记", 4000);
    return;
  }

  const launch = await loadHelper(app.vault, "_launch-claude.js");
  try {
    await launch.launchClaude({ app, vaultPath: file.path });
  } catch (e) {
    new Notice(`Open Claude 失败：${String((e && e.message) || e).trim().slice(0, 200)}`, 6000);
  }
};
