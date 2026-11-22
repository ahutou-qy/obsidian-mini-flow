// ==============================================
// Mini Flow - 共享任务文件工具
//
// task-capture.js 和 task.js 都要建 <月目录>/<name>.md；把公共逻辑抽在这里，
// 避免两处各写一遍导致模板、路径规则漂移。
//
// 任务落点：flow/data/YYYY/Qn/MM/（MM 两位月份）。月度 ideas 文件仍在 Qn/ 根。
// - computeDateParts：从 now（moment-like 或 Date）拆 year/quarter/month/day。
// - inferTasksDir：从当前文件父路径推 flow/data/YYYY/Qn/MM；推不到用今天。
// - inferQuarterFolder：推 flow/data/YYYY/Qn（用于定位 Qn 根的月度 ideas 文件）。
// - TASK_ROOT_RE / parseTaskPath：统一识别月目录任务树，禁止各脚本各写正则。
// - resolveTaskTarget：识别单文件 / folder README / 遗留 legacy 三种入口，
//     全部为空时交给 findUniquePath 处理撞名（-2/-3 后缀）。
// - buildFolderReadme：folder 任务 README 初始模板（每次 capture 一律建 folder）。
// - buildTaskLink：把 TFile 拼成 Capture 行里的 wiki 链接。
// ==============================================

const QUARTER_OF = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4, 11: 4, 12: 4 };

// 月份段：01..12。周记目录是 W<周>，不会误匹配。
const TASK_MONTH_SEG = "(0[1-9]|1[0-2])";
// 任务树根（月目录），含其下任意深度。
const TASK_ROOT_RE = new RegExp(`^flow/data/\\d{4}/Q[1-4]/${TASK_MONTH_SEG}(?:/|$)`);

function computeDateParts(now) {
  if (now && typeof now.format === "function") {
    const month = now.format("MM");
    return { year: now.format("YYYY"), month, day: now.format("DD"), quarter: "Q" + QUARTER_OF[Number(month)] };
  }
  const d = now || new Date();
  const m = (typeof d.getMonth === "function" ? d.getMonth() : d.month()) + 1;
  const year = typeof d.getFullYear === "function" ? d.getFullYear() : d.year();
  const day = typeof d.getDate === "function" ? d.getDate() : d.date();
  const pad = (n) => String(n).padStart(2, "0");
  return { year: String(year), month: pad(m), day: pad(day), quarter: "Q" + QUARTER_OF[m] };
}

function joinPath(...parts) {
  return parts.filter(Boolean).join("/");
}

function inferQuarterFolder(activeParentPath) {
  const match = String(activeParentPath || "").match(/^(flow\/data\/\d{4}\/Q[1-4])/);
  if (match) return match[1];
  const parts = computeDateParts(typeof window !== "undefined" && window.moment ? window.moment() : new Date());
  return `flow/data/${parts.year}/${parts.quarter}`;
}

// 任务月目录。从活动文件路径截取 Qn/MM；截不到用今天。
// now 可选（CLI 传 Date，Obsidian 端用 window.moment）。
function inferTasksDir(activeParentPath, now) {
  const match = String(activeParentPath || "").match(
    new RegExp(`^(flow/data/\\d{4}/Q[1-4]/${TASK_MONTH_SEG})`)
  );
  if (match) return match[1];
  const parts = computeDateParts(now || (typeof window !== "undefined" && window.moment ? window.moment() : new Date()));
  return `flow/data/${parts.year}/${parts.quarter}/${parts.month}`;
}

// 解析任务树路径：root = 月目录，rest = 月目录之后的相对路径（可能为空）。
// 不在任务树内返回 null。
function parseTaskPath(path) {
  const value = String(path || "");
  const m = value.match(new RegExp(`^(flow/data/\\d{4}/Q[1-4]/${TASK_MONTH_SEG})(?:/(.+))?$`));
  if (!m) return null;
  return { root: m[1], rest: m[3] || "" };
}

function isInTaskTree(path) {
  return TASK_ROOT_RE.test(String(path || ""));
}

// 取路径所属的任务 folder 根（<月目录>/<名>），name 后可接 "/" 或结尾，任意深度都折叠到最外层。
// 排除周记目录 <月目录>/W<周>/——周记不是任务。单文件任务 <月目录>/<名>.md 也会被匹配，
// 调用方需用 getAbstractFileByPath + children 判定它确实是目录（插件/refresh 本就如此）。
// 没有 folder 包裹或不在任务树时返回 null。
function taskFolderPrefixOf(path) {
  const value = String(path || "");
  const m = value.match(
    new RegExp(`^(flow/data/\\d{4}/Q[1-4]/${TASK_MONTH_SEG}/(?!W\\d)[^/]+)(?:/|$)`)
  );
  return m ? m[1] : null;
}

