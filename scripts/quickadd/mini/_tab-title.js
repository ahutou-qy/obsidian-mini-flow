// ==============================================
// Mini Flow - folder 任务 README 的显示标题
//
// Obsidian 的 tab 标题、视图头部标题、窗口标题都走 `FileView#getDisplayText()`，
// 而 FileView 的实现恒为 `file.basename`——folder 任务的入口文件一律叫 README.md，
// 于是同时开几个任务就有几个一模一样的 `README` tab，靠标题区分不了任务。
//
// 文件名是现状数据（82+ 个任务目录、脚本与 外部同步 CLI 全按 `<任务目录>/README.md` 写死），
// 标题是渲染出口：在出口处把「任务根 README」映射成任务目录名，不动盘面。
// 本文件只放这条映射的纯函数，裸 node 可测；原型 patch 在 miniflow 插件里。
//
// 判据（`_task.js#taskFolderPrefixOf` 认任务根，排除 <月目录>/W<周>/ 周记）：
// - `<月目录>/<任务>/README.md`            → `<任务>`
// - `<月目录>/<任务>/<子目录>/README.md`    → `<任务>/<子目录>`
// - 其它文件（含月目录自身的 README）      → ""（保持 Obsidian 默认 basename）
// ==============================================

function taskLabelForReadmeFile(file, taskFolderPrefixOf) {
  const basename = String((file && file.basename) || "");
  if (basename !== "README" || typeof taskFolderPrefixOf !== "function") return "";
  const parentPath = String((file && file.parentPath) || "");
  if (!parentPath) return "";
  const prefix = taskFolderPrefixOf(parentPath);
  if (!prefix) return "";
  const name = prefix.slice(prefix.lastIndexOf("/") + 1);
  if (!name) return "";
  if (parentPath === prefix) return name;
  // 任务目录内更深一层的 README（如 design/README.md）：带上级路径，避免又一个同名 tab。
  const rest = parentPath.slice(prefix.length + 1);
  return rest ? `${name}/${rest}` : name;
}

module.exports = {
  taskLabelForReadmeFile,
};
