"use strict";
const obsidian = require("obsidian");
const { Plugin, Notice, Modal, Setting, MarkdownRenderChild } = obsidian;
// Mini Flow（插件 id `miniflow`，2026-11-20 由 `mini-flow-index` 改名）：
// 一个插件承载全部 Mini Flow 职责，功能模块由 flow/config/miniflow.json 的
// `modules` 开关（设置页可改）决定启不启用——云效 / qy 半边就是其中一个模块。
//
// 职责一：folder 任务 README 的 `## 文件索引` 段自动维护器。
//
// 手动 task-refresh-index 靠人按；Obsidian 没有常驻 QuickAdd 槽位。本插件挂三个事件补齐：
//   - workspace.on('file-open')：打开 folder 任务内任意文件
//   - vault.on('create' | 'delete' | 'rename')：folder 内文件增删改（含 AI/脚本/git 落盘）
// 命中后按 folder 去抖 400ms 再重写 README 哨兵段，写入逻辑与 task-refresh-index.js
// 共用 flow/scripts/quickadd/mini/_index.js，walk 逻辑共用同目录 _walk.js（均字符串加载，
// 跟 QuickAdd 沙盒同模式——文件在 vault 里而非插件目录，require 解析不到）。
//
// 静默写盘：内容没变不写（压住 iCloud 重传）；README 正处于活动编辑器时跳过（避免光标跳/
// 覆盖未保存改动），此时按命令 "Mini Flow: 刷新当前任务索引" 手动补。
//
// 第二职责（2026-10-09 起）：给 QuickAdd 用户脚本补上 obsidian 模块（见下方
// installObsidianRequireShim）。Mini Flow 的弹框命令全靠它，故与索引维护同属「让
// vault 侧脚本跑得起来」这一件事，不另立插件。
//
// 第三职责（2026-10-28 起）：folder 任务 README 的 tab 标题显示任务名（见下方
// installTaskTitlePatch）。任务入口文件全叫 README.md，tab 标题撞名分不出任务；
// 在标题渲染出口换显示名，不动盘面。
//
// 本开源包**不含**外部工作项平台集成模块（同步卡渲染 + 四个事实队列消费）：
// 导出时按锚点整段裁掉，设置页只留一个不产生效果的开关位。写面仍是同一批
// flow/scripts/quickadd/mini/ 脚本，没有第二份里程碑 / 结案实现。

const WALK_PATH = "flow/scripts/quickadd/mini/_walk.js";
const INDEX_PATH = "flow/scripts/quickadd/mini/_index.js";
// 任务 folder 根判定复用 _task.js 的 taskFolderPrefixOf（字符串加载，同沙盒模式）：
// 它识别 <月目录>/<名> 并排除 <月目录>/W<周>/ 周记目录，避免把周记夹当任务 folder。
const TASK_PATH = "flow/scripts/quickadd/mini/_task.js";
// convertIdeaToTask 用到的 helper（与 task-capture.js 加载清单对齐——同一批文件，
// 不再散落写）。flow 路径全部从 vault 根写起，strings 加载走 vault.adapter。
const NAMING_PATH = "flow/scripts/quickadd/mini/_naming.js";
const CAPTURE_PATH = "flow/scripts/quickadd/mini/_capture.js";
const WORKFLOW_PATH = "flow/scripts/quickadd/mini/_workflow.js";
const INFER_PATH = "flow/scripts/quickadd/mini/_infer.js";
const STATUS_PATH = "flow/scripts/quickadd/mini/_status.js";
const UI_PATH = "flow/scripts/quickadd/mini/_ui.js";
// 建任务成功后把 README 全路径写进剪贴板（与 task-capture.js 同一实现、同一行为）。
const CLIPBOARD_PATH = "flow/scripts/quickadd/mini/_clipboard.js";
// 闪念数据 + 局部刷新事件名。Home.md 闪念块（dataviewjs）已监听这个事件，
// 改后只局部重绘自己，不触发 Dataview 索引 / 不走 Vault 的 modify 事件。
const IDEAS_PATH = "flow/ideas-home.txt";
const IDEAS_CHANGED_EVENT = "miniflow:ideas-changed";
// 功能模块开关：配置落 vault 文件（不是纯插件设置）——插件与将来 vault 侧脚本两边
// 都读得到，这与阶段 2「抽配置层」是同一份真源。缺文件 / 解析失败一律走默认值
// （全部开启），保证升级或手滑删掉配置不会让功能静默消失。
const MODULES_CONFIG_PATH = "flow/config/miniflow.json";
const MODULE_DEFAULTS = {
  yunxiao: true,          // 云效 / qy 集成：qy sync 卡 + 四个旁车队列消费
  indexMaintenance: true, // README 文件索引段自动维护
  requireShim: true,      // 给 QuickAdd 用户脚本补 obsidian 模块（三个弹框命令靠它）
  tabTitle: true,         // folder 任务 README 的 tab 标签显示任务名
  homeCards: true,        // Home 卡 api（homeActiveNodes 等 + fillable 登记）
  launchClaude: true,     // ▶ 按钮起 claude 会话
};


const FINISH_PATH = "flow/scripts/quickadd/mini/_finish.js";
// 月度 Capture 行改写的唯一实现（2026-11-19 写面收敛）：_finish.js#rewriteStatusLine
// 只是它的转调壳，字符串加载没有 require，所以调用方装载后注入。
const LINE_REWRITE_PATH = "flow/scripts/quickadd/mini/_capture-line-rewrite.js";
const HOME_FIELDS_PATH = "flow/scripts/quickadd/mini/_home-fields.js";
// Task Finish 的**编排**（唯一一份，含定位月度行 / 反查 README / 进展收口 / 写两处写面）：
// 人点的 Task Finish 与下面的 headless 命令都走它，交互（确认框、关 tab）由各入口注入。
const TASK_FINISH_GUI_PATH = "flow/scripts/quickadd/mini/task-finish-gui.js";
const CAPTURE_LINE_PATH = "flow/scripts/quickadd/mini/_capture-line.js";
const YAML_PATH = "flow/scripts/quickadd/mini/_yaml.js";
// 启动 claude 会话的单源（与 QuickAdd 宏 Open Claude 共用）：Home「🏠 工作事务」行内 ▶ 按钮走它。
const LAUNCH_PATH = "flow/scripts/quickadd/mini/_launch-claude.js";
// Home 首行那一个两栏网格（含 [!proposed] 卡的那个 [!cols]）：右栏「自适应填满」按它量行高。
const HOME_GRID_SELECTOR =
  '.miniflow-home .callout[data-callout="cols"]:has(> .callout-content > .callout[data-callout="proposed"])';
// 任务 README 的 tab 标题映射（纯函数，裸 node 可测）：_tab-title.js#taskLabelForReadmeFile。
const TAB_TITLE_PATH = "flow/scripts/quickadd/mini/_tab-title.js";
// ---------- 行为参数（去抖 / 节流），可被 flow/config/miniflow.json 的 behavior 组覆盖 ----------
// 默认值在这里，插件 onload 读配置后 Object.assign 进来；设置页改配置时同步更新本对象
// 所以**无需重载**——setTimeout 的延迟是在调用那一刻求值的，改完下一次调度就用新值。
// 放成对象而不是散落的 const，是为了让「可配」这件事只有一个落点：加一项 = 加一个键。
const BEHAVIOR_DEFAULTS = {
  indexDebounceMs: 400,        // folder 任务内文件增删 → 索引段重写的去抖
  titleDebounceMs: 120,        // tab 标题刷新（比索引短：标题是即时反馈，等久了像没生效）
  drainDebounceMs: 800,        // 四个旁车队列（合并/回归/转出/变更）drain 的去抖，四条同值合成一项
  qyCardFocusDebounceMs: 500,  // qy sync 卡的回焦重绘兜底（归云效模块，随 modules.yunxiao 一起关）
};
const BEHAVIOR = { ...BEHAVIOR_DEFAULTS };

// ---------- 运行环境适配：把 obsidian 模块接进 window.require ----------
// Obsidian 只在「插件」的 main.js 里注入 obsidian 模块别名；插件之外（devtools /
// dataviewjs / Templater / QuickAdd 用户脚本）require("obsidian") 一律抛
// `Cannot find module 'obsidian'`。官方论坛 "Expose obsidian module to be used
// outside plugins"(#49988) 帖 #1 原文即此结论。
//
// QuickAdd 的脚本加载器恰好把 window.require 原样透传给用户脚本：
//     let o = g => window.require && window.require(g);
//     new Function("require", "module", "exports", code)(o, mod, exp)
// 于是 flow/scripts/quickadd/mini/ 下 task-capture / task-edit / topic 三个命令
// （连它们经 loadHelper 字符串加载的 _ui.js 里那次 require）全部在**加载期**就失败，
// 报 `QuickAdd could not load .../X.js because it could not find the required
// module "obsidian"`——命令面板里按下去只弹这一句，弹框根本不出现。
//
// 本插件是 vault 自有插件、跑在插件上下文里，能拿到真模块；把 "obsidian" 这一条接进
// window.require 的解析链，四处调用一并复通，脚本侧零改动。选择改全局而非改四个脚本：
// ① 脚本侧要在顶层「解构出 Modal 给 class extends 用」，没有能兜住 require 抛错的写法；
// ② QuickAdd 之后新增/升级用户脚本时不用再记得补一次。
// 卸载时还原，不给下一个会话留改过的全局。
const OBSIDIAN_MODULE = obsidian;

function installObsidianRequireShim() {
  if (typeof window === "undefined" || typeof window.require !== "function") return null;
  const original = window.require;
  // 其余 id 原样转交，且保持原来的调用形态（this/arguments 都不动），对既有调用方透明。
  const shim = function (id) {
    if (id === "obsidian") return OBSIDIAN_MODULE;
    return original.apply(this, arguments);
  };
  try {
    window.require = shim;
    if (window.require !== shim) {
      // 只读属性：退回 defineProperty 再试一次。
      Object.defineProperty(window, "require", { value: shim, writable: true, configurable: true });
    }
  } catch (e) {
    console.error("[miniflow] window.require 不可接管，QuickAdd 用户脚本仍会取不到 obsidian 模块：", e);
    return null;
  }
  return window.require === shim ? original : null;
}

