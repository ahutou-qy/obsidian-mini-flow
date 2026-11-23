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

// 默认值兜底：调用方不传 paths 时回退到这个常量（与 _config.js DEFAULTS.paths 同源）。
// 调用方读配置后传 paths.domainRoot 才会覆盖——**不传 = 原行为**，
// 所以没接入的调用方不必一次改完。
const DOMAINS_ROOT = "flow/data/domains";
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

module.exports = {
  DOMAINS_ROOT,
  FLOW_FILE,
  flowPath,
  loadWorkflow,
  listDomainChoices,
};
