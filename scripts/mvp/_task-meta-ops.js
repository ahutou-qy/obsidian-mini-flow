// ==============================================
// Mini Flow - mf.js 的任务元数据编辑（`rename` / `set`，2026-11-23）
//
// 对应 Obsidian 的 Task Edit（`task-edit.js`）里 agent 最需要的三件事：
//   1) 改标题（`_rename.js` 的三处写：H1 / 磁盘名 / 月度行 alias）
//   2) 换域（frontmatter `domain:` + 正文导航行）；--topic 已于 2026-11-23 砍 topic 时下线
//   3) 换域（frontmatter `domain:` + 正文导航行）
//
// **和 GUI 的差别（有意的）**：
//   - GUI 的 Task Edit 换域/改主题时**不重渲染正文导航行**（那是 capture 快照）。
//     CLI 侧两处一起改——agent 改域是「纠正」，导航行留着旧域会把人导到错的域规约；
//     vault 根 CLAUDE.md「云效工作流」段对手改域的要求也是「两处一起改」。
//   - GUI 靠 Obsidian `fileManager.renameFile` 全库自动改双链；CLI 没有索引，自己扫
//     `flow/data/**` 下的 md + 根 `Home.md`，按 `_delete.js#pathLinkResolver` 解析，
//     只重写**解析到目标任务（含其子文件）**的链接，其余原样。
//
// 顺序硬约束（崩溃时的可恢复性）：先改内容（H1 / 链接 / alias / chain.parent），
// **最后**才动磁盘名。中途失败时文件仍在旧路径，链接也仍指旧路径，不会半截。
//
// 边界：
//   - 改名前请确认 Obsidian 里没有开着该任务 README 的编辑态（外部 rename 与编辑器
//     缓冲可能打架，同 `_rename.js` 头注）。
//   - 不做全库链接改写之外的任何副作用：不刷新 `## 文件索引`（folder 同父目录改名时
//     索引里的相对链接不变）。
// ==============================================

const fs = require("node:fs");
const nodePath = require("node:path");

const MINI = nodePath.resolve(__dirname, "..", "quickadd", "mini");
const yaml = require(nodePath.join(MINI, "_yaml.js"));
const naming = require(nodePath.join(MINI, "_naming.js"));
const renameHelpers = require(nodePath.join(MINI, "_rename.js"));
const deleteHelpers = require(nodePath.join(MINI, "_delete.js"));
const configMod = require(nodePath.join(MINI, "_config.js"));
const workflow = require(nodePath.join(MINI, "_workflow.js"));
const { CliError } = require("./agent-capture.js");
const taskPath = require("./_task-path.js");

const SENTINEL = "<!-- _task.js render: nav line — 不要手改 -->";
const LINK_RE = /(!?)\[\[([^\]]+)\]\]/g;

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function has(args, name) {
  return args.includes(name);
}

function die(code, msg) {
  throw new CliError(code, msg);
}

function splitDoc(content) {
  const m = String(content).match(yaml.FRONTMATTER_RE);
  if (!m) return { fm: "", body: String(content) };
  return { fm: m[1], body: String(content).slice(m[0].length) };
}

function joinDoc(fm, body) {
  return `---\n${fm}\n---${body}`;
}

async function requireTask(vault, raw, root) {
  const rel = taskPath.resolveTaskFile(vault, raw, root, die);
  const content = await vault.read(rel);
  const { fm } = splitDoc(content);
  const type = yaml.getScalarField(fm, "type");
  if (type !== "task" && type !== "task-folder") {
    die(3, `不是任务文件（type=${type || "无"}）：${rel}`);
  }
  return { rel, content, fm, type };
}

// ---------- 链接扫描 ----------

// flow/data 下全部 md + 根 Home.md（vault 相对路径；不含 big/、.obsidian/）。
function collectMarkdown(vaultRoot) {
  const root = nodePath.resolve(vaultRoot);
  const out = [];
  const walk = (rel) => {
    const abs = nodePath.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(childRel);
      } else if (/\.md$/i.test(e.name)) {
        out.push(childRel);
      }
    }
  };
  walk("flow/data");
  if (fs.existsSync(nodePath.join(root, "Home.md"))) out.push("Home.md");
  return out;
}

function parseInner(inner) {
  const pipe = inner.indexOf("|");
  const beforePipe = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const alias = pipe >= 0 ? inner.slice(pipe + 1) : "";
  const hash = beforePipe.indexOf("#");
  return {
    linkpath: (hash >= 0 ? beforePipe.slice(0, hash) : beforePipe).trim(),
    heading: hash >= 0 ? beforePipe.slice(hash + 1) : "",
    alias,
  };
}

