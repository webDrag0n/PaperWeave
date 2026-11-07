# 论文内引用悬浮信息浮窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 PDF 正文数字及作者—年份引用上悬浮显示参考文献卡片，支持摘要展开、打开库内论文和直接下载未入库引用。

**Architecture:** 主进程和浏览器桥分别构建本地引用索引，`PdfViewer` 只负责文本标记和命中检测，独立浮窗组件负责交互，下载复用现有 `downloadOneRef`。悬浮不联网、不修改文本 DOM，也不新增遮挡层。

**Tech Stack:** Electron、Node.js CommonJS、浏览器 ES Modules、pdf.js 4.x、原生 DOM／CSS、现有 Node 与 Electron 自测。

## Global Constraints

- 支持 `[1]`、`[1, 3]`、`[1–3]`、`Vaswani et al. (2017)`、`(Vaswani et al., 2017)`。
- 悬浮时不发起网络请求；DOI／arXiv 优先，标题匹配兜底。
- 库内论文显示可展开 Abstract；未入库引用复用现有下载链路。
- 作者—年份多候选全部展示，编号无效时忽略该编号。
- 不修改文字 DOM，不破坏高亮、双栏选区、便利贴及平滑缩放。
- 首版不做 OCR、悬浮联网补摘要、出版商私有链接解析或浮窗内编辑。

---

### Task 1: 主进程本地引用索引

**Files:**
- Create: `main/citation-index.js`
- Create: `tools/citation-index-test.js`
- Modify: `package.json`（新增 `citationtest`）

**Interfaces:**
- Produces: `buildCitationIndex(paper, papers) -> Array<CitationEntry>`。
- `CitationEntry = { id, order, label, number, surname, year, raw, title, kind, paper, external }`；`kind` 为 `library | external | raw`，后两者只存在一个有效负载。

- [ ] **Step 1: 写失败测试**

```js
const assert = require('node:assert/strict');
const { buildCitationIndex } = require('../main/citation-index');
const paper = { id: 'self', refText: '[1] A. Vaswani et al. Attention Is All You Need. NeurIPS 2017. arXiv:1706.03762\n[2] D. Kingma, J. Ba. Adam: A Method for Stochastic Optimization. ICLR 2015. arXiv:1412.6980' };
const library = { id: 'p_attention', title: 'Attention Is All You Need', doi: 'arXiv:1706.03762', abstract: 'Abstract text' };
const external = { key: 'arxiv:1412.6980', dir: 'out', title: 'Adam: A Method for Stochastic Optimization', arxivId: '1412.6980', doi: 'arXiv:1412.6980' };
const index = buildCitationIndex({ ...paper, externalRefs: [external] }, [paper, library]);
assert.equal(index[0].number, 1);
assert.equal(index[0].kind, 'library');
assert.equal(index[0].paper.abstract, 'Abstract text');
assert.equal(index[1].kind, 'external');
assert.equal(index[1].external.key, external.key);
assert.equal(index[0].surname, 'vaswani');
assert.equal(index[0].year, '2017');
```

- [ ] **Step 2: 验证测试失败**

Run: `node tools/citation-index-test.js`
Expected: FAIL，提示找不到 `main/citation-index.js`。

- [ ] **Step 3: 实现索引**

实现保留标签的条目切分、DOI／arXiv 提取、标题覆盖率匹配和作者年份提取。核心返回结构：

```js
function toEntry(raw, label, number, order, target) {
  return {
    id: 'ref_' + order, order, label, number,
    surname: firstSurname(raw), year: firstYear(raw), raw,
    title: target.title || guessRefTitle(raw) || raw.slice(0, 180),
    kind: target.kind, paper: target.paper || null, external: target.external || null,
  };
}
module.exports = { buildCitationIndex, splitLabeledReferences };
```

- [ ] **Step 4: 验证测试通过**

Run: `node tools/citation-index-test.js`
Expected: 所有索引断言 PASS，包括原始条目、无编号和作者年份多候选。

- [ ] **Step 5: 提交**

```bash
git add main/citation-index.js tools/citation-index-test.js package.json
git commit -m "feat: 构建本地参考文献引用索引"
```

### Task 2: IPC 与浏览器桥接

