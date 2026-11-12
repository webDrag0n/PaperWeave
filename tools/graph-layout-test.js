// 引用图谱时间线：纯年份布局的确定性、排序与边界测试
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const file = path.join(__dirname, '..', 'renderer', 'graph-layout.js');
  const source = fs.readFileSync(file, 'utf8');
  const { computeTimelineLayout, collectLineageIds, collectPathsBetween } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const papers = [
    { id: 'new', year: 2020 },
    { id: 'old-a', year: '2017' },
    { id: 'unknown', year: '' },
    { id: 'old-b', year: '2017' },
    { id: 'invalid', year: 'n/a' },
  ];
  const result = computeTimelineLayout(papers);
  assert.deepEqual(result.columns.map(c => c.label), ['2017', '2020', '未知']);
  assert.deepEqual([...result.positions.keys()], ['old-a', 'old-b', 'new', 'unknown', 'invalid']);
  assert.equal(result.positions.get('new').x, result.columns[1].x);
  assert.equal(result.positions.get('old-a').x, result.positions.get('old-b').x);
  assert.equal(result.positions.get('old-a').y - result.positions.get('old-b').y, 18);
  assert.ok(result.positions.get('unknown').x > result.positions.get('new').x);
  assert.ok([...result.positions.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.z === 0));
  assert.deepEqual(computeTimelineLayout(papers), result);
  assert.equal(computeTimelineLayout([{ id: 'one', year: '2024' }]).positions.get('one').y, 0);
  assert.equal(computeTimelineLayout([{ id: 'u', year: null }], { unknownLabel: 'Unknown' }).columns[0].label, 'Unknown');
  assert.deepEqual(computeTimelineLayout([]), { positions: new Map(), columns: [], yearLabelY: 14, minY: 0, maxY: 0 });

  const links = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'e', to: 'c' },
    { from: 'x', to: 'y' },
  ];
  const lineage = collectLineageIds(links, 'c');
  assert.deepEqual([...lineage.upstream].sort(), ['d']);
  assert.deepEqual([...lineage.downstream].sort(), ['a', 'b', 'e']);
  assert.deepEqual([...lineage.ids].sort(), ['a', 'b', 'c', 'd', 'e']);
  const cyclic = collectLineageIds([...links, { from: 'd', to: 'b' }], 'c');
  assert.equal(cyclic.ids.size, 5);
  assert.ok(!cyclic.ids.has('x') && !cyclic.ids.has('y'));
  assert.deepEqual([...collectLineageIds([], 'missing').ids], ['missing']);
  console.log('PASS 时间线布局与递归上下游谱系计算');

  // ---- 多选：两篇论文之间的全部路径 ----
  // new 经两条不同的引用链到达 old（new→m1→old、new→m2→m3→old），另有一条直接引用；side 只是旁支。
  const diamond = [
    { from: 'new', to: 'm1' },    // 0
    { from: 'm1', to: 'old' },    // 1
    { from: 'new', to: 'm2' },    // 2
    { from: 'm2', to: 'm3' },     // 3
    { from: 'm3', to: 'old' },    // 4
    { from: 'new', to: 'old' },   // 5
    { from: 'side', to: 'm1' },   // 6：不在 new ⇝ old 的任何链上
    { from: 'old', to: 'root' },  // 7：old 之后的上游，不在两者之间
  ];
  const all = collectPathsBetween(diamond, ['new', 'old']);
  assert.deepEqual([...all.edges].sort(), [0, 1, 2, 3, 4, 5], '应包含全部引用链，而不只是最短的一条');
  assert.deepEqual([...all.nodes].sort(), ['m1', 'm2', 'm3', 'new', 'old']);
  assert.equal(all.pairs[0].kind, 'chain');
  // 选择顺序无关
  assert.deepEqual([...collectPathsBetween(diamond, ['old', 'new']).edges].sort(), [0, 1, 2, 3, 4, 5]);
  // 两篇论文之间没有引用链（只共同引用 / 被同一篇引用）：退回全部最短无向路径
  const siblings = [
    { from: 'a', to: 'p' }, { from: 'b', to: 'p' },   // 0 1：共同引用 p
    { from: 'a', to: 'q' }, { from: 'b', to: 'q' },   // 2 3：共同引用 q（另一条等长路径）
    { from: 'a', to: 'x' }, { from: 'x', to: 'y' }, { from: 'b', to: 'y' }, // 4 5 6：更长的路径，不计入
  ];
  const sib = collectPathsBetween(siblings, ['a', 'b']);
  assert.deepEqual([...sib.edges].sort(), [0, 1, 2, 3]);
  assert.deepEqual([...sib.nodes].sort(), ['a', 'b', 'p', 'q']);
  assert.equal(sib.pairs[0].kind, 'shortest');
  // 不连通：没有路径，也不抛错
  const apart = collectPathsBetween([{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }], ['a', 'c']);
  assert.equal(apart.edges.size, 0);
  assert.equal(apart.nodes.size, 0);
  assert.equal(apart.pairs[0].kind, 'none');
  // 三选：两两路径取并集
  const three = collectPathsBetween(diamond, ['new', 'old', 'root']);
  assert.ok([0, 1, 2, 3, 4, 5, 7].every(i => three.edges.has(i)) && !three.edges.has(6));
  assert.equal(three.pairs.length, 3);
  // 引用成环与单选都必须正常结束
  const loop = collectPathsBetween([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }], ['a', 'c']);
  assert.deepEqual([...loop.edges].sort(), [0, 1, 2]);
  assert.equal(collectPathsBetween(diamond, ['new']).edges.size, 0);
  assert.equal(collectPathsBetween(diamond, ['new', 'missing']).edges.size, 0);
  console.log('PASS 多选时两篇论文之间的全部路径（引用链 / 最短无向路径 / 不连通）');

  const graphSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'graph.js'), 'utf8');
  assert.match(graphSource, /collectPathsBetween/, '时间线视图应使用全部路径');
  console.log('PASS 图谱视图接入全部路径计算');
})().catch(err => { console.error(err); process.exit(1); });
