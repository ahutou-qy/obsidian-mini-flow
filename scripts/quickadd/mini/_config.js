// ==============================================
// Mini Flow 配置读取的单一入口（阶段 2 · 抽配置层）
//
// 为什么要有这个文件：Mini Flow 的配置散在插件（Obsidian 运行时）、QuickAdd 沙盒、
// 裸 node CLI 三个执行上下文里，各自硬编码一份路径/阈值 → 改一处漏两处。
// 本文件把**默认值、合并逻辑、路径常量**收成一份，三方共用。
//
// **IO 留在调用方**（本文件零 IO、纯函数，裸 node 直接可测）：
//   - 插件 / Obsidian 侧：`parse(await this.app.vault.adapter.read(CONFIG_PATH))`
//   - CLI / 脚本侧       ：`parse(fs.readFileSync(path.join(resolveVaultRoot(), CONFIG_PATH), "utf8"))`
// 两边都拿这个文件的 `CONFIG_PATH` 拼路径——**路径只写一次**。
// 为什么不把 IO 也收进来：插件要走 vault.adapter（vault 相对路径），CLI 要走 fs +
// resolveVaultRoot()（junction 下 `__dirname` 指向共享仓，不能上溯推 vault 根），
// 两套 IO 各自只有两三行，收进来反而要让本文件感知环境、也就不再是纯函数。
//
// **改默认值要同步**：`flow/config/miniflow.json`（本机真文件，各 vault 一份）
// 与共享仓 `config/miniflow.json.example`（示例）。本文件的 DEFAULTS 是第三份——
// 它是「配置文件缺失/损坏时的兜底」，所以**允许它比配置文件旧**（老配置没有新键，
// 靠 DEFAULTS 补齐），但**不允许它比 DEFAULTS 语义旧**（删键=删默认值，会静默降级）。
// ==============================================

// vault 相对路径。三方都用它拼绝对路径或直接交给 vault.adapter。
const CONFIG_PATH = "flow/config/miniflow.json";

// ---------- 默认值 ----------
// 全部为「默认开启/默认原值」——配置被删不该让功能消失（见 _config.js 头注）。
const DEFAULTS = {
  // 功能模块开关（插件 onload 据此决定注册哪些段；关掉云效模块 = 不注册代码块 handler
  // 与四个队列的事件监听，方法留在类里、不注册就没人调）。
  modules: {
    yunxiao: true,
    indexMaintenance: true,
    requireShim: true,
    tabTitle: true,
    homeCards: true,
    launchClaude: true,
  },

  // 行为参数（去抖 / 节流 / 阈值）。前四项是插件侧的 setTimeout 窗口——在调用那一刻
  // 求值，所以设置页改完不必重载；后三项是 vault 脚本侧的阈值（阶段 2 批次 2 接入）。
  behavior: {
    indexDebounceMs: 400,        // folder 任务内文件增删 → 索引段重写
    titleDebounceMs: 120,        // tab 标题刷新（即时反馈，等久了像没生效）
    drainDebounceMs: 800,        // 四个旁车队列 drain，四条同值
    qyCardFocusDebounceMs: 500,  // qy sync 卡回焦重绘（随 modules.yunxiao 一起失效）
    progressSoftLimit: 5,        // `## 进展` 段 bullet 上限，超出归档到 process/R-进展历史.md
    maxFilenameLength: 30,       // 任务文件名最大长度（中文任务名常被截断的来源）
    copyPathOnCapture: true,     // capture 成功后是否把 README 绝对路径写进剪贴板

    // 交付证据软闸的**交付任务口径**（`_finish.js#isDeliveryTask`）。这两项是业务口径
    // 不是通用行为，所以默认空——开源使用者按自己的域填，代码里不写死任何人的域名。
    //   deliveryDomains        ：这些域的任务一律算交付任务（不看有没有交付物）
    //   deliveryExcludeDomains ：这些域哪怕有交付物也不算（基建域、个人事务域）
    // 两项都空时口径退化为「有 yunxiao_id 或 有 output/ 交付物即交付任务」，仍是有效软闸。
    // **与溯源链聚合脚本同源**：那边也读这两项，别在各处另写一份域名清单。
    deliveryDomains: [],
    deliveryExcludeDomains: [],
  },

  // 路径。**只放「改了不会让识别失效」的那几项**。键名 camelCase，值不带尾斜杠。
  //
  // **故意不放三项**，前两条与 helperRoot 同理：
  //   - **helperRoot（脚本根）**：循环依赖（读配置要先 loadModule("<脚本根>/_config.js")）
  //     + 职责已被共享仓 `mounts.json` 占——它是安装布局不是偏好；
  //   - **taskRoot（flow/data）**：它是**识别口径**不是路径拼接——`_home-fields.js` 的
  //     TASK_RE、`_task.js` 的 parseTaskPath / isInTaskTree / inferTasksDir、
  //     `_capture-line.js` 的 MONTH_RE 全把 `flow/data` 写死在正则里。改根不改正则，
  //     读得到目录却认不出里面的任务，**半可配比不可配更糟**；
  //   - **ideasPattern**：月度文件命名（`ideas-YYYY-MM` + 季度目录）是产品结构约定，
  //     与 taskRoot 同源；单改它只会让「生成的路径」与「识别的正则」对不上。
  // 真要换 vault 布局，那是数据迁移不是改配置。
  paths: {
    homePath: "Home.md",                        // 首页笔记（task-finish 关 tab 后回它）
    ideasFile: "flow/ideas-home.txt",           // 闪念文件
    domainRoot: "flow/data/domains",            // 领域根
    // topicRoot 已于 2026-11-23 砍 topic 时删除（listTopicChoices 一并下线，无消费方）。
  },
};

