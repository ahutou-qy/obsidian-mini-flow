// ==============================================
// Mini Flow - Task Edit：事后改一个任务的元数据。
//
// 编辑操作：
// - 标题：走 _rename.js 改 H1/磁盘名/月度行 alias 三处。
// - 状态：active 态渲染只读 chip「活跃」；finish 态渲染「已完成 · 重开为：」+ 一个
//   可点的 Active chip（2026-11-12 起只剩单活跃档，finish → active 是唯一跃迁，
//   走 rewriteStatus 剥 completion）。
//   切档只动月度行 #status，不写 README milestones（append-only 规约，历史 finish 留痕）；
//   **重开（finish → active）例外**：README milestones 追加一条 {date, type: reopen}
//   （2026-11-04 补的 writer，判据 _status.js#isReopenTransition）。
//
// 入口：光标在月度 Capture 行，或打开任务 README（沿 source 锚点定位月度行）。
// ==============================================

const { Modal, Setting } = require("obsidian");

// 状态字典 → _status.js#STATUSES 单源（task-capture.js 共用）。阶段 1 抽提。

// 界面文案查表（阶段 3）。**模块级**而非入口里的局部 const：`IdeaModal` / `EditModal` 是
// 模块级 class，它们的方法构成独立作用域，取不到入口函数内的局部变量（2026-11-21 实测
// 差点就地抛 ReferenceError——守卫只查 key 存在、查不到作用域，靠读代码才看见）。
// 入口 loadLocale 成功后用查表函数覆盖它；没覆盖时恒等返回原文，不因初始化缺失变空。
let _tWarned = false;
let _t = (key, fallback) => {
  // 表还没加载就用 _t → 查表静默失效。**warn 一次**（不每次都吵）：症状是「切到英文后界面
  // 还是中文」，而 warn 直接指出是加载时序问题。
  if (!_tWarned) {
    _tWarned = true;
    console.warn("[miniflow] 文案表未加载，界面文案回落中文原文——检查入口是否在用 _t() 之前 await 了 loadLocale");
  }
  return fallback === undefined ? key : fallback;
};

