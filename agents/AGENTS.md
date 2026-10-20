# PaperWeave Agent 接口说明（AGENTS.md）

> 面向 AI Agent / 自动化工具的官方操作接口文档。
> PaperWeave 提供两种 Agent 接入方式：**本地 HTTP API**（通用）与 **MCP Server**（支持 MCP 的宿主零编码接入）。
> 维护约定：**每次功能或接口更新，都必须同步更新本文件**（见文末「版本与变更」）。

- 应用：PaperWeave（跨平台论文阅读器，Windows / macOS / Linux）
- 接口形式：本地 HTTP JSON API（`127.0.0.1`，仅本机回环）+ MCP stdio Server（`paperweave-mcp.js`）
- API 版本：`5`（自 PaperWeave 1.0.0 起；鉴权头 `X-PaperWeave-Token`）

> **0.8.0 多论文库架构**：论文本体全局统一存储（每篇论文唯一 id，PDF 内容哈希命名共享一份文件），
> 论文库（library）只记录「包含哪些论文 id + 库内引用关联」。批注 / 笔记 / 评星随论文全局保存。
> 导入去重：内容 hash 命中 → 直接复用；DOI 相同或标题高度相似但内容不同 → Agent 默认 `auto`（DOI 冲突自动合并复用），
> 可传 `conflictPolicy: merge|new` 显式指定；GUI 导入时弹窗请用户确认。

---

## 0. MCP Server（推荐：支持 MCP 的 Agent 宿主）

`paperweave-mcp.js` 是一个**零依赖单文件 MCP stdio Server**，与 AGENTS.md 放在同一目录
（安装版在 `resources/`，便携版在 exe 同文件夹；源码仓库在 `mcp/`）。
它是第 1~3 节 HTTP API 的薄包装，**PaperWeave 必须处于运行状态**。

### 宿主配置

```jsonc
{
  "mcpServers": {
    "paperweave": {
      "command": "node",
      "args": ["<paperweave-mcp.js 的绝对路径>"]
    }
  }
}
```

连接自发现顺序：`PAPERWEAVE_AGENT_API_JSON` 环境变量 → 脚本同目录 `paperweave-agent-api.json` → 平台数据目录 `paperweave/paperweave-data/agent-api.json`。

### 25 个工具（与 HTTP API 一一对应）

| 工具 | 说明 |
| --- | --- |
| `paperweave_status` | 库状态统计 |
| `paperweave_list_papers` | 列出论文（`query` 可过滤） |
| `paperweave_get_paper` | 论文详情（含笔记与未入库引用） |
| `paperweave_update_paper` | 更新元数据 / 笔记 / 评星 |
| `paperweave_delete_paper` | 删除论文 |
| `paperweave_import_path` | 本机 PDF 批量导入 |
| `paperweave_import_url` | URL 下载导入（arXiv 自动转 PDF） |
| `paperweave_list_annotations` | 读取批注 |
| `paperweave_add_annotation` | 追加高亮 / 便利贴 |
| `paperweave_set_annotations` | 全量替换批注 |
| `paperweave_list_links` | 引用边列表 |
| `paperweave_add_link` | 新增引用边（from 引用 to） |
| `paperweave_delete_link` | 删除引用边 |
| `paperweave_fetch_references` | 抓取"引用"：解析 PDF 参考文献，经 DOI(CrossRef)/arXiv/标题(OpenAlex)在线检索建边；未入库条目存入 `externalRefs` |
| `paperweave_fetch_citations` | 抓取"被引"：Semantic Scholar（限流退避），失败回退 OpenAlex；未入库条目存入 `externalRefs` |
| `paperweave_fetch_refs` | 组合抓取（引用 + 被引） |
| `paperweave_auto_match_refs` | 离线匹配参考文献建边 |
| `paperweave_download_ref` | 下载单条未入库引用（arXiv / OpenAlex OA），入库默认无评分并自动建边 |
| `paperweave_download_all_refs` | 一键下载全部未入库引用（`dir`: out/in/both） |
| `paperweave_get_graph` | 引用图谱快照 |
| `paperweave_list_libraries` | 论文库列表与当前库 |
| `paperweave_create_library` | 新建论文库（默认同时切换） |
| `paperweave_switch_library` | 切换当前论文库 |
| `paperweave_update_library` | 更新论文库名称 / 简介 / 标志图标（emoji）/ 置顶 |
| `paperweave_reorder_libraries` | 按 id 顺序重排论文库 |

