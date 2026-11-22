// ==============================================
// Mini Flow - 剪贴板：新建任务成功后把 README 全路径写进系统剪贴板
//
// 调用点（2026-10-26 起默认复制，无开关）：
// - task-capture.js#onSubmit（QuickAdd「Task Capture」）
// - miniflow 插件 convertIdeaToTask#onConvertSubmit（Home 闪念「⤴」转任务）
//   两者建的都是同一形状的 folder 任务，行为保持一致。
//
// 路径形态：桌面端走 adapter.getFullPath 拼本地绝对路径（与 open-claude.js /
// open-finder.js 同一来源；Obsidian 内部是 Node path.join(basePath, rel)，
// Windows 下自然是反斜杠形态）。移动端 / adapter 无该 API 时退化为 vault 相对路径。
//
// 边界：
// - 失败静默：剪贴板不可用、窗口未聚焦都只吞掉，不打断建任务主流程、不发 Notice
//   （flow/CLAUDE.md「Mini Flow 命令的 Notice 策略」：Task Capture 提交不发成功提示）。
// - 回退链 navigator.clipboard.writeText → 临时 textarea + execCommand
//   （与 Home.md 闪念「⧉ 复制」按钮同款）。不进 Electron clipboard 模块：navigator 在
//   Obsidian 渲染进程已实测可用，多一条链路多一处版本依赖。
// - 只写文本，不读剪贴板。
// ==============================================

// 复制任务 README 全路径。永不 reject（调用方可以 fire-and-forget）。
async function copyReadmePath(app, readmePath) {
  try {
    const text = fullPathOf(app, readmePath);
    if (!text) return false;
    return await copyText(text);
  } catch {
    return false;
  }
}

// vault 相对路径 → 本地绝对路径。adapter 没有 getFullPath（移动端）或调用抛错时
// 原样返回相对路径——总比什么都不复制有用。
function fullPathOf(app, readmePath) {
  if (!readmePath) return "";
  const adapter = app && app.vault && app.vault.adapter;
  if (!adapter || typeof adapter.getFullPath !== "function") return readmePath;
  try {
    return adapter.getFullPath(readmePath) || readmePath;
  } catch {
    return readmePath;
  }
}

// 写文本：navigator.clipboard 优先，失败（无权限 / 文档未聚焦）落 execCommand。
async function copyText(text) {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(text);
      return true;
    } catch { /* 落到 execCommand 回退 */ }
  }
  return execCommandCopy(text);
}

// 临时 textarea 不入视觉（Home.md 闪念复制同款）。
function execCommandCopy(text) {
  if (typeof document === "undefined" || !document.body) return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

module.exports = { copyReadmePath, fullPathOf, execCommandCopy };
