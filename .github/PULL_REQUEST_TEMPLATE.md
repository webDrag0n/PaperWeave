<!-- 中英文均可 / English or Chinese is fine. 提交前请阅读 CONTRIBUTING.md -->

## 改动说明

<!-- 做了什么，为什么。关联的 Issue 写 Closes #123 -->

## 改动类型

- [ ] 缺陷修复
- [ ] 新功能
- [ ] 重构或性能，行为不变
- [ ] 文档
- [ ] 构建、测试或流程

## 验证

<!-- 写明实际运行了哪些命令及结果；没有运行的套件请说明原因 -->

- [ ] `npm test`
- [ ] `npm run apitest` / `npm run mcptest`（改动涉及 Agent API、service、store、MCP 时）
- [ ] `npm run selftest`（改动涉及界面、preload、IPC 时）
- [ ] 手动验证：

## 联动检查

- [ ] Agent 接口、数据字段或行为语义有变化：已同步 `agents/AGENTS.md`、MCP 工具定义与 API 版本
- [ ] 界面文案有变化：已更新 `renderer/i18n.js`
- [ ] 修改了 `importer.js` / `refs.js` / `citation-index.js`：网页版镜像已同步
- [ ] 用户可见的变化：已写入 `CHANGELOG.md`，README 中英文已同步
- [ ] 涉及鉴权、配对、CORS、CSP、preload 接口或插件权限：已在上方说明安全影响
- [ ] 以上均不涉及

## 截图

<!-- 界面改动请附修改前后的截图 -->
