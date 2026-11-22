// ==============================================
// Mini Flow - Topic：长期主题卡片
//
// 一屏 Modal 收齐主题元数据，再落 flow/data/topics/<id>.md。
// 极简收口规则（2026-08）：
// - 主题名必填；其余字段可空，空时不写 frontmatter，避免"建了再补"的空规则。
// - auto_tags / auto_links / auto_keywords 三类聚合规则在弹框里同时收，逗号/分号分隔。
// - 时间窗 scan_from / scan_to 可选日期（YYYY-MM-DD），留空表示无限。
// - 三段模板（追踪问题 / 关注边界 / 退出条件）在弹框里逐段问，决定主题的"为什么"。
//
// 两级主题（2026-09 起）：
// - 父主题 dropdown：源端 listTopicChoices（_workflow.js）拉候选，去自身，可空=根主题。
// - frontmatter 写 `parent_topic: "<id>"`，空串时不写该字段（与 status/created 缺省策略一致）。
// - 父主题卡 dataviewjs 据此扩展 page.topic 召回通道（父→子 topic_id 集合，窄写宽读边界）。
// ==============================================

const { Modal, Setting } = require("obsidian");

const DEFAULT_SOURCE_PATHS = ["flow/data", "project", "weread"];
// 注：这条 topicRoot **尚未接 paths 配置**（见 328 行的用点）。它写进外部 yaml 的
// exclude_paths，漏接的后果是「改了 paths.topicRoot 后新主题目录没被排除」——可见的
// 配置漂移，不是静默数据错误，所以排在最后接。
const DEFAULT_EXCLUDE_PATHS = ["flow/data/topics"];

// 界面文案查表（阶段 3）。**模块级 `_t`**：入口 load 一次后赋值；未赋值时恒等返回原文。
// 与 task-capture / task-edit / _ui.js / rule-* 同款——避开「局部 const 取不到模块级
// class 里的调用」那个坑（批次 2 实测）。
let _t = (key, fallback) => (fallback === undefined ? key : fallback);

