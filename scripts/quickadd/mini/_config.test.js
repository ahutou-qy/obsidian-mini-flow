// _config.js 单测（裸 node：`node --test _config.test.js`）
//
// 重点测三件事：
//   1. 解析边界——空/坏配置回落默认值，**一个手滑的 JSON 不能打死整条链**；
//   2. 浅合并的**补齐语义**——配置里只写一项时，同组其它项必须仍是默认值
//      （漏了就会拿到 undefined，而 undefined 会让 `!== false` 之类的判断静默走错分支）；
//   3. **默认值与真配置的漂移守卫**——DEFAULTS 是「配置缺失时的兜底」，它与
//      flow/config/miniflow.json 的**键集合**必须一致；谁加了键忘了另一边，这条就红。
//      （2026-11-21 已按预告降级为键集合比对：deliveryDomains 等业务口径项与 paths 组
//      各机必然取值不同，比取值会把「按自己的 vault 填配置」误报成漂移。）
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");

const { CONFIG_PATH, DEFAULTS, parse, read } = require("./_config.js");

// ---------- 解析边界 ----------

test("空/缺失/损坏的配置一律回落全量默认值", () => {
  for (const input of [null, undefined, "", "   ", "{不是 json", "[1,2]"]) {
    const cfg = parse(input);
    assert.deepEqual(cfg.modules, DEFAULTS.modules, `输入 ${JSON.stringify(input)}`);
    assert.deepEqual(cfg.behavior, DEFAULTS.behavior);
    assert.deepEqual(cfg.paths, DEFAULTS.paths);
  }
});

test("浅合并：只写一项时，同组其它项必须仍是默认值（补齐语义）", () => {
  const cfg = parse('{"behavior":{"indexDebounceMs":150}}');
  assert.equal(cfg.behavior.indexDebounceMs, 150, "写的那项生效");
  assert.equal(cfg.behavior.progressSoftLimit, 5, "同组没写的项补齐默认值，不能是 undefined");
  assert.equal(cfg.behavior.maxFilenameLength, 30);
  assert.equal(cfg.paths.helperRoot, DEFAULTS.paths.helperRoot, "另一组不受影响");
  assert.equal(cfg.modules.yunxiao, true, "另一组不受影响");
});

test("空的组对象不覆盖默认值", () => {
  const cfg = parse('{"modules":{},"behavior":{},"paths":{}}');
  assert.deepEqual(cfg.modules, DEFAULTS.modules);
  assert.deepEqual(cfg.behavior, DEFAULTS.behavior);
  assert.deepEqual(cfg.paths, DEFAULTS.paths);
});

test("read(text, group) 只取那一组；不给组名取全部", () => {
  const text = '{"behavior":{"indexDebounceMs":50}}';
  assert.equal(read(text, "behavior").indexDebounceMs, 50);
  assert.deepEqual(read(text), parse(text));
  assert.equal(read(text, "paths").homePath, DEFAULTS.paths.homePath);
});

// ---------- 占位符展开 ----------

test("DEFAULTS 与 flow/config/miniflow.json 当前一致（改一边忘了另一边就红）", () => {
  let text = null;
  try {
    // 走 _vault-root.js 而非 __dirname 上溯：junction 下 __dirname 指向共享仓物理位置，
    // 上溯拿不到 vault 根（见 flow/CLAUDE.md「Mini Flow 代码面与共享仓」段）。
    const { resolveVaultRoot } = require("./_vault-root.js");
    text = fs.readFileSync(path.join(resolveVaultRoot(), CONFIG_PATH), "utf8");
  } catch (e) {
    // 拿不到真配置（非本机/未装）时跳过，不把「没装」报成「漂移」。
    test.skip(`读不到 ${CONFIG_PATH}，跳过漂移守卫：${e.message}`);
    return;
  }
  const cfg = parse(text);
  // **只比键集合，不比取值**（2026-11-21 降级，本文件头注早已预告）：
  // `behavior.deliveryDomains` / `deliveryExcludeDomains` 是各人自己的业务域名清单，
  // 真文件必然与 DEFAULTS（空）不同；paths 组同理。比取值会把「按自己的 vault 填配置」
  // 报成漂移。守的是「加了键忘了同步另一边」——那才是会静默降级的错。
  for (const group of ["modules", "behavior", "paths"]) {
    assert.deepEqual(
      Object.keys(cfg[group]).sort(),
      Object.keys(DEFAULTS[group]).sort(),
      `${group} 组键集合与 DEFAULTS 漂移`,
    );
  }
});