参数与返回结构同第 3 节 HTTP API（`tools/call` 的 `arguments` 对应 Body / Query，
返回 `content[0].text` 为 JSON 文本，错误时 `isError: true`）。

### MCP Resources（可直接挂入 Agent 上下文）

| URI | 类型 | 说明 |
| --- | --- | --- |
| `paperweave://papers` | `application/json` | 论文库全部论文列表 |
| `paperweave://papers/{id}` | `application/json` | 单篇论文详情（含笔记） |
| `paperweave://papers/{id}/notes` | `text/markdown` | 单篇论文的 Markdown 笔记 |
| `paperweave://papers/{id}/annotations` | `application/json` | 单篇论文的高亮与便利贴 |
| `paperweave://graph` | `application/json` | 引用图谱快照（nodes + edges） |

### MCP Prompts（一键工作流模板）

| 模板 | 参数 | 工作流 |
| --- | --- | --- |
| `paperweave_read_paper` | `paper`（id 或标题关键词） | 精读论文：拉元数据/批注/笔记 → 结构化阅读报告 → 回写 notes → 报告引用与被引 |
| `paperweave_literature_review` | `topic` | 文献综述：检索库内相关论文 → 分析引用网络 → 产出综述并回写 |
| `paperweave_import_and_link` | `source`（PDF 路径或 URL） | 导入 → 补全元数据 → 建引用边 → 报告与库内论文的关系 |

---

## 1. 连接方式

PaperWeave 启动后自动开启 Agent API（默认端口 `24680`，被占用时自动递增，最多探测 20 个端口）。
如需禁用：设置环境变量 `PAPERWEAVE_AGENT_API=0` 后启动。

### 1.1 查找连接信息

应用启动时会把连接信息写成 JSON 文件（字段：`port`、`token`、`baseUrl`、`pid`、`startedAt`）：

| 位置 | 路径 |
| --- | --- |
| 数据目录（始终存在） | `<用户数据目录>/paperweave/paperweave-data/agent-api.json` |
| 安装/便携目录（可写时） | 与 `PaperWeave.exe`（或 `PaperWeave`）**同文件夹**下的 `paperweave-agent-api.json` |

Windows 数据目录示例：`C:\Users\<用户名>\AppData\Roaming\paperweave\paperweave-data\agent-api.json`
macOS：`~/Library/Application Support/paperweave/paperweave-data/agent-api.json`
Linux：`~/.config/paperweave/paperweave-data/agent-api.json`

本文件（AGENTS.md）同样会出现在 exe 同目录（便携版/安装目录可写时）。

### 1.2 鉴权

除 `GET /api/ping` 外，所有请求必须携带请求头：

```
X-PaperWeave-Token: <agent-api.json 中的 token>
```

令牌在同一论文库生命周期内保持稳定；删除数据目录会重新生成。

### 1.3 约定

- 请求与响应均为 JSON；出错时返回 `{ "ok": false, "error": "..." }` 及相应 HTTP 状态码。
- 所有“写操作”成功后，正在运行的 PaperWeave 界面会自动刷新。
- 时间戳均为 Unix 毫秒。

快速探活（无需令牌）：

```bash
curl http://127.0.0.1:24680/api/ping
# {"ok":true,"name":"PaperWeave","version":"0.8.0","api":4}
```

---

## 2. 数据模型

### Paper（论文）

