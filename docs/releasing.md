# 发布流程

本文规定版本号规则、分支与提交约定，以及发布一个版本的完整步骤。

## 版本号

项目同时维护两个互相独立的版本号。

### 应用版本

采用[语义化版本](https://semver.org/lang/zh-CN/)，Git 标签格式为 `vX.Y.Z`。

| 位 | 何时递增 |
| --- | --- |
| 主版本 | 用户数据无法自动迁移，或 Agent 契约出现不兼容变更（例如 1.0.0 更名时修改了鉴权头与 MCP 工具前缀） |
| 次版本 | 新增功能，旧数据与旧客户端保持可用 |
| 修订号 | 只含缺陷修复 |

### API 版本

Agent 契约的版本是一个整数，由 `GET /api/ping` 的 `api` 字段返回，客户端据此判断能力。

- **需要递增**：新增、删除或重命名接口与 MCP 工具；请求或响应字段的增删；默认值、状态码或行为语义的变化。
- **不需要递增**：纯界面改动、内部重构、性能优化。这类改动在 `agents/AGENTS.md` 的「版本与变更」表中记为「N（HTTP 不变）」。

API 版本随功能开发递增，不必等到发布；一个应用版本可以跨越多个 API 版本（1.3.0 从 v6 直接到 v8）。

### 版本号出现的位置

发布时逐项核对。历史上出现过遗漏：v1.0.0 的文档已声明 API v5，而 `/api/ping` 实际仍返回 4。

| 位置 | 内容 |
| --- | --- |
| `package.json` → `version` | 应用版本 |
| `package-lock.json` | 应用版本，运行 `npm install --package-lock-only` 同步 |
| `extension/manifest.json` → `version` | 与应用版本一致 |
| `main/agent-api.js` → `/api/ping` 的 `api` | API 版本 |
| `agents/AGENTS.md` 顶部「API 版本」与文末表格 | API 版本及其变更说明 |
| `agents/AGENTS.md` 中 `/api/ping` 与 `/api/status` 的响应示例 | 应用版本与 API 版本 |
| `extension/README.md` | 提到的 API 版本 |
| `README.md`、`README.en.md` | 版本徽章取自 GitHub Release，无需手改；功能描述按需更新 |
| `CHANGELOG.md`、`docs/releases/vX.Y.Z.md` | 本次发布的变更记录与发布说明 |

## 分支与提交

- `main` 始终保持可发布状态，所有标签都打在 `main` 上。
- 功能开发使用 `feature/<主题>` 分支，缺陷修复使用 `fix/<主题>`，通过 Pull Request 合并。
- 提交信息采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 前缀加中文或英文描述，一次提交只做一件事：

  ```
  feat: 增加引用网络时间线视图
  fix: 修复扩窗提取参考文献时的页序
  docs: 补充发布流程
  test: 完成引用悬浮浮窗完整回归
  refactor: / chore: / perf: / build:
  ```

- 不兼容变更在类型后加 `!`，并在正文以 `BREAKING CHANGE:` 说明影响与迁移方式。

## 发布步骤

### 1. 准备

1. 确认 `CHANGELOG.md` 的「未发布」一节完整反映了自上个版本以来的变更。
2. 决定版本号，按上表更新各处版本。
3. 把「未发布」改为新版本号与日期，并新建空的「未发布」一节。
4. 撰写 `docs/releases/vX.Y.Z.md`：面向用户说明主要更新、升级注意事项、构建产物。标题格式为 `PaperWeave vX.Y.Z — <主题>`。
5. 核对 `agents/AGENTS.md` 的变更表已包含本次的全部接口变化。

### 2. 验证

```bash
npm test
npm run test:e2e
```

全部通过后才能继续。`selftest` 会显示窗口并抢占焦点。

### 3. 构建

```bash
npm run dist:win      # Windows：NSIS 安装包 + 便携版
npm run dist:mac      # macOS：dmg + zip，必须在 macOS 上执行
npm run dist:linux    # Linux：AppImage + deb，必须在 Linux 上执行
```

macOS 也可以使用 `./tools/build-mac.sh [x64|arm64|all]`，它会先安装依赖再构建。

`tools/build.js` 先在系统临时目录构建，再把发行物拷回 `release/`，随后打包浏览器插件。Windows 构建完成后 `release/` 中应有：

| 文件 | 是否上传 |
| --- | --- |
| `PaperWeave-X.Y.Z-win-x64-setup.exe` | 是 |
| `PaperWeave-X.Y.Z-win-x64-setup.exe.blockmap` | 是 |
| `PaperWeave-X.Y.Z-win-x64-portable.exe` | 是 |
| `PaperWeave-Connector-X.Y.Z.zip` | 是 |
| `latest.yml`、`extension/` | 否 |

用打包产物再跑一遍回归：

```powershell
$env:PAPERWEAVE_TEST_EXE = (Resolve-Path "release\PaperWeave-X.Y.Z-win-x64-portable.exe").Path
npm run test:e2e
Remove-Item Env:PAPERWEAVE_TEST_EXE
```

> **注意**：在 `release/` 里运行过便携版后，目录中会多出 `AGENTS.md`、`paperweave-mcp.js` 和 `paperweave-agent-api.json`。最后一个文件包含本机的 Agent 令牌，**不要上传**。

### 4. 提交、合并、打标签

```bash
git add -A
git commit -m "chore: 发布 vX.Y.Z"
# 通过 PR 合并到 main 后：
git checkout main && git pull
git tag -a vX.Y.Z -m "PaperWeave vX.Y.Z"
git push origin main vX.Y.Z
```

### 5. 创建 GitHub Release

在 <https://github.com/webDrag0n/PaperWeave/releases> 基于该标签创建 Release，标题与正文取自 `docs/releases/vX.Y.Z.md`，上传上表中的构建产物。使用 GitHub CLI 时：

```bash
gh release create vX.Y.Z \
  --title "PaperWeave vX.Y.Z — <主题>" \
  --notes-file docs/releases/vX.Y.Z.md \
  release/PaperWeave-X.Y.Z-win-x64-setup.exe \
  release/PaperWeave-X.Y.Z-win-x64-setup.exe.blockmap \
  release/PaperWeave-X.Y.Z-win-x64-portable.exe \
  release/PaperWeave-Connector-X.Y.Z.zip
```

### 6. 发布后

- 打开 Release 页面，确认附件齐全且可下载，README 的版本徽章已更新。
- 从 Release 下载安装包，在一台干净的机器或新的用户数据目录上完成一次安装与启动。

## 修复版本

线上版本出现严重缺陷时：从对应标签拉出 `fix/<主题>` 分支，只合入修复，递增修订号，按上述步骤完整发布，并确认修复也已进入 `main`。

## 代码签名现状

- **Windows**：未配置签名证书。用户首次运行会看到 SmartScreen 提示，发布说明中需要提醒。
- **macOS**：未配置 Apple 开发者证书时，electron-builder 使用 ad-hoc 签名。本机可以运行，其他用户需要在「系统设置 → 隐私与安全性」中放行。目前不随 Release 提供 macOS 与 Linux 的预构建包，用户从源码构建。

## 历史版本

| 版本 | 日期 | API | 发布说明 |
| --- | --- | --- | --- |
| 1.4.0 | 2026-11-12 | v9 | [v1.4.0](releases/v1.4.0.md) |
| 1.3.0 | 2026-11-08 | v8 | [v1.3.0](releases/v1.3.0.md) |
| 1.2.0 | 2026-11-07 | v6 | [v1.2.0](releases/v1.2.0.md) |
| 1.1.0 | 2026-10-30 | v5 | [v1.1.0](releases/v1.1.0.md) |
| 1.0.0 | 2026-10-21 | v5 | [v1.0.0](releases/v1.0.0.md) |

更早的 0.x 版本没有标签，其变更记录保留在 [`agents/AGENTS.md` 第 6 节](../agents/AGENTS.md)。
