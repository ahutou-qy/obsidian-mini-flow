// ==============================================
// Mini Flow - UI 视觉公共 helper
//
// 原 idea.js 私有函数（行 724-745），被 task-edit.js / idea.js 共同需要。
// 抽到一处：两处都 loadHelper("_ui") 调用。
//
// applyChipHighlight：Minimal 主题下 mod-cta 视觉偏弱；inline 读
// --interactive-accent / --text-on-accent 主题色，主题切换时跟随。
// getCssVar：读 --css-var 名，提供 fallback（返回 '' 由 caller 处理）。
//
// 关键约束：applyChipHighlight 依赖 window.getComputedStyle，
// 在裸 node 环境（_ui.test.js）下 window 不存在，getCssVar 会抛；
// 调用方应做好 try/catch 兜底（_ui.test.js 验证这层鲁棒性）。
// ==============================================

// 界面文案查表（阶段 3 · 文案表）。本文件的 helper 都是**同步函数**，
// 没法在渲染时 await loadLocale，所以走**注入**：调用方入口
// `await i18n.loadLocale(vault)` 之后调 `initI18n(i18nMod)`，之后闭包里同步用 `_t()`。
// 没注入时 `_t` 恒等返回原文——**初始化缺失不该让界面变空**（回落中文，看得见）。
let _tWarned = false;
let _t = (key, fallback) => {
  // 表还没加载就用 _t → 查表静默失效。**warn 一次**（不每次都吵），让它可见：
  // 症状是「切到英文后界面还是中文」，而 warn 会直接指出是加载时序问题。
  if (!_tWarned) {
    _tWarned = true;
    console.warn("[miniflow] 文案表未加载，界面文案回落中文原文——检查入口是否在用 _t() 之前 await 了 loadLocale");
  }
  return fallback === undefined ? key : fallback;
};
function initI18n(mod) {
  if (mod && typeof mod.t === "function") _t = mod.t;
}

function getCssVar(name) {
  try {
    if (typeof window === "undefined" || !window.getComputedStyle) return "";
    const v = window.getComputedStyle(document.body).getPropertyValue(name);
    return v ? v.trim() : "";
  } catch (e) {
    return "";
  }
}

function applyChipHighlight(btn, on) {
  if (!btn) return;
  if (on) {
    const accent = getCssVar("--interactive-accent") || "#5b8def";
    const onAccent = getCssVar("--text-on-accent") || "#ffffff";
    btn.style.backgroundColor = accent;
    btn.style.color = onAccent;
    btn.style.borderColor = accent;
  } else {
    btn.style.backgroundColor = "";
    btn.style.color = "";
    btn.style.borderColor = "";
  }
}

module.exports = {
  applyChipHighlight,
  getCssVar,
  // 文案注入：调用方入口 await loadLocale 后调它（见文件头注释）
  initI18n,
};
// 2026-11-23 砍 topic：原 topic UI helper 全套已删——
// matchTopicByQuery / applyAllTopicsFilter / buildTopicTree / findTopicRoot /
// renderFlatChips / applyTopicSubtreeFilter / applyTreeTopicsFilter / createTopicSection。
// 这 8 个此前零非测试调用方（只被本文件内部与 _ui.test.js / _smoke.js 引用）。
