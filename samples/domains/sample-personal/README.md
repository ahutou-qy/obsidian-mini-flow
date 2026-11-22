# sample-personal 领域

示例**个人域**（`work: false`）。用来演示两条 personal 行为：

- **零命中降级**：`_infer.js` 全域都不命中时，兜底落第一个 `work: false` 的域——
  本样例正是那个兜底位（真实 vault 里是 `growth`）。
- **排序**：`work: false` 的域在 Home「工作事务」卡里排最前，作为**默认域**。

> **脚手架用法**：复制本目录到 `flow/data/domains/sample-personal/`，改 `label` /
> `keywords` 即可。

## 与 work 域的差别只在 `work` 字段

| 字段 | 本域 | sample-work |
|---|---|---|
| `work` | `false` | `true` |
| `keywords` | 生活 / 阅读 / 记录 这类个人词 | 示例 / 演示 这类通用词 |
| `review` | 无（个人域不做代码评审） | 可选，`{ "checklist": "<文件名>" }` |

两条规则（**不是**配置项、不能改）：「有 `flow.json`」= 任务域，否则纯规则库；
「`work` 组整体压过 personal 组」的推断优先级写死在 `_infer.js`，见 `flow/CLAUDE.md`
「domain 与 topic」段。
