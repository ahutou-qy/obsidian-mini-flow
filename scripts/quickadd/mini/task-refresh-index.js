// Mini Flow - Task Refresh Index：扫 folder 任务下所有文件，重写 README 的自动索引段。
// 平时由 miniflow 插件在打开文件 / 文件增删时静默跑；本脚本是手动补刷入口
// （典型：插件加载前就开着 README、或 README 正被编辑时插件自动跳过）。
//
// 入口两种：
// 1) 光标在 checkbox 行 → 解析任务名 → 若已升级为 folder 就刷新
// 2) 当前打开的文件在 flow/data/YYYY/Qn/MM/<name>/ 内 → 用最外层 folder 定位
//
// 只重写 README.md 里 <!-- auto-index:start --> ... <!-- auto-index:end --> 之间的内容；
// 找不到哨兵时补一段完整 `## 文件索引`，插在 `## 内化` 之后（或旧 `## 输出`/`## 进展`/`## 过程` 段末，或末尾）。
// 旧 README 可能含 `## AI 上下文` 段（2026-08-20 已下线，迁移脚本会清），优先级仍兼容。
// 手写的 `## 目录结构` 段完全不动——那段承担"为什么这么组织"的说明，索引只列结构。

let buildFileName, buildIndexBody, replaceOrInsertIndex, taskHelpers, maxFilenameLength;

module.exports = async ({ app }) => {
  ({ buildFileName } = await loadNamingHelpers(app));
  // 文件名上限走配置（与建任务同源）；读不到就 undefined → _naming.js 兜底 30。
  const cfgMod = await loadConfigHelpers(app);
  const cfg = cfgMod && typeof cfgMod.loadFromAdapter === "function"
    ? await cfgMod.loadFromAdapter(app.vault.adapter)
    : null;
  maxFilenameLength = cfg && cfg.behavior ? cfg.behavior.maxFilenameLength : undefined;
  ({ buildIndexBody } = await loadWalkHelpers(app));
  ({ replaceOrInsertIndex } = await loadIndexHelpers(app));
  taskHelpers = await loadTaskHelpers(app);

  const fromCheckbox = resolveTaskFolderFromCheckbox(app);
  if (fromCheckbox) {
    if (!fromCheckbox.folder) {
      new Notice(`未找到对应 folder 任务：${fromCheckbox.title}（可能还没升级）`);
      return;
    }
    return await refreshIndex(app, fromCheckbox.folder);
  }

  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice("请先打开 folder 任务里任意文件，或把光标放到 checkbox 行上");
    return;
  }
  const folder = findEnclosingTaskFolder(activeFile);
  if (!folder) {
    new Notice(`当前文件不在 folder 任务目录内：${activeFile.path}`);
    return;
  }
  await refreshIndex(app, folder);
};

async function refreshIndex(app, taskFolder) {
  const vault = app.vault;
  const readmePath = `${taskFolder.path}/README.md`;
  const readme = vault.getAbstractFileByPath(readmePath);
  if (!readme) {
    new Notice(`folder 任务缺 README：${readmePath}`);
    return;
  }
  const indexBody = buildIndexBody(taskFolder);
  const oldContent = await vault.read(readme);
  const newContent = replaceOrInsertIndex(oldContent, indexBody);
  if (newContent === oldContent) {
    new Notice(`文件索引已是最新：${readmePath}`);
    return;
  }
  await vault.modify(readme, newContent);
  new Notice(`已刷新文件索引：${readmePath}`);
}

// checkbox 入口：跟 task-upgrade 对齐，走 buildFileName 得到磁盘文件名。
function resolveTaskFolderFromCheckbox(app) {
  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  if (!editor) return null;
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  const match = String(line).match(/^\s*- \[[ xXoO\/>-]\]\s*(.*)$/);
  if (!match) return null;
  const title = buildFileName(match[1], maxFilenameLength);
  if (!title) return null;
  const activeFile = app.workspace.getActiveFile();
  const folderPath = `${taskHelpers.tasksDirForActiveFile(activeFile)}/${title}`;
  const folder = app.vault.getAbstractFileByPath(folderPath);
  return { title, folder: folder && Array.isArray(folder.children) ? folder : null };
}

// 找当前文件所在的 folder 任务根：一路往上直到路径落在 <月目录>/<名> 这一层。
function findEnclosingTaskFolder(file) {
  let cur = file.parent;
  while (cur) {
    if (taskHelpers.taskFolderPrefixOf(cur.path) === cur.path) return cur;
    cur = cur.parent;
  }
  return null;
}

// 与其它 mini 脚本一致：把 _naming.js 当字符串加载，避免 QuickAdd 沙盒里 require 相对路径。
async function loadNamingHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_naming.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _config.js：behavior.maxFilenameLength 的唯一读取入口。
// 被字符串加载的脚本不能 require 同目录文件，只能走 adapter（见 _config.js 头注）。
async function loadConfigHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_config.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 跟 loadNamingHelpers 同模式，加载 _walk.js。task-upgrade 升级时和本脚本都靠 buildIndexBody
// 扫 folder children 生成索引；提一份避免两处实现漂移。
async function loadWalkHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_walk.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _index.js：哨兵常量与替换/插入段逻辑，与 miniflow 插件共用。
async function loadIndexHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_index.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _task.js：任务月目录/folder 根的路径判定，与各命令脚本和插件共用同一正则。
async function loadTaskHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_task.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