**Files:**
- Modify: `main/main.js`（引用 IPC 区域）
- Modify: `preload/preload.js`（引用 API 区域）
- Modify: `renderer/bridge.js`
- Create: `renderer/citation-index.js`
- Modify: `tools/citation-index-test.js`

**Interfaces:**
- Consumes: `buildCitationIndex(paper, papers)`。
- Produces: `bridge.citationIndex(paperId) -> Promise<CitationEntry[]>`，Electron 走 `refs:citationIndex`，Web 走 `buildCitationIndexWeb`。

- [ ] **Step 1: 增加失败测试**

验证 IPC 源文件注册 `refs:citationIndex`，preload 暴露 `citationIndex`，并验证 Web 构建器与主进程返回相同 `kind` 和编号。

- [ ] **Step 2: 验证失败**

Run: `node tools/citation-index-test.js`
Expected: FAIL，提示桥接方法或 Web 构建器不存在。

- [ ] **Step 3: 实现桥接**

```js
ipcMain.handle('refs:citationIndex', (e, paperId) => {
  const paper = store.getPaper(paperId);
  return paper ? buildCitationIndex(paper, store.data.papers) : [];
});
```

```js
citationIndex: (paperId) => ipcRenderer.invoke('refs:citationIndex', paperId),
```

Web 从 `loadData()` 取当前论文及库内论文，返回相同结构，不向公开论文对象额外暴露 `refText`。

- [ ] **Step 4: 验证通过**

Run: `node tools/citation-index-test.js && node --check main/main.js && node --check preload/preload.js`
Expected: 全部 PASS，语法检查退出码 0。

- [ ] **Step 5: 提交**

```bash
git add main/main.js preload/preload.js renderer/bridge.js renderer/citation-index.js tools/citation-index-test.js
git commit -m "feat: 接入引用索引 IPC 与浏览器桥"
```

### Task 3: PDF 引用标记与悬浮命中

**Files:**
- Modify: `renderer/pdfviewer.js`
- Modify: `renderer/selftest.js`

**Interfaces:**
- Produces: `viewer.setCitationIndex(entries)`、`viewer._buildCitationMarkers(page)`、`viewer._citationAtPoint(clientX, clientY)`。
- Consumes: `opts.onCitationHover(entries, point)`、`opts.onCitationLeave()`。
- 标记结构：`{ start, end, entryIds }`，使用文本节点全局偏移，命中后按 id 返回条目。

- [ ] **Step 1: 写失败的真实 DOM 测试**

在已渲染文本层插入跨两个 span 的 `[1–2]` 与 `Vaswani et al. (2017)`，调用 `setCitationIndex` 和 `_buildCitationMarkers`：

```js
viewer.setCitationIndex(citationFixtures);
viewer._buildCitationMarkers(page);
check('跨片段数字范围引用', page.citationMarkers.some(m => m.entryIds.length === 2));
check('作者年份引用', page.citationMarkers.some(m => m.entryIds.includes('ref_1')));
const hit = viewer._citationAtPoint(rect.left + 2, rect.top + rect.height / 2);
check('悬浮命中返回引用条目', hit && hit.entries.length === 2);
```

- [ ] **Step 2: 验证失败**

Run: `npm run selftest`
Expected: 新增检查 FAIL，现有功能继续运行。

- [ ] **Step 3: 实现文本索引和命中**

使用 TreeWalker 记录 `{ node, start, end }`，在拼接文本上执行数字与作者年份正则；通过 `document.caretRangeFromPoint` 将指针转换为文本偏移。数字解析器展开列表和范围，作者年份解析器保留全部候选。`setCitationIndex` 重建所有已渲染页索引，重绘后重建当前页索引。

- [ ] **Step 4: 验证通过**

Run: `npm run selftest`
Expected: 新增标记检查及全部既有检查 PASS。

- [ ] **Step 5: 提交**

```bash
git add renderer/pdfviewer.js renderer/selftest.js
git commit -m "feat: 定位 PDF 正文引用并支持悬浮命中"
```

### Task 4: 浮窗组件与视觉交互

**Files:**
- Create: `renderer/citation-popup.js`
- Modify: `renderer/index.html`
- Modify: `renderer/styles.css`
- Modify: `renderer/i18n.js`
- Modify: `renderer/app.js`
- Modify: `renderer/selftest.js`

