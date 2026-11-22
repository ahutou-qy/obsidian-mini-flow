// ==============================================
// Mini Flow - capture 核心（Obsidian 与 CLI 共用）
//
// 把"一条 idea 落成 folder 任务 + 月度 Capture 行"的编排抽在这里，供 task-capture.js
// （QuickAdd 宏 / Obsidian Mod+T）与 mvp/agent-capture.js（AI 侧 CLI，2026-11-09 起）共用。
// 任务状态以 Obsidian 为唯一真相；建任务逻辑只此一份，任何入口不得另写。
//（2026-08 曾删掉 AI/会话侧 CLI 入口；2026-11-09 按需求补回，且改为「先问后建」，
// 见 vault 根 CLAUDE.md「任务系统」的 capture 边界段。）
//
// 极简模型（2026-08 第二次转向，删去范围/条目/事件类型/因果/标签，2026-08-20 第三次：
// 删 process/*.md narrative + ## AI 上下文 段）：
// - 每次 capture 一律建 folder（<月目录>/<名>/README.md + input/process/output/）。
//   process/ 仅作 artifact 容器（脚本/JSON/XML/CSV/PY/LOG 等），narrative 不再放 process/。
//   narrative 一律进 README 的 ## 笔记 段。
// - 月度 Capture 一行 = 一个任务；一律无 checkbox 形态
//   `- [[08/名/README|名]] #active ^cap-xxx`（领域只存 README frontmatter，行内不再打 tag）。
// - 状态写行内 #active（唯一活跃档）/ #finish（完成，补 [completion:: 日期]）。
// - README frontmatter `milestones` 字段记里程碑（create/archive/finish/reopen/manual），
//   由 capture 与 task-finish 追加。
// - 机器不写 README（AI 上下文段已下线，obsidian-snapshot 改产文本模式）。
//
// 运行环境无关：`vault` 是 Obsidian-vault 形状适配器，本文件一律 await（见下）。
// `now` 支持 moment-like（window.moment()）或原生 Date。
// ==============================================

// cap- + 8 位 base36；Obsidian 块引用天然稳定，行号变化不影响跳转。
function newAnchorId() {
  return `cap-${Math.random().toString(36).slice(2, 10)}`;
}

