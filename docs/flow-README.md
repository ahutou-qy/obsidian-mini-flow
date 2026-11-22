# Mini Flow 用户文档

每月一个 idea 文件，任务一律展开为 folder，里程碑写在 README frontmatter 的 `milestones` 字段。

> 本文是**开源版**。上游私有部署里还有外部工作项平台的集成（工作项物化成任务、
> 合并/回归事实写回），那部分不在本包内，本文也不涉及。

## 命令

全部是 **Mini Flow 插件自带命令**，命令面板搜得到、设置里能绑键，**不依赖 QuickAdd**。
键位见 `docs/INSTALL.md` 第 5 节。

| 命令 | 用途 |
| --- | --- |
| **Task Capture** | 主面板只输入任务名。在当月 `Qn/MM/<任务名>/` 建 folder（`README.md` + `input/`/`process/`/`output/`），README frontmatter 写首条里程碑 `{date: 创建日, type: create}`，月度 `## Capture` 段加一行 `#active` 任务行。**创建成功后立即打开 README** 方便补输入，并默认把 README 的本地绝对路径复制到剪贴板（可在设置页关掉）。领域由标题关键词后台推断（无 UI chip，改领域手改 frontmatter）；主题在主面板全集 chips 里手动点选。 |
| **Idea Capture** | 一两句、尚不成结论的闪念。追加到闪念文件（默认 `flow/ideas-home.txt`），以 `- YYYY-MM-DD HH:MM 内容` 呈现，可带 `#tag`。不建 folder、不进任务流水线、不进月度 Capture。沉淀成行动项再走 Task Capture（Home 闪念卡上的 📌 一键转任务）。 |
| **Progress Checkin** | 打开任务 README 或光标停在月度 Capture 行时执行，输入一句话即往 `## 进展` 段追加 `- 今天 \| 事`。可多次打卡；不写 milestone（那是状态事件）。也可直接手写同格式 bullet。 |
| **Task Finish** | 推进状态机：`#active` → `#finish`（月度行补 `[completion:: 今天]`，README `milestones` 追加 `{type: finish}`）。**README 收口**：`## 进展` 段 bullet 超过上限（默认 5）时把最早的自动归档到 `process/R-进展历史.md`。**交付证据软闸**：交付任务结案时若 `### 设计` / `### 自测` 段还是模板骨架就提示、**不拦**（人点的并进确认框，无头通道发 Notice，CLI 进返回的 `evidenceWarning` 字段）。完成后关闭该 README 的 tab；被关的正是当前活动页时回首页。 |
| **Task Edit** | 改状态与标题（H1 / 磁盘名 / 月度行别名三处同步）。完成态渲染「重开为 Active」chip，点选即重开：改回月度行、剥 `[completion:: …]`，并在 `milestones` 追加一条 `{type: reopen}`。改领域手改 frontmatter。 |
| **Task Delete** | 删任务文件/folder + 清双链；**月度 Capture 行一律保留作留底事件**，行内 `[[...]]` 同时降级为纯文本（不留死链——死链点开会被 Obsidian 新建成空笔记）。删除前二次确认。删除后关闭该 README 的 tab。 |
| **Task Search** | 按标题/状态/领域搜任务，选中即打开。 |
| **Task Upgrade** | 兜底命令：把历史单文件 `<月目录>/任务名.md` 升级为 `<月目录>/任务名>/README.md`，Obsidian 自动更新双链。新建任务一律 folder，正常流程用不到。 |
| **Topic** | 一屏收齐主题元数据：主题名 / 父主题 / 自动标签 / 自动链接 / 自动关键词 / 起止日期 / 追踪问题 / 关注边界 / 退出条件。空字段不写 frontmatter。落在 `flow/data/topics/<slug>.md`。 |
| **Rule Capture** | 打开任务 README 时触发，选领域、输入短标题与一句话陈述，在 `flow/data/domains/<域>/rules/` 建一条 `proposed` 规则笔记，并在任务 README 追加 `## 产出规则` 反链。 |
| **Rule Validate** | 在**另一个**任务里登记「我用了这条规则」，往规则的 `validated_by` 追加一条并在任务 README 追加 `## 引用规则`。提出 + 验证来自 **≥2 个不同任务**时自动晋级 `confirmed`。 |
| **Rule Promote / Deprecate** | 人工晋级 / 废弃规则。废弃可接线 `supersedes` / `superseded_by`。 |
| **Open Claude** | 在**活动笔记所属任务**的根目录起一个 Claude Code 会话（需装 Claude Code）。 |
| **Open Finder** | 在系统文件管理器里打开当前任务目录。 |
| **MD2EPUB** | 把当前笔记转 epub（需 pandoc）。 |
| **刷新当前任务索引** | 手动重写当前 folder 任务 README 的 `## 文件索引` 段（README 正被编辑时插件会跳过自动刷新）。 |
| **Task Finish（无确认）/ MF 重建索引** | 供 MCP 等无头通道调用，见 `docs/flow-CLAUDE.md`「MCP 对接面」。 |
| **CLI：`mf.js`** | `propose` / `create` / `finish` / `reopen` / `progress` / `delete` / `query`，stdout 恒为 JSON。需 Node；`agent-capture.js` 是给 AI agent 的等价入口。 |

