// ==============================================
// migrate-source-link.js —— 存量任务 source 链接补一级（2026-11-22）
//
// **本文件是真源**（随共享仓走，两台机器 pull 即得）。Windows 卡2 任务目录下的
// `process/04-migrate-source-link.js` 是本轮执行记录副本，改判据改这里。
//
// 病症：`_task.js#buildSourceLink` 原先只加一级 `../`，而 folder 任务 README 在
//   flow/data/YYYY/Qn/MM/<dir>/README.md —— 一级只到 Qn/MM/，月度 capture 文件在 Qn/。
//   于是所有 folder 任务的「来源」是红链（mac 侧 2026-11-22 实测）。生成侧已修，本脚本补存量。
//
// **按深度区分，不能一刀切**：
//   - folder README（Qn/MM/<dir>/README.md）→ 需要 `../../`
//   - 单文件任务（Qn/MM/<名>.md）        → 一级 `../` **本来就对**，本脚本只核对不改
//
// 只动两处链接，别的一个字节不碰（含行尾：全程原始字符串替换，不做 CRLF 归一）：
//   1. frontmatter 的 `source: "[[../ideas-YYYY-MM#^cap-xxx]]"`
//   2. 正文的 `来源：[[../ideas-YYYY-MM#^cap-xxx]]`
// 正文其它位置若也有同款红链，**只报不改**（可能是快照/叙事里的引用，改动面要人判）。
//
// 幂等：正则要求 `[[` 紧跟 `../ideas-`，两级形式 `[[../../ideas-` 天然不匹配，重跑零改动。
// 裸名形式 `[[ideas-YYYY-MM#…]]` 不动——Obsidian 按 basename 唯一解析，它是能跳的。
//
// 用法（**在 vault 根跑**，脚本自己上溯定位 vault 根，放哪跑都行）：
//   node <共享仓>/scripts/tools/migrate-source-link.js            # dry-run，只报
//   node <共享仓>/scripts/tools/migrate-source-link.js --check    # 只读对账：断链数
//   node <共享仓>/scripts/tools/migrate-source-link.js --apply    # 真写
//   node ... --apply --only <路径子串>                            # 限定范围（试跑用）
// 退出码：--check 有断链时退 1，其余 0。
// ==============================================
const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const CHECK = process.argv.includes("--check");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

// vault 根：**一律走定位器**，不许从 __dirname 上溯——本文件住在共享仓，
// 上溯只会到共享仓根（没有 flow/ + .obsidian/）。定位器认 MINIFLOW_VAULT_ROOT /
// 入口逻辑路径 / cwd / 共享仓根的 .miniflow-local.json，见 _vault-root.js 头注。
const { resolveVaultRoot } = require("../quickadd/mini/_vault-root.js");

const ROOT = resolveVaultRoot();
const DATA = path.join(ROOT, "flow", "data");

const FOLDER_README = /^flow\/data\/\d{4}\/Q[1-4]\/\d{2}\/[^/]+\/README\.md$/;
const SINGLE_FILE = /^flow\/data\/\d{4}\/Q[1-4]\/\d{2}\/[^/]+\.md$/;

