// 浏览器插件接口自测：mock store/service 启动 agent-api，验证 import-web / CORS / 鉴权
const { startAgentApi } = require('../main/agent-api');

const papers = [];
const store = {
  data: { papers, links: [], annotations: {} },
  libraryDir: '/tmp/lib',
  currentLibraryId: () => 'lib_default',
  listLibraries: () => [{ id: 'lib_default' }],
  listPapers: () => papers,
  listLinks: () => [],
  getPaper: (id) => papers.find(p => p.id === id) || null,
  updatePaper: (id, patch) => {
    const p = papers.find(x => x.id === id);
    if (!p) return null;
    Object.assign(p, patch);
    return p;
  },
};

const service = {
  async importFromUrl(url, opts) {
    // 模拟：PDF 提取到的标题为空 → 由 import-web 的元数据提示补齐
    const paper = {
      id: 'p_test1', title: '未命名论文', authors: [], year: '', doi: '',
      abstract: '', venue: '', tags: [], rating: 1, file: 'x.pdf', hash: 'h',
    };
    papers.push(paper);
    return { paper: { ...paper }, duplicate: false };
  },
};

(async () => {
  const started = await startAgentApi({
    store, service, token: 'testtoken123', appVersion: 'test',
    onChanged: () => {}, refsProgress: new Map(), onProgress: null,
  });
  if (!started) { console.error('FAIL: server not started'); process.exit(1); }
  const base = `http://127.0.0.1:${started.port}`;
  let failed = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failed++; };

  // 1. ping 无需鉴权 + CORS 头
  let res = await fetch(base + '/api/ping');
  let body = await res.json();
  check('ping ok', body.ok && body.api === 5);
  check('ping CORS header', res.headers.get('access-control-allow-origin') === '*');

  // 2. OPTIONS 预检
  res = await fetch(base + '/api/papers/import-web', { method: 'OPTIONS' });
  check('OPTIONS 204', res.status === 204);
  check('OPTIONS allow-headers 含 token 头', /x-paperweave-token/i.test(res.headers.get('access-control-allow-headers') || ''));

  // 3. 无令牌 → 401
  res = await fetch(base + '/api/papers/import-web', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://arxiv.org/abs/1706.03762' }),
  });
  check('无令牌 401', res.status === 401);

  // 4. 缺 url → 400
  res = await fetch(base + '/api/papers/import-web', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PaperWeave-Token': 'testtoken123' },
    body: JSON.stringify({ title: 'x' }),
  });
  check('缺 url 400', res.status === 400);

  // 5. 正常导入：元数据提示补齐空字段
  res = await fetch(base + '/api/papers/import-web', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PaperWeave-Token': 'testtoken123' },
    body: JSON.stringify({
      url: 'https://arxiv.org/abs/1706.03762',
      pdfUrl: 'https://arxiv.org/pdf/1706.03762',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: '2017', doi: '10.48550/arXiv.1706.03762', abstract: 'The dominant sequence transduction models...', venue: 'arXiv',
    }),
  });
  body = await res.json();
  check('导入 ok', res.status === 200 && body.ok === true);
  check('返回 paper', !!(body.data && body.data.paper && body.data.paper.id === 'p_test1'));
  check('元数据补齐标题', papers[0].title === 'Attention Is All You Need');
  check('元数据补齐作者/年份/DOI/摘要/venue', papers[0].authors.length === 2 && papers[0].year === '2017' && papers[0].doi.startsWith('10.') && papers[0].abstract.length > 10 && papers[0].venue === 'arXiv');
  check('duplicate=false', body.data.duplicate === false);
  check('sourcePage 回传', body.data.sourcePage === 'https://arxiv.org/abs/1706.03762');

  // 6. 下载失败 → 502
  service.importFromUrl = async () => { throw new Error('下载失败：HTTP 404'); };
  res = await fetch(base + '/api/papers/import-web', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PaperWeave-Token': 'testtoken123' },
    body: JSON.stringify({ url: 'https://example.com/none.pdf' }),
  });
  body = await res.json();
  check('下载失败 502', res.status === 502 && body.ok === false);

  started.server.close();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
