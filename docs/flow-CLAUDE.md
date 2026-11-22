# Mini Flow 实现契约（给改代码的人与 AI agent）

本文是 `flow/**` 与插件的实现约束，**不是使用说明**（使用说明在 `docs/flow-README.md`）。
改任何一处前先读对应段；每段末尾的「联动清单」列出必须同批改动的面。

> 本文是**开源版**。上游私有部署里还有外部工作项平台集成（四个旁车队列、状态镜像、
> 同步卡渲染），那些段落在导出时已去掉——本包里没有对应代码。

## 三条贯穿全局的红线

1. **写面唯一**。状态是**两处写面**（月度 capture 行 + README `milestones`），
   任何入口都必须两处都写、且走同一批函数。只改一处会产出「看起来改了、其实状态没改」的文件。
   里程碑走 `_task.js#appendMilestone`、结案走 `_finish.js`、月度行改写走
   `_capture-line-rewrite.js`——**不许各写一份**。
2. **判据单源**。同一件事的判定只有一份实现，插件 / QuickAdd 沙盒 / 裸 node CLI 三方共用。
   第二份实现必漂，且漂了不报错，只是两边给出不同答案。
3. **纯函数 + 注入 IO**。判据函数不读盘、不弹框；IO 与交互由调用方注入。
   这样裸 node 能测，也这样同一套盘面能同时服务 GUI 与无头通道。

## 代码面布局与 vault 根定位

代码面（插件 / `flow/scripts/` / `flow/templates/task/` / CSS / 本文与用户文档）住在本仓，
vault 侧是**挂载点**（`install.ps1` / `install.sh` 按 `mounts.json` 建 junction / symlink）。
数据（`flow/data/`）与本机配置（`flow/config/miniflow.json`）留在 vault。

- **挂载表只有一份**：`mounts.json`。改挂载点只改它，别在两个安装脚本里各写一份路径。
- **junction 会让 `__dirname` 失效**：Node 把 junction 解析成**真实路径**（`__dirname` 指向本仓
  物理位置，而入口路径 `process.argv[1]` 保留逻辑路径）。因此**禁止**用「`__dirname` 上溯 N 层
  = vault 根」推路径——一律走 `scripts/quickadd/mini/_vault-root.js#resolveVaultRoot()`。
  定位顺序：`MINIFLOW_VAULT_ROOT` → 入口逻辑路径 → cwd → 本仓根的 `.miniflow-local.json`
  （安装脚本写、逐机器、不进 git）→ **报错**（宁可报错也不静默猜一个错的根）。
- **只有 Node CLI 这一侧受影响**：Obsidian 侧走 `vault.adapter.read("flow/scripts/quickadd/mini/<name>")`
  的 vault 相对路径，junction 对它透明。
- **插件目录整挂**意味着 `data.json`（运行时记账）跟着走；它是 gitignore 的逐机器文件。

## 配置层（`_config.js`）

配置散在三个执行上下文里（Obsidian 插件 / QuickAdd 沙盒 / 裸 node），所以收成一个入口：

- **配置落 vault 文件**（`flow/config/miniflow.json`），不是纯插件设置——两个上下文都读得到。
- 三个读取入口：`parse(text)`（纯函数，IO 留调用方）/ `loadSync(root)`（CLI）/
  `loadFromAdapter(adapter)`（脚本与插件）。
- **读不到一律回落默认值、不抛错**：配置被删不该让功能消失，一个手滑的 JSON 不该打死 capture 链。
- 合并是**浅的**（按组展开），组内新键靠 `DEFAULTS` 补齐。
- **默认值真源只有 `DEFAULTS` 一份**：插件启动时用它覆盖本地兜底副本（两份默认值漂过一次）。
- 漂移守卫（`_config.test.js` 与 `install --verify`）**只比键集合、不比取值**：
  业务口径与路径各机必然不同，比取值会把「按自己的 vault 填配置」误报成漂移。

四组：`modules`（功能开关）/ `behavior`（去抖、阈值、交付口径）/ `paths`（四条路径）/
`i18n.locale`（文案表语言，由 `_i18n.js` 直读）。