## 日常流程

1. **capture**：只输任务名，领域自动推断、状态固定 `#active`，主题手动点选。
   每次都建 folder。README 正文 = 置顶 `## 文件索引`（插件维护）+ `## 进展` + `## 输入` + `## 内化`
   （下含五个 H3：调研 / 分析 / 设计 / 实现 / 自测）。
   原始输入进 `input/`，加工产物（脚本、JSON、报告）进 `process/`，交付件进 `output/`。
2. **推进与完成**：在做就是 `#active`；做完 Task Finish 推到 `#finish`。
   完成后又有新进展用 Task Edit 重开，同一任务继续，不新建关联任务。
3. **追溯**：Home 的「✅ 已完成」卡按时段看 `milestones`（create / finish / reopen / manual）
   与 `process/` 阶段文档。末位里程碑是 `reopen` 的不算已完成，会回到活跃卡。
4. **看板**：Home 的「🏠 工作事务」按域分组；有 `chain` frontmatter 的子任务按父任务缩进成链，
   行首标「第 N/M 步」。标了 `external_dep` 的任务带 ⛔ 徽标与一行说明（缺什么、找谁、期望何时）。

## 闭环：idea / task / topic / domain

四个实体不是流水线，是「一个干活平面 + 两个沉淀平面」。idea/task 把事做完，
domain 和 topic 从 task 吸收相反的东西再反哺回来。

```
capture idea ──升级──► task 干活 ──finish──► 交付
   ▲                      │
   │                      ├─ 可复用规律 ─► rule-capture（手动提炼）
   │                      │                  └─► domain/<域>/rules/
   │                      │                        proposed → confirmed（第二任务验证自动晋级）
   │                      │                              └─► review checklist 反哺下次干活
   │                      │
   │                      └─ 勾主题 ─► README frontmatter topic: <id>
   │                                              ▼
   │                                   topic 卡自动召回（时间线/阶段汇总）
   │                                              │
   │                                   到期 ──► 人工复盘
   └──────────── 新 idea ◄── 复盘的「下一步」手动 capture
```

1. **idea → task**：capture 推断 domain、可选勾 topic，状态机 active → finish。
2. **task → domain**：交付后手动提一条 `proposed` 规则；被**另一个任务**复用才晋级 `confirmed`。
   判据一句话：**脱离具体客户/项目还成立吗？** 不成立就不是规则，是这条任务的笔记。
3. **task → topic**：勾主题只写 frontmatter `topic:`（不写 tag、不写双链），主题卡据此聚合。
   topic 不收规律，只回答「这条线进展如何」。
4. **topic → idea**：到期复盘，把「下一步」capture 成新 idea——这是主题反过来派活的唯一回路。

domain 与 topic 正交：domain 是单值排他的归属（带规则库），topic 是跨域的追踪线（带复盘节奏）。
两个回流开关在人手上：**交付后主动提规则**、**到点真做复盘**。不做这两步，闭环空转。

## 文件位置

- 月度 idea：`flow/data/YYYY/Qn/ideas-YYYY-MM.md`，`## Capture` 段一行 = 一个任务（无复选框）
- 任务 folder：`flow/data/YYYY/Qn/MM/<任务名>/README.md`（`type: task-folder`）
- 主题卡片：`flow/data/topics/<主题名>.md`
- 领域：`flow/data/domains/<slug>/flow.json`（+ 可选 `rules/`、`templates/`）
- 任务骨架模板：`flow/templates/task/folder-readme.md`，builder 实时读盘替换 `{{占位符}}`；
  域可在 `flow/data/domains/<域>/templates/folder-readme.md` 覆写（**覆写版必须同步复制占位符**，
  否则静默丢字段）。规则笔记没有模板文件，正文由 `_rule.js#buildRuleNote` 生成。
- 配置：`flow/config/miniflow.json`；文案表：`flow/config/i18n/<locale>.json`

## 约定

- **月度行是状态的唯一真源**：一行 = 一个任务，无 checkbox、不跨月滚存。
  `#active` / `#finish` 互斥，完成带 `[completion:: 日期]`。重开另在 frontmatter 留 `reopen` 里程碑。
- **`milestones` 是 append-only**：capture 写 `create`，finish 写 `finish`，重开写 `reopen`，
  人可手写 `manual`。幂等键 `{date, type}`——同一天同一类型只留一条。
  正文叙事进 `## 内化`，里程碑数据在 frontmatter，两者分开。
