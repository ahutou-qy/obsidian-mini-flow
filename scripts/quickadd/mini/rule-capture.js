// ==============================================
// Mini Flow - Rule Capture：从当前任务沉淀一条领域规则。
//
// 在任务文件或 folder README 打开时执行：
//   1. 选领域（domains/ 下已有领域，扫描含 rules/ 子目录的域）
//   2. 输入规则短标题（用作文件名，走 _naming.buildFileName）
//   3. 输入一句话规则陈述（可留空，留到笔记里写）
//   4. 输入子方向 tag（可选，逗号分隔，如 上报,异步）
// 然后建 flow/data/domains/<domain>/rules/<slug>.md（status: proposed，
// sources 已带本任务），并往任务笔记追加「## 产出规则」块链回规则。
//
// 这是 Phase 1：独立命令，不挂 task-finish。晋级 confirmed 由后续
// 「登记复用」动作负责，本命令只建 proposed 规则。
// 任务状态以 Obsidian 为唯一真相。
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

  const [naming, rule, taskHelpers, review, configMod] = await Promise.all([
    loadHelper(vault, "_naming.js"),
    loadHelper(vault, "_rule.js"),
    loadHelper(vault, "_task.js"),
    loadHelper(vault, "_rule-review.js"),
    loadHelper(vault, "_config.js"),
  ]);
  // 文件名上限走配置（与建任务同源）；读不到就 undefined → _naming.js 兜底 30。
  const cfg = configMod && typeof configMod.loadFromAdapter === "function"
    ? await configMod.loadFromAdapter(vault.adapter)
    : null;
  const maxLen = cfg && cfg.behavior ? cfg.behavior.maxFilenameLength : undefined;

  const taskFile = resolveActiveTask(app, taskHelpers);
  if (!taskFile) {
    new Notice(_t("ruleCapture.needTaskFile", "请先打开任务文件或 folder README，再沉淀规则"));
    return;
  }

  // ---------- 1. 领域 ----------
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

  // ---------- 2. 短标题 ----------
  const titleInput = await quickAddApi.inputPrompt(_t("ruleCapture.shortTitleHint", "规则短标题（用作文件名，≤30字）"));
  if (titleInput == null) return; // Esc
  const title = naming.cleanTitle(titleInput);
  if (!title) {
    new Notice(_t("ruleCapture.emptyTitle", "标题为空，未创建规则"));
    return;
  }
  const fileName = naming.buildFileName(title, maxLen);
  const targetPath = rule.rulePath(domain, fileName);
  if (vault.getAbstractFileByPath(targetPath)) {
    new Notice(`规则已存在：${targetPath}`);
    return;
  }

  // ---------- 3. 一句话陈述（可留空） ----------
  const statement = await quickAddApi.inputPrompt(_t("ruleCapture.statementHint", "一句话规则陈述（可留空，稍后在笔记里写）")) || "";
  if (statement == null) return;

  // ---------- 4. 子方向 tag（可选） ----------
  const subtagInput = await quickAddApi.inputPrompt(_t("ruleCapture.tagsHint", "子方向 tag（可选，逗号分隔，如 上报,异步）")) || "";
  if (subtagInput == null) return;
  const subtags = String(subtagInput)
    .split(/[,，]/)
    .map((s) => naming.sanitize(s.trim()))
    .filter(Boolean);

  // ---------- 4.5. supersede（可选）：本规则取代的旧规则路径列表 ----------
  // 逗号分隔 vault 根相对路径（不含 .md 后缀，可含 [][]）。每条对应旧规则：
  //   - 新规则 frontmatter `supersedes` 写入这些路径（取代记录）
  //   - 旧规则触发 deprecateRule：status: deprecated + superseded_by: [[本规则]]
  // 留空 = 本规则不取代任何旧规则。旧规则不存在 / 已 superseded 状态由 §四校验提示。
  const supInput = await quickAddApi.inputPrompt(_t("ruleCapture.supersedeHint", "supersede 旧规则（可选，逗号分隔 vault 路径，如 flow/data/domains/work7/rules/foo）")) || "";
  if (supInput == null) return;
  const supersedes = String(supInput)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  // ---------- 落地：建规则 + 任务追加块 ----------
  const created = window.moment().format("YYYY-MM-DD");
  const taskPathNoExt = taskFile.path.replace(/\.md$/, "");
  const note = rule.buildRuleNote({
    title,
    statement,
    domain,
    subtags,
    created,
    sourceTaskPathNoExt: taskPathNoExt,
    supersedes,
  });

  try {
    const rulesDir = rule.rulesFolder(domain);
    if (!vault.getAbstractFileByPath(rulesDir)) {
      // domains/<domain>/rules 应已存在（listDomains 据此识别领域），
      // 兜底：不存在则逐级建，避免 listDomains 与磁盘状态漂移时崩。
      await ensureFolder(vault, rulesDir);
    }
    await vault.create(targetPath, note);

    const taskContent = await vault.read(taskFile);
    const updated = rule.appendProducedRuleBlock(taskContent, targetPath.replace(/\.md$/, ""), title);
    if (updated !== taskContent) await vault.modify(taskFile, updated);

    // ---------- 5. supersede 联动：把每个旧规则跑一遍 deprecateRule ----------
    // 新规则的 supersedes 字段已写入 frontmatter（见 buildRuleNote），这里只更新旧规则。
    // 旧规则不存在 / 已 deprecated：deprecateRule 内部 status=noop/error，落到下面 Notice 汇总。
    if (supersedes.length) {
      const newRulePathNoExt = targetPath.replace(/\.md$/, "");
      const results = [];
      for (const oldPath of supersedes) {
        const oldPathWithExt = oldPath.endsWith(".md") ? oldPath : `${oldPath}.md`;
        const oldFile = vault.getAbstractFileByPath(oldPathWithExt);
        if (!oldFile) {
          results.push({ path: oldPath, status: "error", message: "文件不存在" });
          continue;
        }
        let oldContent;
        try {
          oldContent = await vault.read(oldFile);
        } catch (e) {
          results.push({ path: oldPath, status: "error", message: String(e).slice(0, 80) });
          continue;
        }
        const supResult = review.deprecateRule(
          oldContent,
          oldFile.path,
          `被新规则 [[${newRulePathNoExt}]] 取代`,
          [newRulePathNoExt],
          created,
        );
        if (supResult.changed) {
          try {
            await vault.modify(oldFile, supResult.content);
            results.push({ path: oldPath, status: "deprecated" });
          } catch (e) {
            results.push({ path: oldPath, status: "error", message: `写盘失败: ${String(e).slice(0, 80)}` });
          }
        } else {
          results.push({ path: oldPath, status: supResult.status });
        }
      }
      // 汇总 supersede 联动结果到同一 Notice 文案（不另开 Notice，与 Mini Flow 策略对齐）
      const errors = results.filter((r) => r.status === "error");
      const skipped = results.filter((r) => r.status === "noop" || r.status === "deprecated-noop");
      if (errors.length || skipped.length) {
        const detail = [
          ...errors.map((r) => `${r.path}: ${r.message || r.status}`),
          ...skipped.map((r) => `${r.path}: ${r.status}`),
        ].join("；");
        console.warn(`[rule-capture] supersede 联动异常：${detail}`);
      }
    }
  } catch (e) {
    new Notice(`创建规则失败: ${String(e).slice(0, 160)}`);
    return;
  }

  // 2026-10-14：Rule Capture 不再自动重渲染 domains/<domain>/CLAUDE.md 的索引段。
  // 候选规则晋升为规约由人工审核后编辑相应域 CLAUDE.md 完成，详见该日决定。
  const supMsg = supersedes.length
    ? `（supersede ${supersedes.length} 条旧规则）`
    : "";
  new Notice(`已沉淀规则 [proposed]: ${title} → ${targetPath} ${supMsg}`.trim(), 4000);
};

// 只认当前打开的任务文件 / folder README（与 task-finish 的文件入口一致）。
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

async function ensureFolder(vault, folderPath) {
  let current = "";
  for (const part of String(folderPath).split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