**故意不开放的**：`helperRoot`（循环依赖 + 属安装布局）、`taskRoot`、`ideasPattern`
——后两者是**识别口径**不是路径拼接（`_home-fields.js` 的 `TASK_RE`、`_task.js` 的
`parseTaskPath`、`_capture-line.js` 的 `MONTH_RE` 都把 `flow/data` 写死在正则里）。
改根不改正则 = 读得到目录却认不出任务，**半可配比不可配更糟**。

**联动**：加/改配置键 → `_config.js#DEFAULTS` + `config/miniflow.json.example` +
设置页控件 + `_config.test.js`；用到该键的脚本按「调用方读配置 → 传参给纯函数」接。

## 文案表（`_i18n.js`）

- 文案落 `flow/config/i18n/<locale>.json`，**key 是语义路径**（`ui.parentTopic`），
  不拿文案本身当 key——文案一改 key 就断。
- **load 一次、之后同步用**：`Modal.onOpen()` 是同步方法，里面 await 不了。
  入口（async）先 `await loadLocale()` 灌表，渲染时同步 `t(key)` 取值。
- 漏译 / 缺表一律**回落中文原文**，可见、不出空串。
- **带变量的模板不抽**（抽进 JSON 要引入插值规则，收益不抵复杂度）。
- 两条守卫：① `zh.json` 必须覆盖代码里用到的 key；② 每个文件 `_t` 的赋值必须在首次调用之前
  （否则查表静默失效，症状是「切了语言界面没变」，此时 warn 一次）。

## 任务笔记的形状与成形契约

- **单文件**必须有 `type: task`，正文由 `_task.js#buildTaskNote()` 生成（无模板文件）。
  **folder** 由 `_task.js#buildFolderReadme()` 生成，`type: task-folder`，段落顺序必须一致
  （snapshot / 插件不区分来源）。形状由事件类型决定，capture 不手选。
- `source` 与正文「来源」指向同一条 `[[ideas-YYYY-MM#^cap-xxx]]` capture 行，锚点同时写到那一行。
- **capture 弹框状态区只读**：状态字典只有两档，capture 一律写 `#active`，没有可切换项。
  完成是已存在任务的推进态，不在 capture 入口暴露。
- **两张溯源表是模板自带骨架**：`### 调研` 的未决项登记表与 `### 设计` 的需求→功能四列表
  由 `folder-readme.md` 正文注入，**用不上整表删掉**，不做强制占位段。
- **文件索引段**由 `<!-- auto-index:start -->` / `<!-- auto-index:end -->` 包围，
  脚本与插件重写哨兵之间的内容，人工不改。索引**不列 folder 根 README 自身**（自链接无导航价值）。
- `_walk.js` 对根级 `input/` / `output/` / `process/` **只展一层**：直接放在这三个目录下的文件照常列出，
  其下子文件夹只留 `- **xxx/**` 占位、不递归（避免第三方包把索引刷屏）。其它目录照常递归。
- **folder 任务 README 的 tab 标签显示任务目录名**（`_tab-title.js#taskLabelForReadmeFile`）。
  视图头部与 inline title **刻意不接管**——那两个是 Obsidian 的改名框，塞任务名会让人误按一下
  就把 README.md 改名、全部短链变红。

**联动**：改 frontmatter / 段名段序 / `{{占位符}}` / 索引哨兵 → 模板 + 生成脚本 + 插件同批改；
域覆写模板（`domains/<域>/templates/folder-readme.md`）必须同步复制新占位符，否则静默丢字段。

## AI 自动 capture（`mvp/agent-capture.js`）

AI 侧建任务的唯一入口是 standalone CLI，复用与 Obsidian 端**同一条写面**
（`_capture.js#captureIdea` + `_task.js#buildFolderReadme`），不另写建任务逻辑、不手抄 README 骨架。

- `propose --title "<标题>"`：只读，回 JSON（cleanedTitle / stem / 推断 domain / 目标目录 / 撞名 / 主题候选）。
- `create --json <file|->`：读 `{title, domain?, topic?, status?, research?}`，建 folder + 月度行；
  `research` 写进 README `### 调研` 小节末尾（按 H3 截段，找不到小节不猜落点）。
