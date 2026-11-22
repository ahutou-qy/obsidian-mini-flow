// Mini Flow - Task Upgrade：把单文件任务升级为 folder 任务。
// <月目录>/<任务名>.md 会迁移为 <月目录>/<任务名>/README.md。
// 必须通过 FileManager 移动，让 Obsidian 同步更新指向源任务的链接。
//
// 兜底定位：新任务在 capture 时就选好形状（单文件 / 文件夹），正常流程不再走这里。
// 本命令只服务历史单文件任务，或误判为单文件、后来才需要 input/process/output/子任务的情况。

let cleanTitle, buildFileName, truncateSmart, MAX_FILENAME_LENGTH, maxFilenameLength, insertIndexSection, isInTaskTree, tasksDirForActiveFile, taskHelpers, loadWorkflow, yamlHelpers;

module.exports = async ({ app }) => {
  taskHelpers = await loadTaskHelpers(app);
  ({ cleanTitle, buildFileName, truncateSmart, MAX_FILENAME_LENGTH } = await loadNamingHelpers(app));
  // 文件名上限走配置（与建任务 / 改名**同源**）；读不到退回 _naming.js 的默认 30。
  // 不同源会让升级后的磁盘名与月度行别名对不上。
  const cfgMod = await loadConfigHelpers(app);
  const cfg = cfgMod && typeof cfgMod.loadFromAdapter === "function"
    ? await cfgMod.loadFromAdapter(app.vault.adapter)
    : null;
  maxFilenameLength = cfg && cfg.behavior && cfg.behavior.maxFilenameLength !== undefined
    ? cfg.behavior.maxFilenameLength
    : MAX_FILENAME_LENGTH;
  ({ insertIndexSection } = await loadIndexHelpers(app));
  ({ loadWorkflow } = await loadWorkflowHelpers(app));
  ({ isInTaskTree, tasksDirForActiveFile } = taskHelpers);
  yamlHelpers = await loadYamlHelpers(app);

  // 1) checkbox 入口：光标在 checkbox 行上 → 解析出任务名 → 找任务文件升级。
  //    从 idea 月度文件里也能一键升级。
  const fromCheckbox = resolveTaskFromCheckbox(app, taskHelpers);
  if (fromCheckbox) {
    if (!fromCheckbox.file) {
      new Notice(`未找到对应任务文件，无法升级：${fromCheckbox.title}`);
      return;
    }
    return await upgradeTaskFile(app, fromCheckbox.file);
  }

  // 2) 任务文件入口
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice("请先打开一个任务文件再触发 Task Upgrade");
    return;
  }
  if (!activeFile.path.endsWith(".md")) {
    new Notice("当前打开的不是 Markdown 任务文件");
    return;
  }
  if (isFolderTaskPath(activeFile.path)) {
    new Notice("当前任务已经是 folder 形式，无需再次升级");
    return;
  }
  const parentPath = activeFile.parent ? activeFile.parent.path : "";
  // 允许月目录任务树下任意深度的 type:task 升级：月目录根的散任务，或 folder 内的子任务。
  if (!isInTaskTree(parentPath)) {
    new Notice(`当前文件不在 flow/data/YYYY/Qn/MM 任务目录树中：${parentPath || "<根目录>"}`);
    return;
  }
  return await upgradeTaskFile(app, activeFile);
};

