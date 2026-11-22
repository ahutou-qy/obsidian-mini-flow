// ==============================================
// Mini Flow - 任务名推断核心（Obsidian 与 CLI 共用）
//
// 极简匹配：nameLower.includes(keywordLower) 单向 substring。
// 不引停用词表、不引 jieba；work7/10 域名 + topic.auto_keywords 全
// 是用户/维护者手写的小词典，substring 命中已够，且无"加跑步功能 ≠ fitness"
// 这类假阳性损耗。后续若 capture 历史显示命中率长期偏低再评估切词。
//
// 与 _workflow.js 的 I/O 角色解耦：本文件只吃已经序列化好的
// domainChoices / topicChoices 数组（来自 listDomainChoices /
// listTopicChoices），不读 vault。_workflow.js 透传 flow.json 的
// keywords 字段、topic.js 序列化时已写 auto_keywords——调用方负责
// 把数据喂进来。
//
// 字段命名：domain 侧关键词锁 `keywords`（区别 topic 侧 `auto_keywords`）。
// 状态机：domain 命中按 work=true 优先；同 work 取 hit 数多者；
// 同 hit 数按原顺序（与 listDomainChoices 的排序一致）。
//
// topic 不再做任务名自动召回（2026-09-14 取消 capture 入口的推断链路）；
// topic 关联走用户手动点选 chip，字段 `auto_keywords` / `auto_patterns`
// 仍由 topic 卡 dataviewjs 聚合（另一条管道）使用，前端不消费。
// ==============================================

// 命中：keyword（已 lowercase）出现在 nameLower 中。
// 单向 substring 比 `keyword.includes(nameLower)` 稳——后者只在
// keyword 比 name 还长时命中，正常情况无意义。
function matchKeyword(nameLower, keywordLower) {
  if (!keywordLower) return false;
  return nameLower.includes(keywordLower);
}

// 命中的去重保序 keyword 列表（用于警告面板 / 调试）。
function hitKeywords(nameLower, keywords) {
  const out = [];
  const seen = new Set();
  for (const raw of keywords || []) {
    const k = String(raw || "").toLowerCase();
    if (!k || seen.has(k)) continue;
    if (matchKeyword(nameLower, k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

// 推断领域。返回：
//   { slug, label, work, domain, keywords, hits[], score }
// - hits: 命中 keyword 列表
//
// domainChoices 形如 [{ slug, label, work, domain, keywords }]，
// 调用方必须把 wf.keywords 抽平铺到 choice.keywords）。
function inferDomain(name, domainChoices) {
  const nameLower = String(name || "").toLowerCase();
  const choices = Array.isArray(domainChoices) ? domainChoices : [];

  const scored = choices.map((c) => {
    const kws = Array.isArray(c.keywords) ? c.keywords : [];
    const hits = hitKeywords(nameLower, kws);
    return {
      slug: c.slug,
      label: c.label,
      work: !!c.work,
      domain: c.domain || c.slug,
      keywords: kws,
      hits,
      score: hits.length,
    };
  });

  const workHits = scored.filter((s) => s.score > 0 && s.work);
  const personalHits = scored.filter((s) => s.score > 0 && !s.work);

  let chosen = null;

  if (workHits.length > 0) {
    // 多 work 命中：按 hit 数降序、同数按原顺序。
    workHits.sort((a, b) => b.score - a.score);
    chosen = workHits[0];
  } else if (personalHits.length > 0) {
    // 仅 personal 命中；也按 hit 数降序取。
    personalHits.sort((a, b) => b.score - a.score);
    chosen = personalHits[0];
  } else {
    // 零命中：兜底到第一个 work=false（growth 排第一）。
    const fallback = choices.find((c) => !c.work);
    if (fallback) {
      chosen = {
        slug: fallback.slug,
        label: fallback.label,
        work: !!fallback.work,
        domain: fallback.domain || fallback.slug,
        keywords: Array.isArray(fallback.keywords) ? fallback.keywords : [],
        hits: [],
        score: 0,
      };
    } else {
      // 极端兜底：连 work=false 都没有时，取第一个。
      const first = choices[0];
      chosen = first
        ? {
            slug: first.slug,
            label: first.label,
            work: !!first.work,
            domain: first.domain || first.slug,
            keywords: Array.isArray(first.keywords) ? first.keywords : [],
            hits: [],
            score: 0,
          }
        : null;
    }
  }

  return chosen;
}

// 输入清洗：保留 lowercase + 中英文字符与常见连接符。去除空白与
// 控制字符——避免 "5 km" vs "5km" 这种切词敏感。这个函数目前没用
// 上（substring 匹配对空白不敏感），留给未来要切词时启用。
function tokenize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .split(/[^一-龥a-z0-9-]+/i)
    .filter(Boolean);
}

module.exports = {
  inferDomain,
  tokenize,
  // 导出供测试用，不进对外 API 文档
  _matchKeyword: matchKeyword,
  _hitKeywords: hitKeywords,
};