// 目标路径映射：旧任务文件 / 旧任务目录下的任何文件 → 新路径。不命中返 null。
function mapTargetPath(destPath, oldTask, newTask) {
  const d = String(destPath).replace(/\\/g, "/");
  if (oldTask.folder) {
    if (d === `${oldTask.folder}/README.md`) return `${newTask.folder}/README.md`;
    if (d.startsWith(`${oldTask.folder}/`)) return newTask.folder + d.slice(oldTask.folder.length);
  } else if (d === oldTask.file) {
    return newTask.file;
  }
  return null;
}

// 源文件自己是否也在这棵被移动的目录里——在的话，相对链接要按**新位置**的目录算。
function mapSourcePath(sourcePath, oldTask, newTask) {
  if (oldTask.folder && sourcePath.startsWith(`${oldTask.folder}/`)) {
    return newTask.folder + sourcePath.slice(oldTask.folder.length);
  }
  if (!oldTask.folder && sourcePath === oldTask.file) return newTask.file;
  return sourcePath;
}

// 保持原来的链接风格：vault 绝对（flow/ 开头或 / 开头）就写绝对，否则按源文件目录写相对。
function buildNewLinkpath(origLinkpath, effectiveSourcePath, mappedAbsWithExt) {
  const abs = mappedAbsWithExt.replace(/\.md$/i, "");
  if (origLinkpath.startsWith("/")) return `/${abs}`;
  if (origLinkpath.startsWith("flow/")) return abs;
  const fromDir = effectiveSourcePath.split("/").slice(0, -1).join("/");
  return nodePath.posix.relative(fromDir, abs) || abs;
}

async function rewriteFileLinks(vault, rel, oldTask, newTask, resolveLink) {
  const content = await vault.read(rel);
  const effectiveSource = mapSourcePath(rel, oldTask, newTask);
  let changed = false;
  const rewritten = content.replace(LINK_RE, (full, embed, inner) => {
    if (embed) return full;
    const { linkpath, heading, alias } = parseInner(inner);
    if (!linkpath) return full;
    const dest = resolveLink(linkpath, rel);
    if (!dest) return full;
    const mapped = mapTargetPath(dest.path, oldTask, newTask);
    if (!mapped) return full;
    changed = true;
    const newLinkpath = buildNewLinkpath(linkpath, effectiveSource, mapped);
    return `[[${newLinkpath}${heading ? `#${heading}` : ""}${alias ? `|${alias}` : ""}]]`;
  });
  if (!changed || rewritten === content) return false;
  await vault.modify(rel, rewritten);
  return true;
}