- 退出码：0 成功 / 2 usage / 3 数据或撞名冲突 / 4 IO。
- `status` 只收 `active`；`topic` 必须指向已存在的主题卡，否则退码 3。
- **`_fs-vault.js` 的方法面契约**：除 `read`/`modify`/`create`/`createFolder`/`getAbstractFileByPath`
  外还必须有 **`list`**（缺了月度文件扫不到、`listRecentTasks` 恒空）、**`delete`**（目录要递归）、
  file 对象要有 **`parent`**（缺了进展归档**静默 no-op**）。
  **接任何 Obsidian helper 到 fsVault 前，先核它用到的全部 vault 方法与 file 字段**——
  这类缺失都不报错，只给空结果。

**联动**：改 `captureIdea` 签名 / `buildFolderReadme` 段落 / 撞名规则 → `agent-capture.js` + 单测；
改 `### 调研` 小节名 → `appendToSubsection` 的 header 参数与模板一起改。
测试：`node --test scripts/mvp/agent-capture.test.js`（临时 fixture vault）。

## MCP 对接面（CLI 为主、命令面为辅）

形态由两条 API 级限制定死：Obsidian 的 `POST /commands/{id}/` **无 request body**（命令拿不到参数）
且 **fire-and-forget**（取不到返回值）。所以「读 + 带参 + 取结果」只能在 CLI 侧成立。

| 面 | 承载 | 能力 |
|---|---|---|
| **CLI（主）** | `node flow/scripts/mvp/mf.js <子命令>` | 读 / 带参 / stdout JSON / 退出码 |
| **命令面（辅）** | 插件的无头命令 | 只做动作，只补 CLI 做不到的 |

| 子命令 | 参数 | 做什么 |
|---|---|---|
| `propose` | `--title <t>` | 只读推断 |
| `create` | `--json <file\|->` | 建任务 |
| `finish` | `--path <任务目录或 README>` | 结案：月度行 + `finish` 里程碑 + 进展归档 |
| `reopen` | `--path <p>` | 重开：月度行回 `active` + `reopen` 里程碑 |
| `progress` | `--path <p> --text "<一行>"` | 追加 `## 进展` 一条 |
| `delete` | `--path <p>` | 留底行降级 → 清双链 → 删文件；**无二次确认** |
| `query` | `[--status active\|finish\|all] [--domain <slug>] [--dep]` | 读面，判据与 Home 卡同源 |

- **输出契约**：stdout 恒为 JSON；错误走 stderr 的 `{"ok":false,"error":…,"code":N}` +
  退出码 0 / 2 / 3 / 4。`_set-status.js` 因此抛带 code 的错误而不是自己 `process.exit`。
- **禁令**：MCP 侧**不许**用通用 vault 写接口直接改状态文件（README frontmatter、月度行）。
  绕过写面只改一处 = 状态没真改。
- **`query --status active` 与 Home 活跃卡同一份成形判据**（`_home-fields.js#activeNodes`）；
  `finish` / `all` 按 **capture 行**取，与 Home「✅ 已完成」卡（按 `milestones` 聚合）**口径不同**，
  两边数字别直接对比。

### 判据唯一定义点：`_home-fields.js`

`finishedFromMilestones`（末位 `reopen` 不算结案）/ `domainLabels` / `taskFields` / `depTasks` /
`activeCaptureRows` / `activeNodes` / `taskCandidateFiles` / `nameOfPath` 都在这里。
插件 `main.js` 的 `home*` 读面只是薄壳（加载 + 缓存 + 注入 vault），`mf.js query` 调同一份。
**改判据去那个文件改，别在插件或 dataviewjs 里补第二份。**
fsVault 侧没有 `getMarkdownFiles`，`taskCandidateFiles` 按 `flow/data/<YYYY>/<Qn>/<MM>/` 结构走，
**不递归进任务的 input/process/output**。

### 命令面

- `miniflow:task-finish-headless` —— 见「headless 结案入口」。
- `miniflow:mf-reindex` —— CLI 写完盘后追平：清域配置缓存 + 补刷被「README 正开着」挡下的目录 +
  强制刷当前任务索引。**不做全库重扫**；无参、不抢焦点，跑完发一条 Notice 报数。
- **改插件 api 与改 `Home.md` 不能同批上线**：Home.md 是数据、改完立即生效，插件代码要**人工重载**。
  先切 Home 会让卡片当场显示「插件未就绪」。

## Obsidian 运行时与索引契约

