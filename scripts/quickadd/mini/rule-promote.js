// ==============================================
// Mini Flow - Rule Promote：手动 force `status: confirmed`（不依赖 validated_by 数）。
// 适用于：复盘后人工评审判断"应该 confirmed，但还没另一任务复用"的情形。
// 设计与契约见
// （上游设计文档，不在本包内） §一。
//
// 触发：当前活动文件必须是 rule（type: rule）。任务文件不适用——任务入口走 Rule Validate。
// 行为：
//   1) 校验活动文件是 rule
//   2) 输入晋级理由（一句话，写进 ## 变更 段）
//   3) 写盘：status: confirmed + ## 变更 追加 `manual promote：<reason>`
//
// 边界：
//   - 已 confirmed → Notice 「已是 confirmed」短路
//   - 已 deprecated → Notice 「不能手动晋级」短路（sticky）
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
    new Notice(_t("rulePromote.needRuleFile", "请先打开一条规则文件（type: rule），再走 Promote"));
    return;
  }
  const today = window.moment().format("YYYY-MM-DD");
  const reason = await quickAddApi.inputPrompt(_t("rulePromote.reasonHint", "晋级理由，一句话，落地 ## 变更 段")) || "";
  if (reason == null) return;

  let content;
  try {
    content = await vault.read(ruleFile);
  } catch (e) {
    new Notice(`读取规则失败: ${String(e).slice(0, 160)}`);
    return;
  }
  const result = review.promoteRuleManual(content, ruleFile.path, reason.trim(), today);

  if (result.status === "noop") {
    new Notice(_t("rulePromote.alreadyConfirmed", "规则已是 confirmed，不重复晋级"), 3000);
    return;
  }
  if (result.status === "deprecated") {
    new Notice(_t("rulePromote.isDeprecated", "规则已 deprecated，不能手动晋级"), 3000);
    return;
  }
  if (result.status === "error") {
    new Notice(`晋级失败: ${result.message || "未知错误"}`, 3000);
    return;
  }

  try {
    await vault.modify(ruleFile, result.content);
  } catch (e) {
    new Notice(`写盘失败: ${String(e).slice(0, 160)}`);
    return;
  }
  new Notice(`已晋级 confirmed：${ruleFile.basename} → ${ruleFile.path}`, 4000);
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