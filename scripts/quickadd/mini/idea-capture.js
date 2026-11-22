// ==============================================
// Mini Flow - Idea Capture：随手闪念，追加到独立数据文件。
//
// 2026-08-20 从原 Idea 命令正名拆分而来：
// - 建 type:task-folder 任务的命令改名 Task Capture（task-capture.js）。
// - 本命令收一两句、尚不成结论的碎片（想法、待消化的链接、临时记录），
//   不进任务流水线、不建 folder、不进月度 Capture、不被 miniflow 索引。
//   沉淀成行动项后再走 Task Capture。
//
// 落点：flow/ideas-home.txt，用 vault.adapter（底层 fs）读写。
// 关键：不能写 .md 也不能走 vault.modify——那会让 Dataview 索引到它、bump
// index.revision，导致 Home 里所有 dataviewjs 块重跑（render 先 innerHTML=""），
// 产生「一闪」。.txt 不被 Dataview 索引，adapter 直写不走 vault modify 事件。
// Home.md 的「💡 闪念」段读这个文件渲染，写完派发 miniflow:ideas-changed 局部重绘。
//
// 每条 `- 内容`（不写日期时间——闪念的时间戳无意义，纯属噪音），正文可带 #tag；
// Esc 或空输入取消。
// ==============================================

const IDEAS_PATH = "flow/ideas-home.txt";
const CHANGE_EVENT = "miniflow:ideas-changed";

// 界面文案查表（阶段 3）。**模块级 `_t`**：入口 load 一次后赋值；未赋值时恒等返回原文。
// 与 task-capture / task-edit / _ui.js / rule-* 同款——避开「局部 const 取不到模块级
// class 里的调用」那个坑（批次 2 实测）。
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

module.exports = async ({ app, quickAddApi }) => {
  // 文案表（阶段 3）：内联最小加载器（被字符串加载的脚本不能 require 同目录文件，
  // 各文件的 loadHelper / loadMiniHelper 签名也不一，一律走 adapter.read）。
  // **必须排在任何 _t() 调用之前**——下面就要用。
  const i18nSrc = await app.vault.adapter.read("flow/scripts/quickadd/mini/_i18n.js");
  const i18nMod = { exports: {} };
  new Function("module", "exports", i18nSrc)(i18nMod, i18nMod.exports);
  await i18nMod.exports.loadLocale(app.vault);
  _t = i18nMod.exports.t;
  const adapter = app.vault.adapter;
  const text = await quickAddApi.inputPrompt(_t("ideaCapture.prompt", "闪念（Esc 取消）"));
  const body = (text ?? "").trim();
  if (!body) {
    new Notice(_t("common.cancelledEmpty", "已取消：空内容不写入"), 2000);
    return;
  }

  const line = `- ${body}`;


  // 闪念文件路径走配置（paths.ideasFile）。本脚本没有 loadHelper，内联一份最小加载器
  // （与 task-upgrade#loadConfigHelpers 同款）——被字符串加载的脚本不能 require 同目录
  // 文件，只能走 adapter。读不到就用默认值，别让一次配置读取失败挡住记闪念。
  let ideasPath = IDEAS_PATH;
  try {
    const src = await adapter.read("flow/scripts/quickadd/mini/_config.js");
    const m = { exports: {} };
    new Function("module", "exports", src)(m, m.exports);
    const cfg = await m.exports.loadFromAdapter(adapter);
    if (cfg && cfg.paths && cfg.paths.ideasFile) ideasPath = cfg.paths.ideasFile;
  } catch (_e) { /* 读不到用默认 */ }

  let prev = "";
  try { prev = await adapter.read(ideasPath); } catch { /* 不存在则新建 */ }
  const next = (prev.replace(/\s*$/, "") || "") + (prev.trim() ? "\n" : "") + line + "\n";
  await adapter.write(ideasPath, next);

  // 通知已打开的 Home 视图局部刷新（不触发任何 dataview 块重跑）。
  window.dispatchEvent(new Event(CHANGE_EVENT));
};
