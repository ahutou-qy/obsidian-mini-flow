// ==============================================
// Mini Flow - capture 行共用原语
//
// idea / task-edit / task-finish 共用的月度 Capture 行解析、定位、
// 近期任务列举逻辑收口于此，消除漂移。分两层：
//   - 纯函数（parseTaskLine / parseCaptureLine / extractAnchor …）：字符串进字符串出，
//     不碰 app/vault，可在 Node 下单测。
//   - 运行时函数（resolveCaptureFromSource / listRecentTasks / findFollowers …）：依赖 app/vault，按参数
//     注入，与 QuickAdd 沙盒同模式由各脚本字符串加载本文件。
//
// 月度 Capture 行形态（无 checkbox）：
//   - [[08/名/README|显示名]] #active [completion:: 2026-08-12] ^cap-xxx
//     历史行可能还带 #domain/<slug>（2026-11-16 起不再写）；reader-side 宽读，仅作 legacy 兜底。
// 状态两态互斥写在行内 #active / #finish；#now / #next / #dev_done 是已并入 active
// 的历史别名（2026-11-12 收敛），#archive 是 finish 的旧形态（2026-08-19 语义已合并），
// 二者同样只作 reader-side 宽读——归一规则见下方 STATUS_ALIAS。
// 老数据可能仍是 checkbox 任务行（- [ ] [[...]] ^cap-xxx），parseCaptureLine 一并解析。
// ==============================================

// ---------- 纯函数（不依赖 app/vault） ----------

function isCheckboxLine(line) {
  return /^\s*- \[[ xXoO\/>-]\]\s*/.test(String(line));
}

function extractAnchor(line) {
  const m = String(line).match(/\^([A-Za-z0-9-]+)\s*$/);
  return m ? m[1] : null;
}

// 行内状态标签 → 规范档。历史别名只在 reader-side 宽读时归一，写盘路径
// （_capture-line-rewrite.js / _finish.js）会把这些旧 tag 清掉、只留一个状态标签。
//   #now / #next / #dev_done → active：三者都表示「还在办」；now/next 于 2026-11-12
//     合并为单活跃档 active（两档不携带信息：capture 默认写 #next、人从不改档），
//     dev_done 档 2026-10-22 删除后也归入 active。
//   #archive → finish：archive 档 2026-08-19 删除，其语义（带 completion 日期的完成态）
//     已并入 finish。
const STATUS_ALIAS = {
  active: "active",
  now: "active",
  next: "active",
  dev_done: "active",
  archive: "finish",
  finish: "finish",
};

