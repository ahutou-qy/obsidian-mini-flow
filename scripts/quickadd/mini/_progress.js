// ==============================================
// Mini Flow - `## 进展` 段的纯函数（2026-11-19 段 4 从 progress-checkin.js 下沉）
//
// 两个调用方：QuickAdd 宏 Progress Checkin（人点，带输入框/Notice/光标定位）与
// CLI `mf.js progress`（MCP 侧带参调用）。交互留在各自入口，**追加算法只有这一份**。
//
// 与 milestones 的分工：frontmatter milestones 是状态事件（create/finish/reopen，命令写）；
// `## 进展` 是人写的进度叙事。本模块只算正文，不碰 frontmatter。
//
// 阈值 SOFT_LIMIT 与 `_finish.js` 的收口阈值（5）对齐；bullet 判据与
// `_finish.js#PROGRESS_BULLET_RE` 同款（模型名可含空格，勿收窄成单 token）。
// 段头正则容忍尾部 `\r`：本仓 CRLF，逐行非 /m 的 `$` 不认 `\r`，否则计数恒 0。
// ==============================================

const PROGRESS_HEADER = "## 进展";
const PROGRESS_HINT =
  "> 人写的过程叙事，按 `- 日期 | 做了什么` 追加；AI 协作记录用 `·` 分隔模型名（`日期 · 模型 | 事`）。\n" +
  "> 状态里程碑（创建/完成）由命令写 frontmatter `milestones`，不在此段重复。";

const SOFT_LIMIT = 5;

// 纯函数：在 content 的 `## 进展` 段末追加 `- today | body`。
// 段不存在则创建（带提示 blockquote），位置：`## 输入` 之前 → 首个非 `## 文件索引`
// 的 `## ` 之前（文件索引 2026-08-24 起置顶，进展须在其下）→ 文末。
// 返回 { content, appendedLine }，appendedLine 是新 bullet 的 0-based 行号（定位光标用，找不到为 -1）。
function ensureProgressSection(content, today, body) {
  const text = String(content || "");
  const bullet = `- ${today} | ${body}`;

  const headerMatch = text.match(/^##[ \t]+进展[ \t]*$/m);
  if (headerMatch) {
    const sectionStart = headerMatch.index + headerMatch[0].length;
    const rest = text.slice(sectionStart);
    // 段末 = 下一个同级 ## 之前；无则文末。
    const nextHeader = rest.match(/^##[ \t]+/m);
    const insertAt = nextHeader ? sectionStart + nextHeader.index : text.length;
    const before = text.slice(0, insertAt).replace(/\s*$/, "");
    const after = text.slice(insertAt).replace(/^\s*/, "");
    const nextText = `${before}\n${bullet}\n\n${after}`;
    return { content: nextText, appendedLine: nextText.slice(0, before.length + 1).split("\n").length - 1 };
  }

  const block = `${PROGRESS_HEADER}\n\n${PROGRESS_HINT}\n\n${bullet}\n\n`;

  // 优先插在 `## 输入` 之前（新模板：文件索引 → 进展 → 输入）。
  const inputHeader = text.match(/^##[ \t]+输入[ \t]*$/m);
  if (inputHeader) {
    const at = inputHeader.index;
    const nextText = `${text.slice(0, at).replace(/\s*$/, "\n\n")}${block}${text.slice(at)}`;
    return { content: nextText, appendedLine: lineOfBullet(nextText, bullet) };
  }
  // 老 README：插在第一个非「文件索引」的 ## 段之前（索引置顶，进展压在其下）。
  const firstBodyHeader = text.match(/^##[ \t]+(?!文件索引[ \t]*$).*$/m);
  if (firstBodyHeader) {
    const at = firstBodyHeader.index;
    const nextText = `${text.slice(0, at).replace(/\s*$/, "\n\n")}${block}${text.slice(at)}`;
    return { content: nextText, appendedLine: lineOfBullet(nextText, bullet) };
  }
  // 都没有：文末。
  const nextText = `${text.replace(/\s*$/, "")}\n\n${block}`;
  return { content: nextText, appendedLine: lineOfBullet(nextText, bullet) };
}

function lineOfBullet(content, bullet) {
  const idx = content.indexOf(bullet);
  if (idx === -1) return -1;
  return content.slice(0, idx).split("\n").length - 1;
}

function countProgressBullets(content) {
  const text = String(content || "");
  const lines = text.split("\n");
  const sectionStart = lines.findIndex((l) => /^##[ \t]+进展[ \t]*\r?$/.test(l));
  if (sectionStart === -1) return 0;
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^##[ \t]+\S/.test(lines[i])) { sectionEnd = i; break; }
  }
  const re = /^-\s+\d{4}-\d{2}-\d{2}(?:\s+·\s+[^|\n]+)?\s*\|/;
  let n = 0;
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    if (re.test(lines[i])) n += 1;
  }
  return n;
}

module.exports = {
  PROGRESS_HEADER,
  PROGRESS_HINT,
  SOFT_LIMIT,
  ensureProgressSection,
  lineOfBullet,
  countProgressBullets,
};