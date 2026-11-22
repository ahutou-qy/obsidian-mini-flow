// ==============================================
// Mini Flow - vault 根定位（2026-11-20 起，Mini Flow 共享仓抽仓的配套）
//
// 为什么需要这个模块：Mini Flow 的代码面抽进独立共享仓之后，「代码在哪」与
// 「vault 在哪」解耦了。原先「从 __dirname 上溯 N 层 = vault 根」这种推导一律失效——
// **Node 会把 junction 解析成真实路径**：挂载后 __dirname 指向共享仓的物理位置，
// 不是 vault 里的逻辑位置（2026-11-20 实测：__dirname = ...\miniflow\scripts\...，
// 而入口路径 process.argv[1] = ...\obsidian\flow\scripts\...）。
//
// 定位顺序（先命中先用）：
//   1. 环境变量 MINIFLOW_VAULT_ROOT
//   2. 入口脚本的**逻辑**路径（process.argv[1] 不被 realpath 解析）向上找 vault 标记
//   3. 当前工作目录向上找
//   4. 共享仓内的本机定位文件 .miniflow-local.json（安装脚本写，逐机器、不进 git）
//   5. 抛错并说清怎么修——宁可报错，也不静默猜一个错的根（错的根会写到别处去）
//
// vault 标记 = 同时存在 .obsidian/ 与 flow/ 两个目录。
//
// 用法：
//   const { resolveVaultRoot } = require("./_vault-root.js");
//   const VAULT_ROOT = resolveVaultRoot();
// ==============================================

const fs = require("node:fs");
const path = require("node:path");

const MAX_UP = 12;

function isVaultRoot(dir) {
  if (!dir) return false;
  try {
    return (
      fs.existsSync(path.join(dir, ".obsidian")) &&
      fs.statSync(path.join(dir, ".obsidian")).isDirectory() &&
      fs.existsSync(path.join(dir, "flow")) &&
      fs.statSync(path.join(dir, "flow")).isDirectory()
    );
  } catch (e) {
    return false;
  }
}

function findVaultRootUpward(startDir) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (let i = 0; i < MAX_UP; i++) {
    if (isVaultRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readLocalLocator(startDir) {
  // 共享仓根的 .miniflow-local.json：{"vault_root": "<绝对路径>"}。
  // 安装脚本写、共享仓 .gitignore 排除——每台机器各有一份（各自 clone 的工作区）。
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, ".miniflow-local.json");
    try {
      if (fs.existsSync(file)) {
        // 去掉 BOM：某些编辑器/脚本会写成带 BOM 的 UTF-8，JSON.parse 吃不下前缀
        const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
        const data = JSON.parse(raw);
        if (data && data.vault_root && isVaultRoot(data.vault_root)) {
          return path.resolve(data.vault_root);
        }
      }
    } catch (e) {
      // 文件坏了就当没有，继续下一档；不因定位器本身把整个命令带崩
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveVaultRoot() {
  const fromEnv = process.env.MINIFLOW_VAULT_ROOT;
  if (fromEnv && isVaultRoot(fromEnv)) return path.resolve(fromEnv);

  // 入口脚本的逻辑路径：argv[1] 不被 realpath 解析，保留用户实际敲的那条路径，
  // 因此「node <vault>/flow/scripts/mvp/mf.js」能直接推回 vault 根。
  const entry = process.argv && process.argv[1];
  if (entry) {
    const fromEntry = findVaultRootUpward(path.dirname(path.resolve(entry)));
    if (fromEntry) return fromEntry;
  }

  const fromCwd = findVaultRootUpward(process.cwd());
  if (fromCwd) return fromCwd;

  const fromLocal = readLocalLocator(__dirname);
  if (fromLocal) return fromLocal;

  const fromSelf = findVaultRootUpward(__dirname);
  if (fromSelf) return fromSelf;

  throw new Error(
    "定位不到 vault 根（既没找到 .obsidian/ + flow/ 的标记目录，也读不到本机定位文件）。\n" +
      "三种修法（任选其一）：\n" +
      "  1) 设环境变量 MINIFLOW_VAULT_ROOT=<vault 根>\n" +
      "  2) 在 vault 内跑（cwd 在 vault 里会自动定位）\n" +
      "  3) 在共享仓根写 .miniflow-local.json：{\"vault_root\": \"<vault 根>\"}（install 脚本会写）"
  );
}

module.exports = { resolveVaultRoot, isVaultRoot, findVaultRootUpward };
