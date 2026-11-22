// ==============================================
// Mini Flow - Task Finish：推进任务状态机。
//
// 状态两态：#active（活跃）→ #finish（完成，写 [completion:: 日期]）。
// archive 档于 2026-08-19 从数据模型中删除（status.js#STATUSES 字典已收窄），
// 两段式「活跃 → 归档 → 完成」压成一段式「活跃 → 完成」。
// - 在月度 Capture 行上执行、或打开任务 README 执行（沿 source 锚点定位月度行）。
// - 活跃 → 完成：月度行 #active/#无状态 改 #finish，补 [completion:: 今天]，
//   README frontmatter milestones 追加 type=finish 一条，完成后关闭打开的 README tab；
//   被关掉的 README 正是当前活动页时再回 Home 首页（落点规则见 closeReadmeLeaf）。
// - 已完成（#finish）只关 README（如果开着），状态机不动；提示用 Task Edit 重开
//   （task-edit 的状态 chip 可把 finish 改回 active）。
// - 老 checkbox Capture 行：未勾选视为活跃→完成（去 checkbox 变勾选、改 #finish、补 completion）。
//
// 任务状态以 Obsidian 为唯一真相，milestones 数组只追加不回写。
//
// README 收口（task-finish README 收口段，flow/CLAUDE.md）：
// task-finish 推进到 #finish 前仅做一道收口：`## 进展` 段 bullet > 5 则把最早 N 条
// 移到 process/R-进展历史.md（H3 追加）。`## 结果` 段原是完成态硬卡点（强制填三段
// 交付/验收/变更），2026-09-17 取消——soft-warning 不强制、用户自觉写。
//
// 交付证据软闸（2026-11-20）：交付任务结案时若 `### 设计` / `### 自测` 段还是模板骨架
// 出提示、**不拦**。判据与文案单源在 `_finish.js`（三个 finish 入口共用），本文件只决定
// 提示挂哪——有 confirm 并进确认框，headless 发 Notice（见 runFinish 里的 evidence 段）。
//
// 盘面动作（进度推进目标、月度行改写、进展归档）在 `_finish.js`：miniflow
// 消费 `flow/qy-merge-inbox.json` 时走同一套，两处不许各写一份。
// ==============================================

// 默认入口：QuickAdd 宏 Task Finish 走它。人机交互全在这一层注入——
// window.confirm 二次确认 + 完成后关 README leaf（要不要回 Home 由 closeReadmeLeaf 定）。
// 界面文案查表（阶段 3）。**模块级 `_t`**：入口 load 一次后赋值；未赋值时恒等返回原文。
// 与 task-capture / task-edit / _ui.js / rule-* 同款——避开「局部 const 取不到模块级
// class 里的调用」那个坑（批次 2 实测）。
let _t = (key, fallback) => (fallback === undefined ? key : fallback);

module.exports = async ({ app }) => {
  // 文案表（阶段 3）：内联最小加载器（被字符串加载的脚本不能 require 同目录文件，
  // 各文件的 loadHelper / loadMiniHelper 签名也不一，一律走 adapter.read）。
  // **必须排在任何 _t() 调用之前**——下面就要用。
  const i18nSrc = await app.vault.adapter.read("flow/scripts/quickadd/mini/_i18n.js");
  const i18nMod = { exports: {} };
  new Function("module", "exports", i18nSrc)(i18nMod, i18nMod.exports);
  await i18nMod.exports.loadLocale(app.vault);
  _t = i18nMod.exports.t;
  const result = await runFinish(app, {
    confirm: confirmFinish,
    // afterFinish 的**契约**是 `(readme) => Promise<void>`（见 runFinish 的 opts 注释）。
    // closeReadmeLeaf 的签名却是 `(app, readme)`——**直接注入会让它收到 app=readme、
    // readme=undefined**，于是 app.workspace 是 undefined，关 tab 这步直接抛
    // 「Cannot read properties of undefined (reading 'getActiveFile')」，
    // README tab 自然关不掉（2026-11-20 实测定位；QuickAdd 宏时代同一个坑）。
    // 用箭头包一层、闭包捕获 app，参数才与契约对上。
    afterFinish: (readme) => closeReadmeLeaf(app, readme),
  });
  if (result.status === "no-target") {
    new Notice(_t("taskFinish.noTarget", "把光标放在月度 Capture 行上，或打开任务 README 后再执行"));
    return;
  }
  if (result.status === "not-line") {
    new Notice(_t("taskFinish.notLine", "该行不是标准 Capture 行"));
    return;
  }
  if (result.status === "already") {
    new Notice(_t("taskFinish.already", "任务已完成（#finish）；要重开用 Task Edit 把状态改回 Active"), 4000);
    return;
  }
  if (result.status === "cancelled") {
    new Notice(_t("taskFinish.cancelled", "已取消，未推进任务状态"), 2000);
    return;
  }
  if (result.status === "done") new Notice(result.message, 2000);
};

