// ==============================================
// Mini Flow - 共享命名工具
//
// 所有把"checkbox 行文本"或"原始标题"转成磁盘文件名的入口
// （task.js 等）都必须走这里，否则会出现
// 「创建时清理了字符，重命名/升级时没清理」导致对不上磁盘文件。
//
// - cleanTitle 是"语义层"清洗：剥 [[wiki]] 别名、剥 #tag、剥 [key:: value]
//   inline field（[qy:: id]、[completion:: 日期]）和行尾块 ID、折叠空白。
// - sanitize    是"文件系统层"清洗：替换非法字符为 `-`。
// - truncateSmart 在不超过 80 字符的前提下找最后一个智能断点截断。
// - buildFileName 是上面三步的合集，标题 → 最终文件名。
// - findUniquePath 在指定目录下找不冲突的 createPath，撞名追加 -2/-3。
// ==============================================

const MAX_FILENAME_LENGTH = 30;

// 智能截断的候选断点字符。出现冲突时取最后一个 < limit 的命中位置。
// 注意：cleanTitle 已折叠空白，所以这里不放空格；保留中英文常见分隔符。
const SMART_BREAK_CHARS = ["、", "；", "，", "（", ",", ";", ":", "."];

// 把 checkbox 行文本剥成"基名"：[[wiki]] 取 alias 或 target；剥 [key:: value]
// inline field、行内 #tag 和行尾块 ID；折叠空白。
function cleanTitle(body) {
  return String(body)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/\[[^\]]*::[^\]]*\]/g, "")
    .replace(/(^|\s)#[^\s#]+/g, "")
    .replace(/(^|\s)\^[A-Za-z0-9-]+\s*$/g, "")
    .trim()
    .replace(/\s+/g, "");
}

// 把基名转成合法文件名：非法字符 → `-`，折叠空白与连续 `-`，剥首尾 `-`。
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|#^[\]()]/g, "-")
    .replace(/\s+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// 智能截断：优先在 SMART_BREAK_CHARS 上断，断后再剥一次尾部 `-`/空白；
// 没有智能断点则硬砍到 limit。emoji 等 surrogate pair 占 2 个 UTF-16 code unit，
// 硬砍可能切到一半；如果最后一位是 high surrogate，退一位。
function truncateSmart(name, limit) {
  if (!name || name.length <= limit) return name;
  let cutAt = -1;
  for (let i = 0; i < limit; i++) {
    if (SMART_BREAK_CHARS.includes(name[i])) cutAt = i;
  }
  let raw = cutAt > 0 ? name.slice(0, cutAt) : name.slice(0, limit);
  const lastCode = raw.charCodeAt(raw.length - 1);
  // 末尾是 high surrogate 时 low 被切掉，砍掉；末尾是 low 时前面必有 high（pair 完整），保留。
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    raw = raw.slice(0, -1);
  }
  return raw.replace(/[-…\s]+$/, "");
}

// cleanTitle → sanitize → truncateSmart 的合集。
// 输入允许是 checkbox 行原文或已经过 cleanTitle 的基名（幂等）。
// **maxLen 由调用方从 `behavior.maxFilenameLength` 传入**（阶段 2 方案 A：配置走函数
// 参数，本文件保持纯函数）；不传则用 MAX_FILENAME_LENGTH 兜底。**所有入口必须传同一个
// 值**——否则会出现「建任务用配置值、改名/升级用默认 30」，磁盘名与月度行别名对不上。
function buildFileName(rawTitle, maxLen = MAX_FILENAME_LENGTH) {
  const cleaned = cleanTitle(rawTitle);
  const safe = sanitize(cleaned);
  if (!safe) return "未命名任务";
  return truncateSmart(safe, maxLen) || "未命名任务";
}

// 给定目录 + 基名，找一个不冲突的 createPath。
// `<stem>.md` 不存在 → 直接用；存在 → 试 `<stem>-2.md`、`<stem>-3.md`...
// 上限 -999，避免无限循环。
// 撞名后追加 `-N` 可能突破上限；本函数在拼接后再调 truncateSmart 把 stem 部分压回去，
// 保证最终 createPath 的 stem 长度始终受同一上限约束。
// maxLen 同 buildFileName：调用方传配置值，两处必须同源。
function findUniquePath(vault, dirPath, stem, maxLen = MAX_FILENAME_LENGTH) {
  const ext = ".md";
  const fit = (suffix) => {
    const combined = suffix ? `${stem}${suffix}` : stem;
    if (combined.length <= maxLen) return combined;
    const budget = maxLen - suffix.length;
    return truncateSmart(stem, budget) + suffix;
  };

  const directName = fit("");
  const direct = `${dirPath}/${directName}${ext}`;
  if (!vault.getAbstractFileByPath(direct)) {
    return { createPath: direct, name: directName };
  }
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const candidate = fit(suffix);
    const path = `${dirPath}/${candidate}${ext}`;
    if (!vault.getAbstractFileByPath(path)) {
      return { createPath: path, name: candidate };
    }
  }
  throw new Error(`无法为 ${stem} 生成唯一文件名（已尝试到 -999）`);
}

module.exports = {
  cleanTitle,
  sanitize,
  truncateSmart,
  buildFileName,
  findUniquePath,
  MAX_FILENAME_LENGTH,
};
