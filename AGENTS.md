# AGENTS.md

本文件是给在本仓库中**修改代码**的 coding agent 的工作规则。人类贡献者请看 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

> 不要与 [`agents/AGENTS.md`](agents/AGENTS.md) 混淆。那份文件是 PaperWeave 对外的 Agent 接口契约（HTTP API 与 MCP 工具），随安装包分发给最终用户；它是产品的一部分，修改它等同于修改接口文档。

## 项目是什么

PaperWeave 是本地优先的 Electron 桌面论文阅读器：PDF 阅读与批注、引用关系自动解析、引用网络图谱，并通过本地 HTTP API 与 MCP Server 向 AI agent 开放同样的能力。纯 JavaScript，没有构建步骤，没有测试框架，运行时依赖只有 `pdfjs-dist` 与 `three`。

## 动手之前

| 需要了解 | 阅读 |
| --- | --- |
| 模块边界、数据模型、核心流程、已知技术债 | [`docs/architecture.md`](docs/architecture.md) |
| 各类改动必须同步修改的位置 | [`docs/development.md`](docs/development.md#修改指引) |
| 测试套件与运行条件 | [`docs/testing.md`](docs/testing.md) |
| 版本号规则与发布步骤 | [`docs/releasing.md`](docs/releasing.md) |
| 哪份文档负责哪类信息 | [`docs/README.md`](docs/README.md#文档清单与归属) |

## 目录速查

```
main/        主进程（CommonJS）：main.js 入口与 IPC，store.js 存储，service.js 业务，refs.js 引用引擎，agent-api.js HTTP 接口
preload/     contextBridge，渲染进程访问主进程的唯一通道
renderer/    界面（ES Module）：app.js 控制器，bridge.js 桥接与网页版实现，pdfviewer.js，graph.js，i18n.js，selftest.js
shared/      主进程与渲染进程共用的 ES Module
mcp/         MCP stdio Server，零依赖单文件
extension/   浏览器插件（Manifest V3）
agents/      对外 Agent 接口契约
vendor/      pdf.js 与 three.js 发行文件，勿手改
tools/       测试运行器、开发服务器、打包脚本
docs/        开发文档、设计记录、发布说明
```

## 命令

```bash
npm install
npm start              # 桌面应用
npm run dev            # 浏览器预览 http://127.0.0.1:7100/
npm test               # 快速回归，不启动 Electron，每次改动后必跑
npm run apitest        # Agent HTTP API，无窗口 Electron
npm run mcptest        # MCP Server，无窗口 Electron
npm run selftest       # 界面端到端，会弹出窗口并抢占焦点
npm run test:e2e       # 以上三个 Electron 套件
```

`node` 不在 PATH 上时，检查本地是否存在 `tools/runtime/node-v*/`（未入库的独立运行时），可直接用其中的 `node.exe` 运行 `tools/*.js`。

## 硬性约束

1. **引用边方向**：`{ from, to }` 永远表示 from 引用了 to。
2. **业务逻辑只写一处**：包含流程的操作放在 `main/service.js`，由 IPC 与 HTTP 共同调用。不要在 `main.js` 的 IPC 处理器或 `agent-api.js` 的路由里重复实现。
3. **渲染进程不直接碰 Node**：新增能力必须走 `main.js` → `preload.js` → `bridge.js` 这条链路，并在 `bridge.js` 的 `webBridge` 中给出网页版实现或明确的降级返回。
4. **不引入构建步骤与新的运行时依赖**。`renderer/` 中只能用浏览器原生支持的语法与 importmap 中已有的模块。
5. **`refText` 不出主进程**：返回给渲染进程或 API 的论文对象必须去掉该字段。
6. **数据向后兼容**：不改变已有持久化字段的含义；新增字段在 `Store._load()` 中补默认值。
7. **界面文案以中文为 key**：新增或修改文案时同步维护 `renderer/i18n.js` 的 `DICT`。
8. **`vendor/` 是原样拷贝**：不要编辑其中的文件，升级方式见开发指南。
9. **安全敏感区域**：`agent-api.js` 的鉴权 / 配对 / CORS、`main.js` 的协议处理器与 `webPreferences`、`preload.js` 的接口面、`index.html` 的 CSP、`extension/manifest.json` 的权限。改动前先读 [`SECURITY.md`](SECURITY.md)，并在说明中明确指出。

## 联动清单

| 你改了 | 还必须改 |
| --- | --- |
| HTTP 接口、MCP 工具、对外数据字段或行为语义 | `main/agent-api.js`、`mcp/paperweave-mcp.js`、`agents/AGENTS.md`（含版本表）、`/api/ping` 的 `api` 值、`tools/api-test.js`、`tools/mcp-test.js` |
| `main/importer.js`、`main/refs.js`、`main/citation-index.js` | 对应的网页版镜像 `renderer/pdfmeta.js`、`renderer/refs-web.js`、`renderer/citation-index.js`，然后跑 `npm run citationtest` |
| `preload/preload.js` 暴露的方法 | `main/main.js` 的 IPC 注册、`renderer/bridge.js` 的 `webBridge` |
| 论文可更新字段 | `main/store.js` 与 `renderer/bridge.js` 中两份 `allowed` 白名单 |
| 界面文案 | `renderer/i18n.js` |
| 用户可见的行为 | `CHANGELOG.md` 的「未发布」；必要时 `README.md` 与 `README.en.md` 同步修改 |
| 模块结构、数据结构、核心流程 | `docs/architecture.md` |
| 命令、环境变量、测试套件 | `docs/development.md`、`docs/testing.md`、本文件 |
| 浏览器插件行为 | `extension/README.md`、`tools/ext-api-test.js` 或 `tools/connector-background-test.js` |

## 完成标准

报告任务完成之前：

1. `npm test` 通过。
2. 改动涉及 `main/agent-api.js`、`main/service.js`、`main/store.js` 或 `mcp/` 时，`npm run apitest` 与 `npm run mcptest` 通过。
3. 改动涉及 `renderer/`、`preload/` 或 IPC 时，`npm run selftest` 通过。它会显示窗口并在截图时置顶；用户正在使用这台电脑时，先说明再运行，或者请用户运行。
4. 新行为有对应用例；缺陷修复先有能复现问题的失败用例。
5. 联动清单中的对应项全部完成。
6. 如实报告运行了哪些套件及其结果。没有运行的套件要明确说明没有运行，不要推断结果。

## 环境注意事项

- **`ELECTRON_RUN_AS_NODE`**：由 Electron 托管的终端可能设置了这个变量。测试运行器会自行清除；直接运行 `electron` 或打包时需要先取消它。
- **Electron 运行器在 Windows 上验证**：`selftest`、`apitest`、`mcptest` 收尾时调用 `taskkill`，在其他平台上未经验证。
- **联网用例**：`apitest` 与 `mcptest` 各有一个 arXiv 下载用例，离线时自动跳过。其余测试不得依赖网络。
- **测试数据目录**：`.selftest-data/`、`.apitest-data/`、`.mcptest-data/`、`.tmp/` 均未入库，可以安全删除。不要让测试读写真实用户数据目录。
- **`tools/` 中的演示脚本**：`installed-mcp-demo.js`、`live-fetch-demo.js`、`live-progress-demo.js`、`seed-real-library.js`、`wam-cross-check.js`、`wam-link-demo.js` 依赖特定本机环境并会操作真实论文库，不要运行。
- **`release/`**：构建产物目录，未入库。其中的 `paperweave-agent-api.json` 含本机令牌，不要读取后外传，也不要上传。

## Git 与发布

- 未经维护者明确要求，不要执行 `git commit`、`git push`、打标签或创建 GitHub Release，也不要修改版本号。
- 提交信息采用 Conventional Commits 前缀（`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:`），描述用中文或英文。
- 不要改写已发布的历史文档：`docs/releases/` 与 `docs/superpowers/` 下的既有文件只增不改。
