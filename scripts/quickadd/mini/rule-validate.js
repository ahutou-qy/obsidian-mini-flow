// ==============================================
// Mini Flow - Rule Validate：把当前任务登记为某条 proposed 规则的
// validated_by 之一。设计与契约见
// （上游设计文档，不在本包内）。
//
// 触发：当前活动文件必须是 task / task-folder（与 rule-capture 共用入口判据）。
// 行为：
//   1) 选领域（domains/ 下含 rules/ 子目录的域）
//   2) 选规则（仅 status: proposed；deprecated / confirmed 不在候选）
//   3) 输入验证陈述（一句话实证）
//   4) 写盘：
//      - 规则 frontmatter `validated_by` 追加一条（已含同 path 短路——决策 4）
//      - sources + validated_by 合并去重 ≥ 2 → 自动 `status: confirmed`（决策 1）
//      - 规则 ## 变更 段追加条目
//      - 当前任务 README 追加 ## 引用规则 段 bullet（决策 5 新开）
//
// Notice 策略：成功 → 「已登记验证 + autoPromote 标识」简要行；幂等 → 「已登记过」；
// deprecated / 缺任务 / 无规则 → Notice 错误/边界（与 Mini Flow Notice 策略对齐）。
// ==============================================

// 界面文案查表（阶段 3）。**模块级 `_t`**：入口 load 一次后赋值；未赋值时恒等返回原文，
// 不因初始化缺失让界面变空。与 task-capture / task-edit / _ui.js 同款——那边实测过
// 「局部 const 取不到模块级 class 里的调用」，这里不重蹈。
let _t = (key, fallback) => (fallback === undefined ? key : fallback);

module.exports = async ({ app, quickAddApi }) => {
  const vault = app.vault;
  // 文案表（阶段 3）：load 一次并把查表函数挂到模块级 _t。
  const i18nMod = await loadHelper(vault, "_i18n.js");
  await i18nMod.loadLocale(vault);
  _t = i18nMod.t;

  const [rule, review, taskHelpers] = await Promise.all([
    loadHelper(vault, "_rule.js"),
    loadHelper(vault, "_rule-review.js"),
    loadHelper(vault, "_task.js"),
  ]);

  // ---------- 1. 当前任务 ----------
  const taskFile = resolveActiveTask(app, taskHelpers);
  if (!taskFile) {
    new Notice(_t("ruleValidate.needTaskFile", "请先打开任务文件或 folder README，再登记验证规则"));
    return;
  }
  const taskPathNoExt = taskFile.path.replace(/\.md$/, "");
  const today = window.moment().format("YYYY-MM-DD");

  // ---------- 2. 领域 ----------
  let domains;
  try {
    domains = await rule.listDomains(vault);
  } catch (e) {
    new Notice(`读取领域列表失败: ${String(e).slice(0, 120)}`);
    return;
  }
  if (!domains.length) {
    new Notice(_t("common.noDomains", "未找到任何领域（flow/data/domains/<域>/rules/），先建领域目录"));
    return;
  }
  const domain = domains.length === 1
    ? domains[0]
    : await quickAddApi.suggester(domains, domains);
  if (!domain) return;

  // ---------- 3. 选规则（仅 proposed） ----------
  const candidates = await listProposedRules(vault, rule, domain);
  if (!candidates.length) {
    new Notice(`领域 ${domain} 下没有 proposed 规则可登记（先沉淀新规则或 un-deprecate）`);
    return;
  }
  const displayLabels = candidates.map((r) => `${r.title}  ·  ${r.relPath}`);
  const picked = await quickAddApi.suggester(displayLabels, candidates);
  if (!picked) return;

  // ---------- 4. 验证陈述 ----------
  const note = await quickAddApi.inputPrompt(_t("ruleValidate.evidenceHint", "一句话实证（这条规则在当前任务上怎么被验证）")) || "";
  if (note == null) return;

  // ---------- 5. 写盘 ----------
  let ruleContent;
  try {
    ruleContent = await vault.read(picked.file);
  } catch (e) {
    new Notice(`读取规则失败: ${String(e).slice(0, 160)}`);
    return;
  }
  const result = review.validateRule(ruleContent, picked.file.path, taskPathNoExt, note.trim(), today);

  if (result.status === "noop") {
    new Notice(`已登记过：当前任务对「${picked.title}」验证已存在，不重复写`, 3000);
    return;
  }
  if (result.status === "deprecated") {
    new Notice(`规则「${picked.title}」已 deprecated，不接受新验证`, 3000);
    return;
  }
  if (result.status === "error") {
    new Notice(`校验规则失败: ${result.message || "未知错误"}`, 3000);
    return;
  }

  try {
    await vault.modify(picked.file, result.content);

    // 任务侧反向链：## 引用规则 段
    const taskContent = await vault.read(taskFile);
    const rulePathNoExt = picked.file.path.replace(/\.md$/, "");
    const updatedTask = review.appendReferencedRuleBlock(taskContent, rulePathNoExt, picked.title, note.trim(), today);
    if (updatedTask !== taskContent) await vault.modify(taskFile, updatedTask);
  } catch (e) {
    new Notice(`写盘失败: ${String(e).slice(0, 160)}`);
    return;
  }

  // 成功条 Notice：UI 已写盘，append 一条简要行说清楚写到了哪里 + 是否晋级。
  if (result.autoPromoted) {
    new Notice(`已登记验证「${picked.title}」并晋级 confirmed → ${picked.file.path}`, 4000);
  } else {
    new Notice(`已登记验证「${picked.title}」→ ${picked.file.path}`, 3000);
  }
};

// ---------- 候选规则列表（仅 proposed） ----------
//
// 读 flow/data/domains/<domain>/rules/*.md，frontmatter status: proposed 才列。
// 读 frontmatter 走极简解析（不引 _yaml.js 全套，规则文件 frontmatter 形态稳定，
// 与 _rule-review.js#readScalar / readBlockArray 同思路）。
async function listProposedRules(vault, rule, domain) {
  const folder = await vault.getAbstractFileByPath(rule.rulesFolder(domain));
  if (!folder || !folder.children) return [];
  const out = [];
  for (const child of folder.children) {
    if (!child || child.name.startsWith("_")) continue;
    if (!child.name.endsWith(".md")) continue;
    let content;
    try {
      content = await vault.read(child);
    } catch {
      continue;
    }
    const status = readStatusField(content);
    if (status !== "proposed") continue;
    const title = readTitleField(content) || child.basename;
    out.push({ file: child, title, relPath: child.path.replace(/^flow\/data\/domains\//, "") });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

// 极简 status 字段读取（仅扫 `status: <value>` 一行）
function readStatusField(content) {
  const m = String(content || "").match(/^status\s*:\s*(\S+)/m);
  return m ? m[1].trim() : "";
}

function readTitleField(content) {
  const m = String(content || "").match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

// 只认当前打开的任务文件 / folder README（与 rule-capture 共用入口判据）。
function resolveActiveTask(app, taskHelpers) {
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  const entry = taskHelpers.resolveTaskEntry(file);
  if (!entry) return null;
  if (entry.kind !== "root-file" && entry.kind !== "root-readme") return null;
  const cache = app.metadataCache && app.metadataCache.getFileCache(file);
  const type = cache && cache.frontmatter && cache.frontmatter.type;
  if (type !== "task" && type !== "task-folder") return null;
  return file;
}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}