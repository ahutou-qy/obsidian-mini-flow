// ==============================================
// Mini Flow - 规则评审机制共享工具（rule-review）
//
// 范围：让 rules/<域>/<slug>.md 的 proposed → confirmed → deprecated 状态过渡
// 能跑起来。设计见 flow/data/2026/Q4/10/miniflow中还少一个rule的评审机制/
// process/01-评审机制设计方案.md §一~§四。
//
// 与 _rule.js 平行：_rule.js 负责"记录落盘"（建规则、写 sources、appendProducedRuleBlock），
// _rule-review.js 负责"评审"（写 validated_by、status 晋级/降级、任务侧反向链 ## 引用规则）。
// 不互相依赖，全部纯字符串 + frontmatter 块读写，零依赖。
//
// 阈值（已与 qy 在 2026-10-14 锁定）：
//   PROMOTE_THRESHOLD = 2 —— sources + validated_by 合并去重 unique 数 ≥ 2 → 触发
//   confirmed 自动晋级。去重有两层：
//   ① 路径层：按 wikilink 解析后的绝对路径比较（见 §resolveEntryPath），
//      旧的 workcat 规则相对路径写法要去掉 .. 后再比较（去重不丢同源条目）。
//   ② **任务层**（2026-11-06 补）：同一任务的**多篇文档**（README + process/…）
//      折叠成同一个身份，只计 1——阈值衡量的是「被几个不同任务验证过」，
//      不是「有几篇文档提到它」。见 §taskIdentityOf。
//
// 不接 task-finish / task-capture / yunxiao 物化——评审与任务生命周期解耦。
// ==============================================

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

// 合并去重阈值：sources + validated_by 合并去重后的 unique **任务** 数 ≥ 此值 → auto-confirm。
// 「任务」口径：同一任务的多篇文档（README / process/…）折叠成 1，见 §taskIdentityOf。
const PROMOTE_THRESHOLD = 2;

// 把规则 frontmatter 切片出来（含闭合 --- 后不消耗换行），与 _yaml.js 同款 lookahead。
function splitRuleDoc(content) {
  const s = String(content || "");
  const m = s.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: "", body: s, raw: null };
  return { frontmatter: m[1], body: s.slice(m[0].length), raw: m[1] };
}

// 找 block-array 字段（如 validated_by / sources / supersedes / superseded_by）
// 在 frontmatter 行数组里的范围：[start, endExclusive)。段结束于下一个
// `^[A-Za-z0-9_-]+\s*:`（其它字段）或 frontmatter 末尾。
//
// **同时认 inline 空数组 `field: []`**（2026-11-23 补）：`_rule.js#buildRuleNote`
// 建规则时写的就是 `validated_by: []`。只认块形式的话，首次登记验证会把它当成
// 「没有该字段」而在 frontmatter 末尾**追加**第二个 `validated_by:` 块——同一键
// 出现两行，YAML 解析器会判重复键。认了 inline 空数组后，写入就是替换而不是追加。
function findBlockArrayRange(lines, fieldName) {
  const re = new RegExp(`^${fieldName}\\s*:\\s*(?:\\[\\s*\\])?\\s*$`);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

// 读 block-array 字段，返回字符串数组（每行去除 `  - ` 前缀，并去掉外层引号）。
// 不接 inline `field: [x, y]` 写法——_rule.js#buildRuleNote 也是块形式，与之对齐。
// 条目可能带外层双引号（_rule.js#buildRuleNote 自动生成 `"[[path]]"`）也可能不带
//（历史手写规则如 workcat 启动 Flyway 规则）；两种都兼容。
function readBlockArray(frontmatterStr, fieldName) {
  const fm = String(frontmatterStr || "");
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  const range = findBlockArrayRange(lines, fieldName);
  if (!range) return [];
  const [, end] = range;
  const out = [];
  for (let i = range[0] + 1; i < end; i++) {
    const m = lines[i].match(/^\s+-\s+(.*)$/);
    if (!m) continue;
    let item = m[1];
    // 去外层双引号（YAML 字符串引号包裹）
    if (item.startsWith('"') && item.endsWith('"') && item.length >= 2) {
      item = item.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (item.startsWith("'") && item.endsWith("'") && item.length >= 2) {
      item = item.slice(1, -1);
    }
    out.push(item);
  }
  return out;
}

// 把 block-array 字段值替换；空数组 → 删字段。非空 → 写 `fieldName:\n  - "item"\n...`。
// 条目统一外层双引号包裹（与 _rule.js#buildRuleNote 的 sources / validated_by 风格一致），
// 内部双引号 / 反斜杠做 YAML 转义。不动其它字段、不重排顺序。
function writeBlockArray(frontmatterStr, fieldName, items) {
  const fm = String(frontmatterStr || "").trim();
  if (!fm) return fm;
  const lines = fm.split(/\r?\n/);
  const range = findBlockArrayRange(lines, fieldName);
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    if (!range) return fm;
    const [start, end] = range;
    return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const serialized = [fieldName + ":", ...list.map((it) => `  - "${escapeYamlDoubleQuoted(it)}"`)];
  if (!range) {
    const closingIdx = lines.lastIndexOf("---");
    if (closingIdx < 0) return [...lines, "", ...serialized].join("\n");
    lines.splice(closingIdx, 0, ...serialized);
    return lines.join("\n");
  }
  const [start, end] = range;
  return [...lines.slice(0, start), ...serialized, ...lines.slice(end)].join("\n");
}

// 读 scalar 字段（status / domain / type 等），空串视为"未设"。
function readScalar(frontmatterStr, fieldName) {
  const fm = String(frontmatterStr || "");
  if (!fm) return "";
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${fieldName}\\s*:`).test(l));
  if (idx === -1) return "";
  const v = lines[idx].replace(new RegExp(`^${fieldName}\\s*:\\s*`), "").trim();
  return v.replace(/^['"]|['"]$/g, "");
}

// 写 scalar 字段：空串删字段；非空 → 替换或插入。
function writeScalar(frontmatterStr, fieldName, value) {
  const fm = String(frontmatterStr || "").trim();
  if (!fm) return fm;
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${fieldName}\\s*:`).test(l));
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (idx === -1) return fm;
    return [...lines.slice(0, idx), ...lines.slice(idx + 1)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const serialized = `${fieldName}: ${normalized}`;
  if (idx >= 0) return [...lines.slice(0, idx), serialized, ...lines.slice(idx + 1)].join("\n");
  const closingIdx = lines.lastIndexOf("---");
  if (closingIdx < 0) return [...lines, "", serialized].join("\n");
  lines.splice(closingIdx, 0, serialized);
  return lines.join("\n");
}

// YAML 双引号转义（与 _yaml.js#escapeDoubleQuoted 同款语义）：
// 反斜杠与双引号转义，控制字符（\r \n \t）替换为空格。
function escapeYamlDoubleQuoted(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, " ");
}