// 统一识别一个打开的文件在任务树里的角色，替代各脚本各自写正则：
// - root-readme：<月目录>/<名>/README.md（folder/epic 入口）
// - root-file：  <月目录>/<名>.md（单文件任务）
// - nested：     月目录下更深的文件（folder 内子任务/过程文档）
// 不在月目录任务树返回 null。周记在 <月目录>/W<周>/ 下，归 nested。
function resolveTaskEntry(file) {
  if (!file || !file.path) return null;
  const parsed = parseTaskPath(file.path);
  if (!parsed) return null;
  const parentPath = file.parent ? file.parent.path : "";
  if (file.basename === "README" && parentPath && parentPath !== parsed.root) {
    // README 在月目录直接子目录下 → folder/epic 入口；更深的 README 归 nested。
    // 排除周记目录 <月目录>/W<周>/，它不是任务 folder。
    const seg = parentPath.slice(parsed.root.length + 1);
    if (file.parent && file.parent.parent && file.parent.parent.path === parsed.root
        && !/^W\d/.test(seg) && !seg.includes("/")) {
      return { root: parsed.root, rest: parsed.rest, kind: "root-readme", folder: file.parent };
    }
  }
  if (parentPath === parsed.root && file.path.endsWith(".md")) {
    return { root: parsed.root, rest: parsed.rest, kind: "root-file", folder: null };
  }
  return { root: parsed.root, rest: parsed.rest, kind: "nested", folder: null };
}

// 命令入口定位任务月目录：
// - checkbox 入口时活动文件是 Qn/ideas-YYYY-MM.md，按文件名定月份（比"今天"准，跨月不搜错）；
// - 文件入口时活动文件本身在 Qn/MM/ 树下，用父路径推；
// - 都推不到用今天。
function tasksDirForActiveFile(activeFile, now) {
  const fp = activeFile && activeFile.path ? String(activeFile.path) : "";
  const m = fp.match(/ideas-(\d{4})-(\d{2})\.md$/);
  if (m) {
    const [, year, month] = m;
    return `flow/data/${year}/Q${QUARTER_OF[Number(month)]}/${month}`;
  }
  const parentPath = activeFile && activeFile.parent ? activeFile.parent.path : "";
  return inferTasksDir(parentPath, now);
}

// ---------- 任务正文公共段 ----------
// builder（capture 原生任务/folder/epic）与 task-upgrade（历史单文件升级 folder）共用，
// 改文案只改这一处。这样 snapshot、miniflow、task-refresh-index 不用区分
// "原生 folder"和"升级 folder"——同一段文本。段常量都以单个 \n 结尾，段间空行由
// 模板字面量提供；task-upgrade 的注入函数自己管段前段后空白。
//
// 四种任务笔记的散文骨架已外置到 flow/templates/task/*.md（可手动改文案/段顺序），
// builder 实时读盘、替换 {{占位符}}；锁点段（文件索引/目录结构）仍由下面
// 的常量经占位符注入，文本不进 md，避免误改哨兵。

// 文件索引段：空骨架，哨兵之间由 task-refresh-index / _index.js 填列表。
// 哨兵串必须与 _index.js 的 INDEX_HEADER/START/END 一致，改两边一起改。
const FILE_INDEX_SECTION = [
  "## 文件索引",
  "<!-- auto-index:start -->",
  "<!-- auto-index:end -->",
  "",
].join("\n");

// AI 上下文段已于 2026-08-20 下线：所有 narrative 进 ## 笔记，机器不写 README。
// 老的 AI_CONTEXT_SECTION 常量 / buildFolderReadme 注入逻辑已删除。

// 状态机里程碑中文字面到 frontmatter type 枚举的映射。type 走 ASCII 枚举
//（create|finish|reopen|manual）便于看板按 type 聚合过滤。
// 2026-08-19 archive 档从数据模型中删除，对应「归档」字面入口移除；
// 历史 README 里残留的 type: archive 仍可读（_yaml.js 不做 enum 校验）。
// 「重开」由 task-edit 的重开路径写（2026-11-04 起有 writer：finish → now/next
// 时 appendMilestone 一条 {date, type: reopen}）。
const MILESTONE_TYPE = {
  "创建": "create",
  "完成": "finish",
  "重开": "reopen",
};

