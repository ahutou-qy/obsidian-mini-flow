# 安装：从零到跑通一条任务

目标：一个空 Obsidian vault，装完后能 **建任务 → 打卡 → 结案**，Home 上看到它。

全程约 10 分钟。下面每一步都标了「怎么确认这步成了」——装不上时按顺序回查，
不要跳步（后面几步依赖前面的目录布局）。

---

## 0. 前置

| 要什么 | 必需性 | 说明 |
|---|---|---|
| Obsidian ≥ 1.4 | 必需 | 桌面端。移动端能读数据，但安装脚本与 CLI 跑不了 |
| 一个 vault | 必需 | 已有的也行；本安装只新增目录，不动你已有的笔记 |
| PowerShell 7 / bash | 必需 | 安装脚本用。Windows 自带的 5.1 也能跑，但推荐 7 |
| Node.js ≥ 18 | 可选 | 只有 CLI（`flow/scripts/mvp/`）与单测要它 |
| Dataview 插件 | 可选 | Home 四张卡要它；不装则任务系统照常，只是没有看板 |
| pandoc | 可选 | 只影响 MD2EPUB 一个命令 |

**不需要 QuickAdd。** 早期版本的命令挂在 QuickAdd 宏上，现在全部是插件自带命令。

---

## 1. 拿到本仓

```bash
git clone <本仓地址> obsidian-mini-flow
cd obsidian-mini-flow
```

本仓**就是代码本体**，不是「解压后拷进去」的发行包——下一步把它挂进 vault，
之后改仓里的文件 vault 立刻生效，代码只有一份。

---

## 2. 挂载进 vault

```powershell
# Windows
.\install.ps1 -VaultRoot D:\vaults\my-vault --dry-run   # 先看会做什么
.\install.ps1 -VaultRoot D:\vaults\my-vault
```

```bash
# macOS / Linux
./install.sh --vault ~/vaults/my-vault --dry-run
./install.sh --vault ~/vaults/my-vault
```

它按 `mounts.json`（**挂载表唯一真源**）建 7 个挂载点：

| vault 内路径 | 指向本仓 | 形态 |
|---|---|---|
| `.obsidian/plugins/miniflow/` | `plugin/` | 目录 junction（Win）/ symlink（mac） |
| `flow/scripts/quickadd/mini/` | `scripts/quickadd/mini/` | 同上 |
| `flow/scripts/mvp/` | `scripts/mvp/` | 同上 |
| `flow/templates/task/` | `templates/task/` | 同上 |
| `.obsidian/snippets/miniflow-home.css` | `snippets/miniflow-home.css` | 文件 symlink |
| `flow/CLAUDE.md` | `docs/flow-CLAUDE.md` | 文件 symlink |
| `flow/README.md` | `docs/flow-README.md` | 文件 symlink |

- **幂等**：连跑两次，第二次全 skip。
- **备份**：vault 里那几条路径原本有真内容时，先备份到 `vault/.miniflow-backup/<时间戳>/` 再替换。
- **权限退路**：Windows 未开开发者模式、非管理员时单文件 symlink 建不了，脚本改为**拷贝落地**
  并明确告知「以后改仓不会自动同步，要重跑脚本刷新」。看到这条就去
  设置 → 系统 → 开发者选项 打开「开发人员模式」，再 `--uninstall` + 重装。
- **`--refresh`（只在一种情况下用）**：vault 里已有比本仓更新的同名内容、且你想保留 vault 那份时，
  先 `--refresh` 把 vault 内容回灌本仓再挂载。全新安装用不到。

**确认这步成了**：

```powershell
.\install.ps1 -VaultRoot D:\vaults\my-vault --verify
```

七条全 `OK`。有一条不对就重跑安装（幂等，不会重复建）。

---

## 3. 配置与样例数据

安装脚本**不碰配置**（配置是各人自己的，不该被脚本覆盖），手动复制三样：

```bash
cd <vault 根>

# ① 配置：example → 真文件
mkdir -p flow/config
cp <本仓>/config/miniflow.json.example flow/config/miniflow.json

# ② 文案表（界面中文；en.json 是未翻译的骨架）
cp -r <本仓>/config/i18n flow/config/i18n

# ③ 示例领域与主题（替代包里没有的私有数据）
mkdir -p flow/data/domains flow/data/topics
cp -r <本仓>/samples/domains/sample-work      flow/data/domains/
cp -r <本仓>/samples/domains/sample-personal  flow/data/domains/
cp    <本仓>/samples/topics/*.md              flow/data/topics/
```

