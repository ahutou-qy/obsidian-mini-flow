// ==============================================
// Mini Flow - UI 视觉公共 helper
//
// 原 idea.js 私有函数（行 724-745），被 task-edit.js / idea.js 共同需要。
// 抽到一处：两处都 loadHelper("_ui") 调用。
//
// applyChipHighlight：Minimal 主题下 mod-cta 视觉偏弱；inline 读
// --interactive-accent / --text-on-accent 主题色，主题切换时跟随。
// getCssVar：读 --css-var 名，提供 fallback（返回 '' 由 caller 处理）。
//
// 关键约束：applyChipHighlight 依赖 window.getComputedStyle，
// 在裸 node 环境（_ui.test.js）下 window 不存在，getCssVar 会抛；
// 调用方应做好 try/catch 兜底（_ui.test.js 验证这层鲁棒性）。
// ==============================================

// 界面文案查表（阶段 3 · 文案表）。本文件的 renderLayer1/2 是**同步闭包**（createTopicSection
// 也不是 async），没法在渲染时 await loadLocale，所以走**注入**：调用方入口
// `await i18n.loadLocale(vault)` 之后调 `initI18n(i18nMod)`，之后闭包里同步用 `_t()`。
// 没注入时 `_t` 恒等返回原文——**初始化缺失不该让界面变空**（回落中文，看得见）。
let _tWarned = false;
let _t = (key, fallback) => {
  // 表还没加载就用 _t → 查表静默失效。**warn 一次**（不每次都吵），让它可见：
  // 症状是「切到英文后界面还是中文」，而 warn 会直接指出是加载时序问题。
  if (!_tWarned) {
    _tWarned = true;
    console.warn("[miniflow] 文案表未加载，界面文案回落中文原文——检查入口是否在用 _t() 之前 await 了 loadLocale");
  }
  return fallback === undefined ? key : fallback;
};
function initI18n(mod) {
  if (mod && typeof mod.t === "function") _t = mod.t;
}

function getCssVar(name) {
  try {
    if (typeof window === "undefined" || !window.getComputedStyle) return "";
    const v = window.getComputedStyle(document.body).getPropertyValue(name);
    return v ? v.trim() : "";
  } catch (e) {
    return "";
  }
}

function applyChipHighlight(btn, on) {
  if (!btn) return;
  if (on) {
    const accent = getCssVar("--interactive-accent") || "#5b8def";
    const onAccent = getCssVar("--text-on-accent") || "#ffffff";
    btn.style.backgroundColor = accent;
    btn.style.color = onAccent;
    btn.style.borderColor = accent;
  } else {
    btn.style.backgroundColor = "";
    btn.style.color = "";
    btn.style.borderColor = "";
  }
}

// 主题全集过滤：按 value 子串(lowercase)在 t.label / 任一 auto_keywords 命中。
// 空 value 全显示。返回 boolean 数组与输入 choices 同序,无副作用纯函数。
//
// 任务级 EditModal 与 idea Modal 共用。原 idea.js#applyAllTopicsFilter:688-703 直接
// 切 DOM style.display——这里升级为纯函数,Modal 自接 DOM 切换。
//
// choices 形态：[{ id, label, auto_keywords: string[] }, ...]
function matchTopicByQuery(topic, query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return true;
  if (String(topic.label || "").toLowerCase().includes(q)) return true;
  if (Array.isArray(topic.auto_keywords) && topic.auto_keywords.some(
    (k) => String(k || "").toLowerCase().includes(q)
  )) return true;
  return false;
}

function applyAllTopicsFilter(choices, query) {
  return (Array.isArray(choices) ? choices : []).map((t) => matchTopicByQuery(t, query));
}