// ---------- 解析与合并 ----------

// text 为空/解析失败一律回落默认值——**配置被删不该让功能消失**。
// 合并是浅的（按组展开），组内新键靠 DEFAULTS 补齐：老配置没有 progressSoftLimit，
// 合并后仍拿到 5，而不是 undefined。
function parse(text) {
  let raw = {};
  if (text !== null && text !== undefined && String(text).trim() !== "") {
    try {
      raw = JSON.parse(text) || {};
    } catch (_e) {
      raw = {}; // 损坏的配置 = 没有配置，走默认值；不抛错，免得一个手滑的 JSON 打死整条链
    }
  }
  return {
    modules: { ...DEFAULTS.modules, ...(raw.modules || {}) },
    behavior: { ...DEFAULTS.behavior, ...(raw.behavior || {}) },
    paths: { ...DEFAULTS.paths, ...(raw.paths || {}) },
  };
}

// 取一组；不给组名就取全部。调用方多数只要一组，少写一次展开。
function read(text, group) {
  const cfg = parse(text);
  return group ? cfg[group] : cfg;
}

// ---------- 脚本侧调用方的同步读 ----------
//
// 用在「调用方读配置 → 传参给脚本函数」这条路上（阶段 2 定的方案：配置走函数参数，
// 脚本保持纯函数）。**插件侧不要用它**——插件走 `vault.adapter.read(CONFIG_PATH)`
// （vault 相对路径，junction 透明），本函数要绝对路径，在 Obsidian 里最容易定位失败。
//
// 为什么本文件仍保持「IO 留给调用方」：这里读盘是给**脚本的调用方**（宏 / CLI）用的
// 便利入口，`parse` 本身仍是纯函数、单测照常只喂字符串。
//
// `root` 可选：调用方能给 vault 根就给（CLI 有 `__dirname`）；不给依次退到
// `MINIFLOW_VAULT_ROOT` 环境变量 → cwd。**读不到一律回落默认值、不抛错**——
// 配置缺失不该打死一条 capture/finish 链，这与 parse 的兜底语义一致。
function loadSync(root) {
  try {
    const fs = require("fs");
    const path = require("path");
    const base = root || process.env.MINIFLOW_VAULT_ROOT || process.cwd();
    const text = fs.readFileSync(path.join(base, CONFIG_PATH), "utf8");
    return parse(text);
  } catch (_e) {
    return parse(null);
  }
}

// 脚本侧调用方的**异步**读：走 Obsidian 的 vault.adapter（vault 相对路径，junction 透明）。
// 用在「脚本在函数体内通过 loadHelper 加载本文件，再拿配置传参」这条路上——
// 脚本本身不能 require 同目录文件（插件的 new Function 只注入 module/exports，
// 相对路径的基准目录不可控），但 `loadHelper(vault, "_config.js")` 能把它取进来。
//
//   const mod = await loadHelper(vault, "_config.js");
//   const cfg = await mod.loadFromAdapter(vault.adapter);
//
// 每个脚本那两行是既有范式（loadHelper 本来就在各脚本里各有一份），逻辑只在本文件。
async function loadFromAdapter(adapter) {
  try {
    const text = await adapter.read(CONFIG_PATH);
    return parse(text);
  } catch (_e) {
    return parse(null); // 读不到 = 没配置，走默认值；不抛错
  }
}

module.exports = {
  CONFIG_PATH,
  DEFAULTS,
  parse,
  read,
  loadSync,
  loadFromAdapter,
};
