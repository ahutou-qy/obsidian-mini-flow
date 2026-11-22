// ==============================================
// MVP - CLI 删任务盘面（2026-11-19 段 4，`mf.js delete` 的实现层）
//
// 与 GUI（QuickAdd 宏 Task Delete）**同一策略**：
//   1. 月度 Capture 行**保留**作留底事件，行内 wiki 降级为纯文本
//      （`_capture-line.js#demoteCaptureLink`，与 GUI 同一个纯函数）；
//   2. 清理指向该任务的双链（`_delete.js#removeBacklinks`，与 GUI 同一个循环，
//      只换链接解析器：CLI 没有 metadataCache，用路径候选 + basename 兜底）；
//   3. 删任务文件/目录。
//
// **顺序不可换**：降级必须在清双链之前——后者把整段 `[[...|别名]]` 删空（连标题一起丢）；
// 也必须在删文件之前——定位月度行靠 README frontmatter 的 source 锚点。
//
// 与 GUI 的差别（已知、有意）：
//   - 无二次确认（CLI 由调用方负责确认，同 headless 结案）；
//   - 不发 Notice、不关 tab；
//   - 悬空因果边只**报数**返回（GUI 弹 Notice），由调用方决定怎么处理。
// ==============================================

const fs = require("node:fs");
const path = require("node:path");

const MINI = path.resolve(__dirname, "..", "quickadd", "mini");
const lineHelpers = require(path.join(MINI, "_capture-line.js"));
const delHelpers = require(path.join(MINI, "_delete.js"));
const { extractFrontmatter, extractSource, findIdeasFile, findAnchorLine, SetStatusError } = require("./_set-status.js");

// CLI 侧扫哪些 md 找双链：flow/ 全树 + vault 根一层 md（Home.md 等）。
// 跳过任务的 input/（外部原始输入，可能有第三方 SDK 上千文件）、.git、node_modules、big/。
function collectMarkdownFiles(vaultRoot) {
  const out = [];
  const SKIP = new Set([".git", "node_modules", "big", "input", ".obsidian", ".trash"]);
  const walk = (rel, depth) => {
    const abs = path.join(vaultRoot, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        if (depth > 12) continue;
        walk(child, depth + 1);
      } else if (e.name.endsWith(".md")) {
        out.push({ path: child });
      }
    }
  };
  walk("flow", 0);
  for (const e of fs.readdirSync(vaultRoot, { withFileTypes: true })) {
    if (!e.isDirectory() && e.name.endsWith(".md")) out.push({ path: e.name });
  }
  return out;
}

// {ok, deleted, demoted, backlinksCleaned, followers}
async function deleteTask({ vaultRoot, taskPath, vault }) {
  const readmePath = path.join(taskPath, "README.md");
  const singleFile = fs.existsSync(readmePath) ? null : `${taskPath}.md`;
  const targetFilePath = fs.existsSync(readmePath) ? readmePath : singleFile;
  if (!targetFilePath || !fs.existsSync(targetFilePath)) {
    throw new SetStatusError(2, `任务文件不存在：${readmePath}（也没有 ${singleFile}）`);
  }
  const rel = (p) => path.relative(vaultRoot, p).replace(/\\/g, "/");
  const targetRel = rel(targetFilePath);
  const targetFile = vault.getAbstractFileByPath(targetRel);
  const isFolder = targetRel.endsWith("/README.md");
  const folderRel = isFolder ? targetRel.replace(/\/README\.md$/, "") : null;
  const targetFolder = folderRel ? vault.getAbstractFileByPath(folderRel) : null;

  const text = fs.readFileSync(targetFilePath, "utf8");
  const fm = extractFrontmatter(text);
  const source = fm ? extractSource(fm) : null;

  // 1. 留底行降级（定位靠 source 锚点，必须在删文件前）。
  let demoted = false;
  let ideasPath = null;
  let anchor = null;
  if (source) {
    const hits = findIdeasFile(vaultRoot, source.file);
    if (hits.length === 1) {
      ideasPath = hits[0];
      anchor = source.anchor;
      const content = fs.readFileSync(ideasPath, "utf8");
      const lines = content.split("\n");
      const idx = findAnchorLine(content, anchor);
      if (idx >= 0) {
        const next = lineHelpers.demoteCaptureLink(lines[idx]);
        if (next && next !== lines[idx]) {
          lines[idx] = next;
          fs.writeFileSync(ideasPath, lines.join("\n"), "utf8");
          demoted = true;
        }
      }
    }
  }

  // 2. 清双链（降级之后、删文件之前）。
  const files = collectMarkdownFiles(vaultRoot);
  const resolver = delHelpers.pathLinkResolver(vault, files);
  const backlinksCleaned = await delHelpers.removeBacklinks(
    vault, targetFile, targetFolder, resolver, files);

  // 3. 悬空因果边（只报数，不改别的任务）。
  let followers = [];
  if (anchor && typeof lineHelpers.findFollowers === "function") {
    try {
      const found = await lineHelpers.findFollowers(vault, { taskPath: targetRel, anchor });
      followers = Array.isArray(found) ? found.map((f) => f.anchor || f.title || String(f)) : [];
    } catch { followers = []; }
  }

  // 4. 删文件/目录。
  await vault.delete(targetFolder || targetFile, Boolean(targetFolder));

  return {
    ok: true,
    deleted: targetFolder ? folderRel : targetRel,
    demoted,
    captureLineKept: Boolean(ideasPath),
    backlinksCleaned,
    followers,
  };
}

module.exports = { deleteTask, collectMarkdownFiles };