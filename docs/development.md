# 开发指南

本文说明如何搭建环境、运行各种模式，以及修改不同部分代码时必须遵守的约定。模块职责与数据流见 [架构与设计](architecture.md)。

## 环境准备

- Node.js 18 或更高（当前开发与验证使用 24.x）与 npm。
- Git。
- 打包需要对应平台：Windows 安装包在 Windows 上构建，macOS 的 dmg 必须在 macOS 上构建，Linux 的 AppImage / deb 必须在 Linux 上构建。

```bash
git clone https://github.com/webDrag0n/PaperWeave.git
cd PaperWeave
npm install
```

`npm install` 会下载 Electron 二进制。国内网络较慢时可先设置镜像：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
```

## 运行

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动桌面应用，使用真实用户数据目录 |
| `npm run dev` | 浏览器预览：`http://127.0.0.1:7100/`，首次打开自动载入示例论文，数据存于浏览器 |
| `npm test` | 快速回归：不启动 Electron 的全部测试 |
| `npm run test:e2e` | 完整回归：`selftest` + `apitest` + `mcptest`，会启动 Electron |
| `npm run pack` | 生成免安装目录，用于本地检查打包结果 |
| `npm run dist:win` / `dist:mac` / `dist:linux` | 构建发行物到 `release/` |
| `npm run pack:ext` | 仅打包浏览器插件到 `release/` |

各测试套件的覆盖范围、前置条件与耗时见 [测试](testing.md)。

开发时不想影响自己的真实论文库，可以指定独立数据目录（`.dev-data/` 已在 `.gitignore` 中）：

```bash
npx electron . --user-data-dir=./.dev-data
```

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `PAPERWEAVE_S2_API_KEY` | Semantic Scholar API Key，提高引用抓取配额 |
| `PAPERWEAVE_AUTOFETCH=0` | 关闭导入后的自动引用抓取 |
| `PAPERWEAVE_AGENT_API=0` | 不启动本地 Agent API |
| `PAPERWEAVE_AGENT_API_JSON` | 仅 MCP Server 读取：显式指定连接信息文件路径 |
| `PAPERWEAVE_HEADLESS=1` | 不显示窗口，`apitest` / `mcptest` 使用 |
| `PAPERWEAVE_SELFTEST=1` | 自测模式：加载 `?selftest=1`、注册自测 IPC、关闭自动抓取 |
| `PAPERWEAVE_SELFTEST_OUT`、`PAPERWEAVE_SAMPLE_DIR`、`PAPERWEAVE_SHOT_DIR` | 自测报告、样例 PDF、截图的路径，由 `tools/selftest.js` 设置 |
| `PAPERWEAVE_TEST_EXE` | 让测试运行器启动指定的可执行文件（例如打包后的便携版）而不是开发版 Electron |
| `PORT`、`HOST` | `npm run dev` 的监听端口与地址，也可用 `--port`、`--host` 参数 |

## 目录结构

```
main/        Electron 主进程（CommonJS）
preload/     contextBridge 桥
renderer/    界面（ES Module，无构建步骤）
shared/      主进程与渲染进程共用的 ES Module
mcp/         MCP stdio Server（零依赖单文件，随应用分发）
extension/   浏览器插件 PaperWeave Connector（随应用分发）
agents/      AGENTS.md：Agent 接口契约（随应用分发）
vendor/      pdf.js 与 three.js 发行文件
assets/      图标与自测样例 PDF
tools/       开发服务器、测试运行器、打包脚本
docs/        开发文档、设计记录、发布说明
```

未纳入版本控制的本地目录：`release/`（构建产物）、`shots/` 与 `selftest-report.json`（自测产物）、`.selftest-data/`、`.apitest-data/`、`.mcptest-data/`、`.tmp/`（测试临时数据）、`tools/runtime/`（可选的独立 Node 运行时）。

## 代码约定

项目没有配置 lint 或格式化工具，请与周围代码保持一致：

- 两个空格缩进，单引号，语句末尾加分号。
- 主进程与 `tools/` 用 CommonJS；`renderer/` 与 `shared/` 用 ES Module。
- 注释、界面文案、测试用例名称使用中文；标识符使用英文。
- 注释说明原因与约束，不复述代码。
- 不新增运行时依赖。确有必要时先开 Issue 讨论。

## 修改指引

下面按改动类型列出必须同步修改的位置。漏掉其中任何一项都会造成界面、Agent 接口或文档之间的不一致。

### 新增或修改界面文案

1. 代码中以中文原文调用 `t('中文')` 或 `tf('已选 {n} 篇', { n })`；静态 DOM 使用 `data-i18n`、`data-i18n-title`、`data-i18n-ph` 属性。
2. 在 `renderer/i18n.js` 的 `DICT` 中添加同一中文 key 的英文译文。
3. 修改已有中文文案时，`DICT` 的 key 必须同步修改，否则英文界面会回退显示中文。

### 新增渲染进程可调用的能力

1. 实现逻辑：只读写数据放在 `main/store.js`，包含流程的放在 `main/service.js`。
2. 在 `main/main.js` 的 `registerIpc()` 注册 `ipcMain.handle('域:动作', ...)`。
3. 在 `preload/preload.js` 暴露同名方法。
4. 在 `renderer/bridge.js` 的 `webBridge` 中提供网页版实现。无法在浏览器中实现的能力也要给出明确的降级返回值，否则浏览器预览会报错。
5. 在 `renderer/selftest.js` 增加用例。

