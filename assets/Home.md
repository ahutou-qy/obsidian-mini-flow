<!-- Mini Flow 开源包附带的 Home 模板。四张卡：工作事务 / 闪念 / 规则待复盘 / 已完成。
     上游私有部署里还有云效工作项卡、溯源链卡与 qy sync 块——它们依赖包外的数据与脚本，
     导出时已去掉。用法见 docs/INSTALL.md「Home 卡」。 -->
---
cssclasses:
  - miniflow-home
---

> [!cols]
>
>> [!tasks] 🏠 事务
>> ```dataviewjs
>> // 🟢 活跃（「🏠 事务」卡）：当前还在办的任务，按领域分组、按链缩进（第 N/M 步）。
>> //
>> // ---------- 数据源（2026-11-18 起直读 md，不再走 Dataview 的 dv.pages） ----------
>> //   - 活跃集合 = 月度 capture 行的 `#active`（含历史别名 #now/#next），滤 `#finish` 与
>> //     `#yunxiao`（外部工作项系统物化的任务；本包没有那张卡）。走插件导出的 `api.homeActiveNodes()`，
>> //     内部是 `_home-fields.js#activeNodes` → `_capture-line.js#listRecentTasks`
>> //     —— 与 task-edit / task-finish 同一份解析，也与 CLI `mf.js query` 同一份成形判据。
>> //   - 任务字段 domain / chain / external_dep / milestones 走 `_home-fields.js#taskFields`，
>> //     判据与 `_yaml.js` 同源（QuickAdd 写面用的就是它），两张卡与 CLI 不会各判各的。
>> //     （2026-11-19 段 3：判据从插件 main.js 下沉到 `_home-fields.js`，MCP/CLI 够得着了。）
>> //   - `external_dep`（外部依赖待解）直接在本卡展示：⛔ 徽标 + 灰色副行。2026-11-19 起独立的
>> //     「⛔ 外部依赖待解」卡已删（原先它与本卡是两个不同集合，会让链被劈成两卡）；卡尾用
>> //     `api.homeDepTasks()` 求差集给一行兜底提示——有 dep 却不在本卡活跃集合里的还有几条。
>> //   - 领域显示名与「工作域优先」排序走 `api.homeDomainLabels()`（flow/data/domains/*/flow.json，
>> //     插件侧缓存、改 flow.json 才失效——原先每次渲染串行读 7 个文件，Home 三张卡共读 21 次）。
>> //   - 组内排序（2026-11-23）：**被外部依赖卡住的排本分组最后**（byOrder = 卡住 → step → title
>> //     中文序）。「卡住」按**链级**判（规则 B）：自己带 external_dep，或活跃子节点**全部**卡住——
>> //     有可动作的子任务就不沉，只把整条链推不动的搬到底（叶节点退化成「自己 dep」）。根级把
>> //     独立任务与「父不在活跃集」的链组一起排（链组 = 父 frontmatter 的 dep 或子任务全卡）。
>> //     领域分组之间不变，仍是工作域优先 → label 中文序。
>> //
>> // ---------- 为什么脱离 Dataview ----------
>> // `dv.pages` 依赖会让 flow/data 下**任何** md 变动（改任务正文、写 capture 行、索引插件
>> // 重写文件索引）都 bump index.revision → 本块被整块清空重建，卡面间歇性闪烁。现在块内没有
>> // dv.pages/dv.page，Dataview 不再因索引变化重跑它（与闪念卡同范式），重绘由下面的 vault
>> // 事件自控。
>> //
>> // ---------- 重绘策略 ----------
>> // 事件（flow/data 下 modify/create/delete/rename + 窗口回焦点）→ 去抖 300ms → 重算 →
>> // **指纹没变就不动 DOM**。最高频的写入是改任务正文（写进展 bullet），那种改动不该让整卡
>> // 重绘；指纹覆盖渲染所需的全部输入。真变了才重建：离屏建好再一次挂上（原子替换，无空白帧）。
>> //
>> // ---------- 行内 ▶️ 按钮（2026-11-19）+ 会话状态徽标（2026-11-23） ----------
>> // 每条任务行尾一个 ▶️，在该任务根起一个全新 claude 会话——补的是「人还在 Home 上、没打开
>> // 任务 README」这个场景：Commander pageHeader 那颗 Open Claude 取的是**活动笔记**，在
>> // Home.md 上按它 cwd 落 vault 根、不是任务目录。启动实现单源在
>> // flow/scripts/quickadd/mini/_launch-claude.js（QuickAdd 宏 Open Claude 同一份），经插件
>> // api.launchClaude(path) 调，块里只传 linkTarget 路径、不写路径规则。
>> // 按钮**不进指纹**（它不是渲染输入，画不画都不该让整卡重绘）。
>> // 形态：彩色 emoji + 闪念三键同款（0.95em 裸字无边框），但**常驻淡显** .55→hover 1
>> // ——每行只一颗、又是本功能唯一入口，藏起来等于没有。档位单源在
>> // .obsidian/snippets/miniflow-home.css 的「卡内统一档」段（档 5），改形态去那里改。
>> //
>> // 2026-11-23 起行末多一颗**会话状态 chip**（🟢 运行中 / 💤 空闲 / ⏳ 等你输入或授权），
>> // 读本机 Claude Code 的实时会话注册表（`~/.claude/sessions/<pid>.json`）——走插件
>> // api.homeSessions(paths)，判据单源在 flow/scripts/quickadd/mini/_session-probe.js。
>> // 口径：**只按会话 cwd**（落在该任务根或其子目录内即命中）；shell 档并入 idle（同义）。
>> // **这推翻了 2026-11-19「不探测该任务是否已有 claude 在跑」的决策**——当时不探测是因为
>> // 一旦探测，每次开/关终端都得整卡重绘；现在徽标只把 {count,status} 放进指纹（状态没变
>> // 就不动 DOM），且数据源在 vault 之外（不 bump 索引、不引起闪烁），代价可以接受。
>> // chip **可点**：点开列出该任务的活会话（pid / 名称 / 状态 / 启动时间），走
>> // api.showSessionPanel（面板在插件侧，Modal 才有稳定外观）。
>> // 会话状态**进指纹**（状态变了就该重画），因此另加 25 秒轮询——focus 事件只覆盖「切窗口
>> // 回来」，覆盖不了「终端里另一个 agent 跑完了」。
>> //
>> // ---------- 2026-11-23 卡面两项调整 ----------
>> // ① chip 形态改成**描边小标签**（与预缺陷卡的风险徽标同款，CSS 共用一份「卡内 chip」段），
>> //    位置在**行末**（▶️ 之后）——行序：标题 → ▶️ → chip。
>> // ② **任务标题不跨行**：CSS 把 body 与其直接子级 p 改成 flex 容器，链前缀与 ⛔ 成为独立
>> //    flex item（永不变行），链接超长出省略号；全文靠 hover（li.title，120 字）。
>> //    DOM 归属不变（⛔ 仍在 body 内），另一个任务的验证脚本不受影响。
>> //
>> // ---------- 历史坑（2026-11-12 那轮踩过，改这块前先读 flow/CLAUDE.md） ----------
>> //   - 所有 await 收在取数阶段，DOM 构建全同步：散着 await 的写法在重绘时只剩空卡。
>> //   - 链关系读 README frontmatter 自己解析，不依赖 Dataview 暴露嵌套字段（p.chain 曾整卡退化）。
>> //   - 死链降级交给 linkTo（目标文件不在就出纯文本），不再自己扫 wikilink。
>> const { MarkdownRenderer } = require("obsidian");
>> const component = dv.component || this.component;
>> const root = dv.el("div", "", { cls: "miniflow-active" });
>>
>> const plugin = app.plugins && app.plugins.plugins && app.plugins.plugins["miniflow"];
>> const api = plugin && plugin.api;
>> if (!api || typeof api.homeActiveNodes !== "function") {
>>   root.createDiv({
>>     text: "miniflow 插件未就绪：本卡取数走它的 md 读面（api.homeActiveNodes 等）。",
>>     cls: "miniflow-active-empty",
>>   });
>> } else {
>>   let lastFp = "";
>>
>>   const nameOfPath = (path) => path.split("/").slice(-2, -1)[0] || path;
>>   const linkTo = (path, name) => app.vault.getAbstractFileByPath(`${path}.md`)
>>     ? `**[[${path}|${name}]]**`
>>     : `**${name}**`;
>>
>>   const domLabel = (labels, s) => (labels[s] && labels[s].label) || s || "未分类";
>>   const domIsWork = (labels, s) => !!(labels[s] && labels[s].work);
>>   // 工作领域优先，其余按 label 中文排序。
>>   const sortDomains = (labels, keys) => keys.sort((a, b) => {
>>     const wa = domIsWork(labels, a);
>>     const wb = domIsWork(labels, b);
>>     if (wa !== wb) return wb - wa;
>>     return domLabel(labels, a).localeCompare(domLabel(labels, b), "zh");
>>   });
>>
>>   // 一行 = [内容容器] + （传了 claudePath 才有的）▶️ 按钮 + dep 副行 + 子列表。
>>   // 内容单独进 .miniflow-active-body：MarkdownRenderer.renderMarkdown 是**异步**往容器里
>>   // 填的，直接往 li 上挂兄弟节点（副行 / 子 ul / ▶️ 按钮）会跟它抢先后——容器把这段不确定性
>>   // 关在容器里，▶️ 因此恒在标题后方、副行恒在标题下方（原先副行的先后依赖 renderMarkdown
>>   // 的真实填充时机，verify-home-blocks-runtime.js 的桩验不了，见该脚本头注）。
>>   // 每行兜底：渲染失败或渲染出空内容时，至少把纯文本摆进容器（带 title 提示）。
>>   const render = (parentEl, text, opts) => {
>>     const claudePath = (opts && opts.claudePath) || "";
>>     const li = parentEl.createEl("li");
>>     // hover 提示长度 120 字（2026-11-23 从 90 放宽）：标题在卡面上恒一行、超长出省略号，
>>     // 全文只能从这里看——提示太短就等于没提示。
>>     li.title = String(text).slice(0, 120);
>>     const row = li.createDiv({ cls: "miniflow-active-row" });
>>     const body = row.createDiv({ cls: "miniflow-active-body" });
>>     const fallback = () => {
>>       if (!body.textContent || !body.textContent.trim()) body.createEl("span", { text: String(text) });
>>     };
>>     try {
>>       Promise.resolve(MarkdownRenderer.renderMarkdown(String(text), body, "Home.md", component))
>>         .then(fallback)
>>         .catch(() => { body.createEl("span", { text: String(text) }); });
>>     } catch (e) {
>>       body.createEl("span", { text: String(text) });
>>     }
>>     // 行内 ▶️：在该任务根起一个全新 claude 会话（2026-11-19）。启动实现与失败文案都在
>>     // 插件的 api.launchClaude（单源 _launch-claude.js），块里只传路径。插件没这个方法
>>     // （旧版本 / 验证脚本的桩）就不画按钮，卡片照常渲染。
>>     if (claudePath && typeof api.launchClaude === "function") {
>>       const btn = document.createElement("button");
>>       btn.className = "miniflow-active-cc";
>>       btn.type = "button";
>>       btn.textContent = "▶️";
>>       btn.title = `在新终端里于该任务目录启动 claude 会话（${nameOfPath(claudePath)}）`;
>>       btn.addEventListener("click", (ev) => {
>>         ev.preventDefault();
>>         ev.stopPropagation();
>>         // launchClaude 内部已把失败收口成 Notice（不 reject）；这里再兜一层防空转。
>>         Promise.resolve(api.launchClaude(claudePath)).catch(() => {});
>>       });
>>       row.appendChild(btn);
>>     }
>>     // 会话状态 chip（2026-11-23）：本机是否开着该任务的 claude 会话。数据来自
>>     // api.homeSessions（插件读本机会话注册表），块里只画字符、只传路径，不判命中。
>>     // 形态 = **描边小标签**（与预缺陷卡的风险徽标同款，CSS 在「卡内 chip」段共用一份）；
>>     // 位置 = **行末**（▶️ 之后，2026-11-23 面板定）。
>>     // 徽标可点 → 插件面板列出该任务的活会话（Modal 在插件侧才有稳定外观）。
>>     const sess = (opts && opts.session) || null;
>>     if (sess && sess.count > 0) {
>>       const badge = document.createElement("button");
>>       badge.className = `miniflow-active-sess miniflow-active-sess-${sess.chip || "idle"}`;
>>       badge.type = "button";
>>       badge.textContent = sess.count > 1 ? `${sess.icon || "💤"}×${sess.count}` : (sess.icon || "💤");
>>       badge.title = `本机有 ${sess.count} 个 claude 会话（${sess.label || sess.status}）——点击查看`;
>>       badge.addEventListener("click", (ev) => {
>>         ev.preventDefault();
>>         ev.stopPropagation();
>>         if (typeof api.showSessionPanel !== "function") return;
>>         Promise.resolve(api.showSessionPanel(claudePath)).catch(() => {});
>>       });
>>       row.appendChild(badge);
>>     }
>>     return li;
>>   };
>>
>>   const repaint = async () => {
>>     // ---------- 阶段一：取数（await 全在这段） ----------
>>     // homeDepTasks 是全库扫（原 ⛔ 卡的数据源），合并后只服务卡尾那行兜底差集——活跃集合内
>>     // 的 dep 文案走 homeTaskFields 的 externalDep，不靠它。插件没这个函数时按空数组处理。
>>     const [labels, nodes, depRows] = await Promise.all([
>>       api.homeDomainLabels(),
>>       api.homeActiveNodes(),
>>       typeof api.homeDepTasks === "function" ? api.homeDepTasks() : [],
>>     ]);
>>     // nodes 的成形判据（无 linkTarget 丢弃 / title 退任务目录名 / domain 三级兜底 /
>>     // 不按 README finish 里程碑过滤）已下沉到 _home-fields.js#activeNodes，
>>     // 与 CLI `mf.js query --status active` 同一份——这里不再自己拼（2026-11-19 段 3）。
>>
>>     // 本机会话（2026-11-23）：徽标数据源。插件没这个方法（旧版本 / 验证脚本的桩）时按
>>     // 空处理，卡面照常渲染、不出徽标——与 ▶️ 按钮同款降级。
>>     const sess = (typeof api.homeSessions === "function" && nodes.length)
>>       ? await api.homeSessions(nodes.map((n) => n.path))
>>       : {};
>>
>>     // 兜底差集：有 dep、却不在本卡活跃集合里的任务（capture 行 #finish / 带 #yunxiao / 无
>>     // capture 行——原 ⛔ 卡多收的三类）。换口径收窄不能静默，卡尾给一行灰字提示条数。
>>     const activeSet = new Set(nodes.map((n) => n.path));
>>     const depOutside = depRows.filter((r) => !activeSet.has(r.path));
>>
>>     // 父任务多数已结案、不在活跃集合里，单独读它的结案状态（补渲染的父标题行加「· 已结案」）
>>     // 与 external_dep（2026-11-23：链组按父任务的 dep + 子任务链级继承参与「靠后」排序）。
>>     const parentPaths = [...new Set(nodes.map((n) => n.parent).filter(Boolean))];
>>     const parentFields = await Promise.all(parentPaths.map((p) => api.homeTaskFields(p)));
>>     const parentFinished = {};
>>     const parentDep = {};
>>     parentPaths.forEach((p, i) => {
>>       parentFinished[p] = !!(parentFields[i] && parentFields[i].finished);
>>       parentDep[p] = !!(parentFields[i] && parentFields[i].externalDep);
>>     });
>>
>>     // 指纹 = 渲染的全部输入。没变就不动 DOM（改任务正文是最高频写入，不该让整卡重绘）。
>>     // nodes 已含 dep（改活跃任务的 dep 文案 → 该行副行跟着变）；parentDep 决定链组排位
>>     // （改父任务 dep → 顺序变，必须进指纹）；depOutside.length 覆盖集合外那几条——它们只
>>     // 影响卡尾条数、文案不可见，不必为改文案整卡重绘。
>>     // 会话状态**进指纹**（2026-11-23）：徽标就是为它存在的，状态变了就该重画。只取
>>     // {count,status}——icon 是 status 的派生、明细不影响渲染（会话名换了不重画）。
>>     const sessFp = {};
>>     for (const k of Object.keys(sess)) sessFp[k] = { count: sess[k].count, status: sess[k].status };
>>     const fp = JSON.stringify([labels, parentFinished, parentDep, nodes, depOutside.length, sessFp]);
>>     if (fp === lastFp) return;
>>     lastFp = fp;
>>
>>     // ---------- 阶段二：建 DOM（全同步，离屏建好再一次挂上） ----------
>>     const holder = document.createElement("div");
>>     holder.createEl("h3", { text: "🟢 活跃" });
>>
>>     const gmap = {};
>>     for (const n of nodes) (gmap[n.domain] ||= []).push(n);
>>     const groups = sortDomains(labels, Object.keys(gmap)).map((d) => ({ d, nodes: gmap[d] }));
>>     if (!groups.length) holder.createDiv({ text: "无", cls: "miniflow-active-empty" });
>>
>>     for (const grp of groups) {
>>       const grpNodes = grp.nodes;
>>       holder.createEl("h3", { text: domLabel(labels, grp.d) });
>>       const list = holder.createEl("ul");
>>       const activePaths = new Set(grpNodes.map((n) => n.path));
>>       // 排序（2026-11-23）：**被外部依赖卡住的沉到本分组最后**，其余保持 step → title 中文序。
>>       // 「卡住」按链级判（规则 B）：自己带 dep = 卡住；否则**活跃子节点全部卡住**才算卡住——
>>       // 有可动作的子任务就不沉，只把「整条链推不动」的搬到底。叶节点退化成「自己 dep」。
>>       // 不拆「等待外部」独立段（2026-11-19 才把独立 ⛔ 卡并进来，拆回去会把链劈成两卡）。
>>       const childrenOf = (path) => grpNodes.filter((n) => n.parent === path);
>>       const blockedMemo = new Map();
>>       // seen 防环：frontmatter 的 parent 是人手写的，成环时不让递归打转。
>>       const blockedOf = (n, seen = new Set()) => {
>>         if (blockedMemo.has(n.path)) return blockedMemo.get(n.path);
>>         if (n.dep) { blockedMemo.set(n.path, true); return true; }
>>         if (seen.has(n.path)) return false;
>>         seen.add(n.path);
>>         const ks = childrenOf(n.path);
>>         const blocked = ks.length > 0 && ks.every((k) => blockedOf(k, seen));
>>         seen.delete(n.path);
>>         blockedMemo.set(n.path, blocked);
>>         return blocked;
>>       };
>>       const isBlocked = (n) => blockedOf(n, new Set());
>>       for (const n of grpNodes) isBlocked(n); // 先把 memo 焐热，比较器里不再递归
>>       const byOrder = (a, b) => (isBlocked(a) ? 1 : 0) - (isBlocked(b) ? 1 : 0)
>>         || (a.step - b.step)
>>         || String(a.title).localeCompare(String(b.title), "zh");
>>       const kidsOf = (path) => childrenOf(path).sort(byOrder);
>>
>>       const renderNode = (node, parentEl) => {
>>         const prefix = node.step ? `第 ${node.step}${node.total ? "/" + node.total : ""} 步 · ` : "";
>>         const blocked = isBlocked(node);
>>         const li = render(parentEl, prefix + linkTo(node.path, node.title) + (blocked ? " ⛔" : ""), { claudePath: node.path, session: sess[node.path] });
>>         // 被动阻塞（子任务全卡、自己没 dep）也要能看出为什么排到组尾——⛔ 后补一句 title 提示。
>>         // 标题本身也留在提示里（卡面上已出省略号，全文只能从这里看）。
>>         if (blocked && !node.dep) li.title = `${String(node.title).slice(0, 120)} · 子任务全部卡在外部依赖`;
>>         // dep 完整显示成灰色副行（不用 hover）：文案 30–40 字，藏起来就丢了「找谁」这个 payload。
>>         if (node.dep) li.createEl("div", { text: node.dep, cls: "miniflow-active-dep" });
>>         const kids = kidsOf(node.path);
>>         if (kids.length) {
>>           const sub = li.createEl("ul");
>>           for (const kid of kids) renderNode(kid, sub);
>>         }
>>         return li;
>>       };
>>
>>       // 根 = 父任务不在本分组活跃集合里的节点（含所有无链任务）。
>>       const roots = grpNodes.filter((n) => !(n.parent && activePaths.has(n.parent)));
>>       const chainGroups = {};
>>       const standalone = [];
>>       for (const n of roots.sort(byOrder)) {
>>         // 进这里的节点，其父要么为空、要么不在本分组活跃集合（带 dep 的父任务 2026-11-19 起
>>         // 已进 nodes，子任务走上面 renderNode 的 kidsOf 挂它下面，不再落到这）。父已结案 /
>>         // 不在活跃集合时仍补渲染它的标题行，链不断。
>>         if (n.parent) (chainGroups[n.parent] ||= []).push(n);
>>         else standalone.push(n);
>>       }
>>       // 根级统一排序（2026-11-23）：独立任务与链组一起按「是否卡住 → 独立优先 → step → title」排。
>>       // 分开渲染的话「卡住的独立任务」会压在「没卡住的链组」上面，靠后就只落实一半。
>>       // 链组（父不在活跃集）没有节点可走 blockedOf：父自己的 dep 取 frontmatter（parentDep），
>>       // 再按同一条链级规则继承——活跃子任务全部卡住，链组也算卡住。
>>       const rootEntries = [];
>>       for (const n of standalone) rootEntries.push({ blocked: isBlocked(n), chain: 0, step: n.step, title: n.title, node: n });
>>       for (const p of Object.keys(chainGroups)) {
>>         const kids = chainGroups[p];
>>         rootEntries.push({
>>           blocked: !!parentDep[p] || kids.every((k) => isBlocked(k)),
>>           chain: 1, step: 0, title: nameOfPath(p), parent: p,
>>           passive: !parentDep[p],
>>         });
>>       }
>>       rootEntries.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0)
>>         || (a.chain - b.chain)
>>         || (a.step - b.step)
>>         || String(a.title).localeCompare(String(b.title), "zh"));
>>       for (const e of rootEntries) {
>>         if (!e.chain) { renderNode(e.node, list); continue; }
>>         const done = parentFinished[e.parent] ? " · 已结案" : "";
>>         const li = render(list, `${linkTo(e.parent, nameOfPath(e.parent))}${done}${e.blocked ? " ⛔" : ""}`);
>>         if (e.blocked && e.passive) li.title = `${nameOfPath(e.parent)} · 子任务全部卡在外部依赖`;
>>         const sub = li.createEl("ul");
>>         for (const node of chainGroups[e.parent].sort(byOrder)) renderNode(node, sub);
>>       }
>>     }
>>
>>     // 卡尾兜底：换口径收窄不能静默——有 dep 却不在活跃集合里的还有几条（原 ⛔ 卡会列、本卡
>>     // 不列）。只给条数，完整清单 hover 看；一条都没有就不渲染这行。
>>     if (depOutside.length) {
>>       const more = holder.createDiv({
>>         text: `⛔ 另有 ${depOutside.length} 条不在活跃集合（去任务 README 看）`,
>>         cls: "miniflow-active-dep-outside",
>>       });
>>       more.title = depOutside.map((r) => `${nameOfPath(r.path)} — ${r.dep}`).join("\n");
>>     }
>>
>>     root.empty();
>>     while (holder.firstChild) root.appendChild(holder.firstChild);
>>   };
>>
>>   // ---------- 重绘触发 ----------
>>   let timer = null;
>>   const schedule = () => {
>>     if (timer) clearTimeout(timer);
>>     timer = setTimeout(() => {
>>       timer = null;
>>       repaint().catch((e) => console.warn("[home] 事务卡重绘失败:", e));
>>     }, 300);
>>   };
>>   const onVault = (file) => {
>>     if (file && file.path && file.path.indexOf("flow/data/") === 0) schedule();
>>   };
>>   const refs = [
>>     app.vault.on("modify", onVault),
>>     app.vault.on("create", onVault),
>>     app.vault.on("delete", onVault),
>>     app.vault.on("rename", onVault),
>>   ];
>>   const onFocus = () => schedule();
>>   window.addEventListener("focus", onFocus);
>>   // 25 秒轮询会话状态（2026-11-23）：徽标要在「终端里另一个 agent 跑完了」这种**没人切
>>   // 窗口**的场景也能更新，focus 事件覆盖不了那类变化。轮询只读几个小文件，指纹没变
>>   // 不重绘，代价可忽略。
>>   const poll = (component && component.register && typeof window.setInterval === "function")
>>     ? window.setInterval(schedule, 25000) : null;
>>   if (component && component.register) {
>>     component.register(() => {
>>       if (timer) clearTimeout(timer);
>>       if (poll) window.clearInterval(poll);
>>       for (const r of refs) app.vault.offref(r);
>>       window.removeEventListener("focus", onFocus);
>>     });
>>   }
>>
>>   await repaint();
>> }
>> ```
>
>> [!idea] 💡 闪念
>> ```dataviewjs
>> // 💡 闪念：独立块，块内无 dv.pages/dv.page —— 没有 Dataview 数据依赖。
>> // 关键：数据存 flow/ideas-home.txt 并用 vault.adapter（底层 fs）读写。
>> //   - .txt 不被 Dataview 索引（它只 resolve markdown），改它不 bump index.revision；
>> //   - adapter 直写不走 vault 的 modify 事件。
>> // 双保险下，增删闪念不会触发任何 dataviewjs 块重跑（render() 会先 innerHTML="" 清空，
>> // 那才是「一闪」的根源）。本块只在 miniflow:ideas-changed 事件时局部重绘自己。
>> const { MarkdownRenderer } = require("obsidian");
>> const IDEAS_PATH = "flow/ideas-home.txt";
>> const component = dv.component || this.component;
>> const EVENT = "miniflow:ideas-changed";
>> const renderMd = MarkdownRenderer.renderMarkdown.bind(MarkdownRenderer);
>> const adapter = app.vault.adapter;
>> // 渲染上限（50 条）：**实际显示几条不由这里定**——卡片被首行两栏网格拉伸出来的高度是
>> // 空的，「自适应填满」（插件 api.fitHomeCards）按可用高度决定显示几条：超出的行隐藏、
>> // 卡尾给一行灰字提示。文件里一条不少，只是不都显示。
>> const RENDER_CAP = 50;
>>
>> const parseBlocks = (md) => {
>>   const blocks = [];
>>   let cur = null;
>>   for (const line of md.split(/\r?\n/)) {
>>     if (/^\s*<!--/.test(line) || /^\s*-->/.test(line)) continue;
>>     if (/^- /.test(line)) { if (cur) blocks.push(cur); cur = line; }
>>     else if (cur !== null && line.trim() !== "") cur += "\n" + line;
>>   }
>>   if (cur) blocks.push(cur.replace(/\s+$/, ""));
>>   return blocks;
>> };
>> const readIdeas = async () => {
>>   try { return parseBlocks(await adapter.read(IDEAS_PATH)); }
>>   catch { return []; }
>> };
>> const writeIdeas = async (blocks) => {
>>   await adapter.write(IDEAS_PATH, blocks.join("\n") + "\n");
>> };
>>
>> const wrap = dv.el("div", "", { cls: "miniflow-ideas" });
>>
>> const paint = async (blocks) => {
>>   // 展示顺序：最新创建的在最上（文件本身仍是追加序、最老在前）——只在本函数反转视图，
>>   // 写盘路径不经过这里（删除走 readIdeas → filter → writeIdeas），文件顺序不受影响。
>>   // 只画前 RENDER_CAP 条（最新的那些）；其余留在文件里。真正显示几条由填满逻辑定。
>>   // 离屏构建所有行（含 markdown 渲染），完成后一次性替换 wrap，不留空白帧。
>>   const built = [];
>>   const ordered = [...blocks].reverse();
>>   for (const block of ordered.slice(0, RENDER_CAP)) {
>>     const row = document.createElement("div");
>>     row.className = "miniflow-idea-row";
>>     const body = document.createElement("div");
>>     body.className = "miniflow-idea-body";
>>     row.appendChild(body);
>>     // 去掉首行 "- " 列表前缀；续行的缩进/换行保留，粘贴到 IM 仍是段落、到编辑器仍是合法 markdown。
>>     const copyText = block.replace(/^\s*-\s*/, "");
>>     const copyBtn = document.createElement("button");
>>     copyBtn.className = "miniflow-idea-copy";
>>     copyBtn.textContent = "📋";
>>     copyBtn.title = "复制这条闪念";
>>     copyBtn.addEventListener("click", async () => {
>>       try {
>>         await navigator.clipboard.writeText(copyText);
>>         new Notice("已复制闪念", 1500);
>>       } catch {
>>         // 老浏览器/无 clipboard 权限时回退 execCommand；临时 textarea 不入 DOM 视觉。
>>         const ta = document.createElement("textarea");
>>         ta.value = copyText;
>>         ta.style.position = "fixed";
>>         ta.style.left = "-9999px";
>>         document.body.appendChild(ta);
>>         ta.select();
>>         let ok = false;
>>         try { ok = document.execCommand("copy"); } catch {}
>>         ta.remove();
>>         new Notice(ok ? "已复制闪念" : "复制失败", 1500);
>>       }
>>     });
>>     row.appendChild(copyBtn);
>>     // 转任务按钮：调 miniflow 插件的 convertIdeaToTask API，弹 Task Capture
>>     // 同形态 Modal，任务名预填自 cleanTitle(block)。Modal 在 convertIdeaToTask 内异步
>>     // 打开——失败 / 取消 → 闪念不动；成功 → Modal.close() 后由插件写盘删行。
>>     // 插件未启用 / api 缺失：Notice 报错，不抛异常（防御 onObsidianReady 早期渲染）。
>>     const promoteBtn = document.createElement("button");
>>     promoteBtn.className = "miniflow-idea-promote";
>>     promoteBtn.textContent = "📌";
>>     promoteBtn.title = "将这条闪念转为任务";
>>     promoteBtn.addEventListener("click", async () => {
>>       const plugin = app.plugins && app.plugins.plugins && app.plugins.plugins["miniflow"];
>>       if (!plugin || !plugin.api || typeof plugin.api.convertIdeaToTask !== "function") {
>>         new Notice("Mini Flow Index 插件未启用，无法转任务", 3000);
>>         return;
>>       }
>>       try {
>>         await plugin.api.convertIdeaToTask(block);
>>       } catch (e) {
>>         new Notice(`转任务失败: ${String(e && e.message || e).slice(0, 160)}`, 4000);
>>       }
>>     });
>>     row.appendChild(promoteBtn);
>>     const btn = document.createElement("button");
>>     btn.className = "miniflow-idea-del";
>>     btn.textContent = "🗑";
>>     btn.title = "删除这条闪念";
>>     btn.addEventListener("click", async () => {
>>       row.remove(); // 乐观移除
>>       const cur = await readIdeas();
>>       await writeIdeas(cur.filter((b) => b.trim() !== block.trim()));
>>       window.dispatchEvent(new Event(EVENT));
>>       new Notice("已删除闪念", 1500);
>>     });
>>     row.appendChild(btn);
>>     const rendered = renderMd(block, body, IDEAS_PATH, component);
>>     built.push({ row, rendered });
>>   }
>>   await Promise.all(built.map((b) => b.rendered));
>>   wrap.empty();
>>   if (!built.length) {
>>     const empty = document.createElement("div");
>>     empty.className = "miniflow-ideas-empty";
>>     empty.textContent = "无";
>>     wrap.appendChild(empty);
>>   } else {
>>     built.forEach((b) => wrap.appendChild(b.row));
>>     // 提示行常驻：文案与「显示几条」由填满逻辑回填（初次先藏起来，免得闪一下旧文案）。
>>     const more = document.createElement("div");
>>     more.className = "miniflow-ideas-more";
>>     more.style.display = "none";
>>     wrap.appendChild(more);
>>     // 登记成「可填满」的卡：插件按网格行高决定本卡显示几条——本卡条目多 → 右栏总高涨
>>     // → 其余卡的空白跟着变小（总量守恒）。本块只提供条目与回调，不管排版。
>>     const plugin = app.plugins && app.plugins.plugins && app.plugins.plugins["miniflow"];
>>     const card = wrap.closest(".callout");
>>     if (plugin && plugin.api && typeof plugin.api.registerFillable === "function" && card) {
>>       plugin.api.registerFillable({
>>         card,
>>         rows: () => built.map((b) => b.row),
>>         hint: () => more,
>>         onCount: (shown) => {
>>           more.textContent = `共 ${ordered.length} 条 · 显示最新 ${shown} 条`;
>>           more.style.display = ordered.length > shown ? "" : "none";
>>         },
>>       });
>>       // 立刻填一次（同一帧内改完，用户看不到未填的中间态）；别的卡画完后由 ResizeObserver 再校准。
>>       plugin.api.fitHomeCards();
>>     }
>>   }
>> };
>>
>> paint(await readIdeas());
>>
>> const onChanged = async () => paint(await readIdeas());
>> window.addEventListener(EVENT, onChanged);
>> if (component && component.register) component.register(() => window.removeEventListener(EVENT, onChanged));
>> ```
>
>> [!proposed] ⏳ 规则待复盘
>> ```dataviewjs
>> // ⏳ 规则待复盘：列出 status=proposed 的规则（默认最新 7 条）。
>> // 形式：列表而非表格——每行只给「规则名 + 领域」，够定位就行；列一多就把卡撑爆。
>> // 与 💡 闪念卡同款：不做「展开全部」，超出的条数在卡尾一行灰字提示，全量去源文件看。
>> // 设计：（上游设计文档，不在本包内） §五。
>> // 数据源：flow/data/domains/*/rules/*.md（Dataview 自动索引）。
>> // 读：纯读，不写盘。命令入口走 QuickAdd（Rule Validate / Rule Promote / Rule Deprecate），
>> // 不在本块做快捷链接（决策 6：obsidian:// 协议易腐烂）。
>> const proposed = dv.pages('"flow/data/domains"')
>>   .where(p => p.type === "rule" && p.status === "proposed");
>> // 排序统一走毫秒数：DateTime 用 toMillis()，字符串用 Date.parse()，都取不到则视为最老。
>> const createdMs = (v) => {
>>   if (!v) return -Infinity;
>>   const ms = typeof v.toMillis === "function" ? v.toMillis() : Date.parse(String(v));
>>   return (typeof ms === "number" && !isNaN(ms)) ? ms : -Infinity;
>> };
>> // 领域名：取 flow/data/domains/<slug>/flow.json 的 label（与「✅ 已完成」卡同一套读法），
>> // 读不到就退回 slug。
>> const domainLabels = {};
>> {
>>   const domRoot = app.vault.getAbstractFileByPath("flow/data/domains");
>>   if (domRoot && domRoot.children) {
>>     for (const dir of domRoot.children) {
>>       if (!dir.children || dir.name === "_template") continue;
>>       const fj = dir.children.find(c => c.name === "flow.json");
>>       if (fj) {
>>         try {
>>           const cfg = JSON.parse(await app.vault.read(fj));
>>           domainLabels[dir.name] = cfg.label || dir.name;
>>         }
>>         catch { domainLabels[dir.name] = dir.name; }
>>       } else {
>>         domainLabels[dir.name] = dir.name;
>>       }
>>     }
>>   }
>> }
>> // 降序：最新的排最前；自己按毫秒数排，不依赖 DataArray.sort 的 direction 参数语义。
>> // 注意 DataArray 的 `array` 是**方法**（`array()` 返回底层数组副本），不是数组属性——
>> // 写 `proposed.array.slice(...)` 会报 "proposed.array.slice is not a function"。
>> const sorted = proposed.array().sort((a, b) => createdMs(b.created) - createdMs(a.created));
>> // 渲染上限（60 条）：**实际显示几条不由这里定**——卡片被首行两栏网格拉伸出来的高度是
>> // 空的，「自适应填满」（插件 api.fitHomeCards）按可用高度决定显示几条：超出的行隐藏、
>> // 卡尾给一行灰字提示。规则一条不少，只是默认不全展开。
>> const RENDER_CAP = 60;
>> const wrap = dv.el("div", "", { cls: "miniflow-proposed" });
>> const listHost = wrap.createDiv({ cls: "miniflow-proposed-list" });
>> const paint = () => {
>>   listHost.empty();
>>   if (!sorted.length) { listHost.createDiv({ text: "无" }); return; }
>>   const ul = listHost.createEl("ul");
>>   const rows = [];
>>   for (const r of sorted.slice(0, RENDER_CAP)) {
>>     const li = ul.createEl("li");
>>     li.createEl("a", { text: r.file.name, href: r.file.path, cls: "internal-link" });
>>     const dom = r.domain || "未分类";
>>     li.createSpan({ text: ` · ${domainLabels[dom] || dom}` });
>>     rows.push(li);
>>   }
>>   // 提示行常驻：文案与「显示几条」由填满逻辑回填（初次先藏起来，免得闪一下旧文案）。
>>   const more = document.createElement("div");
>>   more.className = "miniflow-proposed-more";
>>   more.style.display = "none";
>>   listHost.appendChild(more);
>>   // 登记成「可填满」的卡：插件按网格行高决定本卡显示几条——本卡条目多 → 右栏总高涨
>>   // → 其余卡的空白跟着变小（总量守恒）。本块只提供条目与回调，不管排版。
>>   const plugin = app.plugins && app.plugins.plugins && app.plugins.plugins["miniflow"];
>>   const card = wrap.closest(".callout");
>>   if (plugin && plugin.api && typeof plugin.api.registerFillable === "function" && card) {
>>     plugin.api.registerFillable({
>>       card,
>>       rows: () => rows,
>>       hint: () => more,
>>       onCount: (shown) => {
>>         more.textContent = `共 ${sorted.length} 条 · 显示最新 ${shown} 条`;
>>         more.style.display = sorted.length > shown ? "" : "none";
>>       },
>>     });
>>     // 立刻填一次（同一帧内改完，用户看不到未填的中间态）；别的卡画完后由 ResizeObserver 再校准。
>>     plugin.api.fitHomeCards();
>>   }
>> };
>> paint();
>> ```

---

> [!cols]
>
>> [!report] ✅ 已完成
>> ```dataviewjs
>> // 领域标签：从 flow/data/domains/<slug>/flow.json 读 label（与文首 🟢 活跃块独立，各自维护）
>> const labelMap = {};
>> {
>>   const root = app.vault.getAbstractFileByPath("flow/data/domains");
>>   if (root && root.children) {
>>     for (const dir of root.children) {
>>       if (!dir.children || dir.name === "_template") continue;
>>       const fj = dir.children.find(c => c.name === "flow.json");
>>       if (fj) {
>>         try {
>>           const cfg = JSON.parse(await app.vault.read(fj));
>>           labelMap[dir.name] = { label: cfg.label || dir.name, work: !!cfg.work };
>>         }
>>         catch { labelMap[dir.name] = { label: dir.name, work: false }; }
>>       } else {
>>         labelMap[dir.name] = { label: dir.name, work: false };
>>       }
>>     }
>>   }
>> }
>> const domLabel = s => (labelMap[s] && labelMap[s].label) || s || "未分类";
>> const domIsWork = s => !!(labelMap[s] && labelMap[s].work);
>>
>> // 已完成任务按时段聚合。完成日 = milestones 中 type=finish 的最大 date；下拉切本周/本月/本季度/本年。
>> // 「最后一条里程碑事件是 reopen」的任务不算已完成——它已被重开回活跃（在 🟢 活跃卡里）。
>> const toMoment = v => {
>>   if (!v) return null;
>>   if (v.ts) return window.moment(v.ts); // Dataview DateTime
>>   const m = window.moment(v);
>>   return m.isValid() ? m : null;
>> };
>> const finishInfo = dv.pages('"flow/data"')
>>   .where(p => p.type === "task-folder" && p.milestones && p.milestones.length)
>>   .map(p => {
>>     const ms = (p.milestones || []).filter(Boolean);
>>     const dates = ms
>>       .filter(m => m.type === "finish")
>>       .map(m => toMoment(m.date))
>>       .filter(Boolean)
>>       .sort((a, b) => b - a);
>>     if (!dates.length) return null;
>>     // milestones 是 append-only，数组末位 = 最后一次状态事件。
>>     const last = ms[ms.length - 1];
>>     if (last && last.type === "reopen") return null;
>>     return { p, finished: dates[0], domain: p.domain || "未分类" };
>>   })
>>   .filter(Boolean);
>>
>> const PERIODS = [
>>   { key: "week", label: "本周", start: () => window.moment().startOf("isoWeek") },
>>   { key: "month", label: "本月", start: () => window.moment().startOf("month") },
>>   { key: "quarter", label: "本季度", start: () => {
>>       const m = window.moment();
>>       return window.moment(m).startOf("month").month(Math.floor(m.month() / 3) * 3);
>>     } },
>>   { key: "year", label: "本年", start: () => window.moment().startOf("year") },
>> ];
>>
>> const root = dv.el("div", "", { cls: "miniflow-finished" });
>> const bar = root.createDiv({ cls: "miniflow-finished-bar" });
>> bar.createSpan({ text: "时段：" });
>> const sel = bar.createEl("select");
>> for (const pd of PERIODS) sel.createEl("option", { value: pd.key, text: pd.label });
>> sel.value = "week";
>> const body = root.createDiv({ cls: "miniflow-finished-body" });
>>
>> function renderFinished() {
>>   body.empty();
>>   const pd = PERIODS.find(x => x.key === sel.value);
>>   const start = pd.start();
>>   const now = window.moment();
>>   const inRange = finishInfo.filter(x => !x.finished.isBefore(start, "day") && !x.finished.isAfter(now, "day"));
>>   if (!inRange.length) { body.createDiv({ text: "（无）", cls: "miniflow-finished-empty" }); return; }
>>   const g = {};
>>   for (const it of inRange) (g[it.domain] ||= []).push(it);
>>   const doms = Object.keys(g).sort((a, b) => {
>>     const wa = domIsWork(a), wb = domIsWork(b);
>>     if (wa !== wb) return wb - wa;
>>     return domLabel(a).localeCompare(domLabel(b), "zh");
>>   });
>>   for (const d of doms) {
>>     body.createEl("h3", { text: domLabel(d) });
>>     const ul = body.createEl("ul");
>>     for (const it of g[d].sort((a, b) => b.finished - a.finished)) {
>>       const folder = it.p.file.folder || "";
>>       const name = folder.split("/").pop() || it.p.file.name;
>>       const li = ul.createEl("li");
>>       li.createEl("a", { text: name, href: it.p.file.path, cls: "internal-link" });
>>     }
>>   }
>> }
>> sel.addEventListener("change", renderFinished);
>> renderFinished();
>> ```
