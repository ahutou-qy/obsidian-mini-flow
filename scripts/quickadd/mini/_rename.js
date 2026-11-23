// ==============================================
// Mini Flow - 任务改名共享原语
//
// task-edit（编辑弹框里改标题）专用原语：三处写入
//   1. 任务文件正文 H1（完整标题，不受文件名长度限制）
//   2. 磁盘名（单文件 .md / folder 目录，走 buildFileName 的 30 字截断与撞名后缀）
//   3. ideas 月度文件 capture 行的 alias（[[target|显示标题]]）
//
// 为什么 alias 要自己改：Obsidian 的 fileManager.renameFile 会全库自动更新双链的
// target，但保留 alias 文本（冒烟验证）。capture 行用 alias 显示完整标题，
// 不手动改就会一直显示旧标题。
//
// 为什么不在此刷 folder 的 ## 文件索引：miniflow 插件监听 vault.on("rename")，
// 去抖 400ms 后按新路径重写哨兵段。插件被禁用时由调用方提示手动 task-refresh-index，
// 这里不立即 walk（踩 flow/CLAUDE.md 记录的 createFolder 后 stale cache 坑）。
//
// 边界：capture 行的 ^anchor 是稳定主键，改名不变；不写 frontmatter（无 title 字段）。
// 调用方需保证改名前关闭任务文件的活动 editor（renameFile 对正在编辑的文件可能失败）。
// ==============================================

// 核心改名：按 newTitle 改 H1、磁盘名、capture alias。磁盘名截断后没变（长标题）
// 时跳过 renameFile，H1/alias 照常更新。返回 { renamed, isFolder } 供调用方决定提示。
// opts.target = { file, folder }（folder 非空即目录任务）；
// opts.capture = { file, anchor, lineIdx? }（无 capture 时只改文件本身）。
async function applyRename(app, { target, capture, newTitle, tasksDir }) {
  const vault = app.vault;
  const naming = await loadMiniHelper(app, "_naming.js");
  // 文件名上限与建任务**同源**（behavior.maxFilenameLength）——不同源会让改名后的磁盘名
  // 与月度行别名对不上。读不到就 undefined → _naming.js 用默认 30 兜底。
  const cfgMod = await loadMiniHelper(app, "_config.js");
  const cfg = cfgMod && typeof cfgMod.loadFromAdapter === "function"
    ? await cfgMod.loadFromAdapter(vault.adapter)
    : null;
  const maxLen = cfg && cfg.behavior ? cfg.behavior.maxFilenameLength : undefined;
  const oldDiskName = target.folder ? target.folder.name : target.file.basename;
  const newDiskName = naming.buildFileName(newTitle, maxLen);

  let newPath = null;
  if (newDiskName !== oldDiskName) {
    if (target.folder) {
      newPath = `${tasksDir}/${findUniqueFolderName(vault, tasksDir, newDiskName, naming, maxLen)}`;
    } else {
      newPath = naming.findUniquePath(vault, tasksDir, newDiskName, maxLen).createPath;
    }
  }

  // 先改 H1（路径未变，按旧路径读写），再改名，最后 alias。renameFile 动了双链
  // target 但没动 alias，按 anchor 重新定位行只替换 alias，不动标签/勾选态/锚点。
  await rewriteH1(vault, target.file, newTitle);
  if (newPath) {
    await app.fileManager.renameFile(target.folder || target.file, newPath);
  }
  if (capture) {
    await rewriteCaptureAlias(vault, capture, newTitle);
  }
  return { renamed: Boolean(newPath), isFolder: Boolean(target.folder) };
}

// 从 capture 行的 link target 反查要改名的任务文件/目录。
// 全路径链接（folder README，形如 .../08/名/README）按路径取；单文件短链（[[名]]）
// 借 Obsidian 的 linkpath 解析（随 rename 维护，不手拼月目录）。
function resolveTargetFromLink(app, linkTarget, sourceFile) {
  if (!linkTarget) return null;
  const vault = app.vault;
  let file = null;
  if (linkTarget.includes("/")) {
    file = vault.getAbstractFileByPath(`${linkTarget}.md`);
  } else if (app.metadataCache && app.metadataCache.getFirstLinkpathDest) {
    file = app.metadataCache.getFirstLinkpathDest(linkTarget, sourceFile && sourceFile.path);
  }
  if (!file || file.children) return null;
  if (file.basename === "README" && file.parent) {
    return { file, folder: file.parent };
  }
  return { file, folder: null };
}

async function rewriteH1(vault, file, newTitle) {
  const content = await vault.read(file);
  const m = content.match(/^#\s+(.+)$/m);
  if (!m) return; // 旧任务可能没有 H1，跳过而非强行插入
  if (m[1].trim() === newTitle) return;
  const rewritten = content.replace(/^#\s+.+$/m, `# ${newTitle}`);
  if (rewritten !== content) await vault.modify(file, rewritten);
}

// 按行尾 anchor 定位 capture 行，替换（或补上）alias。anchor / 标签 / 勾选态都在
// anchor 之前或就是 anchor 本身，正则只动 [[...]] 内部，不碰它们。
async function rewriteCaptureAlias(vault, capture, newTitle) {
  const content = await vault.read(capture.file);
  const lines = content.split("\n");
  const idx = capture.lineIdx != null && lines[capture.lineIdx] && lines[capture.lineIdx].includes(`^${capture.anchor}`)
    ? capture.lineIdx
    : lines.findIndex(l => l.includes(`^${capture.anchor}`) && /^\s*-\s/.test(l));
  if (idx < 0) return;

  const line = lines[idx];
  const rewritten = line.replace(/(!?)\[\[([^\]]+)\]\]/, (full, embed, inner) => {
    if (embed) return full;
    // inner 形如 "target" / "target|alias" / "target#h|alias"。第一个 | 之前是 target，
    // 之后整段是旧 alias 直接丢弃，不切会累积成 "target|旧|新"。
    const pipeIdx = inner.indexOf("|");
    const target = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
    return `[[${target}|${newTitle}]]`;
  });
  if (rewritten === line) return;
  lines[idx] = rewritten;
  await vault.modify(capture.file, lines.join("\n"));
}

// 文件夹版撞名处理，逻辑对齐 _naming.js#findUniquePath，只是没有 .md 后缀。
// maxLen 由调用方传配置值（与 buildFileName / findUniquePath 同源）；不传退回
// naming.MAX_FILENAME_LENGTH，保证三条路径的上限一致。
function findUniqueFolderName(vault, dirPath, stem, naming, maxLen) {
  const limit = maxLen === undefined ? naming.MAX_FILENAME_LENGTH : maxLen;
  const fit = (suffix) => {
    const combined = suffix ? `${stem}${suffix}` : stem;
    if (combined.length <= limit) return combined;
    const budget = limit - suffix.length;
    return naming.truncateSmart(stem, budget) + suffix;
  };
  const direct = fit("");
  if (!vault.getAbstractFileByPath(`${dirPath}/${direct}`)) return direct;
  for (let i = 2; i < 1000; i++) {
    const candidate = fit(`-${i}`);
    if (!vault.getAbstractFileByPath(`${dirPath}/${candidate}`)) return candidate;
  }
  throw new Error(`无法为 ${stem} 生成唯一文件夹名（已尝试到 -999）`);
}

async function loadMiniHelper(app, name) {
  const src = await app.vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

module.exports = {
  applyRename,
  resolveTargetFromLink,
  rewriteH1,
  rewriteCaptureAlias,
  findUniqueFolderName,
};