function restoreObsidianRequire(original) {
  if (!original) return;
  try {
    window.require = original;
  } catch (e) {
    // 还原失败只是留个包装层，不影响 Obsidian 退出，不往外抛。
  }
}

// ============================================================
// 第三职责：folder 任务 README 的 tab 标题显示任务名（2026-10-28 起）
//
// 问题：Obsidian 的 tab 标签与窗口标题都取自显示名，folder 任务的入口文件一律叫
// README.md，于是同时开几个任务就有几个一模一样的「README」标签，靠标题分不出是
// 哪个任务。
//
// 为什么不在文件名上动手：入口文件名是盘面事实——<任务目录>/README.md 被 20 处脚本
// 硬编码（_task.js / _walk.js / _index.js / task-upgrade / 外部同步 CLI 的 yunxiao 物化
// 等）、被 Capture 行的 [[…/README|标题]] 短链指着。改 80+ 个目录的文件名是全仓级
// 迁移，收益（标签好看）远小于代价（红链 + 脚本 + 跨仓）。文件名是现状数据，标题是
// 渲染出口——在出口处换显示名即可，一个字节的盘面都不动。
//
// 只改 tab 标签与窗口标题，**不碰视图头部标题与 inline title**：这两个都是 Obsidian
// 的改名框（contenteditable，失焦/回车即把当前文件改成框里的文字，见
// FileView#onOpen → titleEl.contentEditable="true" → onTitleBlur → saveTitle →
// fileManager.renameFile）。把任务名塞进去，用户点一下标题再点到别处，README.md 就被
// 改名成任务名——folder 任务的锚点当场废掉、Capture 短链全红。
//
// 打点选 WorkspaceLeaf#getDisplayText()：tab 标签（leaf.updateHeader 读它）与窗口
// 标题（app.getAppTitle(leaf.getDisplayText())）都走这一个出口，而 FileView 的
// 同名方法只喂视图头部/inline title（改名框），正好不重叠。副作用是视图头部仍显示
// README，与 tab 不一致——但那里是改名入口，保它原样是刻意取舍。
//
// 已开的 tab 不会自动变：workspace.json 里存着旧的 title 字段，重启后由 Obsidian
// 自己 setViewState 恢复。所以装补丁后要主动刷一遍所有 leaf 的 tab 头，并在
// file-open / rename / layout-change 时再刷。
//
// 还原：onunload 恢复原函数，插件停用即回到 Obsidian 默认行为。
// ============================================================

// leaf 的显示名 → 任务目录名；非任务 README → 空串（空串 = 不接管）。
// 只管 markdown 视图：sidebar 的「大纲」「属性」等 leaf 虽然 state 里也带 file 路径，
// 但那是它跟随的文件、不是它自己的显示对象，套用会得出错误标题。
//
// 两条取值路径：
// - 已加载的 tab：view.file 直接可用。
// - 启动时恢复但还没点开的 tab（Obsidian 用占位视图 rI 延迟加载）：view.file 为空、
//   显示名是 workspace.json 里存下的 title（装补丁前存的是 README）。这时从
//   leaf.getViewState().state.file 取路径查 vault，才能把老状态一起纠正，
//   不必等用户逐个点开。
//
// 注意 getViewState() 内部会读 getDisplayText()（存 title 字段用）——本函数是从
// getDisplayText 的 wrapper 里调的，所以必须防重入：再加一层判断会更省事，但那个
// 递归会无限展开。用模块级开关挡住：重入时直接返回空串走原逻辑。
let inTaskTitleResolve = false;

function taskTitleForLeaf(app, leaf, taskLabelForReadmeFile, taskFolderPrefixOf) {
  if (!leaf || inTaskTitleResolve) return "";
  const view = leaf.view;
  try {
    if (!view || view.getViewType() !== "markdown") return "";
  } catch (e) {
    return "";
  }
  let file = view.file;
  if (!file) {
    inTaskTitleResolve = true;
    let path = "";
    try {
      const state = typeof leaf.getViewState === "function" ? leaf.getViewState() : null;
      path = (state && state.state && state.state.file) || "";
    } catch (e) {
      path = "";
    } finally {
      inTaskTitleResolve = false;
    }
    if (!path) return "";
    file = app.vault.getAbstractFileByPath(path);
  }
  if (!file || file.basename !== "README") return "";
  const parentPath = file.parent ? file.parent.path : "";
  if (!parentPath) return "";
  return taskLabelForReadmeFile(
    { basename: file.basename, parentPath },
    taskFolderPrefixOf,
  );
}

// 刷一个 leaf 的 tab 头。只调 updateHeader（它读 leaf.getDisplayText）、
// 不改 titleEl / inlineTitleEl——那两个是改名框。
function refreshLeafTitles(leaf) {
  if (!leaf) return;
  try {
    if (typeof leaf.updateHeader === "function") leaf.updateHeader();
  } catch (e) {
    // 单个 leaf 刷失败不该连累其它 leaf。
  }
}

// 装标题 patch。返回还原函数（供 onunload 调用）。
function installTaskTitlePatch(app, taskLabelForReadmeFile, taskFolderPrefixOf) {
  const WorkspaceLeaf = obsidian.WorkspaceLeaf;
  if (!WorkspaceLeaf || !WorkspaceLeaf.prototype || typeof WorkspaceLeaf.prototype.getDisplayText !== "function") {
    return null;
  }
  const proto = WorkspaceLeaf.prototype;
  const original = proto.getDisplayText;
  const wrapper = function () {
    try {
      const label = taskTitleForLeaf(app, this, taskLabelForReadmeFile, taskFolderPrefixOf);
      if (label) return label;
    } catch (e) {
      // 取不到就按原逻辑走，别让标签渲染因为一个判断失败。
    }
    return original.apply(this, arguments);
  };
  proto.getDisplayText = wrapper;

  // 刷一遍所有已开的 leaf（启动时恢复的 tab、切换过的 tab 都要）。
  const refreshAll = () => {
    app.workspace.iterateAllLeaves((leaf) => refreshLeafTitles(leaf));
    // 窗口标题（document.title）取自活动 leaf 的 getDisplayText，改完要单独刷。
    if (typeof app.workspace.updateTitle === "function") app.workspace.updateTitle();
  };

  return {
    refreshAll,
    restore() {
      if (proto.getDisplayText === wrapper) proto.getDisplayText = original;
    },
  };
}

// ============================================================
// ConvertIdeaModal：与 task-capture.js#IdeaModal 同形态，仅两点差异——
//   (a) 任务名输入 setValue(state.title) 预填（cleaned 闪念文本）；
//   (b) Modal 不感知闪念删除：删除放在 modal.close() 之后，由 onConvertSubmit 调
//       deleteIdeaFromHome() 完成——避免「取消创建后闪念消失」事故（删除悲观）。
// class 体一律走 this. 注入的 STATUSES / applyChipHighlight / ui，与 task-capture
// 范式一致（_smoke.js#A6 回归断言保护）。
// ============================================================
class ConvertIdeaModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    // 注入：opts.STATUSES 是 2 态字典（active/finish）；activeStatuses 已在外层收窄到 active。
    this.STATUSES = opts.STATUSES;
    this.activeStatuses = Array.isArray(opts.activeStatuses) && opts.activeStatuses.length > 0
      ? opts.activeStatuses
      : opts.STATUSES.filter((s) => s.value === "active");
    this.applyChipHighlight = opts.applyChipHighlight;
    this.ui = opts.ui;
  }

  onOpen() {
    const { state } = this.opts;
    this.titleEl = this.contentEl.createEl("h2", { text: "闪念转任务", cls: "mini-flow-idea-title" });
    const form = this.contentEl.createDiv();
    this.formEl = form;

    // 任务名输入——预填 state.title（已 cleanTitle 剥过 #tag / wikilink）。其余与
    // task-capture 同款：IME 防御 + Enter 提交 + setTimeout focus + 实时刷新 Submit。
    let composing = false;
    const titleSetting = new Setting(form).setName("任务名");
    titleSetting.addText((text) => {
      text.setPlaceholder("任务名");
      text.setValue(state.title || "");
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
      text.onChange((v) => { state.title = v; this.refreshSubmit(); });
    });

    // 主题区：与 task-capture 同款 host + createTopicSection；topicChoices 在外层异步
  // 加载完再回填（modal 构造时 topicChoices 还是 null，先建空 host + 加载状态）。
  this.topicSettingsHost = form.createDiv({ cls: "mini-flow-topic-settings-host" });
  form.createEl("hr", { cls: "mini-flow-section-divider" });
  this.renderTopicChips();

  // 状态区：唯一活跃档没有可切换项 → 只读说明，与 task-capture 一致（2026-11-12 收敛）。
    const activeLabels = this.activeStatuses.map((s) => s.label).join(" / ");
    new Setting(form)
      .setName("状态")
      .setDesc(`${activeLabels}（唯一活跃档，capture 固定写它）`);

    new Setting(form)
      .addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()))
      .addButton((btn) => {
        btn.setButtonText("创建").setCta().setDisabled(!String(state.title || "").trim());
        btn.onClick(() => this.submit());
        this.submitBtn = btn;
      });
    this.refreshSubmit();
  }

  refreshSubmit() {
    if (!this.submitBtn) return;
    const v = this.nameInputEl ? this.nameInputEl.value : (this.opts.state.title || "");
    this.submitBtn.setDisabled(!String(v || "").trim());
  }

  // 2026-11-12：状态只剩唯一活跃档 active，弹框不再提供切换 → setStatus /
  // refreshStatus（状态 chip 高亮）连同 statusBtns 一并删除。

  // 主题 chips 渲染：convertIdeaToTask 异步回填 topicChoices 后调用；onOpen 时
  // topicChoices 尚未就绪，先建 host,再由本方法首跑 mount。
  renderTopicChips() {
    if (!this.topicSettingsHost) return;
    this.topicSettingsHost.empty();
    if (!this.opts.topicChoices || this.opts.topicChoices.length === 0) {
      this.topicSettingsHost.createSpan({
        text: "（暂无主题，先用 Topic 命令建）",
        cls: "mini-flow-topics-empty",
      });
      return;
    }
    this.ui.createTopicSection({
      host: this.topicSettingsHost,
      tree: this.ui.buildTopicTree(this.opts.topicChoices),
      state: this.opts.state,
      applyChipHighlight: this.applyChipHighlight,
    }).mount();
  }

  submit() {
    if (!this.submitBtn || this.submitBtn.disabled) return;
    const v = this.nameInputEl ? this.nameInputEl.value : "";
    this.opts.onSubmit(v);
  }
}

class MiniflowPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.timers = new Map(); // folder path -> timeout id
    this.pendingFolders = new Set(); // README 正开着被挡下刷新的任务目录，切走后补
    this.buildIndexBody = null;
    this.replaceOrInsertIndex = null;
    this.taskFolderPrefixOf = null;
  }

  async onload() {
    this.originalRequire = installObsidianRequireShim();
    this.buildIndexBody = await this.loadHelper(WALK_PATH, "buildIndexBody");
    this.replaceOrInsertIndex = await this.loadHelper(INDEX_PATH, "replaceOrInsertIndex");
    this.taskFolderPrefixOf = await this.loadHelper(TASK_PATH, "taskFolderPrefixOf");
    this.taskLabelForReadmeFile = await this.loadHelper(TAB_TITLE_PATH, "taskLabelForReadmeFile");
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.scheduleForFile(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.scheduleForFile(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.scheduleForFile(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => this.scheduleForFile(file)));
    // README 正开着时自动刷新会被挡（见 refreshFolder），切走活动文件后补刷这些挂起目录：
    // 覆盖「开着 README 拖文件进 input/」这类场景，不用再手动按命令。
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.flushPending()));

    // 第三职责（2026-10-28 起）：folder 任务 README 的 tab 标题显示任务名。
    // 详见上方 installTaskTitlePatch 的说明：改的是标题渲染出口，任务文件名不动。
    this.titlePatch = installTaskTitlePatch(
      this.app,
      this.taskLabelForReadmeFile,
      this.taskFolderPrefixOf,
    );
    if (this.titlePatch) {
      // 已开的 tab 不会自动变（workspace.json 存着旧 title），装完刷一遍。
      this.app.workspace.onLayoutReady(() => this.titlePatch.refreshAll());
      // 新开 / 重命名 / 布局变化后再刷：rename 会让任务目录名变（标题跟着变），
      // file-open 与 layout-change 覆盖「已开 tab 被切到」等路径。
      this.registerEvent(
        this.app.workspace.on("file-open", () => this.scheduleTitleRefresh()),
      );
      this.registerEvent(
        this.app.vault.on("rename", () => this.scheduleTitleRefresh()),
      );
      this.registerEvent(
        this.app.workspace.on("layout-change", () => this.scheduleTitleRefresh()),
      );
    } else {
      console.error("[miniflow] 找不到 WorkspaceLeaf.prototype.getDisplayText，tab 标题不改名");
    }

    this.addCommand({
      id: "refresh-now",
      name: "刷新当前任务索引",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const folder = this.findEnclosingTaskFolder(file);
        if (folder) this.refreshFolder(folder, { force: true });
        else new Notice("当前文件不在 folder 任务目录内");
      },
    });

    // 无确认的结案入口（2026-11-19）：MCP `command_execute` 只收 commandId，点不掉
    // task-finish-gui 里的 `window.confirm`（阻塞式原生对话框，调用方无法应答），所以给
    // headless 调用方单开一个命令。编排复用 task-finish-gui.js#runFinish——**唯一一份**，
    // 这里只注入「不确认 + 不动 tab」，盘面动作与人点 Task Finish 完全一致。
    // 用法（两步，`resolveTarget` 依赖活动文件）：先 open_file 打开任务 README，**再用
    // active_file_get_path 复核**（open_file 不保证把文件设为活动页），确认后调本命令；
    // 光标停在月度 Capture 行上同样成立。
    this.addCommand({
      id: "task-finish-headless",
      name: "Task Finish（无确认，供 MCP 调用）",
      callback: () => { void this.runHeadlessFinish(); },
    });

    // CLI（`mf.js`）写完盘后让 Obsidian 侧追上：命令面只补 CLI 做不到的事（2026-11-19 段 4）。
    // 无参、无确认，供 MCP `command_execute` 调；结果发一条 Notice（后台动作没有盘面反馈）。
    this.addCommand({
      id: "mf-reindex",
      name: "MF 重建索引（CLI 写盘后调用，供 MCP）",
      callback: () => { void this.runMfReindex(); },
    });

    // 云效 / qy 集成模块：**本开源包不含**。上游私有部署里它是一个功能模块，
    // 由 flow/config/miniflow.json 的 modules.yunxiao 开关闸住注册；开源包在导出时
    // 把整段代码裁掉了，开关因此只剩一个空位（设置页会标明）。
    // 暴露 convertIdeaToTask 给 Home.md 闪念块（dataviewjs 内）调用：经
    // `app.plugins.plugins["miniflow"].api.convertIdeaToTask(text)` 一行
    // 触发，弹 Mini Flow 同形态 Modal，创建成功后删该闪念。详见 onConvertSubmit。
    // home* 四个是 Home 卡的**直读 md 读面**（2026-11-18）：工作事务卡与外部依赖卡原走
    // Dataview 的 dv.pages，flow/data 下任何 md 变动都 bump index.revision → 整块清空重建、
    // 卡面间歇性闪烁。改由卡内自控重绘后，取数收口到这里（判据共用一套，不各写一份）。
    // 2026-11-19 起外部依赖并入工作事务卡、独立 ⛔ 卡已删，homeDepTasks 只服务卡尾兜底差集。
    // launchClaude 是**动作**不是读面（2026-11-19）：Home 活跃卡任务行尾的 ▶ 按钮调它，
    // 在该任务根起一个全新 claude 会话。实现单源在 _launch-claude.js（QuickAdd 宏 Open
    // Claude 共用同一份），这里只做字符串加载 + 失败收口成 Notice（成功不发 Notice——
    // 新终端 tab 自己就是反馈，见 flow/CLAUDE.md「Mini Flow 命令的 Notice 策略」）。
    // Mini Flow 的 16 个动作：原先只以 QuickAdd 宏存在（`quickadd:choice:*`，而宏定义
    // 写在不进仓的 data.json 里——开源用户拿到脚本也注册不出来）。这里用插件命令再暴露
    // 一遍：命令面板搜得到、设置里能绑快捷键、不依赖 QuickAdd。
    // 与 QuickAdd 那份**并存**（两套 id）→ 2026-11-20 起 QuickAdd 侧的宏已删除
    // （备份在任务 input/quickadd-data-before-remove-macros.json），命令面只剩下面这些。
    //
    // 键位用 addCommand 的 hotkeys 声明（Obsidian 的「插件默认键」机制）：进仓、开源用户
    // 装上就有，且用户在 设置→快捷键 里改了就覆盖它——比把键写死在 hotkeys.json 里干净。
    // 风格沿用原有两条（Mod+字母）；次要动作走 Mod+Shift / Mod+Alt，减少与 Obsidian
    // 默认键和其它插件的碰撞。**可能仍有冲突**，设置→快捷键里红色标出的自行改。
    const ACTIONS = [
      // [命令 id, 显示名, 脚本文件, [修饰键, 主键] | null]
      ["task-capture", "Task Capture", "task-capture.js", [["Mod"], "T"]],
      ["idea-capture", "Idea Capture", "idea-capture.js", [["Mod"], "I"]],
      ["task-edit", "Task Edit", "task-edit.js", [["Mod", "Shift"], "E"]],
      ["task-finish", "Task Finish", "task-finish-gui.js", [["Mod", "Alt"], "F"]],
      ["task-delete", "Task Delete", "task-delete.js", [["Mod", "Shift"], "D"]],
      ["task-search", "Task Search", "task-search.js", [["Mod", "Shift"], "S"]],
      ["progress-checkin", "Progress Checkin", "progress-checkin.js", [["Mod", "Shift"], "P"]],
      ["open-claude", "Open Claude", "open-claude.js", [["Mod", "Shift"], "C"]],
      ["open-finder", "Open Finder", "open-finder.js", [["Mod", "Shift"], "O"]],
      ["topic", "Topic", "topic.js", [["Mod", "Shift"], "K"]],
      ["task-upgrade", "Task Upgrade", "task-upgrade.js", [["Mod", "Shift"], "U"]],
      ["rule-capture", "Rule Capture", "rule-capture.js", [["Mod", "Alt"], "C"]],
      ["rule-validate", "Rule Validate", "rule-validate.js", [["Mod", "Alt"], "V"]],
      ["rule-promote", "Rule Promote", "rule-promote.js", [["Mod", "Alt"], "P"]],
      ["rule-deprecate", "Rule Deprecate", "rule-deprecate.js", [["Mod", "Alt"], "D"]],
      ["md2epub", "MD2EPUB", "md2epub.js", [["Mod", "Alt"], "E"]],
    ];
    for (const [id, name, file, hotkey] of ACTIONS) {
      this.addCommand({
        id,
        name,
        // hotkeys 是数组形态（Obsidian 允许一个命令绑多组键）；没有预设的传空数组。
        hotkeys: hotkey ? [{ modifiers: hotkey[0], key: hotkey[1] }] : [],
        callback: () => { void this.runUserScript(file); },
      });
    }

    // 默认值以共享仓的 `_config.js` 为准：本文件的 BEHAVIOR_DEFAULTS 只是「配置读不到时」
    // 的兜底，两份默认值必然漂（本次就漂了——behavior 组加了 progressSoftLimit 等 3 键，
    // 这份还只有 4 个去抖项，设置页读到的兜底值会不对）。启动时用 _config.js 的
    // DEFAULTS.behavior 覆盖一遍，于是**真默认值只有一份**。
    try {
      const cfgMod = await this.loadModule("flow/scripts/quickadd/mini/_config.js");
      if (cfgMod && cfgMod.DEFAULTS && cfgMod.DEFAULTS.behavior) {
        Object.assign(BEHAVIOR_DEFAULTS, cfgMod.DEFAULTS.behavior);
      }
    } catch (_e) { /* 读不到 _config.js 就用本地兜底，不拦 onload */ }
    // 行为参数（去抖 / 节流）：读一次灌进模块级 BEHAVIOR 覆盖默认值。之后设置页改配置
    // 走 writeBehaviorConfig 会再灌一次，所以改完不必重载插件。
    Object.assign(BEHAVIOR, await this.readBehaviorConfig());
    this.addSettingTab(new MiniflowSettingTab(this.app, this));

    this.api = {
      convertIdeaToTask: (text) => this.convertIdeaToTask(text),
      homeCaptureRows: () => this.homeCaptureRows(),
      homeActiveNodes: () => this.homeActiveNodes(),
      homeTaskFields: (path) => this.homeTaskFields(path),
      homeDepTasks: () => this.homeDepTasks(),
      homeDomainLabels: () => this.homeDomainLabels(),
      launchClaude: (vaultPath) => this.launchClaude(vaultPath),
      // Home 右栏「自适应填满」（2026-11-19）：卡片登记自己，本模块按网格行高调条目数。
      registerFillable: (spec) => this.registerFillable(spec),
      fitHomeCards: () => this.fitHomeCards(),
    };
    // 域配置改了（加域 / 改 label、work）→ 领域标签缓存失效。缓存只服务 Home 分组标题与
    // 「工作域优先」排序，键少、重算便宜，没必要做增量。
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file && /(^|\/)flow\/data\/domains\/[^/]+\/flow\.json$/.test(file.path)) {
          this._homeDomainLabels = null;
        }
      }),
    );
  }

  // ============================================================
  // launchClaude(vaultPath)：在给定任务的目录里起一个全新 claude 会话。
  //
  // 调用方 = Home「🏠 工作事务」活跃卡任务行尾的 ▶ 按钮（Home.md 的 renderNode）。
  // `vaultPath` 是 capture 行的 linkTarget（vault 相对、不带 .md，folder 任务形如
  // `flow/data/YYYY/Qn/MM/<任务>/README`）——上抬到任务根、会话名取任务目录名的判据在
  // `_launch-claude.js#resolveTarget`（纯函数带单测），别在这里再写一份路径规则。
  //
  // 失败收口成 Notice：插件是唯一能稳定拿到 Notice 的上下文（QuickAdd 沙盒与字符串加载
  // 两处的可见性不一样），所以文案单源放这里。成功不发 Notice——新终端 tab 就是反馈。
  // ============================================================
  async launchClaude(vaultPath) {
    if (!this._launchClaude) this._launchClaude = this.loadModule(LAUNCH_PATH);
    const mod = await this._launchClaude;
    try {
      await mod.launchClaude({ app: this.app, vaultPath });
    } catch (e) {
      new Notice(`启动 Claude 失败：${String((e && e.message) || e).trim().slice(0, 200)}`, 6000);
    }
  }

  // ============================================================
  // Home 右栏「自适应填满」（2026-11-19）。
  //
  // 现象：首行两栏网格里，右栏四张卡（闪念 / 云效 / 待复盘 / 溯源链）被网格拉伸到与
  // 左栏工作事务卡同高，而卡内条目远不够 → 卡片下半截一片空白，平面利用率低。
  //
  // 机制（不动 CSS）：网格默认 align-items: stretch，卡片盒高 = 所在行高。行高由「跨四行
  // 的左栏卡（= 整列总高 A）」与右栏各卡的自然高共同分摊：
  //     行高_i ≈ 自然高_i + (A − Σ自然高) / 4
  // 多出来的那份就是各卡内部的空白。于是：
  //   · 某张卡多显示条目 → 它的自然高涨 → Σ自然高涨 → **其余卡的行高降** → 那些卡内部
  //     的空白跟着变小；被填的那张自己也不再留白。
  //   · 总量守恒（A 不变）→ 空白从「填不动的卡」挪到「有内容可加的卡」，后者填满即消。
  //
  // 谁能被填：条目可增减的卡（闪念 / 规则待复盘）自己登记成 fillable；云效 / 溯源链内容
  // 固定，只能吃剩下的空白。
  //
  // 谁来做：卡自己的 dataviewjs 块登记（api.registerFillable），本模块只管排版——条目从哪
  // 来、最新优先、渲染条数上限的语义都在各块里，这里不重复实现。
  // 触发：登记时 + 网格尺寸变化时（ResizeObserver：别的卡画完、窗口缩放都走它）。
  // ============================================================
  registerFillable(spec) {
    if (!spec || !spec.card || typeof spec.rows !== "function") return;
    if (!this._fillables) this._fillables = new Map();
    this._fillables.set(spec.card, spec);
    this.scheduleFit();
  }

  scheduleFit() {
    if (this._fitTimer) return;
    this._fitTimer = window.setTimeout(() => {
      this._fitTimer = null;
      try {
        this.fitHomeCards();
      } catch (e) {
        console.warn("[miniflow] Home 填满失败:", e);
      }
    }, 80);
  }

  // 按左栏总高给右栏「可增减条目」的卡分配预算，再据此定显示条数。
  //
  // 关键：预算**自己算**，不读网格当前的分摊值。网格行高是 auto 的，跟内容互相决定
  // （内容多 → 行高涨 → 可用高度涨 → 又能多显示几条），拿当前行高当目标会自锁：卡一空，
  // 行高就缩回分摊值，于是永远填不满（第一版就栽在这，仿真里表现为「填完反而只剩 2 条」）。
  // 改成直接拿左栏工作事务卡的自然高度 A 当总高：
  //     预算 = A − 固定卡自然高 − 可填卡的固定开销 − 行距
  // 预算在可填卡之间分掉，各卡取「累计高 ≤ 份额」的最大前缀 → 右栏自然总高 ≈ A → 网格
  // 没有富余 → 每张卡都不留内部空白（总量守恒：多显示的条目正是从别处挪来的空白）。
  fitHomeCards() {
    if (!this._fillables || !this._fillables.size) return false;
    const grid = this.observeHomeGrid();
    if (!grid) return false;
    const cards = Array.from(grid.querySelectorAll(":scope > .callout-content > .callout"));
    const left = cards.find((c) => c.getAttribute("data-callout") === "tasks");
    if (!left) return false;
    const right = cards.filter((c) => c !== left);
    // Home 换了 tab / 重画后，卡片元素会换新的：把已脱离文档的旧登记清掉，别让 Map 越积越多。
    for (const [card] of this._fillables) {
      if (!card.isConnected) this._fillables.delete(card);
    }
    const specs = [];
    for (const c of right) {
      const s = this._fillables.get(c);
      if (s) specs.push(s);
    }
    if (!specs.length) return false;

    // A = 左栏工作事务卡的自然高度 = 整列总高。
    const total = this.naturalHeight(left);
    // 固定卡（云效 / 溯源链）内容固定，只占位、填不动。
    let fixed = 0;
    for (const c of right) {
      if (!this._fillables.has(c)) fixed += this.naturalHeight(c);
    }
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;

    const measured = specs.map((s) => this.measureFillable(s)).filter(Boolean);
    if (!measured.length) return false;

    // 固定开销：卡头 + 内边距 + 卡尾提示行。
    let chromeSum = 0;
    for (const m of measured) chromeSum += m.chrome + m.hintH;
    let budget = total - fixed - chromeSum - gap * Math.max(0, right.length - 1);
    if (!(budget > 0)) budget = 0;

    // 先平分预算，各卡取「累计高 ≤ 份额」的最大前缀。
    const share = budget / measured.length;
    const counts = measured.map((m) => this.prefixFor(m, share));
    // 余量（某卡条目不够、用不完份额）轮流让给还能加行的卡。
    let totalUsed = measured.reduce((s, m, i) => s + this.contentFor(m, counts[i]), 0);
    let moved = true;
    while (budget - totalUsed > 0.5 && moved) {
      moved = false;
      for (let i = 0; i < measured.length; i++) {
        const m = measured[i];
        if (counts[i] >= m.rows.length) continue;
        const prev = counts[i] > 0 ? m.bottoms[counts[i] - 1] : m.firstTop;
        const step = m.bottoms[counts[i]] - prev;
        if (totalUsed + step > budget) continue;
        totalUsed += step;
        counts[i]++;
        moved = true;
      }
    }

    // 应用：至少留 3 行（一张卡只挂 1 行看着像坏了）；预算不够时宁可右栏略高于左栏，
    // 也不把左栏撑出空白。
    const MIN_ROWS = 3;
    let changed = false;
    for (let i = 0; i < measured.length; i++) {
      const m = measured[i];
      const n = Math.max(MIN_ROWS, Math.min(m.rows.length, counts[i]));
      const diff = m.rows.some((r, k) => (r.style.display === "none") !== (k >= n));
      m.rows.forEach((r, k) => { r.style.display = k < n ? "" : "none"; });
      if (diff) {
        changed = true;
        if (specs[i].onCount) specs[i].onCount(n, m.rows.length);
      }
    }
    // 提示行这时才显形（占回 20 来像素），再补算一轮把这点偏差收掉。
    if (changed) this.scheduleFit();
    return changed;
  }

  // 卡内容区各子块的高度和 = 卡的自然高度（卡片被网格拉伸时，卡内多出来的空白不算进去）。
  naturalHeight(card) {
    const contentEl = card.querySelector(":scope > .callout-content");
    if (!contentEl) return card.getBoundingClientRect().height;
    let h = 0;
    for (const ch of contentEl.children) {
      const cs = getComputedStyle(ch);
      h += ch.getBoundingClientRect().height
        + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    }
    return h;
  }

  // 量一张可填卡：行元素、每行底（几何位置，margin 折叠已含在内）、固定开销、提示行高。
  measureFillable(spec) {
    const card = spec.card;
    const contentEl = card.querySelector(":scope > .callout-content");
    const rows = spec.rows();
    if (!contentEl || !rows.length) return null;
    // 卡或行已被换掉（闪念重绘、任务被删）→ 这次的登记作废，别去量脱离文档的节点。
    if (!card.isConnected || !rows[0].isConnected) return null;
    const cardCs = getComputedStyle(card);
    const contentCs = getComputedStyle(contentEl);
    const titleEl = card.querySelector(":scope > .callout-title");
    const titleH = titleEl ? titleEl.getBoundingClientRect().height : 0;
    const chrome = (parseFloat(cardCs.paddingTop) || 0) + (parseFloat(cardCs.paddingBottom) || 0)
      + (parseFloat(contentCs.paddingTop) || 0) + (parseFloat(contentCs.paddingBottom) || 0)
      + titleH;
    // 全显示量行底：行高只跟容器宽有关，跟显示几条无关，量得准。用几何位置而不是
    // 各自 height + margin——相邻 li 的上下 margin 会折叠，两边都加会把间隙算重。
    rows.forEach((r) => { r.style.display = ""; });
    const firstTop = rows[0].getBoundingClientRect().top;
    const bottoms = rows.map((r) => r.getBoundingClientRect().bottom);
    const hint = typeof spec.hint === "function" ? spec.hint() : null;
    const hintH = hint ? hint.getBoundingClientRect().height : 0;
    return { rows, bottoms, firstTop, chrome, hintH };
  }

  // 前 n 行的累计高（相对第一行顶）。
  contentFor(m, n) {
    if (n <= 0) return 0;
    return m.bottoms[n - 1] - m.firstTop;
  }

  // 「累计高 ≤ 目标」的最大前缀条数。
  prefixFor(m, target) {
    let n = 0;
    for (let i = 0; i < m.rows.length; i++) {
      if (m.bottoms[i] - m.firstTop > target) break;
      n = i + 1;
    }
    return n;
  }

  // 盯住网格尺寸：别的卡画完（行高变）、窗口缩放，都要把填满状态重算一遍。
  observeHomeGrid() {
    const grid = document.querySelector(HOME_GRID_SELECTOR);
    if (!grid) return null;
    if (this._homeGrid === grid) return grid;
    if (this._homeFitObserver) this._homeFitObserver.disconnect();
    this._homeGrid = grid;
    this._homeFitObserver = new ResizeObserver(() => this.scheduleFit());
    this._homeFitObserver.observe(grid);
    return grid;
  }

  // ============================================================
  // Home 卡直读 md 读面（2026-11-18；2026-11-19 判据下沉）。
  //
  // 为什么在插件而不在 Home.md 的 dataviewjs 里写：多个块要同一套 frontmatter 解析，各写
  // 一份必然漂移（flow/CLAUDE.md 对「第二份实现」的判据）；插件已是 Home 卡渲染的统一入口
  // （flow/CLAUDE.md「Home 卡渲染的统一入口」段）。
  // **判据本体已下沉到 `flow/scripts/quickadd/mini/_home-fields.js`**（段 3 / P3）：
  // 下面四个 home* 只做「加载 + 缓存 + 注入 vault」，`mvp/mf.js query` 调同一份判据，
  // MCP 侧不必再自己解析 YAML。改判据去那个文件改，别在这里补第二份。
  // 每个函数都返回纯数据、不碰 DOM；重绘时机由 Home 卡自己（vault 事件 + 指纹）决定。
  // ============================================================

  // _yaml.js / _capture-line.js 只读一次：homeTaskFields 会对每条活跃任务各调一次，
  // 不缓存就是每次重绘把 helper 文件读几十遍。
  async homeYaml() {
    if (!this._homeYaml) this._homeYaml = this.loadModule(YAML_PATH);
    return this._homeYaml;
  }

  async homeCaptureLine() {
    if (!this._homeCaptureLine) this._homeCaptureLine = this.loadModule(CAPTURE_LINE_PATH);
    return this._homeCaptureLine;
  }

  // 判据本体（_home-fields.js）：与 CLI 同源，本文件只做缓存 + 注入。
  async homeFields() {
    if (!this._homeFields) this._homeFields = this.loadModule(HOME_FIELDS_PATH);
    return this._homeFields;
  }

  // 域配置（label / work）：Home 分组标题 +「工作域优先」排序用。带缓存，见 onload 里的失效监听。
  async homeDomainLabels() {
    if (this._homeDomainLabels) return this._homeDomainLabels;
    const fields = await this.homeFields();
    // paths 组：domainRoot 由配置给，缺键退回 _config.js 的默认（读不到 = {}，同效果）。
    const paths = ((await this.readConfigFile()).paths) || {};
    this._homeDomainLabels = await fields.domainLabels(this.app.vault, paths);
    return this._homeDomainLabels;
  }

  // 活跃 capture 行：状态 active（含历史别名 #now/#next，STATUS_ALIAS 归一），滤 #yunxiao ——
  // 云效物化项归「📋 云效工作项」卡。sort:false 跳过逐行 stat（Home 自己按领域/步号排序）。
  async homeCaptureRows() {
    const [line, fields] = await Promise.all([this.homeCaptureLine(), this.homeFields()]);
    return fields.activeCaptureRows(this.app.vault, line, { app: this.app });
  }

  // 活跃卡节点集合（capture 行 → 展示节点）：与 CLI `mf.js query --status active` 同一份成形
  // 判据（_home-fields.js#activeNodes），Home 块不再自己拼 nodes。
  async homeActiveNodes() {
    const [yaml, line, fields] = await Promise.all([
      this.homeYaml(), this.homeCaptureLine(), this.homeFields(),
    ]);
    return fields.activeNodes(this.app.vault, yaml, line, { app: this.app });
  }

  // 单个任务 README 的 frontmatter → Home 卡用的字段。结案判定与 Home「✅ 已完成」卡、
  // depTasks、CLI query 共用 _home-fields.js#finishedFromMilestones（末位 reopen 不算结案）。
  // 文件不在 / 读不到 → null（调用方按无字段处理）。
  async homeTaskFields(path) {
    const [yaml, fields] = await Promise.all([this.homeYaml(), this.homeFields()]);
    return fields.taskFields(this.app.vault, yaml, path);
  }

  // 标了未结案 external_dep 的任务（**兜底差集数据源**，2026-11-19 起）。
  // 外部依赖已并入「🏠 工作事务」活跃卡、独立 ⛔ 卡已删：活跃集合内的展示走 homeTaskFields
  // 的 externalDep，本函数只被活跃卡用来算「有 dep 却不在活跃集合」的条数（卡尾那行灰字）。
  // 口径（两类 type、全库扫、结案判定、稳定排序）都在 _home-fields.js#depTasks，别在这里另写。
  async homeDepTasks() {
    const [yaml, line, fields] = await Promise.all([
      this.homeYaml(), this.homeCaptureLine(), this.homeFields(),
    ]);
    return fields.depTasks(this.app.vault, yaml, line);
  }
  // ---------- 云效 / qy 队列消费：本开源包不含 ----------
  // 四个旁车队列（合并 / 回归 / 转出 / 描述变更）与 qy sync 卡渲染在导出时整段裁掉。

  async loadHelper(path, exportName) {
    const src = await this.app.vault.adapter.read(path);
    const moduleObj = { exports: {} };
    new Function("module", "exports", src)(moduleObj, moduleObj.exports);
    return moduleObj.exports[exportName];
  }

  // loadModule 返回整个 module.exports 对象（loadHelper 取单个 export；convertIdeaToTask
  // 需要多个 export 一并落地——一次加载、跨字段用）。与 loadHelper 同样跑在插件上下文，
  // 读 vault 内 flow/scripts/quickadd/mini/*.js（不在插件目录，require 解析不到）。
  async loadModule(path) {
    const src = await this.app.vault.adapter.read(path);
    const moduleObj = { exports: {} };
    new Function("module", "exports", src)(moduleObj, moduleObj.exports);
    return moduleObj.exports;
  }

  // headless 结案：不确认、不关 README tab、不回 Home（后台动作抢焦点会打断用户，
  // 与消费合并事实时的 `_finish.js` 结案同待遇）。结果只用一条 Notice 报——盘面变化
  // 对调用方不可见，静默就无从判断成没成（同 merge-inbox 消费后的汇总 Notice）。
  // CLI 写盘后的追平动作。**不做全库重扫**：CLI 改文件本身会触发 vault 事件，
  // 索引与 Home 卡的重绘已由既有监听覆盖；这里只补三件它们盖不到的：
  //   ① 域配置缓存失效（CLI 可能改了 flow.json，缓存只在插件侧监听的变更里失效）；
  //   ② README 正开着时被挡下的目录补刷（flushPending 平时靠切 tab 触发）；
  //   ③ 当前活动文件所在任务的索引强制刷一次（force 绕过「README 正被编辑」的跳过）。
  // 无参、不抢焦点、不关 tab；跑完发一条 Notice 报数。
  async runMfReindex() {
    try {
      this._homeDomainLabels = null;
      const pendingBefore = this.pendingFolders.size;
      this.flushPending();
      const folder = this.findEnclosingTaskFolder(this.app.workspace.getActiveFile());
      if (folder) await this.refreshFolder(folder, { force: true });
      new Notice(
        `MF 索引已追平：域缓存已清、补刷挂起目录 ${pendingBefore - this.pendingFolders.size} 个`
        + (folder ? `、强制刷新 ${folder.name}` : "、当前文件不在任务目录内"), 3000);
    } catch (error) {
      console.error("[miniflow] mf-reindex 失败:", error);
      new Notice(`MF 索引追平失败：${(error && error.message) || error}`, 5000);
    }
  }

  async runHeadlessFinish() {
    try {
      const gui = await this.loadModule(TASK_FINISH_GUI_PATH);
      if (!gui || typeof gui.runFinish !== "function") {
        new Notice("task-finish-gui.js 没有导出 runFinish（脚本可能还是旧版）", 5000);
        return;
      }
      const result = await gui.runFinish(this.app);
      const messages = {
        "no-target": "把光标放在月度 Capture 行上，或打开任务 README 后再执行",
        "not-line": "该行不是标准 Capture 行",
        already: "任务已完成（#finish）；要重开用 Task Edit 把状态改回 Active",
        cancelled: "已取消，未推进任务状态",
      };
      if (result && result.status === "done") {
        new Notice(result.message || "任务已标记完成", 2500);
      } else {
        const key = result && result.status;
        new Notice(messages[key] || `结案未执行（${key || "未知"}）`, 4000);
      }
    } catch (error) {
      console.error("[miniflow] headless 结案失败:", error);
      new Notice(`结案失败：${(error && error.message) || error}`, 5000);
    }
  }

  // 读配置文件。不缓存：设置页改完立刻生效，也避免陈旧缓存让开关看起来失灵。
  // 缺文件 / 解析失败一律返回 {}，由各组的 DEFAULTS 兜底——**配置被删不该让功能消失**。
  async readConfigFile() {
    try {
      const parsed = JSON.parse(await this.app.vault.adapter.read(MODULES_CONFIG_PATH));
      return parsed || {};
    } catch (_e) {
      return {};
    }
  }

  async readModulesConfig() {
    const raw = await this.readConfigFile();
    return { ...MODULE_DEFAULTS, ...(raw.modules) };
  }

  async readBehaviorConfig() {
    const raw = await this.readConfigFile();
    return { ...BEHAVIOR_DEFAULTS, ...(raw.behavior) };
  }

  async moduleEnabled(name) {
    const cfg = await this.readModulesConfig();
    return cfg[name] !== false;
  }

  // 写配置：只 patch 指定那一组，**保留文件里已有的另一组**（`...current`）——
  // 两组各写各的，别让写 modules 把 behavior 抹掉。
  async writeConfigGroup(group, patch, defaults) {
    let current = {};
    try {
      current = JSON.parse(await this.app.vault.adapter.read(MODULES_CONFIG_PATH)) || {};
    } catch (_e) { current = {}; }
    const merged = { ...defaults, ...(current[group]), ...patch };
    await this.app.vault.adapter.write(
      MODULES_CONFIG_PATH,
      JSON.stringify({ ...current, [group]: merged }, null, 2) + "\n",
    );
    // behavior 组写完顺手灌进模块级 BEHAVIOR：去抖值在 setTimeout 调用那一刻求值，
    // 改完下一次调度就用新值，**不必重载插件**。
    if (group === "behavior") Object.assign(BEHAVIOR, merged);
    return merged;
  }

  async writeModulesConfig(patch) {
    return this.writeConfigGroup("modules", patch, MODULE_DEFAULTS);
  }

  async writeBehaviorConfig(patch) {
    return this.writeConfigGroup("behavior", patch, BEHAVIOR_DEFAULTS);
  }

  // paths 组的写入。**defaults 传 {}**（与 behavior 不同）：这里只写调用方改的那个键，
  // 其余键靠 _config.js 的 DEFAULTS 在读取时补齐。若用「本地那份默认值」展开，会把本地
  // 可能过期的值写进配置文件、盖掉用户已有的值——插件不维护 paths 默认值就是这个原因。
  // 键值传空串时 JSON.stringify 会丢掉该键 → 该路径回到默认值（等于「恢复默认」）。
  async writePathsConfig(patch) {
    return this.writeConfigGroup("paths", patch, {});
  }

  // 读 paths 组。**不合并默认值**：设置页要显示「用户显式设了什么」，空 = 没设 =
  // 走默认（控件显示 placeholder「(默认)」）。若这里合并 DEFAULTS，页面会把默认值
  // 填成显式值，用户一保存就把默认值固化进配置文件，以后上游改默认值也不再生效。
  async readPathsConfig() {
    const raw = await this.readConfigFile();
    return (raw && raw.paths) || {};
  }

  // 把一个 QuickAdd UserScript 当插件命令跑：loadModule 字符串加载 + 按 QuickAdd 的
  // 签名注入 `{ app, quickAddApi }`。16 个动作因此不再依赖 QuickAdd 的 data.json——
  // 那份配置按本仓硬契约**不进开源包**，别人拿到脚本也跑不起来。
  // 写面不动：脚本内部照旧用 loadHelper 加载 flow/scripts/quickadd/mini/ 下的同一批文件。
  async runUserScript(file) {
    try {
      const mod = await this.loadModule("flow/scripts/quickadd/mini/" + file);
      const fn = typeof mod === "function" ? mod : mod && (mod.default || mod.run);
      if (typeof fn !== "function") {
        new Notice(`${file} 没有导出可执行函数（脚本可能还是旧版）`, 5000);
        return;
      }
      await fn({ app: this.app, quickAddApi: makeQuickAddApi(this.app) });
    } catch (e) {
      console.error(`[miniflow] ${file} 执行失败:`, e);
      new Notice(`${file} 执行失败：${(e && e.message) || e}`, 5000);
    }
  }

  onunload() {
    restoreObsidianRequire(this.originalRequire);
    // 还原标题 patch：插件停用后回到 Obsidian 默认显示（README）。
    if (this.titlePatch) {
      this.titlePatch.restore();
      this.titlePatch = null;
    }
    if (this.titleRefreshTimer) {
      clearTimeout(this.titleRefreshTimer);
      this.titleRefreshTimer = null;
    }
    // 右栏「自适应填满」的观察者与定时器：插件停用后不再量、也不再改 DOM。
    if (this._homeFitObserver) {
      this._homeFitObserver.disconnect();
      this._homeFitObserver = null;
      this._homeGrid = null;
    }
    if (this._fitTimer) {
      clearTimeout(this._fitTimer);
      this._fitTimer = null;
    }
  }

  // 标题刷新去抖：file-open / rename / layout-change 三个事件在一次操作里会连着来
  // （改任务目录名 = 一次 rename + 一串 layout-change），逐个刷会闪。
  scheduleTitleRefresh() {
    if (!this.titlePatch) return;
    if (this.titleRefreshTimer) clearTimeout(this.titleRefreshTimer);
    this.titleRefreshTimer = setTimeout(() => {
      this.titleRefreshTimer = null;
      this.titlePatch.refreshAll();
    }, BEHAVIOR.titleDebounceMs);
  }

  // 字符串加载 vault 内的 helper 模块：文件不在插件目录，require 解析不到，走跟 QuickAdd 同模式。
  async loadHelper(path, exportName) {
    const src = await this.app.vault.adapter.read(path);
    const moduleObj = { exports: {} };
    new Function("module", "exports", src)(moduleObj, moduleObj.exports);
    return moduleObj.exports[exportName];
  }

  // loadModule 返回整个 module.exports 对象（loadHelper 取单个 export；convertIdeaToTask
  // 需要多个 export 一并落地——一次加载、跨字段用）。与 loadHelper 同样跑在插件上下文，
  // 读 vault 内 flow/scripts/quickadd/mini/*.js（不在插件目录，require 解析不到）。
  async loadModule(path) {
    const src = await this.app.vault.adapter.read(path);
    const moduleObj = { exports: {} };
    new Function("module", "exports", src)(moduleObj, moduleObj.exports);
    return moduleObj.exports;
  }

  // ============================================================
  // convertIdeaToTask：Home 闪念转任务的入口。
  //
  // 调用方（Home.md 闪念块按钮）传入 rawBlock（包含 "- " 前缀 + 续行的整段文本）；
  // 经 cleanTitle 剥 #tag / #wikilink / #field 后预填弹框，状态默认 Next、topic 默认空、
  // 领域跑 inferDomain（task-capture 同源）。
  //
  // 删除走「悲观」：弹框 open 时不动 ideas-home.txt；仅在 captureMod.captureIdea 成功
  // 返回 taskPath 后才写盘删行 + dispatch miniflow:ideas-changed + 自动打开新建任务
  // README（与 task-capture 行为一致）。失败 / 用户取消 → 闪念保留。
  // 成功路径同样把 README 全路径写进剪贴板（_clipboard.js，与 task-capture 同源）。
  // ============================================================
  async convertIdeaToTask(rawBlock) {
    const vault = this.app.vault;
    const [naming, task, captureMod, workflow, infer, statusMod, ui, walk, indexHelper, clipboard] = await Promise.all([
      this.loadModule(NAMING_PATH),
      this.loadModule(TASK_PATH),
      this.loadModule(CAPTURE_PATH),
      this.loadModule(WORKFLOW_PATH),
      this.loadModule(INFER_PATH),
      this.loadModule(STATUS_PATH),
      this.loadModule(UI_PATH),
      this.loadModule(WALK_PATH),
      this.loadModule(INDEX_PATH),
      this.loadModule(CLIPBOARD_PATH),
    ]);
    // 闪念文本形如 "- work-驱动-自动分配机制"（markdown 列表行）：cleanTitle 故意不剥
    // `-`（通用清洗，task-capture 用户输入不带 `-` 前缀），这里显式剥一次 markdown 列表
    // 前缀（与 Home.md copyBtn 同款 /^\s*-\s*/，^ 无 gm 旗标只剥起始位置；多行闪念的
    // 续行不带 `- ` 标记，自然不被命中。
    const strippedBlock = rawBlock.replace(/^\s*-\s*/, "");
    const cleaned = naming.cleanTitle(strippedBlock);
    if (!cleaned) {
      new Notice("闪念内容为空，无法创建任务", 2000);
      return;
    }
    // paths 组：domainRoot / topicRoot 由配置给，缺键退回 _config.js 的默认
    // （读不到配置 = {}，_workflow.js 里 `|| DOMAINS_ROOT` 照样兜底）。
    const paths = ((await this.readConfigFile()).paths) || {};
    const [rawDomainChoices, rawTopicChoices] = await Promise.all([
      workflow.listDomainChoices(vault, paths),
      workflow.listTopicChoices(vault, paths),
    ]);
    const domainChoices = rawDomainChoices.map((c) => ({
      slug: c.slug,
      label: c.label,
      work: !!c.work,
      domain: c.domain || c.slug,
      keywords: c.workflow && Array.isArray(c.workflow.keywords) ? c.workflow.keywords : [],
    }));
    const topicChoices = rawTopicChoices.map((t) => ({
      id: t.id,
      label: t.label,
      auto_keywords: Array.isArray(t.auto_keywords) ? t.auto_keywords : [],
      auto_patterns: Array.isArray(t.auto_patterns) ? t.auto_patterns : [],
      parent_id: t.parent_id || "",
    }));
    if (!domainChoices.length) {
      new Notice("领域数据未加载，无法创建", 2000);
      return;
    }
    const { STATUSES } = statusMod;
    const STATUS_LABELS = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));
    const ACTIVE_STATUSES = STATUSES.filter((s) => s.value === "active");

    const state = {
      title: cleaned,
      domainChoice: infer.inferDomain(cleaned, domainChoices) || domainChoices[0],
      status: "active",
      topic: "",
      domainLocked: false,
    };

    const modal = new ConvertIdeaModal(this.app, {
      state,
      infer: { inferDomain: infer.inferDomain },
      STATUSES,
      activeStatuses: ACTIVE_STATUSES,
      applyChipHighlight: ui.applyChipHighlight,
      ui,
      cleanTitle: naming.cleanTitle,
      topicChoices,
      onSubmit: (rawInputTitle) => this.onConvertSubmit({
        rawInputTitle,
        state,
        modal,
        naming,
        task,
        captureMod,
        walk,
        indexHelper,
        clipboard,
        STATUS_LABELS,
        rawBlock,
      }),
    });
    modal.open();
    // 主题 chips 异步渲染：onOpen 时 topicChoices 已通过 opts 传入,首跑渲染;
    // 后续 listTopicChoices 数据更新场景下可再调一次 renderTopicChips 重绘。
    modal.renderTopicChips();
  }

  async onConvertSubmit({ rawInputTitle, state, modal, naming, task, walk, indexHelper, clipboard, captureMod, STATUS_LABELS, rawBlock }) {
    const title = naming.cleanTitle(rawInputTitle);
    if (!title) {
      new Notice("任务名为空，无法创建", 2000);
      return;
    }
    const domainChoice = state.domainChoice;
    if (!domainChoice) {
      new Notice("领域数据未加载，无法创建", 2000);
      return;
    }
    let result;
    try {
      result = await captureMod.captureIdea(this.app.vault, { naming, task, workflow: null, app: this.app }, {
        title,
        status: state.status,
        now: window.moment(),
        domain: domainChoice.domain,
        topic: state.topic,
      });
    } catch (e) {
      new Notice(`任务创建失败: ${String(e).slice(0, 160)}`, 4000);
      return;
    }
    if (result.conflict) { new Notice(result.conflict, 3000); return; }

    // 复制新任务 README 的全路径（与 task-capture 一致）。不 await：剪贴板失败不
    // 影响建任务，copyReadmePath 自身吞掉异常、绝不 reject；此刻窗口仍有焦点。
    // 剪贴板开关（behavior.copyPathOnCapture）：默认开，显式 false 才不写。
    // 与 task-capture.js 同一判据——闪念转任务和人点 capture 的行为要一致。
    const behavior = await this.readBehaviorConfig();
    if (behavior.copyPathOnCapture !== false) {
      clipboard.copyReadmePath(this.app, result.taskPath);
    }

    // 关闭弹框在前；删除闪念 + 打开任务 README 在后（与 task-capture 顺序一致）。
    // 故意不发任务创建成功的 Notice：闪念转任务的反馈靠 Home 闪念列表行实时消失
    // （adapter 写完 dispatch miniflow:ideas-changed 触发局部重绘）+ 新 README 在新
    // leaf 打开，用户能不依赖通知就知道成功。与 idea-capture 的「已记入闪念」一并去掉。
    modal.close();
    try {
      await this.deleteIdeaFromHome(rawBlock);
    } catch (e) {
      new Notice(`闪念删除失败（任务已创建）：${String(e).slice(0, 160)}`, 4000);
    }
    const createdFile = this.app.vault.getAbstractFileByPath(result.taskPath);
    if (createdFile) {
      const taskFolder = createdFile.parent;
      if (taskFolder) {
        const old = await this.app.vault.read(createdFile);
        const updated = indexHelper.replaceOrInsertIndex(old, walk.buildIndexBody(taskFolder));
        if (updated !== old) await this.app.vault.modify(createdFile, updated);
      }
      await this.app.workspace.getLeaf(false).openFile(createdFile, { active: true });
    }
  }

  // 闪念行级删除：从 ideas-home.txt 过滤掉 rawBlock.trim() 匹配的行，adapter 直写
  // 不触发 Dataview 索引（与 Home.md 现有 ✕ 删除按钮同范式）；写完派发
  // miniflow:ideas-changed 让 Home 块局部重绘。
  async deleteIdeaFromHome(rawBlock) {
    const adapter = this.app.vault.adapter;
    // 闪念文件路径走配置（paths.ideasFile）；读不到退回 IDEAS_PATH 常量。
    // 与 idea-capture.js 同一判据——写入与删除必须指同一个文件，否则删不掉刚记的闪念。
    const raw = await this.readConfigFile();
    const ideasPath = (raw && raw.paths && raw.paths.ideasFile) || IDEAS_PATH;
    let prev = "";
    try { prev = await adapter.read(ideasPath); } catch { /* 不存在视为空 */ }
    const kept = prev.split("\n").filter((line) => line.trim() !== rawBlock.trim());
    const body = kept.filter((l) => l !== "").join("\n");
    await adapter.write(ideasPath, body + "\n");
    window.dispatchEvent(new Event(IDEAS_CHANGED_EVENT));
  }

  scheduleForFile(file) {
    if (!file) return;
    const folder = this.findEnclosingTaskFolder(file);
    if (!folder) return;
    const key = folder.path;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refreshFolder(folder, { force: false });
      }, BEHAVIOR.indexDebounceMs),
    );
  }

  findEnclosingTaskFolder(file) {
    if (!file || !this.taskFolderPrefixOf) return null;
    const path = Array.isArray(file.children) ? String(file.path) : String(file.parent ? file.parent.path : "");
    const prefix = this.taskFolderPrefixOf(path);
    if (!prefix) return null;
    const folder = this.app.vault.getAbstractFileByPath(prefix);
    return folder && Array.isArray(folder.children) ? folder : null;
  }

  async refreshFolder(taskFolder, { force }) {
    const readmePath = `${taskFolder.path}/README.md`;
    const readme = this.app.vault.getAbstractFileByPath(readmePath);
    if (!readme) return;

    // README 正被编辑时跳过自动刷新（force 来自手动命令，仍执行）。记下挂起，等切走后补。
    if (!force) {
      const active = this.app.workspace.getActiveFile();
      if (active && active.path === readmePath) {
        this.pendingFolders.add(taskFolder.path);
        return;
      }
    }
    this.pendingFolders.delete(taskFolder.path);

    const oldContent = await this.app.vault.read(readme);
    const newContent = this.replaceOrInsertIndex(oldContent, this.buildIndexBody(taskFolder));
    if (newContent === oldContent) return;
    await this.app.vault.modify(readme, newContent);
  }

  // README 关闭/切走后，把当时被挡下的目录补刷一次（防抖走同一把）。
  flushPending() {
    for (const folderPath of this.pendingFolders) {
      const readmePath = `${folderPath}/README.md`;
      if (this.isReadmeOpenAnywhere(readmePath)) continue; // 还在别的面板开着，继续等
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (folder && Array.isArray(folder.children)) {
        this.pendingFolders.delete(folderPath);
        clearTimeout(this.timers.get(folderPath));
        this.timers.set(
          folderPath,
          setTimeout(() => {
            this.timers.delete(folderPath);
            this.refreshFolder(folder, { force: false });
          }, BEHAVIOR.indexDebounceMs),
        );
      }
    }
  }

  // 该 README 是否在任意 leaf（含分屏/其它 tab）打开——只要还有一个面板在看它，就不覆盖。
  isReadmeOpenAnywhere(readmePath) {
    let open = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const vf = leaf.view && leaf.view.file;
      if (vf && vf.path === readmePath) open = true;
    });
    return open;
  }
}
class MiniflowSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Mini Flow" });
    containerEl.createEl("p", {
      text: "功能模块开关写入 flow/config/miniflow.json（插件与 vault 脚本共用的配置真源）。"
        + "本开源包不含云效 / qy 集成模块（导出时已裁掉），该开关保留只为配置键集合一致。",
      cls: "setting-item-description",
    });
    const LABELS = {
      yunxiao: ["云效 / qy 集成（本包未含）", "可选的外部工作项系统集成模块；开源包在导出时已裁掉该模块代码，此开关不产生效果"],
      indexMaintenance: ["文件索引维护", "打开或增删 folder 任务内文件时重写 README 文件索引段"],
      requireShim: ["QuickAdd obsidian 模块注入", "停掉它 task-capture / task-edit / topic 三个弹框命令会失效"],
      tabTitle: ["任务 tab 标题", "folder 任务的 tab 标签显示任务目录名而不是 README"],
      homeCards: ["Home 卡读面 api", "工作事务 / 闪念 / 云效卡取数与右栏自适应填满"],
      launchClaude: ["▶ 启动 Claude", "Home 任务行尾按钮在任务根起 claude 会话"],
    };
    void (async () => {
      const cfg = await this.plugin.readModulesConfig();
      for (const [key, [name, desc]] of Object.entries(LABELS)) {
        new obsidian.Setting(containerEl)
          .setName(name)
          .setDesc(desc)
          .addToggle((t) => t.setValue(cfg[key] !== false).onChange(async (v) => {
            await this.plugin.writeModulesConfig({ [key]: v });
          }));
      }

      containerEl.createEl("h3", { text: "行为参数" });
      containerEl.createEl("p", {
        text: "去抖 / 节流窗口（毫秒），写进同一个 flow/config/miniflow.json 的 behavior 组。"
          + "改完立即生效，不用重载——这些值是在 setTimeout 调用那一刻求值的。",
        cls: "setting-item-description",
      });
      // [标签, 说明, 最小, 最大, 步长]
      const SLIDERS = {
        indexDebounceMs: ["索引去抖", "folder 内文件增删后，等多久重写 README 文件索引段", 50, 1000, 50],
        titleDebounceMs: ["标题刷新去抖", "tab 标签显示任务名的刷新窗口（比索引短，标题要即时反馈）", 0, 500, 10],
        drainDebounceMs: ["队列消费去抖", "合并 / 回归 / 转出 / 变更四个旁车队列的防抖窗口（四条同值）", 0, 3000, 100],
        qyCardFocusDebounceMs: ["qy 卡回焦重绘", "窗口回焦点时 qy sync 卡的兜底重绘延迟（随云效模块开关一起失效）", 0, 2000, 100],
        progressSoftLimit: ["进展归档上限", "`## 进展` 段超过 N 条时，finish 自动把最早的归档到 process/R-进展历史.md", 1, 50, 1],
        maxFilenameLength: ["任务文件名最大长度", "建任务 / 改名 / 升级三处共用——中文任务名常被截断就是这个值", 10, 200, 1],
      };
      const b = await this.plugin.readBehaviorConfig();
      for (const [key, [name, desc, min, max, step]] of Object.entries(SLIDERS)) {
        new obsidian.Setting(containerEl)
          .setName(name)
          .setDesc(desc)
          .addSlider((s) => s
            .setLimits(min, max, step)
            .setValue(b[key])
            .setDynamicTooltip()
            .onChange(async (v) => {
              await this.plugin.writeBehaviorConfig({ [key]: v });
            }));
      }

      // 布尔项（slider 装不下）：与 task-capture.js 同一判据，人点 capture 与闪念转任务一致。
      new obsidian.Setting(containerEl)
        .setName("capture 后复制路径到剪贴板")
        .setDesc("capture 成功后把 README 绝对路径写进剪贴板；关掉就不再写")
        .addToggle((t) => t.setValue(b.copyPathOnCapture !== false)
          .onChange(async (v) => {
            await this.plugin.writeBehaviorConfig({ copyPathOnCapture: v });
          }));

      // 交付证据软闸的交付口径（域名清单）。**不是通用行为**：各人的业务域不同，
      // 所以默认空、由使用者在这里填；代码里不写死任何人的域名（_finish.js#isDeliveryTask）。
      // 文本框收逗号分隔，写进配置时归一成数组——读面 domainSet 两种形态都认。
      const DOMAIN_LISTS = {
        deliveryDomains: ["交付线域", "这些域的任务一律算交付任务（不看有没有交付物），结案时缺设计/自测证据会提示。逗号分隔，留空=不按域判"],
        deliveryExcludeDomains: ["交付排除域", "这些域哪怕有 output/ 交付物也不算交付任务（基建域、个人事务域）。逗号分隔"],
      };
      for (const [key, [name, desc]] of Object.entries(DOMAIN_LISTS)) {
        const current = Array.isArray(b[key]) ? b[key].join(", ") : String(b[key] || "");
        new obsidian.Setting(containerEl)
          .setName(name)
          .setDesc(desc)
          .addText((t) => t.setValue(current)
            .setPlaceholder("(空)")
            .onChange(async (v) => {
              const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
              await this.plugin.writeBehaviorConfig({ [key]: arr });
            }));
      }

      // ---------- 路径组 ----------
      containerEl.createEl("h3", { text: "路径" });
      containerEl.createEl("p", {
        text: "写进同一个 flow/config/miniflow.json 的 paths 组，清空即回到默认值。"
          + "**脚本根 / 任务根 / 月度文件名不在这**——它们是识别口径（正则里写死 flow/data），"
          + "改了会让读得到目录却认不出任务，理由见 _config.js 头注。",
        cls: "setting-item-description",
      });
      const PATHS_LABELS = {
        homePath: ["首页笔记", "task-finish 关掉 README 后回的那一页（未装 homepage 插件时直接开它）"],
        ideasFile: ["闪念文件", "Idea Capture 写入、Home 闪念块删除的同一个文件"],
        domainRoot: ["领域根", "domains/ 目录（各域的 flow.json 所在处）"],
        topicRoot: ["主题根", "topics/ 目录（主题卡片）"],
      };
      const paths = await this.plugin.readPathsConfig();
      for (const [key, [name, desc]] of Object.entries(PATHS_LABELS)) {
        new obsidian.Setting(containerEl)
          .setName(name)
          .setDesc(desc)
          .addText((t) => t.setValue(paths[key] || "")
            .setPlaceholder("(默认)")
            .onChange(async (v) => {
              await this.plugin.writePathsConfig({ [key]: v.trim() || undefined });
            }));
      }
    })();
  }
}