// 主题树建树：扁平 choices -> roots（每层 children 数组按 label zh 排序）。
// 孤儿（parent_id 指向不存在 topic）升级为根,不抛错——避免一条数据坏掉整棵渲染。
// 数据契约由 _workflow.listTopicChoices 给出 parent_id 字段（空串=根主题），
// 单选语义与 task frontmatter 写回路径与本函数无关,本函数是 N 级父子递归的源端。
function buildTopicTree(choices) {
  const list = Array.isArray(choices) ? choices : [];
  const byId = new Map();
  for (const t of list) {
    byId.set(t.id, { topic: t, children: [] });
  }
  const roots = [];
  for (const t of list) {
    const node = byId.get(t.id);
    if (t.parent_id && byId.has(t.parent_id)) {
      byId.get(t.parent_id).children.push(node);
    } else {
      // 孤儿或根主题:统一入 roots。空 parent_id 是根。
      roots.push(node);
    }
  }
  const sortByLabel = (a, b) =>
    String(a.topic.label || "").localeCompare(String(b.topic.label || ""), "zh");
  const sortRecursive = (nodes) => {
    nodes.sort(sortByLabel);
    for (const n of nodes) sortRecursive(n.children);
  };
  sortRecursive(roots);
  return roots;
}

// 在树中找到 topicId 的根祖先节点(2026-09-20 五次改造:两层 UI 用)。
// topicId 是根 → 返回根节点;topicId 是后代 → 返回最顶层祖先;
// topicId 空 / 不存在 → null。
function findTopicRoot(tree, topicId) {
  if (!topicId || !Array.isArray(tree)) return null;
  const walk = (nodes, ancestors) => {
    // ancestors 是从顶到当前节点父级的 tree-node 链(每个元素含 .topic / .children)。
    for (const n of nodes) {
      if (n.topic.id === topicId) {
        // 首个无 parent_id 的祖先即根祖先;根自身被找时 ancestors 为空,返回自身。
        for (const a of ancestors) {
          if (!a.topic.parent_id) return a;
        }
        return ancestors.length === 0 ? n : null;
      }
      if (n.children.length > 0) {
        const r = walk(n.children, [...ancestors, n]);
        if (r !== undefined && r !== null) return r;
      }
    }
    return undefined;
  };
  for (const r of tree) {
    const result = walk([r], []);
    if (result) return result;
  }
  return null;
}

// 全集 chip 平铺渲染(2026-09-20 四次改造)：遍历整棵树把每个 topic 渲染为
// 独立 chip,按 label zh 全局排序;不做层级视觉分组,由 CSS / applyTopicSubtreeFilter
// 决定显隐与高亮。
//
// callbacks:
//   onSelect(id): 点 chip,selected = selected === id ? "" : id(单选 + 再点取消)
//   getSelectedId(): 当前 state.topic
//   applyChipHighlight(btn, on): 主题色填充(JS 端 inline 跟随主题切换)
//
// 返回 { id → buttonEl }。host 是 chip 容器,常设为 flex/grid 平铺。
function renderFlatChips(host, tree, callbacks) {
  const buttons = {};
  if (!host || !Array.isArray(tree)) return buttons;
  const cb = callbacks || {};
  const all = [];
  const collect = (n) => { all.push(n); for (const c of n.children) collect(c); };
  for (const r of tree) collect(r);
  // 全局按 label zh 排序(跨父/子);filter 不动 DOM 顺序,只切 style.display。
  all.sort((a, b) =>
    String(a.topic.label || "").localeCompare(String(b.topic.label || ""), "zh"),
  );
  for (const node of all) {
    const isRoot = !node.topic.parent_id;
    const on = cb.getSelectedId && cb.getSelectedId() === node.topic.id;
    const btn = host.createEl("button", {
      text: node.topic.label,
      cls: "mini-flow-topic-chip" + (isRoot
        ? " mini-flow-topic-chip--parent"
        : " mini-flow-topic-chip--child"),
      attr: { "data-topic-id": node.topic.id, "aria-checked": on ? "true" : "false" },
    });
    if (on) btn.classList.add("mod-cta", "mini-flow-topic-chip--matched");
    if (cb.applyChipHighlight) cb.applyChipHighlight(btn, !!on);
    btn.addEventListener("click", () => cb.onSelect && cb.onSelect(node.topic.id));
    buttons[node.topic.id] = btn;
  }
  return buttons;
}

