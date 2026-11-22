// ==============================================
// Mini Flow - Open Finder：在访达 / 资源管理器里打开当前文件所属任务的根目录。
//
// 行为：
// - 取当前活动文件，沿父目录往上找到 folder 任务根（<月目录>/<名>/，即含
//   README.md + input/process/output/ 那一层），在文件管理器里打开该目录。
// - 当前文件不在任务树（或在任务根之外的普通笔记）时，退化为打开文件所在目录。
// - folder 判定复用 _task.js 的 taskFolderPrefixOf，和 task-refresh-index /
//   miniflow 插件走同一套正则，避免各脚本各写一份路径规则。
//
// 边界：
// - 仅桌面端（window.require 存在）。iOS 静默提示。
// - 路径可能含空格/中文，execFile 直接传 argv 不经 shell，无需转义。
// - 周记目录 <月目录>/W<周>/ 被 taskFolderPrefixOf 排除，会退化为文件父目录。
// - 文件管理器按平台分流：macOS 走 /usr/bin/open，Windows 走 explorer.exe。
//   Windows 侧不能把非 0 退出码当失败——explorer.exe 复用已有进程时即使成功
//   也返回 1，照搬 execFile 的错误分支会每次弹「打开失败」。
// ==============================================

const nodeRequire =
  typeof window !== "undefined" && typeof window.require === "function"
    ? window.require
    : null;

let taskHelpers;

module.exports = async ({ app }) => {
  if (!nodeRequire) {
    new Notice("Open Finder：仅桌面端可用", 4000);
    return;
  }

  const active = app.workspace.activeEditor || app.workspace.activeLeaf;
  const file = active && active.file;
  if (!file) {
    new Notice("Open Finder：没有活动文件，先打开一个笔记", 4000);
    return;
  }

  const adapter = app.vault.adapter;
  if (typeof adapter.getFullPath !== "function") {
    new Notice("Open Finder：当前 vault 不支持本地路径", 4000);
    return;
  }

  taskHelpers = taskHelpers || (await loadTaskHelpers(app));
  const targetDir = resolveTargetDir(file, taskHelpers);
  const fullPath = adapter.getFullPath(targetDir);

  const { execFile } = nodeRequire("child_process");
  const isWin = nodeRequire("os").platform() === "win32";
  // explorer.exe 收绝对路径即可；路径已由 adapter.getFullPath 转成本地形态，
  // 直接作单个 argv 传，不经 shell，含 & % 等字符也安全。
  execFile(
    isWin ? "explorer.exe" : "/usr/bin/open",
    [fullPath],
    { timeout: 8000 },
    (err, stdout, stderr) => {
      if (!err) return;
      // Windows：err.code 是数字时表示进程正常起、只是退出码非 0——explorer 复用在跑的
      // 实例时就这么报，不代表打开失败，忽略。进程压根没起来（ENOENT 等）才是真失败。
      if (isWin && typeof err.code === "number") return;
      const detail = (stderr || err.message || String(err)).trim().slice(0, 200);
      new Notice(`Open Finder 失败：${detail}`, 6000);
    }
  );
};

// 找当前文件所属的 folder 任务根：一路往上直到路径落在 <月目录>/<名> 这一层。
// 找不到（不在任务树 / 周记 / 任务根之外的普通笔记）返回文件直接父目录。
function resolveTargetDir(file, helpers) {
  let cur = file.parent;
  while (cur) {
    if (helpers.taskFolderPrefixOf(cur.path) === cur.path) return cur.path;
    cur = cur.parent;
  }
  return file.parent ? file.parent.path : "";
}

// 与其它 mini 脚本一致：把 _task.js 当字符串加载，避开 QuickAdd 沙盒对相对
// require 的限制。
async function loadTaskHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_task.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