module.exports = async ({ app, quickAddApi }) => {
  const vault = app.vault;
  // 文案表（阶段 3）：load 一次并把查表函数挂到模块级 _t。
  const i18nMod = await loadHelper(vault, "_i18n.js");
  await i18nMod.loadLocale(vault);
  _t = i18nMod.t;

  const now = window.moment();

  // 父主题候选：异步拉 listTopicChoices（与 _workflow.js 同源，避免硬编码）。
  // 自身排除在 onSubmit 时按 topicSlug(name) 排除；此处拉全集传入 Modal 渲染即可。
  let parentChoices = [];
  try {
    const [wf, cfgMod] = await Promise.all([
      loadHelper(vault, "_workflow.js"),
      loadHelper(vault, "_config.js"),
    ]);
    // topicRoot 走配置（paths.topicRoot）；读不到 → {} → _workflow.js 退回默认常量。
    const cfg = cfgMod && typeof cfgMod.loadFromAdapter === "function"
      ? await cfgMod.loadFromAdapter(vault.adapter)
      : null;
    const all = await wf.listTopicChoices(vault, cfg && cfg.paths);
    parentChoices = all.map((t) => ({ id: t.id, label: t.label }));
  } catch (e) {
    console.error("[miniflow] topic.js loadParentChoices failed:", e);
    // 失败兜底为空数组，Modal 里 dropdown 只有"无，根主题"一项，不阻断创建。
  }

  // topic id 沿用历史字符表（与 _naming.sanitize 不一致是有意的：topic.js 早于 _naming.js 沉淀，
  // 存量 topics/ 下文件名与此规则一致；改这里会破坏现有主题卡片的双链与 dataview 扫描）。
  const topicSlug = (value) => String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-+$/g, "") || "untitled-topic";

  const state = {
    topicName: "",
    parentTopic: "", // 两级主题:父主题 topic_id,空串=根主题(下拉框 "" 选项)
    rawTags: "",
    rawLinks: "",
    rawKeywords: "",
    rawPatterns: "",
    scanFrom: "",
    scanTo: "",
    question: "",
    boundary: "",
    exitCondition: "",
  };

  const modal = new TopicModal(app, {
    state,
    parentChoices, // dropdown 源端列表(id/label),Modal onOpen 渲染
    onSubmit: async () => {
      const topicName = state.topicName.trim();
      if (!topicName) {
        new Notice(_t("topic.emptyName", "主题名为空，未创建"));
        return;
      }
      const topicId = topicSlug(topicName);
      if (!topicId) {
        new Notice(_t("topic.invalidId", "主题名无法生成合法 id，未创建"));
        return;
      }
      const topicPath = `flow/data/topics/${topicId}.md`;
      if (vault.getAbstractFileByPath(topicPath)) {
        new Notice(`ℹ️ 长期主题已存在: ${topicName}`);
        return;
      }

      // 父主题校验：dropdown 已强制排除自身（topicId 生成后过滤）；但防御一道，
      // 万一用户绕过 UI 直接改 state 或从外部注入，确保不写入自指环。
      const parentTopic = parentChoices.some((p) => p.id === state.parentTopic)
        ? state.parentTopic
        : "";

      const created = now.format("YYYY-MM-DD");
      const reviewIntervalDays = 7;
      const nextReview = now.clone().add(reviewIntervalDays, "days").format("YYYY-MM-DD");

      const tagList = splitList(state.rawTags).map((t) => normalizeTag(t)).filter(Boolean);
      const linkList = splitList(state.rawLinks).map((l) => normalizeLink(l)).filter(Boolean);
      const keywordList = splitList(state.rawKeywords).filter(Boolean);
      const patternList = splitList(state.rawPatterns).filter(Boolean);
      const scanFrom = normalizeDate(state.scanFrom);
      const scanTo = normalizeDate(state.scanTo);
      const question = state.question.trim();
      const boundary = state.boundary.trim();
      const exitCondition = state.exitCondition.trim();

      await ensureFolder(vault, "flow/data");
      await ensureFolder(vault, "flow/data/topics");

      const noteBody = buildTopicNote({
        topicName,
        topicId,
        created,
        nextReview,
        reviewIntervalDays,
        tags: [`topic/${topicId}`],
        links: [topicName],
        autoTags: tagList,
        autoLinks: linkList,
        autoKeywords: keywordList,
        autoPatterns: patternList,
        scanFrom,
        scanTo,
        question,
        boundary,
        exitCondition,
        parentTopic, // 两级主题:空串时不写该字段
      });
      await vault.create(topicPath, noteBody);
      new Notice(`✅ 已创建长期主题: ${topicName}${parentTopic ? ` (父主题: ${parentTopic})` : ""}`);
      modal.close();
    },
  });
  modal.open();
};

class TopicModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl(_t("topic.heading", "h2"), { text: "新建长期主题" });

    const addTextRow = (name, key, placeholder, isTextarea) => {
      const setting = new Setting(contentEl).setName(name);
      const make = (textarea) => {
        textarea.setPlaceholder(placeholder);
        textarea.onChange((v) => {
          this.opts.state[key] = v;
        });
        if (key === "topicName") {
          this.nameInputEl = textarea.inputEl;
          window.setTimeout(() => textarea.inputEl.focus(), 0);
        }
        return textarea;
      };
      if (isTextarea) {
        setting.addTextArea((ta) => make(ta));
      } else {
        setting.addText((t) => make(t));
      }
      return setting;
    };

    addTextRow("主题名", "topicName", "例：宁德 RFID 海外项目", false);

    // 两级主题：父主题 dropdown。空选项=根主题。
    // 源端 listTopicChoices 已过滤 deprecated；自身在 onSubmit 校验时排除。
    const parentChoices = this.opts.parentChoices || [];
    new Setting(contentEl).setName(_t("ui.parentTopic", "父主题")).addDropdown((dropdown) => {
      dropdown.addOption("", "（无，根主题）");
      for (const p of parentChoices) {
        dropdown.addOption(p.id, p.label);
      }
      dropdown.setValue(this.opts.state.parentTopic || "");
      dropdown.onChange((v) => {
        this.opts.state.parentTopic = v;
      });
    });

    addTextRow(
      "自动标签",
      "rawTags",
      "逗号/分号分隔，例：domain/work7, skill/rfid",
      false,
    );
    addTextRow(
      "自动链接",
      "rawLinks",
      "[[wikilink]] 或纯名字，多个用逗号/分号分隔",
      false,
    );
    addTextRow(
      "自动关键词",
      "rawKeywords",
      "逗号/分号分隔，命中正文关键词即召回",
      false,
    );
    addTextRow(
      "自动模式",
      "rawPatterns",
      "正则字符串，每行一条；用于 X 天 X 晚等模式命中",
      true,
    );
    addTextRow("起 scan_from", "scanFrom", "YYYY-MM-DD，留空不限", false);
    addTextRow("止 scan_to", "scanTo", "YYYY-MM-DD，留空不限", false);

    contentEl.createEl(_t("topic.definitionHint", "h3"), { text: "主题定义（三段）" });
    addTextRow("追踪问题", "question", "想弄清/解决什么？", true);
    addTextRow("关注边界", "boundary", "管什么、不管什么？", true);
    addTextRow("退出条件", "exitCondition", "什么时候算告一段落？", true);

    const buttonRow = new Setting(contentEl);
    buttonRow.addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()));
    buttonRow.addButton((btn) =>
      btn.setButtonText("创建").setCta().onClick(() => this.opts.onSubmit()),
    );
  }
}

