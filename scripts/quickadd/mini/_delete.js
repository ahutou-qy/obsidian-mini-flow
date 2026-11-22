// ==============================================
// Mini Flow - 删任务时的双链清理（2026-11-19 段 4 从 task-delete.js 下沉）
//
// 两个调用方：QuickAdd 宏 Task Delete（人点，带确认框/Notice）与 CLI `mf.js delete`。
// 差别只在**怎么解析 wiki 链接**：Obsidian 侧有 metadataCache.getFirstLinkpathDest，
// CLI 侧没有索引，只能按路径候选 + basename 兜底。所以解析器由调用方注入，
// **改写循环与判定只有这一份**。
//
// 顺序硬约束（调用方负责，别在这里改）：留底 capture 行的 wiki 降级
// （`_capture-line.js#demoteCaptureLink`）必须发生在**本函数之前**——本函数会把整段
// `[[...|别名]]` 删空（连标题一起丢），降级在先才留得下纯文本标题。
// ==============================================

function isDescendant(file, folder) {
  return String(file.path).startsWith(`${folder.path}/`);
}

function isTargetDestination(destination, targetFile, targetFolder) {
  if (destination.path === targetFile.path) return true;
  return Boolean(targetFolder && (destination.path === targetFolder.path || isDescendant(destination, targetFolder)));
}

// files: [{path}]，由调用方给（Obsidian 用 vault.getMarkdownFiles()，CLI 自己走目录）。
// resolveLink(linkpath, sourcePath) → {path} | null。
// 返回被改写的文件路径数组（调用方报数用）。
async function removeBacklinks(vault, targetFile, targetFolder, resolveLink, files) {
  const changed = [];
  for (const file of files) {
    if (targetFolder && isDescendant(file, targetFolder)) continue;
    if (!targetFolder && file.path === targetFile.path) continue;
    const content = typeof vault.cachedRead === "function"
      ? await vault.cachedRead(file)
      : await vault.read(file);
    const rewritten = String(content).replace(/(!?)\[\[([^\]]+)\]\]/g, (full, embed, inner) => {
      const linkpath = inner.split("#", 1)[0].split("|", 1)[0].trim();
      if (!linkpath) return full;
      const destination = resolveLink(linkpath, file.path);
      if (!destination || !isTargetDestination(destination, targetFile, targetFolder)) return full;
      return "";
    });
    if (rewritten !== content) {
      await vault.modify(file, rewritten);
      changed.push(file.path);
    }
  }
  return changed;
}

// CLI 侧的链接解析器：无 metadataCache，按「相对源文件目录 → vault 根 → 路径后缀 → basename」四档。
// 后缀档是为了吃 capture 风格的短链（`[[11/T/README]]`）——它在 README 里也能出现，
// Obsidian 靠索引按路径后缀解析，相对目录拼不出来。多命中取**路径最短**的一条（稳定、
// 与 Obsidian 的 shortest-path 直觉一致）。只用于判断「这条链接是不是指向被删目标」。
function pathLinkResolver(vault, files) {
  const byBase = new Map();
  for (const f of files) {
    const base = String(f.path).split("/").pop().replace(/\.md$/, "");
    if (!byBase.has(base)) byBase.set(base, f.path);
  }
  const bySuffix = (clean) => {
    const tail = `/${clean}.md`;
    const hits = files.map((f) => f.path).filter((p) => p.endsWith(tail) || p === `${clean}.md`);
    hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
    return hits[0];
  };
  return (linkpath, sourcePath) => {
    const clean = String(linkpath).replace(/\.md$/, "").trim();
    if (!clean) return null;
    const dir = String(sourcePath).split("/").slice(0, -1).join("/");
    const candidates = [`${dir}/${clean}.md`, `${clean}.md`];
    if (clean.includes("/")) candidates.push(bySuffix(clean));
    else candidates.push(byBase.get(clean));
    for (const c of candidates.filter(Boolean)) {
      const f = vault.getAbstractFileByPath(c);
      if (f && !f.children) return f;
    }
    return null;
  };
}

module.exports = { removeBacklinks, pathLinkResolver, isTargetDestination, isDescendant };