// 解析月度 Capture 行，返回结构化字段。兼容老 checkbox 行。
// 返回 null 表示不是带 cap 锚点的 Capture 行。
function parseCaptureLine(line, sourceFile) {
  const raw = String(line);
  const cb = raw.match(/^(\s*)-\s+\[([ xXoO\/>-])\]\s+(.*)$/);
  const plain = raw.match(/^(\s*)-\s+(\S.*?)\s*$/);
  let indent, symbol, body;
  if (cb) { indent = cb[1]; symbol = cb[2]; body = cb[3]; }
  else if (plain) { indent = plain[1]; symbol = ""; body = plain[2]; }
  else return null;

  const anchor = extractAnchor(body);
  if (!anchor || !/^cap-/.test(anchor)) return null;
  if (!/\[\[/.test(body)) return null;

  const completion = (body.match(/\[completion::\s*(\d{4}-\d{2}-\d{2})\s*\]/i) || [])[1] || "";
  // 状态字典两档（active/finish）。历史标签按上方 STATUS_ALIAS 宽读归一。
  const rawStatus = (body.match(/(?:^|\s)#(active|now|next|dev_done|archive|finish)(?=\s|$)/) || [])[1] || "";
  const status = STATUS_ALIAS[rawStatus] || rawStatus;
  const doneLegacy = cb ? /^[xX]$/.test(symbol) : false;

  return {
    indent,
    checkbox: !!cb,
    symbol,
    body,
    anchor,
    linkTarget: linkTargetOf(body, sourceFile),
    title: displayOf(body),
    domain: domainOf(body),
    status,                 // active/finish（历史别名已在 STATUS_ALIAS 归一），老行可能为空
    completion,
    doneLegacy,             // 老 checkbox 行的勾选态
    // 行内 #yunxiao：云效物化项，Home「🏠 工作事务」活跃卡滤掉它（它归「📋 云效工作项」卡）。
    // 状态标签正则只认状态字典，#yunxiao 不是状态 → 单独给一个布尔位，别让消费方各自翻正文。
    yunxiao: /#yunxiao\b/.test(body),
  };
}

// ---------- 运行时（依赖 app/vault） ----------

async function listDir(vault, rel) {
  try {
    if (typeof vault.list === "function") return await vault.list(rel);
    if (vault.adapter && typeof vault.adapter.list === "function") return await vault.adapter.list(rel);
  } catch (e) {
    console.warn(`[miniflow] listDir skipped ${rel}:`, e && e.message);
  }
  return { files: [], folders: [] };
}

// 列出 flow/data 下所有 ideas-YYYY-MM.md 的 vault 相对路径，按文件名降序（近月在前）。
// 只下钻年份(YYYY)和季度(Qn)，绝不进任务月目录(MM/)——任务目录里可能有 SDK/日志/非法名目录。
async function listMonthFiles(vault) {
  const MONTH_RE = /ideas-\d{4}-\d{2}\.md$/;
  const YEAR_RE = /^\d{4}$/;
  const QUARTER_RE = /^Q[1-4]$/;
  const found = [];
  const queue = ["flow/data"];
  while (queue.length) {
    const dir = queue.shift();
    const { files = [], folders = [] } = await listDir(vault, dir);
    for (const f of files) if (MONTH_RE.test(f)) found.push(f);
    for (const d of folders) {
      const base = d.split("/").pop();
      if (YEAR_RE.test(base) || QUARTER_RE.test(base)) queue.push(d);
    }
  }
  return found.sort((a, b) => b.localeCompare(a));
}

async function readText(vault, target) {
  if (typeof target === "string" && vault.adapter && typeof vault.adapter.read === "function") {
    return vault.adapter.read(target);
  }
  return vault.read(target);
}

function readFrontmatterField(app, file, field) {
  const cache = app.metadataCache && app.metadataCache.getFileCache(file);
  const v = cache && cache.frontmatter && cache.frontmatter[field];
  return v ? String(v) : null;
}

// 列月度 Capture 行（任务），给 Task Edit / 任务选择器用。扫所有 idea 月文件，
// 每行用 parseCaptureLine 解析（兼容老 checkbox 行）。
// 排序按所链 README mtime 全局倒序（最近活跃任务浮前），mtime 缺失回退近月+行序。
// opts: limit、statuses（白名单，如 ["active"]）、app、sort。
async function listRecentTasks(vault, { limit = 50, statuses = null, app = null, sort = true } = {}) {
  const MONTH_RE = /ideas-(\d{4})-(\d{2})\.md$/;
  const monthFiles = await listMonthFiles(vault);
  const collected = [];
  for (let mi = 0; mi < monthFiles.length; mi++) {
    const f = monthFiles[mi];
    const m = f.match(MONTH_RE);
    const monthLabel = `${m[1]}-${m[2]}`;
    const content = await readText(vault, f);
    let inCapture = false;
    const lines = content.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (/^##\s+Capture\s*$/.test(line)) { inCapture = true; continue; }
      if (/^##\s/.test(line)) inCapture = false;
      if (!inCapture) continue;
      const parsed = parseCaptureLine(line, f);
      if (!parsed) continue;
      if (statuses && !statuses.includes(parsed.status)) continue;
      collected.push({
        anchor: parsed.anchor,
        file: f,
        monthLabel,
        title: parsed.title,
        linkTarget: parsed.linkTarget,
        domain: parsed.domain,
        status: parsed.status,
        completion: parsed.completion,
        doneLegacy: parsed.doneLegacy,
        yunxiao: parsed.yunxiao,
        mtime: sort ? await taskMtime(vault, app, parsed.linkTarget, f) : 0,
        _mi: mi,
        _li: li,
      });
    }
  }
  if (sort) {
    collected.sort((a, b) =>
      (b.mtime || 0) - (a.mtime || 0) ||
      a._mi - b._mi ||
      b._li - a._li
    );
  }
  const sliced = limit === Infinity ? collected : collected.slice(0, limit);
  return sliced.map(({ _mi, _li, ...ev }) => ev);
}

// 取任务 README 的 mtime（毫秒）。全路径链接直接 stat；basename 短链借 metadataCache 按名解析。
async function taskMtime(vault, app, linkTarget, sourceFile) {
  if (!linkTarget) return 0;
  try {
    if (linkTarget.includes("/")) {
      const stat = await (vault.adapter && vault.adapter.stat
        ? vault.adapter.stat(`${linkTarget}.md`)
        : null);
      return stat ? (stat.mtime || 0) : 0;
    }
    if (app && app.metadataCache && app.metadataCache.getFirstLinkpathDest) {
      const tf = app.metadataCache.getFirstLinkpathDest(linkTarget, sourceFile);
      return tf && tf.stat ? (tf.stat.mtime || 0) : 0;
    }
  } catch (e) {
    console.warn(`[miniflow] taskMtime failed for ${linkTarget}:`, e && e.message);
  }
  return 0;
}

// capture 行正文 → 任务 wiki 链接目标（[[target|alias]] 的 target，去 .md）。
// 相对形式 `08/<名>/README` 相对 ideas 文件所在季目录补全为 vault 全路径。
function linkTargetOf(body, sourceFile) {
  const wiki = String(body).match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
  if (!wiki) return null;
  let target = wiki[1].replace(/\.md$/, "").trim();
  if (target.includes("/") && !target.startsWith("flow/") && sourceFile) {
    const dir = String(sourceFile).split("/").slice(0, -1).join("/");
    target = `${dir}/${target}`;
  }
  return target;
}

// capture 行正文 → 给人看的短标题：取 wiki 别名，否则剥 inline field/tag 取前 40 字。
function displayOf(body) {
  const wiki = String(body).match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (wiki) return wiki[2] || wiki[1].split("/").pop();
  return String(body)
    .replace(/\[[^\]]*::[^\]]*\]/g, "")
    .replace(/(^|\s)#[^\s#]+/g, "")
    .replace(/\s+\^[A-Za-z0-9-]+\s*$/, "")
    .trim()
    .slice(0, 40);
}

// capture 行正文 → 所属领域 slug：读历史 `#domain/<slug>`，无则 null。
// 2026-11-16 起新行不再打该标签（领域只存 README frontmatter `domain:`），本函数仅服务
// 老行的兜底（task-edit 在 README 无 domain 时才用它）。
function domainOf(body) {
  const m = String(body).match(/(?:^|\s)#domain\/([^\s#]+)/);
  return m ? m[1] : null;
}

// 从 wiki target 反推任务名：`10/<名>/README` → `<名>`；`08/<名>.md` → `<名>`。
function taskNameFromTarget(target) {
  const parts = String(target).trim().split("/").filter(Boolean);
  if (!parts.length) return String(target).trim();
  const last = parts[parts.length - 1];
  if (/^readme$/i.test(last)) parts.pop();
  else if (/\.md$/i.test(last)) parts[parts.length - 1] = last.replace(/\.md$/i, "");
  return parts.length ? parts[parts.length - 1] : String(target).trim();
}

// capture 行里的任务 wiki 链接 → 纯文本（别名优先，其次反推的任务名）。
//
// 用途：「删任务、留底行」——行按设计保留作事件留底，但目标文件已经没了，
// 留着 [[...]] 就是死链：Home 里点它，Obsidian 判「链接不存在」会新建空笔记
// （短链 `MM/<名>/README` 还会落到 vault 根，造出一个假月目录）。
//
// 只降级行内**第一个** wiki（任务链接本体）；`[follows:: [[...]]]` 因果边保持原样。
function demoteCaptureLink(line) {
  let demoted = false;
  return String(line).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (full, target, alias) => {
    if (demoted) return full;
    demoted = true;
    const a = alias ? String(alias).trim() : "";
    return a || taskNameFromTarget(target);
  });
}

// 找所有 follows 指向被删任务的后继 capture 行。删任务时用来报悬空因果边。
// 匹配两种形式：新式直指任务文件（[[<taskPath>|<名>]]，target 等于 taskPath 或其 basename），
// 旧式指向事件锚点（[[ideas-YYYY-MM#^<anchor>]]）。返回 [{file, anchor, title}]。
// 用行字符串 regex 读 [follows:: [[...]]]，不依赖 parseTaskLine（已退役），
// 兼容 checkbox 形态与无 checkbox 形态 capture 行。
async function findFollowers(vault, { taskPath, anchor } = {}) {
  const needles = [];
  if (taskPath) {
    const p = String(taskPath).replace(/\.md$/, "");
    needles.push(p);
    const base = p.split("/").pop();
    if (base && base !== p) needles.push(base); // 短链 [[任务名]]
  }
  if (anchor) needles.push(`#^${String(anchor).replace(/^\^/, "")}`);
  if (!needles.length) return [];

  const out = [];
  for (const f of await listMonthFiles(vault)) {
    const content = await readText(vault, f);
    let inCapture = false;
    for (const line of content.split("\n")) {
      if (/^##\s+Capture\s*$/.test(line)) { inCapture = true; continue; }
      if (/^##\s/.test(line)) inCapture = false;
      if (!inCapture) continue;
      if (!/^\s*-\s/.test(line)) continue; // 行首必须是 - 起（兼容 checkbox 与无 checkbox 形态）
      const fm = line.match(/\[follows::\s*\[\[([^\]]+)\]\]\]/);
      if (!fm) continue;
      const inner = fm[1];
      const linkTarget = inner.split("|", 1)[0].replace(/\.md$/, "").trim();
      const hit = needles.some((n) => n.startsWith("#^")
        ? inner.includes(n)
        : linkTarget === n || linkTarget.endsWith(`/${n}`));
      if (!hit) continue;
      const a = extractAnchor(line);
      const titleMatch = line.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const title = titleMatch ? (titleMatch[2] || titleMatch[1].split("/").pop()) : "";
      out.push({ file: f, anchor: a, title });
    }
  }
  return out;
}

// 从任务文件定位月度 idea 文件里的 capture 行。两条路：
//   1) 首选 frontmatter.source 的 `[[ideas#^cap-xxxx]]` 精确定位（capture 原生任务都有）；
//   2) 回退反查：手写/事后补登记的任务 README 没有 source 回填，但月度 capture 行里
//      的 wiki 链接指向它——扫月文件找 linkTarget 解析后等于本任务路径的那行。
// 返回 { file: TFile, anchor, lineIdx }，都找不到返回 null。
async function resolveCaptureFromSource(app, taskFile, taskHelpers) {
  const viaSource = await resolveBySourceField(app, taskFile, taskHelpers);
  if (viaSource) return viaSource;
  return resolveByBacklink(app, taskFile);
}

// 路径 1：读任务文件 frontmatter source 的锚点，直接定位月度行。
async function resolveBySourceField(app, taskFile, taskHelpers) {
  const vault = app.vault;
  const source = readFrontmatterField(app, taskFile, "source");
  if (!source) return null;
  const m = String(source).match(/\[\[([^\]#]+)(?:#\^([^\]]+))?\]\]/);
  if (!m) return null;
  const [, ideaBase, anchor] = m;
  if (!anchor) return null;

  const quarterFolder = taskHelpers.inferQuarterFolder(taskFile.path);
  const capturePath = `${quarterFolder}/${ideaBase.endsWith(".md") ? ideaBase : ideaBase + ".md"}`;
  const captureFile = vault.getAbstractFileByPath(capturePath);
  if (!captureFile || captureFile.children) return null;

  const content = await vault.read(captureFile);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`^${anchor}`) && parseCaptureLine(lines[i], capturePath)) {
      return { file: captureFile, anchor, lineIdx: i };
    }
  }
  return null;
}

// 路径 2：无 source 回填时按 capture 行的 wiki 链接反查本任务。
// linkTargetOf 已把相对形式（[[08/名/README]]）相对 ideas 所在季目录补全为 vault 全路径，
// 故与任务文件去 .md 的全路径精确相等即可，跨月不会误命中（路径含年/季/月）。
// 裸短链 [[名]]（无 "/"）只对单文件任务成立；README 的 basename 是 "README" 不唯一，不做宽松匹配。
async function resolveByBacklink(app, taskFile) {
  const vault = app.vault;
  const taskPathNoExt = String(taskFile.path || "").replace(/\.md$/, "");
  if (!taskPathNoExt) return null;
  const base = taskPathNoExt.split("/").pop();
  const isReadme = taskFile.basename === "README";

  for (const f of await listMonthFiles(vault)) {
    const content = await readText(vault, f);
    const lines = content.split("\n");
    let inCapture = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^##\s+Capture\s*$/.test(line)) { inCapture = true; continue; }
      if (/^##\s/.test(line)) inCapture = false;
      if (!inCapture) continue;
      const parsed = parseCaptureLine(line, f);
      if (!parsed || !parsed.linkTarget) continue;
      const t = parsed.linkTarget;
      const hit = t === taskPathNoExt || (!isReadme && t === base);
      if (!hit) continue;
      const capFile = vault.getAbstractFileByPath(f);
      if (capFile && !capFile.children) {
        return { file: capFile, anchor: parsed.anchor, lineIdx: i };
      }
    }
  }
  return null;
}

// QuickAdd 沙盒/插件都用字符串加载 vault 内 helper。
async function loadMiniHelper(app, name) {
  const src = await app.vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

module.exports = {
  // 纯
  isCheckboxLine,
  extractAnchor,
  parseCaptureLine,
  linkTargetOf,
  displayOf,
  domainOf,
  demoteCaptureLink,
  taskNameFromTarget,
  // 运行时
  listDir,
  listMonthFiles,
  listRecentTasks,
  readFrontmatterField,
  resolveCaptureFromSource,
  findFollowers,
  loadMiniHelper,
};