// ---------- quickAddApi 桩：inputPrompt / suggester ----------
// QuickAdd 用户脚本的签名是 `async ({ app, quickAddApi })`，quickAddApi 由 QuickAdd 注入。
// 插件侧没有它，而 16 个动作里有 7 个真会调（idea-capture / progress-checkin /
// rule-* ×4 / task-search）——不给桩，这些命令一按就抛。这里用 Obsidian Modal 复刻
// 最常用的两个方法，**返回值形态与 QuickAdd 一致**（取消返回 null），于是脚本里既有的
// `text ?? ""` 与 `if (!picked) return` 分支原样成立，脚本一行不改。
//
// 另外 9 个动作要么只要 `{app}`，要么声明了 quickAddApi 却不用——传这个桩即可。

class InputPromptModal extends obsidian.Modal {
  constructor(app, message, resolve) {
    super(app);
    this.message = message;
    this.resolve = resolve;
    this.settled = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("div", { text: this.message, cls: "miniflow-prompt-msg" });
    this.inputEl = contentEl.createEl("input", {
      type: "text",
      cls: "miniflow-prompt-input",
    });
    const row = contentEl.createDiv({ cls: "miniflow-prompt-row" });
    const ok = row.createEl("button", { text: "确定" });
    const cancel = row.createEl("button", { text: "取消", cls: "mod-muted" });
    ok.addEventListener("click", () => this.settle(this.inputEl.value));
    cancel.addEventListener("click", () => this.settle(null));
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.settle(this.inputEl.value); }
      else if (e.key === "Escape") { e.preventDefault(); this.settle(null); }
    });
    window.setTimeout(() => this.inputEl.focus(), 30);
  }
  settle(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }
  onClose() {
    // Esc / 点遮罩走这里：等价于取消，必须 resolve(null)——否则调用方的 await 永远不返回。
    this.settle(null);
    this.contentEl.empty();
  }
}