// `chain.parent` 是纯路径字符串（不是 wikilink），要单独换。
function rewriteChainParent(content, oldNoExt, newNoExt) {
  const { fm, body } = splitDoc(content);
  if (!fm || !/^\s*chain\s*:/m.test(fm)) return content;
  const nextFm = fm.replace(/^(\s*parent:\s*)(.+?)\s*$/m, (full, pre, raw) => {
    const v = String(raw).trim().replace(/^['"]|['"]$/g, "");
    return v === oldNoExt ? `${pre}${newNoExt}` : full;
  });
  if (nextFm === fm) return content;
  return joinDoc(nextFm, body);
}

// 月度 capture 行：从任务 README 的 `source` 反查（与 `_capture-line.js#resolveBySourceField`
// 同口径，但 fsVault 侧没有 metadataCache，按路径规则自己拼）。
async function findCaptureRow(vault, taskRel, fm) {
  const source = yaml.getScalarField(fm, "source");
  const m = String(source).match(/\[\[([^\]#]+)(?:#\^([^\]]+))?\]\]/);
  if (!m || !m[2]) return null;
  const ideaBase = m[1].split("/").pop();
  const anchor = m[2];
  const quarter = /^(flow\/data\/\d{4}\/Q\d)\//.exec(String(taskRel));
  if (!quarter) return null;
  const ideaName = /\.md$/i.test(ideaBase) ? ideaBase : `${ideaBase}.md`;
  const capturePath = `${quarter[1]}/${ideaName}`;
  if (!vault.getAbstractFileByPath(capturePath)) return null;
  const content = await vault.read(capturePath);
  const lines = content.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes(`^${anchor}`) && /^\s*-\s/.test(l));
  if (lineIdx < 0) return null;
  return { file: capturePath, anchor, lineIdx };
}

// ---------- rename ----------

async function renameTask(vault, args, ctx = {}) {
  if (!ctx.vaultRoot) die(4, "rename 需要 vault 根（ctx.vaultRoot）");
  const newTitle = String(flag(args, "--title") || "").trim();
  if (!newTitle) die(2, 'rename 需要 --title "<新标题>"');
  const task = await requireTask(vault, flag(args, "--path"), ctx.vaultRoot);

  const isFolder = taskPath.taskKindOf(task.rel) === "folder";
  const oldTask = isFolder
    ? { file: task.rel, folder: taskPath.taskDirOf(task.rel) }
    : { file: task.rel, folder: null };
  const parentDir = isFolder
    ? nodePath.posix.dirname(oldTask.folder)
    : taskPath.taskDirOf(task.rel);

  const cfg = configMod.loadSync(ctx.vaultRoot);
  const maxLen = cfg && cfg.behavior ? cfg.behavior.maxFilenameLength : undefined;
  const newDiskName = naming.buildFileName(newTitle, maxLen);
  const oldDiskName = isFolder
    ? oldTask.folder.split("/").pop()
    : task.rel.split("/").pop().replace(/\.md$/i, "");

  let newTask;
  if (newDiskName === oldDiskName) {
    newTask = { ...oldTask };
  } else if (isFolder) {
    const name = renameHelpers.findUniqueFolderName(vault, parentDir, newDiskName, naming, maxLen);
    const newFolder = `${parentDir}/${name}`;
    newTask = { file: `${newFolder}/README.md`, folder: newFolder };
  } else {
    const createPath = naming.findUniquePath(vault, parentDir, newDiskName, maxLen).createPath;
    newTask = { file: createPath, folder: null };
  }
  const renamed = newTask.file !== oldTask.file;

  // 1) H1
  await renameHelpers.rewriteH1(vault, task.rel, newTitle);

  // 2) 全库链接 + chain.parent（在改名之前做：解析器要靠旧路径还能解析到文件）
  const files = collectMarkdown(ctx.vaultRoot);
  const resolveLink = deleteHelpers.pathLinkResolver(
    vault,
    files.map((p) => ({ path: p })),
  );
  const oldNoExt = oldTask.file.replace(/\.md$/i, "");
  const newNoExt = newTask.file.replace(/\.md$/i, "");
  const linksRewritten = [];
  const chainRewritten = [];
  for (const rel of files) {
    if (await rewriteFileLinks(vault, rel, oldTask, newTask, resolveLink)) linksRewritten.push(rel);
    const content = await vault.read(rel);
    const next = rewriteChainParent(content, oldNoExt, newNoExt);
    if (next !== content) {
      await vault.modify(rel, next);
      chainRewritten.push(rel);
    }
  }

  // 3) 月度 capture 行 alias（target 已在第 2 步改过；这里只换显示名）
  const capture = await findCaptureRow(vault, task.rel, task.fm);
  if (capture) await renameHelpers.rewriteCaptureAlias(vault, capture, newTitle);

  // 4) 最后动磁盘名
  if (renamed) {
    const absOld = nodePath.join(ctx.vaultRoot, ...(isFolder ? oldTask.folder : oldTask.file).split("/"));
    const absNew = nodePath.join(ctx.vaultRoot, ...(isFolder ? newTask.folder : newTask.file).split("/"));
    if (fs.existsSync(absNew)) die(3, `目标路径已存在：${isFolder ? newTask.folder : newTask.file}`);
    fs.renameSync(absOld, absNew);
  }

  return {
    ok: true,
    action: "task.rename",
    renamed,
    title: newTitle,
    oldPath: task.rel,
    newPath: newTask.file,
    captureUpdated: Boolean(capture),
    linksRewritten,
    chainRewritten,
    hint: renamed && ctx.needsReindex !== false
      ? "改名已落盘；Obsidian 侧索引/双链缓存请再执行 `miniflow:mf-reindex`"
      : "",
  };
}

// ---------- set（domain；--topic 已下线） ----------

// 重建导航行块：保留未指定的那一行，按需替换/删除/插入。
function rewriteNavBlock(body, { domainLine, topicLine }) {
  const lines = body.split("\n");
  const bare = (s) => s.replace(/\r$/, "");
  const idxSentinel = lines.findIndex((l) => bare(l).trim() === SENTINEL);
  const idxDomain = lines.findIndex((l) => /^> \*\*领域：\*\*/.test(bare(l)));
  const idxTopic = lines.findIndex((l) => /^> \*\*主题：\*\*/.test(bare(l)));

  const curDomain = idxDomain >= 0 ? bare(lines[idxDomain]) : null;
  const curTopic = idxTopic >= 0 ? bare(lines[idxTopic]) : null;
  const nextDomain = domainLine === undefined ? curDomain : domainLine;
  const nextTopic = topicLine === undefined ? curTopic : topicLine;

  if (nextDomain === curDomain && nextTopic === curTopic) return body;

  const drop = new Set([idxSentinel, idxDomain, idxTopic].filter((i) => i >= 0));
  const insertAt = drop.size ? Math.min(...drop) : (() => {
    const srcIdx = lines.findIndex((l) => /^来源：/.test(bare(l)));
    if (srcIdx >= 0) return srcIdx + 1;
    const h1Idx = lines.findIndex((l) => /^#\s+/.test(bare(l)));
    return h1Idx >= 0 ? h1Idx + 1 : 0;
  })();

  const kept = lines.filter((_, i) => !drop.has(i));
  const block = [];
  if (nextDomain || nextTopic) {
    block.push(SENTINEL);
    if (nextDomain) block.push(nextDomain);
    if (nextTopic) block.push(nextTopic);
  }
  // insertAt 是原行号；去掉的行都在它之前时，插入点要往前挪。
  let pos = 0;
  for (let i = 0; i < insertAt; i += 1) if (!drop.has(i)) pos += 1;
  const out = [...kept.slice(0, pos), ...block, ...kept.slice(pos)];
  return out.join("\n");
}

async function setTaskMeta(vault, args, ctx = {}) {
  const hasTopic = has(args, "--topic");
  const hasDomain = has(args, "--domain");
  // 阶段一「停写」(2026-11-23,砍 topic):--topic 已下线。显式传参即报 usage 错,
  // **不静默忽略**——静默会让调用方以为主题改成功了。
  // 改域走 `mf.js set --domain <slug>`;存量 `topic:` 字段由阶段三统一迁移。
  if (hasTopic) die(2, "--topic 已下线（domain 与 topic 只保留 domain）；改域用 --domain <slug>");
  if (!hasDomain) die(2, "set 需要 --domain <slug>");
  const task = await requireTask(vault, flag(args, "--path"), ctx.vaultRoot);
  const { fm, body } = splitDoc(task.content);
  let nextFm = fm;
  let domainLine;
  const changes = {};

  if (hasDomain) {
    const slug = String(flag(args, "--domain") || "").trim();
    const flowFile = slug ? vault.getAbstractFileByPath(`flow/data/domains/${slug}/flow.json`) : null;
    if (!slug || !flowFile || flowFile.children) {
      die(3, `域不存在（需要 flow/data/domains/<slug>/flow.json）：${slug || "(空)"}`);
    }
    nextFm = yaml.setDomain(nextFm, slug);
    const wf = await workflow.loadWorkflow(vault, slug);
    const label = (wf && wf.label) || slug;
    domainLine = `> **领域：** [[flow/data/domains/${slug}/CLAUDE|${label} 规则库]]`;
    changes.domain = slug;
  }

  // （原 hasTopic 死分支已随 2026-11-23 砍 topic 删除：上面 if (hasTopic) 直接 die。）

  // topicLine 传 undefined = 保留存量主题导航行原样（阶段一只停写、不动存量数据）。
  const nextBody = rewriteNavBlock(body, { domainLine });
  const next = joinDoc(nextFm, nextBody);
  const changed = next !== task.content;
  if (changed) await vault.modify(task.rel, next);

  return {
    ok: true,
    action: "task.set",
    path: task.rel,
    changed,
    ...changes,
  };
}

// ---------- 分发 ----------

const ACTIONS = { rename: renameTask, set: setTaskMeta };
const USAGE = "usage: mf.js rename --path <p> --title <t> | mf.js set --path <p> "
  + "--domain <slug>";

async function taskMetaCommand(vault, args, ctx = {}) {
  const [op, ...rest] = args;
  if (!op) die(2, USAGE);
  const fn = ACTIONS[op];
  if (!fn) die(2, `未知的子命令：${op}\n${USAGE}`);
  return fn(vault, rest, ctx);
}

module.exports = { renameTask, setTaskMeta, taskMetaCommand, rewriteNavBlock, USAGE };
