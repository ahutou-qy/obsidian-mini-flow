// ==============================================
// Mini Flow - Task Capture：单 Modal 主面板只收任务名 + 智能推断
//
// 2026-08-20 由原 Idea 命令改名而来（idea.js 是历史文件名）：本命令建的是
// type:task-folder 任务，正名「Task Capture」。新的 Idea Capture（闪念/未成结论）
// 改走 idea-capture.js，落到 Home.md 的临时区，不进任务流水线。
//
// 极简模型（2026-08 第二次转向，删去范围/条目/事件类型/因果/标签）：
// 一屏只输入任务名；领域 chip 留主面板（只锁定、不换域），状态到高级折叠区（默认展开）。
// capture 一律建 folder（README + input/process/output/）+ 月度 Capture 行。
// （README 正文为置顶 ## 文件索引 + ## 进展/## 输入/## 内化 三段；## 内化 下默认注入 调研/分析/设计/实现/自测 五个 H3，## 文件索引由插件维护）
// 创建成功后立即打开任务 README，方便立刻补输入；同时把 README 全路径写进剪贴板
//（2026-10-26 起默认，静默不发 Notice，实现见 _clipboard.js）。
//
// 状态档位（与 _status.js 头部注释协同）：
// 2026-11-12 起只剩单一活跃档 active：capture 一律写 #active，没有可切换项，
// 高级区的状态区改为只读说明。完成（finish）是已存在任务的推进态，
// 不在 capture 入口暴露,由 task-edit（编辑面板）和 task-finish（推进流程）处理。
// STATUSES 字典（active/finish）注入实例供 Notice label 查找 / 与 task-edit 保持单源。
//
// 推断（2026-08 第三次转向，2026-09-14 收敛）：
// - 领域默认值由 `_infer.inferDomain(name, domainChoices)` 算出；
//   多 work 命中按 score 降序，零命中兜底第一个 work=false。
// - 状态无自动推断（2026-09-14 删 inferStatus）：固定 active（2026-11-12 单活跃档）。
// - 2026-11-23 砍 topic：主题两层 chip 与其推断链路全部下线，capture 弹框只剩
//   领域后台推断（无 UI），改域走 `mf.js set --domain`。
// - 高级区手动改即锁定：领域 → domainLocked。
// - 领域关键词源 = flow.json#keywords。
// - 月度 Capture 行格式不动；captureIdea 签名不变。
// - 高级区默认 open = true（plan 阶段 4 调整，2026-08-14 UX 转向）。
// - 2026-09-14 取消「测试任务」toggle（isTest / checkboxForm 机制全删）。
// - 2026-09-14 隐藏领域 chip（capture 入口不渲染，task-edit 仍暴露）。
// - 2026-09-14 删推断 badge：#status / domain 早已不在弹框渲染，最后残留的 🔖 topic
//   回显与下方 chip 选中态重复，空元素选中后撑高顶动布局（topic 整体已于 2026-11-23 删除）。
// ==============================================

const { Modal, Setting } = require("obsidian");

