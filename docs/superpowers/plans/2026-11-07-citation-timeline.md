# Citation Timeline View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在现有 Three.js 引用图谱中加入按发表年份从左到右排布的横向时间线，并保留网络布局及全部节点交互。

**Architecture:** 新增无 Three.js 依赖的纯布局模块，输出节点坐标与年份列元数据。`GraphView` 根据 `network | timeline` 选择现有力导向布局或年份布局，并复用同一组网格、连线、标签、射线拾取和详情回调；`app.js` 只负责模式状态和按钮事件。

**Tech Stack:** Electron、浏览器 ES Modules、Three.js、Node.js `assert/strict`、现有 Electron selftest。

## Global Constraints

- 不新增第三方依赖，不更换 Three.js 渲染栈。
- 默认视图为 `network`；合法模式仅为 `network` 和 `timeline`。
- 时间线节点位于 `z = 0`，年份等距排列，未知年份位于最右侧。
- 不修改论文数据；保留星级筛选、搜索定位、选中、多选、详情和双击打开。
- 不执行 `git commit`，除非用户另行明确要求。

---

### Task 1: 确定性年份布局

**Files:**
- Create: `renderer/graph-layout.js`
- Create: `tools/graph-layout-test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `computeTimelineLayout(papers, options?)`。
- Input: `papers: Array<{id: string, year?: string|number}>`；`options.columnGap` 默认 `72`，`options.rowGap` 默认 `18`。
- Output: `{positions: Map<string, {x:number,y:number,z:0}>, columns: Array<{key:string,year:number|null,label:string,x:number}>, yearLabelY:number, minY:number, maxY:number}`。

- [x] **Step 1: 写失败测试**

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const file = path.join(__dirname, '..', 'renderer', 'graph-layout.js');
  const source = fs.readFileSync(file, 'utf8');
  const { computeTimelineLayout } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const papers = [
    { id: 'new', year: 2020 },
    { id: 'old-a', year: '2017' },
    { id: 'unknown', year: '' },
    { id: 'old-b', year: '2017' },
    { id: 'invalid', year: 'n/a' },
  ];
  const result = computeTimelineLayout(papers);
  assert.deepEqual(result.columns.map(c => c.label), ['2017', '2020', '未知']);
  assert.deepEqual([...result.positions.keys()], papers.map(p => p.id));
  assert.equal(result.positions.get('new').x, result.columns[1].x);
  assert.equal(result.positions.get('old-a').x, result.positions.get('old-b').x);
  assert.equal(result.positions.get('old-a').y - result.positions.get('old-b').y, 18);
  assert.ok(result.positions.get('unknown').x > result.positions.get('new').x);
  assert.ok([...result.positions.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.z === 0));
  assert.deepEqual(computeTimelineLayout(papers), result);
  assert.equal(computeTimelineLayout([{ id: 'one', year: '2024' }]).positions.get('one').y, 0);
  assert.deepEqual(computeTimelineLayout([]), { positions: new Map(), columns: [], yearLabelY: 14, minY: 0, maxY: 0 });
  console.log('PASS 时间线年份分组、排序、未知年份、坐标间距与空输入');
})().catch(err => { console.error(err); process.exit(1); });
```

- [x] **Step 2: 验证测试先失败**

Run: `node tools/graph-layout-test.js`
Expected: FAIL，`ENOENT` 或模块不存在，因为布局模块尚未创建。

- [x] **Step 3: 实现纯布局模块**

```js
const DEFAULTS = { columnGap: 72, rowGap: 18 };

function publicationYear(value) {
  const match = String(value ?? '').trim().match(/^(?:19|20)\d{2}$/);
  return match ? Number(match[0]) : null;
}

export function computeTimelineLayout(papers, options = {}) {
  const columnGap = Number.isFinite(options.columnGap) && options.columnGap > 0 ? options.columnGap : DEFAULTS.columnGap;
  const rowGap = Number.isFinite(options.rowGap) && options.rowGap > 0 ? options.rowGap : DEFAULTS.rowGap;
  const groups = new Map();
  for (const paper of papers) {
    const year = publicationYear(paper.year);
    const key = year === null ? 'unknown' : String(year);
    if (!groups.has(key)) groups.set(key, { key, year, papers: [] });
    groups.get(key).papers.push(paper);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.year === null) return 1;
    if (b.year === null) return -1;
    return a.year - b.year;
  });
  const positions = new Map();
  const columns = ordered.map((group, index) => {
    const x = (index - (ordered.length - 1) / 2) * columnGap;
    group.papers.forEach((paper, row) => {
      positions.set(paper.id, { x, y: ((group.papers.length - 1) / 2 - row) * rowGap, z: 0 });
    });
    return { key: group.key, year: group.year, label: group.year === null ? '未知' : String(group.year), x };
  });
  const maxRows = Math.max(0, ...ordered.map(group => group.papers.length));
  const maxY = maxRows > 1 ? (maxRows - 1) * rowGap / 2 : 0;
  return { positions, columns, yearLabelY: maxY + 14, minY: -maxY, maxY };
}
```

