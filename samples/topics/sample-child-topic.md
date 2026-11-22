---
type: topic
topic_id: sample-child-topic
parent_topic: sample-topic
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
  - topic/sample-child-topic
auto_keywords:
  - 子主题
  - child
---

# sample-child-topic

示例**子主题**（`parent_topic: sample-topic`）。

两级主题的规则（见 `flow/CLAUDE.md`「topic 两级主题」）：

- **任务仍只挂一个 `topic`**（标量单值，不引入 `sub_topic`）——跨子线的任务由**父卡**通过
  `parent_topic` 反向聚合到自己身上，任务侧不双挂。
- **父卡的召回通道** = 自身 id/label + 全部子主题 id；子卡正常走自己的通道。
- **什么时候该建父子**：先过「与 domain 同值 / 与任务标题同名」两闸，再看是不是
  **1:N 稳定子流**——几个临时方向用正文 `#### 子方向` 承接就够了，不值得实体化成子 topic。

本样例的 `parent_topic` 指向上一张卡，装完可在 Topic 命令里看到下拉里的父子结构。
