// ==============================================
// Mini Flow - 共享领域规则工具
//
// rule-capture.js（QuickAdd）建规则笔记、往任务写「产出规则」块的公共逻辑。
// 规则落点 flow/data/domains/<domain>/rules/<slug>.md，一规则一文件。
// 段结构（规则 / 边界与反例 / 变更）由本文件生成，是唯一真源——**没有模板文件**
// （2026-10-15 更正：旧注释里的 `templates/rule.md` 从未随 mac vault 快照迁过来）。
//
// `vault` 形状同 _capture.js：Obsidian app.vault（async）或 fs 封装（同步），
// 本文件一律 await。
// ==============================================

const DOMAINS_ROOT = "flow/data/domains";

function rulesFolder(domain) {
  return `${DOMAINS_ROOT}/${domain}/rules`;
}

function rulePath(domain, fileName) {
  return `${rulesFolder(domain)}/${fileName}.md`;
}

// 列出现有领域：domains/ 下含 rules/ 子目录的直接子文件夹。
// 下划线开头（如 _template 脚手架）跳过，不算可沉淀规则的域。
async function listDomains(vault) {
  const root = await vault.getAbstractFileByPath(DOMAINS_ROOT);
  if (!root || !Array.isArray(root.children)) return [];
  const domains = [];
  for (const child of root.children) {
    if (!child.children) continue; // 只要目录
    if (child.name.startsWith("_")) continue;
    if (child.children.some((c) => c.name === "rules")) domains.push(child.name);
  }
  return domains;
}

// 规则笔记骨架。sourceTaskPathNoExt 是去掉 .md 的 vault 根相对任务路径
// （folder README 形如 flow/data/.../MM/<名>/README）。
// supersedes 是被本规则取代的旧规则路径数组（不含 .md）；空数组 = 没取代任何。
function buildRuleNote({ title, statement, domain, subtags, created, sourceTaskPathNoExt, supersedes }) {
  const tags = [`rule/${domain}`, ...subtags.map((s) => `rule/${domain}/${s}`)];
  const tagLines = tags.map((t) => `  - ${t}`).join("\n");
  const sourceLink = `[[${sourceTaskPathNoExt}]]`;
  const stmt = statement ? String(statement).trim() : "";
  const supList = Array.isArray(supersedes) ? supersedes : [];
  const supLines = supList.length
    ? supList.map((p) => `  - "${p.replace(/"/g, '\\"')}"`).join("\n")
    : "";

  return `---
type: rule
domain: ${domain}
status: proposed
created: ${created}
sources:
  - "${sourceLink}"
validated_by: []
supersedes:
${supLines || "  []"}
tags:
${tagLines}
---

# ${title}

## 规则
> 一句：在 <条件> 下，必须/应当 <动作>，因为 <原因>。脱离具体客户/项目仍成立才记这里。

${stmt}

## 依据与正反例
> 只链任务 ## 笔记 段、设计文档或 commit，不复述内容。
-

## 边界与反例
> 什么时候不适用。没有边界的规则是口号。
-

## 变更
- ${created} | proposed from ${sourceLink}
`;
}

// 往任务笔记追加「## 产出规则」块并加一条链接。幂等：已链同一规则不动。
function appendProducedRuleBlock(content, rulePathNoExt, title) {
  if (content.includes(rulePathNoExt)) return content;
  const bullet = `- [[${rulePathNoExt}|${title}]]`;
  const lines = content.split("\n");
  const headerIdx = lines.findIndex((l) => /^##\s+产出规则\s*$/.test(l));

  if (headerIdx === -1) {
    return `${content.replace(/\s*$/, "")}\n\n## 产出规则\n\n${bullet}\n`;
  }

  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { endIdx = i; break; }
  }
  let insertAt = headerIdx + 1;
  for (let i = headerIdx + 1; i < endIdx; i++) {
    if (lines[i].trim().length > 0) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
}

// folder README 显示父目录名，单文件显示 basename。
function taskDisplayName(file) {
  if (file.basename === "README" && file.parent) return file.parent.name;
  return file.basename;
}

module.exports = {
  DOMAINS_ROOT,
  rulesFolder,
  rulePath,
  listDomains,
  buildRuleNote,
  appendProducedRuleBlock,
  taskDisplayName,
};