module.exports = async ({ app, quickAddApi }) => {
  const vault = app.vault;
  const [task, line, rename, workflow, yaml, status, ui, lineRewrite] = await Promise.all([
    loadHelper(vault, "_task.js"),
    loadHelper(vault, "_capture-line.js"),
    loadHelper(vault, "_rename.js"),
    loadHelper(vault, "_workflow.js"),
    loadHelper(vault, "_yaml.js"),
    loadHelper(vault, "_status.js"),
    loadHelper(vault, "_ui.js"),
    loadHelper(vault, "_capture-line-rewrite.js"),
  ]);
  const { STATUSES } = status;
  const { rewriteStatus } = lineRewrite;
  // 界面文案（阶段 3）：load locale 表并注入 _ui.js——它的 renderLayer1/2 是同步闭包，
  // 渲染那一刻来不及 await；这里在进 Modal 之前灌好。
  const i18nMod = await loadHelper(vault, "_i18n.js");
  await i18nMod.loadLocale(vault);
  ui.initI18n(i18nMod);
  _t = i18nMod.t;

  const captured = await resolveCaptureContext(app, vault, task, line);
  if (!captured) {
    new Notice(_t("taskEdit.notOnCaptureLine", "把光标放在 Capture 行上，或打开任务 README 后再执行编辑"));
    return;
  }

  const content = await vault.read(captured.file);
  const lines = content.split("\n");
  const idx = locateLine(lines, captured);
  if (idx < 0) {
    new Notice(_t("taskEdit.captureLineNotFound", "找不到对应的 Capture 行（可能已被移动或删除）"));
    return;
  }

  const parsed = line.parseCaptureLine(lines[idx], captured.file.path);
  if (!parsed || !parsed.linkTarget) {
    new Notice(_t("taskEdit.notStandardCaptureLine", "该行不是标准 Capture 行，无法编辑"));
    return;
  }

  const domainChoices = await workflow.listDomainChoices(vault);
  // renameTarget 缺失时仍允许看，但不写入 README（防御性分支：仅改名+状态重写）。
  const renameTarget = rename.resolveTargetFromLink(app, parsed.linkTarget, captured.file);
  const tasksDir = renameTarget ? task.tasksDirForActiveFile(renameTarget.file) : null;

  // 主题关联只存 README frontmatter topic 标量（2026-09-14 起一任务一 topic），不动月度 Capture 行（单源）。
  const topicChoices = await workflow.listTopicChoices(vault);
  let initialTopic = "";
  let initialDomain = "";
  if (renameTarget) {
    const readmeRaw = await vault.read(renameTarget.file);
    const fmMatch = yaml.FRONTMATTER_RE.exec(readmeRaw);
    if (fmMatch) {
      initialTopic = yaml.getTopic(fmMatch[1]);
      // 以 README frontmatter domain 为权威；老月度行残留的 #domain/x 仅作兜底
      // （2026-11-16 起新 capture 行不再打该标签）。
      initialDomain = yaml.getDomain(fmMatch[1]) || parsed.domain || "";
    }
  }
  const state = {
    title: parsed.title,
    // 当前状态原值；空 = untagged 旧行，chip 全 dimmed + 显示"（无状态）"。
    // 不再默认到 "active"（历史 bug，会让并发 precheck 误判）。
    // statusInitial 记 modal-open 时磁盘上的原始态，点保存时用于判断是否变更。
    currentStatus: parsed.status || "",
    statusInitial: parsed.status || "",
    topic: initialTopic,
  };

  // 持有 modal 引用，onSubmit 末尾统一调 close()——对齐 task-capture.js「submit 只触发
  // onSubmit,close 跟在 work 之后」的模式,避免 onSubmit 内部 await 抛错时
  // close() 与 Notice 被 fire-and-forget 拆散。
  const modal = new EditModal(app, {
    state,
    topicChoices,
    ui,
    STATUSES,
    onSubmit: async () => {
      const newTitle = String(state.title || "").trim();
      const titleChanged = newTitle && newTitle !== parsed.title;
      try {
      if (titleChanged && renameTarget) {
        await rename.applyRename(app, {
          target: renameTarget,
          capture: { file: captured.file, anchor: captured.anchor, lineIdx: idx },
          newTitle,
          tasksDir,
        });
        // rename 不写 captured.file（只改 README + 同 anchor 多行 alias），无须后续处理。
      }
      // 始终 fresh re-read：覆盖 modal 打开期间的盘面变化（修正 silent overwrite bug）。
      // 原实现里 `lines` 在 modal-open 时闭包捕获一次，save 时会用旧 lines 覆盖盘面改动。
      const workingLines = (await vault.read(captured.file)).split("\n");
      const workingIdx = workingLines.findIndex((l) => l.includes(`^${captured.anchor}`));
      if (workingIdx < 0) return;
      // 状态在 chip 点击时只改内存 currentStatus；这里点「保存」才落盘。
      // 切档不写 README milestones（append-only），历史 finish milestone 保留；
      // finish → active 的**重开**要留痕，见下面 appendMilestone 那段。
      const statusChanged = state.currentStatus !== state.statusInitial;
      // 主题关联写回 README frontmatter（appendMilestone 已 modify 过一次，这里重读再写，
      // 顺序不冲突——milestones 与 topic 是两个独立字段，setTopic 只切 topic 段）。
      if (renameTarget) {
        const readmeRaw = await vault.read(renameTarget.file);
        const fmMatch = yaml.FRONTMATTER_RE.exec(readmeRaw);
        if (fmMatch) {
          const nextTopic = yaml.setTopic(fmMatch[1], state.topic);
          if (nextTopic !== fmMatch[1]) {
            // setTopic 返回 body 可能不带尾换行；拼接 --- 闭合前先压扁尾随换行再加一个，
            // 避免吞闭合标记变 "topic: x---" 同行。单测：_yaml.test.js 用例 11。
            const fmBody = `\n${nextTopic}\n`.replace(/\n+$/, "");
            const next = readmeRaw.replace(readmeRaw.match(yaml.FRONTMATTER_RE)[0], `---\n${fmBody}\n---`);
            await vault.modify(renameTarget.file, next);
          }
        }
      }
      // 月度 Capture 行：#status 在点「保存」时落盘。against fresh workingLines。
      let lineDirty = false;
      if (statusChanged && state.currentStatus) {
        // rewriteStatus 负责换 #status、补/剥 [completion::]、checkbox 同步；与 task-finish 同款语义。
        // 仅在选了有效状态时写；untagged("") 不动行。
        workingLines[workingIdx] = rewriteStatus(workingLines[workingIdx], state.currentStatus, moment().format("YYYY-MM-DD"));
        lineDirty = true;
      }
      if (lineDirty) {
        await vault.modify(captured.file, workingLines.join("\n"));
      }
      // 重开留痕：finish → active 是「结案后又做起来」的转折，README milestones 追加一条
      // {date, type: reopen}（2026-11-04）。幂等键沿用 addMilestone 的 {date, type}：
      // 同一天重开两次只留一条——重开是状态转折，一天一次足够；**finish 的键不动**
      // （Home「✅ 已完成」卡按 finish 的最大 date 聚合，依赖那个键）。
      // 写序两处讲究：① 排在主题写回之后——appendMilestone 自己重读全文再改 frontmatter，
      // 放在主题写回前面会被随后的 vault.modify（整篇替换）覆盖掉；
      // ② 排在月度行写回之后——月度行 #status 是状态的唯一真相，先落它。
      // renameTarget 缺失（任务文件找不到）时无处可写，跳过：那条路径本来就只改月度行。
      const isReopen = statusChanged && status.isReopenTransition(state.statusInitial, state.currentStatus);
      if (isReopen && renameTarget) {
        await task.appendMilestone(vault, renameTarget.file, yaml, {
          date: moment().format("YYYY-MM-DD"),
          type: "reopen",
        });
      }
      // 保存成功通知：仅当确实改了字段才弹。
      const topicChanged = (state.topic || "") !== (initialTopic || "");
      const parts = [];
      if (titleChanged) parts.push("标题");
      if (topicChanged) parts.push("主题");
      if (statusChanged) parts.push("状态");
      if (parts.length > 0) {
        new Notice(`已保存任务（${parts.join("/")}）：${newTitle || parsed.title}`, 2000);
      }
      } catch (e) {
        // 任一 await 抛错（rename / vault.read / yaml.setTopic / vault.modify），
        // 不要静默吞掉——提示原因,用户能据此知道没保存成功。
        new Notice(`保存失败：${String(e && e.message || e).slice(0, 160)}`, 4000);
      }
      // close 跟在 work 之后,避免 fire-and-forget 拆散 Notice 与 close() 的时序。
      // 任一路径(成功/早 return / catch)都关弹窗。
      modal.close();
    },
  });
  modal.open();
};