// 结案主流程——两个入口共用的**唯一**编排（2026-11-19 抽出）：
//   1. 上面的 QuickAdd 宏 Task Finish（人点，带确认框、关 tab）；
//   2. miniflow 的 `task-finish-headless` 命令（MCP command_execute 调，不确认、不动 tab）。
// 定位月度行 → 反查 README → 进展收口 → 推进状态机 → 写月度行 + README milestones，
// 全在这一份里；两个入口只差注入的交互。盘面动作仍在 `_finish.js`（nextAction /
// rewriteStatusLine / 归档），那边的「不许各写一份」约束不变。
//
// opts.confirm?:     (prompt) => Promise<boolean>；不传 = 跳过二次确认。
// opts.afterFinish?:  (readme) => Promise<void>；不传 = 不关 tab、不回 Home。
// opts.today?:        "YYYY-MM-DD"；不传取当天。
// opts.notify?:       (message, timeout) => void；不传 = 发 Notice（headless 入口用）。
//                     交付证据软闸的提示没有确认框可挂时走它；单测注入收集器。
// 返回 { status, message?, readme?, action? }，status ∈ no-target / not-line / already /
// cancelled / done。appendMilestone 抛错原样上抛，但 afterFinish 仍会跑（try/finally）。
async function runFinish(app, opts = {}) {
  const vault = app.vault;
  const confirm = typeof opts.confirm === "function" ? opts.confirm : null;
  const afterFinish = typeof opts.afterFinish === "function" ? opts.afterFinish : null;
  const notify = typeof opts.notify === "function" ? opts.notify : noticeFallback;
  const today = opts.today || window.moment().format("YYYY-MM-DD");

  const [taskHelpers, lineHelpers, yamlHelpers, finishHelpers, lineRewrite] = await Promise.all([
    loadHelper(vault, "_task.js"),
    loadHelper(vault, "_capture-line.js"),
    loadHelper(vault, "_yaml.js"),
    loadHelper(vault, "_finish.js"),
    // 月度行改写的唯一实现：_finish.js#rewriteStatusLine 只是它的转调壳，
    // 字符串加载下没有 require，所以在这里装载后注入（同 yamlHelpers 的路子）。
    loadHelper(vault, "_capture-line-rewrite.js"),
  ]);

  const ctx = await resolveTarget(app, vault, taskHelpers, lineHelpers);
  if (!ctx) return { status: "no-target" };

  const content = await vault.read(ctx.file);
  const lines = content.split("\n");
  const line = lines[ctx.lineIdx];
  const parsed = lineHelpers.parseCaptureLine(line, ctx.file.path);
  if (!parsed) return { status: "not-line" };

  // 反查 README 提到 nextAction 之前——已 finish 任务再触发 task-finish 也走同一关闭路径。
  const readme = await resolveReadme(app, vault, ctx, parsed, taskHelpers, lineHelpers);

  // README 收口前置：若 readme 存在，把 `## 进展` 段超出 5 条的最早 N 条自动
  // 移到 process/R-进展历史.md；这是状态机推进的前置，不影响主流程的错误兜底。
  // 配置只读一次：收口上限（progressSoftLimit）与交付证据软闸的交付口径
  // （deliveryDomains / deliveryExcludeDomains）都出自 behavior 组。
  const behavior = await readBehavior(vault);
  if (readme) {
    // 上限从配置取。脚本不能 require 同目录文件，所以走既有的 loadHelper 把 _config.js
    // 取进来、再用 adapter 读配置；读不到返回 undefined，
    // 由 archiveOverflowProgress → extractProgressOverflow 的默认 5 兜底。
    await finishHelpers.archiveOverflowProgress(vault, readme, today, behavior.progressSoftLimit);
  }

  const action = finishHelpers.nextAction(parsed);
  if (!action) {
    // 已 finish 任务：什么都不改，只关 README（如果开着）。复用同一 readme 变量，不重新解析。
    if (afterFinish) await afterFinish(readme);
    return { status: "already", readme };
  }

  // 交付证据软闸（判据与文案单源在 `_finish.js`，见该文件「交付证据软闸」段）：
  // 交付任务的 `### 设计` / `### 自测` 段还是模板骨架时出提示，**不拦**。
  // 提示挂哪：有人点确认（confirm 注入）→ 并进既有 window.confirm 文案，不叠横幅；
  // headless / MCP 无确认框 → 发一条 Notice（三类保留情形之 2「边界提示」）。
  const evidence = readme
    ? await finishHelpers.evidenceWarningFor(vault, readme, yamlHelpers, behavior)
    : "";

  // 二次确认：finish 会改月度行状态 + 追加 README milestones，状态机推进影响面较大。
  // 不想被弹窗打断可按住 Shift 再触发（QuickAdd Macro / 命令面板的 modifier 在调用栈里拿不到，
  // 留给用户在 CmdShift 触发的 QuickAdd choice 里加 bypass 标识，或者把这条 confirm 当可关闭的）。
  // headless 入口不传 confirm，直接跳过——MCP 侧点不掉 window.confirm，见插件侧命令注释。
  if (confirm) {
    if (!await confirm(buildConfirmPrompt(parsed, action, today, evidence))) {
      return { status: "cancelled", readme };
    }
  } else if (evidence) {
    notify(evidence, 6000);
  }

  lines[ctx.lineIdx] = finishHelpers.rewriteStatusLine(line, action, today, lineRewrite);
  await vault.modify(ctx.file, lines.join("\n"));

  // 完成里程碑追加到 README frontmatter milestones。try/finally 保证 afterFinish
  // 总会跑——appendMilestone 抛错时也关 README，避免错误后 README 仍开着让用户困惑。
  try {
    if (readme) {
      const type = taskHelpers.MILESTONE_TYPE[action.milestone];
      if (!type) throw new Error(`未注册的里程碑字面：${action.milestone}`);
      await taskHelpers.appendMilestone(vault, readme, yamlHelpers, { date: today, type });
    }
  } finally {
    // 关闭展示本任务 README 的 leaf：遍历所有 markdown leaf 找匹配 README 路径的 detach，
    // 从月度行触发、README 在另一 tab 也能关掉。
    if (afterFinish) await afterFinish(readme);
  }

  return { status: "done", message: action.notice, readme, action };
}