// 建齐 flow/data/YYYY/Qn 目录，返回当月 idea 文件；不存在则按模板建。
async function ensureMonthFile(vault, { year, month, quarter }) {
  const monthFilePath = `flow/data/${year}/${quarter}/ideas-${year}-${month}.md`;
  for (const folder of [`flow/data/${year}`, `flow/data/${year}/${quarter}`]) {
    if (!await vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
  }
  let monthFile = await vault.getAbstractFileByPath(monthFilePath);
  if (!monthFile) {
    monthFile = await vault.create(monthFilePath, buildMonthTemplate(year, month, quarter));
  }
  return monthFile;
}

// 月度 Capture 行形态（统一无 checkbox 形态，2026-09-14 取消测试任务 toggle 后）：
//   `- [[08/名/README|名]] #active ^cap-xxx`
// 状态两态互斥：#active（活跃）、#finish（完成，带 [completion:: 日期]）。
// 领域/工作归属都在 README frontmatter（2026-11-16 起行内不再打 #domain/<域>，同一事实不两处写）；
// 无 follows/事件/用户标签。
// 老 capture 行可能含 `- [ ] ` 前缀（历史测试任务遗留），reader-side wide 兼容。
async function appendCaptureLine(vault, monthFile, { linkText, sourceAnchorId, status, completion }) {
  const tags = [`#${status || "active"}`];
  const completionField = completion ? ` [completion:: ${completion}]` : "";
  const newTaskLine = `- ${linkText} ${tags.join(" ")}${completionField} ^${sourceAnchorId}`;

  const content = await vault.read(monthFile);
  const updated = appendToSection(content, "## Capture", newTaskLine);
  if (updated === null) {
    await vault.modify(monthFile, `${content.trimEnd()}\n\n## Capture\n\n${newTaskLine}\n`);
  } else {
    await vault.modify(monthFile, updated);
  }
}

// capture：建 folder 任务（README + input/process/output/，process/ 2026-08-20 改造后
// 只装非 md 工件），写月度 Capture 行。
// title = 任务名（文件名）；status = active（capture 只产活跃态，完成由 task-finish 推进）。
// research = 可选正文，建完写进 README `### 调研` 小节末尾（AI 侧的对话上下文走这里）。
// 2026-11-16 起不再收 isWork / kind：两者都由 domain 的 flow.json 派生，不落 frontmatter。
async function captureIdea(vault, helpers, { title, status, now, domain, topic, research }) {
  const { buildFileName, findUniquePath } = helpers.naming;
  // 文件名上限从注入的 config 取（调用方加载 `_config.js` 后放进 helpers.config）。
  // 没注入就 undefined → `_naming.js` 用 MAX_FILENAME_LENGTH 兜底。**建任务与改名/升级
  // 必须用同一个值**，否则磁盘名与月度行别名对不上（见 _naming.js#buildFileName 头注）。
  const maxLen = helpers.config && helpers.config.behavior
    ? helpers.config.behavior.maxFilenameLength
    : undefined;
  const { ensureFolder, buildFolderReadme, joinPath, computeDateParts, inferTasksDir } = helpers.task;

  const { year, month, day, quarter } = computeDateParts(now);
  const monthFile = await ensureMonthFile(vault, { year, month, quarter });
  const sourceAnchorId = newAnchorId();

  const tasksFolder = inferTasksDir(null, now);
  await ensureFolder(vault, tasksFolder);

  const stem = buildFileName(title, maxLen);
  const unique = findUniquePath(vault, tasksFolder, stem, maxLen);
  const folderPath = unique.createPath.replace(/\.md$/, "");
  const readmePath = joinPath(folderPath, "README.md");
  if (vault.getAbstractFileByPath(folderPath) || vault.getAbstractFileByPath(readmePath)) {
    return { conflict: `同名任务目录已存在：${folderPath}` };
  }

  const created = `${year}-${month}-${day}`;
  await createFolderSkeleton(vault, helpers, folderPath);

  const readmeBody = await buildFolderReadme({
    vault,
    title,
    created,
    sourceFile: monthFile.basename,
    sourceAnchor: `#^${sourceAnchorId}`,
    domain: domain || null,
    topic: topic ? String(topic).trim() : "",
  });
  const readme = await vault.create(readmePath, readmeBody);

  // AI 侧上下文：写进 ## 内化 → ### 调研 小节末尾；没有该小节（极端：domain 覆写模板删了它）
  // 时退化为不写——不静默改别的小节。
  const researchText = typeof research === "string" ? research.trim() : "";
  if (researchText) {
    const body = await vault.read(readme);
    const next = appendToSubsection(body, "### 调研", researchText);
    if (next && next !== body) await vault.modify(readme, next);
  }

  const readmePathNoExt = readmePath.replace(/\.md$/, "");
  // 月度行链接用相对 Qn 月文件的 `MM/<名>/README` 形式（与历史行一致，linkTargetOf 据此补全）。
  const monthLink = readmePathNoExt.replace(/^flow\/data\/\d{4}\/Q[1-4]\//, "");
  await appendCaptureLine(vault, monthFile, {
    linkText: `[[${monthLink}|${title}]]`,
    sourceAnchorId,
    status: status || "active",
  });

  return {
    taskPath: readme.path,
    monthFilePath: monthFile.path,
    anchor: sourceAnchorId,
    created: true,
    folder: true,
  };
}

// 建 folder 的三个空目录：input（外部原始输入，未加工）、process（2026-08-20 改造后
// 只装非 md 工件）、output（产出物：交付件/成果/报告）。不建 INDEX、不 walk
//（createFolder 后同事件循环 children 可能 stale，见 flow/CLAUDE.md）。
async function createFolderSkeleton(vault, helpers, folderPath) {
  const { joinPath } = helpers.task;
  await vault.createFolder(folderPath);
  await vault.createFolder(joinPath(folderPath, "input"));
  await vault.createFolder(joinPath(folderPath, "process"));
  await vault.createFolder(joinPath(folderPath, "output"));
}

// ---------- 追加到指定 ## 章节末尾（跳过代码围栏） ----------
function appendToSection(content, sectionHeader, newTaskLine) {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.trim() === sectionHeader);
  if (idx === -1) return null;

  let endIdx = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].match(/^##\s/)) { endIdx = i; break; }
  }

  // 定位追加位置按"最后一个 `- ` 列表行"——同时吃历史 checkbox 行（`- [ ] `）与无 checkbox 形态。
  let insertAt = idx + 1;
  let inFence = false;
  for (let i = idx + 1; i < endIdx; i++) {
    if (lines[i].match(/^\s*```/)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (lines[i].match(/^\s*-\s/)) insertAt = i + 1;
  }

  lines.splice(insertAt, 0, newTaskLine);
  return lines.join("\n");
}

// ---------- 追加到指定 ### 小节末尾（跳过代码围栏） ----------
// 用于 AI 侧 capture 把对话上下文写进 `### 调研`。`appendToSection` 只认 `##` 段边界，
// 这里按「下一个 #/##/### 标题」截段。找不到小节返回 null（调用方据此跳过，不猜落点）。
function appendToSubsection(content, header, text) {
  const body = String(text == null ? "" : text).replace(/\s+$/, "");
  if (!body) return content;
  const lines = String(content == null ? "" : content).split("\n");
  const idx = lines.findIndex((l) => l.trim() === header);
  if (idx === -1) return null;

  let endIdx = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) { endIdx = i; break; }
  }

  // 插到该小节最后一个非空行之后；正文块前留一个空行，块后与下一标题之间也留一个空行。
  let last = idx;
  for (let i = idx + 1; i < endIdx; i++) {
    if (lines[i].trim() !== "") last = i;
  }
  const block = ["", ...body.split("\n")];
  if (last + 1 < lines.length && lines[last + 1].trim() !== "") block.push("");
  lines.splice(last + 1, 0, ...block);
  return lines.join("\n");
}

function buildMonthTemplate(year, month, quarter) {
  return `---
type: idea-monthly
year: ${year}
month: ${month}
quarter: ${quarter}
created: ${year}-${month}-01
tags:
  - flow/idea
---

# ${year} 年 ${month} 月 ideas

> 本月任务索引。\`## Capture\` 一行 = 一个任务（一律 folder，点链接进 README）。
> - capture（Mod+T）填任务名、选领域，在当月目录 \`Qn/MM/\` 建任务 folder。
> - 状态写行内 \`#active\`（唯一活跃档）、\`#finish\`（完成，带 \`[completion:: 日期]\`）；
>   状态由 Task Finish 推进，Task Edit 事后改。
> - 领域只存任务 README frontmatter 的 \`domain:\`（2026-11-16 起行内不再打 \`#domain/<域>\`）。
> - 完成又有新进展用 Task Edit「重开」回到 active，同一任务继续推进，不新建任务关联。

## Capture

## 已升级
`;
}

module.exports = {
  captureIdea,
  appendToSection,
  appendToSubsection,
  appendCaptureLine,
  buildMonthTemplate,
};
