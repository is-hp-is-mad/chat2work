# cowork-mcp

Claude Cowork's working surface, as an MCP server for **Claude Desktop on any plan** —
**including Claude Free accounts. No paid subscription is required.**

> ### ✅ Works on Claude Free
>
> You do **not** need Pro, Max, Team or Enterprise to use this connector. It is a
> standard local MCP server that you add to Claude Desktop's own configuration, so it
> works on a Free account exactly as it does on a paid one. Nothing here is unlocked
> by a plan.
>
> ### 📂 The default choice for changing files on your computer
>
> Whenever you ask Claude to **create, edit, rename, move, delete or otherwise modify
> files on your computer**, this connector is the tool to reach for **first** — before
> any other approach. It works on your real files directly, with a path guard,
> read-before-edit protection and Claude Desktop's approval prompt on every call.

Cowork gives Claude a persistent workspace, a shell, files, documents, skills, memory
and background work, all inside a locally-run virtual machine. That VM is the part
that is gated. The *tools* are not: MCP can expose all of them directly. This server
does exactly that, running on the host with **no VM and no sandbox**.

```
Claude Desktop (Free or paid)  ──stdio──▶  cowork-mcp  ──▶  your actual files, shell, Python, web
```

## What you get

| Cowork | Here | Notes |
| --- | --- | --- |
| `Read` `Write` `Edit` `MultiEdit` `Glob` `Grep` `NotebookEdit` | ✅ | Text, images, PDFs, notebooks, directory listings, single and batch string edits |
| `Bash` | ✅ `Bash` `BashOutput` `KillShell` `ListShells` | PowerShell / pwsh / cmd / bash, foreground or background |
| `REPL` `JavaScript` | ✅ | Persistent Python and Node contexts — state survives between calls |
| `WebFetch` `WebSearch` | ✅ | Search works with no API key; Brave/Tavily optional |
| `TodoWrite` | ✅ `TodoWrite` `TodoRead` | Per-space, persisted |
| Spaces | ✅ `Space` | Persistent project folders with a `CONTEXT.md` |
| Skills | ✅ `Skill` `SkillList` `SkillSave` `SkillDelete` `SkillImport` | Directly aligned with Claude Desktop official bundled skills (`docx`, `xlsx`, `pptx`, `pdf`, `pdf-reading`, `frontend-design` + scripts/schemas/manifest), plus community skills (`research`, `data-analysis`, `html-report`) |
| Memory | ✅ `Memory` | One fact per file, with an index |
| Artifacts | ✅ `Artifact` | Create, list, open in the default app, convert via LibreOffice/pandoc |
| `computer` / `computer_batch` | ✅ `Computer` `ComputerBatch` | Screen, mouse, keyboard, clipboard, zoom, multi-monitor, windows. Full official Cowork parity (29 actions). **Windows only** |
| Claude in Chrome Browser Tools | ✅ Dual-track | `TabsContext`, `ReadPage`, `Navigate`, `FormInput`, `BrowserClick`, `BrowserBatch` + `BrowserScreenshot` (silent wake-up tab visual inspection) |
| Non-blocking Background Jobs | ✅ `TaskCreate` … | Asynchronous background shell jobs (disk scans, junk cleanup, long builds) with persistent output logging |

A full feature-by-feature comparison — including browser control, plugins,
memory sync, teach mode and everything else Cowork gates behind a flag — is in
[COWORK-PARITY.md](COWORK-PARITY.md).

## Install

Requires **Node 20+** on your computer.

### Windows (One-Click)
1. Place `cowork-mcp` in your desired directory (e.g. `D:\chat2work\cowork-mcp`).
2. Double-click **`install.bat`** (it automatically detects Node.js, configures Claude Desktop, and registers the server).
3. **Restart Claude Desktop** completely (exit from the system tray icon, then reopen).

To check your environment: double-click **`doctor.bat`**.  
To uninstall: double-click **`uninstall.bat`**.

### Command Line
```bash
npm install                     # only needed if node_modules is missing
npm run install-desktop        # writes the entry into claude_desktop_config.json
npm run doctor                 # verifies environment & tools
```

### Install options

```bash
node scripts/install.mjs --home "D:\Work\ClaudeFiles"   # where the workspace lives
node scripts/install.mjs --allow "D:\code"              # extra folder outside the home
node scripts/install.mjs --allow-all                    # no path guard at all
node scripts/install.mjs --brave-key BSA...             # better web search
node scripts/install.mjs --print                        # show, do not write
node scripts/install.mjs --remove                       # uninstall
```

Or edit `claude_desktop_config.json` yourself:

```json
{
  "mcpServers": {
    "cowork": {
      "command": "node",
      "args": ["D:\\chat2work\\cowork-mcp\\src\\index.mjs"],
      "env": {
        "COWORK_HOME": "C:\\Users\\you\\Claude"
      }
    }
  }
}
```

The config file lives at (Windows):

- `%APPDATA%\Claude\claude_desktop_config.json`

## The workspace

