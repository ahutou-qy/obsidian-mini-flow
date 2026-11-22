// ==============================================
// Mini Flow - Progress Checkin（进展打卡）：给当前任务 README 的 `## 进展` 段追加一条。
//
// 与 milestones 的分工：
//   - frontmatter milestones：状态事件（create/finish/reopen），由命令自动写，无 note。
//   - 正文 `## 进展`：人写的进度叙事，按 `- 日期 | 做了什么` 追加。
// 本命令只写正文 `## 进展`，不碰 frontmatter——打卡是进度叙事，不是状态事件。
//
// 入口：光标在月度 Capture 行、或打开任务 README/任务文件时执行。
// Esc 或空输入取消，不落空行。
// ==============================================

// 界面文案查表（阶段 3）。**模块级 `_t`**：入口 load 一次后赋值；未赋值时恒等返回原文。
// 与 task-capture / task-edit / _ui.js / rule-* 同款——避开「局部 const 取不到模块级
// class 里的调用」那个坑（批次 2 实测）。
let _t = (key, fallback) => (fallback === undefined ? key : fallback);

module.exports = async ({ app, quickAddApi }) => {
  const vault = app.vault;
  // 文案表（阶段 3）：load 一次并把查表函数挂到模块级 _t。
  const i18nMod = await loadHelper(vault, "_i18n.js");
  await i18nMod.loadLocale(vault);
  _t = i18nMod.t;

  const [taskHelpers, lineHelpers, progress] = await Promise.all([
    loadHelper(vault, "_task.js"),
    loadHelper(vault, "_capture-line.js"),
    // 追加算法与计数已下沉到 _progress.js（CLI `mf.js progress` 调同一份）。
    loadHelper(vault, "_progress.js"),
  ]);
  const { ensureProgressSection, countProgressBullets, SOFT_LIMIT } = progress;

  const readme = await resolveReadme(app, vault, taskHelpers, lineHelpers);
  if (!readme) {
    new Notice(_t("progressCheckin.needContext", "打开任务 README，或把光标放在月度 Capture 行上再记进展"));
    return;
  }

  const text = await quickAddApi.inputPrompt(_t("progressCheckin.prompt", "进展（一行，记进 ## 进展；Esc 取消）"));
  const body = (text ?? "").trim();
  if (!body) {
    new Notice(_t("common.cancelledEmpty", "已取消：空内容不写入"), 2000);
    return;
  }

  const today = window.moment().format("YYYY-MM-DD");
  const prev = await vault.read(readme);
  const { content: next, appendedLine } = ensureProgressSection(prev, today, body);
  await vault.modify(readme, next);

  new Notice(`已记进展：${today}`, 2000);

  // soft-warning：超阈值不阻断，但提示用户 task-finish 会强制收口，避免惊喜。
  const total = countProgressBullets(next);
  if (total > SOFT_LIMIT) {
    new Notice(`提示：进展段已超 ${SOFT_LIMIT} 条（当前 ${total} 条），task-finish 时会自动归档最早 ${total - SOFT_LIMIT} 条到 process/R-进展历史.md`, 4000);
  }

  // 尽力打开 README 并把光标落到新行；失败不影响写入结果。
  try {
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(readme, { active: true });
    const editor = leaf.view && leaf.view.editor;
    if (editor && appendedLine >= 0) {
      editor.setCursor({ line: appendedLine, ch: 0 });
    }
  } catch (_) {
    // 光标定位是锦上添花，忽略。
  }
};

// 定位要写入的 README TFile：
//   - 当前打开的就是 root README / 任务文件 → 直接用；
//   - 光标在月度 Capture 行 → 解析行内 wiki-link target。
// 镜像 task-finish-gui.js 的 resolveReadme，但不依赖先改写月度行。
async function resolveReadme(app, vault, taskHelpers, lineHelpers) {
  const activeFile = app.workspace.getActiveFile();
  if (activeFile) {
    const entry = taskHelpers.resolveTaskEntry(activeFile);
    if (entry && (entry.kind === "root-readme" || entry.kind === "root-file")) {
      return activeFile;
    }
  }

  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  if (editor && activeFile && /ideas-\d{4}-\d{2}\.md$/.test(activeFile.path)) {
    const idx = editor.getCursor().line;
    const line = editor.getLine(idx) || "";
    const parsed = lineHelpers.parseCaptureLine(line, activeFile.path);
    if (parsed && parsed.linkTarget) {
      const direct = vault.getAbstractFileByPath(`${parsed.linkTarget}.md`);
      if (direct && !direct.children) return direct;
      if (app.metadataCache && app.metadataCache.getFirstLinkpathDest) {
        const f = app.metadataCache.getFirstLinkpathDest(parsed.linkTarget, activeFile.path);
        if (f && !f.children) return f;
      }
    }
  }
  return null;
}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

// 纯函数已下沉到 `_progress.js`（GUI 与 CLI 共用）。__test 只服务裸 node 单测：
// Obsidian 字符串加载没有 require，这里 try 住即可（运行时走上面的 loadHelper）。
try {
  const p = require("./_progress.js");
  module.exports.__test = {
    ensureProgressSection: p.ensureProgressSection,
    countProgressBullets: p.countProgressBullets,
    PROGRESS_HEADER: p.PROGRESS_HEADER,
    PROGRESS_HINT: p.PROGRESS_HINT,
  };
} catch (_) { /* Obsidian 侧无 require：__test 不可用，不影响命令本体 */ }
