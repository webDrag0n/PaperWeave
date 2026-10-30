# PaperWeave Connector（Chrome / Edge 浏览器插件）

在浏览 **arXiv 摘要页 / arXiv PDF / 论文 PDF 直链 / 出版商页面** 时，点击工具栏插件图标即可把论文一键下载入库到 PaperWeave 桌面端，类似 Zotero Connector。

## 工作原理

```
浏览器页面 ──content-script──▶ 提取元数据（citation_* 元标签 / arXiv 页面结构）
     │ popup「保存到 PaperWeave」
     ▼
background service worker ──POST /api/papers/import-web──▶ PaperWeave 桌面端
（携带 X-PaperWeave-Token 鉴权）                                下载 PDF → 解析 → 入库 → 自动解析引用
```

桌面端接口（`main/agent-api.js`，API v5 起）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/ping` | 探活（无需令牌），返回应用版本与 API 版本 |
| `GET /api/status` | 库统计（需令牌），用于连接测试 |
| `POST /api/papers/import-web` | 插件入库：接受 `url` / `pdfUrl` + `title` / `authors` / `year` / `doi` / `abstract` / `venue` 元数据提示；服务端下载 PDF 入库，元数据只补空白字段 |

## 安装（未上架商店，走开发者模式）

1. 打开 PaperWeave 桌面端 → 顶栏 **「🧩 插件」** → **「📂 打开插件目录」**，记下弹窗里的 **服务地址** 与 **访问令牌**。
2. 浏览器地址栏打开 `chrome://extensions`（Edge 用 `edge://extensions`），开启右上角 **「开发人员模式」**。
3. 点击 **「加载解压缩的扩展」**，选择刚打开的 `extension` 文件夹。
4. 点击工具栏的 PaperWeave 图标 → **⚙ 设置**，粘贴服务地址与访问令牌，点 **「测试连接」** 确认变绿。

## 使用

- **点图标保存**：在 arXiv 摘要页（`arxiv.org/abs/...`）、PDF 页面（`arxiv.org/pdf/...` 或任意 `.pdf` 直链）、带 `citation_pdf_url` 元数据的出版商页面，点击插件图标 → 「📥 保存到 PaperWeave」。
- **右键保存**：页面空白处右键 → 「保存页面论文到 PaperWeave」；在 PDF 链接上右键 → 「保存链接论文到 PaperWeave」。保存结果以图标角标 ✓ / ✕ 反馈。
- 已入库的论文（内容 hash / DOI 相同）会自动复用，不会重复下载。

## 文件结构

```
extension/
├── manifest.json        MV3 清单
├── background.js        与本地 Agent API 通信、右键菜单、角标反馈
├── content-script.js    页面论文元数据提取（响应式，平时零开销）
├── popup.html / .js     点击图标后的保存面板
├── options.html / .js   服务地址 + 令牌设置页
├── styles.css           与桌面端统一的深色学术风样式
└── icons/               插件图标（由 assets/icon.png 生成）
```

## 常见问题

- **提示「无法连接」**：确认 PaperWeave 桌面端正在运行；端口被占用时桌面端会自动递增（24680→24681…），以「🧩 插件」弹窗里显示的地址为准。
- **提示「令牌无效」**：令牌随桌面端首次启动生成并固定，重新粘贴一次即可；不要在多台机器间混用。
- **出版商页面识别不出 PDF**：说明该页没有开放获取的 PDF 或缺少 `citation_pdf_url` 元数据，可手动下载 PDF 后拖进桌面端。
