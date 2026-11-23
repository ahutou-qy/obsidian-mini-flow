// ==============================================
// Mini Flow - 预缺陷单（**一缺陷一文件**）的写面单源（2026-11-23 改造）
//
// 背景（任务 flow/data/2026/Q4/11/预缺陷单改造-一缺陷一文件与CNMI六节结构）：AI 在 work 代码
// 预分析阶段发现缺陷时**禁止直接改码**，改为落一张缺陷单 + 把三个选项交产品拍板
// （路径 A：与本次需求强相关；路径 B：历史存量，不绑需求）。约束写在 vault 根
// `CLAUDE.md`「预识别缺陷处理」段，本文件是它的执行面。
//
// 形态（取代 2026-11-23 上午的「单文件台账堆条目」）：
//
//   flow/data/domains/work-family/defects/PD-YYYYMMDD-NN.md
//
//   ---
//   type: defect
//   id: "PD-20261123-01"
//   title: "…"
//   status: "待产品决策"
//   risk: "P1"
//   module: "…"
//   path: "B"
//   req_id: "work-5698"
//   task: "flow/data/.../README"
//   created: "2026-11-23"
//   decided: ""
//   reproduced: false
//   ---
//
//   # PD-… · <标题>
//   ## 一、缺陷现象 … 六、附件        ← CNMI 六节，给人读
//   ## 决策记录                       ← decide 追加，一行一条
//
// 两层分工：**frontmatter 可查**（dataview 聚合 / CLI list），**正文六节给人读**。
// 不建台账 / 索引表——聚合交给 dataview 视图页，写面只有本文件这一份。
//
// 编号 `PD-YYYYMMDD-NN` 是**本地临时号**，与云效真号 `work-<n>` 形态不同——work 提交的
// 编号闸拿标题里的 `缺陷ID:work-<n>` 与任务 `req_id` 对账，本地号绝不能写成 `work-<n>`。
// 产品建单后把真号回填到 frontmatter `req_id`（路径 B 该字段初始留空）。
//
// **零 require**：插件的 `loadModule` 用 `new Function("module","exports",src)`，没有 require，
// 加了 require 插件侧直接崩。所以 `_yaml.js` 走**参数注入**（`makeDefectApi(yaml)`）——
// CLI 与插件各自把自己的 `_yaml.js` 传进来，解析 / 序列化口径仍只有一份。
// ==============================================

const DEFECT_DIR = "flow/data/domains/work-family/defects";

// 状态字面量（frontmatter 与 CLI 共用；`已修复` 是终态，不再接受 decide）。
const STATUS_PENDING = "待产品决策";
const STATUS_INCLUDE = "本次一并修复";
const STATUS_DEFER = "单独排期";
const STATUS_ARCHIVE = "不修归档";
const STATUS_FIXED = "已修复";

// decide 的 choice → 状态字面量。三选一，与缺陷单「五、给产品的三选项」一一对应。
const DECISIONS = {
  include: STATUS_INCLUDE,
  defer: STATUS_DEFER,
  archive: STATUS_ARCHIVE,
};

// frontmatter 的**写入顺序**（解析按键取值、不依赖顺序，但顺序固定让 diff 与人工阅读稳定）。
const FIELD_ORDER = [
  "type",
  "id",
  "title",
  "status",
  "risk",
  "module",
  "path",
  "req_id",
  "task",
  "created",
  "decided",
  "reproduced",
];

// P3 = 代码健壮性优化（2026-11-23 新增档，旧实现只到 P2）。
const RISKS = ["P0", "P1", "P2", "P3"];
const PATHS = ["A", "B"];

// 六节：中文序号 → 语义键。按序号前缀定位，不按标题文字精确匹配——
// 人手改标题措辞不该让 show / scriptsFor 失效。
const SECTION_KEYS = {
  一: "phenomenon",
  二: "scope",
  三: "rootCause",
  四: "fix",
  五: "options",
  六: "attachments",
};
const SECTION_HEADINGS = {
  phenomenon: "## 一、缺陷现象",
  scope: "## 二、影响范围",
  rootCause: "## 三、根因分析",
  fix: "## 四、建议修复方案",
  options: "## 五、给产品的三选项",
  attachments: "## 六、附件",
};
const DECISIONS_HEADING = "## 决策记录";