class SuggesterModal extends obsidian.Modal {
  constructor(app, textItems, items, resolve) {
    super(app);
    this.textItems = textItems.map((t) => String(t));
    this.items = items;
    this.resolve = resolve;
    this.settled = false;
    this.order = this.textItems.map((_, i) => i);
    this.cursor = 0;
  }
  onOpen() {
    const { contentEl } = this;
    this.filterEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "输入过滤，↑↓ 选择，Enter 确定，Esc 取消",
      cls: "miniflow-suggester-filter",
    });
    this.listEl = contentEl.createDiv({ cls: "miniflow-suggester-list" });
    this.filterEl.addEventListener("input", () => {
      const q = this.filterEl.value.trim().toLowerCase();
      this.order = this.textItems
        .map((t, i) => [t, i])
        .filter(([t]) => !q || t.toLowerCase().includes(q))
        .map(([, i]) => i);
      this.cursor = 0;
      this.render();
    });
    this.filterEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const idx = this.order[this.cursor];
        if (idx !== undefined) this.settle(this.items[idx]);
      } else if (e.key === "Escape") { e.preventDefault(); this.settle(null); }
    });
    this.render();
    window.setTimeout(() => this.filterEl.focus(), 30);
  }
  move(delta) {
    if (!this.order.length) return;
    this.cursor = (this.cursor + delta + this.order.length) % this.order.length;
    this.render();
  }
  render() {
    this.listEl.empty();
    if (!this.order.length) {
      this.listEl.createDiv({ text: "（无匹配）", cls: "miniflow-suggester-empty" });
      return;
    }
    this.order.forEach((idx, pos) => {
      const row = this.listEl.createDiv({
        text: this.textItems[idx],
        cls: "miniflow-suggester-item" + (pos === this.cursor ? " is-active" : ""),
      });
      row.addEventListener("click", () => this.settle(this.items[idx]));
      row.addEventListener("mousemove", () => {
        if (this.cursor !== pos) { this.cursor = pos; this.render(); }
      });
    });
    const active = this.listEl.querySelector(".is-active");
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }
  settle(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }
  onClose() {
    this.settle(null);
    this.contentEl.empty();
  }
}

// 交给脚本的 quickAddApi 桩。只实现脚本真正调用过的两个方法——多给用不上，反而让人
// 以为 QuickAdd 的整套 API 都在（那些没有桩的方法一调就 TypeError，比缺方法更难查）。
function makeQuickAddApi(app) {
  return {
    inputPrompt: (message, placeholder, value) => new Promise((resolve) => {
      new InputPromptModal(app, message || "输入", resolve).open();
      void placeholder; void value; // 脚本没传过这两个参数；保留形参照 QuickAdd 签名
    }),
    suggester: (textItems, items, placeholder) => new Promise((resolve) => {
      new SuggesterModal(app, textItems || [], items || [], resolve).open();
      void placeholder;
    }),
  };
}


module.exports = MiniflowPlugin;