```jsonc
{
  "id": "p_m3k9x2abcd",            // 唯一 ID，所有接口使用
  "title": "Attention Is All You Need",
  "authors": ["Ashish Vaswani", "..."],
  "year": "2017",
  "venue": "NeurIPS",
  "doi": "10.48550/arXiv.1706.03762",   // 或 "arXiv:1706.03762"
  "abstract": "...",
  "tags": ["transformer"],
  "notes": "# Markdown 笔记",
  "pageCount": 15,
  "file": "3f8a9c2b1d4e5f60.pdf",       // 库内文件名
  "hash": "3f8a9c2b...",                // 内容 SHA-1（用于去重）
  "favorite": false,
  "rating": 1,                           // 重要性评星 0-5（0=未评分；手动导入默认 1，引用下载默认 0）
  "lastPage": 3,                        // 最近阅读到的页码（GUI 阅读位置记忆，可选）
  "externalRefs": [{                     // 抓取到的「未入库」引用条目（可下载入库）
    "key": "arxiv:1412.6980",           // 稳定标识：doi:* / arxiv:* / t:<标题前缀>
    "dir": "out",                       // out=本文引用的 | in=引用本文的
    "title": "Adam: A Method for Stochastic Optimization",
    "authors": ["D. P. Kingma", "J. Ba"],
    "year": "2015", "venue": "ICLR",
    "doi": "arXiv:1412.6980", "arxivId": "1412.6980",
    "citeCount": 100000,                // 仅被引条目可能携带
    "source": "arxiv", "fetchedAt": 1759900000000
  }],
  "addedAt": 1759800000000,
  "updatedAt": 1759800000000
}
```

### Annotation（批注）

```jsonc
{
  "id": "a_kd82jf9s",
  "type": "highlight",              // highlight=文字高亮 | sticky=便利贴
  "page": 3,                        // 页码，从 1 开始
  "color": "#ffe74a",
  "text": "被高亮的原文",            // highlight 专用
  "quads": [{"x":0.1,"y":0.2,"w":0.5,"h":0.02}], // highlight 专用：相对页面宽高的归一化矩形组
  "x": 0.3, "y": 0.4,               // sticky 专用：归一化坐标
  "comment": "我的批注",
  "createdAt": 1759800000000
}
```

### Link（引用关联）

`{ "id": "lk_abc123", "from": "p_aaa", "to": "p_bbb", "source": "manual|agent|semanticscholar|local-match" }`
**语义：`from` 引用了 `to`**（from 是引用方，to 是被引方）。

---

## 3. 接口一览

以下示例假设 `baseUrl=http://127.0.0.1:24680`、`$TOKEN` 为令牌。

### 3.1 状态

```bash
curl -H "X-PaperWeave-Token: $TOKEN" http://127.0.0.1:24680/api/status
# {"ok":true,"data":{"version":"0.1.0","papers":6,"links":9,"annotations":3,"libraryDir":"..."}}
```

### 3.2 论文库（多库管理，0.8.0+）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/libraries` | 论文库列表 + 当前库：`{ current, libraries: [{id,name,desc,pinned,paperCount,linkCount}] }` |
| POST | `/api/libraries` | 新建论文库 `{ "name": "...", "desc": "...", "switch": true }`（默认同时切换为当前库） |
| PATCH | `/api/libraries/{id}` | 更新名称 / 简介 / 置顶：`{ "name", "desc", "pinned" }` |
| POST | `/api/libraries/reorder` | 拖拽排序持久化：`{ "ids": ["lib_a", "lib_b"] }` |
| POST | `/api/libraries/current` | 切换当前库 `{ "id": "lib_xxx" }`；之后所有论文/图谱/导入接口都作用于该库 |
| DELETE | `/api/libraries/{id}` | 删除论文库（至少保留一个；论文本体保留在全局存储中） |

> 首个初始默认论文库在任何语言下都命名为 `New Weave`。

### 3.3 论文

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/papers` | 列出全部论文 |
| GET | `/api/papers/{id}` | 论文详情（含 notes） |
| PATCH | `/api/papers/{id}` | 更新字段：`title / authors / year / venue / doi / abstract / tags / notes / favorite / lastPage / rating / externalRefs` |
| DELETE | `/api/papers/{id}?deleteFile=1` | 删除论文及其批注、关联；`deleteFile=0` 保留库内 PDF |
| GET | `/api/papers/{id}/pdf` | 下载论文 PDF 原始字节（`application/pdf`） |

```bash
# 更新笔记（Markdown）
curl -X PATCH -H "X-PaperWeave-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"notes": "# 复现要点\n- 使用 8 头注意力"}' \
  http://127.0.0.1:24680/api/papers/p_m3k9x2abcd
