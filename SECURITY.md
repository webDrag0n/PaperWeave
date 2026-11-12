# 安全策略

> **English summary.** Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/webDrag0n/PaperWeave/security/advisories/new) instead of opening a public issue. Only the latest release receives security fixes. PaperWeave's trust boundary is the local user account: the Agent API listens on loopback only and is protected by a token stored on disk. The known limitations of that model are listed below and are not treated as vulnerabilities by themselves.

## 支持的版本

只有最新的发布版本会收到安全修复。请先升级到最新版本再确认问题是否仍然存在。

## 报告漏洞

**请不要通过公开 Issue、PR 或讨论区报告安全问题。**

1. 通过 [GitHub 私密漏洞报告](https://github.com/webDrag0n/PaperWeave/security/advisories/new) 提交。
2. 如果该入口不可用，请开一个不含任何细节的 Issue，仅说明需要一个私下沟通渠道，维护者会与你联系。

报告中请包含：受影响的版本与操作系统、复现步骤或概念验证、你评估的影响范围。

这是一个志愿维护的项目，我们会尽力及时回复。修复发布后，我们乐意在发布说明中致谢报告者，你也可以选择匿名。在修复发布之前，请不要公开漏洞细节。

## 安全模型

PaperWeave 是本地优先的桌面应用，没有服务端，也不上传任何用户数据。它的信任边界是**本机当前用户账户**。

| 组件 | 防护 |
| --- | --- |
| 渲染进程 | 开启 `contextIsolation`、关闭 `nodeIntegration`；仅能调用 preload 暴露的方法；CSP 限制脚本来源与可连接的域名 |
| `app://` 协议 | 路径限制在应用目录内，拒绝目录穿越 |
| Agent HTTP API | 仅监听 `127.0.0.1`；除 `/api/ping` 与 `/api/connector/pair` 外全部校验 `X-PaperWeave-Token` |
| 浏览器插件配对 | 仅接受 `chrome-extension://` 与 `moz-extension://` 来源，普通网页被拒绝 |
| 对外网络请求 | 仅访问 Semantic Scholar、OpenAlex、CrossRef、arXiv，以及用户或 agent 指定的 PDF 下载地址 |

### 已知限制

以下是当前设计的固有限制，已记录在案，单独报告它们不会被视为新漏洞。欢迎提出改进方案。

- 令牌明文保存在数据目录的 `agent-api.json` 中，本机同一用户下的任何进程都可以读取。
- 自 1.3.0 起插件配对自动批准：本机浏览器中安装的任何扩展都可以取得令牌；`Origin` 请求头也可以被本机的非浏览器进程伪造。
- 持有令牌即拥有完整权限，包括让应用读取本机任意路径的 PDF（`import-path`）、从任意 URL 下载 PDF、修改与删除论文数据。
- API 响应带有 `Access-Control-Allow-Origin: *`，跨域访问的唯一防线是令牌。
- 窗口的 `sandbox` 选项为关闭状态。
- Windows 与 macOS 的发行包没有代码签名。请只从本仓库的 [Releases 页面](https://github.com/webDrag0n/PaperWeave/releases)下载。

### 我们关心的问题

- 普通网页在没有令牌的情况下调用 Agent API，或以任何方式取得令牌。
- 恶意 PDF、恶意论文元数据或学术数据源的响应导致代码执行、任意文件读写或界面脚本注入。
- 绕过 `app://` 协议的路径限制读取应用目录之外的文件。
- 数据目录之外的文件被意外写入或删除。

## 给用户的建议

- 把 `agent-api.json` 与其中的令牌当作密码对待，不要分享或提交到公开仓库。
- 不要把 Agent API 端口转发或暴露到本机以外。
- 不需要 agent 与浏览器插件时，可以设置 `PAPERWEAVE_AGENT_API=0` 关闭本地接口。
- 只安装你信任的浏览器扩展。

## 给贡献者的要求

修改以下位置属于安全敏感变更，PR 中必须单独说明威胁影响，并附带覆盖拒绝路径的测试：

- `main/agent-api.js` 中的鉴权、配对、CORS 与请求体大小限制。
- `main/main.js` 中的 `app://` 协议处理器与 `BrowserWindow` 的 `webPreferences`。
- `preload/preload.js` 暴露的接口面。
- `renderer/index.html` 的 CSP。
- `extension/manifest.json` 的权限声明。

任何把用户提供或网络返回的文本写入 DOM 的代码，都必须经过转义（参见 `renderer/app.js` 的 `esc()` 与 `renderer/markdown.js`）。
