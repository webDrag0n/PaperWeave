# PaperWeave 文档

这里是面向开发者与 coding agent 的文档。产品介绍与使用说明见仓库根目录的 [README](../README.md)。

## 从哪里开始

| 你想做什么 | 阅读 |
| --- | --- |
| 了解项目能做什么、如何安装使用 | [README](../README.md)（[English](../README.en.md)） |
| 提交第一个改动 | [贡献指南](../CONTRIBUTING.md) → [开发指南](development.md) |
| 理解代码结构与设计取舍 | [架构与设计](architecture.md) |
| 运行或编写测试 | [测试](testing.md) |
| 发布新版本 | [发布流程](releasing.md) |
| 让 agent 操作论文库（HTTP API / MCP） | [`agents/AGENTS.md`](../agents/AGENTS.md) |
| 以 coding agent 身份参与开发 | 根目录 [`AGENTS.md`](../AGENTS.md) |
| 使用或修改浏览器插件 | [`extension/README.md`](../extension/README.md) |
| 报告安全问题 | [`SECURITY.md`](../SECURITY.md) |
| 查看版本变更 | [`CHANGELOG.md`](../CHANGELOG.md)、[发布说明](releases/) |
| 查看某个功能当初的设计与实施计划 | [设计记录](superpowers/README.md) |

## 文档清单与归属

每类信息只在一个地方维护，其他位置用链接引用。修改代码时按下表更新对应文档。

| 文档 | 维护的内容 | 何时更新 |
| --- | --- | --- |
| `README.md` / `README.en.md` | 产品定位、功能、安装、使用、常见问题、路线图 | 用户可见的功能或安装方式变化。两个文件必须同步修改 |
| `AGENTS.md`（根目录） | coding agent 的工作规则：命令、约束、联动清单 | 开发约定或目录结构变化 |
| `agents/AGENTS.md` | Agent 接口契约：HTTP API、MCP 工具、数据模型、API 版本史。**随安装包分发给最终用户** | 任何接口、字段、行为语义变化 |
| `CONTRIBUTING.md` | 贡献流程、提交与 PR 要求 | 协作流程变化 |
| `SECURITY.md` | 漏洞报告渠道、安全模型、敏感代码范围 | 鉴权、配对、网络暴露面变化 |
| `CHANGELOG.md` | 每个版本的变更摘要 | 每个合并的 PR 在「未发布」中追加一行 |
| `docs/architecture.md` | 模块边界、数据模型、核心流程、设计决策、技术债 | 新增模块、数据结构或流程变化、清偿或新增技术债 |
| `docs/development.md` | 环境、命令、环境变量、各类改动的联动步骤 | 新增命令、环境变量或联动要求 |
| `docs/testing.md` | 测试套件、运行条件、编写约定 | 新增或调整测试套件 |
| `docs/releasing.md` | 版本规则、发布步骤、历史版本表 | 发布流程变化；每次发布追加历史版本 |
| `docs/releases/vX.Y.Z.md` | 面向用户的单版本发布说明，即 GitHub Release 正文 | 每次发布新增一个文件，发布后不再修改 |
| `docs/superpowers/` | 功能的设计说明与实施计划，属于历史记录 | 开始较大功能前新增；完成后不回头改写 |
| `extension/README.md` | 浏览器插件的安装、使用、文件结构 | 插件行为变化 |

## 文档约定

- **语言**：中文是文档的基准语言。`README.en.md` 是 README 的英文版本，`CONTRIBUTING.md` 与 `SECURITY.md` 顶部附英文摘要。Issue 与 PR 中英文均可。
- **以代码为准**：文档与代码不一致时，先确认代码行为，再修正文档。发现不一致请直接提 PR。
- **不写会过期的数字**：测试用例数、代码行数等随时变化的数字不写进长期文档，只出现在发布说明这类记录某一时刻的文档里。
- **历史文档不改写**：发布说明与设计记录描述的是当时的状态，后续变化写进新文档，不回头修改旧文件。
- **链接用相对路径**，这样在 GitHub 网页和本地编辑器中都能跳转。
