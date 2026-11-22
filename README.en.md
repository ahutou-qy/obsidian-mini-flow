# Mini Flow

**A task system for Obsidian where Markdown is the only storage.** No database, no cloud, no
proprietary format — a task *is* a folder, a status *is* a line of text, a milestone *is* a
frontmatter field. Close Obsidian, change machines, come back in ten years: your tasks are still
plain files you can read.

One plugin + a set of vault scripts + a Home dashboard cover the whole loop:
**fleeting idea → task → delivery → reusable rule**.

- License: MIT
- Plugin id: `miniflow` (display name `Mini Flow`; the repository is `obsidian-mini-flow` on purpose —
  the plugin id is baked into the manifest, command ids and config paths)
- UI language: Chinese-first, with all strings moved into a resource file (`flow/config/i18n/zh.json`).
  An `en.json` skeleton exists but is **not translated yet** — missing keys fall back to the Chinese
  source text, so you always see something.

> 中文版见 [README.md](README.md)。

## What it looks like

```
flow/data/2026/Q4/11/some-task/
├─ README.md          the task itself: file index + progress + input + five engineering sections
├─ input/             raw external input (manuals, screenshots, customer material)
├─ process/           your own working artifacts (scripts, analysis, logs)
└─ output/            deliverables
```

Status lives on a single line in the monthly file `flow/data/2026/Q4/ideas-2026-11.md`:

```markdown
- [[11/some-task/README|some-task]] #active ^cap-abc123
```

Two mutually exclusive inline tags — `#active` / `#finish` — plus `[completion:: 2026-11-22]` when
finished. The task README carries an append-only `milestones` array in its frontmatter
(`create` / `finish` / `reopen` / `manual`). **Both write surfaces are maintained by the same code**,
so they cannot drift apart.

## What's inside

| Area | Details |
|---|---|
| **19 plugin commands** | Task Capture / Edit / Finish / Delete / Search / Upgrade, Idea Capture, Progress Checkin, Topic, Rule Capture / Validate / Promote / Deprecate, Open Claude / Finder, MD2EPUB, plus three headless commands. **QuickAdd is not required.** |
| **Preset hotkeys** | Declared through Obsidian's "plugin default hotkeys" mechanism, so they work right after install and can be rebound in Settings → Hotkeys. |
| **Home dashboard** | Active tasks (grouped by domain, task chains indented) / ideas / rules due for review / finished. Template and CSS ship with the package. |
| **Automatic file index** | Adding or removing files inside a task folder rewrites the README's `## 文件索引` section (between sentinel comments; humans don't touch it). |
| **Domain rule library** | Distil a `proposed` rule after delivery; it is promoted to `confirmed` once a **different task** validates it. |
| **Two-level topics** | A task links one topic; a parent topic aggregates tasks of its child topics. |
| **CLI / MCP surface** | `mf.js` with `create` / `finish` / `reopen` / `progress` / `delete` / `query`, always emitting JSON on stdout (optional, see below). |
| **Settings page** | Feature toggles + behaviour parameters + delivery criteria + paths, all written to `flow/config/miniflow.json` inside the vault. |

## Quick start

See **[docs/INSTALL.md](docs/INSTALL.md)**. The short version:

```powershell
# Windows (macOS: ./install.sh --vault <path>)
.\install.ps1 -VaultRoot D:\path\to\your\vault
```

The installer links this repository's directories **into** your vault (junction on Windows, symlink
on macOS), so there is exactly one copy of the code — edit here, the vault sees it immediately.

Then copy the config and samples, enable the CSS snippets, and install Dataview. INSTALL walks
through it step by step, with a troubleshooting table at the end.

## Documentation

| Document | Audience |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | First-time install: from zero to a working capture → finish loop |
| [docs/flow-README.md](docs/flow-README.md) | Daily users: command table, workflow, how the four entities close the loop, conventions (Chinese) |
| [docs/flow-CLAUDE.md](docs/flow-CLAUDE.md) | People changing the code / AI agents: implementation contract, single-writer rules, state machine, change checklists (Chinese) |

> All documents under `docs/` are currently written in Chinese. This English README covers what the
> project is, what it contains and how to start; the step-by-step install instructions are in
> `docs/INSTALL.md` and are mostly commands, paths and expected results.

## Optional dependencies

| Dependency | What breaks without it |
|---|---|
| **Dataview plugin** | The four Home cards don't render (they are dataviewjs blocks). The task system itself is unaffected. |
| **Node.js** | The `flow/scripts/mvp/` CLI is unavailable. Every in-Obsidian command still works. |
| **Claude Code** | `mf.js` / `agent-capture.js` are channels for AI agents; without it you simply don't use that half — **not required**. |
| **pandoc** | Only the MD2EPUB command. |

## What is *not* in this package

- **Private data** — real tasks and business-specific domain keyword tables. Only `samples/` ships
  (one work domain, one personal domain, two topic cards).
- **An external work-item integration module** — the upstream private deployment has an optional
  module that materialises tickets from an issue tracker and consumes fact queues. It is bound to a
  private CLI, so it is **cut out entirely** during export. The settings page keeps a placeholder
  toggle (to keep the config key set stable); flipping it does nothing.
- **Configurable data contracts** — the capture line format, frontmatter field names and the
  `milestones` schema are product conventions. Making them configurable would only make different
  people's data incompatible. What *is* configurable: paths, thresholds, feature toggles,
  delivery criteria.

## Tests

```bash
node --test scripts/quickadd/mini/*.test.js
node --test scripts/mvp/*.test.js
```

Plain `node --test`, no test framework.

## License

MIT, see [LICENSE](LICENSE).