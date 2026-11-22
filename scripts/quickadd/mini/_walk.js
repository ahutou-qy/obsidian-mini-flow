// ==============================================
// Mini Flow - 文件索引 walk 共享工具
//
// task-upgrade（升级时一次性预生成）、task-refresh-index（手动刷）和 miniflow
// 插件（打开/增删文件时静默重写）共用同一份 walk 逻辑，避免多处实现漂移。QuickAdd 沙盒里
// require 不了相对路径，两个脚本用 loadWalkHelpers(app) 字符串加载（跟 _naming.js 同模式）。
//
// 规则：
// - 忽略以 `.` 开头的隐藏文件
// - README.md 在 folder 根时跳过（就是承载索引的文件自身，不列自链接）
// - md 去扩展名；其它类型保留扩展名让 Obsidian 走对应打开逻辑
// - 目录先于文件，同类按 zh-Hans 本地序，跟 Finder 视觉一致
// - `.assets` 后缀目录（pandoc/typora 相邻附件）只留占位、不展开，附件由正文内联引用
// - 根级 `input/` / `output/` / `process/` 只展一层：直接放进去的文件照常列出，
//   其下的子文件夹（input/rfid/、input/Proneta_3_10_0_0/ 等）一律只留目录占位、
//   不递归——附件/工具包进子目录后由 Finder/文件树进，避免索引被第三方包刷屏
//   （2026-08-24 收紧）。其它根级目录（design/ 等）仍正常展开。
// - 巨型第三方包由 isVendoredBundle 折叠（node_modules / venv / site-packages /
//   offline whl 等只留占位不递归）
// - `.assets` 后缀目录（pandoc/typora 相邻附件）只留占位、不展开，附件由正文内联引用
// ==============================================

const ARTIFACT_DIRS = new Set(["input", "output", "process"]);

function buildIndexBody(taskFolder) {
  // 根 README 不列：它就是承载 `## 文件索引` 的文件本身，加一行指向自己的链接没有导航价值，
  // 还会在 backlinks 里制造自链噪音。子目录里的 README（如 design/README）走相对路径列出，
  // 那是真有导航价值的子索引。walk() 在 relPrefix 为空时跳过根 README.md，这里从空数组起步。
  const lines = [];
  walk(taskFolder, "", 0, lines);
  return lines.join("\n");
}

// 判定一个目录是不是第三方依赖/运行时包（内嵌 CPython、venv、node_modules、site-packages、
// pip wheel 缓存）。命中只留目录占位、不递归展开。判据用结构特征而非目录名，避免误伤同名内容目录。
function isVendoredBundle(folder) {
  const kids = folder.children || [];
  const names = kids.map(c => c.name);
  const child = (n) => kids.find(c => c.name === n && Array.isArray(c.children));
  if (names.includes("pyvenv.cfg")) return true;                       // Python venv 根
  const bin = child("bin");
  const lib = child("lib");
  if (bin && bin.children.some(c => /^python3(\.\d+)?(?:\.exe)?$/i.test(c.name))) return true;  // 内嵌 CPython
  if (lib && lib.children.some(c => /^python\d+\.\d+$/i.test(c.name))) return true;             // 含标准库
  if (folder.name === "node_modules" || folder.name === "site-packages") return true;
  if (/offline[_-]?pkgs?/i.test(folder.name) && names.some(n => n.endsWith(".whl"))) return true; // pip 离线包
  return false;
}

function walk(folder, relPrefix, depth, out) {
  const children = [...(folder.children || [])].sort((a, b) => {
    const aDir = Array.isArray(a.children);
    const bDir = Array.isArray(b.children);
    if (aDir !== bDir) return aDir ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), "zh-Hans");
  });
  const indent = "  ".repeat(depth);
  for (const child of children) {
    if (String(child.name).startsWith(".")) continue;
    if (!relPrefix && child.name === "README.md") continue;
    const rel = relPrefix ? `${relPrefix}/${child.name}` : child.name;
    if (Array.isArray(child.children)) {
      out.push(`${indent}- **${child.name}/**`);
      // `.assets` 是 pandoc/typora 导出 md 的相邻附件目录，图片已由正文内联引用，
      // 索引只保留目录占位、不展开逐个二进制文件，避免刷屏；附件从正文进。
      if (/\.assets$/i.test(child.name)) continue;
      // 根级 input/output/process 只展一层：其下的子文件夹一律只留占位、不递归
      // （见文件头规则），直接放在这层的文件在上面 else 分支照常列出。
      if (ARTIFACT_DIRS.has(relPrefix)) continue;
      // 其它目录正常展开，仅折叠第三方依赖包。
      if (isVendoredBundle(child)) continue;
      walk(child, rel, depth + 1, out);
    } else {
      const isMd = child.name.endsWith(".md");
      const link = isMd ? rel.replace(/\.md$/, "") : rel;
      // target 保留相对前缀（[[design/xx]]）防 vault 内撞名 fuzzy；
      // 显示只露 basename，避免与上层目录标题重复。根级文件 link 无 `/`，
      // label 等于 link 时不加别名。
      const label = isMd ? child.name.replace(/\.md$/, "") : child.name;
      const text = label === link ? link : `${link}|${label}`;
      out.push(`${indent}- [[${text}]]`);
    }
  }
}

module.exports = { buildIndexBody, walk };
