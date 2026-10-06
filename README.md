# 🛠️ chat2work

> **让任意 Windows 用户在 Claude Desktop 上免费享受完整的 Cowork 与 Claude in Chrome 生产力工作流 — 零付费门槛、100% 本机原生。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](https://microsoft.com)
[![Node.js: >=20](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org)
[![Community: LINUX DO](https://img.shields.io/badge/Community-LINUX%20DO-ff6b4a.svg)](https://linux.do)

**chat2work** 是专为 **Windows 平台**下的 **Claude Desktop** 量身打造的一体化本地工作站集成。因涉及底层 Windows Cowork 虚拟机桥接、命名管道通信、Native Host 注册表自愈与本地宿主机键鼠自动化，**本项目仅限 Windows 平台使用（Windows 10 / 11 x64），不兼容 macOS 与 Linux**。它打破了官方对付费订阅（Pro / Team / Enterprise）的强门槛，让 **Claude 免费账号（Free Plan）** 也能直接在 Windows 宿主机上获得官方级 **Claude Cowork** 与 **Claude in Chrome** 的全部生产力能力（48 个核心工具）。

---

## 🌟 核心特性

### 1. 📂 100% 宿主机原生 Cowork 运行面（48 个工具对齐）
- **完整文件系统能力**：支持大文件分片读写、精确多处字符串替换、正则搜索与匹配（`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`）。
- **持久化 Shell 与 REPL**：直接调用系统 PowerShell / cmd / bash，支持前台与后台异步执行（`Bash`, `BashOutput`, `KillShell`, `ListShells`）；提供会话级持久化的 Python 与 Node.js 代码执行环境（`REPL`, `JavaScript`）。
- **Office 文档与自动化技能**：完全对齐 Claude Desktop 官方捆绑技能包，支持开箱即用的文档生成与解析：
  - 📄 `docx` (Word 文档生成与样式排版)
  - 📊 `xlsx` (Excel 表格计算与复杂报表)
  - 📑 `pptx` (PowerPoint 幻灯片制作)
  - 📜 `pdf` / `pdf-reading` (PDF 渲染提取与填写)
  - 🎨 `frontend-design` (前端原型组件设计)
  - 社区增强技能：`research`、`data-analysis`、`html-report`
- **项目持久化空间与记忆**：独立工作空间文件夹、持久化 `CONTEXT.md`、多任务 Todo 追踪与事实记忆库（`Space`, `TodoWrite`, `TodoRead`, `Memory`）。
- **非阻塞后台长任务**：内置异步任务执行器（`TaskCreate`, `TaskList`, `TaskGet`, `TaskOutput`, `TaskStop`, `TaskCleanup`），处理大型扫描、文件解包或批处理时无需冻结对话。
- **🖥️ 宿主机键鼠与桌面自动化 (Computer Use)**：
  - 支持 Anthropic 官方级键鼠与桌面控制（`Computer`, `ComputerBatch`），包含屏幕截图、局部缩放（Zoom）、键鼠点击与拖拽、组合键、剪贴板读写、窗口与应用管理。
  - **⚠️ Windows 高分屏 (DPI 缩放) 比例偏差与实测说明**：
    - 在 2K 分辨率（`2560×1440`）且开启 Windows **150% DPI 缩放** 的环境下，截屏降采样至 `1568×882`（长边限制，换算系数 `1.6327`）。因底层输入注入受系统 DPI 系数影响（`1.5`），实际点击落点会出现约 **0.92** 比例的左上方偏移（`1.5 ÷ 1.6327 ≈ 0.9187`）。越往屏幕右下方偏离像素越多。
    - **实测表现**：点击搜索结果第一项可能误触上一首/迷你播放器；点击关闭按钮误触最小化按钮；侧栏点击偏向上方条目。
    - **避坑提示**：`cursor_position` 回读的是理论转换坐标，**无法检测出该输入偏移**，切勿使用 `cursor_position` 来验证点击是否命中目标！
    - **补偿方案**：操作后通过新截图视觉确认；若偏左上，可向 Claude 提示将目标坐标除以 0.92（乘以 `1.087`）或点击按钮右下区域；亦可调用 `zoom` 放大局部区域后再操作。

### 2. 🌐 浏览器双轨自动化与视觉巡检
- **双轨自动化流水线**：
  - **语义轨（Semantic / A11y Tree）**：极速、低 Token 消耗的 DOM 树导航、表单自动填写与智能点击（`ReadPage`, `FormInput`, `BrowserClick`, `BrowserBatch`）。
  - **视觉轨（Visual Inspection）**：高分辨率视口截屏与整页长图（`BrowserScreenshot` / `PageScreenshot`）。
- **静默后台唤醒机制**：Chrome 窗口或标签页处于最小化、后台遮挡状态时，依旧能按需渲染无感唤醒，并将清晰画面以 Base64 流实时送入 Claude Desktop。

### 3. 🧩 Claude in Chrome for Gateway（浏览器插件网关版）
- **独立分仓开源**：浏览器插件现已独立打包发布为 [`Claude in Chrome for Gateway`](../claude-in-chrome-for-gateway)，仅含纯净发行文件。
- **摆脱官方 OAuth 登录限制**：直接连接任意兼容 Anthropic Messages API 的网关（One-API、New-API、自建反代等）。
- **原生融合设置与历史会话**：网关配置无缝嵌入 Claude in Chrome 原生 Options 选项页；内置对话历史记录与 Markdown/JSON 导出。
- **Opus 5.5 推理努力程度**：全量支持 low/medium/high/xhigh/max 预设与自定义输入。
- **全局网站免确认授权**：原生权限页支持一键允许所有网站操作，免去频繁弹窗确认。
- **全量简体中文与遥测脱敏**：内置 900+ 词条 zh-CN 字典自动激活；源码级屏蔽所有官方遥测。

---

## 📐 系统架构

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          Claude Desktop                                │
│                     (免费账号 / 任意订阅)                              │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ stdio (MCP 协议)                │ 命名管道 (Named Pipe)
                   ▼                                 ▼
   ┌───────────────────────────────┐  ┌───────────────────────────────────┐
   │          cowork-mcp           │  │      chrome-native-host.exe       │
   │      (本地原生 MCP 服务)      │  │     (自愈注册表与本地通信代理)     │
   └───────┬───────────────┬───────┘  └──────────────────┬────────────────┘
           │               │                             │ Chrome Native Messaging
           ▼               ▼                             ▼
   ┌───────────────┐ ┌───────────┐           ┌───────────────────────┐
   │ 宿主机操作系统 │ │ 可选 Micro│           │   browser-extension   │
   │ 文件系统、终端 │ │ VM(WSL2)  │           │   (Claude in Chrome   │
   │ Python / 办公 │ └───────────┘           │      网关集成版)       │
   └───────────────┘                         └───────────┬───────────┘
                                                         │
                                                         ▼
                                             ┌───────────────────────┐
                                             │  浏览器标签页自动化   │
                                             │ (DOM 语义树 + 视觉截屏)│
                                             └───────────────────────┘
```

---

## 📁 目录结构

```text
chat2work/
├── browser-extension/          # Claude in Chrome 网关集成版
│   ├── claude-gateway/         # 已打好全部补丁的 Chrome 扩展目录（加载此目录）
│   ├── tools/                  # 扩展补丁脚本、网关源码与单测
│   └── README.md               # 浏览器扩展独立使用说明
│
├── cowork-mcp/                 # 宿主机本地 Cowork MCP 服务端
│   ├── bin/                    # 本地通信辅助程序 (chrome-native-host.exe)
│   ├── src/                    # MCP 服务端核心实现与 48 个工具处理器
│   │   ├── tools/              # 文件、终端、键鼠、浏览器、技能、任务模块
│   │   └── lib/                # Native Messaging 通信、VM 挂载、路径防护
│   ├── skills/                 # 官方捆绑办公文档技能 (Word/Excel/PPT/PDF)
│   ├── scripts/                # 自动化安装、环境诊断与注册表工具
│   ├── tests/                  # 154 项自动化回归测试
│   ├── install.bat             # Windows 鼠标双击一键安装脚本
│   ├── doctor.bat              # 环境诊断与连通性检测脚本
│   ├── uninstall.bat           # 一键卸载脚本
│   ├── package.json
│   └── README.md               # MCP 服务端详细文档
│
├── .gitignore
├── LICENSE                     # MIT 开源协议
└── README.md                   # 项目总览说明文档（本文档）
```

---

## 🚀 极速安装与上手指南

### 准备环境
- **操作系统**：Windows 10 / 11 (x64)
- **Node.js**：v20 或更高版本（[前往 Node.js 官网下载](https://nodejs.org/)）
- **Google Chrome** 或 Chromium 架构浏览器（Edge / Brave）
- **Claude Desktop** 客户端（免费账号登录即可）

---

### 第一步：加载浏览器插件（Claude in Chrome 网关版）

1. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions` 并回车。
2. 在右上角打开 **「开发者模式」** 开关。
3. 点击左上角的 **「加载已解压的扩展程序」** 按钮。
4. 在弹出的文件选择器中，选择独立扩展目录或本工程目录：
   ```text
   D:\claude-in-chrome-for-gateway
   (或 D:\chat2work\browser-extension\claude-gateway)
   ```
5. 扩展加载完成后，点击浏览器右上角的扩展图标打开 Claude 侧边栏。
6. 点击侧边栏右上角的 **「⚙ 网关设置」**（或在原生菜单中点击 Settings），在打开的配置面板中填写：
   - **网关地址（Base URL）**：兼容 Anthropic Messages API 的中转地址（例如 `https://api.your-gateway.com` 或 `http://127.0.0.1:8080`）
   - **API Key**：您的网关密钥
   - **自定义模型**：在「自定义模型」选项卡中添加您希望使用的模型 ID
7. 点击 **「保存并登录」**，侧边栏即可自动建立连接！

---

### 第二步：一键配置 Cowork MCP 服务端

#### 方式 A：鼠标双击一键安装（推荐）
直接双击运行 `cowork-mcp` 目录下的 **`install.bat`**：
```cmd
D:\chat2work\cowork-mcp\install.bat
```
安装脚本会自动：
1. 校验当前机器的 Node.js 运行环境与版本。
2. 自动安装 npm 依赖包。
3. 自动将 MCP 服务端注册至 `%APPDATA%\Claude\claude_desktop_config.json`。
4. 自动为系统内已安装的 Chrome / Edge 注册 Native Messaging Host 注册表通道。

#### 方式 B：完整手动安装与配置流程（高自定义度）

如果您希望完全手动掌控安装过程，请按以下步骤操作：

##### 1. 安装 Node.js 依赖
打开终端（PowerShell 或 CMD），进入 `cowork-mcp` 目录并安装依赖包：
```bash
cd D:\chat2work\cowork-mcp
npm install
```

##### 2. 定位 Claude Desktop 配置文件（Windows 专享）
在 Windows 运行窗口或资源管理器中打开配置文件：
- **配置文件路径**：`%APPDATA%\Claude\claude_desktop_config.json`  
- **快捷打开方法**：按键盘快捷键 `Win + R`，输入 `%APPDATA%\Claude` 并回车即可打开配置目录（若 `claude_desktop_config.json` 尚不存在，可直接新建一个空白文本文件并重命名）。

##### 3. 手动编辑添加 MCP 服务端
使用任意文本编辑器打开 `claude_desktop_config.json`，在 `mcpServers` 节点中加入 `cowork` 配置项：

```json
{
  "mcpServers": {
    "cowork": {
      "command": "node",
      "args": ["D:\\chat2work\\cowork-mcp\\src\\index.mjs"],
      "env": {
        "COWORK_HOME": "C:\\Users\\YourUsername\\Claude",
        "COWORK_ALLOW_ALL": "0"
      }
    }
  }
}
```

> **📌 配置项说明**：
> - `args`：填写您本地 `cowork-mcp\src\index.mjs` 的**绝对路径**（Windows 路径中的反斜杠需双写转义 `\\`）。
> - `COWORK_HOME`（可选）：指定 Claude 工作区根目录，存放 Projects、Artifacts、Skills、Memory 等。留空默认使用 `~/Claude`。
> - `COWORK_ALLOW_ALL`（可选）：默认为 `"0"`（受安全沙盒 Path Guard 保护，防止访问工作区外文件）；设为 `"1"` 可允许访问宿主机所有磁盘目录。
> - `BRAVE_API_KEY`（可选）：若配置了 Brave Search API Key，可增强 Claude 的实时联网搜索能力。

##### 4. 注册 Chrome 浏览器本地通信通道（Native Messaging Host）
若需要与 Chrome 浏览器插件（Claude in Chrome）进行本地双轨自动化联动，请在 `cowork-mcp` 目录下运行一次通道注册命令：
```bash
node scripts/install.mjs
```
*该脚本会自动向当前用户的注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts` 写入官方兼容通道配置，无需管理员权限。*

##### 5. 验证安装与环境自检
运行内置的诊断脚本，确认一切依赖与注册表均已正确就绪：
```bash
node scripts/doctor.mjs
```
*(看到所有检查项显示 `[OK]` 即表示手动安装完全成功)*

---

### 第三步：重启 Claude Desktop 并体验

1. **彻底退出 Claude Desktop**：在 Windows 任务栏右下角系统托盘中，右键点击 Claude 图标，选择 **Quit / 退出**。
2. 重新启动 Claude Desktop。
3. 在任意对话框中，点击输入框右侧的 **锤子图标（MCP Tools）** — 您将看到完整的 **48 个 Cowork 工具** 已经全部激活就绪！

---

## 🩺 环境诊断与自动化验证

- **一键诊断**：双击运行 `cowork-mcp\doctor.bat`，即可一键排查 Node 环境、Native Messaging 注册表状态及依赖健康度。
- **回归测试套件**：运行内置的 154 项全量自动化测试：
  ```cmd
  cd D:\chat2work\cowork-mcp
  node tests/smoke.mjs
  ```
  *(涵盖文件原子操作、持久化 Shell、Notebook、REPL、Office 文档构建、Native Messaging 通信等 154 项全面测试)*

---

## 🛡️ 安全与隐私说明

- **操作显式授权（Approval Guard）**：所有对本地文件系统的修改、删除、命令执行均遵循 Claude Desktop 原生安全策略，必须经您在界面上确认允许后才触发。
- **沙盒路径限制（Path Guard）**：默认将文件读写与工作区限定在 `COWORK_HOME` 目录下，并严格防御任何路径穿越（`../`）攻击。
- **零遥测与隐私保护**：彻底剥离官方原版扩展内的所有三方分析、错误上报及埋点探针，保护本地数据资产。
- **纯本地直连**：文件交互、命令执行和本地脚本完全在您的本机操作系统上直跑，绝不经由任何第三方中继服务器。

---

## 🙏 致谢与交流 (Acknowledgments)

本项目在逆向工程、协议解密及架构打通的过程中，离不开以下社区与项目的启发与支持：

- **特别鸣谢 [LINUX DO 社区](https://linux.do)**（[https://linux.do](https://linux.do)）：感谢社区朋友们的无私分享、深度讨论以及对探索生产力边界的纯粹热情。
- 感谢 **Anthropic** 打造的卓越交互范式以及 Model Context Protocol (MCP) 开放标准。
- 感谢广大开源爱好者对 AI 本地化、开放化生态所做出的持续探索。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议完全开源。

> **免责声明**：*chat2work 为独立的开源研究与效率提升工具，旨在探索本地工具互操作性与开发者生产力，非 Anthropic PBC 官方产品，亦未受其资助或背书。使用时请遵循相关服务条款与当地法律法规。*