// Capture 行级 rewrite 三个纯函数 + rewriteStatus 薄壳：抽到 _capture-line-rewrite.js,
// task-finish / task-edit 的状态改写共用同一源,避免漂移。task-edit 通过 chip-click handler
// 调 rewriteStatus 做 finish→active 重开（active 平面，不写 milestones），推进到 finish
// 仍走 task-finish（file-private rewriteStatusLine）。note:rewriteStatus 也写到 _rewriteStatus.test.js。
// 注意:模块顶层看不到入口 vault,helper 必须由调用方注入(见 MEMORY「QuickAdd Modal class 作用域坑」)。

async function resolveCaptureContext(app, vault, task, line) {
  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  const activeFile = app.workspace.getActiveFile();
  if (editor && activeFile && /ideas-\d{4}-\d{2}\.md$/.test(activeFile.path)) {
    const idx = editor.getCursor().line;
    const row = editor.getLine(idx) || "";
    if (line.parseCaptureLine(row, activeFile.path)) return { file: activeFile, anchor: line.extractAnchor(row), lineIdx: idx };
  }
  if (activeFile) {
    const entry = task.resolveTaskEntry(activeFile);
    if (entry && (entry.kind === "root-readme" || entry.kind === "root-file")) {
      return line.resolveCaptureFromSource(app, activeFile, task);
    }
  }
  return null;
}

