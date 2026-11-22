// ==============================================
// Mini Flow - fsVault：文件系统版 vault 适配器（standalone，不依赖 Obsidian runtime）
//
// `_capture.js` / `_task.js` / `_workflow.js` 的注释早就写明「Obsidian app.vault（async）
// 或 fsVault（同步），一律 await，两种都吃得下」：`_task.js#readVaultText` 会在没有
// `vault.adapter` 时回落到 `vault.read(路径字符串)`。但 fsVault 的实现随 2026-08 的
// CLI 入口一起删了，本文件把它补回来，供 `mvp/agent-capture.js` 使用。
//
// 形状对齐 Obsidian 用到的子集：
//   getAbstractFileByPath(rel) -> null | {path, name, basename, extension, parent, children?}
//   create(rel, content)       -> file 对象
//   createFolder(rel)          -> folder 对象
//   read(fileOrPath)           -> 文本（同时接受对象与路径字符串）
//   modify(fileOrPath, content)
//
// `parent` 是 2026-11-19 补的（段 2）：`_finish.js#ensureProcessHistory` 用
// `readme.parent.path` 拼 `process/R-进展历史.md`，缺 parent 时它 `if (!readmeDir) return`
// **静默 no-op**——归档看起来接上了其实一条没搬。惰性 getter，与 children 同款。
//
// 同步实现、接口保持 async 兼容（调用方一律 await）。路径一律 vault 相对路径、`/` 分隔。
// ==============================================

const fs = require("node:fs");
const path = require("node:path");

function createFsVault(vaultRoot) {
  const root = path.resolve(vaultRoot);

  const normalize = (rel) =>
    String(rel == null ? "" : rel).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const abs = (rel) => path.join(root, normalize(rel));
  const pathOf = (fileOrPath) =>
    typeof fileOrPath === "string" ? normalize(fileOrPath) : normalize(fileOrPath && fileOrPath.path);

  function entry(rel, st) {
    const name = path.posix.basename(rel);
    const isDir = st.isDirectory();
    const out = {
      path: rel,
      name,
      basename: isDir ? name : name.replace(/\.[^./]+$/, ""),
      extension: isDir ? "" : path.posix.extname(name).replace(/^\./, ""),
      stat: { ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size },
    };
    if (isDir) {
      // 惰性 + 记忆化：`!child.children` 是调用方区分文件/目录的判据，getter 读一次即够；
      // 急切递归会把 domains/ 或月目录整棵子树走一遍（每次 getAbstractFileByPath 都走）。
      let children;
      Object.defineProperty(out, "children", {
        enumerable: true,
        get() {
          if (!children) children = readChildren(rel);
          return children;
        },
      });
    }
    // parent：vault 根一层文件的 parent 给 null（Obsidian 给根 folder，但 Mini Flow 的
    // 用法都是任务目录下的 README，根一层没有正当落点，给 null 让调用方走 no-op 分支）。
    let parent;
    let parentDone = false;
    Object.defineProperty(out, "parent", {
      enumerable: true,
      get() {
        if (!parentDone) {
          const dir = path.posix.dirname(rel);
          parent = dir && dir !== "." && dir !== "/" ? getAbstractFileByPath(dir) : null;
          parentDone = true;
        }
        return parent;
      },
    });
    return out;
  }

  // folder 的 children 列表（真正递归一次，深度按需；Mini Flow 只用到 domains/ 与 topics/ 一层）。
  function readChildren(rel) {
    let dirs;
    try {
      dirs = fs.readdirSync(abs(rel), { withFileTypes: true });
    } catch {
      return [];
    }
    return dirs.map((d) => entry(rel ? `${rel}/${d.name}` : d.name, d));
  }

  function getAbstractFileByPath(rel) {
    const clean = normalize(rel);
    if (!clean) return null;
    try {
      return entry(clean, fs.statSync(abs(clean)));
    } catch {
      return null;
    }
  }

  async function create(rel, content) {
    const clean = normalize(rel);
    fs.mkdirSync(path.dirname(abs(clean)), { recursive: true });
    fs.writeFileSync(abs(clean), String(content == null ? "" : content), "utf8");
    return getAbstractFileByPath(clean);
  }

  async function createFolder(rel) {
    const clean = normalize(rel);
    fs.mkdirSync(abs(clean), { recursive: true });
    return getAbstractFileByPath(clean);
  }

  async function read(fileOrPath) {
    return fs.readFileSync(abs(pathOf(fileOrPath)), "utf8");
  }

  async function modify(fileOrPath, content) {
    const clean = pathOf(fileOrPath);
    fs.mkdirSync(path.dirname(abs(clean)), { recursive: true });
    fs.writeFileSync(abs(clean), String(content == null ? "" : content), "utf8");
    return getAbstractFileByPath(clean);
  }

  // adapter.list 的形状：{files:[vault 相对路径], folders:[同]}。
  // `_capture-line.js#listDir` 先探 vault.list 再探 adapter.list，两个都没有就返回空目录 →
  // listMonthFiles 扫不到任何月度文件 → listRecentTasks 恒空（2026-11-19 段 3 补，
  // 与 parent 同型的「适配器缺一个方法 → 上层静默空结果」）。目录不存在给空，不抛。
  async function list(rel) {
    const clean = normalize(rel);
    let entries;
    try {
      entries = fs.readdirSync(abs(clean), { withFileTypes: true });
    } catch {
      return { files: [], folders: [] };
    }
    const files = [];
    const folders = [];
    for (const e of entries) {
      const p = clean ? `${clean}/${e.name}` : e.name;
      if (e.isDirectory()) folders.push(p);
      else files.push(p);
    }
    return { files, folders };
  }

  // 删除（CLI `mf.js delete` 用）。Obsidian 的 `vault.delete(file, recursive)` 语义：
  // 目录要给 recursive=true 才连带内容删。**这是本适配器唯一的破坏性方法**，
  // 调用方只应传已确认的任务文件/目录；不做 trash（CLI 侧没有 Obsidian 的 .trash）。
  async function deleteEntry(fileOrPath, recursive = false) {
    const clean = pathOf(fileOrPath);
    if (!clean) throw new Error("fsVault.delete: 空路径");
    const target = abs(clean);
    const st = fs.statSync(target);
    if (st.isDirectory() && !recursive) throw new Error(`fsVault.delete: 目录需 recursive=true（${clean}）`);
    fs.rmSync(target, { recursive: st.isDirectory(), force: false });
  }

  return {
    root,
    getAbstractFileByPath,
    create,
    createFolder,
    read,
    modify,
    list,
    // `delete` 是保留字，不能作函数声明名；导出键仍对齐 Obsidian 的 vault.delete。
    delete: deleteEntry,
    // 兼容个别 helper 的 `vault.adapter.read` 探测；给 adapter 会让 _task.js 走 adapter 分支，
    // 所以这里刻意不提供 adapter —— 走 read(路径) 分支。
  };
}

module.exports = { createFsVault };
