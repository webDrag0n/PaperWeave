# 贡献指南

感谢你愿意为 PaperWeave 出力。本文说明如何报告问题、提交改动，以及一个 PR 被合并需要满足的条件。

> **English summary.** Issues and pull requests are welcome in English or Chinese. Set up with `npm install`, run `npm test` before every commit, and run `npm run test:e2e` when you touch the UI or the Agent API. Any change to the HTTP API, MCP tools or data fields must update `agents/AGENTS.md` and the API version in the same PR. Developer documentation under `docs/` is written in Chinese; machine translation works well on it, and maintainers are happy to answer questions in English.

## 参与方式

- **报告缺陷**：使用 [Issue 模板](https://github.com/webDrag0n/PaperWeave/issues/new/choose)，写明版本、操作系统、复现步骤与期望行为。涉及具体论文时请给出 arXiv 编号或 DOI。
- **提出功能建议**：先开 Issue 说明使用场景，再讨论方案。
- **安全问题**：不要公开提 Issue，按 [`SECURITY.md`](SECURITY.md) 的方式私下报告。
- **提交代码或文档**：小的修复可以直接提 PR；较大的改动先开 Issue 对齐方向，满足[设计记录](docs/superpowers/README.md#何时需要写设计记录)条件的需要先写设计说明。

## 开发流程

1. Fork 仓库并克隆，按 [开发指南](docs/development.md) 完成环境准备。
2. 从 `main` 创建分支：功能用 `feature/<主题>`，修复用 `fix/<主题>`。
3. 修改代码。不同类型的改动需要同步修改哪些位置，见开发指南的[修改指引](docs/development.md#修改指引)。
4. 补充测试并运行，范围见 [测试](docs/testing.md#何时运行哪些套件)。
5. 更新文档，范围见 [文档归属表](docs/README.md#文档清单与归属)。
6. 在 `CHANGELOG.md` 的「未发布」一节追加一行，面向用户描述这次变化。
7. 提交并发起 PR，按模板填写说明。

## 提交规范

提交信息采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 前缀，描述用中文或英文均可：

```
feat: 增加引用网络时间线视图
fix: 修复扩窗提取参考文献时的页序
docs: 补充发布流程
```

可用的类型有 `feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`chore`。一次提交只做一件事；不兼容变更的写法见 [发布流程](docs/releasing.md#分支与提交)。

## PR 合并条件

- [ ] `npm test` 通过。
- [ ] 改动涉及界面、IPC 或 Agent API 时，对应的 Electron 套件通过，并在 PR 中写明运行了哪些。
- [ ] 新行为有测试覆盖；缺陷修复附带能复现原问题的用例。
- [ ] Agent 接口、数据字段或行为语义有变化时，`agents/AGENTS.md`、MCP 工具定义与 API 版本已同步更新。
- [ ] 界面文案有变化时，`renderer/i18n.js` 已补充英文译文。
- [ ] 主进程与网页版镜像实现保持一致（`importer.js`、`refs.js`、`citation-index.js`）。
- [ ] 用户可见的变化已写入 `CHANGELOG.md`，`README.md` 与 `README.en.md` 同步更新。
- [ ] 没有引入新的运行时依赖；确有必要时已在 Issue 中讨论并获得同意。
- [ ] 界面改动附截图。

PR 尽量保持小而聚焦。与主题无关的重构、格式化请单独提交。

## 使用 AI 工具贡献

欢迎使用 coding agent。仓库根目录的 [`AGENTS.md`](AGENTS.md) 是给 agent 的工作规则，多数工具会自动读取。提交者对 PR 的全部内容负责：请亲自阅读 diff、运行测试并确认结果，不要提交自己没有验证过的改动。

## 交流约定

请保持尊重、就事论事。评审意见针对代码而不是人；有分歧时用可复现的例子和数据说话。维护者有权关闭不符合项目方向的 Issue 与 PR，并会说明原因。

## 许可

本项目采用 [MIT 许可证](LICENSE)。提交贡献即表示你同意以同一许可证授权你的贡献。