- **QuickAdd 用户脚本拿不到 `obsidian` 模块**：Obsidian 只在*插件*的 main.js 里注入模块别名，
  插件之外 `require("obsidian")` 一律抛 `Cannot find module`。而 QuickAdd 的加载器把
  `window.require` 原样透传给用户脚本，于是三个弹框命令在**加载期**就死。
  修法在插件 onload 把 `"obsidian"` 接进 `window.require` 的解析链、onunload 还原。
  **插件因此不只是索引器**——停用它，那三个命令立刻全废。
  （本包的命令已改由插件直接跑脚本，但 shim 仍服务外部 QuickAdd 用法，故保留开关。）
- **dataviewjs 块里不要写顶层 `return`**：Dataview 只在脚本文本 `includes("await")` 时才把块包进
  async IIFE，否则裸 `eval`。无 `await` 的块写顶层 `return` → 整块 `Illegal return statement`，
  与数据无关、恒报。空数据/早退一律 if/else 收尾。
- **`DataArray.array` 是方法不是属性**：要原生数组用 `pages.array()`；`pages.sort(keyFn, dir)`
  的第一个参数是**取键函数**不是双参比较器。自定义排序先 `array()` 再 `.sort(cmp)`。
- **`dv.table` 只渲染进 `dv.container`**：想放进自建 div 得临时替换 `dv.container`、渲染完换回来
  （它是普通可写字段；不还原会让块内后续输出跑进错误容器）。
- **`ListItem.file` 取不到**：行所属文件的路径要从**所属页面**拿（遍历 `dv.pages()` 用
  `page.file.path` 配 `page.file.lists` 自己组），别用 `行.file.path`。
- **嵌套 frontmatter 对象（`p.chain` 这类）不可靠**：块形式嵌套对象取值不稳，取到空会让整段逻辑
  退化成「无关系」。要这类数据就自己 `cachedRead` + 正则切 frontmatter。
- **别「边 await 边建 DOM」**：重跑块时区域会被清空重画，等待期间已建好的行会落在被丢弃的旧区域里
  （症状：诊断行有数字、任务行一条不见）。**阶段一把数据全部 await 取齐，阶段二同步建 DOM**。
- `vault.createFolder` 后不会立即刷新 cache；同一事件循环读新目录 `children` 会拿到 stale 快照，
  递归 walk 会生成越界路径。纯 Node 单测抓不到，只在 Obsidian runtime 复现。
  新增「创建后立即扫描 children」的脚本前先确认 cache 同步策略；默认不依赖 walk。

## frontmatter 与 Capture 行契约

- **`milestones`**（`{date, type, note?}` 数组）是里程碑主源：capture 写 `create`，
  finish 写 `finish`，重开写 `reopen`，人可手写 `manual`。**append-only**，键 `{date, type}` 幂等
  （同日重开两次只留一条；**finish 的键不动**，已完成卡按 finish 的最大 date 聚合依赖它）。
  行格式与中文映射由 `_yaml.js`（`serializeMilestone` / `MILESTONE_TYPE`）统一，
  **行统一 2 空格缩进**——顶格虽合法但 Obsidian 判「无效属性」，且不同形会让每次 finish 原地重写、
  diff 带噪声（`_task.test.js` 有缩进守卫）。
- **月度 Capture 行无复选框**，状态是行内互斥标签 `#active` / `#finish`，完成带 `[completion:: 日期]`。
  解析走 `_capture-line.js#parseCaptureLine`，reader-side wide 收历史别名
  （`#now`/`#next`/`#dev_done` → `active`，`#archive` → `finish`），写盘时由 rewrite 清成单标签。
- **留底行的 wiki 降级为纯文本**：删任务保留 capture 行时，行内 `[[...|别名]]` 降级成纯文本标题
  （`demoteCaptureLink`）。理由：目标已删，`[[...]]` 是死链——点它 Obsidian 会新建空笔记，
  短链还会落到 vault 根造出假月目录。**降级必须发生在 `removeBacklinks` 之前**（后者会把整段连标题删空）。
- **Home 渲染对死链降级**：任务目录被非 Task Delete 手段删掉时短链没人降级，Home 渲染时查不到目标
  就出纯文本；**拿不到源文件目录时保持原样**（宁可不降级，也不把正常链接误降）。
