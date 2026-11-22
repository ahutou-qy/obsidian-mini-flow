// Mini Flow - Task Delete（单路径，2026-09-14 取消测试任务机制后）：
// 1) 光标在 Capture 行上 → 删当前 capture 行；若能定位到任务文件/夹一并删，清双链。
// 2) 打开的是任务文件本身 → 读 frontmatter source 的 `[[ideas#^cap-xxxx]]` anchor
//    精确删 capture 行，删文件/夹，清双链。
//
// 单一策略：capture 行一律保留作留底事件。
// 老 capture 行可能仍含 `- [ ] ` 前缀（历史测试任务遗留），reader-side wide 兼容解析。
//
// 为什么按 anchor 删 capture 行：capture 行以 `^cap-xxxx` block anchor 结尾，任务文件
// source 字段存了同一 anchor，能精确定位；旧实现拿 buildFileName(标题) 匹配，
// alias/去重后缀/inbox 行会对不上而留孤儿行。任务状态以 Obsidian 为唯一真相，
// 不调用任何外部任务系统。

let buildFileName;
let maxFilenameLength;

// 界面文案查表（阶段 3）。**模块级 `_t`**：入口 load 一次后赋值；未赋值时恒等返回原文。
// 与 task-capture / task-edit / _ui.js / rule-* 同款——避开「局部 const 取不到模块级
// class 里的调用」那个坑（批次 2 实测）。
let _t = (key, fallback) => (fallback === undefined ? key : fallback);

module.exports = async ({ app }) => {
  ({ buildFileName } = await loadMiniHelper(app, "_naming.js"));
  // 文件名上限走配置（与建任务 / 改名同源）；读不到就 undefined → _naming.js 兜底 30。
  // 这里取的是「从 Capture 行反推磁盘名」的上限，必须与建文件时一致，否则找不到任务。
  const cfgMod = await loadMiniHelper(app, "_config.js");
  const cfg = cfgMod && typeof cfgMod.loadFromAdapter === "function"
    ? await cfgMod.loadFromAdapter(app.vault.adapter)
    : null;
  maxFilenameLength = cfg && cfg.behavior ? cfg.behavior.maxFilenameLength : undefined;
  const taskHelpers = await loadMiniHelper(app, "_task.js");
  const lineHelpers = await loadMiniHelper(app, "_capture-line.js");
  const vault = app.vault;
  // 文案表（阶段 3）：load 一次并把查表函数挂到模块级 _t。
  const i18nMod = await loadHelper(vault, "_i18n.js");
  await i18nMod.loadLocale(vault);
  _t = i18nMod.t;

  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice(_t("taskDelete.needCaptureLineOrFile", "请先打开任务 Capture 行或任务文件"));
    return;
  }

  const fromCheckbox = resolveFromCaptureLine(app, lineHelpers);
  if (fromCheckbox) {
    return await deleteByCaptureLine(app, fromCheckbox, taskHelpers, lineHelpers);
  }

  const fromFile = resolveFromFile(vault, activeFile, taskHelpers);
  if (!fromFile) {
    new Notice(_t("taskDelete.notATaskFile", "当前文件不是 Mini Flow 任务文件，且当前行不是 Capture 行"));
    return;
  }

  const content = await vault.cachedRead(fromFile.file);
  if (parseFrontmatterType(content) !== "task" && parseFrontmatterType(content) !== "task-folder") {
    new Notice(`当前文件 type 为 ${parseFrontmatterType(content) || "<none>"}，删除命令只处理 task/task-folder`);
    return;
  }

  const descendantCount = fromFile.folder ? listDescendants(fromFile.folder).length : 0;
  const detail = fromFile.folder ? `任务目录及其中 ${descendantCount} 个文件` : "任务文件";
  const prompt = `确认删除「${fromFile.name}」？\n将删除${detail}，清理指向它的双链；月度 Capture 行保留作为留底事件。\n\n此操作不可撤销。`;
  if (!await confirmDelete(prompt)) return;

  // 留底 capture 行里的 wiki → 纯文本（行留、链接不留）。必须在删文件之前：
  // 定位靠任务 README 的 frontmatter source，文件一删就找不到行了。
  // 也必须在 removeBacklinks 之前：它会把整段 [[...|别名]] 删空（连标题一起丢），
  // 降级在先，留底行就只剩纯文本标题，不剩死链。
  await demoteCaptureLinkLine(app, lineHelpers, taskHelpers, fromFile.file);
  // 任务文件/夹 + 双链必删；capture 行一律保留（2026-09-14 取消测试任务形态分流后）。
  await removeBacklinks(app, fromFile.file, fromFile.folder);
  const taskPath = fromFile.file ? fromFile.file.path : "";
  await warnDanglingFollowers(app.vault, lineHelpers, { taskPath, anchor: anchorFromSource(app, fromFile.file), displayName: fromFile.name });
  // 先关 tab 再删文件：文件一删，leaf.view.file 就不再可靠，取不到路径就关不掉。
  await closeReadmeIfOpen(app, fromFile.file);
  await vault.delete(fromFile.folder || fromFile.file, Boolean(fromFile.folder));
};