// 逗号/分号/换行 都当作分隔符；中英文混排时方便一次性贴多条。
function splitList(input) {
  return String(input || "")
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 接受 `#tag` / `tag`，再做 topic 内置 slug 规则（与 id 同字符表，统一一处）。
function normalizeTag(value) {
  const stripped = String(value).replace(/^#/, "").trim();
  return slugifyValue(stripped);
}

// 接受 [[wiki]] / [[wiki|alias]] / wiki / 别名，取最右边的"显示名"作为 wikilink target。
function normalizeLink(value) {
  const raw = String(value).trim();
  const m = raw.match(/^\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]$/);
  const target = m ? m[1].trim() : raw;
  return target;
}

// YYYY-MM-DD 接受；其它返回 null（区分"用户没填"与"用户填错"，落盘时不写错值）。
function normalizeDate(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function slugifyValue(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|#^[\]()]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "";
}

async function ensureFolder(vault, path) {
  if (!vault.getAbstractFileByPath(path)) {
    await vault.createFolder(path);
  }
}

// QuickAdd 沙箱外不暴露 require；与 task-capture.js 同款字符串加载 helper。
async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

function yamlList(values, indent = "") {
  if (!values || values.length === 0) return " []";
  return `\n${values.map((value) => `${indent}- ${JSON.stringify(value)}`).join("\n")}`;
}

// pattern 类字段专用：内联双引号字符串，仅对字面双斜杠/双引号做最少转义。
// 不用 JSON.stringify 是因为它会把单个 \\ 当 escape 处理（输出 \\\\d+），
// _workflow.yamlUnquote 只把 \\\\ → \\，最后 new RegExp 拿到 \\d+（字面
// 反斜杠）匹配失败。这里 inline 双引号让 yamlUnquote 跳过非 \\X 序列，
// 单个 \\ 字面落到 JS 字符串里，正好给 RegExp 编译。
function yamlInlineList(values, indent = "") {
  if (!values || values.length === 0) return " []";
  const esc = (v) => String(v).replace(/[\\"]/g, (m) => `\\${m}`);
  return `\n${values.map((value) => `${indent}- "${esc(value)}"`).join("\n")}`;
}

function buildTopicNote({
  topicName,
  topicId,
  created,
  nextReview,
  reviewIntervalDays,
  tags: _tags,
  links: _links,
  autoTags,
  autoLinks,
  autoKeywords,
  autoPatterns,
  scanFrom,
  scanTo,
  question,
  boundary,
  exitCondition,
  parentTopic, // 两级主题:可选父主题 topic_id,空串不写
}) {
  // 双重兜底：哪怕外部调用方漏了 normalize，这里也挡一道。
  const safeFrom = scanFrom && /^\d{4}-\d{2}-\d{2}$/.test(scanFrom) ? scanFrom : null;
  const safeTo = scanTo && /^\d{4}-\d{2}-\d{2}$/.test(scanTo) ? scanTo : null;
  const scanFromLine = safeFrom ? `scan_from: ${safeFrom}\n` : "";
  const scanToLine = safeTo ? `scan_to: ${safeTo}\n` : "";
  // 两级主题:空串不写该字段(与现有 scan_from/scan_to 缺省策略一致,避免空规则)。
  const parentTopicLine = parentTopic ? `parent_topic: ${JSON.stringify(parentTopic)}\n` : "";
  return `---
type: topic
topic_id: ${JSON.stringify(topicId)}
status: active
created: ${created}
last_review:
next_review: ${nextReview}
review_interval_days: ${reviewIntervalDays}
${scanFromLine}${scanToLine}${parentTopicLine}source_paths:${yamlList(DEFAULT_SOURCE_PATHS, "  ")}
exclude_paths:${yamlList(DEFAULT_EXCLUDE_PATHS, "  ")}
auto_tags:${yamlList(autoTags, "  ")}
auto_keywords:${yamlList(autoKeywords, "  ")}
auto_patterns:${yamlInlineList(autoPatterns, "  ")}
auto_links:${yamlList(autoLinks, "  ")}
tags:
  - flow/topic
ai_generated: false
---

# ${topicName}

## 主题定义

- 追踪问题：${question || "_（待补）_"}
- 关注边界：${boundary || "_（待补）_"}
- 退出条件：${exitCondition || "_（待补）_"}

## 自动聚合规则

- 标签：\`auto_tags\`
- 链接：\`auto_links\`
- 关键词：\`auto_keywords\`
- 模式：\`auto_patterns\`
- 时间范围：\`scan_from\` ~ \`scan_to\`
- 扫描目录：\`source_paths\`

## 主题时间线

\`\`\`dataviewjs
${timelineDataviewJs()}
\`\`\`

## 阶段汇总

\`\`\`dataviewjs
${summaryDataviewJs()}
\`\`\`

### 人工复盘记录

#### ${created}

- 本阶段变化：
- 新出现的问题：
- 已沉淀结论：
- 下一步动作：

## 复盘提醒

- \`last_review\`：最近一次人工复盘日期
- \`next_review\`：下次应复盘日期；到期后会出现在每日/每周模板的长期主题提醒中
- \`review_interval_days\`：建议复盘间隔
`;
}

function timelineDataviewJs() {
  return String.raw`const current = dv.current();
const normalizeList = (value) => Array.isArray(value) ? value : (value ? [value] : []);
const normalizeTag = (tag) => String(tag).replace(/^#/, "").trim();
const normalizeLink = (link) => String(link).replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
const containsText = (content, keyword) => content.toLowerCase().includes(String(keyword).toLowerCase());
const dateOf = (page) => page.date ?? page.date_created ?? page.file.day ?? page.file.ctime;

const sourcePaths = normalizeList(current.source_paths).map(String);
const excludePaths = normalizeList(current.exclude_paths).map(String);
const tags = normalizeList(current.auto_tags).map(normalizeTag).filter(Boolean);
const links = normalizeList(current.auto_links).map(normalizeLink).filter(Boolean);
const keywords = normalizeList(current.auto_keywords).map(String).filter(Boolean);
const from = current.scan_from ? dv.date(current.scan_from) : null;
const to = current.scan_to ? dv.date(current.scan_to) : null;

const candidates = dv.pages()
  .where(page => page.file.path !== current.file.path)
  .where(page => sourcePaths.length === 0 || sourcePaths.some(path => page.file.path.startsWith(path + "/") || page.file.path === path))
  .where(page => !excludePaths.some(path => page.file.path.startsWith(path + "/") || page.file.path === path))
  .where(page => {
    const date = dateOf(page);
    if (!date) return true;
    if (from && dv.date(date) < from) return false;
    if (to && dv.date(date) > to) return false;
    return true;
  });

const rows = [];
for (const page of candidates) {
  const content = await dv.io.load(page.file.path);
  const pageTags = normalizeList(page.file.tags).map(normalizeTag);
  const outlinks = normalizeList(page.file.outlinks).map(link => normalizeLink(link.path ?? link));
  // 任务 README frontmatter topic: "id" 单值单源召回（不写 tag、不写正文双链）。
  const topicHit = String(page.topic ?? "").trim() === String(current.topic_id).trim();
  const matched = [];

  const matchedTags = tags.filter(tag => pageTags.includes(tag) || containsText(content, ` + "`#${tag}`" + `));
  const matchedLinks = links.filter(link => outlinks.includes(link) || content.includes(` + "`[[${link}]]`" + `));
  const matchedKeywords = keywords.filter(keyword => containsText(content, keyword));

  if (matchedTags.length > 0) matched.push(` + "`tag: ${matchedTags.join(\", \")}`" + `);
  if (matchedLinks.length > 0) matched.push(` + "`link: ${matchedLinks.join(\", \")}`" + `);
  if (matchedKeywords.length > 0) matched.push(` + "`keyword: ${matchedKeywords.join(\", \")}`" + `);
  if (topicHit) matched.push(` + "`topic: ${current.topic_id}`" + `);

  if (matched.length > 0) {
    rows.push({
      date: dateOf(page),
      file: page.file.link,
      matched: matched.join("；")
    });
  }
}

rows.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
dv.table(["日期", "来源", "命中规则"], rows.map(row => [row.date ?? "", row.file, row.matched]));`;
}

function summaryDataviewJs() {
  return String.raw`const current = dv.current();
const normalizeList = (value) => Array.isArray(value) ? value : (value ? [value] : []);
const normalizeTag = (tag) => String(tag).replace(/^#/, "").trim();
const normalizeLink = (link) => String(link).replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
const containsText = (content, keyword) => content.toLowerCase().includes(String(keyword).toLowerCase());
const dateOf = (page) => page.date ?? page.date_created ?? page.file.day ?? page.file.ctime;
const stageKey = (date) => window.moment(String(date)).isValid()
  ? window.moment(String(date)).format("YYYY-[W]WW")
  : "未标日期";

const sourcePaths = normalizeList(current.source_paths).map(String);
const excludePaths = normalizeList(current.exclude_paths).map(String);
const tags = normalizeList(current.auto_tags).map(normalizeTag).filter(Boolean);
const links = normalizeList(current.auto_links).map(normalizeLink).filter(Boolean);
const keywords = normalizeList(current.auto_keywords).map(String).filter(Boolean);
const from = current.scan_from ? dv.date(current.scan_from) : null;
const to = current.scan_to ? dv.date(current.scan_to) : null;

const groups = new Map();
for (const page of dv.pages()
  .where(page => page.file.path !== current.file.path)
  .where(page => sourcePaths.length === 0 || sourcePaths.some(path => page.file.path.startsWith(path + "/") || page.file.path === path))
  .where(page => !excludePaths.some(path => page.file.path.startsWith(path + "/") || page.file.path === path))) {
  const date = dateOf(page);
  if (date) {
    if (from && dv.date(date) < from) continue;
    if (to && dv.date(date) > to) continue;
  }
  const content = await dv.io.load(page.file.path);
  const pageTags = normalizeList(page.file.tags).map(normalizeTag);
  const outlinks = normalizeList(page.file.outlinks).map(link => normalizeLink(link.path ?? link));
  const topicHit = String(page.topic ?? "").trim() === String(current.topic_id).trim();
  const matched = topicHit
    || tags.some(tag => pageTags.includes(tag) || containsText(content, ` + "`#${tag}`" + `))
    || links.some(link => outlinks.includes(link) || content.includes(` + "`[[${link}]]`" + `))
    || keywords.some(keyword => containsText(content, keyword));
  if (!matched) continue;

  const key = stageKey(date);
  const group = groups.get(key) ?? [];
  group.push(page.file.link);
  groups.set(key, group);
}
dv.table(["阶段", "新增记录", "最近来源"], [...groups.entries()]
  .sort((a, b) => b[0].localeCompare(a[0]))
  .map(([stage, files]) => [stage, files.length, files.slice(0, 5)]));`;
}