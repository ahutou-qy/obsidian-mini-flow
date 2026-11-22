// ==============================================
// Mini Flow - Rule Deprecate：标记规则为 deprecated（决策 3 superseded_by 选填）。
// 设计与契约见
// （上游设计文档，不在本包内） §一。
//
// 触发：当前活动文件必须是 rule。
// 行为：
//   1) 校验活动文件是 rule
//   2) 输入废弃理由
//   3) 可选：输入 superseded_by（新规则的 vault 路径，留空 = 单纯否决）
//   4) 写盘：status: deprecated + 可选 superseded_by: [...] + ## 变更 追加条目
//
// 边界：
//   - 已 deprecated → Notice 「已是 deprecated」短路
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

  const review = await loadHelper(vault, "_rule-review.js");

  const ruleFile = resolveActiveRule(app);
  if (!ruleFile) {
    new Notice(_t("ruleDeprecate.needRuleFile", "请先打开一条规则文件（type: rule），再走 Deprecate"));
    return;
  }
  const today = window.moment().format("YYYY-MM-DD");
  const reason = await quickAddApi.inputPrompt(_t("ruleDeprecate.reasonHint", "废弃理由，一句话")) || "";
  if (reason == null) return;

  // superseded_by 选填：留空 = 单纯否决 / 项目废弃；非空 = 被新规则覆盖。
  const supRaw = await quickAddApi.inputPrompt(_t("ruleDeprecate.supersededByHint", "superseded_by 新规则路径（可选，留空 = 单纯否决）")) || "";
  if (supRaw == null) return;
  const supersededBy = supRaw.trim()
    ? supRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    : [];

  let content;
  try {
    content = await vault.read(ruleFile);
  } catch (e) {
    new Notice(`读取规则失败: ${String(e).slice(0, 160)}`);
    return;
  }
  const result = review.deprecateRule(content, ruleFile.path, reason.trim(), supersededBy, today);

  if (result.status === "noop") {
    new Notice(_t("ruleDeprecate.alreadyDeprecated", "规则已是 deprecated，不重复标记"), 3000);
    return;
  }
  if (result.status === "error") {
    new Notice(`废弃失败: ${result.message || "未知错误"}`, 3000);
    return;
  }

  try {
    await vault.modify(ruleFile, result.content);
  } catch (e) {
    new Notice(`写盘失败: ${String(e).slice(0, 160)}`);
    return;
  }
  const detail = supersededBy.length
    ? `已 deprecated（被 ${supersededBy.join(", ")} 取代）`
    : `已 deprecated`;
  new Notice(`${detail}：${ruleFile.basename} → ${ruleFile.path}`, 4000);
};

function resolveActiveRule(app) {
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  const cache = app.metadataCache && app.metadataCache.getFileCache(file);
  const type = cache && cache.frontmatter && cache.frontmatter.type;
  if (type !== "rule") return null;
  return file;
}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}