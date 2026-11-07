// 引用图谱时间线：纯年份布局的确定性、排序与边界测试
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
  console.log('PASS 时间线年份分组、排序、未知年份、坐标间距与空输入');
})().catch(err => { console.error(err); process.exit(1); });