- **`external_dep`**（标量字符串）：标「已预判推进但卡在外部输入上」——一句话说明缺什么、找谁、
  期望何时。字段不存在 = 无依赖，空串 = 取消标注。写面是 `_yaml.js#setExternalDep`，
  **别手写 YAML 行**（那是第二份实现）。读面在 Home 活跃卡：⛔ 徽标 + 完整文案副行。
- **`chain`**（`{parent, step, total}`）：任务链关系。`parent` 存**纯路径**而非 wikilink
  （消费方要可直接比较的字符串，图反向链接由正文承担）。**读侧只认 frontmatter**，
  不解析正文——正文标记已出现多种变体，正则不可靠。并行片合法（同一步挂多张卡），链可嵌套。
- **规则 frontmatter**（`type: rule`）：`sources` / `validated_by` / `supersedes` / `superseded_by` /
  `status`（`proposed → confirmed → deprecated`）。
  自动晋级阈值：sources + validated_by 合并去重 **≥2** 才 confirmed，且：
  - **只统计 `[[wikilink]]` 条目**（纯文本来源不进计数）；
  - **去重按「任务身份」而非文档路径**——同一任务的 README + process 多篇折叠成 1。
  推论：一个任务自己提出再自己验证**不会**晋级；纯文本来源的规则天然更难晋级。
  Home「⏳ 规则待复盘」卡的两列是**条目数**不是任务数，别据此判断已达阈值。
- **任务侧两段反向链**：`## 产出规则`（我提出了这条）与 `## 引用规则`（我用了这条），
  分别由 rule-capture / rule-validate 幂等追加。

## domain 与 topic

- `domains/<slug>/flow.json` 的 `keywords` 是 capture 领域推断的规则源；
  `topics/<id>.md` 的 `auto_keywords` 是主题卡聚合的事实源。**字段名刻意区分**。
  新增 domain 必须同步填 `keywords`，否则推断退化为兜底域。
- capture / edit **都不渲染领域 UI**，改领域手改 README frontmatter。
- **存储主轴是日期** `flow/data/YYYY/Qn/MM/`，**不按 topic/domain 物理分目录**：
  topic 会改名废弃、domain 虽稳定但主导浏览轴是时间。按域搬目录会把时间视图挤成虚拟查询。
- **topic 单值**：一个任务至多挂一个主题（frontmatter 标量 `topic:`）。
  domain 担归口轴、标题担名物轴，剩下的交叉维度结构性地至多一个；多选只诱导标签囤积。
- **两级主题**：主题卡可选 `parent_topic`（空串 = 根）。任务侧仍单值，
  **父卡反向聚合**子主题 ids（窄写宽读：写路径不感知父子关系）。
  挂载规则：先过「与 domain 同值 / 与任务标题同名」两闸；跨子线的挂父，只服务单一子线的挂子；
  1:N 稳定子流不足时不建父子（几个临时方向用正文 `#### 子方向` 承接）。
- 主题挂**标题与 domain 都未承载的交叉维度**；`status: deprecated` 的主题不进候选、不参与召回，
  但文件与 id 保留（历史 wikilink 可追溯）。
- 导航行（领域 → 域 CLAUDE、主题 → 主题卡）是 **capture 时的快照**，改域/改主题不重渲染。

## Mini Flow 状态机

两档：`active` / `finish`。**本段是状态机的唯一定义点。**

| 值 | 含义 | capture 行 | milestone |
|---|---|---|---|
| `active` | 活跃（在做 / 待办，同一档） | `#active` | 不带 completion |
| `finish` | 结案（做完 / 主动关闭） | `#finish` + `[completion:: 日期]` | `finish` |

合法切换：`active → finish`；`finish → active`（Task Edit 的重开 chip，留 `reopen` 里程碑）；
`active → active` 无意义。

历史档位 reader-side 宽读归一（见上「Capture 行契约」），写盘时清成单标签。
**状态由开发者手工维护**，不被任何外部系统的状态变化自动驱动。

### 改动联动清单

新增 / 改写状态档时以下必须同批改：