// 升级一个已确定的任务文件：truncate → frontmatter 校验 → alias 补全 → folder 化。
async function upgradeTaskFile(app, activeFile) {
  const vault = app.vault;
  const parentPath = activeFile.parent ? activeFile.parent.path : "";

  // ---------- basename 截断（升级前） ----------
  // 升级会沿用 activeFile.basename 作为 folder 名。如果上游是手工创建
  // 或历史迁移过来的超长文件名，folder 会跟着变长。这里先 rename 一次，
  // fileManager.renameFile 会同步全库 [[old]] → [[new]]，所以下游链接不破。
  if (activeFile.basename.length > maxFilenameLength) {
    const truncatedName = truncateSmart(activeFile.basename, maxFilenameLength);
    const targetPath = joinPath(parentPath, `${truncatedName}.md`);
    if (vault.getAbstractFileByPath(targetPath)) {
      new Notice(`截断目标已存在，无法先重命名：${targetPath}`);
      return;
    }
    const originalLen = activeFile.basename.length;
    try {
      // 先补别名：升级流程后面还会再补一次（此时名字还是旧的，alias 才能挂上），
      // 这样 rename 后链接既指向新文件，又保留原文显示。
      await addTaskNameAliasesToBacklinks(app, activeFile, activeFile.basename);
      await app.fileManager.renameFile(activeFile, targetPath);
      const renamed = vault.getAbstractFileByPath(targetPath);
      if (!renamed) {
        new Notice(`重命名失败，请检查：${targetPath}`);
        return;
      }
      activeFile = renamed;
      new Notice(`basename 已截断：${truncatedName}（原长 ${originalLen} 字 → ${activeFile.basename.length} 字）`);
    } catch (error) {
      console.error("Task Upgrade pre-truncate rename failed", error);
      new Notice("升级前截断失败，已中止");
      return;
    }
  }

  const oldContent = await vault.cachedRead(activeFile);
  const frontmatterType = parseFrontmatterType(oldContent);
  if (frontmatterType !== "task") {
    new Notice(`当前文件 type 为 ${frontmatterType || "<none>"}，Task Upgrade 只处理 type: task`);
    return;
  }

  if (!app.fileManager || typeof app.fileManager.renameFile !== "function") {
    new Notice("当前 Obsidian FileManager 不可用，无法在升级时安全更新任务链接");
    return;
  }

  const taskName = activeFile.basename;
  const folderPath = joinPath(parentPath, taskName);
  const targetPath = joinPath(folderPath, "README.md");
  if (vault.getAbstractFileByPath(folderPath) || vault.getAbstractFileByPath(targetPath)) {
    new Notice(`同名任务目录已存在：${folderPath}`);
    return;
  }

  const hasEmbeds = /!\[\[/.test(oldContent);
  const upgradedAt = window.moment().format("YYYY-MM-DD");

  let renameSucceeded = false;
  let cleanupWarning = "";
  try {
    await addTaskNameAliasesToBacklinks(app, activeFile, taskName);
  } catch (error) {
    console.error("Task Upgrade backlink preparation failed", error);
    new Notice("无法为现有任务链接补充显示名称，本次升级未执行");
    return;
  }

  // 每个写盘步骤带 step 标签：iCloud vault 上 createFolder/create 偶发
  // "File already exists"（cache/文件系统同步时序），透传 step 才能定位是哪一步撞、
  // 撞什么，不再只弹一句"执行失败"让用户去开 DevTools。
  try {
    await step("创建任务目录", () => vault.createFolder(folderPath));
    await step("创建 input 目录", () => vault.createFolder(joinPath(folderPath, "input")));
    await step("创建 process 目录", () => vault.createFolder(joinPath(folderPath, "process")));
    await step("创建 output 目录", () => vault.createFolder(joinPath(folderPath, "output")));
    // task-upgrade 刚建了三个空目录，自己拼初始索引最稳——不依赖 walk 扫 vault。
    // 原因：曾经观察到 createFolder 之后立即 getAbstractFileByPath 拿到的 TFolder.children
    // 不是新 folder 的 children（vault cache 时序问题），walk 会输出 [[../XXX/README]]
    // 这种越界路径。task-refresh-index 是手动触发，时序有保证，仍用 walk 没问题。
    //
    // 不列根 README：它就是承载索引的文件自身，自链接没导航价值（规则见 _walk.js buildIndexBody）。
    const initialIndexBody = [
      "- **input/**",
      "- **process/** (仅 artifact)",
      "- **output/**",
    ].join("\n");
    // review 注入由域配置驱动：从 frontmatter tags 取 domain/<slug>，该域 flow.json
    // 声明了 review.checklist 才注入对应清单段；删掉旧的 work7 路径正则硬编码。
    const reviewChecklist = await resolveReviewChecklist(vault, oldContent, loadWorkflow);
    const upgradedContent = promoteToFolderTask(oldContent, upgradedAt, initialIndexBody, taskHelpers, reviewChecklist, yamlHelpers);
    await step("改写任务内容（frontmatter/索引段）", () => vault.modify(activeFile, upgradedContent));
    await step("移动为 folder/README.md", () => app.fileManager.renameFile(activeFile, targetPath));
    renameSucceeded = true;
  } catch (error) {
    const sourceFile = vault.getAbstractFileByPath(activeFile.path);
    if (sourceFile && sourceFile.path === activeFile.path) {
      try {
        await vault.modify(sourceFile, oldContent);
      } catch (_) {
        // 保留原异常；Notice 会提示用户检查源文件。
      }
    }
    // rename 没成功就说明本次建的 folder 还没承载真正的 README；把整棵新建目录树
    // 递归删掉，避免留下 input/process/output 空壳导致下次升级/capture 撞"缺少 README"。
    // rename 成功则 README 已就位，不能删。
    cleanupWarning = await cleanupCreatedFolder(vault, folderPath, renameSucceeded);
    console.error("Task Upgrade failed", error);
    new Notice(
      `Task Upgrade 失败：${error.message}` +
        (cleanupWarning ? `\n${cleanupWarning}` : "\n已尽量回滚；请检查源文件和目标目录"),
    );
    return;
  }

  // FileManager.renameFile 已自动把当前 leaf 切到新 README，再 openLinkText 会重复触发 leaf 激活/重载。

  const embedWarning = hasEmbeds ? "；检测到 ![[...]]，请检查相对附件链接" : "";
  new Notice(`已升级为 ${targetPath}${embedWarning}`);
}

// README basename 无法表达任务名；先给无别名双链补上任务名，再交给 FileManager 改路径。
async function addTaskNameAliasesToBacklinks(app, activeFile, taskName) {
  const vault = app.vault;
  const metadataCache = app.metadataCache;
  if (!metadataCache || typeof metadataCache.getFirstLinkpathDest !== "function") {
    throw new Error("MetadataCache.getFirstLinkpathDest is unavailable");
  }
  if (typeof vault.getMarkdownFiles !== "function") {
    throw new Error("Vault.getMarkdownFiles is unavailable");
  }

  for (const file of vault.getMarkdownFiles()) {
    if (file.path === activeFile.path) continue;
    const content = await vault.cachedRead(file);
    const rewritten = content.replace(/(!?)\[\[([^\]]+)\]\]/g, (full, embed, inner) => {
      if (embed || inner.includes("|")) return full;
      const linkpath = inner.split("#", 1)[0].trim();
      if (!linkpath) return full;
      const destination = metadataCache.getFirstLinkpathDest(linkpath, file.path);
      if (!destination || destination.path !== activeFile.path) return full;
      return `[[${inner}|${taskName}]]`;
    });
    if (rewritten !== content) await vault.modify(file, rewritten);
  }
}

// checkbox 入口解析约定：cleanTitle 剥 [[alias]] 和 #tag，
// buildFileName 再走一次文件系统清洗；标题就是磁盘文件名。
function parseTaskLine(line) {
  const match = String(line).match(/^\s*- \[[ xXoO\/>-]\]\s*(.*)$/);
  return match ? { body: match[1] } : null;
}

function resolveTaskFromCheckbox(app, taskHelpers) {
  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  if (!editor) return null;
  const cursor = editor.getCursor();
  const parsed = parseTaskLine(editor.getLine(cursor.line));
  if (!parsed) return null;
  const title = buildFileName(parsed.body, maxFilenameLength);
  if (!title) return null;
  const activeFile = app.workspace.getActiveFile();
  const tasksDir = taskHelpers.tasksDirForActiveFile(activeFile);
  const file = findTaskFile(app.vault, tasksDir, title);
  return { title, file };
}

// 单文件任务 <name>.md 优先，其次 folder 任务 <name>/README.md；
// 返回 TFile 或 null；folder 升级时只用 README.basename，不展开 folder。
function findTaskFile(vault, tasksPath, title) {
  const simple = vault.getAbstractFileByPath(`${tasksPath}/${title}.md`);
  if (simple) return simple;
  const readme = vault.getAbstractFileByPath(`${tasksPath}/${title}/README.md`);
  return readme || null;
}

// 已是 folder 形态：任意深度的 README，或遗留的 <名>/<名>.md。
function isFolderTaskPath(path) {
  const value = String(path);
  if (/README\.md$/.test(value) && isInTaskTree(value)) return true;
  const legacy = value.match(/\/([^/]+)\/([^/]+)\.md$/);
  return Boolean(legacy && legacy[1] === legacy[2] && isInTaskTree(value));
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function parseFrontmatterType(content) {
  const match = matchFrontmatter(content);
  if (!match) return null;
  const typeLine = match[1].split(/\r?\n/).find(line => /^[ \t]*type[ \t]*:/.test(line));
  if (!typeLine) return null;
  const value = typeLine
    .replace(/^[ \t]*type[ \t]*:[ \t]*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
  return value ? value.toLowerCase() : null;
}

function promoteToFolderTask(content, upgradedAt, initialIndexBody, taskHelpers, reviewChecklist, yamlHelpers) {
  const match = matchFrontmatter(content);
  if (!match) return content;

  let frontmatter = match[1].replace(/^([ \t]*type[ \t]*:[ \t]*).*$/m, (_, prefix) => `${prefix}task-folder`);
  // upgraded_at 字段 2026-11-16 删除（无读者；升级发生的事实已由 manual 里程碑承载）。

  const body = String(content).slice(match[0].length);

  // 旧 ## 时间轴 段（行格式 "- YYYY-MM-DD | ..."）→ milestones 灌入 frontmatter；
  // 旧段无/空/不存在 → 一条 manual 标记本次升级发生过，不冒充任务创建时间。
  // 合并策略：旧段 list + frontmatter 已存 list，按 {date, type} 幂等去重（addMilestone 同款）。
  const fromSection = extractTimelineMilestones(body, upgradedAt);
  const cleanBody = removeTimelineSection(body);
  const existing = yamlHelpers.getMilestones(frontmatter);
  const merged = mergeMilestones(fromSection, existing);
  if (merged.length) frontmatter = yamlHelpers.setMilestones(frontmatter, merged);

  const withReview = reviewChecklist ? injectReviewSection(cleanBody, reviewChecklist) : cleanBody;
  return `---\n${frontmatter}\n---${insertIndexSection(withReview, initialIndexBody)}`;
}

// 解析旧 ## 时间轴 段行为 milestones。旧段无/无匹配行 → 一条 manual 占位。
// 不强行翻译"- 创建 | xxx"等关键字为 create/finish：单文件任务历史段里"创建"未必是任务创建日，
// 翻译会失真；保留原行文本到 note，type 一律 manual（决策 4 枚举）。
function extractTimelineMilestones(body, upgradedAt) {
  const section = matchTimelineSection(body);
  const placeholder = [{ date: upgradedAt, type: 'manual', note: '从单文件升级为 folder 任务' }];
  if (!section) return placeholder;
  const milestones = [];
  for (const line of section.body.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s*$/);
    if (m) milestones.push({ date: m[1], type: 'manual', note: m[2] });
  }
  return milestones.length ? milestones : placeholder;
}

// 找 ## 时间轴 段；返回 {header, body} 或 null。段范围：从 `## 时间轴` 行到下一个 `## ` 段或文末。
// JS regex 没有 \Z 锚点（m flag 下 \$ 匹配行界，会在 `## 时间轴` 自己行末就满足导致空抓），
// 用 \$(?![\s\S]) 表达"真·文末"。
function matchTimelineSection(body) {
  const m = body.match(/^##[ \t]+时间轴[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]+|\$(?![\s\S]))/m);
  if (!m) return null;
  return { header: '## 时间轴', body: m[1] || '' };
}

// 删 ## 时间轴 段及其紧跟的连续空行，保留其它段。幂等：旧段无原样返回。
// 按 matchTimelineSection 拿到的 (start, end) 区间做切片，删段+尾部空行；
// 不再独立维护一份 regex，避免和 matchTimelineSection 的段边界漂移。
function removeTimelineSection(body) {
  const headerRe = /^##[ \t]+时间轴[ \t]*$/m;
  const headerMatch = body.match(headerRe);
  if (!headerMatch) return body;
  const headerEnd = headerMatch.index + headerMatch[0].length;
  const rest = body.slice(headerEnd);
  const nextHeader = rest.match(/^##[ \t]+/m);
  const sectionEnd = headerEnd + (nextHeader ? nextHeader.index : rest.length);
  // 段末尾的连续空行（\n+）也一起吞掉，避免和下一段之间留空隙
  const trailing = body.slice(sectionEnd).match(/^\r?\n+/);
  const cutEnd = sectionEnd + (trailing ? trailing[0].length : 0);
  return body.slice(0, headerMatch.index) + body.slice(cutEnd);
}

// 旧段 list + 已存 list，按 {date, type} 幂等合并：同键升级 note（addMilestone 同款语义）。
// 旧段在前保持历史时序；frontmatter 已存（人写）补在后面；同 date+type 只留一条最新 note。
function mergeMilestones(fromSection, existing) {
  const result = [...fromSection];
  for (const m of existing) {
    const hit = result.find((x) => x.date === m.date && x.type === m.type);
    if (hit) {
      if (hit.note !== (m.note || '')) hit.note = m.note || '';
    } else {
      result.push(m);
    }
  }
  return result;
}

// 取任务 frontmatter 的领域 slug：`domain:` 标量优先（2026-11-16 起 capture 与 qy 物化
// 都只写标量），取不到再退回旧的 `domain/<slug>` tag（历史单文件任务、老 README）。
// 返回 slug 或 null。
function parseDomain(content) {
  const match = matchFrontmatter(content);
  if (!match) return null;
  const scalar = match[1].match(/^[ \t]*domain[ \t]*:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/m);
  if (scalar) return scalar[1];
  const m = match[1].match(/domain\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// 读该域 flow.json，返回 review.checklist（声明了才注入），否则 null。
// loadWorkflow 要求有非空 stages，因此无 workflow 的纯规则域自然不注入。
async function resolveReviewChecklist(vault, content, loadWorkflow) {
  const domain = parseDomain(content);
  if (!domain) return null;
  const wf = await loadWorkflow(vault, domain);
  const checklist = wf && wf.review && wf.review.checklist;
  return checklist ? String(checklist) : null;
}

// 注入精简的合入前 review 勾选段，完整版链到该域 flow.json 声明的 checklist。
// 四条是跨代码域通用的"读得懂/现场安全/并发锁/兜得住"；域专属硬规则（如 work7 的
// StringUtl/六套 sql-back）放 checklist 文件，不写死在注入段。幂等：已含此段原样返回。
// 位置：正文末（`## 文件索引` 已置顶为导航段，review 是 body 内容，不压在索引之上）。
function injectReviewSection(body, checklist) {
  if (/^##[ \t]+合入前 Review/m.test(body)) return body;
  const section = [
    "## 合入前 Review（代码）",
    `> AI 产出的代码合入前过一遍。完整清单见 [[${checklist}]]，下面是必过核心项。`,
    "> 非代码任务可直接删本段。",
    "",
    "- [ ] 读得懂：合上 AI 能讲清状态流转，魔法值说得出来源",
    "- [ ] 现场安全：寄存器/字节序/报文校验对得上手册，超时重试有界，通信线程不阻塞，仿真/现场冒烟过",
    "- [ ] 并发锁：集群用 Redisson 不用 synchronized，异常路径释放，无先查后改竞态",
    "- [ ] 兜得住：知道从哪看日志定位、怎么回滚，AI 不在线也能改",
    "",
  ].join("\n");

  return `${body.replace(/\s*$/, "")}\n\n${section}`;
}


// AI 上下文段已于 2026-08-20 下线，injectAiContextSection 函数整体删除。

function matchFrontmatter(content) {
  return String(content).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/);
}

// 给单个写盘动作打步骤标签：失败时错误带上"正在做什么"，catch 才能透传给用户。
async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `${label}：${error.message || error}`;
    throw error;
  }
}

// 升级失败时清理本次新建的 folder。rename 成功则 README 已就位，绝不删。
// rename 没成功：folderPath 是本次 createFolder 新建的（前置冲突检查保证之前不存在），
// 里面的 input/process/output/INDEX.md 也都是我们建的，整棵递归删掉，不留空壳。
// 防御：若目标 README 已存在（不应发生），不动目录，避免误删真实内容。
// iCloud 上 vault.delete 偶发失败（文件系统同步时序），不静默吞：返回残留提示，
// 让 Notice 提醒用户手动删，否则空壳会导致下次升级撞"同名目录已存在"。
async function cleanupCreatedFolder(vault, folderPath, renameSucceeded) {
  if (renameSucceeded) return "";
  const folder = vault.getAbstractFileByPath(folderPath);
  if (!folder || !folder.children) return "";
  const readme = vault.getAbstractFileByPath(joinPath(folderPath, "README.md"));
  if (readme) return ""; // README 在，说明内容已落地，不删
  try {
    await vault.delete(folder, true);
    return "";
  } catch (error) {
    console.error("Task Upgrade cleanup failed", error);
    return `回滚时删除残留目录失败：${folderPath}（可能是 iCloud 同步中），请手动删除后再升级`;
  }
}

// QuickAdd 的 script 上下文里 window.require 不能解析相对路径；
// 把 _naming.js 当字符串读进来，用 Function 构造一个临时 module 取 exports。
// 源文件仍然是唯一一份（flow/scripts/quickadd/mini/_naming.js），
// 5 个脚本共用，加新 helper 只改那一处即可。
async function loadNamingHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_naming.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _config.js：behavior.maxFilenameLength 等配置项的唯一读取入口。
// 本文件（以及所有被字符串加载的脚本）不能 require 同目录文件，只能走 adapter。
async function loadConfigHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_config.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _index.js：索引段写入逻辑，与 miniflow 插件、task-refresh-index 共用。
async function loadIndexHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_index.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _task.js：共享的 INPUTS_INDEX_TEMPLATE 已下线。
async function loadTaskHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_task.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _workflow.js：用 loadWorkflow 读域 flow.json 的 review 配置，替代旧的
// work7 路径正则硬编码。
async function loadWorkflowHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_workflow.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 同模式加载 _yaml.js：frontmatter 读写与 milestones 数组操作。
// 升级路径要灌历史里程碑，setMilestones / getMilestones 在这里。
async function loadYamlHelpers(app) {
  const src = await app.vault.adapter.read("flow/scripts/quickadd/mini/_yaml.js");
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
