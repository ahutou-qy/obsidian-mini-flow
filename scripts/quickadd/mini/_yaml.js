// ==============================================
// Mini Flow - frontmatter 读写 helper（纯字符串、零依赖）
//
// 给 task-finish / task-edit / task-upgrade 共用：把"任务状态里程碑"从
// ## 时间轴 markdown 段迁到 frontmatter 数组 milestones: [{date, type, note}]。
// 形态约束：
//   - type 是 ASCII 枚举（create|archive|finish|reopen|manual），不引号；
//   - date 是 YYYY-MM-DD，加单引号防 YAML date 类型化；
//   - note 含中文/标点强制双引号包，反斜杠与双引号转义。
// 不引第三方（gray-matter/js-yaml），与仓内 frontmatterHasTag/cleanYamlScalar
// 风格同源。
// ==============================================

// 仓内 frontmatter 切片正典：用前瞻 (?=...) 不消耗关闭 `---` 之后的换行，
// 让 content.slice(match[0].length) 拿到的 rest 保留原貌（含与正文的空行 \n 头）。
// task-upgrade.js:350 同 lookahead 写法（消费侧一致）。
// 沿用旧 alternation (?:\r?\n|$) 是已知瑕疵，但只取 match[1] 不切片 rest，无影响。
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

// 去前后空白/前后引号/前导井号。
function cleanScalar(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "").replace(/^#/, "");
}

// note 含任何 YAML 特殊字符（含中文标点 / : # - [] {} 之一）就强制双引号包。
function needsQuote(value) {
  return /[:\[\]\{\}\-,#&*!|>'"%@`一-鿿]/.test(value);
}

function escapeDoubleQuoted(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, " ");
}

// milestone 行统一缩进 2 空格，与 `_task.js` 的 create 行同形。
// 全库 2026-10-15 统一到缩进式：两种写法都是合法 YAML（PyYAML/js-yaml 解析结果一致），
// 但 Obsidian frontmatter 对顶格序列判过「无效属性」（2026-10-12 bc02a0f 后 1002/892 的
// tags 中招，见 `_task.test.js` 的缩进守卫），且 Obsidian 属性编辑器本身就写缩进式。
// 此函数此前产顶格、`_task.js` 产缩进 → 每次 finish 都会原地重写这两行，diff 里白带噪声。
function serializeMilestone({ date, type, note }) {
  if (!date || !type) throw new Error("milestone 需要 date 与 type");
  const head = `  - {date: '${date}', type: ${type}`;
  if (note == null || note === "") return `${head}}`;
  const safe = needsQuote(note)
    ? `"${escapeDoubleQuoted(note)}"`
    : note;
  return `${head}, note: ${safe}}`;
}

// 把 "milestones: ..." 字段值切出来（不切整段 frontmatter，专注单字段）。
// 兼容 inline 与 block 两种 YAML 写法。
function readMilestonesBlock(frontmatter) {
  if (!frontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^milestones\s*:/.test(l));
  if (headerIdx === -1) return null;
  const inline = lines[headerIdx].replace(/^milestones\s*:\s*/, "").trim();
  if (inline) {
    // inline 形式: milestones: [{date: '...', type: ...}, ...]
    const stripped = inline.replace(/^\[|\]$/g, "").trim();
    return { headerIdx, lines: [], inline: stripped };
  }
  const block = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(lines[i])) break;
    if (!/^\s*-\s/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return { headerIdx, block, inline: "" };
}

function parseInlineObject(line) {
  // 解析单条 "- {date: '2026-08-13', type: archive, note: "..."}"
  const body = line.replace(/^\s*-\s+/, "").replace(/^\{|\}$/g, "").trim();
  if (!body) return null;
  const out = {};
  // 三种字段都可能存在；用正则按 ", " 切，但 note 可能含逗号，所以要小心。
  // 简单做法：先抠出 note（最复杂那个），剩下的再按逗号切。
  const noteMatch = body.match(/,\s*note\s*:\s*("(?:\\"|[^"])*"|[^,]+?)\s*$/);
  if (noteMatch) {
    out.note = cleanScalar(noteMatch[1]);
    const head = body.slice(0, noteMatch.index);
    head.split(/,\s*/).forEach((kv) => {
      const m = kv.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) out[m[1]] = cleanScalar(m[2]);
    });
  } else {
    body.split(/,\s*/).forEach((kv) => {
      const m = kv.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) out[m[1]] = cleanScalar(m[2]);
    });
  }
  if (!out.date || !out.type) return null;
  return { date: out.date, type: out.type, note: out.note || "" };
}

