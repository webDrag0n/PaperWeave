# 更新日志

本文件记录每个版本的重要变更，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

每个版本面向用户的完整说明在 [`docs/releases/`](docs/releases/)；Agent 接口的逐版本变更在 [`agents/AGENTS.md` 第 6 节](agents/AGENTS.md)。

## [未发布]

## [1.4.0] - 2026-11-12

[发布说明](docs/releases/v1.4.0.md)

API 版本 v8 → v9。

### 新增

- PDF 阅读中点击已有高亮可改色、添加或编辑批注、删除；文字批注在页边显示并用引线连接原文。
- 图谱节点筛选支持星级与多位作者组合；点击论文详情中的作者可直接选择或取消筛选。
- 左侧新增「全部已下载」：跨论文库汇总所有已下载论文及其关系，包括未加入任何论文库的论文。
- 「设置」支持分别选择 PDF 下载目录与数据目录；现有文件复制保留，PDF 目录立即生效，数据目录重启后生效。
- 引用下载失败原因持久化，引用页顶部以可展开列表显示未下载论文及原因，并支持逐条重试。
- 时间线视图 Shift 多选论文时，高亮选中论文之间的全部引用路径；网络视图仍显示最短关联。

### 修复

- 无窗口 API/MCP 模式不再创建渲染窗口，并规避部分 Windows 环境的 Electron GPU 子进程崩溃。
- 抓取 / 下载任务在图谱与阅读器之间往返后恢复进度，不再因超过 4 秒而提前消失。
- arXiv 年份优先按编号与首页盖章识别，避免把 2048 context length、1945、1907.01470、1988 等正文数字误认为发表年份；已有错误年份启动时修复一次。
- PDF 高亮、搜索命中与文本选区改为文字背景，保持文字颜色与清晰度；语言按钮与 3D 图谱不再共用图标。

### 文档

- 新增根目录 `AGENTS.md`（coding agent 工作规则）、`CONTRIBUTING.md`、`SECURITY.md` 与本文件。
- 新增 `docs/` 下的架构与设计、开发指南、测试、发布流程文档，以及文档索引与设计记录索引。
- 发布说明由仓库根目录移入 `docs/releases/`，并按 GitHub Release 原文补录 v1.2.0。
- README 修正过期信息：版本徽章、下载地址、API 版本、测试说明、路线图；中英文版本重新对齐。

### 构建与流程

- 新增 `npm test`（不依赖 Electron 的快速回归）与 `npm run test:e2e`（完整回归）。
- 新增 GitHub Actions 工作流、Issue 模板与 PR 模板。
- `.gitignore` 的 `release*/` 限定到仓库根目录，不再误伤 `docs/releases/`。

### 修复

- `downloadtest` 不再无条件依赖未入库的 `.tmp/2603.01966.pdf`，全新克隆后可以直接通过。
- `agents/AGENTS.md` 中 `/api/ping` 与 `/api/status` 的响应示例更新为当前版本。

## [1.3.0] - 2026-11-08

API 版本 v6 → v8。[发布说明](docs/releases/v1.3.0.md)

### 新增

- 引用图谱新增二维时间线视图：按发表年份排布，未知年份独立成列，支持年份跳转、分轴缩放与适配全图。
- 论文详情新增上下游发展史：递归展示参考文献与被引脉络并排除旁支。
- 浏览器插件新增论文库列表与目标库选择，记住上次选择；`POST /api/papers/import-web` 新增可选参数 `libraryId`。
- 新增 `POST /api/connector/pair`，浏览器插件据此自动取得令牌。

### 变更

- 浏览器插件改为自动发现并静默连接桌面端，不再需要手动复制地址与令牌。
- 批量管理与导入按钮移入各论文库的工具栏。
- 全部下拉菜单统一圆角、箭头与焦点样式。

## [1.2.0] - 2026-11-07

API 版本 v5 → v6。[发布说明](docs/releases/v1.2.0.md)

### 新增

- 阅读器正文引用悬浮卡片：悬停 `[1]` 或作者—年份引用时显示对应参考文献，库内论文可直接打开，未入库条目可直接下载。
- 多链接导入与「全部下载」改为自适应并行，并发在 1–6 之间按网络状况调整。
- 进度对象新增可选字段 `active`、`pending`、`concurrency`、`failed`；阅读器引用页与图谱节点侧栏实时显示进度。

### 修复

- PDF 参考文献提取：修复扩窗后的页序错误，支持无编号条目、机构作者、跨行断词与附录截断；旧论文抓取时可从本地 PDF 重建参考文献。
- 并行导入相同内容时可能重复入库的竞态。

## [1.1.0] - 2026-10-30

[发布说明](docs/releases/v1.1.0.md)

### 新增

- 浏览器插件 PaperWeave Connector（Chrome / Edge）：在 arXiv、PDF 页面与带 `citation_*` 元数据的出版商页面一键入库，支持右键保存。
- `POST /api/papers/import-web`：接收 PDF 地址与页面元数据提示。
- macOS 一键构建脚本 `tools/build-mac.sh`。

### 变更

- PDF 阅读器以鼠标位置为中心平滑缩放；交互期间先变换图层，停顿后再高清重绘。

### 修复

- 高亮在缩放与重绘后与文字错位。
- 双栏论文选区填满栏间空白、相邻行高亮重叠。
- 构建在文件被占用与 Electron 托管终端环境下失败。

## [1.0.0] - 2026-10-21

首个公开发布版本，由 PaperGraph 更名为 PaperWeave。功能总览见[发布说明](docs/releases/v1.0.0.md)。

### 变更

- **不兼容**：鉴权头改为 `X-PaperWeave-Token`；MCP Server 更名为 `paperweave-mcp.js`，工具前缀改为 `paperweave_`；环境变量改为 `PAPERWEAVE_S2_API_KEY`。
- 数据目录改为 `paperweave-data`，首次启动自动从 `papergraph-data` 迁移。
- 默认初始论文库名称改为 `New Weave`。

## 0.x

0.1.0 至 0.9.0 为更名前的 PaperGraph 阶段，没有对应标签，变更记录保留在 [`agents/AGENTS.md` 第 6 节](agents/AGENTS.md)。

[未发布]: https://github.com/webDrag0n/PaperWeave/compare/v1.4.0...HEAD

[1.4.0]: https://github.com/webDrag0n/PaperWeave/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/webDrag0n/PaperWeave/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/webDrag0n/PaperWeave/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/webDrag0n/PaperWeave/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/webDrag0n/PaperWeave/releases/tag/v1.0.0
