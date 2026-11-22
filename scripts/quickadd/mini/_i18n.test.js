// _i18n.js 单测（裸 node：`node --test _i18n.test.js`）
//
// 重点测三件事：
//   1. **回落语义**——没表 / 缺 key / 值不是字符串，都必须回落到调用方给的中文原文，
//      绝不能出空字符串（漏译是可见的，静默变空是事故）；
//   2. **loadLocale 不抛错**——文案缺失不能让 capture / finish 主流程失败；
//   3. **真文件里确实有 key**——zh.json 写错 key、或代码用了文件里没有的 key，
//      这条会红，挡住「表和代码对不上」这种静默失配。
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");

// **别用 `__dirname` 上溯推 vault 根**：本文件在挂载点下，junction 让 __dirname 指向
// 共享仓物理位置（<本仓根>/scripts/...），上溯 7 层推出的是 E:\flow\...
// ——这正是 flow/CLAUDE.md「Mini Flow 代码面与共享仓」段记的坑（2026-11-21 实测踩中）。
// 同目录直接 require 定位器，再用它的 resolveVaultRoot() 取根。
const { resolveVaultRoot } = require("./_vault-root.js");
const VAULT_ROOT = resolveVaultRoot();
const MINI = path.join(VAULT_ROOT, "flow", "scripts", "quickadd", "mini");
const i18n = require(path.join(MINI, "_i18n.js"));

// 极简 mock vault：只实现 loadLocale 用到的 adapter.read(path)。
function mockVault(files) {
  return {
    adapter: {
      read: async (p) => {
        if (p in files) return files[p];
        throw new Error(`ENOENT: ${p}`);
      },
    },
  };
}

test.beforeEach(() => i18n.resetForTest());

test("没加载表时 t() 回落 fallback（不能出空串）", () => {
  assert.strictEqual(i18n.t("ui.parentTopic", "父主题"), "父主题");
  assert.strictEqual(i18n.t("ui.parentTopic"), "ui.parentTopic", "没给 fallback 退回 key，便于发现漏配");
});

test("加载表后 t() 返回译文", async () => {
  await i18n.loadLocale(mockVault({ "flow/config/i18n/zh.json": JSON.stringify({ ui: { parentTopic: "Parent topic" } }) }));
  assert.strictEqual(i18n.t("ui.parentTopic", "父主题"), "Parent topic");
});

test("表里没有该 key → 回落 fallback", async () => {
  await i18n.loadLocale(mockVault({ "flow/config/i18n/zh.json": JSON.stringify({ ui: {} }) }));
  assert.strictEqual(i18n.t("ui.childTopic", "子主题"), "子主题");
});

test("表里值不是字符串（如嵌套对象）→ 回落 fallback，不返回 [object Object]", async () => {
  await i18n.loadLocale(mockVault({ "flow/config/i18n/zh.json": JSON.stringify({ ui: { childTopic: { x: 1 } } }) }));
  assert.strictEqual(i18n.t("ui.childTopic", "子主题"), "子主题");
});

test("文案表不存在 / 坏 JSON → 空表、不抛错（文案缺失不能打断主流程）", async () => {
  await i18n.loadLocale(mockVault({}));
  assert.strictEqual(i18n.t("ui.parentTopic", "父主题"), "父主题");
  await i18n.loadLocale(mockVault({ "flow/config/i18n/zh.json": "{坏 json" }));
  assert.strictEqual(i18n.t("ui.parentTopic", "父主题"), "父主题");
});

test("locale 从 miniflow.json 的 i18n.locale 取；缺该键用默认 zh", async () => {
  await i18n.loadLocale(mockVault({
    "flow/config/miniflow.json": JSON.stringify({ i18n: { locale: "en" } }),
    "flow/config/i18n/en.json": JSON.stringify({ ui: { parentTopic: "EN" } }),
  }));
  assert.strictEqual(i18n.t("ui.parentTopic", "父主题"), "EN");
});

test("显式传 locale 覆盖配置里的值", async () => {
  await i18n.loadLocale(mockVault({
    "flow/config/miniflow.json": JSON.stringify({ i18n: { locale: "en" } }),
    "flow/config/i18n/zh.json": JSON.stringify({ ui: { parentTopic: "ZH" } }),
    "flow/config/i18n/en.json": JSON.stringify({ ui: { parentTopic: "EN" } }),
  }), "zh");
  assert.strictEqual(i18n.t("ui.parentTopic", "父主题"), "ZH");
});

// 时序守卫：**每个用 _t() 的文件，_t 的赋值必须在首次调用之前**。
// 批次 5 实测踩中：两个文件的加载块插在了锚点行之后，而首个 _t() 调用在它前面
// ——不崩（恒等函数回落原文），但**查表静默失效**，比崩更难发现。
test("每个用 _t() 的文件，_t 的赋值都在首次调用之前", () => {
  const root = resolveVaultRoot();
  const dir = path.join(root, "flow/scripts/quickadd/mini");
  let checked = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    const firstUse = src.search(/(?<![.\w])_t\("/);
    if (firstUse < 0) continue;
    if (name === "_ui.js") {
      // _ui.js 是 helper、没有自己的入口，它的 _t 由 initI18n(i18nMod) **注入**——
      // 加载时序由调用方（task-capture / task-edit）保证，不在本守卫范围。
      assert.ok(src.includes("function initI18n"), "_ui.js 应保留 initI18n 注入点");
      continue;
    }
    // 赋值行要**行首匹配**：注释里提到 `_t = i18nMod.t` 的说明行会被子串匹配误判成
    // 「又加载了一次」，把守卫变成永远红（2026-11-21 实测踩过）。
    const assign = src.search(/^\s*_t = i18nMod/m);
    assert.ok(assign >= 0, `${name} 用了 _t() 却没有给 _t 赋值`);
    assert.ok(assign < firstUse,
      `${name}: _t 的赋值在首次调用之后（晚 ${firstUse - assign} 行）——查表会静默失效`);
    checked++;
  }
  assert.ok(checked > 0, "没有文件在用 _t()，守卫空转");
});
// 漏了这条，改文件名/改 key 后界面会静默回落中文，而切换语言时才会发现（那时太晚）。
// 扫**整个 mini 目录**而非硬编码文件清单——每抽一批新文件，守卫自动覆盖，不会漏。
test("真 zh.json 覆盖代码里在用的 key（表与代码对不上就红）", async () => {
  const root = resolveVaultRoot();
  const zh = JSON.parse(fs.readFileSync(path.join(root, "flow/config/i18n/zh.json"), "utf8"));
  const dir = path.join(root, "flow/scripts/quickadd/mini");
  const used = new Set();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    for (const m of src.matchAll(/(?<![.\w])_?t\("([a-zA-Z][\w.]+)"/g)) used.add(m[1]);
  }
  if (used.size === 0) { test.skip("还没有代码在用 t()，跳过"); return; }
  for (const key of used) {
    const [ns, name] = key.split(".");
    assert.ok(zh[ns] && name in zh[ns], `zh.json 缺 ${key}`);
    assert.strictEqual(typeof zh[ns][name], "string", `${key} 的值应是字符串`);
  }
});