### 新增或修改 Agent API

HTTP 接口、MCP 工具与文档是同一份契约的三个表现，必须一起改：

1. `main/agent-api.js`：路由与参数校验。业务逻辑复用 `service` 或 `store`，不要在路由里重新实现。
2. `mcp/paperweave-mcp.js`：对应的工具定义（`TOOLS`）与调用映射。
3. `agents/AGENTS.md`：接口表、数据模型、「版本与变更」表格。
4. 契约发生变化时递增 API 版本：`main/agent-api.js` 中 `/api/ping` 返回的 `api` 值与 `agents/AGENTS.md` 顶部的版本号保持一致。判定标准见 [发布流程](releasing.md#版本号)。
5. `tools/api-test.js` 与 `tools/mcp-test.js` 增加用例；浏览器插件相关接口还需更新 `tools/ext-api-test.js`。

### 修改 PDF 提取、引用解析或引用索引

这三块在主进程和网页版各有一份实现：

| 主进程 | 网页版镜像 |
| --- | --- |
| `main/importer.js` | `renderer/pdfmeta.js` |
| `main/refs.js` | `renderer/refs-web.js` |
| `main/citation-index.js` | `renderer/citation-index.js` |

两边必须同步修改，然后运行 `npm run citationtest`，其中包含两份实现的一致性用例。

### 新增持久化字段

1. 在 `main/store.js` 的 `_load()` 中为旧数据补默认值。
2. 论文字段需加入 `updatePaper` 的 `allowed` 白名单；`renderer/bridge.js` 的 `webBridge.updatePaper` 有一份相同的白名单，同步修改。
3. 字段经 Agent API 暴露时，按上一小节更新契约。
4. 不要改变既有字段的含义。需要破坏性变更时，写迁移逻辑并保留旧文件备份，做法参考 `_load()` 中的单库结构迁移。

### 修改浏览器插件

- 版本号在 `extension/manifest.json`，发布时与应用版本保持一致。
- 插件随应用分发，源码即产物，没有构建步骤。
- 运行 `npm run exttest`；手动验证时在 `chrome://extensions` 以开发者模式加载 `extension/` 目录。
- 使用说明在 [`extension/README.md`](../extension/README.md)，行为变化时同步更新。

### 升级 pdf.js 或 three.js

`vendor/` 中的文件是 `node_modules` 对应构建产物的原样拷贝，没有修改：

| `vendor/` | 来源 |
| --- | --- |
| `pdfjs/pdf.mjs` | `node_modules/pdfjs-dist/build/pdf.mjs` |
| `pdfjs/pdf.worker.mjs` | `node_modules/pdfjs-dist/build/pdf.worker.mjs` |
| `three/three.module.js` | `node_modules/three/build/three.module.js` |
| `three/addons/controls/OrbitControls.js` | `node_modules/three/examples/jsm/controls/OrbitControls.js` |

升级步骤：修改 `package.json` 版本并 `npm install` → 把上述文件重新复制到 `vendor/` → 运行完整回归。主进程直接从 `node_modules` 加载 `pdfjs-dist/legacy/build/pdf.mjs`，因此两处使用的 pdf.js 版本会随之保持一致。

### 新增打包内容

应用包内的文件由 `package.json` 的 `build.files` 决定，随包分发的独立文件由 `build.extraResources` 决定。新增顶层目录时需要把它加入 `build.files`，否则开发环境正常而安装版缺文件。

## 调试

- **渲染进程**：`npm start` 后按 `Ctrl+Shift+I`（macOS 为 `Cmd+Opt+I`）打开开发者工具。`window.__pg` 暴露了 `state`、`viewer`、`graph` 等内部对象。
- **主进程**：日志输出到启动应用的终端；需要断点时使用 `npx electron --inspect=9229 .`。
- **Agent API**：连接信息在数据目录的 `agent-api.json`，`curl http://127.0.0.1:24680/api/ping` 可以确认服务是否在运行。
- **数据问题**：直接查看数据目录下的 JSON 文件。损坏时会生成 `.broken-<时间戳>` 备份。

## 常见环境问题

- **`ELECTRON_RUN_AS_NODE=1`**：某些由 Electron 托管的终端会设置这个变量，导致 `electron .` 以 Node 模式运行、asar 打包失败。测试运行器会自行清除它；打包时请改用独立的 Node 运行 `tools/build.js`，或在启动前取消该变量。
- **构建时文件被占用（EBUSY）**：编辑器的文件监听可能锁住 `app.asar`。`tools/build.js` 默认把输出放到系统临时目录并自动重试，只把发行物拷回 `release/`。
- **端口占用**：Agent API 默认 24680，被占用时依次尝试到 24700。同时运行应用和测试不会冲突，但连接信息文件以各自的数据目录为准。
- **引用抓取被限流**：Semantic Scholar 未认证配额很低，开发时建议设置 `PAPERWEAVE_S2_API_KEY`，或用 `PAPERWEAVE_AUTOFETCH=0` 关闭自动抓取。
