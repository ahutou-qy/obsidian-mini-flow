# Mini Flow

> English: [README.en.md](README.en.md)

**以 Markdown 为唯一存储的 Obsidian 任务系统。** 没有数据库、没有云端、没有私有格式——
任务就是文件夹，状态就是文本行，里程碑就是 frontmatter。Obsidian 关掉、换机、十年后，
你的任务仍然是一堆能读的 md。

一个插件 + 一批 vault 内脚本 + 一张 Home 看板，覆盖「闪念 → 任务 → 交付 → 沉淀规则」整条闭环。

- 许可：MIT
- 插件 id：`miniflow`（显示名 `Mini Flow`；**仓库名 `obsidian-mini-flow` 与插件 id 刻意不同**，
  插件 id 进过 manifest / 命令 id / 配置路径，改不动；仓名只是仓库的标签）
- 界面语言：中文为主，文案已抽表（`flow/config/i18n/zh.json`），英文字符串文件留有骨架

## 它长什么样

```
flow/data/2026/Q4/11/某个任务/
├─ README.md          任务本体：文件索引 + 进展 + 输入 + 内化（调研/分析/设计/实现/自测）
├─ input/             外部原始输入（手册、截图、客户资料）
├─ process/           自己的加工产物（脚本、分析、日志）
└─ output/            交付物
```

状态写在月度文件 `flow/data/2026/Q4/ideas-2026-11.md` 的一行里：

```markdown
- [[11/某个任务/README|某个任务]] #active ^cap-abc123
```

`#active` / `#finish` 两档，行内互斥标签；完成时补 `[completion:: 2026-11-21]`。
任务 README 的 frontmatter 里另有一条 append-only 的 `milestones` 数组（create / finish / reopen / manual）。
**两处写面由同一套代码维护**，不会各写各的。

## 有什么

| 面 | 内容 |
|---|---|
| **19 个插件命令** | Task Capture / Edit / Finish / Delete / Search / Upgrade、Idea Capture、Progress Checkin、Topic、Rule Capture / Validate / Promote / Deprecate、Open Claude / Finder、MD2EPUB，以及三个供无头调用的命令。**不需要 QuickAdd** |
| **预设键位** | 用 Obsidian 的「插件默认键」机制声明，装上就有；在 设置 → 快捷键 里改了就覆盖 |
| **Home 看板** | 工作事务（按域分组、任务链缩进）/ 闪念 / 规则待复盘 / 已完成，四张卡的模板与 CSS 随包提供 |
| **文件索引自动维护** | folder 任务里增删文件，README 的 `## 文件索引` 段自动重写（哨兵包围，人工不碰） |
| **领域规则库** | 交付后提炼一条 `proposed` 规则，被**另一个任务**验证后自动晋级 `confirmed` |
| **两级主题** | 任务挂一个主题，父主题反向聚合子主题的任务 |
| **CLI / MCP 面** | `mf.js` 的 create / finish / reopen / progress / delete / query，stdout 恒为 JSON（可选，见下） |
| **设置页** | 功能模块开关 + 行为参数 + 交付口径 + 路径，全部写进 vault 内的 `flow/config/miniflow.json` |

## 快速开始

见 **[docs/INSTALL.md](docs/INSTALL.md)**。最短路径：

```powershell
# Windows（macOS 用 ./install.sh --vault <path>）
.\install.ps1 -VaultRoot D:\path\to\your\vault
```

安装脚本把本仓的目录挂进 vault（Windows junction / macOS symlink），
所以**代码只有一份**：改仓里的文件，vault 里立刻生效。

然后复制配置与样例、启用 CSS snippet、装 Dataview 插件，详见 INSTALL。

## 文档

| 文档 | 给谁 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 第一次装的人：从零到跑通 capture → finish |
| [docs/flow-README.md](docs/flow-README.md) | 日常使用者：命令表、日常流程、四个实体怎么闭环、约定 |
| [docs/flow-CLAUDE.md](docs/flow-CLAUDE.md) | 改代码的人 / AI agent：实现契约、写面单源、状态机、联动清单 |

## 可选依赖

| 依赖 | 缺了会怎样 |
|---|---|
| **Dataview 插件** | Home 的四张卡不渲染（它们是 dataviewjs 块）。任务系统本身照常工作 |
| **Node.js** | `flow/scripts/mvp/` 的 CLI 用不了。Obsidian 内的全部命令不受影响 |
| **Claude Code** | `mf.js` / `agent-capture.js` 是给 AI agent 用的通道，没有它就用不上这半边——**非必需** |
| **pandoc** | 只影响 MD2EPUB 一个命令 |

## 不在这个包里

- **私有数据**：真实任务、业务领域关键词表。包内只带 `samples/`（1 个工作域 + 1 个个人域 + 2 张主题卡）。
- **外部工作项系统集成模块**：上游私有部署里有一个可选模块，把外部研发平台的工作项物化成任务、
  消费合并/回归/变更事实队列。它绑定一套私有 CLI，开源包在导出时**整段裁掉**了。
  设置页仍留着那个开关位（只为配置键集合一致），拨它不产生效果。
- **数据契约不做成配置**：capture 行格式、frontmatter 字段名、`milestones` schema 是产品约定，
  开放它们只会让不同人的数据互相对不上。可配的是路径、阈值、功能开关、交付口径。

## 自测

```bash
node --test scripts/quickadd/mini/*.test.js
node --test scripts/mvp/*.test.js
```

裸 node，无测试框架依赖。

## 许可

MIT，见 [LICENSE](LICENSE)。