- [x] **Step 4: 添加测试命令并通过**

在 `package.json` 的 `scripts` 中加入：

```json
"graphtest": "node tools/graph-layout-test.js"
```

Run: `npm run graphtest`
Expected: 输出 `PASS 时间线年份分组、排序、未知年份、坐标间距与空输入`，退出码 0。

---

### Task 2: GraphView 时间线渲染与模式切换

**Files:**
- Modify: `renderer/graph.js`
- Test: `renderer/selftest.js`（Task 3 接入完整场景）

**Interfaces:**
- Consumes: `computeTimelineLayout()`。
- Produces: `graph.setViewMode(mode)`、`graph.viewMode`、`graph.timelineGroup`、`graph.timelineColumns`。

- [x] **Step 1: 在现有 selftest 的图谱段添加失败断言**

```js
document.querySelector('[data-graph-mode="timeline"]').click();
await sleep(300);
check('时间线模式已激活', graph.viewMode === 'timeline');
check('时间线节点共面且按年份升序', graph.nodes.every(n => n.pos.z === 0) && graph.timelineColumns.every((c, i, a) => i === 0 || a[i - 1].year <= c.year));
check('同年节点纵向避让', graph.nodes.every((a, i) => graph.nodes.every((b, j) => i === j || a.paper.year !== b.paper.year || Math.abs(a.pos.y - b.pos.y) >= 18)));
check('年份刻度与参考线已创建', graph.timelineColumns.length > 0 && graph.timelineGroup.children.length >= graph.timelineColumns.length * 2);
document.querySelector('[data-graph-mode="network"]').click();
await sleep(300);
check('切回网络模式', graph.viewMode === 'network' && graph.timelineGroup.children.length === 0);
```

Run: `npm run selftest`
Expected: FAIL，模式按钮尚不存在，测试无法完成时间线路径。

- [x] **Step 2: 接入布局并添加时间线组**

在 `graph.js` 导入布局，构造器设置 `this.viewMode = opts.viewMode === 'timeline' ? 'timeline' : 'network'`，并在 `_build()` 中创建 `timelineGroup`，加入场景。清空数据和销毁时同步释放时间线对象。

```js
import { computeTimelineLayout } from './graph-layout.js';

// constructor
this.viewMode = opts.viewMode === 'timeline' ? 'timeline' : 'network';
this.timelineColumns = [];

// _build
this.timelineGroup = new THREE.Group();
this.scene.add(this.timelineGroup);
```

- [x] **Step 3: 实现布局分派、参考线与边更新**

```js
setViewMode(mode) {
  const next = mode === 'timeline' ? 'timeline' : 'network';
  if (next === this.viewMode) return;
  this.viewMode = next;
  if (!this._built) return;
  this._layout();
  this._fitCamera(false);
  this._recolor();
}

_clearTimeline() {
  this.timelineColumns = [];
  if (!this.timelineGroup) return;
  while (this.timelineGroup.children.length) {
    const child = this.timelineGroup.children.pop();
    disposeObj(child);
    this.timelineGroup.remove(child);
  }
}

_updateEdges() {
  for (const edge of this.edges) edge.line.geometry.setFromPoints([edge.a.pos, edge.b.pos]);
}

_layoutTimeline() {
  const layout = computeTimelineLayout(this.nodes.map(node => node.paper));
  this.timelineColumns = layout.columns;
  for (const node of this.nodes) {
    const pos = layout.positions.get(node.id);
    if (pos) node.pos.set(pos.x, pos.y, pos.z);
    node.vel.set(0, 0, 0);
  }
  this._clearTimeline();
  this.timelineColumns = layout.columns;
  for (const column of layout.columns) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(column.x, layout.minY - 10, -2),
        new THREE.Vector3(column.x, layout.yearLabelY - 4, -2),
      ]),
      new THREE.LineBasicMaterial({ color: this.T.edgeBase, transparent: true, opacity: 0.22 }),
    );
    const label = makeLabelSprite(column.label, this.T);
    label.position.set(column.x, layout.yearLabelY, 0);
    this.timelineGroup.add(line, label);
  }
  this._updateEdges();
}

_layout() {
  if (!this.nodes.length) { this._clearTimeline(); return; }
  if (this.viewMode === 'timeline') { this._layoutTimeline(); return; }
  this._clearTimeline();
  // 保留现有力导向迭代，结束时调用 this._updateEdges()。
}
```

