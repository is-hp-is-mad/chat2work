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
1. Place `cowork-mcp` in your desired directory (e.g. `C:\path\to\cowork-mcp`).
2. Double-click **`install.bat`** (it automatically detects Node.js, configures Claude Desktop, and registers the server using current actual path).
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
node scripts/install.mjs --home "C:\Users\<user>\ClaudeFiles" # where the workspace lives
node scripts/install.mjs --allow "C:\code"                    # extra folder outside the home
node scripts/install.mjs --allow-all                          # no path guard at all
node scripts/install.mjs --brave-key BSA...                   # better web search
node scripts/install.mjs --print                              # show, do not write
node scripts/install.mjs --remove                             # uninstall
```

Or edit `claude_desktop_config.json` yourself:

```json
{
  "mcpServers": {
    "cowork": {
      "command": "node",
      "args": ["<path-to-your-project>\\cowork-mcp\\src\\index.mjs"],
      "env": {
        "COWORK_HOME": "C:\\Users\\<user>\\Claude"
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

### Windows DPI 缩放与 Computer Use 自动硬件级坐标补偿

在开启了高分屏缩放（如 2K 2560×1440 屏幕下开启 **150% DPI 缩放**）的 Windows 环境中，Claude 进行视觉点击时：

- **偏差机理**：
  - 屏幕物理分辨率为 `2560 × 1440`，截屏按长边上限降采样至 `1568 × 882`（系数 `1.6327`）。
  - Windows 原生输入注入（`SetCursorPos` / `SendInput`）在未适配时默认继承系统 DPI 缩放乘数（`1.5`），而未能应用截屏到物理像素的完整系数（`1.6327`）。
  - 两者比值为 `1.5 ÷ 1.6327 ≈ 0.9187`。未补偿时实际落点坐标 `≈ 给定坐标 × 0.92`，导致向左上方偏离。
- **内置底层自动补偿（开箱即用，无需 Claude 思考）**：
  - `cowork-mcp` 服务端现已在底层驱动层内置了**自动 DPI 比例补偿引擎**（可在配置中通过 `COWORK_CU_AUTO_DPI=0` 关闭）。
  - 截图时自动探测并回传系统实际 DPI 缩放比；当检测到降采样比率与系统 DPI 不一致时，在注入坐标换算时直接自动乘以补偿系数（`1.0885`，即 `1 / 0.9187`）。
  - **Claude 和用户无需心智负担**：Claude 看到的截图是哪个点，直接传入该点坐标即可，驱动层自动精准对准物理像素落点。
- **⚠️ 避坑提醒**：
  - `cursor_position` 回读的是系统理论坐标，不能体现 OS 内部输入虚拟化落点，不要将 `cursor_position` 作为物理点击是否准确的判定依据。

## 📦 官方 Cowork 虚拟机镜像提取与离线手动安装指南

虽然 `cowork-mcp` 默认在宿主机 100% 原生运行（无需虚拟机），但若你想体验或挂载官方 Ubuntu 22.04 容器镜像（`VMStatus`, `VMMount`, `VMRun`），我们提供了完整的提取与离线放置机制：

### 1. 一键提取/备份本机官方镜像（避免官方未来下架）
只需运行我们编写的提取工具：
```bash
npm run backup-vm
# 或者：node scripts/backup-vm.mjs --dest D:\your_backup_dir
```
该命令会自动检测 Claude Desktop 官方缓存的 `rootfs.vhdx` (约 8.5GB) 与 `chrome-native-host.exe`，并完整备份至指定目录，且带有实时进度条。

### 2. 离线/手动安装路径（镜像与 EXE 放置位置）
如果今后从网盘、移动硬盘或其它机器获取了 `rootfs.vhdx` 和 `chrome-native-host.exe`，服务端的**自动探测优先级**如下，放到以下任意位置均可被永久识别：

| 依赖文件 | 推荐放置路径（优先级从高到低） | 说明 |
| :--- | :--- | :--- |
| **`rootfs.vhdx`**<br>(8.5GB 虚拟机镜像) | 1. 环境变量：`COWORK_VM_ROOTFS=D:\any_path\rootfs.vhdx`<br>2. 官方标准路径：`%APPDATA%\Claude\vm_bundles\claudevm.bundle\rootfs.vhdx`<br>3. 工程便携路径：`cowork-mcp\vm\rootfs.vhdx` (或 `vm\claudevm.bundle\rootfs.vhdx`)<br>4. 本地备份路径：`D:\Claude_Local_Backup\claudevm.bundle\rootfs.vhdx` | 放置后通过 `VMStatus` 工具或 `doctor.bat` 即可实时查看就绪状态 |
| **`chrome-native-host.exe`**<br>(浏览器本地消息代理) | 1. 工程打包目录：`cowork-mcp\bin\chrome-native-host.exe` (已内置)<br>2. 系统注册目录：`%APPDATA%\Claude\ChromeNativeHost\chrome-native-host.exe`<br>3. 官方安装目录：`%LOCALAPPDATA%\Programs\Claude\resources\chrome-native-host.exe` | 只要运行 `node scripts/install.mjs`，便会自动将其注册并自愈至注册表 |

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