// 在 README frontmatter milestones 数组里追加一条里程碑。读全文、用
// yamlHelpers.FRONTMATTER_RE 切片、调 addMilestone（同 date+type 幂等；同
// date+type 不同 note 升级 note）、全文写回。milestone = { date, type, note? }。
// 业务脚本用 loadHelper 加载 _yaml.js 后把 yamlHelpers 传进来，绕开 QuickAdd
// 沙盒对相对 require 的限制。
//
// FRONTMATTER_RE 的 `(?:\r?\n|$)` 实际消耗了关闭 `---` 后的 1 个换行，所以
// match[0] 末尾是 "---\n"。slice 出的 rest 开头是 rest 原貌（可能含空行 \n
// 头）。写回用 `---\n${nextFm}\n---${rest}` 拼装，rest 头若已是 \n 则
// frontmatter 与正文章节之间是 1 个空行（标准形态）。
async function appendMilestone(vault, file, yamlHelpers, milestone) {
  if (!milestone || !milestone.date || !milestone.type) {
    throw new Error("appendMilestone 需要 {date, type}");
  }
  if (!yamlHelpers || !yamlHelpers.FRONTMATTER_RE || !yamlHelpers.addMilestone) {
    throw new Error("appendMilestone 需要 yamlHelpers.FRONTMATTER_RE / addMilestone");
  }
  const content = await vault.read(file);
  const match = String(content).match(yamlHelpers.FRONTMATTER_RE);
  if (!match) {
    throw new Error(`README 缺少 frontmatter：${file && file.path}`);
  }
  const fm = match[1];
  const rest = content.slice(match[0].length);
  const nextFm = yamlHelpers.addMilestone(fm, {
    date: milestone.date,
    type: milestone.type,
    note: milestone.note || "",
  });
  if (nextFm === fm) return; // 幂等命中，省一次写盘
  // 显式补回关闭 `---` 之后的换行（被 regex 消耗过）；rest 头若已有 \n 则
  // 仍只 1 个空行隔开 frontmatter 与正文，不重复加。
  await vault.modify(file, `---\n${nextFm}\n---${rest}`);
}


