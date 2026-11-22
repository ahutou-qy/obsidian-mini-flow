// ==============================================
// Mini Flow - Task Finish 的盘面动作（公共）
//
// 从 task-finish-gui.js 抽出：状态推进目标、月度行改写、`## 进展` 段收口
// 与归档。留在这里的原因是它有两个调用方：
//   1. task-finish-gui.js（人点 Task Finish，附带关 tab / 回 Home 等交互）；
//   2. miniflow 插件（消费 flow/qy-merge-inbox.json 等云效旁车队列，把 qy
//      的事实写回任务；后台静默，不动 tab。云效 / qy 半边 2026-11-20 起是
//      miniflow 插件的内部模块，不再是独立插件——见 flow/CLAUDE.md 旁车队列段）。
// 两处必须同一套格式与阈值——`_yaml.js#addMilestone` 的幂等键是 {date,type}，
// 各写一份就必然漂移（同一天多条 manual 会互相覆盖 note）。
//
// 月度行改写自 2026-11-19 起**不在本文件实现**：rewriteStatusLine 只是
// `_capture-line-rewrite.js#rewriteStatus` 的转调壳（写面收敛，见该文件头注）。
//
// 交互动作（关 README leaf、回 Home、二次确认、Notice）不进本文件：它们只在
// 人主动触发的命令里成立。
// ==============================================

// 活跃（active/无状态/老未勾选行）→ finish；finish 不推进。
// 2026-08-19 删 archive 档后，唯一的推进方向就是「活跃 → 完成」一段式。
// milestone 字段保留中文（Notice 显示用），type 字段是 frontmatter 枚举。
function nextAction(parsed) {
  if (parsed.status === "finish") return null;
  // 历史 #archive 老行（2026-08-19 之前）也走完同一段式推进 → finish，
  // 不再单独分支；语义上与「finished-from-active」对齐。
  return { status: "finish", milestone: "完成", type: "finish", notice: "任务已标记完成" };
}

// 重写月度行：**转调唯一实现** `_capture-line-rewrite.js#rewriteStatus`
// （2026-11-19 写面收敛，本函数不再自带一份正则）。
// 保留 `action` 形态的签名是因为调用方（task-finish-gui / 插件 finishFromInbox /
// 归档的一次性 headless 脚本）都按 nextAction() 的产物传参。
//
// 依赖注入而非顶层 require：本文件在 Obsidian 侧由 `loadHelper` / `loadModule` 用
// `new Function("module","exports",src)` 字符串加载，**没有 require**（同 _task.js
// 收 yamlHelpers 的理由）。所以第 4 参收 `_capture-line-rewrite.js` 模块；裸 node
// （CLI / 单测 / 一次性脚本）省略时走真 require 拿 sibling。两条路都指向同一份实现，
// 不存在第二份正则。
function rewriteStatusLine(line, action, today, lineRewrite) {
  const rewriter = resolveLineRewrite(lineRewrite);
  return rewriter.rewriteStatus(line, action.status, today);
}

function resolveLineRewrite(injected) {
  if (injected && typeof injected.rewriteStatus === "function") return injected;
  // 裸 node：真 require 可用。Obsidian 字符串加载下这里会抛（window.require 解析不到
  // 相对路径），吞掉后报明确的注入缺失错误——不静默退回另一份实现。
  try {
    return require("./_capture-line-rewrite.js");
  } catch (_) {
    throw new Error(
      "rewriteStatusLine 需要注入 _capture-line-rewrite.js 模块（第 4 参）：" +
      "Obsidian 侧 loadHelper/loadModule 不提供 require");
  }
}

// 进展段 bullet 正则：`- YYYY-MM-DD[ · 模型] | ...`，日期与竖线之间允许可选 AI 协作标记。
// 模型名可含空格（`Opus 5` / `Sonnet 5.5`），故用 `[^|\n]+` 而非单 token 的 `[^\s|]+`——
// 后者认不出本 vault 实际写法，会让整段漏数、归档永不触发（2026-10-12 修）。
// `progress-checkin.js` 有同款副本（soft-warning 用），改这里时两边一起改。
// 复用给 countProgressBullets / extractProgressOverflow，二者口径必须严格一致。
const PROGRESS_BULLET_RE = /^-\s+\d{4}-\d{2}-\d{2}(?:\s+·\s+[^|\n]+)?\s*\|/;

