// ==============================================
// Mini Flow - 界面文案查表（阶段 3 · 文案表）
//
// 把硬编码在弹框 / Notice 里的中文抽到 `flow/config/i18n/<locale>.json`，
// 让「换语言」只改数据不改代码。**阶段 3 只做抽表 + 预留 en.json 骨架，不做翻译**
// （见 process/01-调研与方案.md §六 阶段 3）。
//
// **为什么文案表要「load 一次、之后同步用」**：`Modal.onOpen()` 是**同步**方法，
// 里面 await 不了；Notice 也常在同步渲染路径里抛。所以入口（async）先 `await loadLocale()`
// 把表灌进模块级 TABLE，渲染时用同步的 `t(key)` 取值——时序上 open() 在 await 之后，
// 表一定就绪。
//
// **key 是语义路径**（`ui.parentTopic` / `taskSearch.empty`），不拿文案本身当 key：
// 文案一改 key 就断，而语义 key 不随文案变；漏译时 `t()` 回落 key 的 fallback，
// **可见地显示中文原文**，不会出空字符串。
//
// **带变量的模板不抽**（如 `定位不到任务：${x}`）——抽进 JSON 要引入插值规则，
// 比直接在代码里拼更难读，收益也不在本阶段。
// ==============================================

const CONFIG_PATH = "flow/config/miniflow.json";
const I18N_DIR = "flow/config/i18n";
const DEFAULT_LOCALE = "zh";

// 模块级查表对象。**每个被 loadModule 加载的脚本各有一份实例**（new Function 每次执行
// 都是新模块），所以各脚本在自己的入口 load 一次即可，互不干扰、也不会跨调用陈旧。
let TABLE = Object.create(null);
let LOADED = null; // 已加载的 locale，重复调用直接短路

// 读 locale → 读对应文案表 → 灌进 TABLE。**任何一步失败都回落到空表**（= 全部用原文），
// 不抛错：文案缺失不该让 capture / finish 主流程失败。
async function loadLocale(vault, locale) {
  let want = locale || DEFAULT_LOCALE;
  if (!locale) {
    try {
      const raw = await vault.adapter.read(CONFIG_PATH);
      const cfg = JSON.parse(raw);
      if (cfg && cfg.i18n && typeof cfg.i18n.locale === "string" && cfg.i18n.locale) {
        want = cfg.i18n.locale;
      }
    } catch (_e) { /* 没有 miniflow.json 或解析失败 → 用默认 locale */ }
  }
  if (LOADED === want) return TABLE;
  try {
    const src = await vault.adapter.read(`${I18N_DIR}/${want}.json`);
    const parsed = JSON.parse(src);
    TABLE = (parsed && typeof parsed === "object") ? Object.assign(Object.create(null), parsed)
      : Object.create(null);
  } catch (_e) {
    TABLE = Object.create(null); // 表不存在 / 坏 JSON → 全部回落原文
  }
  LOADED = want;
  return TABLE;
}

// 同步取译文。key 是**点号路径**（`ui.parentTopic`），与 zh.json 的分组结构对应——
// 表按模块分组比 88 个扁平 key 好读，代价只是这里逐段下钻。
// `fallback` 是**中文原文**（调用方传自己的原文字面量）——没有表、路径断在中途、
// 或值不是字符串时，一律回落它，**绝不出空串**（漏译可见，静默变空是事故）。
function t(key, fallback) {
  let v = TABLE;
  if (v) {
    for (const seg of String(key).split(".")) {
      v = v[seg];
      if (v === undefined || v === null) break;
    }
  }
  if (typeof v === "string" && v !== "") return v;
  return fallback === undefined ? key : fallback;
}

// 单测用：清掉已加载状态（否则第二次断言会命中上一次的表）。
function resetForTest() {
  TABLE = Object.create(null);
  LOADED = null;
}

module.exports = {
  CONFIG_PATH,
  I18N_DIR,
  DEFAULT_LOCALE,
  loadLocale,
  t,
  resetForTest,
};