// 定位要操作的月度行：光标在 ideas 文件 → 该行；打开 README → 沿 source 反查。
async function resolveTarget(app, vault, taskHelpers, lineHelpers) {
  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  const activeFile = app.workspace.getActiveFile();
  if (editor && activeFile && /ideas-\d{4}-\d{2}\.md$/.test(activeFile.path)) {
    const idx = editor.getCursor().line;
    const line = editor.getLine(idx) || "";
    if (lineHelpers.parseCaptureLine(line, activeFile.path)) {
      return { file: activeFile, lineIdx: idx };
    }
  }
  if (activeFile) {
    const entry = taskHelpers.resolveTaskEntry(activeFile);
    if (entry && (entry.kind === "root-readme" || entry.kind === "root-file")) {
      return lineHelpers.resolveCaptureFromSource(app, activeFile, taskHelpers);
    }
  }
  return null;
}

// 找到月度行对应的 README TFile（写 frontmatter milestones 用）。光标在月度行时按链接 target 解析。
async function resolveReadme(app, vault, ctx, parsed, taskHelpers, lineHelpers) {
  const activeFile = app.workspace.getActiveFile();
  // 打开的就是 README/任务文件，直接用它。
  if (activeFile && taskHelpers.resolveTaskEntry(activeFile)?.kind?.startsWith("root")) {
    return activeFile;
  }
  // 光标在月度行：解析行内 wiki 链接目标。
  if (parsed.linkTarget) {
    const direct = vault.getAbstractFileByPath(`${parsed.linkTarget}.md`);
    if (direct && !direct.children) return direct;
    if (app.metadataCache && app.metadataCache.getFirstLinkpathDest) {
      const f = app.metadataCache.getFirstLinkpathDest(parsed.linkTarget, ctx.file.path);
      if (f && !f.children) return f;
    }
  }
  return null;
}