// 解析一条 `validated_by` / `sources` 条目为 wikilink 目标路径：
//   `"[[flow/data/.../README]]（note）"` → "flow/data/.../README"
//   `"[[flow/data/.../README]]"`         → "flow/data/.../README"
//   `"[[../../../2026/Q3/09/.../process/x]]"` → "../..."（相对原样）
// 解析失败（无 [[]] 包裹）返 null；调 resolveEntryPath 归一为绝对路径（需要 ruleFilePath）。
function parseEntryTarget(entry) {
  const s = String(entry || "").trim();
  const m = s.match(/^\[\[([^\]]+)\]\]/);
  if (!m) return null;
  return m[1].trim();
}

// 把 wikilink 目标归一为 vault 绝对路径。相对路径（`..` 起首）按 ruleFilePath 解析；
// 绝对路径原样。process 模块加载场景下，ruleFilePath 可为 null，相对路径原样返。
function resolveEntryPath(target, ruleFilePath) {
  if (!target) return "";
  if (target.startsWith("/")) return target.slice(1);
  if (!ruleFilePath) return target;
  // 相对路径：按 ruleFilePath 目录逐段 .. 解析
  if (!target.startsWith("..")) return target;
  const ruleDir = ruleFilePath.replace(/\/[^/]+$/, "");
  const ruleParts = ruleDir.split("/");
  const tgtParts = target.split("/");
  const stack = [...ruleParts];
  for (const seg of tgtParts) {
    if (seg === "..") stack.pop();
    else if (seg !== ".") stack.push(seg);
  }
  return stack.filter(Boolean).join("/");
}

// 任务目录识别：vault 任务落在 flow/data/<YYYY>/<Qn>/<MM>/<任务目录>/ 下，
// 其下的 README / process/… 等文档同属一个任务。捕获第 1 组（年月日 + 任务目录名）。
const TASK_DIR_RE = /(?:^|\/)(\d{4}\/Q\d\/\d{2}\/[^/]+)(?:\/|$)/;

// 把已归一的 vault 路径折叠成「任务身份」：
//   flow/data/2026/Q4/11/某任务/README              → 2026/Q4/11/某任务
//   flow/data/2026/Q4/11/某任务/process/01-调研.md    → 2026/Q4/11/某任务（同上）
//   flow/data/domains/work10/rules/x.md              → 原样（非任务路径，按自身算一个单位）
// 理由：晋级阈值衡量的是「被几个不同任务提出/验证过」，同一任务的多篇文档只算一个来源。
function taskIdentityOf(absPath) {
  const s = String(absPath || "").replace(/\\/g, "/");
  const m = s.match(TASK_DIR_RE);
  return m ? m[1] : s;
}