// 只匹配一级前缀；两级形式不匹配 → 幂等
const ONE_LEVEL = /\[\[\.\.\/(ideas-\d{4}-\d{2})/g;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

const files = walk(DATA, []);

// --check：只读对账——把每个 folder README 的 source 链接按相对路径解析，看目标文件在不在。
// 这是「链接能不能跳」的地面真值，比数前缀可靠（Obsidian 对含 `/` 的链接按路径解析，不做 basename 兜底）。
if (CHECK) {
  let ok = 0, bare = 0;
  const bad = [];
  for (const abs of files) {
    const r = rel(abs);
    if (!FOLDER_README.test(r)) continue;
    const m = fs.readFileSync(abs, "utf8").match(/^source:\s*["']?\[\[([^\]#]+)/m);
    if (!m) { bad.push([r, "无 source"]); continue; }
    const link = m[1];
    if (!link.includes("/")) { bare++; continue; } // 裸名：Obsidian 按 basename 唯一解析，能跳
    const target = path.resolve(path.dirname(abs), link.endsWith(".md") ? link : link + ".md");
    if (fs.existsSync(target)) ok++; else bad.push([r, link]);
  }
  console.log("=== CHECK（只读对账）===");
  console.log(`相对链接可解析：${ok} | 裸名形式：${bare} | 断链：${bad.length}`);
  for (const b of bad.slice(0, 20)) console.log("  ✗ " + b[0] + " -> " + b[1]);
  process.exit(bad.length ? 1 : 0);
}
const stats = {
  folderReadme: 0, singleFile: 0,
  changed: 0, changedSource: 0, changedBody: 0,
  alreadyTwoLevel: 0, bareForm: 0, noSource: 0,
  otherRefs: [], singleWrong: [], touched: [],
};

for (const abs of files) {
  const r = rel(abs);
  if (ONLY && !r.includes(ONLY)) continue;

  const isFolder = FOLDER_README.test(r);
  const isSingle = SINGLE_FILE.test(r);
  if (!isFolder && !isSingle) continue;

  const raw = fs.readFileSync(abs, "utf8");
  const srcLine = raw.match(/^source:.*$/m);

  if (isSingle) {
    stats.singleFile++;
    // 单文件任务：一级才对。出现两级说明有人误改过，只报不改。
    if (srcLine && /\[\[\.\.\/\.\.\//.test(srcLine[0])) stats.singleWrong.push(r);
    continue;
  }

  stats.folderReadme++;
  if (!srcLine) { stats.noSource++; continue; }
  if (/\[\[\.\.\/\.\.\/ideas-/.test(srcLine[0])) { stats.alreadyTwoLevel++; continue; }
  if (/\[\[ideas-/.test(srcLine[0])) { stats.bareForm++; continue; }
  if (!/\[\[\.\.\/ideas-/.test(srcLine[0])) continue;

  // 逐行处理，只认 source: 行与 来源 行；其余行原样保留（含 \r）
  const lines = raw.split("\n");
  let hitSource = 0, hitBody = 0, other = 0;
  const out = lines.map((line) => {
    const isSrc = /^source:/.test(line);
    const isBody = /^来源[：:]/.test(line);
    if (!isSrc && !isBody) {
      const m = line.match(ONE_LEVEL);
      if (m) other += m.length;
      return line;
    }
    let n = 0;
    const next = line.replace(ONE_LEVEL, (_all, name) => { n++; return `[[../../${name}`; });
    if (isSrc) hitSource += n; else hitBody += n;
    return next;
  });

  if (other) stats.otherRefs.push({ file: r, count: other });
  if (!hitSource && !hitBody) continue;

  stats.changed++;
  stats.changedSource += hitSource;
  stats.changedBody += hitBody;
  stats.touched.push(r);
  if (APPLY) fs.writeFileSync(abs, out.join("\n"), "utf8");
}

console.log(APPLY ? "=== APPLY（已写盘）===" : "=== DRY-RUN（未写盘）===");
console.log(`vault 根：${ROOT}`);
console.log(`folder README 候选：${stats.folderReadme}（已是两级 ${stats.alreadyTwoLevel} / 裸名 ${stats.bareForm} / 无 source ${stats.noSource}）`);
console.log(`单文件任务：${stats.singleFile}（一级前缀本来就对，未改；异常两级的 ${stats.singleWrong.length} 条）`);
console.log(`本次改动文件：${stats.changed}（source 行 ${stats.changedSource} 处 / 来源行 ${stats.changedBody} 处）`);
if (stats.singleWrong.length) {
  console.log("\n[!] 单文件任务出现两级前缀（需人工看）：");
  for (const f of stats.singleWrong) console.log("    " + f);
}
if (stats.otherRefs.length) {
  console.log("\n[i] 正文其它位置仍有同款一级链接（只报不改）：");
  for (const o of stats.otherRefs) console.log(`    ${o.file} × ${o.count}`);
}
if (!APPLY && stats.touched.length) {
  console.log(`\n将改动的前 10 个文件（共 ${stats.touched.length}）：`);
  for (const f of stats.touched.slice(0, 10)) console.log("    " + f);
}