By default the server adopts Claude Desktop's own `coworkUserFilesPath` if it is set,
otherwise `~/Claude`:

```
~/Claude/
  Projects/<space>/   spaces — one folder per piece of ongoing work, each with CONTEXT.md
  Artifacts/          finished files for you
  Skills/<name>/      your own skills (SKILL.md), shadowing the built-ins by name
  Memory/             notes that outlive a conversation, plus MEMORY.md as the index
  Uploads/            drop files here for Claude
  .cowork/            state: todos, task records and logs
```

The **active space** is the base directory for every relative path. `Space(action:"use")`
switches it; the choice persists across restarts.

## Using it

**Just ask.** On a Free or paid account alike, when you tell Claude to change something
on your computer — "edit this file", "rename these", "clean up that folder", "write the
result to my desktop" — Claude should use this connector first. You do not have to name
it or invoke a prompt.

Five prompts are registered — in Claude Desktop they appear under the ➕ / attachment
menu as `cowork`, `new-space`, `make-document`, `research`, `resume`. `cowork` is the
one to start with: it orients Claude in the workspace before it touches anything.

Typical openings:

> Use the cowork prompt, then set up a space for the Q4 board deck.

> Read every CSV in Uploads, work out which regions are declining, and give me an
> xlsx with the numbers and a chart.

> Research how MCP handles authorization and write it up as a PDF.

## Safety

There is no sandbox — that is the point, and it is worth being clear-eyed about.
Three things stand between Claude and your filesystem:

1. **Claude Desktop's own approval prompt** on every tool call. This is the real control.
2. **The path guard.** File tools refuse paths outside the workspace root. Widen it with
   `COWORK_ALLOWED_DIRS`, or switch it off with `COWORK_ALLOW_ALL=1`. It deliberately
   does **not** apply to `Bash`, because a shell command is unrestricted by nature.
3. **Read-before-edit.** `Edit`, `Write` over an existing file and `NotebookEdit` refuse
   to touch a file this session has not read, and refuse again if it changed underneath.
   Set `COWORK_STRICT_EDIT=0` to disable.

Point 1 is the one that matters. If you turn on "always allow" for `Bash`, you have
given a language model unattended shell access to your computer. That is a reasonable
thing to want and a bad thing to do by accident.

The same goes double for `Computer` and `ComputerBatch`: they drive your real mouse
and keyboard, so while they are running the pointer is not yours. Coordinates are
checked against the last screenshot and refused if they fall outside it, and clicking
before any screenshot is taken is refused outright — but there is no allowlist of
which applications may be touched. Watch the screen, or don't approve them.

## Configuration

All optional, all via the `env` block of the config entry.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COWORK_HOME` | Desktop's `coworkUserFilesPath`, else `~/Claude` | Workspace root |
| `COWORK_ALLOWED_DIRS` | — | Extra readable/writable roots, `;`/`:` separated |
| `COWORK_ALLOW_ALL` | `0` | Disable the path guard entirely |
| `COWORK_STRICT_EDIT` | `1` | Require a read before an edit |
| `COWORK_SHELL` | `powershell` on Windows, `bash` elsewhere | Default `Bash` interpreter |
| `COWORK_PYTHON` | `python` / `python3` | Interpreter for `REPL` |
| `COWORK_CU_MAX_DIM` | `1568` | Longest screenshot edge before downscaling |
| `COWORK_CU_QUALITY` | `75` | Screenshot JPEG quality |
| `COWORK_CU_SETTLE` | `350` | Milliseconds to let the UI repaint before the post-action screenshot |
| `COWORK_MAX_OUTPUT` | `60000` | Character cap per tool result |
| `COWORK_BASH_TIMEOUT` | `120000` | Default command timeout (ms) |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` | — | Better `WebSearch` backend |
| `COWORK_DEBUG` | `0` | Log to stderr (visible in Claude Desktop's MCP logs) |

## Skills

Built-in skills live in `skills/`. Yours go in `<home>/Skills/<name>/SKILL.md` and
shadow a built-in with the same name. The format is a Markdown file with YAML front
matter:

```markdown
---
name: invoice
description: Produce an invoice in our house format. Use when the user asks for one.
---

# Invoices
…instructions…
```

`SkillSave` writes one for you. Supporting scripts and templates go alongside the
`SKILL.md`; `Skill` lists them so Claude knows to read them.

## Development

```bash
node tests/smoke.mjs     # 100+ assertions, end to end over a real stdio transport
node scripts/doctor.mjs  # environment check
COWORK_DEBUG=1 node src/index.mjs   # run by hand; speaks MCP on stdio
```

Layout:

```
src/index.mjs        server bootstrap, resources, prompts
src/config.mjs       paths, limits, env
src/session.mjs      active space, todo location
src/guide.mjs        the operating instructions and canned prompts
src/lib/             paths, walk/glob, html→markdown, store
src/tools/           one module per tool group
skills/              built-in skills
## Acknowledgments

Special thanks to the [LINUX DO Community](https://linux.do) (https://linux.do) for inspiring discussions and open-source spirit!

## Licence

MIT.