- **`source` 字段**为 `[[ideas-YYYY-MM#^cap-xxx]]` 锚链接，反跳月度行；`^cap-xxx` 是任务稳定 ID
  （重命名不断链）。
- **父子关系由文件位置决定**：folder README 是父，目录树内任何 `type: task` 笔记是子任务，
  子任务不进月度 Capture。`process/`、`input/` 里无 `type` 的过程文档不算子任务。
- **删除一律留底**：删文件清双链，但保留月度行并降级其中的链接为纯文本。
- **`## 进展` 有上限**（默认 5，可配）：超出时 finish 自动把最早的归档到 `process/R-进展历史.md`。
  bullet 格式 `- YYYY-MM-DD | 事`，日期写完整四位年——写短了计数认不出，归档会静默不触发。
- **成功不弹横幅**：命令成功的反馈是 UI 变化本身（弹框关闭 / 新文件打开 / 行消失 / 列表重绘），
  只有错误与边界情形才发 Notice。
- **数据契约不可配**：capture 行格式、frontmatter 字段名、`milestones` schema 是产品约定。
  可配的是路径、阈值、功能开关、交付口径。

## Capture 的领域推断

规则源：`flow/data/domains/<slug>/flow.json` 的 `keywords` 数组。

- 任务名（lowercase）包含任一 keyword 视为命中；
- 多域命中时 **`work: true` 组整体压过 `work: false` 组**，组内取命中数多者，平分按 slug 字典序；
- 零命中兜底到排序后第一个 `work: false` 的域（样例里是 `sample-personal`）；
- 实时推断 180ms 去抖，提交时再算一次防 race；
- 领域无 UI 入口，推断结果直接落 frontmatter。

**新增域时必须同步填 `keywords`**，否则该域永远不会被推断命中。
关键词写「这个词出现在标题里就该归这个域」的词，不是标签；跨域通用词（设备名、动作名）
挂到某一个域会抢别的域的标题。

主题**不做自动召回**：capture 与 edit 都是全集 chips 手动点选（带过滤框）。
主题卡 frontmatter 的 `auto_keywords` 只服务主题卡自己的聚合。

## 重型 folder 任务的段落

`## 内化` 固定五个 H3，按工程阶段归口：

| H3 | 装什么 |
|---|---|
| `### 调研` | 需求复述、现状摸清、关键结论、未决项；拆不拆的判定也写这里。未决项逐项登记进段内登记表（`未决项 / 谁确认 / 结论 / 日期`），确认后回写；无未决项整表删掉 |
| `### 分析` | 根因定位、证据链、错误结论订正（"为什么"，区别于"怎么做"） |
| `### 设计` | 方案、数据链、落地形态、行为契约、验收口径；需求→功能四列映射表，验证位置自测阶段回填；不适用整表删掉 |
| `### 实现` | 最终 commit / 改动范围指针；细节交叉引用到自测 |
| `### 自测` | 测试流程、用例、点位对账、结论、未覆盖边界；验证结论是链上后继步骤的放行依据 |

交付后可追加 `### 复盘`（做对的 / 踩的坑 / 未闭环），不作为默认骨架。

**`## 内化` 是结论叙事，不是参考手册存档**：写关键结论、决策、状态、指针，可一屏扫完。
寄存器全表、协议逐字段对拍、逐行 checklist 这类「查得到但平时不读」的长篇资料，
压成紧凑结论表或放 `process/`，不要整篇灌进内化段。

两张溯源表（`### 调研` 的未决项登记表、`### 设计` 的需求→功能四列表）是模板自带骨架，
**用不上整表删掉**，不做强制占位。

## 大任务要不要拆

判定时点在**调研之后**，不在 capture 之时——那时既无范围描述也无验收口径。
补完 `## 输入` + `### 调研` 后，命中任一即拆：

1. 能切出 ≥3 个**增量**段（每段结束时系统仍可运行/可验证/可结案，段间有依赖顺序）；
   切块不算（同一交付物的不同部分切开会割裂口径）；
2. 跨 ≥2 仓 / ≥2 服务 / 前后端跨端；
3. 各段的验收各自都要重搭环境；
4. 后验指纹：任务已 finish 却仍有新增进展，或 `process/` 下阶段文档 ≥3 个。

三种形态：**任务内阶段化**（默认，靠 `process/` 的 NN- 阶段文档串）、
**并行片**（父任务持唯一定义点 + 兄弟任务各做一片）、
**串行链**（前驱未 finish 且未留验证结论时后继不得开工）。
判定结论写进 `### 调研`：拆 / 不拆 + 理由 + 步骤清单。详见 `docs/flow-CLAUDE.md`「任务链与阶段验证」。