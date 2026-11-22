// ==============================================
// Mini Flow - 共享领域配置工具
//
// 领域配置在 flow/data/domains/<domain>/flow.json，声明该域元数据
// （label、是否工作任务 work、可选 review.checklist）。capture 选域、
// task-upgrade 注入 review 段共用这里。
//
// 阶段链 epic 已于 2026-08 下线：需求统一走 folder + process/ 四类文档，
// 不再有 stages / 自动推进。flow.json 里的 stages 字段被忽略，保留不报错
// （老配置可平滑过渡，想删 stages 随时删）。
//
// 与 _capture.js / _rule.js 同构：`vault` 是 Obsidian app.vault（async）或
// fsVault（同步），本文件一律 await，两种都吃得下。
// ==============================================

// 默认值兜底：调用方不传 paths 时回退到这两个常量（与 _config.js DEFAULTS.paths 同源）。
// 调用方读配置后传 paths.domainRoot / paths.topicRoot 才会覆盖——**不传 = 原行为**，
// 所以没接入的调用方不必一次改完。
const DOMAINS_ROOT = "flow/data/domains";
const TOPICS_ROOT = "flow/data/topics";
const FLOW_FILE = "flow.json";

function flowPath(domain, paths) {
  const root = (paths && paths.domainRoot) || DOMAINS_ROOT;
  return `${root}/${domain}/${FLOW_FILE}`;
}

// 读并解析某域的 flow.json；缺文件或解析失败返回 null。
// 不再要求非空 stages——阶段链已下线，work/review 等配置仍要能读到。
async function loadWorkflow(vault, domain, paths) {
  if (!domain) return null;
  const file = vault.getAbstractFileByPath(flowPath(domain, paths));
  if (!file || file.children) return null; // 目录或不存在
  try {
    const raw = await vault.read(file);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.error(`[miniflow] loadWorkflow ${domain} failed:`, e);
    return null;
  }
}

// 列出 capture 选域用的候选项：domains/ 下每个**任务域**（下划线开头的脚手架跳过）。
// 判据"有 flow.json"——flow.json 承载 work / review.checklist，正是任务归口需要的元数据；
// domains/README.md「新增一个域」写明"纯规则库直接删掉 stages 和整个 flow.json"，
// 即有无所 flow.json 就是任务域与纯规则库的分界。故 work-family（族总规入口）、
// work-shared（纯规则库）不进候选——work-shared/CLAUDE.md 明文"任务 frontmatter
// domain: 字段不应填 work-shared"。想选到它们会拿到 work=false，静默丢 review 段。
// 注意：规则沉淀的候选池是另一回事，判据"有 rules/"在 _rule.js#listDomains，work-shared 仍在内。
async function listDomainChoices(vault, paths) {
  const domainsRoot = (paths && paths.domainRoot) || DOMAINS_ROOT;
  const root = vault.getAbstractFileByPath(domainsRoot);
  const slugs = [];
  if (root && Array.isArray(root.children)) {
    for (const child of root.children) {
      if (!child.children || child.name.startsWith("_")) continue;
      const hasFlow = await vault.getAbstractFileByPath(`${domainsRoot}/${child.name}/${FLOW_FILE}`);
      if (hasFlow) slugs.push(child.name);
    }
  }
  const choices = [];
  for (const slug of slugs.sort()) {
    const wf = await loadWorkflow(vault, slug, paths);
    choices.push({
      slug,
      label: (wf && wf.label) || slug,
      work: !!(wf && wf.work),
      domain: slug,
      workflow: wf,
    });
  }
  // 非工作域（个人）排最前作为默认；工作域（work7 等）其后。
  choices.sort((a, b) => Number(a.work) - Number(b.work));
  return choices;
}