// 切出 ## 进展 段（含段头与后续同级 ## 之前的所有行）。
// 返回 { start, end }，start 是段头行号，end 是段末下一行号（开区间）；无段则 null。
// 段头正则容忍尾部 `\r`：本仓 autocrlf=true，按 "\n" 切行后每行带 `\r`，非 multiline 的
// `$` 不认 `\r`，于是段头恒不命中、countProgressBullets 恒返 0、归档永不触发
// （2026-11-19 修；`progress-checkin.js#countProgressBullets` 是同款副本，一起改）。
function locateProgressSection(lines) {
  const start = lines.findIndex((l) => /^##[ \t]+进展[ \t]*\r?$/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##[ \t]+\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// 统计 ## 进展 段的 bullet 数（含日期格式正确即可，AI 协作标记可选）。
function countProgressBullets(content) {
  const text = String(content || "");
  const lines = text.split("\n");
  const section = locateProgressSection(lines);
  if (!section) return 0;
  let n = 0;
  for (let i = section.start + 1; i < section.end; i += 1) {
    if (PROGRESS_BULLET_RE.test(lines[i])) n += 1;
  }
  return n;
}

// 超阈值时把最早 N 条从 ## 进展 段移到 archived（按时间序保留，超出 bullet 留 5 条）。
// 返回 { content, archived: string[], movedCount }；未超返回 movedCount=0、archived=[]。
function extractProgressOverflow(content, maxBullets = 5) {
  const text = String(content || "");
  const lines = text.split("\n");
  const section = locateProgressSection(lines);
  if (!section) return { content: text, archived: [], movedCount: 0 };

  // 收集段内 bullet 行号
  const bulletIdxs = [];
  for (let i = section.start + 1; i < section.end; i += 1) {
    if (PROGRESS_BULLET_RE.test(lines[i])) bulletIdxs.push(i);
  }
  const overflow = bulletIdxs.length - maxBullets;
  if (overflow <= 0) return { content: text, archived: [], movedCount: 0 };

  // 最早的 N 条移走（按段内从上到下顺序，前 N 条即为最早）
  const toMove = bulletIdxs.slice(0, overflow);
  const archived = toMove.map((idx) => lines[idx]);

  // 重建段：保留非 bullet 内容（提示 blockquote、空行）+ 剩余 bullet
  const before = lines.slice(0, section.start + 1);
  const tail = lines.slice(section.end);
  const middleLines = [];
  for (let i = section.start + 1; i < section.end; i += 1) {
    if (!toMove.includes(i)) middleLines.push(lines[i]);
  }
  const rebuilt = [...before, ...middleLines, ...tail].join("\n");
  return { content: rebuilt, archived, movedCount: toMove.length };
}

// 写 process/R-进展历史.md：存在则追加在文末（带 ## <完成日> 归档 H3），不存在则创建带哨兵。
// 文件名带 `R-` 前缀是 vault 硬约束：process/ 根下「新增」md 必须带 NN-（01-…04-）或 R-
// 前缀，`scripts/git-hooks/pre-commit` 闸 3 直接拒绝提交；R- = 归档/记录类。归档路径与
// obsidian-snapshot skill（§4 压 ## 进展、超 5 条归档）写的是同一处，别再各写一份。
async function ensureProcessHistory(vault, readme, archived, today) {
  if (!archived || archived.length === 0) return;
  const readmeDir = readme.parent ? readme.parent.path : "";
  if (!readmeDir) return;
  const historyPath = `${readmeDir}/process/R-进展历史.md`;
  const existing = vault.getAbstractFileByPath(historyPath);
  const historyDir = `${readmeDir}/process`;
  if (!vault.getAbstractFileByPath(historyDir)) {
    await vault.createFolder(historyDir);
  }
  const block = `\n## ${today} 归档\n\n${archived.map((b) => b).join("\n")}\n`;
  if (existing && !existing.children) {
    const prev = await vault.read(existing);
    await vault.modify(existing, prev.replace(/\s*$/, "") + "\n" + block);
  } else {
    const sentinel = "<!-- 由 task-finish 自动归档，请勿手改；想回移进展段可手工复制对应 bullet 回 ## 进展 -->\n";
    await vault.create(historyPath, sentinel + block);
  }
}

// 进展段收口：bullet 超过上限时把最早 N 条移到 process/R-进展历史.md（H3 追加）。
// 上限由调用方从 `flow/config/miniflow.json` 的 `behavior.progressSoftLimit` 传入
// （三个 finish 入口各自读一次配置——人点/队列后台结案走 adapter，CLI 走 loadSync）；
// 不传则走 `extractProgressOverflow` 的默认 5，与 `_progress.js#SOFT_LIMIT` 对齐。
// 返回 undefined；未超阈值则 no-op。`## 结果` 段原是完成态硬卡点（强制填三段），
// 2026-09-17 取消后本函数只承担进展归档职责。
async function archiveOverflowProgress(vault, readme, today, maxBullets) {
  const prev = await vault.read(readme);
  const overflow = extractProgressOverflow(prev, maxBullets);
  if (overflow.movedCount > 0) {
    await ensureProcessHistory(vault, readme, overflow.archived, today);
    await vault.modify(readme, overflow.content);
  }
}

// ==============================================
// 交付证据软闸（设计 / 自测段）——2026-11-20
//
// 背景：`## 结果` 硬卡点 2026-09-17 取消后，finish 对验证证据**零检查**，交付任务
// 890 填得满是自觉不是机制（父卡缺口分析「环节 4」：回归档位普遍缺失）。这里补一道
// **软闸**：交付任务结案时若 `### 设计` / `### 自测` 段还是模板骨架，出提示但**不拦**。
//
// 三个调用方共用本判据（不许各写一份）：
//   1. task-finish-gui.js#runFinish —— 人点 Task Finish：提示挂进既有 window.confirm
//      文案（不叠横幅，Notice 策略见 flow/CLAUDE.md「Mini Flow 命令的 Notice 策略」）；
//      headless（无 confirm）发一条 Notice（三类保留情形之 2「边界提示」）。
//   2. miniflow 插件 finishFromInbox —— 消费合并/转出队列的后台结案，无确认框，
//      发一条 Notice。
//   3. `_finish.js` 自身只出判据与文案；盘面动作仍归上面两处的编排。
//
// 判据三条（2026-11-20 用户定）：
//   ① 交付任务口径**与溯源链卡同源**（build-trace-chain.js 读同两项配置
//      `behavior.deliveryDomains` / `behavior.deliveryExcludeDomains`）——不造第二套
//      口径；两边的真源关系见 isDeliveryTask 头注。
//   ② 「空」= **段在但无正文**：段整个不存在（旧单文件任务、被手工删掉）→ 不适用、
//      不提示；段在但只有模板骨架 → 提示。
//   ③ 提示形态：GUI 走 confirm 文案内联，headless 与后台结案走 Notice。
// ==============================================

// 检查哪些段（顺序即提示文案里的顺序）。
const EVIDENCE_SECTIONS = ["设计", "自测"];

// 交付线域与排除域**走配置**（`behavior.deliveryDomains` / `behavior.deliveryExcludeDomains`，
// 2026-11-21 起）：域名清单是各人自己的业务口径，不该写死在代码里——写死会让这套东西
// 只对某一个 vault 成立，开源出去别人改不了。默认两项皆空，口径退化为
// 「有 yunxiao_id 或 有 output/ 交付物即交付任务」，仍是有效软闸。
// **与溯源链聚合脚本同源**：那边读同两项配置，别在各处另写一份域名清单——
// 漂了会让溯源链卡与 finish 软闸对同一批任务给出不同答案。
const DELIVERY_DOMAINS_DEFAULT = [];
const DELIVERY_EXCLUDED_DOMAINS_DEFAULT = [];

// 配置值 → Set。允许数组、逗号分隔字符串、undefined（回落默认空）。
function domainSet(value, fallback) {
  const arr = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.trim() ? value.split(",") : fallback);
  return new Set((arr || []).map((s) => String(s).trim()).filter(Boolean));
}

// 模板自带的说明行（非引用、非表格）：`flow/templates/task/folder-readme.md` 的
// `### 设计` 段在四列表前有一行"需求 → 功能四列映射（…）："，它是骨架不是人写的正文。
// **改模板这两段的文案要同步这里**——漏改的后果是该段永远判"有正文"、软闸静默失效
// （只影响设计段，自测段没有说明行）。
const TEMPLATE_GUIDANCE_PREFIXES = ["需求 → 功能四列映射"];

// 切出 `### <name>` 段（H3，到下一个 H3/H2 或文末为止）。返回 {start,end}，end 开区间。
// 段头正则容忍尾部 `\r`（同 locateProgressSection 的理由：autocrlf 下逐行 `$` 不认 \r）。
function locateEvidenceSection(lines, name) {
  const start = lines.findIndex((l) => new RegExp(`^###[ \\t]+${name}[ \\t]*\\r?$`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}[ \t]+\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// 表格分隔行：`| --- | --- |` / `|:---|`。带 "-" 才算（纯 `| |` 不是分隔行）。
function isTableSeparator(line) {
  const t = String(line || "").trim();
  return /^\|[\s:|-]+\|$/.test(t) && t.includes("-");
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(String(line || ""));
}

// 表行里有没有填过内容的单元格（`|  |  |  |` 全空 → false）。
function rowHasFilledCell(line) {
  return String(line || "").trim()
    .replace(/^\|/, "").replace(/\|$/, "")
    .split("|").some((c) => c.trim() !== "");
}

// 段内有没有「正文」——即剥掉模板骨架后还剩不剩东西。骨架四类：
//   空行 / `>` 引用行 / 表格结构行（分隔行、紧邻分隔行的表头行、全空单元格行）/
//   模板说明行（TEMPLATE_GUIDANCE_PREFIXES）。
// 只要有一行是人写的内容就返回 true。
function evidenceSectionHasBody(lines, section) {
  for (let i = section.start + 1; i < section.end; i += 1) {
    const raw = String(lines[i] == null ? "" : lines[i]);
    const t = raw.trim();
    if (!t) continue;                                  // 空行
    if (t.startsWith(">")) continue;                   // 模板引用行
    if (isTableSeparator(t)) continue;                 // 表分隔行
    if (isTableRow(raw)) {
      const next = String(lines[i + 1] == null ? "" : lines[i + 1]).trim();
      if (isTableSeparator(next)) continue;            // 表头行（紧邻分隔行的那行）
      if (!rowHasFilledCell(raw)) continue;            // 全空单元格的占位行
      return true;                                     // 表里真填了内容
    }
    if (TEMPLATE_GUIDANCE_PREFIXES.some((p) => t.startsWith(p))) continue;
    return true;
  }
  return false;
}

// 段在但无正文的段名列表（顺序按 EVIDENCE_SECTIONS）。
// 段不存在 → 跳过（不适用，不提示）——旧单文件任务、或有人整段删掉，都不该被点名。
function emptyEvidenceSections(content) {
  const lines = String(content || "").split("\n");
  const empty = [];
  for (const name of EVIDENCE_SECTIONS) {
    const section = locateEvidenceSection(lines, name);
    if (!section) continue;
    if (!evidenceSectionHasBody(lines, section)) empty.push(name);
  }
  return empty;
}

// 交付任务口径：与溯源链卡（build-trace-chain.js）**同源**，逐条对应它的
//   deliveryDomains.has(domain) || !!yunxiaoId || (outputs.length > 0 && !excludeDomains.has(domain))
// 那份是 task process/ 里的聚合脚本（改口径要重跑全量），这份是 finish 时的实时判据；
// 两边读同两项配置，否则同一条任务会"在溯源链卡里、却收不到 finish 提醒"。
// inputs: { domain, yunxiaoId, outputs, deliveryDomains, deliveryExcludeDomains }
//   —— outputs 是任务 output/ 下的文件名数组；后两项来自 `behavior` 组，缺省即空清单。
function isDeliveryTask({
  domain, yunxiaoId, outputs, deliveryDomains, deliveryExcludeDomains,
} = {}) {
  const dom = String(domain || "").trim();
  if (domainSet(deliveryDomains, DELIVERY_DOMAINS_DEFAULT).has(dom)) return true;
  if (String(yunxiaoId || "").trim()) return true;
  const n = Array.isArray(outputs) ? outputs.length : 0;
  return n > 0 && !domainSet(deliveryExcludeDomains, DELIVERY_EXCLUDED_DOMAINS_DEFAULT).has(dom);
}

// 提示文案；不适用 / 都有正文 → 空串（调用方据此决定出不出提示）。
function evidenceWarning({
  text, domain, yunxiaoId, outputs, deliveryDomains, deliveryExcludeDomains,
} = {}) {
  if (!isDeliveryTask({ domain, yunxiaoId, outputs, deliveryDomains, deliveryExcludeDomains })) return "";
  const empty = emptyEvidenceSections(text);
  if (empty.length === 0) return "";
  const names = empty.map((n) => `### ${n}`).join("、");
  return `⚠ 结案提醒：本交付任务的 ${names} 段仍是模板骨架（无正文），未留验证证据。`;
}

// IO 面：读 README + frontmatter + output/ 目录，组装上面的判据。
// 三个调用方都走这一条（读法与列目录不许各写一份）。
// yamlHelpers 需要 FRONTMATTER_RE / getDomain / getYunxiaoId（调用方本来就装载了 _yaml.js）。
// behavior?: 配置 behavior 组（调用方本来就读过配置，顺带传进来，不在这里再读一次盘）；
//   缺省时交付口径退化为「有 yunxiao_id 或有交付物」，见 isDeliveryTask 头注。
// 任何一步失败都只告警 + 返回空串——软闸是提示，不能因为读不到就把结案打断。
async function evidenceWarningFor(vault, readme, yamlHelpers, behavior) {
  try {
    const text = await vault.read(readme);
    const m = yamlHelpers.FRONTMATTER_RE.exec(String(text || ""));
    const fm = m ? m[1] : "";
    const domain = yamlHelpers.getDomain(fm);
    const yunxiaoId = yamlHelpers.getYunxiaoId(fm);
    let outputs = [];
    const dir = readme && readme.parent ? readme.parent.path : "";
    if (dir && typeof vault.list === "function") {
      try {
        const listed = await vault.list(`${dir}/output`);
        outputs = (listed && listed.files) || [];
      } catch (_) {
        outputs = []; // output/ 还没建：按"无交付物"算，不拦
      }
    }
    return evidenceWarning({
      text, domain, yunxiaoId, outputs,
      deliveryDomains: behavior && behavior.deliveryDomains,
      deliveryExcludeDomains: behavior && behavior.deliveryExcludeDomains,
    });
  } catch (e) {
    console.warn("[miniflow] 交付证据检查跳过:", e && e.message);
    return "";
  }
}

module.exports = {
  nextAction,
  rewriteStatusLine,
  PROGRESS_BULLET_RE,
  locateProgressSection,
  countProgressBullets,
  extractProgressOverflow,
  ensureProcessHistory,
  archiveOverflowProgress,
  // 交付证据软闸
  EVIDENCE_SECTIONS,
  DELIVERY_DOMAINS_DEFAULT,
  DELIVERY_EXCLUDED_DOMAINS_DEFAULT,
  locateEvidenceSection,
  emptyEvidenceSections,
  isDeliveryTask,
  evidenceWarning,
  evidenceWarningFor,
};

