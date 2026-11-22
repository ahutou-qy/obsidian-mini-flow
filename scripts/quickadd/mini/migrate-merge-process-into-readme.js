// Mini Flow - 一次性迁移：process/*.md 合到 README ## 过程 段
//
// 整体合并任务目录结构改造的第二阶段。本脚本读每个任务 README，把 process/*.md
// 全文 + 原 ## 背景 + 原 ## 别重蹈 内容并到新 ## 过程 段，删 process/*.md，删 ## AI 上下文
// 段，替换所有 process/ 路径引用（旧 `[[x/process/Y]]` → `[[x/README#过程-Y]]`）。
//
// 跨任务链接同步改：扫 vault 内全部 .md 替换 `[[<任务>/process/X|Y]]` → `[[<任务>/README#过程-X|Y]]`，
// 跨任务 `obsidian:.../process/...` 同理。rule 文档（flow/data/domains/）一并改。
//
// 用法：
//   node migrate-merge-process-into-readme.js                      # dry-run 模式
//   node migrate-merge-process-into-readme.js --apply              # 写文件
//   node migrate-merge-process-into-readme.js --apply --task <名>  # 单任务
//   node migrate-merge-process-into-readme.js --apply --skip-cross-links
//
// 参考：migrate-folder-kind.js (414 行, dry-run/apply, 纯 node fs) + normalize-historical-tasks.js
// 三段式分桶模式。
//
// 边界：
// - 单任务失败 → stderr 记录继续（不中断整批）
// - 跨任务链接目标已迁移过 → 直接替换
// - README 已含 `## 过程` → 跳过过程段插入，但仍做链接替换
// - README 含 `## AI 上下文` → 整段删除并打 INFO 日志
// - 留 process/ 目录里非 md 文件（脚本/JSON/XML/CSV/PY/LOG 等 artifact）

const fs = require("fs");
const path = require("path");

const { resolveVaultRoot } = require("./_vault-root.js");
const VAULT_ROOT = resolveVaultRoot(); // 挂载后 __dirname 上溯推不出 vault 根
const DATA_ROOT = path.join(VAULT_ROOT, "flow/data");
const APPLY = process.argv.includes("--apply");
const SKIP_CROSS_LINKS = process.argv.includes("--skip-cross-links");
const ONLY_TASK = (() => {
  const idx = process.argv.indexOf("--task");
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ---------- Frontmatter ----------
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/m;

function extractFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { raw: "", body: content };
  return { raw: m[1], body: content.slice(m[0].length) };
}

// ---------- 任务扫描 ----------
function isTaskReadme(p) {
  return /flow\/data\/\d{4}\/Q[1-4]\/(0[1-9]|1[0-2])\/[^/]+\/README\.md$/.test(p.replace(/\\/g, "/"));
}

function findTaskReadmes() {
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (!st.isDirectory()) continue;
      if (/^\d{4}$/.test(name)) {
        for (const q of fs.readdirSync(p)) {
          if (!/^Q[1-4]$/.test(q)) continue;
          const qp = path.join(p, q);
          if (!fs.statSync(qp).isDirectory()) continue;
          for (const m of fs.readdirSync(qp)) {
            if (!/^(0[1-9]|1[0-2])$/.test(m)) continue;
            const mp = path.join(qp, m);
            if (!fs.statSync(mp).isDirectory()) continue;
            walk(mp);
          }
        }
      } else {
        walk(p);
      }
    }
  }
  function pickReadmes(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (name.startsWith("W") && /^W\d/.test(name)) continue;  // 周记目录不是任务
        const readme = path.join(p, "README.md");
        if (fs.existsSync(readme) && isTaskReadme(readme)) out.push(readme);
        pickReadmes(p);
      }
    }
  }
  walk(DATA_ROOT);
  pickReadmes(DATA_ROOT);
  return [...new Set(out)].sort();
}

// ---------- 段操作 ----------
function extractSection(body, sectionName) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${sectionName}`);
  if (start === -1) return { start: -1, end: -1, body: "" };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return { start, end, body: lines.slice(start + 1, end).join("\n") };
}

function removeSections(body, names) {
  let lines = body.split(/\r?\n/);
  // 从下往上删，索引不漂
  const ranges = names
    .map((n) => extractSection(body, n))
    .filter((r) => r.start !== -1)
    .sort((a, b) => b.start - a.start);
  for (const r of ranges) {
    lines.splice(r.start, r.end - r.start);
    // 删段后紧跟的连续空行，避免留空隙
    while (lines[r.start] === "") lines.splice(r.start, 1);
  }
  return lines.join("\n");
}

function insertAfterHeader(body, afterHeader, newSection) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${afterHeader}`);
  if (start === -1) {
    return body.trimEnd() + "\n\n" + newSection + "\n";
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const before = lines.slice(0, end).join("\n").replace(/\s*$/, "\n\n");
  const after = lines.slice(end).join("\n").replace(/^\s+/, "");
  return before + newSection + "\n\n" + after;
}

