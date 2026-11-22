// 一次性：把 folder 任务 README 的 `## 文件索引` 段移到正文最上方（第一个非索引 H2 之前）。
// 幂等：已置顶跳过；要求段含 <!-- auto-index:end --> 哨兵才动，否则报告跳过。
// 用法：node flow/scripts/quickadd/mini/move-index-to-top.js [--apply]
const fs = require("fs");
const path = require("path");

const { resolveVaultRoot } = require("./_vault-root.js");
const ROOT = resolveVaultRoot(); // 挂载后 __dirname 上溯推不出 vault 根，定位交给 _vault-root.js
const DATA = path.join(ROOT, "flow", "data");
const APPLY = process.argv.includes("--apply");

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name === "README.md") out.push(p);
  }
  return out;
}

const files = walk(DATA, []);
const moved = [];
const skippedNoSentinel = [];
const alreadyTop = [];
const errors = [];

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { errors.push(`${file}: ${e.message}`); continue; }
  if (!/^##[ \t]+文件索引[ \t]*$/m.test(text)) continue;
  if (!/<!-- auto-index:end -->/.test(text)) { skippedNoSentinel.push(file); continue; }

  const lines = text.split(/\r?\n/);
  // 找 frontmatter 边界（可选）
  let bodyStart = 0;
  if (lines[0] && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { bodyStart = i + 1; break; }
    }
  }
  // 在 body 内定位第一个 H2 与文件索引段
  let firstH2 = -1, indexH2 = -1, indexEnd = -1;
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^##[ \t]+/.test(lines[i])) {
      if (firstH2 === -1) firstH2 = i;
      if (/^##[ \t]+文件索引[ \t]*$/.test(lines[i]) && indexH2 === -1) indexH2 = i;
    }
    if (indexH2 !== -1 && /<!-- auto-index:end -->/.test(lines[i])) { indexEnd = i; break; }
  }
  if (indexH2 === -1 || indexEnd === -1) { errors.push(`${file}: 定位失败`); continue; }
  if (firstH2 === indexH2) { alreadyTop.push(file); continue; }

  // 抽出索引段（header .. end 哨兵，含尾行）
  const section = lines.slice(indexH2, indexEnd + 1);
  // 从原位删除：连带段前段后空行，避免留下大空块
  let without = lines.slice(0, indexH2).concat(lines.slice(indexEnd + 1));
  // 重整：把删除点处的连续空行压成最多一个
  without = without.join("\n").replace(/\n{3,}/g, "\n\n").split("\n");

  // 重新定位 bodyStart 后第一个 H2（删除后行号可能变，但内容未动前半段，bodyStart 仍有效）
  let insertAt = -1;
  for (let i = bodyStart; i < without.length; i++) {
    if (/^##[ \t]+/.test(without[i])) { insertAt = i; break; }
  }
  if (insertAt === -1) { errors.push(`${file}: 找不到插入点 H2`); continue; }

  const next = without.slice(0, insertAt)
    .concat(section)
    .concat(without.slice(insertAt));
  const outText = next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");

  moved.push(file);
  if (APPLY) {
    try { fs.writeFileSync(file, outText, "utf8"); }
    catch (e) { errors.push(`${file}: write ${e.message}`); }
  }
}

const rel = (p) => path.relative(ROOT, p);
console.log(`模式: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`含文件索引的 README 总数: ${alreadyTop.length + moved.length + skippedNoSentinel.length}`);
console.log(`已置顶(跳过): ${alreadyTop.length}`);
console.log(`将移动/已移动: ${moved.length}`);
if (skippedNoSentinel.length) {
  console.log(`\n跳过(缺 end 哨兵，需先 normalize/refresh) ${skippedNoSentinel.length}:`);
  skippedNoSentinel.forEach((p) => console.log("  " + rel(p)));
}
if (moved.length) {
  console.log(`\n${APPLY ? "已移动" : "待移动"}文件:`);
  moved.forEach((p) => console.log("  " + rel(p)));
}
if (errors.length) { console.log(`\n错误 ${errors.length}:`); errors.forEach((e) => console.log("  " + e)); }