```

### 3.4 导入

| 方法 | 路径 | Body | 说明 |
| --- | --- | --- | --- |
| POST | `/api/papers/import-path` | `{"path": "..."}` 或 `{"paths": ["..."]}`（可选 `conflictPolicy`） | 导入本机 PDF（批量），自动提取元数据；统一全局存储：内容 hash 命中直接复用；疑似重复（DOI 相同 / 标题高度相似且内容不同）按 `conflictPolicy` 处理：`auto`（默认，DOI 冲突自动合并）、`merge`、`new`；结果中 `reused: true` 表示复用了已有论文 |
| POST | `/api/papers/import-url` | `{"url": "..."}`（可选 `conflictPolicy`） | 下载导入；支持 PDF 直链与 arXiv 摘要页（自动转 PDF）；去重与冲突策略同上 |

```bash
curl -X POST -H "X-PaperWeave-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://arxiv.org/abs/1706.03762"}' \
  http://127.0.0.1:24680/api/papers/import-url
# {"ok":true,"data":{"paper":{...},"duplicate":false}}
```

### 3.5 批注（高亮 / 便利贴）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/papers/{id}/annotations` | 读取该论文全部批注 |
| POST | `/api/papers/{id}/annotations` | 追加批注（单条对象或数组），字段见数据模型；`id` 自动生成 |
| PUT | `/api/papers/{id}/annotations` | 全量替换（数组），可用于修改/删除既有批注 |

```bash
# 在第 2 页放一张便利贴
curl -X POST -H "X-PaperWeave-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"sticky","page":2,"x":0.35,"y":0.5,"comment":"Agent 留下的便签"}' \
  http://127.0.0.1:24680/api/papers/p_m3k9x2abcd
```

