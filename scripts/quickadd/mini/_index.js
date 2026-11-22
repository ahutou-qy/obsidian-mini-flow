// ==============================================
// Mini Flow - README 自动索引段的写入逻辑
//
// 三个调用方共用本文件，消除插入位置规则漂移：
//   - miniflow 插件（打开/增删文件时静默重写）
//   - task-refresh-index（QuickAdd 手动补刷）
//   - task-upgrade（升级时一次性注入骨架）
// walk 生成索引体在 _walk.js，本文件只负责"把索引体塞进 README 的正确位置"。
//
// 入口：
//   replaceOrInsertIndex(content, body) 有哨兵则替换哨兵间内容，否则补整段。刷新路径用。
//   insertIndexSection(content, body)    已存在 `## 文件索引` 段则原样返回，否则补整段。
//                                        升级路径用（幂等：重复升级不重复插段）。
//
// 无哨兵时的插入位置：文件索引是置顶导航段，插在第一个 `## ` 段之前（frontmatter 之后）。
// 旧 README（含 `## 输出`/`## 过程`/`## 笔记`/`## AI 上下文` 等历史段名）也一律置顶，
// 不再按旧名挂在段末——README 新版正文三段为 进展/输入/内化（2026-08-24 起索引置顶）。
// 跟 QuickAdd 沙盒同模式：用 new Function 字符串加载，不 export 相对路径。
// ==============================================

const INDEX_HEADER = "## 文件索引";
const INDEX_START = "<!-- auto-index:start -->";
const INDEX_END = "<!-- auto-index:end -->";

function buildSection(indexBody) {
  return `${INDEX_HEADER}\n${INDEX_START}\n${indexBody}\n${INDEX_END}\n`;
}

// 把完整 section（含标题与哨兵）插到第一个 `## ` 正文段之前（文件索引置顶）。
// frontmatter 已由调用方在 content 里，`^## ` 首个命中即正文第一段；无则文末。
function insertSection(content, section) {
  const firstHeader = content.match(/^##[ \t]+/m);
  if (firstHeader) {
    const at = firstHeader.index;
    return `${content.slice(0, at).replace(/\s*$/, "\n\n")}${section}\n${content.slice(at)}`;
  }
  return `${content.replace(/\s*$/, "")}\n\n${section}`;
}

function replaceOrInsertIndex(content, indexBody) {
  const startIdx = content.indexOf(INDEX_START);
  const endIdx = content.indexOf(INDEX_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // 哨兵之间的内容整段替换；标题行和哨兵行本身不动
    const before = content.slice(0, startIdx + INDEX_START.length);
    const after = content.slice(endIdx);
    return `${before}\n${indexBody}\n${after}`;
  }
  return insertSection(content, buildSection(indexBody));
}

function insertIndexSection(content, indexBody) {
  // 幂等：已存在索引标题就不动（升级场景可能重复触发）。
  if (content.match(/^##[ \t]+文件索引[ \t]*$/m)) return content;
  return insertSection(content, buildSection(indexBody));
}

module.exports = {
  INDEX_HEADER,
  INDEX_START,
  INDEX_END,
  replaceOrInsertIndex,
  insertIndexSection,
};
