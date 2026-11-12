# 测试

PaperWeave 没有引入测试框架。每个套件都是 `tools/` 下可以直接用 Node 运行的脚本，失败时以非零退出码结束。

## 一览

| 命令 | 脚本 | 需要 Electron | 覆盖范围 |
| --- | --- | --- | --- |
| `npm run storetest` | `store-test.js` | 否 | 全局论文与跨库关系、目录复制与持久化、禁止覆盖、全局删除 |
| `npm run yeartest` | `pubyear-test.js` | 否 | arXiv 编号年份、出版标记、创建日期约束、存量修复、网页镜像一致性 |
| `npm run graphtest` | `graph-layout-test.js` | 否 | 时间线年份布局、上下游谱系收集、多选节点间全部路径 |
| `npm run downloadtest` | `adaptive-scheduler-test.js`、`download-service-test.js` | 否 | 调度器并发与退避、批量下载、去重、哈希竞态、自动建边、失败记录与重试信息 |
| `npm run citationtest` | `citation-index-test.js`、`reference-extraction-test.js` | 否 | 引用索引、参考文献定位与切分、主进程与网页版实现的一致性 |
| `npm run exttest` | `ext-api-test.js`、`connector-background-test.js` | 否 | 插件相关接口（`import-web`、CORS、鉴权、配对）、插件后台脚本 |
| `npm run apitest` | `api-test.js` | 是，无窗口 | Agent HTTP API 全流程 |
| `npm run mcptest` | `mcp-test.js` | 是，无窗口 | MCP 握手、工具、资源、提示模板 |
| `npm run selftest` | `selftest.js` + `renderer/selftest.js` | 是，**显示窗口** | 真实界面中的端到端用户场景 |

两个聚合命令：

- `npm test`：前六个套件。不启动 Electron，通常几十秒内完成，每次改动后都应运行，也是 CI 在每个 PR 上执行的内容。
- `npm run test:e2e`：后三个套件，耗时数分钟。

在 v1.3.0 上的基线：`apitest` 48 项、`mcptest` 49 项、`selftest` 225 项，全部通过。用例数会随功能增长，以运行器输出为准，文档中不再维护具体数字。

## 何时运行哪些套件

| 改动范围 | 至少运行 |
| --- | --- |
| 任何代码改动 | `npm test` |
| `renderer/` 界面、`preload/`、`main/main.js` 的 IPC | 加 `npm run selftest` |
| `main/agent-api.js`、`main/service.js`、`main/store.js` | 加 `npm run apitest`、`npm run mcptest` |
| `mcp/paperweave-mcp.js` | 加 `npm run mcptest` |
| `extension/` | `npm run exttest`，并在浏览器中手动加载验证 |
| 发布前 | 全部套件，见 [发布流程](releasing.md) |

## 各套件说明

### 不依赖 Electron 的套件

直接 `require` 被测模块，用 `node:assert/strict` 断言。`main/service.js` 支持注入 `fetch` 与 `referencesOnline`，因此下载相关测试不访问网络。

- `store-test.js` 在 `.tmp/store-test-<pid>/` 验证全局视图与目录复制，结束后清理。
- `pubyear-test.js` 含四篇问题论文的纯文本与存量数据回归；`.tmp/year-samples/<arxiv-id>.pdf` 存在时还会验证真实 PDF，缺失则跳过，不要求联网。
- `download-service-test.js` 在 `.tmp/download-service-test/` 下创建临时数据。
- 真实论文回归依赖 `.tmp/2603.01966.pdf`。这个文件不入库，需要时自行下载 arXiv:2603.01966 的 PDF 放到该路径。文件不存在时（全新克隆与 CI 都是这种情况），`reference-extraction-test.js` 打印 `SKIP` 并继续，`download-service-test.js` 改用 `assets/samples/attention.pdf` 验证同一条路径。新增用例不得无条件依赖 `.tmp/` 下的文件。
- `graph-layout-test.js` 与部分一致性用例通过 `data:` URL 动态导入 `renderer/` 下的 ES Module，所以这些模块必须保持纯函数、不依赖 DOM。
- `ext-api-test.js` 用模拟的 store 与 service 启动真实的 `agent-api.js`，会占用 24680 起的一个本地端口。

