# PaperWeave v1.0.0 — Weave Your Papers into a Living Citation Network

<div align="center">
<img src="../README.assets/logo.png" alt="PaperWeave" width="96">
</div>

**中文** | [English](#english)

## PaperWeave v1.0.0「织网成篇」

首个公开发布版本。PaperWeave 是一款**本地优先**的桌面论文阅读器：阅读、批注、评星，并把论文库**织**成一张可探索的 3D 引用网络——参考文献自动解析、未入库引用一键下载、相似论文自动发现，内置 MCP Server 让 AI agent 直接接管你的论文库。

### ✨ 功能总览

- **📄 阅读与批注**：PDF 秒开与懒加载、目录侧边栏精确定位到子段落、5 色高亮 + 文字批注 + 便利贴、每篇论文 Markdown 笔记、阅读位置记忆、护眼模式、明暗双主题
- **⭐ 论文库管理**：多论文库卡片面板（emoji 图标 / 简介 / 星标置顶 / 拖拽排序）、统一导入弹窗（链接 + 拖文件 + 选文件）、全局唯一存储 + 智能去重确认、1–5 星评星与分区排序
- **🌐 3D 引用网络**：力导向 3D 图谱、标签常显、节点辉光、**引用方向流光特效**（被引 → 引用方）、跳数高亮滑条（1–5 跳分色）、Shift 多选自动勾勒最短关联、按星级过滤
- **🔗 引用引擎**：导入即后台解析；参考文献优先走 Semantic Scholar，回退 PDF 参考文献段落解析（`[1]` / `1.` / `[Vaswani+17]` / 无编号），经 CrossRef / arXiv / S2 / OpenAlex 多级确认；被引抓取带限流退避；**未入库条目闭环**——单篇或一键全部下载入库并自动建边
- **🧭 相似与库外发现**：文献耦合 × 同被引计算相似度，详情栏给出 Top 5 相似论文；「发现」面板聚合全库重叠——🏛 经典先驱（被库内多篇共同引用）与 🌱 衍生新作（同时引用库内多篇），一键入库
- **🌐 中英双语**界面一键切换

### 🤖 Agent 原生

- 内置本地 HTTP Agent API（`127.0.0.1`，令牌鉴权）与零依赖 **MCP Server**（25 个工具）
- AI agent 可以：建库 / 导入 / 抓取引用 / 读写笔记批注 / 查图谱——论文库成为 agent 的一等工具
- 接入文档见 `agents/AGENTS.md`（随安装包分发）

### 📦 下载

| 文件 | 平台 | 说明 |
| --- | --- | --- |
| `PaperWeave-1.0.0-win-x64-setup.exe` | Windows | NSIS 安装程序（可选安装目录） |
| `PaperWeave-1.0.0-win-x64-portable.exe` | Windows | 便携版，免安装直接运行 |

macOS / Linux 请从源码构建（`README` 打包章节，一条命令）。

### 🔄 从 PaperGraph 升级

本版本由 PaperGraph 更名而来。首次启动会**自动迁移**旧数据目录（`papergraph-data` → `paperweave-data`），论文库、批注、笔记全部保留。

⚠️ 破坏性变更（仅影响 agent 集成）：API 版本升至 **v5**——鉴权头改为 `X-PaperWeave-Token`，MCP Server 更名 `paperweave-mcp.js`（工具前缀 `paperweave_`），环境变量改为 `PAPERWEAVE_S2_API_KEY`。

### 🧪 质量

三套自动化回归全绿：**158** 项端到端用户场景（真实 Electron 渲染 + 截图存档）+ **47** 项 Agent API + **49** 项 MCP 工具测试。

---

## English

## PaperWeave v1.0.0 "Weave Your Papers"

First public release. PaperWeave is a **local-first** desktop paper reader: read, annotate, rate — and **weave** your library into an explorable 3D citation network. References resolve automatically, missing papers download in one click, similar papers surface on their own, and a built-in MCP server lets AI agents work your library directly.

### ✨ Highlights

- **📄 Reading & annotation**: instant PDF open with lazy rendering, outline sidebar with sub-section precision, 5-color highlights + notes + sticky memos, per-paper Markdown notes, reading-position memory, eye-care mode, dark & light themes
- **⭐ Library management**: multi-library card panel (emoji icons / descriptions / pin-to-top / drag to reorder), unified import dialog (links + drag-drop + file picker), global single-copy storage with smart dedup confirmation, 1–5 star ratings
- **🌐 3D citation network**: force-directed 3D graph, always-on labels, node glow, **flow animation along citation direction** (cited → citing), hop-depth highlight slider (1–5 color-coded hops), Shift-multi-select with shortest-path outlining, star-rating filter
- **🔗 Citation engine**: background resolution on import; references prefer Semantic Scholar with PDF-section fallback (`[1]` / `1.` / `[Vaswani+17]` / unnumbered), confirmed via CrossRef / arXiv / S2 / OpenAlex; throttled citation fetching; **not-in-library loop** — download entries individually or in bulk, auto-linked on arrival
- **🧭 Similarity & discovery**: bibliographic coupling × co-citation similarity with Top-5 similar papers in the detail panel; the Discover panel aggregates library-wide overlap — 🏛 Prior works (co-cited by your library) and 🌱 Derivative works (citing multiple library papers), one click to import
- **🌐 Bilingual** Chinese / English UI

### 🤖 Agent-native

- Built-in local HTTP Agent API (token-secured, `127.0.0.1`) and a zero-dependency **MCP server** (25 tools)
- Agents can create libraries, import, fetch citations, read & write annotations, and query the graph — your library becomes a first-class agent tool
- Integration guide in `agents/AGENTS.md` (ships with the app)

### 📦 Downloads

| File | Platform | Notes |
| --- | --- | --- |
| `PaperWeave-1.0.0-win-x64-setup.exe` | Windows | NSIS installer (custom install dir) |
| `PaperWeave-1.0.0-win-x64-portable.exe` | Windows | Portable, no install needed |

macOS / Linux: build from source (one command, see README).

### 🔄 Upgrading from PaperGraph

This release renames PaperGraph to PaperWeave. On first launch, your data directory is **migrated automatically** (`papergraph-data` → `paperweave-data`) — libraries, annotations and notes are preserved.

⚠️ Breaking changes (agent integrations only): API version is now **v5** — the auth header is `X-PaperWeave-Token`, the MCP server is `paperweave-mcp.js` (tool prefix `paperweave_`), and the env var is `PAPERWEAVE_S2_API_KEY`.

### 🧪 Quality

All three regression suites green: **158** end-to-end user scenarios (real Electron rendering + screenshot archive) + **47** Agent API + **49** MCP tool tests.