- `_status.js` —— `STATUSES` 数组、`ACTIVE_STATUSES` 派生、`isReopenTransition`
- `task-edit.js` —— chip 渲染与重开里程碑写入
- `task-capture.js` —— 只暴露 `active`
- `plugin/main.js` —— **第二处 STATUSES 消费方**（闪念转任务 Modal）
- `mvp/agent-capture.js` —— `status` 入参白名单
- `_capture.js` —— capture 行默认档
- `_capture-line.js` —— 状态正则 + `STATUS_ALIAS` 归一表（漏了该档任务会显示「无状态」、活跃卡收不到）
- `task-search.js` —— status icon 映射
- `_capture-line-rewrite.js` —— **月度行改写的唯一实现**（checkbox 归一 + 历史标签清理）
- `mvp/_set-status.js` —— CLI 状态写面（改月度行**并**写 `milestones`）
- `mvp/mf.js` —— `finish` / `reopen` 子命令
- `_set-status.test.js` / `mf.test.js` / `_rewriteStatus.test.js` / `_status.test.js` / `_yaml.test.js`
- `task-finish-gui.js` —— 交互层 + 结案编排
- `Home.md` —— 已完成卡按**最后一条里程碑事件**判定（末位 `reopen` 不算已完成）

### task-finish 的 README 收口

推进到 `#finish` 前只做一道收口：**`## 进展` 段 bullet 超上限**（默认 5，配置
`behavior.progressSoftLimit`）则把最早 N 条归档到 `process/R-进展历史.md`（追加，H3 分隔 `## <完成日> 归档`）。

- bullet 判据 `- YYYY-MM-DD[ · 模型] | …`，**模型名可含空格**，正则取 `[^|\n]+` 而非单 token
  （单 token 写法认不出带空格的名字，计数恒 0、归档永不触发）。
- **段头正则必须容忍行尾 `\r`**：autocrlf 环境下按 `\n` 切行后每行带 `\r`，
  逐行 `.test(line)` 且无 `/m` 时 `$` 不认 `\r` → 段头恒不命中 → 计数恒 0、归档静默失效。
  `locateProgressSection` 与 `countProgressBullets` 都写 `\r?$`，**改判据两处一起改并补 CRLF 夹具**。
- 计数与追加算法在 `_progress.js`（GUI 与 CLI 共用）。
- `## 结果` 段**不是卡点**：不强制填、不弹 prompt、不主动创建。

### 交付证据软闸（设计 / 自测段）

交付任务结案时若 `### 设计` / `### 自测` 段还是模板骨架就提示，**不拦**。

- **交付任务口径走配置**：`behavior.deliveryDomains`（这些域一律算交付）∪ 有外部工作项 id
  ∪ 有 `output/` 交付物且不在 `behavior.deliveryExcludeDomains` 里。
  两项默认空 → 口径退化为「有 id 或有交付物」，仍是有效软闸。
  **代码里不写死任何人的业务域名**；溯源链一类的聚合脚本读同两项配置，别另写一份清单。
- **「空」= 段在但无正文**。段整个不存在 → 不适用、不提示。剥掉的骨架四类：空行 / `>` 引用行 /
  表格结构行（分隔行、紧邻分隔行的表头行、全空单元格行）/ 模板说明行。
  **改模板这两段的文案要同步 `TEMPLATE_GUIDANCE_PREFIXES`**，漏改会让该段永远判「有正文」、软闸静默失效。
- **提示挂哪看入口**：人点的并进既有确认框文案（不叠横幅）；无头 / 后台发一条 Notice；
  CLI 进返回对象的 `evidenceWarning` 字段。
- **四个 finish 写手共用同一份判据**：`task-finish-gui.js#runFinish`、插件后台结案、
  `mvp/_set-status.js`（`mf.js finish` 与两个薄 CLI）。`_finish.js` 只出判据与文案。

### task-finish 关闭 README 后的落点

关掉展示该任务 README 的 leaf；**被关的正好是当前活动页时**才回首页
（纯函数 `shouldFocusHome(activePath, readmePath)`）。从月度行触发、README 开在别的 tab 时**不跳**
——抢焦点会打断连续处理 capture 行的批处理流。

回首页优先走 homepage 插件命令（软依赖，只走命令 id）；未注册或抛错时直接开首页，
**那条路必须先找已开的 leaf 再开**，否则会开出第二个首页 tab。首页缺失则 no-op。
Task Delete 复用同一份 `closeReadmeLeaf`，顺序是**先关 tab 再删文件**（文件一删 `leaf.view.file` 就不可靠）。

