#!/usr/bin/env node
// ==============================================================================
// sync-config-keys.js — 把共享仓 config/miniflow.json.example 的**键**同步进本机配置
//
// 背景（2026-11-23，卡2 2.1）：`flow/config/miniflow.json` 逐机器分叉、**不挂载**，
// 各机留自己的真文件；共享仓存 example。于是「example 加了顶层组、某台机器忘了加」
// 就会静默漂移——2026-11-22 加的 `i18n` 组，mac 缺了一整天，而 `install --verify`
// 当时只比 modules/behavior/paths 三组、照样报「一致」。
// 这个工具补的就是那一半：**报出缺的键、按需补上**；取值一律不覆盖（各机自定）。
//
// 用法：
//   node scripts/tools/sync-config-keys.js                 # 只报告（默认读 resolveVaultRoot()）
//   node scripts/tools/sync-config-keys.js --vault <根>     # 指定 vault（路径含空格要加引号）
//   node scripts/tools/sync-config-keys.js --apply          # 把缺的键按 example 值补进去
//
// 退出码：0 无漂移（或已 apply）/ 1 有漂移且没 apply / 2 用法或 IO 错误
// 边界：只补键、不改已有取值；本机多出的键只提示、不删（那可能是本机特有的开关）。
// ==============================================================================
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SHARED_ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLE = path.join(SHARED_ROOT, "config", "miniflow.json.example");
const CONFIG_REL = "flow/config/miniflow.json";

function usage() {
  console.log(
    [
      "用法：node scripts/tools/sync-config-keys.js [--vault <vault 根>] [--apply]",
      "  --vault  vault 根目录；不给则用 _vault-root.js#resolveVaultRoot()",
      "  --apply  把 example 里有、本机缺的键补进去（已有取值一律不改）",
      "  报告模式：缺的键按 example 取值列出；本机多出的键只提示、不删。",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = { vault: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--vault") { out.vault = argv[++i]; if (!out.vault) throw new Error("--vault 缺值"); }
    else if (a === "--apply") out.apply = true;
    else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`读 ${p} 失败：${e.message}`);
  }
}

// 只补缺的键：递归，**永不覆盖已有值**。
// 返回 {filled: [["组.键", 值], ...]}；对象与标量类型不一致时算「本机已有」，不动（交给 --verify 报漂移）。
function fillMissing(target, template, prefix, filled) {
  for (const [k, v] of Object.entries(template)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (!(k in target)) { target[k] = v; filled.push([p, v]); continue; }
    const cur = target[k];
    if (cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v)) {
      fillMissing(cur, v, p, filled);
    }
    // 类型不同或已是标量：本机自己有主意，不动
  }
}

function extraKeys(target, template, prefix, extra) {
  for (const k of Object.keys(target)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (!(k in template)) { extra.push(p); continue; }
    const t = target[k], v = template[k];
    if (t && typeof t === "object" && !Array.isArray(t) && v && typeof v === "object" && !Array.isArray(v)) {
      extraKeys(t, v, p, extra);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let vaultRoot = args.vault;
  if (!vaultRoot) {
    // vault 根定位走契约文件，不用 __dirname 上溯（junction 下上溯会到共享仓）
    const { resolveVaultRoot } = require(path.join(SHARED_ROOT, "scripts", "quickadd", "mini", "_vault-root.js"));
    vaultRoot = resolveVaultRoot();
  }
  const cfgPath = path.join(vaultRoot, CONFIG_REL);
  const example = readJson(EXAMPLE);
  const local = fs.existsSync(cfgPath) ? readJson(cfgPath) : null;
  if (!local) {
    console.error(`[cfg] 本机配置不存在：${cfgPath}（先跑 install.sh --vault <根> 建挂载，再重跑）`);
    return 2;
  }

  const filled = [];
  fillMissing(local, example, "", filled);

  const extra = [];
  extraKeys(local, example, "", extra);

  if (!filled.length && !extra.length) {
    console.log(`[cfg] 键集合一致：${path.relative(vaultRoot, cfgPath).replace(/\\/g, "/")} == config/miniflow.json.example`);
    return 0;
  }

  if (filled.length) {
    console.log(`[cfg] 缺 ${filled.length} 个键（example 有、本机没有）：`);
    for (const [k, v] of filled) console.log(`    + ${k} = ${JSON.stringify(v)}`);
  }
  if (extra.length) {
    console.log(`[cfg] 本机多出 ${extra.length} 个键（example 没有，只提示不删）：`);
    for (const k of extra) console.log(`    - ${k}`);
  }

  if (!args.apply) {
    console.log("[cfg] 未改盘：确认后加 --apply 补上（已有取值不会被覆盖）");
    return 1;
  }
  if (!filled.length) {
    console.log("[cfg] 没有可补的键，未写盘");
    return 0;
  }
  const before = fs.readFileSync(cfgPath, "utf8");
  const out = JSON.stringify(local, null, 2) + (before.endsWith("\n") || !before ? "\n" : "");
  fs.writeFileSync(cfgPath, out, "utf8");
  console.log(`[cfg] 已写回 ${cfgPath}（补 ${filled.length} 个键，已有取值未动）`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`[cfg] ${e.message}`);
  process.exit(2);
}