**Interfaces:**
- Produces: `CitationPopup.show(entries, point)`、`hide()`、`setDownloadHandler(fn)`。
- Consumes: `onOpenPaper(paperId)` 与异步 `onDownload(external, button) -> paper|null`。

- [ ] **Step 1: 写失败的浮窗测试**

```js
citationPopup.show([libraryEntry, externalEntry], { clientX: 400, clientY: 300 });
check('浮窗显示两类卡片', !!document.querySelector('.citation-card.library') && !!document.querySelector('.citation-card.external'));
document.querySelector('.citation-abstract-toggle').click();
check('摘要可展开', document.querySelector('details.citation-abstract').open === true);
document.querySelector('.citation-download').click();
await sleep(0);
check('下载成功原地更新', !!document.querySelector('.citation-card.library'));
```

- [ ] **Step 2: 验证失败**

Run: `npm run selftest`
Expected: 浮窗 DOM 不存在，新增检查 FAIL。

- [ ] **Step 3: 实现组件**

浮窗包含卡片容器，库内卡片提供打开按钮和 `<details>` 摘要，外部卡片提供下载按钮。控制器实现 250 ms 延迟、浮窗移入保持、移出宽限、Esc／滚动／缩放关闭、视口边缘位置约束及组合卡片内部滚动。所有文献文本通过 `textContent` 写入。

- [ ] **Step 4: 验证通过**

Run: `npm run selftest`
Expected: 浮窗、摘要、键盘关闭及既有检查 PASS。

- [ ] **Step 5: 提交**

```bash
git add renderer/citation-popup.js renderer/index.html renderer/styles.css renderer/i18n.js renderer/app.js renderer/selftest.js
git commit -m "feat: 添加参考文献悬浮卡片与摘要展开"
```

### Task 5: 下载成功、失败与索引刷新

**Files:**
- Modify: `renderer/app.js`（`downloadOneRef`、`afterRefsChanged`、`openReader`）
- Modify: `renderer/selftest.js`

**Interfaces:**
- Changes: `downloadOneRef(ext, button) -> Promise<{paper, duplicate}|null>`。
- Produces: `refreshCitationIndex()`，在打开论文和引用数据变化后调用 `viewer.setCitationIndex`。

- [ ] **Step 1: 写失败的状态联动测试**

模拟一次下载失败和一次成功：失败时按钮恢复且显示错误；成功后当前外部卡片变为库内卡片、摘要可用，随后重新加载索引仍返回库内状态。

- [ ] **Step 2: 验证失败**

Run: `npm run selftest`
Expected: 当前 `downloadOneRef` 无返回值且浮窗不刷新，新增检查 FAIL。

- [ ] **Step 3: 实现联动**

`downloadOneRef` 保留原提示和按钮行为并返回结果；浮窗调用同一函数。成功后 `afterRefsChanged` 刷新引用面板、图谱和 `viewer` 索引，当前浮窗使用返回论文原地更新。下载中关闭浮窗不取消任务。

- [ ] **Step 4: 验证通过**

Run: `npm run selftest && npm run citationtest`
Expected: 所有状态联动检查 PASS。

- [ ] **Step 5: 提交**

```bash
git add renderer/app.js renderer/selftest.js
git commit -m "feat: 联动引用下载与浮窗状态刷新"
```

### Task 6: 完整验证与发布前检查

**Files:**
- Modify only if a regression requires it: `renderer/pdfviewer.js`、`renderer/citation-popup.js`、`renderer/app.js`
- Verify: `selftest-report.json`

**Interfaces:**
- Consumes: 前五个任务的公开接口，不新增 API。

- [ ] **Step 1: 运行完整检查**

```bash
npm run citationtest
npm run selftest
npm run exttest
npm run apitest
npm run mcptest
```

Expected: 全部退出码 0；Electron 自测包含引用浮窗新场景且原有缩放、高亮、双栏测试全部通过。

- [ ] **Step 2: 检查边界和格式**

```bash
git diff --check
node --input-type=module --check < renderer/pdfviewer.js
node --input-type=module --check < renderer/citation-popup.js
node --input-type=module --check < renderer/app.js
```

Expected: 无空白错误或语法错误。

- [ ] **Step 3: 提交最终修正**

```bash
git add renderer package.json main preload tools
git commit -m "test: 完成引用悬浮浮窗完整回归"
```