function locateLine(lines, captured) {
  if (captured.lineIdx != null && lines[captured.lineIdx] && lines[captured.lineIdx].includes(`^${captured.anchor}`)) {
    return captured.lineIdx;
  }
  return lines.findIndex((l) => l.includes(`^${captured.anchor}`));
}

class EditModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.ui = opts.ui; // _ui.applyChipHighlight / _ui.getCssVar
    this.STATUSES = opts.STATUSES; // _status.STATUSES 2 态字典,阶段 1 抽提后必须显式注入。
  }
  onOpen() {
    const { state, topicChoices } = this.opts;
    // 阶段 2：与 idea Modal 视觉对齐——h2 + form 排版、字体 class 一致。
    // 这里借用 idea Modal 的 title class（物理上 reuse，CSS 单源在 .obsidian/snippets/miniflow-idea-popup.css）。
    this.titleEl = this.contentEl.createEl("h2", { text: _t("taskEdit.heading", "编辑任务"), cls: "mini-flow-idea-title" });
    const form = this.contentEl.createDiv();
    this.formEl = form;

    // 任务名输入——与 idea 对齐：IME 防御 + Enter 提交 + setTimeout focus。
    let composing = false;
    const titleSetting = new Setting(form).setName(_t("common.taskName", "任务名"));
    const titleInputCfg = titleSetting.addText((text) => {
      text.setPlaceholder("任务名");
      text.setValue(state.title);
      this.nameInputEl = text.inputEl;
      window.setTimeout(() => text.inputEl.focus(), 0);
      text.inputEl.addEventListener("compositionstart", () => { composing = true; });
      text.inputEl.addEventListener("compositionend", () => { composing = false; });
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !composing && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          this.submit();
        }
      });
      text.inputEl.addEventListener("input", () => this.refreshSubmit());
      text.onChange((v) => {
        state.title = v;
        this.refreshSubmit();
      });
    });
    // 关联主题:两层 chip 单选,与 task-capture 同款(2026-09-29 对齐)。
    // 落点也照 capture:form 下平级 host div + hr 分隔,不再把主题 Setting 塞进
    // 另一个 Setting 的控件列(Setting 套 Setting 会让 label 列叠三层)。
    // 渲染实现共用 _ui.createTopicSection,两边不存在"改一份漏一份"。
    this.topicSettingsHost = form.createDiv({ cls: "mini-flow-topic-settings-host" });
    form.createEl("hr", { cls: "mini-flow-section-divider" });
    if (!topicChoices || topicChoices.length === 0) {
      this.topicSettingsHost.createSpan({
        text: _t("common.noTopicsHint", "（暂无主题，先用 Topic 命令建）"),
        cls: "mini-flow-topics-empty",
      });
    } else {
      this.ui.createTopicSection({
        host: this.topicSettingsHost,
        tree: this.ui.buildTopicTree(topicChoices),
        state,
        applyChipHighlight: this.ui.applyChipHighlight,
      }).mount();
    }

    const statusSetting = new Setting(form).setName(_t("common.status", "状态"));
    // 状态区：active 态只读；finish 态给一个 Active chip 重开（rewriteStatus 剥 completion）。
    // 所有切换走 _capture-line-rewrite#rewriteStatus，只动月度行 #status，不写 milestones/frontmatter。
    const statusHost = statusSetting.controlEl.createDiv({ cls: "mini-flow-task-edit-status-host" });
    this.renderStatusChips(statusHost);

    // 阶段 2：保存按钮加 disabled 守卫，空 title 不可保存。
    new Setting(form)
      .addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()))
      .addButton((btn) => {
        btn.setButtonText("保存").setCta().setDisabled(!String(state.title || "").trim());
        btn.onClick(() => this.submit());
        this.submitBtn = btn;
      });
    this.refreshSubmit();
  }
  // 两层主题 chip 的渲染/选中/高亮在 _ui.createTopicSection(2026-09-29 抽提,
  // 与 task-capture 共用)。本 Modal 只负责建 host 并 mount。
  refreshSubmit() {
    if (!this.submitBtn) return;
    const v = this.nameInputEl ? this.nameInputEl.value : (this.opts.state.title || "");
    this.submitBtn.setDisabled(!String(v || "").trim());
  }
  submit() {
    // 阶段 2 Enter 提交入口。空 title 直接吞掉（refreshSubmit 已 disabled）。
    // close() 跟随 onSubmit 末尾（modal 持有者负责），不在这里同步调——
    // 同步 close 会跟 onSubmit 的 await 链错开,Notice 与 DOM 移除竞态。
    if (!this.submitBtn || this.submitBtn.disabled) return;
    this.opts.onSubmit();
  }

  // 状态 chip 渲染（2026-11-12 单活跃档）：
  // - active：只读 chip「活跃」——只有一个活跃档，切换无对象，不给按钮。
  // - finish：2026-08-24 起支持 reopen，2026-11-12 收敛后只渲染一个 Active chip
  //   （前带「已完成 · 重开为」提示），点它即走 rewriteStatus 回 active：
  //   #finish→#active、剥 [completion::]、checkbox [x]→[ ]。README 的 finish
  //   milestone 按 append-only 规约保留（状态以月度行 #status 为唯一真相）。
  // - 仅 untagged（""）历史行走单只读 muted chip。
  // 历史别名行不会出现在 UI 上（parseCaptureLine 已归一到 active/finish），
  // 未知 token 走 fallback 显示原文,作为 reader 容错标记。
  renderStatusChips(host) {
    if (!host) return;
    this.statusHost = host; // toggleStatusChip 回调里复用
    const { state } = this.opts;
    host.replaceChildren();
    const cur = state.currentStatus;

    // active：只读 chip（没有第二个活跃档可切）。
    if (cur === "active") {
      host.createSpan({
        text: _t("taskEdit.active", "活跃"),
        cls: "mini-flow-task-edit-status-chip mini-flow-task-edit-status-chip--active",
      });
      return;
    }

    // finish 重开：只读「已完成」提示 + 一个 Active chip（唯一的状态跃迁）。
    if (cur === "finish") {
      host.createSpan({
        text: _t("taskEdit.finishReopenPrefix", "已完成 · 重开为："),
        cls: "mini-flow-task-edit-status-reopen-hint",
      });
      host.classList.add("mini-flow-task-edit-status-toggle");
      const btn = host.createEl("button", {
        text: "Active",
        cls: "mini-flow-topic-chip",
        attr: { type: "button", "data-status": "active", "aria-label": "#active" },
      });
      this.ui.applyChipHighlight(btn, false);
      btn.addEventListener("click", () => this.toggleStatusChip("active"));
      return;
    }

    // 仅 untagged / 未知 token：单只读 muted chip,不抢主题色。
    const labelMap = { "": "（无状态）" };
    const label = labelMap[cur] || cur;
    const chip = host.createSpan({
      text: label,
      cls: "mini-flow-task-edit-status-chip",
    });
    if (cur && labelMap[cur]) chip.classList.add(`mini-flow-task-edit-status-chip--${cur}`);
  }

  // chip-click handler：rewrites 月度 Capture 行 #status tag，vault.modify。Modal 不关。
  // chip-click handler：只更新内存里的 state.currentStatus 并重渲染，不落盘。
  // 真正写盘发生在点「保存」时（onSubmit 里与主题一起 fresh re-read 后统一 modify）。
  // 这样状态变更和其它字段一样走「保存」收口，成功提示也在保存后统一弹。
  toggleStatusChip(newStatus) {
    const { state } = this.opts;
    if (newStatus === state.currentStatus) return; // no-op guard
    state.currentStatus = newStatus;
    this.renderStatusChips(this.statusHost); // 翻面刷新当前态
  }

}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
