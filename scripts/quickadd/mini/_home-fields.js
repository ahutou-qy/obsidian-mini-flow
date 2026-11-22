// ==============================================
// Mini Flow - Home / CLI 共用的任务语义判据（2026-11-19 段 3 从插件下沉）
//
// 为什么下沉：这套判据原先住在 `.obsidian/plugins/miniflow/main.js#api`
// （homeTaskFields / homeDepTasks / homeDomainLabels / homeCaptureRows），
// 只有 dataviewjs 够得着，MCP / CLI 侧调不到 → 调用方只能自己解析 YAML = 判据复制（P3）。
// 现在判据在本文件，**插件与 `mvp/mf.js` 都调这一份**，两端同源。
//
// 边界：
//   - 本文件只读不写，返回纯数据、不碰 DOM、不碰 Notice；
//   - 依赖由调用方注入（`yaml` = _yaml.js、`line` = _capture-line.js）——Obsidian 侧
//     字符串加载没有 require，vault 生产 `_*.js` 一律不 require sibling；
//   - vault 可以是 Obsidian `app.vault`，也可以是 `mvp/_fs-vault.js` 的 fsVault：
//     读文件走 cachedRead ?? read，列目录走 line.listDir，列任务文件走
//     getMarkdownFiles ?? 按 flow/data/YYYY/Qn/MM 结构走（见 taskCandidateFiles）。
// ==============================================

// 结案判定：有 finish 里程碑、且末位不是 reopen。**Home「✅ 已完成」卡、活跃卡、
// depTasks、CLI query 全用这一条**，别在任何一侧再写一遍。
function finishedFromMilestones(milestones) {
  const ms = Array.isArray(milestones) ? milestones : [];
  const last = ms[ms.length - 1];
  return ms.some((x) => x && x.type === "finish") && (!last || last.type !== "reopen");
}

async function readOf(vault, file) {
  if (typeof vault.cachedRead === "function") return vault.cachedRead(file);
  return vault.read(file);
}

// 域配置（label / work）：Home 分组标题 +「工作域优先」排序、CLI query 的 domain 过滤与标签用。
// 缓存留给调用方（插件按 flow.json 变更失效；CLI 一次进程内天然只读一次）。
async function domainLabels(vault, paths) {
  const out = {};
  const domainsRoot = (paths && paths.domainRoot) || "flow/data/domains";
  const root = vault.getAbstractFileByPath(domainsRoot);
  if (!root || !root.children) return out;
  for (const dir of root.children) {
    if (!dir.children || dir.name === "_template") continue;
    const fj = dir.children.find((c) => c.name === "flow.json");
    if (!fj) { out[dir.name] = { label: dir.name, work: false }; continue; }
    try {
      const cfg = JSON.parse(await readOf(vault, fj));
      out[dir.name] = { label: cfg.label || dir.name, work: !!cfg.work };
    } catch {
      out[dir.name] = { label: dir.name, work: false };
    }
  }
  return out;
}

// 单个任务 README 的 frontmatter → 字段集。path 是**不含 .md** 的 vault 相对路径
// （capture 行的 linkTarget 形态）。文件不在 / 读不到 → null（调用方按无字段处理）。
async function taskFields(vault, yaml, path) {
  const f = vault.getAbstractFileByPath(`${path}.md`);
  if (!f) return null;
  let text;
  try { text = await readOf(vault, f); } catch { return null; }
  const m = yaml.FRONTMATTER_RE.exec(text);
  const fm = m ? m[1] : "";
  return {
    domain: yaml.getDomain(fm) || "",
    chain: yaml.getChain(fm),
    externalDep: yaml.getExternalDep(fm) || "",
    finished: finishedFromMilestones(yaml.getMilestones(fm)),
  };
}

// 任务候选 md 文件：Obsidian 侧用索引（getMarkdownFiles），fsVault 侧按目录结构走。
// **只走 flow/data/<YYYY>/<Qn>/<MM>/ 这一层 + 任务目录下的 README.md**，与 depTasks 的
// TASK_RE 口径一致；绝不递归进任务的 input/process/output（那里可能有第三方 SDK 上千文件）。
async function taskCandidateFiles(vault, line) {
  if (typeof vault.getMarkdownFiles === "function") return vault.getMarkdownFiles();
  const out = [];
  const push = (p) => out.push({ path: p });
  // 任务根**不做成配置**：下面 103 行的 TASK_RE 是写死 `flow/data` 的**识别口径**，
  // 改根不改正则会让 depTasks / taskCandidateFiles 全部过滤失效——半可配比不可配更糟。
  const years = (await line.listDir(vault, "flow/data")).folders || [];
  for (const y of years) {
    if (!/^\d{4}$/.test(y.split("/").pop())) continue;
    const quarters = (await line.listDir(vault, y)).folders || [];
    for (const q of quarters) {
      if (!/^Q[1-4]$/.test(q.split("/").pop())) continue;
      const months = (await line.listDir(vault, q)).folders || [];
      for (const mo of months) {
        if (!/^\d{2}$/.test(mo.split("/").pop())) continue;
        const { files = [], folders = [] } = await line.listDir(vault, mo);
        for (const f of files) if (f.endsWith(".md")) push(f);
        for (const t of folders) {
          const inner = (await line.listDir(vault, t)).files || [];
          for (const f of inner) if (f.endsWith("/README.md")) push(f);
        }
      }
    }
  }
  return out;
}