// 关闭展示本任务 README 的 leaf：遍历所有 markdown leaf，view.file 命中 readme 就 detach。
// 光标在月度行触发时 README 可能开在别的 tab/分屏，照样收掉；README 未开则 no-op。
//
// 落点（2026-10-16 起）：只有被收掉的 README 正好是**当前活动页**时才回 Home——用户正看着
// 任务页，关掉后无处可去。从月度 Capture 行触发时活动文件是 ideas-YYYY-MM、README 开在别的
// tab，此时抢焦点会打断连续处理 capture 行的批处理流，故不跳（判据纯函数 shouldFocusHome）。
async function closeReadmeLeaf(app, readme) {
  if (!readme) return;
  const active = app.workspace.getActiveFile();
  const wasActive = shouldFocusHome(active && active.path, readme.path);
  const leaves = app.workspace.getLeavesOfType("markdown") || [];
  leaves.forEach((leaf) => {
    const file = leaf.view && leaf.view.file;
    if (file && file.path === readme.path) leaf.detach();
  });
  if (wasActive) await focusHome(app);
}

// 「关掉 README 后该不该回 Home」的唯一判据：被关掉的 README 就是当前活动页。
// 纯函数，单测用（task-finish-gui.test.js）；无活动文件时返回 false。
function shouldFocusHome(activePath, readmePath) {
  if (!activePath || !readmePath) return false;
  return activePath === readmePath;
}

// 回 Home 首页。优先走 homepage 插件的 open-homepage 命令：Home 已开则 setActiveLeaf 激活原
// tab（不重复开）、未开则按用户配置的 manualOpenMode 开（Home 未开且当前是空 leaf 时正好填进去）。
// 命令未注册（插件停用）/ 执行抛错时退回直接开 Home.md——那条路必须先找已开的 Home leaf 再开，
// 否则会在新 leaf 里开出第二个 Home tab。Home 缺失则 no-op，不打断 finish 主流程。
const HOME_PATH = "Home.md";
// 首页路径走配置（paths.homePath）；读不到退回 HOME_PATH。与 readBehavior 同款：
// 脚本不能 require 同目录文件，走 loadHelper 取 _config.js 再用 adapter 读。
async function readHomePath(vault) {
  try {
    const mod = await loadHelper(vault, "_config.js");
    const cfg = mod && typeof mod.loadFromAdapter === "function"
      ? await mod.loadFromAdapter(vault.adapter)
      : null;
    return (cfg && cfg.paths && cfg.paths.homePath) || HOME_PATH;
  } catch (_e) {
    return HOME_PATH;
  }
}
async function focusHome(app) {
  const cmdId = "homepage:open-homepage";
  if (app.commands && app.commands.commands && app.commands.commands[cmdId]) {
    try {
      app.commands.executeCommandById(cmdId);
      return;
    } catch (e) {
      // 插件命令执行抛错 → 落到下面的直接开
    }
  }
  const home = app.vault.getAbstractFileByPath(await readHomePath(app.vault));
  if (!home || home.children) return;
  const opened = (app.workspace.getLeavesOfType("markdown") || []).find((leaf) => {
    const file = leaf.view && leaf.view.file;
    return file && file.path === home.path;
  });
  if (opened) {
    app.workspace.setActiveLeaf(opened, { focus: true });
    return;
  }
  await app.workspace.getLeaf(false).openFile(home, { active: true });
}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 取配置 `behavior` 组（进展段收口上限 + 交付证据软闸的交付口径）。
// **只读、失败返回 {}**——让下游一路退到 `_finish.js` 的默认值（上限 5、交付域清单空），
// 而不是在这里抛错打断 finish 主流程。
// 走 loadHelper 取 _config.js 是因为本文件（以及所有被 loadModule 加载的脚本）不能
// require 同目录文件：插件的 `new Function("module","exports",src)` 只注入两个参数，
// `require` 落到全局、相对路径基准不可控（见 _config.js 头注）。
async function readBehavior(vault) {
  try {
    const mod = await loadHelper(vault, "_config.js");
    const cfg = mod && typeof mod.loadFromAdapter === "function"
      ? await mod.loadFromAdapter(vault.adapter)
      : null;
    return (cfg && cfg.behavior) || {};
  } catch (_e) {
    return {};
  }
}