// ---------- process 文件排序 + slug ----------
function processFileSortKey(name) {
  const m = name.match(/^(\d+)-/);
  return m ? Number(m[1]) : 999;
}

// 文件名 → H3 显示文本（去 .md、去 NN- 前缀）
function processFileDisplay(fileBase) {
  return fileBase.replace(/^\d+-/, "").replace(/\.md$/, "");
}

// 文件名 → slug（用于 anchor 后缀）
// 提取尾部的 role word（调研/设计/联调/测试/交付/复盘/分析/方案/总结/记录/缺陷）
// 退化到整个 base 名
function fileBaseSlug(fileBase) {
  const tail = processFileDisplay(fileBase);
  const role = tail.match(/(调研|设计|联调|测试|交付|复盘|分析|方案|总结|记录|缺陷|验证|评估|可行性|本地自测|架构|踩坑|部署)/);
  if (role) return role[1];
  return tail.slice(-20) || "file";
}

// heading 升级：H1 跳过（已 drop），H2 → H3, H3 → H4 ...
function promoteHeadings(text) {
  return text.replace(/^(#{1,5})\s/gm, (m, hashes) => "#".repeat(hashes.length + 1) + " ");
}

function dropFirstH1(text) {
  const lines = text.split(/\r?\n/);
  let dropped = false;
  return lines.filter((l) => {
    if (!dropped && /^#\s/.test(l)) { dropped = true; return false; }
    return true;
  }).join("\n");
}

// anchor 撞名处理：H3/H4/H5 同名从第二个文件起前置 slug
function resolveAnchorCollisions(sections) {
  const counts = new Map();
  for (const sec of sections) {
    for (const m of sec.content.matchAll(/^(#{2,5})\s+(.+?)\s*$/gm)) {
      counts.set(m[2].trim(), (counts.get(m[2].trim()) || 0) + 1);
    }
  }
  const dupes = new Set([...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k));
  if (dupes.size === 0) return sections;
  const seen = new Map();
  return sections.map((sec) => {
    let out = sec.content;
    out = out.replace(/^(#{2,5})\s+(.+?)\s*$/gm, (m, hashes, text) => {
      const heading = text.trim();
      if (!dupes.has(heading)) return m;
      const n = (seen.get(heading) || 0) + 1;
      seen.set(heading, n);
      if (n === 1) return m;
      return `${hashes} ${sec.slug}-${heading}`;
    });
    return { ...sec, content: out };
  });
}

// ---------- 单任务处理 ----------
function migrateTask(readmePath) {
  const taskDir = path.dirname(readmePath);
  const taskName = path.basename(taskDir);
  const readmeContent = fs.readFileSync(readmePath, "utf8");
  const { raw: fmRaw, body } = extractFrontmatter(readmeContent);

  // 提取原段
  const beiJingSec = extractSection(body, "背景");
  const muBiaoSec = extractSection(body, "目标");
  const bieZhongDaoSec = extractSection(body, "别重蹈");
  const aiSec = extractSection(body, "AI 上下文");
  const noteSec = extractSection(body, "过程");

  // 读 process/*.md
  const processDir = path.join(taskDir, "process");
  const processFiles = fs.existsSync(processDir)
    ? fs.readdirSync(processDir).filter((n) => n.endsWith(".md")).sort((a, b) => processFileSortKey(a) - processFileSortKey(b))
    : [];

  // 过程段内容
  const noteParts = [];

  // 1) 背景内容（无 heading）
  if (beiJingSec.body && beiJingSec.body.trim() && !noteSec.body) {
    noteParts.push(beiJingSec.body.trim());
    noteParts.push("");
  }

  // 2) 每个 process 文件 = H3 子段
  const sections = [];
  for (const fileName of processFiles) {
    const fileBase = fileName.replace(/\.md$/, "");
    const display = processFileDisplay(fileBase);
    const slug = fileBaseSlug(fileBase);
    let content = fs.readFileSync(path.join(processDir, fileName), "utf8");
    content = dropFirstH1(content);
    content = promoteHeadings(content);
    sections.push({ slug, displayName: display, content });
  }
  const sectionsResolved = resolveAnchorCollisions(sections);
  for (const sec of sectionsResolved) {
    noteParts.push(`### ${sec.displayName}`);
    noteParts.push("");
    noteParts.push(sec.content.trim());
    noteParts.push("");
  }

  // 3) 别重蹈
  if (bieZhongDaoSec.body && bieZhongDaoSec.body.trim() && !noteSec.body) {
    noteParts.push("### 别重蹈");
    noteParts.push("");
    noteParts.push(bieZhongDaoSec.body.trim());
    noteParts.push("");
  }

  const newNoteSection = "## 过程\n\n" + (noteParts.length > 0
    ? noteParts.join("\n").replace(/\n{3,}/g, "\n\n")
    : "> （待补充：调研/设计/联调/测试/交付/复盘 narrative）");

  // 删除原段（背景、目标、别重蹈、AI 上下文）
  let newBody = removeSections(body, ["AI 上下文", "别重蹈", "目标", "背景"]);

  // 替换 README 内的 process/ 引用（无论是否有过程段，都做）
  newBody = replaceProcessRefsInReadme(newBody, taskName);

  // 插入新 ## 过程 段（已有 ## 过程 段则跳过插入，避免重复）
  if (!noteSec.body) {
    newBody = insertAfterHeader(newBody, "进展", newNoteSection);
  }

  return {
    taskName,
    readmePath,
    processFiles,
    oldReadmeLen: readmeContent.length,
    newBody,
    fmRaw,
    newBodyLen: newBody.length,
    noteSectionLen: newNoteSection.length,
    hasAiContext: aiSec.body.length > 0,
    hasExistingNote: noteSec.body.length > 0,
    droppedSections: {
      "AI 上下文": aiSec.body.length,
      "别重蹈": bieZhongDaoSec.body.length,
      "目标": muBiaoSec.body.length,
      "背景": beiJingSec.body.length,
    },
  };
}

// ---------- 替换 README 内的 process/ 引用 ----------
// 改 `[[.../process/X|Y]]` → `[[.../README#过程-X|Y]]`
// 改 `[[.../process/X]]` → `[[.../README#过程-X]]`
// 改 `obsidian:.../process/X.md` → `obsidian:.../README#过程-X`
// 改 `obsidian:process/X.md`（vault-relative）→ `obsidian:../README#过程-X`
// 改 `obsidian:.../process/X.md::Y` → `obsidian:.../README#过程-X-Y`
function replaceProcessRefsInReadme(body, taskName) {
  // 1) obsidian URI 含 process/（带/不带 .md，带/不带 ::heading）
  body = body.replace(/obsidian:((?:\.\.\/)*[^"\s)]*?\/)?process\/([\w一-龥.\-_]+?)(\.md)?(::\S+?)?(?=[\s)"',;]|$)/g,
    (m, prefix, file, ext, anchor) => {
      const base = file.replace(/\.md$/, "");
      const headPart = anchor ? `-${anchor.slice(2)}` : "";
      const prefixPart = prefix || "../";
      return `obsidian:${prefixPart}README#过程-${base}${headPart}`;
    });

  // 2) wiki 链接 [[.../process/X|Y]] 或 [[.../process/X]]
  body = body.replace(/\[\[([^\]\/]+)\/process\/([\w一-龥.\-_]+?)(\|([^\]]+))?\]\]/g,
    (m, tName, file, _alias, alias) => {
      return `[[${tName}/README#过程-${file}${alias ? "|" + alias : ""}]]`;
    });

  return body;
}

// ---------- 跨任务 wiki link + obsidian URI 迁移 ----------
function replaceCrossTaskLinks(content) {
  let changed = false;
  // 1) obsidian URI
  let out = content.replace(/obsidian:((?:\.\.\/)*[^"\s)]*?\/)?process\/([\w一-龥.\-_]+?)(\.md)?(::\S+?)?(?=[\s)"',;]|$)/g,
    (m, prefix, file, ext, anchor) => {
      changed = true;
      const base = file.replace(/\.md$/, "");
      const headPart = anchor ? `-${anchor.slice(2)}` : "";
      const prefixPart = prefix || "../";
      return `obsidian:${prefixPart}README#过程-${base}${headPart}`;
    });
  // 2) wiki 链接
  out = out.replace(/\[\[([^\]\/]+)\/process\/([\w一-龥.\-_]+?)(\|([^\]]+))?\]\]/g,
    (m, tName, file, _alias, alias) => {
      changed = true;
      return `[[${tName}/README#过程-${file}${alias ? "|" + alias : ""}]]`;
    });
  return { text: out, changed };
}

function migrateCrossTaskLinks() {
  const results = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".git" || name === ".obsidian" || name === ".trash") continue;
        walk(p);
      } else if (st.isFile() && name.endsWith(".md")) {
        let content;
        try { content = fs.readFileSync(p, "utf8"); } catch { continue; }
        const { text, changed } = replaceCrossTaskLinks(content);
        if (changed) {
          results.push({ path: p, oldLen: content.length, newLen: text.length });
          if (APPLY) fs.writeFileSync(p, text);
        }
      }
    }
  }
  walk(VAULT_ROOT);
  return results;
}

// ---------- main ----------
function main() {
  console.log(`# 迁移 ${APPLY ? "APPLY" : "DRY-RUN"} 模式\n`);
  console.log(`vault root: ${VAULT_ROOT}`);
  console.log(`ONLY_TASK: ${ONLY_TASK || "(all)"}`);
  console.log(`SKIP_CROSS_LINKS: ${SKIP_CROSS_LINKS}\n`);

  const allReadmes = findTaskReadmes();
  const targets = ONLY_TASK
    ? allReadmes.filter((p) => path.basename(path.dirname(p)) === ONLY_TASK)
    : allReadmes;

  console.log(`扫描到 ${allReadmes.length} 个任务 README${ONLY_TASK ? `，过滤到 ${targets.length} 个` : ""}\n`);

  const reportRows = [];
  for (const readmePath of targets) {
    try {
      const report = migrateTask(readmePath);
      reportRows.push(report);
    } catch (e) {
      console.error(`❌ ${path.relative(VAULT_ROOT, readmePath)}: ${e.message}`);
    }
  }

  // 打印每任务报告
  for (const r of reportRows) {
    const rel = path.relative(VAULT_ROOT, r.readmePath);
    console.log(`## ${r.taskName}`);
    console.log(`- README: ${rel}`);
    console.log(`- 旧长度: ${r.oldReadmeLen}B, 新 body 长度: ${r.newBodyLen}B（Δ ${r.newBodyLen - r.oldReadmeLen > 0 ? "+" : ""}${r.newBodyLen - r.oldReadmeLen}B）`);
    console.log(`- process/*.md: ${r.processFiles.length} 个${r.processFiles.length > 0 ? ` (${r.processFiles.slice(0, 5).join(", ")}${r.processFiles.length > 5 ? "..." : ""})` : ""}`);
    const dropStr = Object.entries(r.droppedSections).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}B`).join(", ") || "(无)";
    console.log(`- 删除段: ${dropStr}`);
    if (r.hasAiContext) console.log(`- ⚠️ 含 AI 上下文段，整段删除`);
    if (r.hasExistingNote) console.log(`- ⚠️ 已含 ## 过程 段，跳过过程段插入`);
    console.log();
  }

  if (!APPLY) {
    console.log(`\n# ${reportRows.length} 任务 dry-run 完成，加 --apply 才会写盘\n`);
    return;
  }

  // apply 模式：写 README + 删 process/*.md
  for (const r of reportRows) {
    const newContent = `---\n${r.fmRaw}\n---${r.newBody}`;
    fs.writeFileSync(r.readmePath, newContent);
    const processDir = path.join(path.dirname(r.readmePath), "process");
    for (const fileName of r.processFiles) {
      const p = path.join(processDir, fileName);
      try { fs.unlinkSync(p); } catch (e) { console.error(`删失败 ${p}: ${e.message}`); }
    }
  }
  console.log(`\n✅ ${reportRows.length} 任务 README 已更新，process/*.md 已删除\n`);

  // 跨任务 wiki 链接
  if (SKIP_CROSS_LINKS) {
    console.log(`--skip-cross-links，跳过跨任务 wiki 链接迁移\n`);
  } else {
    const crossResults = migrateCrossTaskLinks();
    console.log(`跨任务 wiki/obsidian 链接迁移: ${crossResults.length} 个文件被修改`);
    for (const c of crossResults.slice(0, 30)) {
      console.log(`  - ${path.relative(VAULT_ROOT, c.path)}`);
    }
    if (crossResults.length > 30) console.log(`  ... 等 ${crossResults.length - 30} 个`);
  }

  // 输出 git add 命令
  console.log(`\n# 接下来手动提交（按任务分批）：`);
  for (const r of reportRows) {
    console.log(`git add "${path.relative(VAULT_ROOT, r.readmePath)}"`);
  }
}

main();