// 标了未结案 external_dep 的任务（Home 活跃卡尾的**兜底差集**数据源）。
// 口径别顺手收窄：差集要覆盖 capture 行 #finish / 带 #yunxiao / 无 capture 行这三类。
// 任务形态认 `type: task`（单文件）与 `type: task-folder`（目录）两类——只认后者会让单文件
// 任务两头落空（活跃集合里没有、差集里也没有）。
async function depTasks(vault, yaml, line) {
  const TASK_RE = /^flow\/data\/\d{4}\/Q[1-4]\/\d{2}\/[^/]+(?:\/README)?\.md$/;
  const out = [];
  for (const f of await taskCandidateFiles(vault, line)) {
    if (!TASK_RE.test(f.path)) continue;
    let text;
    try { text = await readOf(vault, f); } catch { continue; }
    const m = yaml.FRONTMATTER_RE.exec(text);
    if (!m) continue;
    const fm = m[1];
    const type = (fm.match(/^type\s*:\s*(\S+)\s*$/m) || [])[1] || "";
    if (type !== "task" && type !== "task-folder") continue;
    const dep = yaml.getExternalDep(fm);
    if (!dep) continue;
    if (finishedFromMilestones(yaml.getMilestones(fm))) continue;
    out.push({ path: f.path.replace(/\.md$/, ""), dep });
  }
  // 排序固定：文件枚举顺序不保证稳定，指纹比较要的是同一输入同一输出。
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// 活跃 capture 行：状态 active（历史别名由 _capture-line.js#STATUS_ALIAS 归一），
// 滤 #yunxiao（云效物化项归 Home「📋 云效工作项」卡 / CLI 的 --yunxiao 开关）。
// sort:false 跳过逐行 stat（调用方自己按领域/步号排序）。
async function activeCaptureRows(vault, line, { app = null, includeYunxiao = false } = {}) {
  const rows = await line.listRecentTasks(vault, {
    limit: Infinity,
    statuses: ["active"],
    app,
    sort: false,
  });
  return includeYunxiao ? rows : rows.filter((r) => !r.yunxiao);
}

// 任务目录名（`flow/data/YYYY/Qn/MM/<任务目录>/README` → `<任务目录>`）。
// 与 Home.md 原来的 `nameOfPath` 同款，下沉后两端共用。
function nameOfPath(path) {
  return String(path || "").split("/").slice(-2, -1)[0] || String(path || "");
}

// 活跃卡的**节点集合**：capture 行 → 展示节点。Home「🏠 工作事务」卡与 CLI `mf.js query`
// 共用这一份，所以「两边集合对得上」是构造保证的，不靠事后对账。
// 口径（照搬下沉前的 Home 块，别顺手改）：
//   - 无 linkTarget 的行丢弃（定位不到任务文件）；
//   - title 取 capture 行别名，别名是 `README` 时退任务目录名；
//   - domain 优先 README frontmatter，其次 capture 行的 #domain/…（历史行），再兜「未分类」；
//   - **不按 README 的 finish 里程碑过滤**：capture 行 active 就进集合（finished 只作字段返回，
//     Home 的「✅ 已完成」卡是另一套按 milestones 聚合的口径，两者别混）。
async function activeNodes(vault, yaml, line, { app = null, includeYunxiao = false } = {}) {
  const rows = await activeCaptureRows(vault, line, { app, includeYunxiao });
  const fields = await Promise.all(rows.map((r) => taskFields(vault, yaml, r.linkTarget || "")));
  const nodes = [];
  rows.forEach((r, i) => {
    const path = r.linkTarget;
    if (!path) return;
    const f = fields[i];
    const ch = f && f.chain;
    nodes.push({
      path,
      title: (r.title && !/^readme$/i.test(r.title)) ? r.title : nameOfPath(path),
      domain: (f && f.domain) || r.domain || "未分类",
      parent: ch ? ch.parent : "",
      step: ch && ch.step ? ch.step : 0,
      total: ch && ch.total ? ch.total : 0,
      dep: (f && f.externalDep) || "",
      finished: !!(f && f.finished),
      anchor: r.anchor,
      monthLabel: r.monthLabel,
      yunxiao: !!r.yunxiao,
    });
  });
  return nodes;
}

module.exports = {
  finishedFromMilestones,
  nameOfPath,
  domainLabels,
  taskFields,
  taskCandidateFiles,
  depTasks,
  activeCaptureRows,
  activeNodes,
};