function getMilestones(frontmatterStr) {
  const fm = String(frontmatterStr || "");
  if (!fm) return [];
  const block = readMilestonesBlock(fm);
  if (!block) return [];
  if (block.inline) {
    return block.inline
      .split(/},\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInlineObject(`- {${s}}`))
      .filter(Boolean);
  }
  return block.block.map(parseInlineObject).filter(Boolean);
}

// 找 milestones 段在 frontmatter 行数组里的范围：[start, endExclusive)。
// 段结构：首行 `milestones:` / `milestones: [...]`，后跟 0+ 行 `  - {...}`。
// 段结束于下一个 `^[A-Za-z0-9_-]+\s*:`（其它字段）或文件末尾。
function findMilestonesRange(lines) {
  const start = lines.findIndex((l) => /^milestones\s*:/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

// 在 frontmatter 字符串里替换 milestones 段。空 list → 删字段。
// 不动其它字段、不重排顺序。
function setMilestones(frontmatterStr, list) {
  const fm = String(frontmatterStr || "").trim();
  if (!fm) return fm;
  const lines = fm.split(/\r?\n/);
  const range = findMilestonesRange(lines);
  if (!list || list.length === 0) {
    if (!range) return fm;
    const [start, end] = range;
    // 删 [start, end) 这一段，保留 end 之后的内容。空行粘连时压一个换行。
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    return [...before, ...after].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const serialized = list.map(serializeMilestone);
  if (!range) {
    // 插在 frontmatter 末尾（最后一行 "---" 之前）
    const closingIdx = lines.lastIndexOf("---");
    if (closingIdx < 0) {
      return [...lines, "", "milestones:", ...serialized].join("\n");
    }
    lines.splice(closingIdx, 0, "milestones:", ...serialized);
    return lines.join("\n");
  }
  // 替换现有 [range[0], range[1])
  const [start, end] = range;
  return [...lines.slice(0, start), "milestones:", ...serialized, ...lines.slice(end)].join("\n");
}

// 幂等键：同 {date, type}：
//   - 同 note  → noop
//   - 不同 note → 升级 note（合并为一条，note 取新值）
//   - 都没 → push 新条
function addMilestone(frontmatterStr, milestone) {
  const list = getMilestones(frontmatterStr);
  const hit = list.find((m) => m.date === milestone.date && m.type === milestone.type);
  if (hit) {
    if (hit.note === (milestone.note || "")) return frontmatterStr;
    const next = list.map((m) =>
      m === hit ? { ...m, note: milestone.note || "" } : m
    );
    return setMilestones(frontmatterStr, next);
  }
  list.push({ date: milestone.date, type: milestone.type, note: milestone.note || "" });
  return setMilestones(frontmatterStr, list);
}

// ---------- topic（主题关联，标量，2026-09-14 由 topics 列表收口为单值） ----------
// 一个任务至多挂一个 topic：domain 担归口轴、标题通常担名物轴，残留交叉维度至多一个；
// 多挂诱导标签囤积。存量 block `topics:\n  - "x"` 兼容读（取第一条），写回统一标量。
function getTopic(frontmatterStr) {
  const fm = String(frontmatterStr || "");
  if (!fm) return "";
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^topic\s*:/.test(l));
  if (idx >= 0) {
    const v = lines[idx].replace(/^topic\s*:\s*/, "").trim();
    if (v) return cleanScalar(v);
  }
  return getTopicsLegacy(fm)[0] || "";
}

// 空串删字段；同时清掉历史 topics block。新值统一 JSON 双引号（id 可含空格/大写）。
function setTopic(frontmatterStr, value) {
  const fm = String(frontmatterStr || "").trim();
  if (!fm) return fm;
  let lines = fm.split(/\r?\n/);
  // 先删历史 topics block，再按标量 domain 同款 replace-or-insert 处理。
  const legacyRange = findTopicsRange(lines);
  if (legacyRange) {
    const [start, end] = legacyRange;
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  const normalized = String(value || "").trim();
  const idx = lines.findIndex((l) => /^topic\s*:/.test(l));
  if (!normalized) {
    if (idx === -1) return lines.join("\n").replace(/\n{3,}/g, "\n\n");
    return [...lines.slice(0, idx), ...lines.slice(idx + 1)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const serialized = `topic: ${JSON.stringify(normalized)}`;
  if (idx >= 0) {
    return [...lines.slice(0, idx), serialized, ...lines.slice(idx + 1)].join("\n");
  }
  const closingIdx = lines.lastIndexOf("---");
  if (closingIdx < 0) return [...lines, "", serialized].join("\n");
  lines.splice(closingIdx, 0, serialized);
  return lines.join("\n");
}

// 历史 block/inline `topics: [...]` 只读兼容（task-edit 打开未迁移老任务时取值）。
function findTopicsRange(lines) {
  const start = lines.findIndex((l) => /^topics\s*:/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(lines[i])) { end = i; break; }
    if (!/^\s*-\s/.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

function getTopicsLegacy(frontmatterStr) {
  const fm = String(frontmatterStr || "");
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^topics\s*:/.test(l));
  if (headerIdx === -1) return [];
  const inline = lines[headerIdx].replace(/^topics\s*:\s*/, "").trim();
  if (inline) {
    // inline: topics: ["a", "b"] 或 topics: [a, b]
    return inline.replace(/^\[|\]$/g, "").split(",").map((s) => cleanScalar(s)).filter(Boolean);
  }
  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!/^\s*-\s/.test(lines[i])) break;
    out.push(cleanScalar(lines[i].replace(/^\s*-\s+/, "")));
  }
  return out.filter(Boolean);
}

// ---------- 标量字段读取（通用） ----------
//
// 标量字段读取通用 helper（只读；schema = 单行标量，取不到返回 ""）。
// 给"MF 侧只读、写手在别处"的字段用——写手不在 MF 的字段不该长出第二份解析。
function getScalarField(frontmatterStr, fieldName) {
  const fm = String(frontmatterStr || "");
  if (!fm) return "";
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${fieldName}\\s*:`).test(l));
  if (idx === -1) return "";
  const v = lines[idx].replace(new RegExp(`^${fieldName}\\s*:\\s*`), "").trim();
  return v ? cleanScalar(v) : "";
}

// ---------- domain（任务领域，标量字段） ----------
//
// 用途：读任务所属领域（work 任务落在 `flow/data/domains/<slug>/`，个人任务 `growth`）。
// `buildFolderReadme` 新建时写入 frontmatter `domain: <slug>` 与正文导航行；
// 领域无弹框 UI（capture 2026-09-14 删、task-edit 2026-10-01 删），此处只读解析，
// 改领域手改 README frontmatter。
//
// schema：标量字符串（slug 全小写），空串视为"未设"。不接 inline list。
function getDomain(frontmatterStr) {
  return getScalarField(frontmatterStr, "domain");
}

// `yunxiao_id`（结构化需求编号 `work-<数字>`，2026-11-18 起）：**写手是 外部同步 CLI 的云效
// 物化**（tasks.rs 新建时写 + 存量回填），MF 的 capture / edit / finish / upgrade 都不写
// 这个字段——所以这里只有读面、没有 set。读者是交付证据软闸（_finish.js#isDeliveryTask
// 拿它判"这条任务是不是云效物化交付任务"）与 work commit 标题闸的对账链。
// 空串视为"未设"（手建任务本来就没有）。
function getYunxiaoId(frontmatterStr) {
  return getScalarField(frontmatterStr, "yunxiao_id");
}

// 字段行范围查找通用 helper：找到 `^fieldName\s*:` 起，止于下一个
// `^[A-Za-z0-9_-]+\s*:` 或文件末尾。
// 同时止于闭合围栏 `---`：调用方可能传**带围栏**的整段 frontmatter（`_yaml.test.js`
// 的历史用例就是这样），而 `---` 不匹配"下一字段"正则 → 不拦就会把闭合围栏一起
// 吞进字段段、替换时把围栏删掉（C3 用例踩到）。
function findFieldRange(lines, fieldName) {
  const start = lines.findIndex((l) => new RegExp(`^${fieldName}\\s*:`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { end = i; break; }
    if (/^[A-Za-z0-9_-]+\s*:/.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

// ---------- chain（任务链：父任务 + 步号，块形式标量，2026-11-12） ----------
//
// 用途：把「拆自 [[父]] 第 N 步」这条**只写在子卡正文**的关系落成可查询数据，
// 供 Home 聚合渲染（父子分组 / 第 N/M 步 / 链进度）与后续串行链放行判断消费。
// 正文那行仍是人类叙事，**不删**——两边一起写，读侧只认 frontmatter（确定性）。
//
// schema（`parent` 为空即"无链"，整段删除）：
//   chain:
//     parent: flow/data/2026/Q4/11/<父任务目录>/README   # 父任务 README 的 vault 相对路径，不含 .md
//     step: 2                                            # 在链中的步号（正整数）
//     total: 4                                           # 链总步数；未知则省略该行
//
// 约定：
//   - `parent` 存**纯路径字符串**而非 `[[wikilink]]`：消费方（Home dataviewjs /
//     qy 侧 / 迁移脚本）要的是可直接比较的路径，图反向链接已由正文那行承担。
//   - 并行片（同一步挂多张卡，如 C 盘迁移第 3 步三张）合法——`step` 不唯一。
//   - `step` / `total` 缺省写 0 → 该行不输出，读侧视为 null。
function serializeChain(chain) {
  const parent = chain && chain.parent ? String(chain.parent).trim() : "";
  if (!parent) throw new Error("chain 需要 parent");
  const step = Number(chain.step) > 0 ? Math.floor(Number(chain.step)) : 0;
  const total = Number(chain.total) > 0 ? Math.floor(Number(chain.total)) : 0;
  const parentValue = needsQuote(parent) ? `"${escapeDoubleQuoted(parent)}"` : parent;
  const lines = ["chain:", `  parent: ${parentValue}`];
  if (step) lines.push(`  step: ${step}`);
  if (total) lines.push(`  total: ${total}`);
  return lines.join("\n");
}

function getChain(frontmatterStr) {
  const fm = String(frontmatterStr || "");
  if (!fm) return null;
  const lines = fm.split(/\r?\n/);
  const range = findFieldRange(lines, "chain");
  if (!range) return null;
  const out = { parent: "", step: null, total: null };
  for (let i = range[0] + 1; i < range[1]; i++) {
    const m = lines[i].match(/^\s+(parent|step|total)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "step" || m[1] === "total") {
      const n = parseInt(cleanScalar(m[2]), 10);
      out[m[1]] = Number.isFinite(n) && n > 0 ? n : null;
    } else {
      out.parent = cleanScalar(m[2]);
    }
  }
  return out.parent ? out : null;
}

function setChain(frontmatterStr, chain) {
  const fm = String(frontmatterStr || "").trim();
  if (!fm) return fm;
  const lines = fm.split(/\r?\n/);
  const range = findFieldRange(lines, "chain");
  const parent = chain && chain.parent ? String(chain.parent).trim() : "";
  if (!parent) {
    if (!range) return fm;
    const [start, end] = range;
    return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const serialized = serializeChain(chain).split("\n");
  if (!range) {
    const closingIdx = lines.lastIndexOf("---");
    // 插到 frontmatter 末尾；不要额外空行（YAML 允许，但会让 chain 与其它字段之间
    // 多出一行空行，29 个任务迁移时满屏都是这个噪声）。
    if (closingIdx < 0) return [...lines, ...serialized].join("\n");
    lines.splice(closingIdx, 0, ...serialized);
    return lines.join("\n");
  }
  const [start, end] = range;
  return [...lines.slice(0, start), ...serialized, ...lines.slice(end)].join("\n");
}

// ---------- external_dep（外部依赖待解，标量字段，2026-11-18） ----------
//
// 用途：标「这条我已经预判推进了，但卡在某个外部输入上」——缺什么、找谁、期望何时。
// 写手是用户级 skill `dep-mark`（走本 helper，不另写一套 YAML 改写）；
// 读面是 Home「🏠 工作事务」活跃卡（⛔ 徽标 + 灰副行；2026-11-19 起并卡，原独立 ⛔ 卡已删）。
//
// schema：标量字符串（一句话）。字段不存在 = 无外部依赖待解；空串 = 取消标注（删字段）。
function getExternalDep(frontmatterStr) {
  const fm = String(frontmatterStr || "");
  if (!fm) return "";
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^external_dep\s*:/.test(l));
  if (idx === -1) return "";
  const v = lines[idx].replace(/^external_dep\s*:\s*/, "").trim();
  return v ? cleanScalar(v) : "";
}

// 空串删字段（取消标注）；有值则 replace-or-insert，写法同 topic 标量。
// 调用方可能传**带围栏**的整段 frontmatter，也可能只传内容段——两种都支持：
// 有闭合围栏就插在围栏前，没有就追加到末尾。
function setExternalDep(frontmatterStr, value) {
  const fm = String(frontmatterStr || "").trim();
  if (!fm) return fm;
  let lines = fm.split(/\r?\n/);
  const normalized = String(value || "").trim();
  const idx = lines.findIndex((l) => /^external_dep\s*:/.test(l));
  if (!normalized) {
    if (idx === -1) return lines.join("\n").replace(/\n{3,}/g, "\n\n");
    return [...lines.slice(0, idx), ...lines.slice(idx + 1)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const serialized = `external_dep: ${JSON.stringify(normalized)}`;
  if (idx >= 0) {
    return [...lines.slice(0, idx), serialized, ...lines.slice(idx + 1)].join("\n");
  }
  const closingIdx = lines.lastIndexOf("---");
  if (closingIdx < 0) return [...lines, serialized].join("\n");
  lines.splice(closingIdx, 0, serialized);
  return lines.join("\n");
}

module.exports = {
  FRONTMATTER_RE,
  getMilestones,
  setMilestones,
  addMilestone,
  serializeMilestone,
  getTopic,
  setTopic,
  getDomain,
  getYunxiaoId,
  getChain,
  setChain,
  serializeChain,
  getExternalDep,
  setExternalDep,
};