Windows 用 `Copy-Item -Recurse` 等价。**没有领域目录，capture 的领域推断会全线兜底**——
这步别跳。

配置里值得先看的两组：

- `behavior.deliveryDomains` / `deliveryExcludeDomains`：**你自己的交付线域名**。
  留空也能用（口径退化为「有外部工作项 id 或有 `output/` 交付物即交付任务」）。
- `paths`：首页 / 闪念文件 / 领域根 / 主题根。清空即回默认。
  **任务根与月度文件名不在这**——它们是识别口径（正则里写死 `flow/data`），
  改了会「读得到目录却认不出任务」，理由见 `flow/scripts/quickadd/mini/_config.js` 头注。

**确认这步成了**：`flow/config/miniflow.json` 存在且是合法 JSON；
`flow/data/domains/` 下有两个目录、各带 `flow.json`。

---

## 4. 启用插件

Obsidian 里：设置 → 第三方插件 → 关闭「安全模式」→ 已安装插件列表里启用 **Mini Flow**。

列表里没有它时点「刷新」；仍没有就回查第 2 步的 `.obsidian/plugins/miniflow/` 挂载。

启用后设置页会多出 **Mini Flow** 一节：功能模块开关、行为参数、交付口径、路径。

> 设置页里的「云效 / qy 集成」开关**本包未含该模块**，拨它不产生效果——
> 保留键位只为配置键集合一致。

**确认这步成了**：命令面板（`Ctrl/Cmd+P`）搜 `Task Capture` 能搜到。

---

## 5. 键位

19 个命令都带**预设键位**（Obsidian 的「插件默认键」机制，装上就有）：

| 命令 | 键 | 命令 | 键 |
|---|---|---|---|
| Task Capture | `Mod+T` | Topic | `Mod+Shift+K` |
| Idea Capture | `Mod+I` | Task Upgrade | `Mod+Shift+U` |
| Task Edit | `Mod+Shift+E` | Rule Capture | `Mod+Alt+C` |
| Task Finish | `Mod+Alt+F` | Rule Validate | `Mod+Alt+V` |
| Task Delete | `Mod+Shift+D` | Rule Promote | `Mod+Alt+P` |
| Task Search | `Mod+Shift+S` | Rule Deprecate | `Mod+Alt+D` |
| Progress Checkin | `Mod+Shift+P` | MD2EPUB | `Mod+Alt+E` |
| Open Claude | `Mod+Shift+C` | Open Finder | `Mod+Shift+O` |

`Mod` = Windows/Linux 的 `Ctrl`、macOS 的 `Cmd`（Obsidian 自动映射，不用改）。

**可能与你已有的键冲突**：设置 → 快捷键 里冲突项会标红，自行改。
改了就覆盖预设，不用动代码。

另外三个命令没有预设键（供无头通道调用，见 `docs/flow-CLAUDE.md`「MCP 对接面」）：
`刷新当前任务索引`、`Task Finish（无确认，供 MCP 调用）`、`MF 重建索引`。

---

## 6. Home 看板（可选，要 Dataview）

1. 装并启用 **Dataview** 插件，设置里打开 **Enable JavaScript Queries**（`dataviewjs` 靠它）。
2. 复制模板：`cp <本仓>/assets/Home.md <vault>/Home.md`
3. 复制布局 snippet：`cp <本仓>/snippets/columns.css <vault>/.obsidian/snippets/`
   （`miniflow-home.css` 第 2 步已挂进 `.obsidian/snippets/`，不用拷）。
4. 启用 CSS：设置 → 外观 → CSS 代码片段 → 刷新 → 打开 **columns** 与 **miniflow-home** 两条。

**两条 snippet 都要开**：`columns.css` 提供 `[!cols]` 的分栏容器（flex + `display:contents` 透传），
`miniflow-home.css` 在它之上叠卡片样式与网格。只开后者，四张卡会竖成一列。

> 主题不是硬依赖。上游用的是 Minimal，换别的主题卡片配色会不同，布局与功能不受影响。

四张卡：**🏠 工作事务**（活跃任务，按域分组、任务链缩进）/ **💡 闪念** / **⏳ 规则待复盘** / **✅ 已完成**。

- 卡片取数走插件 api（`app.plugins.plugins["miniflow"].api`），**不依赖 Dataview 索引**——
  改任务正文不会让整卡闪烁。插件没启用时卡面会显示「插件未就绪」。
- 任务行尾的 **▶️** 按钮在该任务目录起一个 Claude Code 会话；没装 Claude Code 时点它会报错，
  不影响其它功能。