// 列出长期主题卡片：flow/data/topics/<id>.md，每项 {id, label, file}。
// label 取 frontmatter topic_id（与文件名一致），无 topic_id 时退回文件名 stem；
// 排序按 label。topic 文件只能由 Topic 命令建，这里不做下划线脚手架过滤。
//
// auto_keywords 默认合并 id / label：让"输 fitness 能命中 fitness topic"成立——
// 旧版全平铺 chip 时不暴露，主面板按命中过滤（plan 阶段 4-5/6 UX 转向）
// 后若不合并，用户输主题名词自身会看到"chip 不在"的错觉。topic.md
// 文件本体不动，只在 listTopicChoices 序列化时把 id/label 加进 keywords，
// frontmatter 里的 auto_keywords 仍是手工维护的事实源。
async function listTopicChoices(vault, paths) {
  const topicsRoot = (paths && paths.topicRoot) || TOPICS_ROOT;
  const root = vault.getAbstractFileByPath(topicsRoot);
  if (!root || !Array.isArray(root.children)) return [];
  const choices = [];
  for (const child of root.children) {
    if (child.children || !/\.md$/i.test(child.name)) continue; // 只看 .md 文件
    let id = child.name.replace(/\.md$/i, "");
    let autoKeywords = [];
    let autoPatterns = [];
    let parentId = ""; // 两级主题:父主题 topic_id,空串=根主题,弹框按此字段分组树形渲染
    try {
      const raw = await vault.read(child);
      const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (fm) {
        const idMatch = /^topic_id\s*:\s*(.+?)\s*$/m.exec(fm[1]);
        if (idMatch) id = idMatch[1].trim().replace(/^['"]|['"]$/g, "");
        autoKeywords = parseYamlStringArray(fm[1], "auto_keywords");
        autoPatterns = parseYamlStringArray(fm[1], "auto_patterns");
        // parent_topic 缺省视为空(与 topic_id/status 缺省策略一致);弹框树形渲染源端读此字段,
        // 父主题卡 dataviewjs 据此扩展 page.topic 召回通道(父→子 topic_id 集合)。
        const parentMatch = /^parent_topic\s*:\s*(.+?)\s*$/m.exec(fm[1]);
        parentId = parentMatch
          ? parentMatch[1].trim().replace(/^['"]|['"]$/g, "")
          : "";
        // status: deprecated 的 topic 不进入弹框 chip 候选（idea.js / task-edit.js 都从
        // 这个数组读，源端过滤后下游自动级联）；文件本体仍保留以供历史 wikilink /
        // topics: [old-id] 形式的可追溯，Dataview 块也已下线不再渲染。
        const statusMatch = /^status\s*:\s*(.+?)\s*$/m.exec(fm[1]);
        const fmStatus = statusMatch
          ? statusMatch[1].trim().replace(/^['"]|['"]$/g, "")
          : "active";
        if (fmStatus === "deprecated") continue;
      }
    } catch (e) {
      console.error(`[miniflow] listTopicChoices read ${child.path} failed:`, e);
    }
    // 合并 id / label 到 auto_keywords（去重保序，label 优先放最后）。
    const seen = new Set(autoKeywords);
    const merged = autoKeywords.slice();
    for (const extra of [id, id /* label 当前等于 id，将来解耦时换为 label */]) {
      const v = String(extra || "").trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      merged.push(v);
    }
    choices.push({
      id,
      label: id,
      file: child,
      auto_keywords: merged,
      auto_patterns: autoPatterns,
      parent_id: parentId, // 两级主题:父主题 topic_id,空串=根主题,弹框按此字段分组树形渲染
    });
  }
  choices.sort((a, b) => a.label.localeCompare(b.label, "zh"));
  return choices;
}

// 极简 YAML 字符串数组解析：只支持 `key:\n  - foo\n  - bar`（block）
// 与 `key: [foo, bar]`（inline，topic.js 创建时走 inline 形态）两种。
// 失败一律返回空数组，避免阻断 listTopicChoices。键值/嵌套 anchor
// 在 topic.md frontmatter 里不会出现，省去引 _yaml.js 的成本。
//
// 双引号字符串按 YAML 双引号字符串语义 unescape：\\ → \、\" → "。
// 其它反斜杠序列（\\d、\\s 等 regex 字符）保持字面——YAML 1.2 只
// 规定有限转义集，未列出的当字面字符处理；这正是 pattern 字段需要的
// （让 '\\d+\\s*天...' 进 JS 后是单个 '\'，new RegExp 编译为 /\d/）。
// 单引号/plain 不做 unescape（YAML plain 风格本就 literal）。
function parseYamlStringArray(fmBody, key) {
  const re = new RegExp(`^${key}\\s*:\\s*([\\s\\S]*?)(?=^\\S|\\Z)`, "m");
  const m = re.exec(fmBody);
  if (!m) return [];
  const body = m[1];
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(.+?)\s*$/);
    if (item) items.push(yamlUnquote(item[1]));
  }
  if (items.length > 0) return items;
  const inline = body.trim();
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((s) => yamlUnquote(s.trim()))
      .filter(Boolean);
  }
  return [];
}

// 剥 YAML 字符串外层引号 + 处理双引号内反斜杠转义。
// 不剥：单/双引号都未包裹的 plain 字符串原样返回。
function yamlUnquote(value) {
  const s = String(value || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    if (s.startsWith('"')) {
      // 双引号：处理 \\ → \、\" → "；其它 \X 字面保留（YAML 1.2 行为）。
      return inner.replace(/\\(["\\])/g, "$1");
    }
    // 单引号：YAML 1.2 中 '' 表示字面 '，这里无单引号 case，原样返回。
    return inner;
  }
  return s;
}

module.exports = {
  DOMAINS_ROOT,
  TOPICS_ROOT,
  FLOW_FILE,
  flowPath,
  loadWorkflow,
  listDomainChoices,
  listTopicChoices,
};