在 `_recolor()` 中，将时间线未选中边的基础透明度设为 `0.3`，网络模式保持 `0.55`；高亮边仍为 `0.95`。主题切换时调用 `_layoutTimeline()` 重建刻度颜色，但不改变模式。

- [x] **Step 4: 运行布局测试和语法检查**

Run: `npm run graphtest && node --input-type=module --check < renderer/graph.js`
Expected: 布局测试 PASS；语法检查无输出且退出码 0。

---

### Task 3: 工具栏、状态、响应式与端到端验证

**Files:**
- Modify: `renderer/index.html:110-124`
- Modify: `renderer/styles.css:350-395`
- Modify: `renderer/app.js:13-28,482-517,1558-1577,1837-1852`
- Modify: `renderer/selftest.js:464-577`

**Interfaces:**
- Consumes: `GraphView.setViewMode(mode)`。
- Produces: `state.graphViewMode`、`[data-graph-mode]` 按钮、`pg-graph-view-mode` 本地偏好。

- [x] **Step 1: 添加模式切换控件与样式**

在 `.graph-filter` 前加入：

```html
<div class="graph-mode-switch" role="group" aria-label="图谱布局">
  <button class="active" type="button" data-graph-mode="network" aria-pressed="true" data-i18n="网络">网络</button>
  <button type="button" data-graph-mode="timeline" aria-pressed="false" data-i18n="时间线">时间线</button>
</div>
```

```css
.graph-mode-switch {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 12;
  display: flex; padding: 3px; gap: 3px; border: 1px solid var(--line); border-radius: 9px;
  background: color-mix(in srgb, var(--bg2) 86%, transparent); backdrop-filter: blur(6px);
}
.graph-mode-switch button {
  border: 0; border-radius: 6px; padding: 5px 12px; cursor: pointer;
  background: transparent; color: var(--text-dim); font-size: 12px;
}
.graph-mode-switch button.active { background: var(--accent); color: #0d1420; }
::root[data-theme="light"] .graph-mode-switch button.active { color: #fff; }
@media (max-width: 760px) {
  .graph-mode-switch { left: auto; right: 14px; transform: none; }
  .graph-filter { top: 58px; left: 14px; }
  #graphLegend { top: 100px; }
}
```

- [x] **Step 2: 绑定状态并保持筛选与选中**

```js
// state
const savedGraphMode = localStorage.getItem('pg-graph-view-mode');
// state 对象字段：graphViewMode: savedGraphMode === 'timeline' ? 'timeline' : 'network',

function syncGraphModeButtons() {
  document.querySelectorAll('[data-graph-mode]').forEach(button => {
    const active = button.dataset.graphMode === state.graphViewMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

// ensureGraph 的 opts
viewMode: state.graphViewMode,

// bindEvents
document.querySelectorAll('[data-graph-mode]').forEach(button => {
  button.addEventListener('click', () => {
    state.graphViewMode = button.dataset.graphMode === 'timeline' ? 'timeline' : 'network';
    localStorage.setItem('pg-graph-view-mode', state.graphViewMode);
    syncGraphModeButtons();
    if (graph) graph.setViewMode(state.graphViewMode);
  });
});
```

`showView('graph')` 和语言切换时调用 `syncGraphModeButtons()`。模式切换只调用 `setViewMode()`，不调用 `setData()`，因此筛选与选中集合保持不变。

- [x] **Step 3: 执行完整自测并检查产物**

Run: `npm run citationtest && npm run graphtest && npm run selftest`
Expected: 引用测试和布局测试全部 PASS；selftest 报告 `ok: true`，新增时间线断言全部通过，既有图谱断言无回归。

- [x] **Step 4: 浏览器预览验证**

Run: `npm run dev -- --host 127.0.0.1 --port 7100`
Expected: 页面可打开；时间线从左到右显示年份，未知年份在最右，同年节点不重叠，连线跟随节点，切回网络后恢复三维布局。验证结束后停止临时开发服务器。

- [x] **Step 5: 最终检查**

Run: `git diff --check && git status --short`
Expected: 无空白错误；变更仅包含本功能源码、测试与设计/计划文档。