- 首页路径可改（配置 `paths.homePath`）；Task Finish 关掉任务后会回它。

---

## 7. 跑通一条任务

1. `Mod+T` → 输入 `示例任务` → 提交。
   领域推断应命中 `sample-work`（标题含「示例」）；主题可选。
2. 提交后任务 README 自动打开，路径是
   `flow/data/<年>/<季>/<月>/示例任务/README.md`，同级建好 `input/` `process/` `output/`。
3. `Mod+Shift+P`（Progress Checkin）→ 输入一句话 → README 的 `## 进展` 段多一条
   `- <今天> | 那句话`。
4. `Mod+Alt+F`（Task Finish）→ 确认。
   月度文件 `flow/data/<年>/<季>/ideas-<年-月>.md` 的那行变成 `#finish` 并补
   `[completion:: <今天>]`；README frontmatter 的 `milestones` 追加一条 `{type: finish}`。
5. Home 上它从「🏠 工作事务」挪进「✅ 已完成」。

**四处都对上才算装好**：任务目录、月度行、`milestones`、Home 卡。
只对上其中一两处时看下面的排查表。

---

## 8. CLI（可选，要 Node）

```bash
cd <vault 根>
node flow/scripts/mvp/mf.js query --status active
node flow/scripts/mvp/mf.js create --json -      # 从 stdin 读 {"title":"…","domain":"…"}
node flow/scripts/mvp/mf.js finish --path flow/data/<年>/<季>/<月>/<任务>
```

stdout 恒为 JSON；退出码 0 成功 / 2 用法 / 3 数据冲突 / 4 IO。
`agent-capture.js` 是给 AI agent 用的等价入口（需要 Claude Code 才有意义）。

**junction 下的 vault 根定位**：Node 会把 junction 解析成真实路径，所以 CLI 不靠
`__dirname` 上溯推 vault 根。定位顺序：环境变量 `MINIFLOW_VAULT_ROOT` → 入口脚本的逻辑路径 →
cwd → 本仓根的 `.miniflow-local.json`（安装脚本写，逐机器、不进 git）→ **报错**。
在 vault 根跑就不会踩到；在别处跑请设 `MINIFLOW_VAULT_ROOT`。

CLI 写完盘后，Obsidian 侧索引可能滞后（README 正开着时插件会跳过重写）——
跑一次命令 `MF 重建索引` 追平。

---

## 9. 自测

```bash
cd <本仓根>
node --test scripts/quickadd/mini/*.test.js
node --test scripts/mvp/*.test.js
```

裸 node，无框架依赖。全绿说明脚本层没问题；界面层的问题看下面。

---

## 排查表

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 命令面板搜不到 Task Capture | 插件没启用 / 挂载没建 | 第 2、4 步；`--verify` |
| 按命令报 `Cannot find module 'obsidian'` | require shim 被关了 | 设置页打开「QuickAdd obsidian 模块注入」 |
| 建任务落到 vault 根、月目录名奇怪 | 领域目录缺失或任务根被改过 | 第 3 步；`paths` 里没有任务根，别自己加 |
| Home 卡显示「插件未就绪」 | 插件没启用，或改了插件代码没重载 | 启用 / 重载插件（本仓不含 hot-reload） |
| Home 卡空白不报错 | Dataview 的 JS 查询没开 | 第 6 步第 1 条 |
| Home 四张卡竖成一列、没有分栏 | `columns.css` 没拷或没启用 | 第 6 步第 3、4 条（两条 snippet 都要开） |
| Home 卡数据不刷新 | 旁路写入没触发重绘 | 切走再切回窗口（回焦点是兜底触发点） |
| 文件索引段不更新 | README 正被编辑（插件刻意跳过） | 关掉编辑或跑「刷新当前任务索引」 |
| 界面还是中文，改了 locale 没用 | 文案表没复制到 `flow/config/i18n/` | 第 3 步②；`en.json` 是**未翻译**骨架，切英文只会回落中文 |
| CLI 报「定位不到 vault 根」 | 在 vault 外跑 | `cd` 到 vault 根，或设 `MINIFLOW_VAULT_ROOT` |
| `--verify` 报配置键集合漂移 | 加/删了配置键但没同步 example | 两边键补齐（**取值不同是正常的**，不比取值） |

---

## 卸载

```powershell
.\install.ps1 -VaultRoot D:\vaults\my-vault --uninstall
```

移除挂载点，并从 `.miniflow-backup/<时间戳>/` 还原挂载前的内容。
你的任务数据（`flow/data/`）不受影响——它从来不在本仓里。