// 选中态联动子树过滤(2026-09-20 四次改造):selectedId 空 → 全 true;
// 否则 visible = (id 在 selectedId 的子树里),子树 = selectedId 自身 + 所有
// descendants(N 级递归)。选 work 看到 work + work5/work7/work10/workx,
// 其它根主题隐藏;选 work7 看到 work7 + 其 descendants,再点 work7 取消 → 全显。
// 返回 { id → bool }。
function applyTopicSubtreeFilter(tree, selectedId) {
  const result = {};
  const safeTree = Array.isArray(tree) ? tree : [];
  const collect = (n) => { result[n.topic.id] = false; for (const c of n.children) collect(c); };
  for (const r of safeTree) collect(r);
  if (!selectedId) {
    for (const id in result) result[id] = true;
    return result;
  }
  // 找到 selectedId 节点,mark 该节点 + 所有 descendants visible
  const walk = (node) => {
    if (node.topic.id === selectedId) {
      const markSubtree = (n) => {
        result[n.topic.id] = true;
        for (const c of n.children) markSubtree(c);
      };
      markSubtree(node);
      return true;
    }
    for (const c of node.children) {
      if (walk(c)) return true;
    }
    return false;
  };
  for (const r of safeTree) walk(r);
  return result;
}

// 树形过滤：两遍。pass1 自下而上 visible = selfMatch || anyChildVisible,
// 保留祖先上下文（输子关键词时父仍可见）；pass2 自上而下：父 visible 则所有
// descendants visible（输父名时子树全显,不要求子标签自身命中）。
// 返回 { id → bool }。空 query 全 true;query 非空但无任何命中时全 false。
function applyTreeTopicsFilter(roots, query) {
  const result = {};
  const safeRoots = Array.isArray(roots) ? roots : [];
  const nodes = [];
  const collect = (n) => { nodes.push(n); for (const c of n.children) collect(c); };
  for (const r of safeRoots) collect(r);
  for (const n of nodes) result[n.topic.id] = false;
  if (!String(query || "").trim()) {
    for (const n of nodes) result[n.topic.id] = true;
    return result;
  }
  // pass 1: 自下而上
  const pass1 = (node) => {
    const selfMatch = matchTopicByQuery(node.topic, query);
    let childVisible = false;
    for (const c of node.children) if (pass1(c)) childVisible = true;
    const visible = selfMatch || childVisible;
    result[node.topic.id] = visible;
    return visible;
  };
  for (const r of safeRoots) pass1(r);
  // pass 2: 自上而下,父 visible 强制所有 descendants visible
  const pass2 = (node) => {
    if (result[node.topic.id]) {
      for (const c of node.children) {
        result[c.topic.id] = true;
        pass2(c);
      }
    }
  };
  for (const r of safeRoots) pass2(r);
  return result;
}