### headless 结案入口

人点的 Task Finish 带 `window.confirm` 且依赖**活动文件/光标**，无头通道点不掉原生确认框。
所以插件注册了一个**无确认**命令 `miniflow:task-finish-headless`。

- **唯一编排**：`task-finish-gui.js#runFinish(app, opts)`——定位月度行 → 反查 README → 进展收口 →
  推进状态机 → 写两处写面。交互一律**注入**：`opts.confirm`（不传 = 跳过）、
  `opts.afterFinish`（不传 = 不关 tab、不回首页）、`opts.today`。盘面动作仍在 `_finish.js`，
  **三层都不许各写一份**。
- **用法两步，第二步要复核**：① 打开目标 README → ② 调命令。
  `open_file` **不保证把文件设为活动页**，调用后必须复核活动文件路径，不对就重开再调。
- 跑完发**一条** Notice 报结果（`done` / `no-target` / `not-line` / `already`）——
  后台动作没有盘面反馈，静默就无从判断成没成。
- **`afterFinish` 的契约是 `(readme)`**，而 `closeReadmeLeaf(app, readme)` 是两参——
  直接注入会让 app 收到 readme、readme 收到 undefined。必须箭头闭包包一层
  （`task-finish-gui.contract.test.js` 守这条）。

## 任务链与阶段验证

大任务（单个任务装不下、需要有序多步才能交付）按本段处理。**不改数据模型、不改状态机**。

- **判定时点在调研之后**，不在 capture 之时。判据四条见用户文档「大任务要不要拆」。
  判定结论写进 `### 调研`。
- **三种形态别混用**：任务内阶段化（默认）/ 并行片（父任务持唯一定义点 + 兄弟任务各做一片）/
  串行链（前驱未 finish 且未留验证结论时后继不得置 active）。
- **链的关系正文 + frontmatter 双写**：正文写「拆自 [[父任务]] 第 N 步」（人类叙事、图反向链接），
  机器读的关系落 `chain` frontmatter。**读侧只认 frontmatter**。
- **阶段验证闸是软闸**：形态一的验收结论写在 `process/` 阶段文档末尾；串行链每个任务 finish 前
  必须在 `### 自测` 留验证结论（跑了什么命令、哪些点位、结论与未覆盖边界），
  并记一条 `{type: manual, note: 验证通过}` 里程碑。
  **验证结论由自动化测试产出的必须标档位**——把值注入级的测试写成「端到端打通」就是虚假绿灯。
- **明确不做**：自动判定、硬闸（与「谁能改状态」的原则相冲）、人日估算、
  用于自动放行的字段（`chain` 只服务**显示**，`step` 不唯一，撑不起偏序）。

## Notice 策略

**成功反馈不依赖 Notice 横幅**，靠 UI 状态变化自带告知：弹框关闭 + 新文件打开（capture）、
文件树刷新（delete）、闪念行出现/消失（idea capture / 转任务）。成功后再叠一条 Notice 是冗余横幅。

**保留 Notice 的三类**：① 错误/异常；② 边界提示（「请先打开任务 Capture 行」「当前文件类型不匹配」
「因果边已悬空」）；③ 动作范围比预期小（「已移除任务：X」——文件本来就不存在，只删了行）。

另有**后台动作**：无可见 UI 反馈时保留**一条**汇总 Notice（逐条明细只进 console）。

复合提示（「步骤 A 成功 + 步骤 B 失败」）用**单条** Notice 把已成功的部分明说，
让人知道不必手动重建——那不是成功反馈，不在禁止之列。

## 测试

```bash
node --test scripts/quickadd/mini/*.test.js
node --test scripts/mvp/*.test.js
```

裸 node，无框架依赖。改判据函数必须同批改单测；改 CLI 必跑 `mf.test.js`；
改 `_capture.js` / `_task.js` 时一并跑 `agent-capture.test.js`。

**纯 Node 单测抓不到的**：Obsidian cache 时序、dataviewjs 运行时行为、真实 vault 的 CRLF 行尾。
前者只在 Obsidian 里复现，后者要**显式补 CRLF 夹具**（LF 夹具测不出那个盲区）。