// 取 sources + validated_by 合并去重后的 unique **任务** 数。
// ruleFilePath 用于解析相对路径；可为 null，相对路径以字符串维度去重（保留 workcat 风格）。
function uniqueValidatedByCount(frontmatterStr, ruleFilePath) {
  const sources = readBlockArray(frontmatterStr, "sources");
  const validatedBy = readBlockArray(frontmatterStr, "validated_by");
  const all = [...sources, ...validatedBy];
  const seen = new Set();
  for (const e of all) {
    const t = parseEntryTarget(e);
    if (!t) continue;
    const abs = resolveEntryPath(t, ruleFilePath);
    if (abs) seen.add(taskIdentityOf(abs));
  }
  return seen.size;
}

// 检查当前任务是否已在 validated_by 列表里（按绝对路径去重）。
function isTaskAlreadyValidated(frontmatterStr, taskPath, ruleFilePath) {
  const validatedBy = readBlockArray(frontmatterStr, "validated_by");
  for (const e of validatedBy) {
    const t = parseEntryTarget(e);
    if (!t) continue;
    if (resolveEntryPath(t, ruleFilePath) === taskPath) return true;
  }
  return false;
}

// 格式化一条 validated_by 条目：`[[taskPath]]（note）`，note 空时只写 wikilink。
function formatValidationEntry(taskPath, note) {
  const trimmedNote = String(note || "").trim();
  return trimmedNote ? `[[${taskPath}]]（${trimmedNote}）` : `[[${taskPath}]]`;
}

// ---------- 任务 README 的 ## 引用规则 段操作 ----------

