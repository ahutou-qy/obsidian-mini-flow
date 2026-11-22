// ==============================================
// Mini Flow - Task Search：跨月按任务名模糊检索，回车直接打开任务 README。
//
// 痛点：Home「✅ 最近 30 天完成」只看近 30 天；想翻更早完成的、或记不清完成时间
// 的任务，只能去 ideas-YYYY-MM.md 里肉眼找。本命令给一个跨月、跨状态的检索入口。
//
// 流程：suggester 列出全部任务，用户直接在其输入框里模糊打名字（QuickAdd 原生
// fuzzy 过滤），回车打开对应 README。选中后用 metadataCache 解析 capture 行的
// wiki link target 定位 TFile，撞名短链也能正确解析。
//
// 数据源：listRecentTasks(limit:Infinity) 扫所有 ideas-YYYY-MM.md 的 Capture 段，
// 覆盖 active/finish/老 archive，不限时间窗。任务状态以 Obsidian 为唯一真相。
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

  const line = await loadHelper(vault, "_capture-line.js");

  // 全量任务（不限 status / 时间）；sort:true 让最近活跃的浮前，输入框空时体验更好。
  const tasks = await line.listRecentTasks(vault, { limit: Infinity, app, sort: true });
  if (!tasks.length) {
    new Notice(_t("taskSearch.empty", "未找到任何任务（Capture 行为空）"));
    return;
  }

  // 展示项：状态徽标 + 标题 + 领域/完成日后缀。QuickAdd suggester 的输入框对这些
  // 显示文本做 fuzzy 匹配，用户直接打字即可按标题/领域/日期过滤。value 保留原 task。
  const display = tasks.map((t) => {
    const badge = statusBadge(t);
    const tail = [];
    if (t.domain) tail.push(t.domain);
    if (t.completion) tail.push(t.completion);
    return `${badge} ${t.title}${tail.length ? ` · ${tail.join(" · ")}` : ""}`;
  });

  const picked = await quickAddApi.suggester(display, tasks);
  if (!picked) return;

  const file = resolveTaskFile(app, picked);
  if (!file) {
    new Notice(`定位不到任务文件：${picked.linkTarget || picked.title}`);
    return;
  }
  await app.workspace.getLeaf(false).openFile(file);
};

// 状态 → 徽标。finish 显 ✅；active 显 🟢；空/未知显占位。
// 历史 #now/#next/#dev_done 由 parseCaptureLine 归一为 active，#archive 归一为 finish
// （已删档的 reader-side 宽读）。
function statusBadge(t) {
  if (t.status === "finish" || t.doneLegacy) return "✅";
  if (t.status === "active") return "🟢";
  if (t.status === "archive") return "📦";
  return "⚪";
}

// capture 行 wiki target → TFile。全路径链接（含 /）走 getAbstractFileByPath；
// basename 短链借 metadataCache.getFirstLinkpathDest 按源文件解析（处理撞名）。
function resolveTaskFile(app, t) {
  const target = t.linkTarget;
  if (!target) return null;
  if (target.includes("/")) {
    const direct = app.vault.getAbstractFileByPath(`${target}.md`);
    if (direct && !direct.children) return direct;
  }
  if (app.metadataCache && app.metadataCache.getFirstLinkpathDest) {
    const dest = app.metadataCache.getFirstLinkpathDest(target, t.file);
    if (dest && dest.extension === "md") return dest;
  }
  return null;
}

async function loadHelper(vault, name) {
  const src = await vault.adapter.read(`flow/scripts/quickadd/mini/${name}`);
  const moduleObj = { exports: {} };
  new Function("module", "exports", src)(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}