// 文件名即身份：`PD-<8位日期>-<2位序号>`。模板示例 `PD-YYYYMMDD-NN` 因此不会被误认。
const ID_RE = /^PD-\d{8}-\d{2}$/;
const SECTION_HEAD_RE = /^##\s+([一二三四五六])、/;
const ANY_H2_RE = /^##\s+/;
const DECISION_LINE_RE = /^-\s+(.+)$/;
const FIX_PART_RE = /^###\s+4\.(\d)/;
const FIX_PART_KEYS = { 1: "suggestion", 2: "changeScope", 3: "regression", 4: "sideEffects" };

const PENDING_PLACEHOLDER = "（待补）";

function pad2(n) {
  return String(n).padStart(2, "0");
}

// `--now` 归一（YYYY-MM-DD），没给就本地今天。
function normalizeNow(value) {
  if (!value) {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function dateCompact(dateStr) {
  return String(dateStr).replace(/-/g, "");
}

// 文件路径 → id（`.../defects/PD-20261123-01.md` → `PD-20261123-01`）；不合形态返回 ""。
function idFromPath(filePath) {
  const base = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
  const id = base.replace(/\.md$/i, "");
  return ID_RE.test(id) ? id : "";
}

// 新编号：同一天已有 N 条则顺延（existingIds 是已占用编号列表）。撞号顺延，不覆盖。
function nextId(existingIds, dateStr) {
  const compact = dateCompact(dateStr);
  const taken = new Set((existingIds || []).filter(Boolean));
  for (let n = 1; n <= 99; n += 1) {
    const id = `PD-${compact}-${pad2(n)}`;
    if (!taken.has(id)) return id;
  }
  throw new Error(`编号用尽：PD-${compact}-01..99 已占满`);
}

// 状态读取：缺 status 按待产品决策算（手写单宽读）。
function statusOf(entry) {
  return (entry && entry.status) || STATUS_PENDING;
}

function clip(text, n) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function bodyOrPlaceholder(value) {
  return String(value == null ? "" : value).trim() || PENDING_PLACEHOLDER;
}

// ---------- 正文解析 ----------

// 六节正文 → {phenomenon, scope, rootCause, fix, options, attachments}。
// 止于下一个 `## `（含「决策记录」）。
function parseSections(body) {
  const out = {
    phenomenon: "", scope: "", rootCause: "", fix: "", options: "", attachments: "",
  };
  const lines = String(body == null ? "" : body).split(/\r?\n/);
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur) out[cur] = buf.join("\n").trim();
  };
  for (const line of lines) {
    const sec = SECTION_HEAD_RE.exec(line);
    if (sec) {
      flush();
      cur = SECTION_KEYS[sec[1]] || null;
      buf = [];
      continue;
    }
    if (ANY_H2_RE.test(line)) {
      flush();
      cur = null;
      buf = [];
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return out;
}

// 「四、建议修复方案」里的 4.1–4.4 拆开（话术要用单段，不整块贴）。
function parseFixParts(fixText) {
  const out = { suggestion: "", changeScope: "", regression: "", sideEffects: "" };
  const lines = String(fixText == null ? "" : fixText).split(/\r?\n/);
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur) out[cur] = buf.join("\n").trim();
  };
  for (const line of lines) {
    const m = FIX_PART_RE.exec(line);
    if (m) {
      flush();
      cur = FIX_PART_KEYS[m[1]] || null;
      buf = [];
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return out;
}

// `## 决策记录` 段的 bullet（一行一条）。
function parseDecisions(body) {
  const lines = String(body == null ? "" : body).split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === DECISIONS_HEADING);
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (ANY_H2_RE.test(lines[i])) break;
    const m = DECISION_LINE_RE.exec(lines[i].trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

// 缺陷现象段里混着两行模板 bullet（发现时机 / 复现状态），话术要剥掉它们。
function phenomenonText(entry) {
  const raw = entry && entry.sections ? entry.sections.phenomenon : entry && entry.phenomenon;
  return String(raw || "")
    .split(/\r?\n/)
    .filter((l) => !/^-\s+\*\*(发现时机|复现状态)\*\*/.test(l.trim()))
    .join("\n")
    .trim();
}

// ---------- 写面单源（需要注入 _yaml.js） ----------

function makeDefectApi(yaml) {
  if (!yaml || typeof yaml.getScalarField !== "function"
      || typeof yaml.setScalarField !== "function"
      || typeof yaml.needsQuote !== "function"
      || typeof yaml.escapeDoubleQuoted !== "function") {
    throw new Error("_defect.js 需要注入 _yaml.js（getScalarField / setScalarField / needsQuote / escapeDoubleQuoted）");
  }

  // 标量序列化：中文与 `: # -` 等一律双引号包（不包会被 YAML 截断或类型化）。
  function quoted(value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return '""';
    return yaml.needsQuote(v) ? `"${yaml.escapeDoubleQuoted(v)}"` : v;
  }

  function scalarLine(name, value) {
    return `${name}: ${quoted(value)}`;
  }

  // 整张单 → 条目。缺 frontmatter / 不是 `type: defect` → null（list 计入 skipped）。
  function parseDefectFile(content, filePath = "") {
    const s = String(content == null ? "" : content);
    const m = s.match(yaml.FRONTMATTER_RE);
    if (!m) return null;
    const fm = m[1];
    if (yaml.getScalarField(fm, "type") !== "defect") return null;

    const fileId = idFromPath(filePath);
    const fmId = yaml.getScalarField(fm, "id");
    const body = s.slice(m[0].length);
    const sections = parseSections(body);
    sections.fixParts = parseFixParts(sections.fix);

    return {
      id: fmId || fileId,
      fileId,
      idMismatch: !!(fmId && fileId && fmId !== fileId),
      title: yaml.getScalarField(fm, "title"),
      status: yaml.getScalarField(fm, "status") || STATUS_PENDING,
      risk: yaml.getScalarField(fm, "risk"),
      module: yaml.getScalarField(fm, "module"),
      path: yaml.getScalarField(fm, "path"),
      reqId: yaml.getScalarField(fm, "req_id"),
      task: yaml.getScalarField(fm, "task"),
      created: yaml.getScalarField(fm, "created"),
      decided: yaml.getScalarField(fm, "decided"),
      reproduced: /^true$/i.test(yaml.getScalarField(fm, "reproduced")),
      sections,
      decisions: parseDecisions(body),
      file: String(filePath || ""),
    };
  }

  // 条目 → 整张单（create / 迁移共用；骨架顺序固定）。
  //
  // entry 字段：id / title / risk / module / path / reqId / task / created / decided /
  //             reproduced / phenomenon / scope / rootCause / suggestion / changeScope /
  //             regression / sideEffects / attach / status / decisions
  function buildDefectNote(entry) {
    const e = entry || {};
    const id = String(e.id || "").trim();
    if (!ID_RE.test(id)) throw new Error(`非法缺陷编号：${id || "(空)"}`);
    const title = String(e.title || "").trim();
    if (!title) throw new Error("缺陷单缺 title");
    const risk = String(e.risk || "").toUpperCase();
    if (!RISKS.includes(risk)) throw new Error(`risk 只收 ${RISKS.join("|")}，收到 ${e.risk}`);
    const p = String(e.path || "").toUpperCase();
    if (!PATHS.includes(p)) throw new Error(`path 只收 A|B，收到 ${e.path}`);

    const values = {
      type: "defect",
      id,
      title,
      status: e.status || STATUS_PENDING,
      risk,
      module: e.module,
      path: p,
      req_id: e.reqId,
      task: e.task,
      created: e.created,
      decided: e.decided || "",
      reproduced: e.reproduced === true ? "true" : "false",
    };

    const lines = ["---"];
    for (const key of FIELD_ORDER) lines.push(scalarLine(key, values[key]));
    lines.push("---", "");
    lines.push(`# ${id} · ${title}`, "");
    lines.push(
      "> 本单由 `node flow/scripts/mvp/mf.js defect create` 生成；状态回写走 `mf.js defect decide`。",
      "> **不要手改 frontmatter**（手写是第二份实现，解析口径必漂）。",
      "> 编号 `PD-YYYYMMDD-NN` 是本地临时号，与云效真号 `work-<n>` 形态不同、不撞提交编号闸。",
      "",
    );

    lines.push(SECTION_HEADINGS.phenomenon, "");
    lines.push("- **发现时机**：AI 前置代码分析阶段（尚未进入开发/联调）");
    lines.push(`- **复现状态**：${e.reproduced === true ? "已现场复现" : "尚未现场复现（结论来自代码逻辑推演）"}`);
    lines.push("", bodyOrPlaceholder(e.phenomenon), "");

    lines.push(SECTION_HEADINGS.scope, "", bodyOrPlaceholder(e.scope), "");
    lines.push(SECTION_HEADINGS.rootCause, "", bodyOrPlaceholder(e.rootCause), "");

    lines.push(SECTION_HEADINGS.fix, "");
    lines.push("### 4.1 方案简述", "", bodyOrPlaceholder(e.suggestion), "");
    lines.push("### 4.2 修改范围", "", bodyOrPlaceholder(e.changeScope), "");
    lines.push("### 4.3 测试与回归用例", "", bodyOrPlaceholder(e.regression), "");
    lines.push("### 4.4 风险评估（副作用）", "", bodyOrPlaceholder(e.sideEffects), "");

    lines.push(SECTION_HEADINGS.options, "");
    lines.push("1. **本次一并修复** —— 纳入当前需求开发范围。");
    lines.push("2. **单独登记，后续版本排期修复** —— 本单留痕，产品建云效缺陷工单。");
    lines.push("3. **暂不修复，风险留痕** —— 记录在案，风险由现场规避。");
    lines.push("");
    lines.push(`请产品拍板后回 \`mf.js defect decide --id ${id} --choice include|defer|archive\`。`, "");

    lines.push(SECTION_HEADINGS.attachments, "", bodyOrPlaceholder(e.attach), "");

    lines.push(DECISIONS_HEADING, "");
    for (const d of e.decisions || []) lines.push(`- ${d}`);
    lines.push("");

    return lines.join("\n");
  }

  // 决策记录追加（段不存在就补在文末；段存在就插在段末、下一个 H2 之前）。
  function appendDecisionLine(body, record) {
    const lines = String(body == null ? "" : body).split(/\r?\n/);
    const idx = lines.findIndex((l) => l.trim() === DECISIONS_HEADING);
    if (idx === -1) {
      return `${String(body).replace(/\s*$/, "")}\n\n${DECISIONS_HEADING}\n\n- ${record}\n`;
    }
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i += 1) {
      if (ANY_H2_RE.test(lines[i])) {
        end = i;
        break;
      }
    }
    const head = lines.slice(0, end);
    const tail = lines.slice(end);
    while (head.length > idx + 1 && head[head.length - 1].trim() === "") head.pop();
    // 段头与第一条 bullet 之间留一个空行；已有 bullet 时紧接其后（不留空行，避免松散列表）。
    if (head.length && head[head.length - 1].trim() === DECISIONS_HEADING) head.push("");
    head.push(`- ${record}`, "");
    if (tail.length) head.push(...tail);
    return head.join("\n");
  }

  // 回写状态 + 追加一条决策记录。幂等键 = 编号 + 目标状态（同状态重放不重复追加）。
  // 返回 {content, changed, status, noop}；终态再改抛 code 3，非法 choice 抛 code 2。
  function applyDecision(content, id, choice, { date, by = "产品", note = "" } = {}) {
    const target = DECISIONS[choice];
    if (!target) throw Object.assign(new Error(`未知 choice：${choice}`), { code: 2 });

    const s = String(content == null ? "" : content);
    const m = s.match(yaml.FRONTMATTER_RE);
    if (!m) throw Object.assign(new Error(`缺陷单缺 frontmatter：${id}`), { code: 3 });
    const entry = parseDefectFile(s, "");
    if (!entry) throw Object.assign(new Error(`不是缺陷单：${id}`), { code: 3 });

    const current = statusOf(entry);
    if (current === STATUS_FIXED) {
      throw Object.assign(new Error(`${id} 已是「已修复」终态，不再接受改判`), { code: 3 });
    }

    const day = date || normalizeNow();
    const record = `${day} · ${by} · ${target}${note ? ` · ${note}` : ""}`;
    const alreadyRecorded = (entry.decisions || []).some((d) => d.includes(`· ${target}`));

    if (current === target && alreadyRecorded) {
      return { content: s, changed: false, status: current, noop: true };
    }

    let fm = m[1];
    fm = yaml.setScalarField(fm, "status", quoted(target));
    fm = yaml.setScalarField(fm, "decided", quoted(day));
    let body = s.slice(m[0].length);
    if (!alreadyRecorded) body = appendDecisionLine(body, record);

    return {
      content: `---\n${fm}\n---${body}`,
      changed: true,
      status: target,
      noop: false,
    };
  }

  // 条目 → 卡面行（Home 卡与 list 共用）。`task` 是裸路径，容错剥一层旧 wikilink。
  function rowOf(e) {
    const taskPath = String(e.task || "")
      .replace(/^\[\[/, "")
      .replace(/\]\]$/, "")
      .split("|")[0]
      .trim();
    return {
      id: e.id,
      title: e.title,
      risk: e.risk,
      module: e.module,
      path: e.path,
      reqId: e.reqId,
      status: statusOf(e),
      created: e.created,
      decided: e.decided,
      taskPath,
      taskLabel: taskPath ? taskPath.split("/").slice(-2, -1)[0] || taskPath : "",
      file: e.file || "",
    };
  }

  // 多张单 → 卡面条目。默认只取「待产品决策」（Home 卡只盯要人拍板的）；
  // `status: "*"` 取全部（CLI list / 调试）。坏文件（缺 frontmatter / 非 defect）跳过。
  function summarize(files, { status = STATUS_PENDING } = {}) {
    const rows = [];
    for (const f of files || []) {
      const entry = parseDefectFile(f && f.content, f && f.path);
      if (!entry) continue;
      if (status !== "*" && statusOf(entry) !== status) continue;
      rows.push(rowOf(entry));
    }
    return rows;
  }

  return {
    parseDefectFile,
    buildDefectNote,
    applyDecision,
    summarize,
    rowOf,
  };
}

// ---------- 话术（不需要 yaml，保持顶层纯函数） ----------

// 从条目取某段正文：解析过的单走 sections，create 时的裸对象走同名字段。
function bodyOf(entry, key) {
  if (!entry) return "";
  if (entry.sections) {
    if (key === "phenomenon") return phenomenonText(entry);
    if (entry.sections.fixParts && key in entry.sections.fixParts) {
      return String(entry.sections.fixParts[key] || "").trim();
    }
    return String(entry.sections[key] || "").trim();
  }
  return String(entry[key] == null ? "" : entry[key]).trim();
}

// 两份话术（2026-11-23 新增「双话术」）：
//   full —— 完整缺陷单摘要，贴评审 / 归档；
//   chat —— 5 行内，企微/钉钉直接发。
// 不替产品做决定（只陈述风险与选项）；现象/风险只在头部给一次，正文不复述。
function scriptsFor(entry) {
  const e = entry || {};
  const id = e.id || "";
  const title = e.title || "";
  const risk = e.risk || "未定级";
  const p = String(e.path || "A").toUpperCase();
  const scope = bodyOf(e, "scope");
  const phenomenon = bodyOf(e, "phenomenon");
  const rootCause = bodyOf(e, "rootCause");
  const suggestion = bodyOf(e, "suggestion");
  const regression = bodyOf(e, "regression");
  const sideEffects = bodyOf(e, "sideEffects");

  const header = `【预识别缺陷 ${id}】${title}\n`
    + `风险等级：${risk}\n`
    + `影响范围：${scope}\n`
    + `现象：${phenomenon}\n`;

  const full = `${header}`
    + `\n根因：${rootCause}\n`
    + `\n建议修复：${suggestion}\n`
    + `\n回归用例：${regression}\n`
    + `\n副作用评估：${sideEffects}\n`
    + `\n三个选项，请你定：\n`
    + `① 本次需求一并修复；\n`
    + `② 本次先不改动，单独登记缺陷后续排期修复；\n`
    + `③ 暂不修复，风险留痕。\n`
    + (p === "B"
      ? `\n注：AI 前置静态分析发现的存量缺陷，非本次需求触发；云效缺陷工单请人工创建。\n`
      : "");

  const chat = `【预识别缺陷 ${id}】${title}\n`
    + `风险 ${risk}｜影响：${clip(scope, 60)}\n`
    + `现象：${clip(phenomenon, 80)}\n`
    + `建议：${clip(suggestion, 60)}\n`
    + `请定：①本次一并修复 ②单独排期 ③暂不修复留痕（路径 ${p}）`;

  return { path: p, full, chat };
}

module.exports = {
  DEFECT_DIR,
  FIELD_ORDER,
  RISKS,
  PATHS,
  DECISIONS,
  STATUS_PENDING,
  STATUS_INCLUDE,
  STATUS_DEFER,
  STATUS_ARCHIVE,
  STATUS_FIXED,
  SECTION_HEADINGS,
  DECISIONS_HEADING,
  PENDING_PLACEHOLDER,
  normalizeNow,
  idFromPath,
  nextId,
  statusOf,
  parseSections,
  parseFixParts,
  parseDecisions,
  scriptsFor,
  makeDefectApi,
};