### `apitest` 与 `mcptest`

运行器以 `PAPERWEAVE_HEADLESS=1`、`PAPERWEAVE_AUTOFETCH=0` 启动一个完整的应用实例，数据目录分别为 `.apitest-data/` 与 `.mcptest-data/`，结束后删除。等待 `agent-api.json` 出现后，以外部客户端的身份走完整流程。
无窗口模式不创建渲染窗口，并禁用独立 GPU 子进程；测试实例不应访问真实用户数据目录。

两者各有一个从 arXiv 下载论文的用例；网络不可用时该用例记为跳过，不算失败。

### `selftest`

`tools/selftest.js` 以 `PAPERWEAVE_SELFTEST=1` 启动应用，页面带 `?selftest=1` 参数加载，`renderer/app.js` 随即动态导入 `renderer/selftest.js` 并执行。用例直接操作真实 DOM 与 `bridge`，覆盖导入、元数据提取、阅读器、批注与高亮背景、图谱、时间线全部路径、跨视图进度恢复、下载失败重试、全部已下载、存储设置、多论文库、i18n 等路径。

需要了解的行为：

- **窗口会显示并在截图时置顶抢占焦点**，运行期间不要操作电脑。
- 数据目录为 `.selftest-data/`，每次运行前清空。
- 截图写入 `shots/`，报告写入 `selftest-report.json`，两者都不入库。
- 整体超时 150 秒，超时以退出码 2 结束。
- 样例论文来自 `assets/samples/`，由 `tools/make_samples.py` 生成（需要 Python 与 `reportlab`）。修改样例后，依赖其内容的断言需要一并调整。

README 中的截图取自 `shots/`，更新界面后把需要展示的截图复制到 `README.assets/`。

### 针对打包产物测试

三个 Electron 运行器都支持用 `PAPERWEAVE_TEST_EXE` 指定被测程序，发布前用它验证打包后的便携版：

```powershell
$env:PAPERWEAVE_TEST_EXE = (Resolve-Path "release\PaperWeave-<版本>-win-x64-portable.exe").Path
npm run test:e2e
```

## 编写测试

- **纯逻辑**（布局、解析、调度、匹配）：在 `tools/` 下新增或扩展 `*-test.js`，用 `node:assert/strict`，每组断言结束后打印一行 `PASS <说明>`。新脚本需要接入 `package.json` 的对应 `*test` 脚本，否则不会被 `npm test` 执行。
- **Agent API**：在 `tools/api-test.js` 中沿用 `check(名称, 条件, 详情)`；MCP 工具在 `tools/mcp-test.js` 中对应增加。
- **界面行为**：在 `renderer/selftest.js` 中增加 `check(...)`。需要访问内部对象时使用 `window.__pg`。
- 修复缺陷时先写出能复现问题的失败用例，再修改实现。
- 测试不得依赖真实用户数据目录，也不得依赖网络；确需联网的用例必须像现有 arXiv 用例那样在离线时跳过。

## 持续集成

`.github/workflows/ci.yml` 定义了两个任务：

- `test`：在每次推送到 `main` 和每个 PR 上运行 `npm test`，覆盖 Windows 与 Linux。
- `e2e`：在 Windows 上依次运行 `apitest`、`mcptest`、`selftest`（即 `npm run test:e2e` 的内容）并上传截图与报告。Electron 套件在托管运行器上的稳定性尚未验证，所以目前只能从 Actions 页面手动触发，不作为合并条件。

## 平台说明

- 全部套件在 Windows 上验证通过。
- 不依赖 Electron 的套件不含平台相关代码，但在 macOS 与 Linux 上尚未实际运行过。
- 三个 Electron 运行器在收尾时调用 Windows 的 `taskkill` 清理进程树，在 macOS 与 Linux 上未经验证，可能需要适配。
