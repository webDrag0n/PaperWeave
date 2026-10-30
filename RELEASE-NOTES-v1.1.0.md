# PaperWeave v1.1.0 — 阅读更顺滑，网页论文一键入库

**中文** | [English](#english)

## 中文

PaperWeave v1.1.0 带来 Chrome / Edge 浏览器插件，并重点优化 PDF 阅读器的缩放、高亮对齐和双栏论文选区体验。

### ✨ 主要更新

- **🧩 PaperWeave Connector**：在 arXiv 摘要页、PDF 页面或支持 `citation_*` 元数据的出版商页面，一键提取论文元数据并下载入库；支持右键保存、连接测试和重复论文自动复用。
- **🖱 鼠标中心平滑缩放**：Ctrl＋滚轮或触控板捏合时按滚动幅度连续缩放，鼠标下方的内容保持稳定。
- **📄 缩放与高清重绘分离**：交互阶段同步变换画布、文字层和批注层，停顿后再高清重绘；过期渲染任务自动取消，减少抖动、白闪和画布并发冲突。
- **🖍 高亮位置更可靠**：批注使用页面归一化坐标，缩放和重绘后仍与文字对齐。
- **📚 双栏选区优化**：同一水平线上的左右栏独立高亮，不再填满栏间空白；同栏小碎片保持连续，多行高亮避免重叠。
- **🔌 Agent API v5**：新增 `POST /api/papers/import-web`，支持浏览器插件传入 PDF 地址和元数据提示；保留令牌鉴权并支持跨域预检。
- **🛠 构建与分发**：Windows 打包自动同步插件目录和 ZIP，提升文件占用与 ASAR 环境下的构建稳定性。

### 📦 下载

| 文件 | 平台 | 说明 |
| --- | --- | --- |
| `PaperWeave-1.1.0-win-x64-setup.exe` | Windows x64 | NSIS 安装程序，可选择安装目录 |
| `PaperWeave-1.1.0-win-x64-portable.exe` | Windows x64 | 便携版，免安装直接运行 |
| `PaperWeave-Connector-1.1.0.zip` | Chrome / Edge | 解压后通过扩展管理页“加载解压缩的扩展”安装 |

插件连接地址和访问令牌可在桌面端顶栏 **「🧩 插件」** 中复制。桌面端需保持运行，插件才能下载入库。

### 🔄 升级

直接从 v1.0.0 安装或运行本版本即可，原论文库、批注、笔记和阅读位置均保留。

### 🧪 质量

发布前自动化检查全部通过：**167** 项真实 Electron 用户场景、**47** 项 Agent API、**49** 项 MCP 工具测试，以及 **13** 项浏览器插件接口检查。

---

## English

## PaperWeave v1.1.0 — Smoother Reading, One-click Web Imports

### ✨ Highlights

- **PaperWeave Connector for Chrome / Edge**: save papers from arXiv, PDF pages, and publisher sites with `citation_*` metadata; includes context-menu saving, connection testing, and automatic duplicate reuse.
- **Cursor-centered smooth zoom**: continuous Ctrl＋wheel and trackpad pinch zoom keeps the content beneath the pointer stable.
- **Flicker-resistant rendering**: canvas, text, and annotation layers transform together during interaction, followed by deferred high-resolution rendering and stale-task cancellation.
- **Reliable highlights**: normalized page coordinates keep annotations aligned through zooming and re-rendering.
- **Two-column selection support**: separate columns remain separate, same-column fragments stay continuous, and adjacent-line highlights no longer overlap.
- **Agent API v5**: adds `POST /api/papers/import-web` for authenticated browser-assisted imports.

### 📦 Downloads

The release includes Windows x64 installer and portable builds, plus the Chrome / Edge Connector ZIP. Open **「🧩 Add-on」** in the desktop app to copy the local server URL and access token.

### 🧪 Quality

All release checks pass: **167** Electron end-to-end scenarios, **47** Agent API tests, **49** MCP tests, and **13** Connector API checks.