// 任务侧反向链：追加 `## 引用规则` 段，与 rule-capture.js 的 `## 产出规则` 段对偶。
// 幂等：已含同 path 短路。
function appendReferencedRuleBlock(taskContent, rulePathNoExt, title, note, date) {
  if (!taskContent) return taskContent;
  if (taskContent.includes(rulePathNoExt)) return taskContent; // 任何位置链过即视为已记录
  const trimmedNote = String(note || "").trim();
  const bullet = trimmedNote
    ? `- [[${rulePathNoExt}|${title}]]（验证于 ${date}：${trimmedNote}）`
    : `- [[${rulePathNoExt}|${title}]]（验证于 ${date}）`;
  const lines = taskContent.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^##\s+引用规则\s*$/.test(l));
  if (headerIdx === -1) {
    return `${taskContent.replace(/\s*$/, "")}\n\n## 引用规则\n\n${bullet}\n`;
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

// ---------- 规则 ## 变更 段操作 ----------

// 规则侧 ## 变更 段追加一条变更记录，幂等：同 date + 同 head 短路。
function appendChangeEntry(ruleContent, date, head) {
  const line = `- ${date} | ${head}`;
  const lines = String(ruleContent || "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^##\s+变更\s*$/.test(l));
  const body = lines.join("\n");
  if (body.includes(line)) return ruleContent;
  if (headerIdx === -1) {
    return `${ruleContent.replace(/\s*$/, "")}\n\n## 变更\n\n${line}\n`;
  }
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { endIdx = i; break; }
  }
  let insertAt = headerIdx + 1;
  for (let i = headerIdx + 1; i < endIdx; i++) {
    if (lines[i].trim().length > 0) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

// ---------- 4 个核心动作 ----------

// 1. 登记验证：把当前任务追加到 rule 的 validated_by。
// 幂等（决策 4）；返回 { content, changed, status, autoPromoted }。
// status: "applied" = 触参与写盘；"noop" = 已在记录里短路。
function validateRule(ruleContent, ruleFilePath, taskPath, note, date) {
  const { frontmatter, body } = splitRuleDoc(ruleContent);
  if (!frontmatter) {
    return { content: ruleContent, changed: false, status: "error", message: "规则无 frontmatter" };
  }
  const currentStatus = readScalar(frontmatter, "status") || "proposed";
  if (currentStatus === "deprecated") {
    return { content: ruleContent, changed: false, status: "deprecated", message: "规则已 deprecated，不接受新验证" };
  }
  if (isTaskAlreadyValidated(frontmatter, taskPath, ruleFilePath)) {
    return { content: ruleContent, changed: false, status: "noop", message: "当前任务已登记过这条规则" };
  }
  const entry = formatValidationEntry(taskPath, note);
  const newValidatedBy = [...readBlockArray(frontmatter, "validated_by"), entry];
  let nextFrontmatter = writeBlockArray(frontmatter, "validated_by", newValidatedBy);

  // 阈值判定 + 自动晋级
  let autoPromoted = false;
  const newCount = uniqueValidatedByCount(nextFrontmatter, ruleFilePath);
  if (newCount >= PROMOTE_THRESHOLD && currentStatus !== "confirmed") {
    nextFrontmatter = writeScalar(nextFrontmatter, "status", "confirmed");
    autoPromoted = true;
  }

  // 写回：拼回 frontmatter + body
  const restored = `---\n${nextFrontmatter}\n---\n${body}`;

  // ## 变更 段：登记 +（可能）晋级两条
  let result = restored;
  result = appendChangeEntry(result, date, `validated by [[${taskPath}]]${note ? `：${note}` : ""}`);
  if (autoPromoted) {
    const sourcesN = readBlockArray(nextFrontmatter, "sources").length;
    const validatedN = readBlockArray(nextFrontmatter, "validated_by").length;
    result = appendChangeEntry(result, date, `auto-confirm：${sourcesN} sources + ${validatedN} validated_by`);
  }

  return { content: result, changed: true, status: autoPromoted ? "auto-promoted" : "applied", autoPromoted };
}

// 2. 手动晋级 confirmed：force confirm，不论 validated_by 数；deprecated 不动。
// 记一条 manual promote 变更。
function promoteRuleManual(ruleContent, ruleFilePath, reason, date) {
  const { frontmatter, body } = splitRuleDoc(ruleContent);
  if (!frontmatter) {
    return { content: ruleContent, changed: false, status: "error", message: "规则无 frontmatter" };
  }
  const currentStatus = readScalar(frontmatter, "status") || "proposed";
  if (currentStatus === "deprecated") {
    return { content: ruleContent, changed: false, status: "deprecated", message: "规则已 deprecated，不能手动晋级" };
  }
  if (currentStatus === "confirmed") {
    return { content: ruleContent, changed: false, status: "noop", message: "规则已是 confirmed" };
  }
  const nextFrontmatter = writeScalar(frontmatter, "status", "confirmed");
  const restored = `---\n${nextFrontmatter}\n---\n${body}`;
  const head = `manual promote：${reason || "人工评审"}`;
  return { content: appendChangeEntry(restored, date, head), changed: true, status: "applied" };
}

// 3. 标记 deprecated：supersededBy 可选（选填，决策 3）。写 superseded_by: [...] 与 status: deprecated。
function deprecateRule(ruleContent, ruleFilePath, reason, supersededBy, date) {
  const { frontmatter, body } = splitRuleDoc(ruleContent);
  if (!frontmatter) {
    return { content: ruleContent, changed: false, status: "error", message: "规则无 frontmatter" };
  }
  const currentStatus = readScalar(frontmatter, "status") || "proposed";
  if (currentStatus === "deprecated") {
    return { content: ruleContent, changed: false, status: "noop", message: "规则已是 deprecated" };
  }
  let nextFrontmatter = writeScalar(frontmatter, "status", "deprecated");
  // superseded_by 选填：留空 → 不写字段（不强行空数组）
  const supList = Array.isArray(supersededBy) ? supersededBy : (supersededBy ? [supersededBy] : []);
  if (supList.length) {
    const formatted = supList.map((s) => {
      const trimmed = String(s || "").trim();
      return trimmed ? `[[${trimmed}]]` : "";
    }).filter(Boolean);
    if (formatted.length) {
      nextFrontmatter = writeBlockArray(nextFrontmatter, "superseded_by", formatted);
    }
  }
  const restored = `---\n${nextFrontmatter}\n---\n${body}`;
  const head = supList.length > 0
    ? `deprecated：${reason || "人工评审"} → superseded by ${supList.map((s) => `[[${s}]]`).join(", ")}`
    : `deprecated：${reason || "人工评审"}`;
  return { content: appendChangeEntry(restored, date, head), changed: true, status: "applied" };
}

// 4. 顺带操作：Rule Capture 在新建规则时若 supersedes 非空，对每个旧规则跑一次 deprecateRule。
// 这里给一个轻量封装：旧规则必须存在 + 状态非 deprecated，否则返回 status（Noop / Error）。
function prepareSupersede(ruleFilePath, supersededBy) {
  // 这层在 QuickAdd 脚本里做（旧规则 vs 当前规则不是同一个文件，需要 vault.read）；
  // helper 函数留位，QuickAdd 端用 deprecateRule + read 即可。空实现防误 import。
  return null;
}

module.exports = {
  // 字段读写
  splitRuleDoc,
  readBlockArray,
  writeBlockArray,
  readScalar,
  writeScalar,
  parseEntryTarget,
  resolveEntryPath,
  taskIdentityOf,
  uniqueValidatedByCount,
  isTaskAlreadyValidated,
  formatValidationEntry,
  // 正文段
  appendReferencedRuleBlock,
  appendChangeEntry,
  // 4 个核心动作
  validateRule,
  promoteRuleManual,
  deprecateRule,
  // 常量
  PROMOTE_THRESHOLD,
};