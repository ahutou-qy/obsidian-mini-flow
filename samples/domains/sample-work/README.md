# sample-work 领域

示例**工作域**（`work: true`）。用来演示 Mini Flow 的两条工作域行为：

- **capture 弹框的领域推断**：`flow.json` 的 `keywords` 是推断规则源，命中的词会把新建任务
  默认归到本域；多域命中时 **work 组整体压过 personal 组**（见 `_infer.js#inferDomain`）。
- **Home「🏠 工作事务」卡的排序**：`work: true` 的域排在个人域之后（`_home-fields.js`）。

> **脚手架用法**：把本目录复制到 `flow/data/domains/sample-work/`，改 `label` 与
> `keywords` 即可。纯规则库（不需要任务归口）可删掉整个 `flow.json`——
> 「有 flow.json」正是任务域与纯规则库的分界（见 `domains/README.md`「新增一个域」）。

## 关键词怎么写

`keywords` 是**推断用**的，不是标签：写「这个词出现在标题里就该归这个域」的词。
示例词刻意用通用词（sample / 示例 / 演示），避免与你自己真实业务域的关键词撞车。

## 域里还能放什么

| 路径 | 用途 |
|---|---|
| `flow.json` | 域元数据（label / work / keywords，可选 `review.checklist` 指向评审清单文件名） |
| `rules/` | 本域的领域规则（`_rule.js` 的规则沉淀候选池按「有 rules/」判定） |
| `templates/` | 覆写全局任务骨架（`folder-readme.md`；覆写版必须同步复制模板里的占位符，否则静默丢字段） |