// 识别月度 Capture 行：兼容 checkbox 形态（- [ ] / - [x] / - [-] 等旧 Tasks 插件状态）
// 与无 checkbox 形态（- [[...]] #active ... ^cap-xxx）。
function resolveFromCaptureLine(app, lineHelpers) {
  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  if (!editor) return null;
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  if (!lineHelpers || typeof lineHelpers.parseCaptureLine !== "function") return null;
  const parsed = lineHelpers.parseCaptureLine(line, "");
  if (!parsed) return null;
  // 显示名仍走 buildFileName（剥 wiki/标签后取磁盘基名）；文件定位优先用行内 wiki
  // 链接的 linkpath 走 Obsidian 解析——子任务 Capture 行带完整 vault 相对路径
  // （[[flow/data/.../08/父/子]]），根任务则是短链，getFirstLinkpathDest 两种都吃。
  const title = buildFileName(parsed.body, maxFilenameLength);
  const linkMatch = String(parsed.body).match(/\[\[([^\]|#]+)/);
  let target = null;
  if (linkMatch && app.metadataCache && app.workspace.getActiveFile()) {
    const dest = app.metadataCache.getFirstLinkpathDest(linkMatch[1].trim(), app.workspace.getActiveFile().path);
    if (dest && dest.extension === "md") {
      target = dest.basename === "README"
        ? { file: dest, folder: dest.parent }
        : { file: dest, folder: null };
    }
  }
  return title ? {
    editor, cursor, title, target,
    anchor: parsed.anchor,
  } : null;
}

async function deleteByCaptureLine(app, ctx, taskHelpers, lineHelpers) {
  const vault = app.vault;
  const activeFile = app.workspace.getActiveFile();
  // 旧 Capture 行可能没有 wiki 链接（纯文本），回退到任务月目录按名找。
  const target = ctx.target || (() => {
    const tasksDir = taskHelpers.tasksDirForActiveFile(activeFile);
    return findTaskTarget(vault, tasksDir, ctx.title);
  })();
  const hasTaskFile = Boolean(target);

  const message = hasTaskFile
    ? `确认删除「${ctx.title}」？\n将删除任务文件${target.folder ? "夹及其全部内容" : ""}，清理指向它的双链；月度 Capture 行保留作为留底事件。\n\n此操作不可撤销。`
    : `确认移除「${ctx.title}」这个 Capture 行？\n未找到对应任务文件，只删除当前行。`;
  if (!await confirmDelete(message)) return;

  await spliceCurrentLine(activeFile, ctx.editor, ctx.cursor);

  const taskPath = target && target.file ? target.file.path : "";
  if (target) {
    await removeBacklinks(app, target.file, target.folder);
    // 同上：先关 tab 再删文件（文件一删就取不到 leaf 的路径了）。
    await closeReadmeIfOpen(app, target.file);
    await vault.delete(target.folder || target.file, Boolean(target.folder));
  }
  await warnDanglingFollowers(vault, lineHelpers, { taskPath, anchor: ctx.anchor, displayName: ctx.title });
  if (!hasTaskFile) new Notice(`已移除任务：${ctx.title}`);
}

async function spliceCurrentLine(file, editor, cursor) {
  const vault = file.vault;
  const content = await vault.read(file);
  const lines = content.split("\n");
  const idx = cursor.line;
  if (idx < 0 || idx >= lines.length) {
    new Notice(_t("taskDelete.lineIndexOutOfRange", "当前行索引越界，已跳过"));
    return;
  }
  // 兼容老 checkbox 形态；捕获删除判定 = 任意 - 起首（checkbox 或无 checkbox 形态都行）。
  const line = lines[idx];
  if (!/^\s*-\s/.test(line)) {
    new Notice(_t("taskDelete.notCaptureLine", "当前行不是 Capture 行，已跳过"));
    return;
  }
  let removeCount = 1;
  // 后跟空行且下一行不是新任务行 → 把空行也吃掉，避免留空行。
  if (lines[idx + 1] !== undefined && /^\s*$/.test(lines[idx + 1]) && (idx + 2 >= lines.length || !/^\s*-\s/.test(lines[idx + 2]))) {
    removeCount = 2;
  }
  lines.splice(idx, removeCount);
  await vault.modify(file, lines.join("\n"));
}

// 从任务文件 source frontmatter 取 capture 锚点（删任务时用来找悬空 follows）。
function anchorFromSource(app, taskFile) {
  const source = readFrontmatterField(app, taskFile, "source");
  if (!source) return null;
  const m = String(source).match(/\[\[[^\]]+#\^([^\]]+)\]\]/);
  return m ? m[1] : null;
}

// 删完任务后，若有其它 capture 行 follows 指向它，告警但不自动改边（手写因果边，
// 自动删会丢信息；交给人判断改指向还是删边）。兼容新式直指任务文件和旧式事件锚点。
async function warnDanglingFollowers(vault, lineHelpers, { taskPath, anchor, displayName }) {
  if (!lineHelpers || typeof lineHelpers.findFollowers !== "function") return;
  const followers = await lineHelpers.findFollowers(vault, { taskPath, anchor });
  if (!followers.length) return;
  const list = followers.slice(0, 5).map((f) => f.title).join("、");
  const more = followers.length > 5 ? ` 等 ${followers.length} 个` : "";
  new Notice(`「${displayName}」被 ${followers.length} 个后续事件 follows：${list}${more}，因果边已悬空，请手动处理`, 6000);
}

// 识别任务月目录树下任意深度的任务文件：
// - 任意深度的 README → folder 节点（根 folder，或已升级成 folder 的子任务）
// - 任意深度的普通 .md → 单文件（月目录根散任务，或 folder 内的子任务）
// folder 内无 type 的过程文档由调用方按 frontmatter type 拦住，不在这里判。
function resolveFromFile(vault, file, taskHelpers) {
  if (!taskHelpers.isInTaskTree(file.path)) return null;
  if (file.basename === "README" && file.parent) {
    return { file, folder: file.parent, name: file.parent.name };
  }
  return { file, folder: null, name: file.basename };
}

// 入参 title 已经是 buildFileName 结果（磁盘文件名形式）；
// 直接拼路径，不再二次转换。
function findTaskTarget(vault, tasksPath, title) {
  const simple = vault.getAbstractFileByPath(`${tasksPath}/${title}.md`);
  if (simple) return { file: simple, folder: null };
  const folder = vault.getAbstractFileByPath(`${tasksPath}/${title}`);
  const readme = vault.getAbstractFileByPath(`${tasksPath}/${title}/README.md`);
  return folder && readme ? { file: readme, folder } : null;
}

function listDescendants(folder) {
  const files = [];
  const visit = node => {
    for (const child of node.children || []) {
      if (child.children) visit(child);
      else files.push(child);
    }
  };
  visit(folder);
  return files;
}

// 双链清理的循环与判定已下沉到 `_delete.js#removeBacklinks`（CLI `mf.js delete` 共用），
// 这里只注入 Obsidian 的链接解析器（metadataCache）。
async function removeBacklinks(app, targetFile, targetFolder) {
  const vault = app.vault;
  const metadataCache = app.metadataCache;
  if (!metadataCache || typeof metadataCache.getFirstLinkpathDest !== "function") return;
  const del = await loadMiniHelper(app, "_delete.js");
  const files = typeof vault.getMarkdownFiles === "function" ? vault.getMarkdownFiles() : [];
  await del.removeBacklinks(
    vault, targetFile, targetFolder,
    (linkpath, sourcePath) => metadataCache.getFirstLinkpathDest(linkpath, sourcePath),
    files);
}

// 留底 capture 行里的 wiki 链接 → 纯文本。
//
// 行按设计保留作事件留底（见文件头「单一策略」），但目标文件已经删了，
// 留着 [[...]] 就是死链：Home 里点它，Obsidian 判「链接不存在」会新建空笔记
// （短链 `MM/<名>/README` 解析不到时还会落到 vault 根，造出一个假月目录）。
// 必须在删任务文件之前调用——定位靠任务 README 的 frontmatter source 锚点。
async function demoteCaptureLinkLine(app, lineHelpers, taskHelpers, taskFile) {
  if (!lineHelpers || typeof lineHelpers.resolveCaptureFromSource !== "function") return false;
  if (typeof lineHelpers.demoteCaptureLink !== "function") return false;
  const hit = await lineHelpers.resolveCaptureFromSource(app, taskFile, taskHelpers);
  if (!hit || !hit.file) return false;
  const content = await app.vault.read(hit.file);
  const lines = content.split("\n");
  let idx = Number.isInteger(hit.lineIdx) ? hit.lineIdx : -1;
  if (idx < 0 || idx >= lines.length || !String(lines[idx]).includes(`^${hit.anchor}`)) {
    idx = lines.findIndex((l) => String(l).includes(`^${hit.anchor}`));
  }
  if (idx < 0 || idx >= lines.length) return false;
  const next = lineHelpers.demoteCaptureLink(lines[idx]);
  if (!next || next === lines[idx]) return false;
  lines[idx] = next;
  await app.vault.modify(hit.file, lines.join("\n"));
  return true;
}

function parseFrontmatterType(content) {
  const match = String(content).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find(item => /^[ \t]*type[ \t]*:/.test(item));
  return line ? line.replace(/^[ \t]*type[ \t]*:[ \t]*/, "").trim().replace(/^['"]|['"]$/g, "").toLowerCase() : null;
}

function readFrontmatterField(app, file, field) {
  const cache = app.metadataCache && app.metadataCache.getFileCache(file);
  const value = cache && cache.frontmatter && cache.frontmatter[field];
  return value ? String(value) : null;
}

function confirmDelete(message) {
  return Promise.resolve(window.confirm(message));
}

// QuickAdd 的 script 上下文里 window.require 不能解析相对路径；
// 把 mini 目录下的 helper 当字符串读进来，用 Function 构造一个临时 module 取 exports。
// 删掉任务后关掉展示该 README 的 tab。**复用 task-finish-gui.js 的同一份实现**
// （`module.exports.closeReadmeLeaf`）——含「被关掉的正是当前活动页就回 Home」的判据，
// 不在这里另写一份：什么算活动页、要不要回 Home 各有一套，两份必然漂。
async function closeReadmeIfOpen(app, file) {
  if (!file) return;
  try {
    const finishGui = await loadMiniHelper(app, "task-finish-gui.js");
    if (finishGui && typeof finishGui.closeReadmeLeaf === "function") {
      await finishGui.closeReadmeLeaf(app, file);
    }
  } catch (e) {
    // 关 tab 失败**不影响删除结果**——任务该删还是删。但要让用户看见，别静默。
    console.error("[task-delete] 关 README tab 失败:", e);
    new Notice(`关 README tab 失败：${(e && e.message) || e}`, 5000);
  }
}

async function loadMiniHelper(app, name) {
  const src = await app.vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
