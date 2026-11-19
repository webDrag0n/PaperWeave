<div align="center">

<img src="README.assets/logo.png" alt="PaperWeave Logo" width="128">

# PaperWeave

**轻量、跨平台的桌面论文阅读器：阅读、批注、评星，并把论文库织成一张可探索的 3D 引用网络。**

[English](README.en.md) | 中文

[![版本](https://img.shields.io/github/v/release/webDrag0n/PaperWeave?label=%E7%89%88%E6%9C%AC&color=4aa3ff)](https://github.com/webDrag0n/PaperWeave/releases/latest)
[![CI](https://github.com/webDrag0n/PaperWeave/actions/workflows/ci.yml/badge.svg)](https://github.com/webDrag0n/PaperWeave/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![平台](https://img.shields.io/badge/平台-Windows%20%7C%20macOS%20%7C%20Linux-b678ff)](#-下载)
[![Electron](https://img.shields.io/badge/Electron-33-5b6270)](package.json)

![3D 引用关系图](README.assets/graph.png)

[下载](#-下载) · [快速开始](#-快速开始) · [功能亮点](#-功能亮点) · [Agent 集成](#-agent-集成) · [开发文档](#-开发)

</div>

---

## 📖 目录

- [简介](#-简介)
- [功能亮点](#-功能亮点)
- [下载](#-下载)
- [快速开始](#-快速开始)
- [典型工作流](#-典型工作流)
- [Agent 集成](#-agent-集成)
- [数据与隐私](#-数据与隐私)
- [常见问题](#-常见问题)
- [开发](#-开发)
- [路线图](#-路线图)
- [贡献](#-贡献)
- [许可证](#-许可证)

## 💡 简介

PaperWeave 是为「读论文 + 理脉络」而生的桌面工具：它不只是一个 PDF 阅读器——导入论文后会自动解析引用关系，把论文库织成一张可交互的 3D 引用网络；遇到未收录进库的参考文献，可以一键下载入库并自动挂到网络里。

同一套源码编译 Windows / macOS / Linux 三平台产物；纯 ES Module 前端无构建步骤，Agent 可通过本地 HTTP API 或 MCP Server 全权接管论文库。

## ✨ 功能亮点

### 📄 阅读、批注与笔记

- **顺畅阅读**：长文档懒加载、鼠标中心平滑缩放、适应宽度、精确目录跳转、阅读位置记忆；右侧面板可收起，支持护眼、浅色 / 深色主题和中英双语界面
- **高亮与下划线并存**：5 色高亮保留原底色，文字批注额外增加彩色下划线；重合下划线自动错位，加宽间距的页边引线连接 Markdown 批注卡片，同色批注也清晰可辨
- **Markdown 批注与便利贴**：批注支持编辑 / 预览，页边和列表同步渲染；任意位置可放便利贴，论文另有自动保存的 Markdown 笔记
- **文内搜索**：选中文字一键搜索，`Ctrl+F` 检索整篇 PDF 并跳转到命中位置
- **可还原批注包**：导出 `.pwpackage`（原始 PDF + 元数据 + 全部批注），再次导入即可还原，并按批注 ID 与现有数据合并
- **正文引用悬浮**：悬停 `[1]` 或作者—年份引用即可查看参考文献，库内论文可直接打开，未入库条目可下载

![高亮底色、下划线与 Markdown 批注](README.assets/02-reader.png)
![正文引用悬浮卡片](README.assets/03-citation-popup.png)

### ⭐ 论文库与检索排序

- **多论文库**：卡片式管理名称、简介、图标、星标与拖拽顺序；「全部已下载」跨库汇总论文和引用关联
- **统一导入与去重**：支持本地 PDF、拖放、URL / arXiv 和浏览器插件；内容 hash 自动复用，DOI 或高相似标题冲突由用户确认
- **自动元数据**：提取标题、作者、DOI、摘要和参考文献；发表年份优先使用 arXiv 编号与明确出版标记
- **分区 + 区内排序**：按星级、添加年份、发表年份、标题首字母、作者首字母或引用关联数分区；搜索结果也保留分区
- **论文管理**：搜索、标签、收藏、批量选择、1–5 星评星和标题行内 Markdown
- **可配置本地存储**：分别设置 PDF 与数据目录，复制时保留原文件；启动时并行加载数据，批注统计在后台补齐，不阻塞首批卡片

![论文库与星级分区](README.assets/01-library.png)
![浅色主题论文库](README.assets/06-light-theme.png)

### 🌐 引用图谱与时间线

- **3D 引用网络**：力导向布局、节点辉光和跳数配色；相机适配节点与标签边界，旋转始终围绕全部节点质心
- **多选与路径高亮**：网络视图显示最短关联，时间线视图显示选中论文之间的全部引用路径
- **对齐的时间刻度**：论文按发表年份排布，平移时年份标尺保持对齐；支持整体、横向和纵向缩放
- **全节点搜索**：顶栏搜索高亮全部匹配节点并弱化其余节点，不再只定位第一个结果
- **筛选与发展史**：组合星级和多位作者筛选，递归查看单篇论文的完整上下游脉络
- **可检索的引用面板**：阅读器和图谱详情的引用、被引列表均可独立搜索，并按时间、作者首字母或标题首字母排序

![时间线与引用面板](README.assets/04-graph-timeline.png)

### 🔗 引用引擎与库外发现

- **自动解析引用**：优先 Semantic Scholar 结构化数据，失败时回退 PDF 参考文献解析；支持编号、无编号、机构作者和跨行断词，被引抓取可回退 OpenAlex
- **未入库闭环**：未入库条目可单篇或批量下载，自动建边并进入图谱；下载失败显示原因并可重试，离线匹配和手动关联可兜底
- **相似论文**：根据共同参考文献与共同引用者计算相似度，在详情栏展示 Top 5 及重叠度
- **库外发现**：汇总全库引用重叠，找出「经典先驱」和「衍生新作」，一键下载补库

![库外发现](README.assets/08-discover.png)

### 🧩 浏览器插件

PaperWeave Connector（Chrome / Edge）在 arXiv、PDF 页面与带 `citation_*` 元数据的出版商页面上一键把论文保存到桌面端，可选择目标论文库，也支持右键保存。插件自动发现并连接本机正在运行的 PaperWeave。安装与使用见 [`extension/README.md`](extension/README.md)。

## 📦 下载

预构建版本发布在 [GitHub Releases](https://github.com/webDrag0n/PaperWeave/releases/latest)：

| 文件 | 说明 |
| --- | --- |
| `PaperWeave-<版本>-win-x64-setup.exe` | Windows 安装程序（可选安装目录） |
| `PaperWeave-<版本>-win-x64-portable.exe` | Windows 便携版，免安装直接运行 |
| `PaperWeave-Connector-<版本>.zip` | Chrome / Edge 浏览器插件 |

- Windows 安装包没有代码签名，首次运行时 SmartScreen 会提示，选择「更多信息 → 仍要运行」。
- macOS 与 Linux 暂不提供预构建包，请[从源码构建](#-开发)。
- 各版本的变化见 [CHANGELOG.md](CHANGELOG.md) 与 [`docs/releases/`](docs/releases/)。

## 🚀 快速开始

### 使用预构建版本

1. 下载并运行安装包或便携版
2. 把 PDF 拖进窗口，或点「📥 导入」粘贴 arXiv 链接
3. 打开论文阅读，点「🌐」进入引用关系图

### 从源码运行

需要 Node.js 18 或更高版本。

```bash
git clone https://github.com/webDrag0n/PaperWeave.git && cd PaperWeave
npm install          # 安装依赖（Electron、pdf.js、three.js）
npm start            # 启动桌面应用
npm run dev          # 浏览器预览模式（http://localhost:7100/，示例数据自动载入）
```

## 🧭 典型工作流

1. **建库**：拖入一批 PDF（或粘贴 arXiv 链接），元数据与引用关系自动就位
2. **精读**：目录侧边栏跳段落 → 高亮核心句 → 便利贴记录疑问 → Markdown 笔记总结
3. **理脉络**：卡片「关系」进入图谱 → 滑条看 2 跳引用圈 → 时间线 Shift 多选几篇核心论文看全部引用路径 → 未入库的高被引参考文献一键下载补库
4. **分级**：读完点星，论文库按星级自动分区，图谱按星级过滤只看核心网络

## 🤖 Agent 集成

PaperWeave 提供两种 Agent 接入方式，完整契约与版本历史见 [`agents/AGENTS.md`](agents/AGENTS.md)：

- **本地 HTTP Agent API**（`127.0.0.1:24680`，`X-PaperWeave-Token` 令牌鉴权）：论文库管理、PDF 逐页正文与原文定位、批注、笔记、引用抓取与下载、跨库图谱与进度查询
- **MCP stdio Server**（`mcp/paperweave-mcp.js`，零依赖单文件）：Claude Desktop / Cursor / Kimi 等宿主配置 `node paperweave-mcp.js` 即可接入；提供正文阅读、原始 PDF 资源、检索、高亮和库管理工具，附有科研助理使用指引与精读、综述、洞察、兴趣高亮等工作流模板

```jsonc
// MCP 宿主配置示例
{
  "mcpServers": {
    "paperweave": { "command": "node", "args": ["<paperweave-mcp.js 的绝对路径>"] }
  }
}
```

连接信息（端口 + 令牌）在启动后写入 `paperweave-data/agent-api.json`；便携版同时写入 exe 同目录，并自动复制 `AGENTS.md` 与 `paperweave-mcp.js`。

> 仓库里有两份 `AGENTS.md`：[`agents/AGENTS.md`](agents/AGENTS.md) 写给**使用** PaperWeave 的 Agent，随安装包分发；根目录的 [`AGENTS.md`](AGENTS.md) 写给**修改本仓库代码**的 Agent。

## 🗂 数据与隐私

- **完全本地优先**：论文库、批注、笔记、评星全部存储在本机，无任何遥测与云端上传
- 桌面版数据位于用户数据目录 `paperweave/paperweave-data/`：
  - `data.json` 应用级配置与论文库列表；`papers.json` 全局论文注册表；`annotations.json` 批注
  - `libraries/<id>.json` 每个论文库的论文清单与引用关联；`library/` 全局共享 PDF 文件库（内容 hash 命名）
  - Windows 示例：`C:\Users\<你>\AppData\Roaming\paperweave\paperweave-data\`
  - macOS：`~/Library/Application Support/paperweave/paperweave-data/`
  - Linux：`~/.config/paperweave/paperweave-data/`
- 浏览器预览版使用 localStorage + IndexedDB
- 引用抓取仅访问公开学术 API（Semantic Scholar / OpenAlex / CrossRef / arXiv）
- Agent API 只监听本机回环地址。安全模型、已知限制与漏洞报告方式见 [SECURITY.md](SECURITY.md)

## ❓ 常见问题

**抓取引用时被限流 / 失败？**
Semantic Scholar 未认证配额为共享池（约 1 req/s），高峰期可能 429。应用已内置节流与指数退避，并自动回退 OpenAlex；如需稳定高配额，设置环境变量 `PAPERWEAVE_S2_API_KEY=<你的 S2 API Key>` 后启动（免费申请见 Semantic Scholar 官网）。

**不希望导入后自动解析引用？**
设置 `PAPERWEAVE_AUTOFETCH=0` 后启动即可关闭，仍可在「引用」页签手动抓取。

**引用下载失败？**
下载走 arXiv 直链与 OpenAlex 开放获取（OA）位置；无 OA 来源的付费论文会集中在「引用」页顶部显示失败原因，可逐条重试，也可手动下载后导入，再点「已在库中 · 关联」补建引用边。

**macOS / Linux 安装包？**
macOS 在 macOS 上执行 `./tools/build-mac.sh`（或 `npm run dist:mac`）；Linux 的 AppImage / deb 在 Linux 上执行 `npm run dist:linux`。没有 Apple 开发者证书时产物为 ad-hoc 签名，本机可直接运行，其他 Mac 需在「系统设置 → 隐私与安全性」中放行。

## 🛠 开发

前端是纯 ES Module，没有构建步骤；主进程是 CommonJS；运行时依赖只有 pdf.js 与 three.js。

```bash
npm start            # 桌面应用
npm run dev          # 浏览器预览
npm test             # 快速回归：纯 Node，不启动 Electron
npm run test:e2e     # 完整回归：启动 Electron，其中 selftest 会弹出窗口并占用焦点
npm run dist:win     # 构建 Windows 安装包与便携版（dist:mac / dist:linux 同理）
```

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 架构、模块职责、数据模型、核心流程、安全边界、设计决策与已知限制 |
| [docs/development.md](docs/development.md) | 环境准备、命令、代码约定、各类改动的检查清单 |
| [docs/testing.md](docs/testing.md) | 各测试套件的范围、运行条件与 CI |
| [docs/releasing.md](docs/releasing.md) | 版本号规则与发布步骤 |
| [agents/AGENTS.md](agents/AGENTS.md) | Agent HTTP API 与 MCP 契约 |
| [AGENTS.md](AGENTS.md) | 写给 coding agent 的仓库工作规则 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

完整索引见 [docs/README.md](docs/README.md)。

## 🗺 路线图

- [x] 引用网络时间线视图（按发表年份排布）
- [ ] macOS 签名与公证构建
- [ ] 高亮与笔记导出为 Markdown / BibTeX
- [ ] Zotero 库导入
- [ ] 跨库全文搜索
- [ ] S2 API Key 设置界面

## 🤝 贡献

欢迎 Issue 与 PR，中英文均可。流程、提交规范与合并前检查见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

提交代码前至少运行 `npm test`；改动涉及界面、IPC、Agent API 或存储时再运行 `npm run test:e2e`。接口、数据字段或行为语义有变化时，必须同步更新 `agents/AGENTS.md` 并递增 API 版本号。

## 📄 许可证

[MIT](LICENSE) © PaperWeave contributors