// 两层主题 chip 区(父层 + 子层)的共用渲染(2026-09-29 抽提)。
// task-capture(新建)与 task-edit(编辑)原本各抄一份 renderTopicLayer1/2 +
// selectTopicRoot/Child + 两层高亮(约 110 行),两份不同步已出过事:d56535e9 换
// 实现时 edit 漏接 host,主题区静默留白、无 chip 也无报错。收成单一实现后
// 不存在"改一份漏一份"。
//
// 契约:state.topic 是唯一读写点(标量单值 = 父 id / 子 id / "");host 由调用方给,
// 两个窗口都用 form 下平级 div(落点一致)。Setting 惰性 require,免得裸 node 单测
// 加载本文件时撞上不存在的 obsidian 模块。
function createTopicSection({ host, tree, state, applyChipHighlight }) {
  const { Setting } = require("obsidian");
  const roots = {};
  const children = {};
  let layer2SettingEl = null;

  const sortByLabel = (nodes) => nodes.slice().sort((a, b) =>
    String(a.topic.label || "").localeCompare(String(b.topic.label || ""), "zh"));

  const paint = (btn, on) => {
    btn.classList.toggle("mod-cta", on);
    btn.classList.toggle("mini-flow-topic-chip--matched", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
    if (applyChipHighlight) applyChipHighlight(btn, on);
  };

  const makeChip = (hostEl, node, kind, store) => {
    const btn = hostEl.createEl("button", {
      text: node.topic.label,
      cls: `mini-flow-topic-chip mini-flow-topic-chip--${kind}`,
      attr: { "data-topic-id": node.topic.id, "aria-checked": "false" },
    });
    btn.addEventListener("click", () => selectTopic(node.topic.id, kind));
    store[node.topic.id] = btn;
  };

  // 第一层:所有根主题 chip,单选 + 再点取消。
  const renderLayer1 = () => {
    const hostEl = new Setting(host)
      .setName(_t("ui.parentTopic", "父主题"))
      .setDesc(_t("ui.parentTopicHint", "选根主题,或不选"))
      .controlEl.createDiv({ cls: "mini-flow-topic-layer-host" });
    for (const r of sortByLabel(tree)) makeChip(hostEl, r, "parent", roots);
  };

  // 第二层:选中项的根祖先的 children。改父时重渲——重渲前先摘掉旧 Setting 节点,
  // 否则每次点父都在 host 末尾追加一组(2026-09-20 真机冒烟 bug)。
  const renderLayer2 = () => {
    if (layer2SettingEl) { layer2SettingEl.remove(); layer2SettingEl = null; }
    for (const id in children) delete children[id];
    const setting = new Setting(host)
      .setName(_t("ui.childTopic", "子主题"))
      .setDesc(_t("ui.childTopicHint", "在所选父主题下选子,或不选(默认用父)"));
    layer2SettingEl = setting.settingEl;
    const hostEl = setting.controlEl.createDiv({ cls: "mini-flow-topic-layer-host" });
    const root = findTopicRoot(tree, state.topic);
    if (!root) { hostEl.createSpan({ text: _t("ui.pickRootHint", "（先选父主题）"), cls: "mini-flow-topics-empty" }); return; }
    const kids = root.children || [];
    if (kids.length === 0) { hostEl.createSpan({ text: _t("ui.noChildHint", "（该主题无子级）"), cls: "mini-flow-topics-empty" }); return; }
    for (const c of sortByLabel(kids)) makeChip(hostEl, c, "child", children);
  };

  // 父层高亮 = 选中项的根祖先(选子时父也跟着亮);子层高亮 = 精确命中。
  const sync = () => {
    const root = findTopicRoot(tree, state.topic);
    const rootId = root ? root.topic.id : "";
    for (const id in roots) if (roots[id]) paint(roots[id], id === rootId);
    for (const id in children) if (children[id]) paint(children[id], id === state.topic);
  };

  // 父主题:单选 + 再点取消。改父后子层集合变了,重渲第二层。
  // 子主题:单选 + 再点取消;取消回退到父(父没变,不必重渲第二层)。
  const selectTopic = (id, kind) => {
    if (kind === "parent") {
      state.topic = state.topic === id ? "" : id;
      renderLayer2();
    } else if (state.topic === id) {
      const root = findTopicRoot(tree, id);
      state.topic = root ? root.topic.id : "";
    } else {
      state.topic = id;
    }
    sync();
  };

  return {
    mount: () => { renderLayer1(); renderLayer2(); sync(); },
  };
}

module.exports = {
  applyChipHighlight,
  getCssVar,
  applyAllTopicsFilter,
  matchTopicByQuery,
  buildTopicTree,
  findTopicRoot,
  renderFlatChips,
  applyTopicSubtreeFilter,
  applyTreeTopicsFilter,
  createTopicSection,
  // 文案注入：调用方入口 await loadLocale 后调它（见文件头注释）
  initI18n,
};
