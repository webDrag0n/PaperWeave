// 本地参考文献索引：编号、作者年份、库内／外部／原始条目匹配
const assert = require('node:assert/strict');
const { buildCitationIndex, splitLabeledReferences } = require('../main/citation-index');

const self = {
  id: 'self',
  title: 'Current paper',
  refText: [
    '[1] A. Vaswani et al. Attention Is All You Need. NeurIPS 2017. arXiv:1706.03762',
    '[2] D. P. Kingma, J. Ba. Adam: A Method for Stochastic Optimization. ICLR 2015. arXiv:1412.6980',
    '[3] A. Unknown. A completely unresolved paper title. Journal 2020.',
  ].join('\n'),
  externalRefs: [{
    key: 'arxiv:1412.6980', dir: 'out', title: 'Adam: A Method for Stochastic Optimization',
    authors: ['D. P. Kingma', 'J. Ba'], year: '2015', doi: 'arXiv:1412.6980', arxivId: '1412.6980',
  }],
};
const attention = {
  id: 'p_attention', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'],
  year: '2017', doi: 'arXiv:1706.03762', abstract: 'Abstract text',
};
const index = buildCitationIndex(self, [self, attention]);
assert.equal(index.length, 3);
assert.equal(index[0].number, 1);
assert.equal(index[0].label, '[1]');
assert.equal(index[0].kind, 'library');
assert.equal(index[0].paper.abstract, 'Abstract text');
assert.equal(index[0].surname, 'vaswani');
assert.equal(index[0].year, '2017');
assert.equal(index[1].kind, 'external');
assert.equal(index[1].external.key, 'arxiv:1412.6980');
assert.equal(index[2].kind, 'raw');
assert.equal(index[2].number, 3);
assert.ok(index[2].raw.includes('completely unresolved'));

const labeled = splitLabeledReferences('1. First reference entry title. 2011.\n2) Second reference entry title. 2012.');
assert.deepEqual(labeled.map(x => x.number), [1, 2]);
assert.deepEqual(labeled.map(x => x.label), ['1.', '2)']);

const unmarked = buildCitationIndex({ id: 'x', refText: 'A. Author. An unmarked but sufficiently long reference title. 2020.', externalRefs: [] }, []);
assert.equal(unmarked[0].number, null);

const ambiguous = buildCitationIndex({
  id: 'x',
  refText: '[1] A. Vaswani et al. Attention Is All You Need. 2017. arXiv:1706.03762\n[2] A. Vaswani et al. Adam: A Method for Stochastic Optimization. 2017. arXiv:1412.6980',
  externalRefs: [],
}, [attention]);
assert.deepEqual(ambiguous.filter(x => x.surname === 'vaswani' && x.year === '2017').map(x => x.number), [1, 2]);

console.log('PASS 本地引用索引：编号、作者年份、库内／外部／原始条目、无编号与多候选');


// Web 与桥接：数据 URL 加载 ES Module，避免项目 CommonJS 配置影响测试。
(async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const webPath = path.join(root, 'renderer', 'citation-index.js');
  const source = fs.readFileSync(webPath, 'utf8');
  const web = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(typeof web.buildCitationIndexWeb, 'function');
  const webIndex = web.buildCitationIndexWeb(self, [self, attention]);
  assert.deepEqual(webIndex.map(x => [x.number, x.kind]), index.map(x => [x.number, x.kind]));
  assert.equal(webIndex[0].paper.abstract, 'Abstract text');

  const mainSource = fs.readFileSync(path.join(root, 'main', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'preload', 'preload.js'), 'utf8');
  const bridgeSource = fs.readFileSync(path.join(root, 'renderer', 'bridge.js'), 'utf8');
  assert.match(mainSource, /refs:citationIndex/);
  assert.match(preloadSource, /citationIndex/);
  assert.match(bridgeSource, /async citationIndex\(paperId\)/);
  console.log('PASS Web 索引与 Electron／浏览器桥接');
})().catch(err => { console.error(err); process.exit(1); });