async function ensureFolder(vault, folderPath) {
  let current = "";
  for (const part of String(folderPath).split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

// 同时识别单文件和 folder 入口，避免升级后再次建同名任务产生重复文件。
// 都不存在时把基名交给 findUniquePath 处理撞名（自动追加 -2/-3）。
function resolveTaskTarget(vault, tasksFolder, fileName, findUniquePath) {
  const simplePath = joinPath(tasksFolder, `${fileName}.md`);
  const folderPath = joinPath(tasksFolder, fileName);
  const folderEntryPath = joinPath(folderPath, "README.md");
  const legacyEntryPath = joinPath(folderPath, `${fileName}.md`);
  const candidates = [simplePath, folderEntryPath, legacyEntryPath]
    .map(path => vault.getAbstractFileByPath(path))
    .filter(Boolean);
  const taskFolder = vault.getAbstractFileByPath(folderPath);

  if (candidates.length > 1) {
    return { conflict: `同名任务存在多个入口文件：${fileName}` };
  }
  if (candidates.length === 1) return { file: candidates[0] };
  if (taskFolder) {
    return { conflict: `同名任务目录已存在但缺少 README.md：${folderEntryPath}` };
  }
  const unique = findUniquePath(vault, tasksFolder, fileName);
  return { createPath: unique.createPath, basename: unique.name };
}

function buildTaskLink(taskFile, title) {
  if (taskFile.basename === "README") {
    return `[[${taskFile.path.replace(/\.md$/, "")}|${title}]]`;
  }
  return title === taskFile.basename
    ? `[[${taskFile.basename}]]`
    : `[[${taskFile.basename}|${title}]]`;
}

// ---------- 模板渲染 ----------
// 笔记散文骨架外置在 flow/templates/task/*.md，可手动改文案/段顺序，builder
// 实时读盘（不缓存），改完下次建任务即生效。frontmatter、work 条件段、文件索引/
// 文件索引/目录结构等锁点仍由代码生成，经 {{占位符}} 注入，文本不进 md，避免误改哨兵。
//
// 域可在 flow/data/domains/<slug>/templates/ 下放 folder-readme.md 覆写骨架。
const TASK_TEMPLATES_DIR = "flow/templates/task";
const DOMAINS_ROOT = "flow/data/domains";

// 环境无关读文本：Obsidian 按路径读走 vault.adapter.read（vault.read 只收 TFile，传
// 字符串会抛 path 类型错）；fsVault 的 read 直接吃路径字符串、无 adapter。不能 require
// 别的 helper——Obsidian 端用 new Function 加载本文件，相对 require 不可用（见 task-capture.js）。
async function readVaultText(vault, rel) {
  if (vault.adapter && typeof vault.adapter.read === "function") return vault.adapter.read(rel);
  return vault.read(rel);
}

// 事件专属模板已下线（事件类型删除）；域可在 domains/<域>/templates/folder-readme.md 覆写骨架。
function resolveTaskTemplate(vault, baseName, domain) {
  if (domain) {
    const domainRel = `${DOMAINS_ROOT}/${domain}/templates/${baseName}`;
    const entry = vault.getAbstractFileByPath(domainRel);
    if (entry && !entry.children) return domainRel;
  }
  return `${TASK_TEMPLATES_DIR}/${baseName}`;
}

async function readTemplate(vault, name, domain) {
  return readVaultText(vault, resolveTaskTemplate(vault, name, domain));
}

// 剥掉模板顶部的 HTML 注释说明（产出的笔记不带这些元注释），替换 {{KEY}} 占位符。
// 未知占位符原样保留（渲染后显眼，提示拼写错）；替换值走函数返回，$ 不当特殊字符。
function renderTemplate(src, vars) {
  const body = src.replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  return body.replace(/\{\{(\w+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m
  );
}

// 改动位置段：代码任务专属（域 flow.json 的 work 门控），个人任务返回空串。withExamples
// 控制是否带 work7 示范行（单文件任务带、folder 不带）。返回值以两个换行收尾，紧接
// {{REF_BLOCK}} 占位符。
function codeLocsBlock(work, withExamples) {
  if (!work) return "";
  const lines = [
    "改动位置（要写入的代码）：",
    "> 仓库名前缀的相对路径，可带 `::符号`；行末一句写改什么。",
  ];
  if (withExamples) lines.push("> - `work7/.../sample_v3/UpsCmcG2DeviceDriver.java` —— 新增 CMC-G2 驱动实现");
  lines.push("");
  return lines.join("\n");
}

// 参考段：与 codeLocsBlock 句式对齐，只在用途动词上区分（写它是什么）。
// 同样按域的 work 标志门控。返回值以两个换行收尾，紧接 ## 目标。
function refsBlock(work, withExamples) {
  if (!work) return "";
  const lines = [
    "参考（照它改的旧实现，只读）：",
    "> 仓库名前缀的相对路径，可带 `::符号`；行末一句写它是什么。",
  ];
  if (withExamples) lines.push("> - `work7/.../handler.py::func` —— 旧状态机，照它改");
  lines.push("", "");
  return lines.join("\n");
}

// 一律建 folder：capture 产 <月目录>/<名>/README.md + input/process/output/，月度行链向 README。
// type task-folder；段落顺序与 task-upgrade 升级产物对齐，snapshot、miniflow
// 不用区分"原生 folder""升级 folder"。事件类型已删，README 不再带 event；状态里程碑
// 写入 frontmatter milestones 数组（见 flow/scripts/quickadd/mini/_yaml.js）。
//
// topic 字段：可选关联的单个长期主题卡 id（标量，2026-09-14 由 topics 列表收口），
// 与 topic.js auto_links 联动召回。空串不输出该字段。
//
// 2026-11-16 frontmatter 精简：删除 kind / code_locs / refs / created / tags 五个字段
// ——kind 与 tags 三行全是 domain 的派生副本、零读者；code_locs / refs 无生产写手也无
// 读者；created 由 milestones 首条 create 承载。work 仍是「改动位置 / 参考」两段的门控，
// 但由 domain 的 flow.json 派生、不落盘。
// 读域显示名（flow.json#label）与 work 标志，读不到回退 slug / false；正文领域行链接文案
// 与「改动位置 / 参考」两段的门控共用这一次读盘。
async function domainMeta(vault, slug) {
  if (!slug) return { label: "", work: false };
  try {
    const j = JSON.parse(await readVaultText(vault, `${DOMAINS_ROOT}/${slug}/flow.json`));
    return {
      label: (j.label && String(j.label).trim()) || slug,
      work: !!j.work,
    };
  } catch {
    return { label: slug, work: false };
  }
}

// 任务 README frontmatter `source` 字段与正文"来源"行共用的 wikilink 拼法。
// 单独抽出便于 Node 单测覆盖（`node --test _task.test.js`）。
// 任务 README 在 `flow/data/YYYY/Qn/MM/<dir>/` 视角，capture 月度文件在
// `flow/data/YYYY/Qn/` 父级，必须加 `../` 前缀。vault 根不放月度 capture 文件
// （保持"日期为存储主轴"单一真源），所以不能省略 `../`。
function buildSourceLink(sourceFile, sourceAnchor) {
  return sourceFile ? `[[../${sourceFile}${sourceAnchor || ""}]]` : "";
}

async function buildFolderReadme({ vault, title, created, sourceFile, sourceAnchor, domain, topic }) {
  // sourceFile 是 capture 月度文件名（如 `ideas-2026-10`），月度文件位于
  // `flow/data/YYYY/Qn/` 根；任务 README 在 `flow/data/YYYY/Qn/MM/<dir>/` 视角下，
  // 相对路径需 `../` 前缀才能 Obsidian wikilink 解析。vault 根不放 capture 月度文件
  // （保持"日期为存储主轴"单一真源），所以不能省略 `../`。
  const sourceLink = buildSourceLink(sourceFile, sourceAnchor);
  const domainField = domain ? `domain: ${domain}\n` : "";
  // 正文导航行（capture 时快照，task-edit 换域/改主题不重渲染，与旧 domainLine 语义一致）：
  // 领域链规则库规约入口（domains/<域>/CLAUDE.md 自带入口说明 + 规则索引 + workflow 约束），
  // 主题链主题卡（topics/<id>，dataviewjs 反向聚合任务）。静态 wikilink，规则/主题增删不破链接；
  // HTML 哨兵明示渲染产物防 reformat 当复述删，主题行续在同一引用块内、不另起哨兵。
  const meta = await domainMeta(vault, domain);
  const domainLine = domain
    ? `<!-- _task.js render: nav line — 不要手改 -->\n> **领域：** [[${DOMAINS_ROOT}/${domain}/CLAUDE|${meta.label} 规则库]]\n`
    : "";
  const topicField = topic
    ? `topic: ${JSON.stringify(String(topic).trim())}\n`
    : "";
  const topicLine = topic
    ? `> **主题：** [[flow/data/topics/${topic}|${topic}]]\n`
    : "";
  // frontmatter 只留机器真源：type / source / domain / milestones（+ 可选 topic）。
  // tags / kind / code_locs / refs 全是派生量或零读者的派生副本，2026-11-16 删除；
  // created 已由 milestones 首条 create 承载。
  const frontmatter = [
    "---",
    "type: task-folder",
    `source: ${sourceLink ? `"${sourceLink}"` : ""}`,
    domainField.replace(/\n$/, ""),
    "milestones:",
    `  - {date: '${created}', type: create}`,
    topicField.replace(/\n$/, ""),
    "---",
  ].filter((l) => l !== "").join("\n");
  const body = renderTemplate(await readTemplate(vault, "folder-readme.md", domain), {
    TITLE: title,
    SOURCE_LINK: sourceLink,
    DOMAIN_LINE: domainLine,
    TOPIC_LINE: topicLine,
    CODE_LOC_BLOCK: codeLocsBlock(meta.work, false),
    REF_BLOCK: refsBlock(meta.work, false),
    CREATED: created,
    FILE_INDEX_SECTION,
  });
  return `${frontmatter}\n\n${body}`;
}

module.exports = {
  TASK_ROOT_RE,
  TASK_MONTH_SEG,
  joinPath,
  computeDateParts,
  inferQuarterFolder,
  inferTasksDir,
  tasksDirForActiveFile,
  parseTaskPath,
  isInTaskTree,
  taskFolderPrefixOf,
  resolveTaskEntry,
  ensureFolder,
  resolveTaskTarget,
  buildTaskLink,
  buildSourceLink,
  buildFolderReadme,
  // 状态机里程碑：MILESTONE_TYPE 把中文显示字面映射成 frontmatter type 枚举，
  // appendMilestone 走 _yaml.addMilestone（loadHelper 加载 _yaml.js 传入 yamlHelpers，
  // 绕开 QuickAdd 沙盒对相对 require 的限制）。
  MILESTONE_TYPE,
  appendMilestone,
};
