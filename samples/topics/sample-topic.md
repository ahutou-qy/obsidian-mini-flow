---
type: topic
topic_id: sample-topic
status: active
created: 2026-11-21
review_interval_days: 7
scan_from:
scan_to:
source_paths:
  - flow/data
exclude_paths:
  - flow/data/topics
auto_tags:
  - topic/sample-topic
auto_keywords:
  - sample
  - 示例
  - 演示
---

# sample-topic

示例主题（**根主题**，无 `parent_topic`）。

主题卡是 Mini Flow 的**召回面**：任务 frontmatter 的 `topic:` 是标量单值，一个任务至多挂一个
主题；标题与 domain 都没承载的交叉维度靠主题补——所以主题名不该与 domain 同值、也不该就是
任务标题（那样零召回增量）。

## 扫描字段

| 字段 | 含义 |
|---|---|
| `source_paths` | `auto_keywords` 全文扫描的起始目录（只扫这些路径下的 md） |
| `exclude_paths` | 排除的目录（主题卡自己那层，避免自匹配） |
| `scan_from` / `scan_to` | 扫描的时间窗口，留空 = 不限 |
| `auto_tags` | 命中时给任务加的 tag |
| `auto_keywords` | 扫描用关键词；**默认合并 id 与 label**，所以「输示例能命中本卡」成立 |

改这些字段只影响**召回**（Dataview 聚合与过滤），**不改主题文件本体**。