// 拼二次确认文案：标题 + 当前态 → 目标态 + 影响（行 / milestones / checkbox）。
// evidence?: 交付证据软闸的提示（`_finish.js#evidenceWarning` 的产物，空串=不出）。
// 有它就并进确认框——人点的路径本来就有一道确认，再叠 Notice 会"看着像出两次结果"
// （Notice 策略：成功反馈不叠横幅，本条属边界提示、挂既有确认框最省）。
function buildConfirmPrompt(parsed, action, today, evidence) {
  const title = parsed.title || parsed.body || "(未命名任务)";
  const fromLabel = parsed.status || "活跃";
  // 2026-08-19 删 archive 后推进目标恒为 finish，label 单一「完成」。
  const toLabel = "完成";
  const parts = [
    `确认把「${title}」从【${fromLabel}】推进到【${toLabel}】？`,
    "",
    "将：",
    `- 月度 Capture 行状态标签改为 #${action.status}` +
      (parsed.checkbox ? "（checkbox 形态同步勾选为 [x]）" : ""),
    `- README frontmatter milestones 追加一条 ${action.milestone}（${today}）`,
    action.status === "finish" ? `- 月度行追加 [completion:: ${today}]` : "",
  ].filter(Boolean);
  if (evidence) parts.push("", evidence, "软闸只提示不拦截——确认后照常结案。");
  parts.push("", "按 Esc / 取消可中断，已操作部分不会回滚。");
  return parts.join("\n");
}

// 复用 task-delete 的 window.confirm 风格；保持纯函数好测。
function confirmFinish(message) {
  return Promise.resolve(window.confirm(message));
}

// 交付证据软闸在"没有确认框可挂"的路径上用的默认通知通道（headless / MCP）。
// Obsidian 里 Notice 是全局类；裸 node（单测）没有 → 静默跳过，单测改注入 opts.notify。
function noticeFallback(message, timeout) {
  if (typeof Notice === "function") new Notice(message, timeout);
}

// 暴露纯函数供单测使用；__test 与 progress-checkin.js 同款范式（裸 node 直接 require）。
// 盘面函数（nextAction / rewriteStatusLine / 进展归档）已移到 `_finish.js`——
// miniflow 插件消费合并事实时用同一套，单测直接 require 那个文件。
module.exports.__test = {
  buildConfirmPrompt,
  // 关闭 README 后的落点判据（closeReadmeLeaf 用）。
  shouldFocusHome,
};

// headless 入口的唯一编排（见 runFinish 头注）。插件侧 `task-finish-headless` 命令
// 经 loadModule 拿整个 module.exports，调这个函数——**不许在插件里再写一份**。
module.exports.runFinish = runFinish;
// 关 README tab 的实现——**同一份**，task-delete 复用（任务文件删掉后那个 tab 会显示
// 「文件不存在」，留着突兀）。含「被关掉的正是当前活动页就回 Home」的判据。
// 顶层不 require("obsidian")（只用 app 的 API），所以裸 node 单测加载它没有副作用。
module.exports.closeReadmeLeaf = closeReadmeLeaf;
