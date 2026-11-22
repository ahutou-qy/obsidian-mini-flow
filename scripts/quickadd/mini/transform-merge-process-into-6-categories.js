// Mini Flow - transform-merge-process-into-6-categories.js
//
// 一次性脚本：把已经迁移过的任务 README ## 过程 段按文件名软归类到 6 类 H3 子段
// （调研/设计/联调/测试/交付/复盘），未匹配的进 ## 杂项。空类不出现。背景段（无 heading）
// 保留在 ## 过程 顶部，别重蹈 H3 保留在末尾。
//
// Wrapper 识别：从 git history（最后一次删 process/*.md 的 commit）找回原文件名清单。
// 当前 ## 过程 段里的 H3 文本匹配文件 basename（去 NN- 前缀、去 .md）即为 wrapper。
//
// 用法：
//   node transform-merge-process-into-6-categories.js                 # dry-run
//   node transform-merge-process-into-6-categories.js --apply         # 写文件
//   node transform-merge-process-into-6-categories.js --apply --task <名>

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const VAULT_ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const ONLY_TASK = (() => {
  const idx = process.argv.indexOf("--task");
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

const ROLE_WORDS = /(调研|设计|联调|测试|交付|复盘|分析|方案|总结|记录|缺陷|验证|评估|可行性|本地自测|架构|踩坑|部署|攻略|答辩|清单|异议|申请书|起诉)/;
const CATEGORY_BY_WORD = {
  调研: "调研", 分析: "调研", 评估: "调研", 可行性: "调研",
  设计: "设计", 架构: "设计", 方案: "设计",
  联调: "联调", 部署: "联调", 缺陷: "联调", 踩坑: "联调",
  测试: "测试", 验证: "测试", 本地自测: "测试",
  交付: "交付", 申请书: "交付", 清单: "交付", 异议: "交付", 起诉: "交付", 答辩: "交付", 攻略: "交付",
  复盘: "复盘", 总结: "复盘", 记录: "复盘",
};
const CATEGORY_ORDER = ["调研", "设计", "联调", "测试", "交付", "复盘", "杂项"];

function classify(name) {
  const m = String(name).match(ROLE_WORDS);
  if (!m) return "杂项";
  return CATEGORY_BY_WORD[m[1]] || "杂项";
}

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
          for (const m of fs.readdirSync(path.join(p, q))) {
            if (!/^(0[1-9]|1[0-2])$/.test(m)) continue;
            const md = path.join(p, q, m);
            if (!fs.statSync(md).isDirectory()) continue;
            walk(md);
          }
        }
      } else {
        if (name.startsWith("W") && /^W\d/.test(name)) continue;
        const readme = path.join(p, "README.md");
        if (fs.existsSync(readme) && isTaskReadme(readme)) out.push(readme);
        walk(p);
      }
    }
  }
  walk(VAULT_ROOT);
  return [...new Set(out)].sort();
}

// 从 git history 找最后一次删 process/*.md 的 commit 并取文件 basenames
function getOriginalProcessFiles(taskReadmePath) {
  try {
    const taskDir = path.dirname(taskReadmePath);
    // -c core.quotepath=off 关闭中文路径加引号；split 按 \n\n 分 commit 块
    const log = execSync(
      `git -c core.quotepath=off log --diff-filter=D --name-only --pretty=format:"COMMIT_START" -- "${taskDir}/process/"`,
      { cwd: VAULT_ROOT, encoding: "utf8" }
    );
    if (!log.trim()) return [];
    const firstCommit = log.split("COMMIT_START").filter((s) => s.trim())[0];
    if (!firstCommit) return [];
    const files = firstCommit.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".md"));
    return files.map((f) => path.basename(f, ".md"));
  } catch (e) {
    return [];
  }
}

// wrapper H3 文本 = 文件 basename（去 NN- 前缀）
function isFileWrapper(h3Text, originalBasenames) {
  // 1) 去 NN- 前缀后完全匹配
  for (const base of originalBasenames) {
    const noPrefix = base.replace(/^\d+-/, "");
    if (noPrefix === h3Text) return true;
  }
  return false;
}

