# PaperWeave Connector（Chrome / Edge 浏览器插件）

在浏览 **arXiv 摘要页 / arXiv PDF / 论文 PDF 直链 / 出版商页面** 时，点击工具栏插件图标即可把论文一键下载入库到 PaperWeave 桌面端，类似 Zotero Connector。

## 工作原理

```
浏览器页面 ──content-script──▶ 提取元数据（citation_* 元标签 / arXiv 页面结构）
     │ popup 立即显示加载阶段和进度
     ▼
background service worker ──自动发现并静默连接 127.0.0.1:24680–24700
     │ 自动 POST /api/connector/pair，本地保存令牌
     ▼
GET /api/libraries → 用户选择目标论文库
POST /api/papers/import-web（携带令牌和 libraryId）
```

桌面端接口（`main/agent-api.js`，API v8 起）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/ping` | 探活（无需令牌），返回应用版本与 API 版本 |
| `POST /api/connector/pair` | 插件配对：仅扩展来源可请求，自动返回令牌，无需桌面端确认 |
| `GET /api/status` | 库统计（需令牌），用于连接测试 |
| `GET /api/libraries` | 获取当前论文库及全部论文库列表 |
| `POST /api/papers/import-web` | 插件入库：接受 `url` / `pdfUrl`、元数据提示和可选 `libraryId`，元数据只补空白字段 |

## 安装（未上架商店，走开发者模式）

1. 打开 PaperWeave 桌面端 → 顶栏 **「🧩 插件」** → **「📂 打开插件目录」**。
2. 浏览器地址栏打开 `chrome://extensions`（Edge 用 `edge://extensions`），开启右上角 **「开发人员模式」**。
3. 点击 **「加载解压缩的扩展」**，选择刚打开的 `extension` 文件夹。
4. 点击工具栏的 PaperWeave 图标即可。插件会自动检测并连接本地桌面端，**无需点击连接按钮、无需桌面端同意，也无需 API Key**。

授权凭据保存在插件本地。高级设置页仅用于旧版本迁移或手动排查。

## 使用

- **点图标保存**：弹窗立即显示加载动画和当前阶段，包括自动连接、获取论文库和识别论文。加载完成后，在“保存到论文库”下拉菜单中选择目标库，再点击「保存到 PaperWeave」。
- **记住目标库**：插件会记住上次选择的论文库；默认使用桌面端当前库。
- **保存进度**：保存时先显示“正在确认连接”，随后显示“正在下载并保存”。
- **右键保存**：页面空白处右键 → 「保存页面论文到 PaperWeave」；在 PDF 链接上右键 → 「保存链接论文到 PaperWeave」。保存结果以图标角标 ✓ / ✕ 反馈，并自动完成连接。
- 已入库的论文（内容 hash / DOI 相同）会自动复用，不会重复下载。

## 文件结构

```
extension/
├── manifest.json        MV3 清单
├── background.js        自动发现、静默连接、目标库导入、Agent API 通信
├── content-script.js    页面论文元数据提取（响应式，平时零开销）
├── popup.html / .js     即时进度、论文库选择和论文保存面板
├── options.html / .js   高级连接设置（通常无需使用）
├── styles.css           与桌面端统一的深色学术风样式
└── icons/               插件图标（由 assets/icon.png 生成）
```

## 常见问题

- **提示「未发现桌面端」**：确认 PaperWeave 正在运行，然后点击重试。插件会自动扫描 `24680–24700` 端口，无需手动查看端口号。
- **提示「连接已失效」**：点击重试，插件会重新自动连接，无需手动复制令牌。
- **出版商页面识别不出 PDF**：说明该页没有开放获取的 PDF 或缺少 `citation_pdf_url` 元数据，可手动下载 PDF 后拖进桌面端。
