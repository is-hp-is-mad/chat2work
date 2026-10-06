# Claude in Chrome for Gateway

> **Claude in Chrome 浏览器插件网关解绑与功能增强开源版**  
> 现已独立分仓开源至：`Claude in Chrome for Gateway`（目录位于 `d:\claude-in-chrome-for-gateway`）

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../LICENSE)
[![Community](https://img.shields.io/badge/Community-LINUX%20DO-orange.svg)](https://linux.do)

---

## 🌟 核心特性与改动

| 模块 | 功能说明 |
|---|---|
| ❌ **去除 Claude 官方登录** | 移除 claude.ai / Anthropic OAuth 强制登录与付费墙门禁，免绑官方账号 |
| 🌐 **自定义 API 网关连接** | 支持任意兼容 Anthropic Messages API（`POST /v1/messages`）的网关与反向代理（Base URL + API Key + `x-api-key`/`Bearer`） |
| 🎛️ **设置页面深度融合** | 网关配置原生集成在 Claude in Chrome 官方 Options 设置页的【网关设置】选项卡中，侧边栏亦支持抽屉面板一键直达 |
| 💬 **历史会话（Chat History）** | 自动记录侧边栏多轮对话；支持搜索、查看消息流、一键复制为 Markdown 文档、全量 JSON 导出与清理 |
| 🧠 **推理努力程度（Reasoning Effort）** | 紧跟 Claude 3.7 / Opus 5.5 规范，支持 `low`、`medium`、`high`、`xhigh`、`max` 预设，并支持手动填写任意自定义值 |
| 🔓 **全局网站免确认授权** | 原生权限管理中新增「直接允许所有网站」开关，跳过所有繁琐的网页操作授权弹窗 |
| 🇨🇳 **全量简体中文（zh-CN）** | 内置 900+ 键全量汉化语言包，中文环境下默认自适应激活 |
| 🛡️ **彻底删除官方遥测** | 源码级阻断 Sentry、Datadog RUM/Profiler、event_logging、GrowthBook、statsig 等一切遥测打点，剥离分布式追踪头 |
| 🛠️ **稳定性增强** | 修复 useMergedRefs 与 SlotClone 的 React #185 ref 抖动循环；注入崩溃错误边界与诊断日志 |

---

## 📦 安装与加载方法

### 独立开源仓库（推荐）
独立仓库目录位于 `d:\claude-in-chrome-for-gateway`，仅包含开箱即用的插件发行文件（已剥离所有构建工具与源码）。

1. 打开 Google Chrome 或基于 Chromium 的浏览器（Edge、Brave 等）。
2. 在地址栏输入 `chrome://extensions` 并回车。
3. 在右上角开启 **「开发者模式」** 开关。
4. 点击左上角的 **「加载已解压的扩展程序」**。
5. 选择独立仓库目录 `d:\claude-in-chrome-for-gateway`（或本工程下的 `claude-gateway` 目录）。
6. 安装完成后，点击扩展图标打开 Claude 侧边栏即可开始使用。

---

## ⚙️ 快速上手配置

1. 打开扩展侧边栏，点击右上角工具栏的 **「⚙ 网关设置」**（或右键扩展图标选择【选项】进入原生设置中的【网关设置】选项卡）。
2. 输入您的网关地址（Base URL，如 `https://api.your-gateway.com` 或本地反代 `http://127.0.0.1:8080`）与 API Key。
3. 在【自定义模型】中配置您所需的模型 ID，按需开启思考能力与配置推理努力程度。
4. 点击【保存并登录】，侧边栏即刻恢复正常使用。
5. 点击侧边栏工具栏的 **「时钟」** 图标，即可随时打开历史会话抽屉，检索、回溯或导出对话记录。

---

## 🛠️ 构建与维护（开发者）

本工程包含官方包解构与自动化补丁构建流水线：
- `original/`：Chrome Web Store 官方拉取解压包。
- `tools/patch.py`：自动生成补丁包的 Python 脚本。
- `tools/gateway-src/`：网关运行时垫片（`shim.js`）、配置控制台（`index.html`、`gateway.js`、`gateway.css`）与简体中文翻译字典（`zh-CN.json`）。
- `tools/test_shim.js`：涵盖 API 改写、遥测拦截、推理参数注入与登录态分区的单元测试套件。

执行重新构建与 ESM 强校验：
```bash
python tools/patch.py
node tools/test_shim.js
```

---

## 🙏 致谢

- 特别鸣谢 **[LINUX DO 社区](https://linux.do)**（`https://linux.do`）的开源分享与技术探索精神！
- 遵循 [MIT License](../LICENSE) 开源。