### 3.6 引用关联

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/links` | 全部引用边 |
| POST | `/api/links` | 新增 `{ "from": "p_a", "to": "p_b" }`（含义：p_a 引用了 p_b） |
| DELETE | `/api/links/{linkId}` | 删除一条边 |
| POST | `/api/papers/{id}/fetch-references` | 抓取"引用"：优先 Semantic Scholar 结构化参考文献（分页拉取 ≤500 条，含标题/DOI/arXiv/作者/被引数），未收录时回退 PDF 参考文献段落逐条检索（DOI(CrossRef)/arXiv/S2标题匹配/OpenAlex）；未入库条目存入 `externalRefs`（dir=out）；响应含 `source`、`unresolved`（≤20 条）与 `external`（未入库数量） |
| POST | `/api/papers/{id}/fetch-citations` | 抓取"被引"：Semantic Scholar（限流退避），失败自动回退 OpenAlex；未入库被引存入 `externalRefs`（dir=in，按被引数降序 ≤100 条） |
| POST | `/api/papers/{id}/download-ref` | 下载单条未入库引用：Body `{"key": "<externalRefs 条目 key>"}`；经 arXiv / OpenAlex 开放获取解析 PDF，入库（rating=0）并自动建边 |
| POST | `/api/papers/{id}/download-all-refs` | 一键下载全部未入库引用：Body `{"dir": "out|in|both"}`（默认 both）；响应含 `downloaded / skipped / failed` 汇总 |
| GET | `/api/papers/{id}/fetch-progress` | 查询该论文最近一次/进行中的抓取进度 |

**进度对象**（`fetch-progress` 返回值；GUI 内同名事件实时推送）：

```jsonc
{
  "stage": "references",      // references=抓取引用 | citations=抓取被引
  "current": 23,              // 已处理条数
  "total": 88,                // 总条数（0 表示总量未知，如定位阶段）
  "currentItem": "正在解析的参考文献原文/被引论文标题",
  "note": "解析中 | CrossRef (DOI) | arXiv | OpenAlex 检索 | 命中库内标题 | …",
  "at": 1759900000000
}
```

> Semantic Scholar 未认证限流约 1 req/s，应用已内置串行节流与 429 指数退避；
> 如需更高配额，设置环境变量 `PAPERWEAVE_S2_API_KEY=<你的 S2 API Key>` 后启动应用。
> 抓取"引用"（参考文献）不依赖 Semantic Scholar：解析 PDF 参考文献段落后，
> 逐条经 DOI（CrossRef）/ arXiv 编号（arXiv API）/ 标题（OpenAlex 检索）在线确认。| POST | `/api/papers/{id}/fetch-refs` | 组合抓取（引用 + 被引）；响应含 `references` 与 `citations` 两个子结果 |
| POST | `/api/papers/{id}/auto-match` | 离线解析参考文献段落，与库内论文模糊匹配建边 |

### 3.7 图谱快照

```bash
curl -H "X-PaperWeave-Token: $TOKEN" http://127.0.0.1:24680/api/graph
```

返回 `{ nodes: [...论文...], edges: [{ id, from, to, source }] }`。
渲染约定（与 GUI 一致）：选中某节点后——它引用的节点为蓝色、引用它的节点为橙色、互引为紫色、自身为黄色、其余为灰色。

---

## 4. 典型 Agent 工作流

1. **建立论文库**：`import-path` 批量导入 → 对每篇 `auto-match` 建边 → `graph` 查看网络。
2. **阅读助理**：`papers` 检索目标 → `pdf` 取原文自行解析 → 以 `annotations` 回写高亮与便利贴 → `PATCH notes` 写阅读笔记。
3. **文献综述**：`graph` 取引用网络 → 对关键论文 `fetch-refs` 扩充关系 → 生成综述后写回 `notes`。

## 5. 错误码

| 状态码 | 含义 |
| --- | --- |
| 400 | 请求体/参数缺失或非法 |
| 401 | 缺少或错误的令牌 |
| 404 | 论文/关联/接口不存在 |
| 422 | 业务条件不满足（如该 PDF 无参考文献段落） |
| 502 | 外部失败（下载、Semantic Scholar 网络错误） |
| 500 | 服务器内部错误 |

## 6. 版本与变更

| API 版本 | PaperWeave | 变更 |
| --- | --- | --- |
| 1 | 0.1.0 | 首个版本：论文库、导入、批注、笔记、引用关联、图谱 |
| 1（HTTP 不变） | 0.1.0 | 新增 MCP stdio Server 包装（`paperweave-mcp.js`，16 个工具） |
| 1（HTTP 不变） | 0.1.0 | MCP 新增 5 个 Resources 与 3 个 Prompt 模板 |
| 1（HTTP 不变） | 0.1.0 | 在线抓取引用新增 OpenAlex 回退源（Semantic Scholar 不可用时自动切换，响应新增 source 字段） |
| 1 | 0.1.0 | 引用抓取拆分：`fetch-references`（参考文献经 DOI/arXiv/标题在线检索）与 `fetch-citations`（Semantic Scholar 限流退避 + OpenAlex 回退）；`fetch-refs` 保留为组合接口；MCP 同步拆分（18 个工具） |
| 1 | 0.1.0 | 抓取进度：新增 `GET /api/papers/{id}/fetch-progress` 进度查询（GUI 内实时进度条同源事件流） |
| 2 | 0.2.0 | `PATCH /api/papers/{id}` 新增 `lastPage`（阅读位置记忆）；`fetch-references` 响应新增 `unresolved` 字段；参考文献切分支持无编号列表与作者-年份标签（如 `[Vaswani+17]`）并按 DOI/arXiv/标题去重；CrossRef 429/5xx 自动退避重试 |
| 3 | 0.3.0 | 论文新增 `rating`（重要性评星 0-5，手动导入默认 1，引用下载默认 0）与 `externalRefs`（抓取到的未入库引用条目，持久保存）；新增 `download-ref` 与 `download-all-refs` 端点（arXiv / OpenAlex 开放获取下载入库并自动建边）；`fetch-references` / `fetch-citations` 响应新增 `external` 数量；MCP 增至 20 个工具 |
| 3（HTTP 不变） | 0.4.0 | `fetch-references` 召回优化：Semantic Scholar 结构化参考文献成为主源（响应 `source=semanticscholar`，`total` 为 S2 参考文献数），PDF 逐条解析降为回退路径并新增 S2 标题匹配源；进度事件节流（10Hz） |
| 3（HTTP 不变） | 0.5.0 | 论文导入/下载后**自动后台解析引用关系**（串行队列，静默执行；`PAPERWEAVE_AUTOFETCH=0` 可关闭，测试环境默认关闭）；GUI：阅读进度条移除，抓取/下载进度条保留在「引用」页签；3D 图谱标签默认常显、节点缩小一倍、移除箭头与动画 |
| 3（HTTP 不变） | 0.5.1 | GUI：3D 图谱新增按星级过滤节点（全部 / ≥N 星 / 仅 5 星，记住选择），无匹配时显示空态提示 |
| 3（HTTP 不变） | 0.6.0 | GUI：3D 图谱选中节点后出现「高亮跳数」滑条（1–5，默认 2），N 跳内节点与边按跳数分色（1 跳蓝 / 2 跳橙 / 3 跳紫 / 4 跳绿 / 5 跳粉），跳数外节点置灰；Shift+点击多选论文，两两最短关联以轮廓环 + 亮线突出（不覆盖跳数颜色），多选跳数取最近选中节点距离；标题类文字全面支持行内 Markdown（粗体/斜体/代码/删除线，图谱 Canvas 标签同步支持） |
| 3（HTTP 不变） | 0.7.0 | GUI：界面中英双语切换（顶栏 🌐 按钮，`pg-lang` 持久化；静态元素走 `data-i18n` 标注，动态文案走 `t()`/`tf()`，字典位于 `renderer/i18n.js`）；浏览器预览模式 CSP 补充允许 `api.crossref.org` 与 `export.arxiv.org` |
| 4 | 0.8.0 | **多论文库**：新增 `GET/POST /api/libraries`、`POST /api/libraries/current`、`DELETE /api/libraries/{id}`；论文本体全局统一存储（唯一 id 跨库复用），论文库只持有 paperIds 与库内引用边；导入去重升级：hash 命中直接复用，疑似重复（DOI 相同/标题高度相似）按 `conflictPolicy`（auto/merge/new）处理，GUI 弹窗确认；`status` 响应新增 `library`/`libraries`；MCP 增至 23 个工具 |
| 4（HTTP 不变） | 0.9.0 | 论文库新增 `desc`（简介）与 `pinned`（置顶）字段；新增 `PATCH /api/libraries/{id}` 与 `POST /api/libraries/reorder`；GUI：论文库列表改为左侧可展开/缩回的卡片面板（编辑/置顶/拖拽排序/输名删除）；「导入文件」与「链接导入」合并为统一导入弹窗（链接 + 拖文件 + 选文件）；默认初始论文库名称改为 `New Graph`；MCP 增至 25 个工具 |
| 5 | 1.0.0 | **品牌更名 PaperGraph → PaperWeave**：鉴权头改为 `X-PaperWeave-Token`，环境变量 `PAPERWEAVE_S2_API_KEY`，MCP Server 更名 `paperweave-mcp.js`（工具前缀 `paperweave_`），数据目录 `paperweave-data`（首次启动自动从旧 `papergraph-data` 迁移）；默认初始论文库名改为 `New Weave`；GUI：新增相似论文区（文献耦合 × 同被引 Top 5）与「库外发现」面板（经典先驱 / 衍生新作聚合推荐，一键下载入库）；新品牌 Logo 全面实装 |

> **维护者注意**：新增/修改接口或数据字段时，必须同步更新本文件并递增 API 版本号；
> 本文件位于源码仓库 `agents/AGENTS.md`，打包时随应用分发（安装版在 `resources/AGENTS.md`，
> 便携版首次运行时自动复制到 exe 同目录，MCP Server `paperweave-mcp.js` 同样落盘）。
