# PaperWeave Connector（Chrome / Edge 浏览器插件）

在浏览 **arXiv 摘要页 / arXiv PDF / 论文 PDF 直链 / 出版商页面** 时，点击工具栏插件图标即可把论文一键下载入库到 PaperWeave 桌面端，类似 Zotero Connector。

## 工作原理

```
浏览器页面 ──content-script──▶ 提取元数据（citation_* 元标签 / arXiv 页面结构）
     │ popup「保存到 PaperWeave」
     ▼
background service worker ──自动发现 127.0.0.1:24680–24700──▶ PaperWeave 桌面端
     │ 首次 POST /api/connector/pair，桌面端一次性授权
     ▼
POST /api/papers/import-web（携带本地保存的 X-PaperWeave-Token）
```

桌面端接口（`main/agent-api.js`，API v7 起）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/ping` | 探活（无需令牌），返回应用版本与 API 版本 |
| `POST /api/connector/pair` | 插件配对：仅扩展来源可请求，桌面端明确批准后才返回令牌 |
| `GET /api/status` | 库统计（需令牌），用于连接测试 |
| `POST /api/papers/import-web` | 插件入库：接受 `url` / `pdfUrl` + 元数据提示；服务端下载 PDF 入库，元数据只补空白字段 |

## 安装（未上架商店，走开发者模式）

1. 打开 PaperWeave 桌面端 → 顶栏 **「🧩 插件」** → **「📂 打开插件目录」**。
2. 浏览器地址栏打开 `chrome://extensions`（Edge 用 `edge://extensions`），开启右上角 **「开发人员模式」**。
3. 点击 **「加载解压缩的扩展」**，选择刚打开的 `extension` 文件夹。
4. 点击工具栏的 PaperWeave 图标。插件会自动检测本地桌面端，点击 **「连接 PaperWeave」**，在桌面端弹窗中选择 **「允许连接」**。

授权凭据保存在插件本地，之后无需填写 API Key。高级设置页仅用于旧版本迁移或手动排查。

## 使用

- **点图标保存**：在 arXiv 摘要页、PDF 页面或带 `citation_pdf_url` 元数据的出版商页面，点击插件图标 → 「📥 保存到 PaperWeave」。
- **右键保存**：页面空白处右键 → 「保存页面论文到 PaperWeave」；在 PDF 链接上右键 → 「保存链接论文到 PaperWeave」。保存结果以图标角标 ✓ / ✕ 反馈。
- 已入库的论文（内容 hash / DOI 相同）会自动复用，不会重复下载。

## 文件结构

```
extension/
├── manifest.json        MV3 清单
├── background.js        自动发现、配对授权、Agent API 通信、右键菜单
├── content-script.js    页面论文元数据提取（响应式，平时零开销）
├── popup.html / .js     自动连接与论文保存面板
├── options.html / .js   高级连接设置（通常无需使用）
├── styles.css           与桌面端统一的深色学术风样式
└── icons/               插件图标（由 assets/icon.png 生成）
```

## 常见问题

- **提示「未发现桌面端」**：确认 PaperWeave 正在运行，然后重新点击连接。插件会自动扫描 `24680–24700` 端口，无需手动查看端口号。
- **提示「连接已失效」**：重新点击连接并在桌面端授权即可，无需手动复制令牌。
- **不想允许连接**：在桌面端弹窗选择拒绝，插件不会获得任何访问凭据。
- **出版商页面识别不出 PDF**：说明该页没有开放获取的 PDF 或缺少 `citation_pdf_url` 元数据，可手动下载 PDF 后拖进桌面端。
