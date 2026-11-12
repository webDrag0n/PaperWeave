// 发表年份推断回归：arXiv 编号优先，其次首页明确标记，再次受约束的 PDF 创建日期；宁缺毋错
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const year = require('../main/pubyear');
const { extractPdfInfo } = require('../main/importer');
const { Store } = require('../main/store');

const NOW = Date.UTC(2026, 10, 10);

(async () => {
  // ---- arXiv 编号 → 首次提交年份 ----
  assert.equal(year.arxivIdYear('2407.14207', NOW), '2024');
  assert.equal(year.arxivIdYear('1410.5401v2', NOW), '2014');
  assert.equal(year.arxivIdYear('1907.01470', NOW), '2019');
  assert.equal(year.arxivIdYear('2010.06891', NOW), '2020');
  assert.equal(year.arxivIdYear('hep-th/9901001', NOW), '1999');
  assert.equal(year.arxivIdYear('cs.CL/0703042', NOW), '2007');
  assert.equal(year.arxivIdYear('2413.00001', NOW), '', '月份非法');
  assert.equal(year.arxivIdYear('9912.00001', NOW), '', '晚于当前年份');
  assert.equal(year.arxivIdYear('', NOW), '');
  assert.equal(year.arxivIdOf('arXiv:1706.03762v7'), '1706.03762');
  assert.equal(year.arxivIdOf('10.48550/arXiv.1706.03762'), '1706.03762');
  assert.equal(year.arxivIdOf('https://arxiv.org/abs/2407.14207v1'), '2407.14207');
  assert.equal(year.arxivIdOf('https://arxiv.org/pdf/hep-th/9901001'), 'hep-th/9901001');
  assert.equal(year.arxivIdOf('10.1038/nature14539'), '');
  console.log('PASS arXiv 编号解析与年份换算');

  // ---- 用户反馈的四种误判：正文里先出现的数字不得当成年份 ----
  const infer = (o) => year.inferPublicationYear({ now: NOW, ...o });
  assert.equal(infer({ firstPageLines: ['Neural Turing Machines', 'arXiv:1410.5401v2 [cs.NE] 10 Dec 2014', 'the stored program computer (Von Neumann, 1945)'] }), '2014');
  assert.equal(infer({ firstPageLines: ['Augmenting Self-attention with Persistent Memory', 'arXiv:1907.01470v1 [cs.LG] 2 Jul 2019'] }), '2019');
  assert.equal(infer({ firstPageLines: ['Memformer', 'back-propagation (Rumelhart et al., 1988)', 'arXiv:2010.06891v2 [cs.CL] 7 Apr 2022'] }), '2020', '以编号年份为准，而非后续版本的盖章日期');
  assert.equal(infer({ firstPageLines: ['Longhorn: State Space Models are Amortized Online Learners', 'with a 2048 context length', 'arXiv:2407.14207v1 [cs.LG] 19 Jul 2024'] }), '2024');
  assert.equal(infer({ firstPageLines: ['A paper', 'trained on WMT 2014 with a 2048 context length'], creationDate: 'D:20240719000000Z' }), '2024', '无明确标记时用创建日期，不取正文数字');
  assert.equal(infer({ firstPageLines: ['A paper', 'trained on WMT 2014 with a 2048 context length'] }), '', '没有可靠来源时留空');
  console.log('PASS 正文数字不再被误判为年份');

  // ---- 首页明确标记 ----
  assert.equal(infer({ firstPageLines: ['Deep Residual Learning', '(c) 2016 IEEE'] }), '2016');
  assert.equal(infer({ firstPageLines: ['Title', 'Copyright \u00a9 2019 Association for Computational Linguistics'] }), '2019');
  assert.equal(infer({ firstPageLines: ['Published as a conference paper at ICLR 2021', 'An Image is Worth 16x16 Words'] }), '2021');
  assert.equal(infer({ firstPageLines: ['Title', '31st Conference on Neural Information Processing Systems (NIPS 2017), Long Beach, CA, USA.'] }), '2017');
  assert.equal(infer({ firstPageLines: ['Title', 'Proceedings of the 37th International Conference on Machine Learning, Online, PMLR 119, 2020.'] }), '2020');
  assert.equal(infer({ firstPageLines: ['Title', 'Received: 3 March 2015 / Accepted: 9 June 2015'] }), '2015');
  assert.equal(infer({ firstPageLines: ['Title', '(c) 2016 IEEE'], ownDoi: '10.48550/arXiv.1512.03385' }), '2015', '论文自身的 arXiv DOI 优先于版权年份');
  assert.equal(infer({ firstPageLines: ['Title', 'Year 2019 doi:10.18653/v1/N19-1423'] }), '2019', '显式 Year 标签');
  assert.equal(infer({ firstPageLines: ['Title', 'This idea has been widely accepted since 1990 and advances in 2012 confirmed it'] }), '', '正文里的 accepted / advances in 不是出版标记');
  assert.equal(infer({ firstPageLines: ['Title', '(c) 2099 Nobody'] }), '', '未来年份无效');
  console.log('PASS 版权 / 会议 / 收稿日期标记');

  // ---- PDF 创建日期：必须与参考文献年份相容 ----
  const refs2019 = '[1] A. Author. First. NeurIPS 2017.\n[2] B. Author. Second. ICLR 2019.\n[3] C. Author. Third. ICML 2019.';
  assert.equal(infer({ firstPageLines: ['Title'], creationDate: 'D:20200115093000+08\'00\'', refText: refs2019 }), '2020');
  assert.equal(infer({ firstPageLines: ['Title'], creationDate: 'D:20030115093000Z', refText: '[1] A. Old. One. 1984.\n[2] B. Old. Two. 1986.\n[3] C. Old. Three. 1986.' }), '', '多年后扫描的旧论文留空');
  assert.equal(infer({ firstPageLines: ['Title'], creationDate: 'D:19990101000000Z', refText: refs2019 }), '', '创建日期早于参考文献留空');
  assert.equal(infer({ firstPageLines: ['Title'], creationDate: 'D:20990101000000Z' }), '');
  assert.equal(year.latestReferenceYear('[1] X. arXiv:1907.01470, 2018.\n[2] Y. pages 2019-2031, 2018.\n[3] Z. 2017.', NOW), '2018', 'arXiv 编号与孤立的离群值不计入');
  console.log('PASS 创建日期受参考文献年份约束');

  // ---- 已入库年份的纠正规则 ----
  assert.equal(year.reconcileYear('2048', 'arXiv:2407.14207', NOW), '2024');
  assert.equal(year.reconcileYear('1945', 'arXiv:1410.5401', NOW), '2014');
  assert.equal(year.reconcileYear('1907', '10.48550/arXiv.1907.01470', NOW), '2019');
  assert.equal(year.reconcileYear('1988', 'arXiv:2010.06891', NOW), '2020');
  assert.equal(year.reconcileYear('', 'arXiv:2010.06891', NOW), '2020');
  assert.equal(year.reconcileYear('2019', 'arXiv:1810.04805', NOW), '2019', '正式发表年份略晚于预印本时保留');
  assert.equal(year.reconcileYear('2048', '10.1000/xyz', NOW), '', '非 arXiv 的未来年份清空');
  assert.equal(year.reconcileYear('1998', '10.1000/xyz', NOW), '1998', '非 arXiv 的合理年份不动');
  assert.equal(year.reconcileYear('1998', '', NOW), '1998');
  console.log('PASS 已入库年份纠正规则');

  // ---- 存量数据一次性修复 ----
  const dir = path.join(__dirname, '..', '.tmp', 'pubyear-store-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ libraries: [{ id: 'lib_default', name: 'New Weave' }], currentLibraryId: 'lib_default' }));
    fs.writeFileSync(path.join(dir, 'papers.json'), JSON.stringify({ papers: [
      { id: 'a', title: 'A', year: '2048', doi: 'arXiv:2407.14207' },
      { id: 'b', title: 'B', year: '1945', doi: 'arXiv:1410.5401' },
      { id: 'c', title: 'C', year: '2019', doi: 'arXiv:1810.04805' },
      { id: 'd', title: 'D', year: '1998', doi: '10.1000/xyz' },
    ] }));
    let store = new Store(dir);
    assert.deepEqual(store.papers.map(p => p.year), ['2024', '2014', '2019', '1998']);
    assert.equal(store.meta.yearRepair, 1);
    // 修复只执行一次：用户之后手工改的年份不再被覆盖
    store.updatePaper('a', { year: '2030' });
    store = new Store(dir);
    assert.equal(store.getPaper('a').year, '2030');
    console.log('PASS 存量论文年份一次性修复且不覆盖后续手工修改');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 真实 PDF（未入库样本，存在时才跑） ----
  const samples = path.join(__dirname, '..', '.tmp', 'year-samples');
  const expected = { '2407.14207': '2024', '1410.5401': '2014', '1907.01470': '2019', '2010.06891': '2020', '1706.03762': '2017', '2006.11239': '2020' };
  const present = Object.keys(expected).filter(id => fs.existsSync(path.join(samples, id + '.pdf')));
  if (present.length) {
    for (const id of present) {
      const info = await extractPdfInfo(fs.readFileSync(path.join(samples, id + '.pdf')));
      assert.equal(info.year, expected[id], 'arXiv:' + id + ' 年份应为 ' + expected[id] + '，实际 ' + info.year);
      assert.equal(info.doi, 'arXiv:' + id, 'arXiv:' + id + ' 的 DOI 应取自首页盖章');
    }
    console.log('PASS 真实 arXiv PDF 年份识别（' + present.length + ' 篇）');
  } else {
    console.log('SKIP 未找到 .tmp/year-samples/*.pdf，跳过真实论文回归');
  }

  // ---- 网页版镜像与主进程逐例一致 ----
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pubyear.js'), 'utf8');
  const web = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const cases = [
    { firstPageLines: ['T', 'arXiv:1410.5401v2 [cs.NE] 10 Dec 2014', '(Von Neumann, 1945)'] },
    { firstPageLines: ['T', '(c) 2016 IEEE'] },
    { firstPageLines: ['T', 'Published as a conference paper at ICLR 2021'] },
    { firstPageLines: ['T', 'Year 2019 doi:10.18653/v1/N19-1423'] },
    { firstPageLines: ['T', 'Received: 3 March 2015 / Accepted: 9 June 2015'] },
    { firstPageLines: ['T'], creationDate: 'D:20200115093000Z', refText: refs2019 },
    { firstPageLines: ['T'], creationDate: 'D:20030115093000Z', refText: '[1] A. 1984.\n[2] B. 1986.\n[3] C. 1986.' },
    { firstPageLines: ['T', 'a 2048 context length'] },
    { firstPageLines: ['T'], ownDoi: 'arXiv:hep-th/9901001' },
  ];
  for (const c of cases) assert.equal(web.inferPublicationYear({ now: NOW, ...c }), infer(c), JSON.stringify(c));
  for (const [y, doi] of [['2048', 'arXiv:2407.14207'], ['2019', 'arXiv:1810.04805'], ['2048', '10.1000/x'], ['', '']]) {
    assert.equal(web.reconcileYear(y, doi, NOW), year.reconcileYear(y, doi, NOW));
  }
  const pdfMeta = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pdfmeta.js'), 'utf8');
  assert.match(pdfMeta, /inferPublicationYear/);
  assert.doesNotMatch(pdfMeta, /headText\.match\(\/\\b\(19\|20\)/, '网页版不得再取正文首个四位数字');
  console.log('PASS 网页版镜像与主进程年份推断一致');
})().catch(err => { console.error(err); process.exit(1); });