function transformProcess(content, originalBasenames) {
  const lines = content.split("\n");
  const procStart = lines.findIndex((l) => l.trim() === "## 过程");
  if (procStart === -1) return null;
  let procEnd = lines.length;
  for (let i = procStart + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { procEnd = i; break; }
  }

  const procLines = lines.slice(procStart + 1, procEnd);
  const before = lines.slice(0, procStart + 1);
  const after = lines.slice(procEnd);

  // 1) 切背景段（任何 H3 之前）
  let bgEnd = 0;
  for (let i = 0; i < procLines.length; i++) {
    if (/^###\s+/.test(procLines[i])) { bgEnd = i; break; }
  }
  const background = procLines.slice(0, bgEnd);

  // 2) 切 H3 sections（按 wrapper 边界分组）
  // 第一个 H3 一定是 wrapper（如果存在）
  // 之后每个 H3：如果是 wrapper 名（匹配 basename）→ 新 wrapper；否则 → 上一 wrapper 的内容
  const sections = [];
  let current = null;
  for (let i = bgEnd; i < procLines.length; i++) {
    const line = procLines[i];
    const h3Match = line.match(/^###\s+(.+?)\s*$/);
    if (h3Match) {
      const h3Text = h3Match[1].trim();
      if (current === null) {
        // 第一个 H3
        current = { name: h3Text, body: [] };
      } else if (isFileWrapper(h3Text, originalBasenames)) {
        // 新 wrapper
        sections.push(current);
        current = { name: h3Text, body: [] };
      } else {
        // 是上一 wrapper 的内容 H3（文件原 H2 promoted to H3）
        current.body.push(line);
      }
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);

  // 3) 分离 别重蹈
  const bieZhongDao = sections.find((s) => s.name === "别重蹈");
  const fileSections = sections.filter((s) => s.name !== "别重蹈");

  // 4) 归类
  const grouped = {};
  for (const cat of CATEGORY_ORDER) grouped[cat] = [];
  for (const sec of fileSections) {
    const cat = classify(sec.name);
    grouped[cat].push(sec);
  }

  // 5) 重组
  // 设计：
  //   ## 过程
  //   ### 调研            （category 标签，无 body）
  //   ### 调取证据申请书    （file wrapper, 保持 H3，body 是 H4+ 降一级）
  //   #### 申请书正文      （原 file H2 → 现在 H4）
  //   #### 致:杭州互联网法院
  //   ### 设计
  //   ### p541-driver-design
  //   ...
  //   ### 别重蹈           （与 category 同级，末尾）
  const newLines = [];
  if (background.some((l) => l.trim() !== "")) {
    newLines.push(...background);
    if (newLines[newLines.length - 1].trim() !== "") newLines.push("");
  }
  for (const cat of CATEGORY_ORDER) {
    const files = grouped[cat];
    if (files.length === 0) continue;
    newLines.push(`### ${cat}`);
    newLines.push("");
    for (const sec of files) {
      newLines.push(`### ${sec.name}`);
      newLines.push("");
      // body 内的 heading H2-H5 全部 +1 降级（H2→H3, H3→H4, H4→H5, H5→H6）
      // 正则捕获 #s（不含尾部空格），追加一个 # 即可
      const demotedBody = sec.body.map((l) => l.replace(/^(#{2,5})(\s)/, "#$1$2"));
      newLines.push(...demotedBody);
      if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") newLines.push("");
    }
    if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") newLines.push("");
  }
  if (bieZhongDao) {
    if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") newLines.push("");
    newLines.push("### 别重蹈");
    newLines.push("");
    newLines.push(...bieZhongDao.body);
  }

  // 6) 拼回 README：before 已含 "## 过程" 标题行，newProcBlock 只含正文
  const newProcBlock = ["", ...newLines].join("\n").replace(/\n{3,}/g, "\n\n");
  return [...before, newProcBlock, ...after].join("\n");
}

function main() {
  console.log(`# 6 类软归类 transform ${APPLY ? "APPLY" : "DRY-RUN"} 模式\n`);
  const targets = findTaskReadmes();
  const filtered = ONLY_TASK
    ? targets.filter((p) => path.basename(path.dirname(p)) === ONLY_TASK)
    : targets;
  console.log(`扫描到 ${targets.length} 个任务 README${ONLY_TASK ? `，过滤到 ${filtered.length} 个` : ""}\n`);

  const report = [];
  for (const p of filtered) {
    const content = fs.readFileSync(p, "utf8");
    if (!content.includes("## 过程")) continue;
    const basenames = getOriginalProcessFiles(p);
    if (basenames.length === 0) continue;  // 没原文件清单的（已无 process 目录历史）跳过
    const newContent = transformProcess(content, basenames);
    if (newContent === null) continue;
    const rel = path.relative(VAULT_ROOT, p);
    if (APPLY && newContent !== content) fs.writeFileSync(p, newContent);
    report.push({ rel, changed: newContent !== content, sizeDelta: newContent.length - content.length, basenames: basenames.length });
  }

  for (const r of report) {
    console.log(`${r.changed ? "✓" : "·"} ${r.rel}  (Δ ${r.sizeDelta > 0 ? "+" : ""}${r.sizeDelta}B, ${r.basenames} 文件)`);
  }
  console.log(`\n# ${report.filter((r) => r.changed).length}/${report.length} 任务已重组${APPLY ? "" : "（dry-run，加 --apply 写盘）"}`);
}

main();