// 状态字典 → _status.js#STATUSES 单源（task-edit 共用）。
// 阶段 1 抽提：原 idea 私有 2 态版本删去；2026-08-19 archive 档从数据模型移除后
// 统一 3 态源头在 _status.js。

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
  const [naming, task, capture, workflow, infer, statusMod, ui, walk, indexHelper, clipboard, configMod] = await Promise.all([
    loadHelper(vault, "_naming.js"),
    loadHelper(vault, "_task.js"),
    loadHelper(vault, "_capture.js"),
    loadHelper(vault, "_workflow.js"),
    loadHelper(vault, "_infer.js"),
    loadHelper(vault, "_status.js"),
    loadHelper(vault, "_ui.js"),
    loadHelper(vault, "_walk.js"),
    loadHelper(vault, "_index.js"),
    loadHelper(vault, "_clipboard.js"),
    // 配置读取入口：文件名上限等 behavior 项由这里读出来、经 helpers.config 注入给
    // _capture.js（脚本不能 require 同目录文件，只能走 loadHelper——见 _config.js 头注）。
    loadHelper(vault, "_config.js"),
  ]);
  const config = configMod && typeof configMod.loadFromAdapter === "function"
    ? await configMod.loadFromAdapter(vault.adapter)
    : null;
  // 界面文案（阶段 3）：load 一次 locale 表并注入 _ui.js——它的 renderLayer1/2 是同步
  // 闭包，渲染那一刻来不及 await；这里在进 Modal 之前灌好，onOpen 时就绪。
  const i18nMod = await loadHelper(vault, "_i18n.js");
  await i18nMod.loadLocale(vault);
  ui.initI18n(i18nMod);
  _t = i18nMod.t;
  const { cleanTitle } = naming;
  const { captureIdea } = capture;
  const { inferDomain } = infer;
  const { applyChipHighlight } = ui;
  const { buildIndexBody } = walk;
  const { replaceOrInsertIndex } = indexHelper;
  const { STATUSES } = statusMod;
  // idea 弹框只渲染 active 两档（详见 _status.js 头部注释），finish 不暴露。
  // 状态无自动推断：默认 Next，用户手动点 Now / Next chip 即锁定（2026-09-14）。
  const STATUS_LABELS = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));
  const ACTIVE_STATUSES = STATUSES.filter((s) => s.value === "active");

  const state = {
    domainChoice: null,
    status: "active",
    domainLocked: false, // 手动钉/换领域后置 true；与状态独立
  };

  // domainChoices 平铺 wf.keywords → choice.keywords。
  // （topic 侧 hydrateTopicChoices 已于 2026-11-23 砍 topic 时删除。）
  const hydrateDomainChoices = (raw) => raw.map((c) => ({
    slug: c.slug,
    label: c.label,
    work: !!c.work,
    domain: c.domain || c.slug,
    keywords: c.workflow && Array.isArray(c.workflow.keywords) ? c.workflow.keywords : [],
  }));

  const modal = new IdeaModal(app, {
    state,
    infer: { inferDomain },
    STATUSES, // 2 态字典（active/finish），task-finish 等共享；本弹框走 ACTIVE_STATUSES（唯一活跃档 active）。
    activeStatuses: ACTIVE_STATUSES, // 显式注入,Modal class 内走 this.activeStatuses 取值。
    applyChipHighlight, // 注入到实例,class 方法内走 this.applyChipHighlight。
    ui, // _ui 视觉 helper 全集;class 内走 this.ui.
    cleanTitle,
    loadData: () => workflow.listDomainChoices(vault, config && config.paths)
      .then((rawDomainChoices) => {
        const domainChoices = hydrateDomainChoices(rawDomainChoices);
        state.domainChoice = domainChoices[0] || null;
        return { domainChoices };
      }),
    onSubmit,
  });
  modal.open();

  async function onSubmit(desc) {
    const title = cleanTitle(desc);
    if (!title) {
      new Notice(_t("taskCapture.emptyTitle", "任务名为空，无法创建"));
      return;
    }
    const domainChoice = state.domainChoice;
    if (!domainChoice) {
      new Notice(_t("taskCapture.domainNotLoaded", "领域数据未加载，无法创建"));
      return;
    }
    let result;
    try {
      result = await captureIdea(vault, { naming, task, workflow, app, config }, {
        title,
        status: state.status,
        now: window.moment(),
        domain: domainChoice.domain,
        // 2026-11-23 砍 topic：不再传 topic（_capture.js / _task.js 两侧均无该字段）。
      });
    } catch (e) {
      new Notice(`任务创建失败: ${String(e).slice(0, 160)}`);
      return;
    }

    if (result.conflict) { new Notice(result.conflict); return; }

    // 复制新任务 README 的全路径（桌面端是本地绝对路径）。不 await：剪贴板写失败
    // 不影响建任务，_clipboard.copyReadmePath 自身吞掉所有异常、绝不 reject。
    // 在关弹框前发起——此刻 Obsidian 窗口一定有焦点，navigator.clipboard 更稳。
    // 剪贴板开关（behavior.copyPathOnCapture）：默认开，**显式 false 才不写**——
    // 配置缺失/读不到时保持原行为，别让人升级后突然丢了「capture 完路径已在剪贴板」。
    if (!config || config.behavior.copyPathOnCapture !== false) {
      clipboard.copyReadmePath(app, result.taskPath);
    }

    // 成功反馈靠 Modal.close() + 新任务 README 自动开新 leaf,
    // 不再发 `new Notice` —— 见 flow/CLAUDE.md「Mini Flow 命令的 Notice 策略」(2026-10-13)。
    modal.close();
    // 建完立即打开任务 README，方便立刻补「## 输入」等信息。
    const createdFile = vault.getAbstractFileByPath(result.taskPath);
    if (createdFile) {
      // 打开前主动写一次初始文件索引：miniflow 插件在 README 为活动文件时
      // 会跳过自动刷新（避免覆盖正在编辑的内容），打开后它就不会再补；这里先填好占位，
      // 否则全新空任务的「## 文件索引」段会一直空着，直到手动 task-refresh-index。
      const taskFolder = createdFile.parent;
      if (taskFolder && buildIndexBody && replaceOrInsertIndex) {
        const old = await vault.read(createdFile);
        const updated = replaceOrInsertIndex(old, buildIndexBody(taskFolder));
        if (updated !== old) await vault.modify(createdFile, updated);
      }
      await app.workspace.getLeaf(false).openFile(createdFile, { active: true });
    }
  }
};

class IdeaModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.STATUSES = opts.STATUSES; // _status.STATUSES 单源(2 态),与 task-edit 同步(避免闭包 scope bug)
    // 弹框只产唯一活跃档（active）；完成（finish）是已存在任务的推进态，
    // 不在 capture 入口暴露（task-finish 走推进）。activeStatuses 供状态区文案用。
    this.activeStatuses = Array.isArray(opts.activeStatuses) && opts.activeStatuses.length > 0
      ? opts.activeStatuses
      : opts.STATUSES.filter((s) => s.value === "active");
    this.applyChipHighlight = opts.applyChipHighlight; // _ui.applyChipHighlight,class 方法内必须走 this.
    this.ui = opts.ui; // _ui 全集(buildTopicTree / createTopicSection);class 内走 this.ui.
  }

  onClose() {
    // 推断节流定时器要清:弹框关闭后 _inferTimer 仍会到点触发一次(读已丢弃的
    // nameInputEl)。capture 入口不渲染领域 chip(2026-09-14),无 domain popup 可清理。
    if (this._inferTimer) { clearTimeout(this._inferTimer); this._inferTimer = null; }
  }

  onOpen() {
    this.contentEl.createEl("h2", { text: _t("taskCapture.heading", "新建任务"), cls: "mini-flow-idea-title" });
    this.formEl = this.contentEl.createDiv();

    // 任务名输入——compositionstart/end + Enter 防误触 + 自动 focus 锁点。
    new Setting(this.formEl)
      .setName(_t("common.taskName", "任务名"))
      .addText((text) => {
        text.setPlaceholder("要做什么");
        this.nameInputEl = text.inputEl;
        window.setTimeout(() => text.inputEl.focus(), 0);
        let composing = false;
        text.inputEl.addEventListener("compositionstart", () => { composing = true; });
        text.inputEl.addEventListener("compositionend", () => { composing = false; });
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !composing && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            this.submit();
          }
        });
        // 实时重推断：input 事件触发，submit 时再算一次。
        text.inputEl.addEventListener("input", () => {
          this.refreshSubmit();
          this.scheduleInfer();
        });
        text.onChange(() => this.refreshSubmit());
      });

    // 2026-11-23 砍 topic：主题两层 chip 区已删；下面这条 hr 保留作视觉分隔。
    this.formEl.createEl("hr", { cls: "mini-flow-section-divider" });

    // 高级折叠区去壳（细节设计 2026-08-14 收紧）：直接把高级 Setting 平铺进 Modal 主区。
    // 保留 class 以便以后按需补 CSS，高级 Setting 仍挂 advBody 子 div；
    // 改后 JS 节点依赖仍在（Setting 构造、异步 loadData、chip 渲染都不依赖 advancedEl 是哪种 tag）。
    this.advancedEl = this.formEl.createDiv({ cls: "mini-flow-idea-advanced" });
    const advBody = this.advancedEl.createDiv();
    // 唯一活跃档没有可切换项 → 状态区改只读说明（2026-11-12 收敛）。
    // 文案仍由 activeStatuses 驱动，将来加档时只改这里。
    const activeLabels = this.activeStatuses.map((s) => s.label).join(" / ");
    this.statusSetting = new Setting(advBody)
      .setName(_t("common.status", "状态"))
      .setDesc(`${activeLabels}（唯一活跃档，capture 固定写它）`);
    // 2026-11-23 砍 topic：主题区已删，状态 Setting 直接挂在高级区。
    // 高级区仅保留状态 chip（2026-09-14 取消「测试任务」toggle 后）。

    // 提交按钮。
    new Setting(this.formEl)
      .addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()))
      .addButton((btn) => {
        btn.setButtonText("创建").setCta().setDisabled(true);
        btn.onClick(() => this.submit());
        this.submitBtn = btn;
      });
    this.refreshSubmit();

    this.loadData();
  }

  async loadData() {
    let data;
    try {
      data = await this.opts.loadData();
    } catch (e) {
      new Notice(`Idea 数据加载失败: ${String(e).slice(0, 160)}`);
      this.close();
      return;
    }
    if (!this.formEl || !this.formEl.isConnected) return;
    const { domainChoices } = data;
    const { state } = this.opts;
    this.domainChoices = domainChoices;
    this.ready = true;
    this.refreshSubmit();

    // 2026-11-23 砍 topic：此处原渲染主题两层 chip（_ui.createTopicSection），现已下线。
    // capture 弹框回到纯推断——domain 本就无 UI(2026-09-14 起)，
    // 用户 2026-11-23 明确决定**不补** domain 选择器，改域走 `mf.js set --domain`。

    this.refreshInfer(true);
  }

  // 实时推断节流：180ms debounce。
  scheduleInfer() {
    if (this._inferTimer) clearTimeout(this._inferTimer);
    this._inferTimer = setTimeout(() => this.refreshInfer(), 180);
  }

  refreshInfer(force) {
    if (!this.ready) return;
    const raw = this.nameInputEl ? this.nameInputEl.value : "";
    // 推断按"提交后会被保留的语义标题"走，与 cleanTitle 同源：
    // 否则用户输入 `#popup 调研 [[旧任务]] [qy:: 1]` 这类被剥的元数据
    // 会污染 topic/domain/status/test 命中，frontmatter 与 README 文件名错位。
    const name = this.opts.cleanTitle ? this.opts.cleanTitle(raw) : raw;
    const { state } = this.opts;

    const inferredDomain = this.opts.infer.inferDomain(name, this.domainChoices);

    // 领域：未锁定时实时覆盖 state.domainChoice；锁定后保留手动钉住的域。
    if (!state.domainLocked || force) {
      if (inferredDomain) {
        state.domainChoice = inferredDomain;
      }
    }
    // 状态无自动推断（2026-09-14 删 inferStatus 后）：固定 active，
    // refreshInfer 不再覆盖 state.status。

    // 领域后台推断继续跑（state.domainChoice 由 inferDomain 维护），
    // 但 capture 入口不渲染领域 chip——领域 chip 仅在 task-edit 暴露。
  }

  // capture 入口不渲染领域 chip（2026-09-14）；renderDomainChip / toggleDomainChip /
  // openDomainPopup / closeDomainPopup / _domainChoicesReady 全删。
  // 领域后台推断仍跑：inferDomain 维护 state.domainChoice，onSubmit 写入 README frontmatter。
  // 任务编辑场景改领域走 task-edit.js 领域 chip + popup（同名代码未删）。

  refreshSubmit() {
    if (!this.submitBtn || !this.nameInputEl) return;
    this.submitBtn.setDisabled(!this.ready || !this.nameInputEl.value.trim());
  }

  // 2026-11-12：状态只剩唯一活跃档 active，弹框不再提供切换 → setStatus /
  // refreshStatus（状态 chip 高亮）连同 statusBtns 一并删除。

  submit() {
    if (!this.ready) return;
    // submit 时再算一次防御 race / override 状态。
    this.refreshInfer(true);
    const v = this.nameInputEl ? this.nameInputEl.value : "";
    this.opts.onSubmit(v);
  }
}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}