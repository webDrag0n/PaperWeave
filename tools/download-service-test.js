// 主进程批量下载：并行、去重、哈希竞态、聚合进度与自动建边
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.PAPERWEAVE_AUTOFETCH = '0';
const { createService } = require('../main/service');

const root = path.join(__dirname, '..');
const samples = ['attention.pdf', 'bert.pdf', 'gpt.pdf', 'vit.pdf'].map(name => fs.readFileSync(path.join(root, 'assets', 'samples', name)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeStore(withSource = false) {
  const libraryDir = path.join(root, '.tmp', 'download-service-test');
  fs.rmSync(libraryDir, { recursive: true, force: true });
  fs.mkdirSync(libraryDir, { recursive: true });
  const papers = [];
  const links = [];
  const externalRefs = samples.map((_, i) => ({
    key: 'arxiv:' + ['1706.03762', '1810.04805', '2005.14165', '2010.11929'][i],
    arxivId: ['1706.03762', '1810.04805', '2005.14165', '2010.11929'][i],
    doi: 'arXiv:' + ['1706.03762', '1810.04805', '2005.14165', '2010.11929'][i],
    dir: 'out', title: 'External ' + i, authors: [],
  }));
  if (withSource) papers.push({ id: 'source', title: 'Source paper', doi: '', authors: [], externalRefs, refText: '', file: '', hash: 'source' });
  return {
    papers, links, libraryDir,
    get data() { return { papers, links }; },
    currentLibraryId() { return 'lib'; },
    getPaper(id) { return papers.find(p => p.id === id) || null; },
    findByHash(hash) { return papers.find(p => p.hash === hash) || null; },
    findByDoi(doi) {
      const norm = String(doi || '').replace(/^arxiv:/i, '').toLowerCase();
      return papers.find(p => norm && p.doi && String(p.doi).replace(/^arxiv:/i, '').toLowerCase() === norm) || null;
    },
    paperInLibraries() { return ['lib']; },
    paperFilePath(paper) { return paper && paper.file ? path.join(libraryDir, paper.file) : null; },
    addToLibrary() { return true; },
    addPaper(paper) { papers.push(paper); return paper; },
    updatePaper(id, patch) { const p = this.getPaper(id); if (p) Object.assign(p, patch); return p; },
    addLink(from, to, source) {
      if (from === to) return null;
      const existing = links.find(l => l.from === from && l.to === to);
      if (existing) return existing;
      const link = { id: 'lk_' + links.length, from, to, source };
      links.push(link);
      return link;
    },
    removeExternalRef(id, key) {
      const p = this.getPaper(id);
      if (p) p.externalRefs = p.externalRefs.filter(r => r.key !== key);
    },
    setExternalRefs() {},
    setExternalRefError(id, key, error) {
      const ref = ((this.getPaper(id) || {}).externalRefs || []).find(r => r.key === key);
      if (ref) { ref.downloadError = error; ref.downloadTriedAt = Date.now(); }
      return !!ref;
    },
  };
}

function trackingFetch() {
  const state = { active: 0, maxActive: 0, calls: 0 };
  const fetch = async url => {
    state.calls++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    await sleep(25);
    const id = String(url).match(/1706\.03762|1810\.04805|2005\.14165|2010\.11929|paper-[0-3]/);
    const indexes = { '1706.03762': 0, '1810.04805': 1, '2005.14165': 2, '2010.11929': 3, 'paper-0': 0, 'paper-1': 1, 'paper-2': 2, 'paper-3': 3 };
    const buf = samples[indexes[id ? id[0] : 'paper-0']];
    state.active--;
    return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  };
  return { fetch, state };
}

(async () => {
  // 并发导入相同内容只能生成一条论文记录。
  const raceStore = makeStore();
  const raceService = createService(raceStore, { fetch: trackingFetch().fetch });
  const same = await Promise.all([
    raceService.importOnePdfBuffer(samples[0], 'same.pdf', { conflictPolicy: 'new' }),
    raceService.importOnePdfBuffer(samples[0], 'same.pdf', { conflictPolicy: 'new' }),
  ]);
  assert.equal(raceStore.papers.length, 1);
  assert.ok(same.every(r => r.paper && r.paper.id === raceStore.papers[0].id));
  console.log('PASS 并行导入相同 PDF 的哈希复核');

  const store = makeStore();
  const tracker = trackingFetch();
  const service = createService(store, { fetch: tracker.fetch });
  assert.equal(typeof service.importFromUrls, 'function');
  const progress = [];
  const batch = await service.importFromUrls(
    ['https://papers.test/paper-0', 'https://papers.test/paper-1', 'https://papers.test/paper-2', 'https://papers.test/paper-0'],
    { conflictPolicy: 'new' },
    p => progress.push(p),
  );
  assert.equal(batch.results.length, 4);
  assert.equal(tracker.state.calls, 3, '相同 URL 只下载一次');
  assert.ok(tracker.state.maxActive >= 2, 'URL 导入应真正并行');
  assert.equal(store.papers.length, 3);
  assert.equal(progress.at(-1).current, 3);
  assert.ok(progress.every(p => p.active >= 0 && p.pending >= 0));
  console.log('PASS 多 URL 并行下载、URL 去重与批次进度');

  const refStore = makeStore(true);
  const refTracker = trackingFetch();
  const refService = createService(refStore, { fetch: refTracker.fetch });
  const downloadProgress = [];
  const result = await refService.downloadAllRefs('source', 'out', p => downloadProgress.push(p));
  assert.equal(result.ok, true);
  assert.equal(result.total, 4);
  assert.equal(result.downloaded + result.skipped, 4);
  assert.equal(result.failed.length, 0);
  assert.ok(refTracker.state.maxActive >= 2, '引用全部下载应真正并行');
  assert.equal(refStore.links.length, 4);
  assert.equal(refStore.getPaper('source').externalRefs.length, 0);
  assert.equal(downloadProgress.at(-1).current, 4);
  assert.equal(downloadProgress.at(-1).total, 4);
  console.log('PASS 引用并行下载、自动建边与聚合进度');

  // 年份：链接里的 arXiv 编号优先于 PDF 内文；非 arXiv 论文以引用条目的书目年份为准。
  // 故意让样例扮演别的论文：gpt.pdf（PDF 内年份 2018）当作 arXiv:2407.14207 下载；
  // bert.pdf（首页 “Year 2019”，DOI 为 ACL 的 10.18653/…）当作一篇 2016 年的期刊论文。
  const yearStore = makeStore(true);
  yearStore.getPaper('source').externalRefs = [
    { key: 'arxiv:2407.14207', arxivId: '2407.14207', doi: 'arXiv:2407.14207', dir: 'out', title: 'Longhorn', authors: [], year: '2024' },
    { key: 'doi:10.1/journal', doi: '10.1/journal', dir: 'in', title: 'Journal Paper', authors: ['A. Author'], year: '2016', venue: 'Some Journal' },
    { key: 'doi:10.1/closed', doi: '10.1/closed', dir: 'out', title: 'Closed Access Paper', authors: [], year: '2011' },
  ];
  const yearService = createService(yearStore, {
    fetch: async url => new Response(samples[/2407\.14207/.test(String(url)) ? 2 : 1], { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    findRefPdfUrl: async ref => (ref.arxivId ? 'https://arxiv.org/pdf/' + ref.arxivId : ref.key === 'doi:10.1/journal' ? 'https://papers.test/journal.pdf' : null),
  });
  const byArxiv = await yearService.downloadRef('source', 'arxiv:2407.14207');
  assert.equal(byArxiv.ok, true);
  assert.equal(byArxiv.paper.year, '2024', 'arXiv 链接下载的论文年份取编号年份');
  assert.equal(byArxiv.paper.refText, undefined, 'refText 不出主进程');
  const byJournal = await yearService.downloadRef('source', 'doi:10.1/journal');
  assert.equal(byJournal.ok, true);
  assert.equal(byJournal.paper.year, '2016', '非 arXiv 论文年份取引用条目的书目年份');
  assert.ok(yearStore.links.some(l => l.from === byJournal.paper.id && l.to === 'source'), 'dir=in：新论文引用了本文');
  console.log('PASS 下载入库的年份取 arXiv 编号 / 书目元数据');

  // 没有开放获取 PDF：返回原因与条目 key，原因随条目保存，批量结果可据此重试。
  const closed = await yearService.downloadRef('source', 'doi:10.1/closed');
  assert.equal(closed.ok, false);
  assert.match(closed.error, /未找到开放获取的 PDF/);
  assert.equal(closed.key, 'doi:10.1/closed');
  const closedRef = yearStore.getPaper('source').externalRefs.find(r => r.key === 'doi:10.1/closed');
  assert.match(closedRef.downloadError, /未找到开放获取的 PDF/);
  assert.ok(closedRef.downloadTriedAt > 0);
  const closedBatch = await yearService.downloadAllRefs('source', 'both');
  assert.equal(closedBatch.total, 1);
  assert.deepEqual(closedBatch.failed.map(f => [f.key, f.dir, f.title]), [['doi:10.1/closed', 'out', 'Closed Access Paper']]);
  assert.match(closedBatch.failed[0].error, /未找到开放获取的 PDF/);
  console.log('PASS 无开放获取 PDF 时记录失败原因并返回可重试的条目 key');

  // 已入库的旧记录没有 refText 时，抓取前应从本地 PDF 按需重建。
  // 真实论文 .tmp/2603.01966.pdf 不入库：存在时用它（37 条），否则退回仓库自带样例（3 条），保证全新克隆与 CI 可运行。
  const realPdf = path.join(root, '.tmp', '2603.01966.pdf');
  const legacyCase = fs.existsSync(realPdf)
    ? { pdf: realPdf, doi: 'arXiv:2603.01966', entries: 37 }
    : { pdf: path.join(root, 'assets', 'samples', 'attention.pdf'), doi: 'arXiv:1706.03762', entries: 3 };
  const legacyStore = makeStore(true);
  fs.copyFileSync(legacyCase.pdf, path.join(legacyStore.libraryDir, 'legacy.pdf'));
  Object.assign(legacyStore.getPaper('source'), { file: 'legacy.pdf', refText: '', doi: legacyCase.doi });
  let legacyRefText = null;
  const legacyService = createService(legacyStore, {
    referencesOnline: async paper => {
      legacyRefText = paper.refText;
      return { ok: true, total: 0, resolved: 0, links: [], external: [] };
    },
  });
  await legacyService.fetchReferences('source');
  const { splitReferenceEntries } = require('../main/refs');
  assert.equal(splitReferenceEntries(legacyRefText || '').length, legacyCase.entries);
  console.log('PASS 旧论文抓取前从本地 PDF 重建参考文献');

  const mainSource = fs.readFileSync(path.join(root, 'main', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'preload', 'preload.js'), 'utf8');
  const bridgeSource = fs.readFileSync(path.join(root, 'renderer', 'bridge.js'), 'utf8');
  assert.match(mainSource, /papers:importUrls/);
  assert.match(mainSource, /import:progress/);
  assert.match(preloadSource, /importUrls/);
  assert.match(preloadSource, /onImportProgress/);
  assert.match(bridgeSource, /async importUrls\(urls, operationId\)/);
  assert.match(bridgeSource, /AdaptiveScheduler/);
  console.log('PASS 桌面与浏览器批量导入桥接契约');
})().catch(err => { console.error(err); process.exit(1); });
