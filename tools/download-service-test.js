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

  // 已入库的旧记录没有 refText 时，抓取前应从本地 PDF 按需重建。
  const legacyStore = makeStore(true);
  fs.copyFileSync(path.join(root, '.tmp', '2603.01966.pdf'), path.join(legacyStore.libraryDir, 'legacy.pdf'));
  Object.assign(legacyStore.getPaper('source'), { file: 'legacy.pdf', refText: '', doi: 'arXiv:2603.01966' });
  let legacyRefText = null;
  const legacyService = createService(legacyStore, {
    referencesOnline: async paper => {
      legacyRefText = paper.refText;
      return { ok: true, total: 0, resolved: 0, links: [], external: [] };
    },
  });
  await legacyService.fetchReferences('source');
  const { splitReferenceEntries } = require('../main/refs');
  assert.equal(splitReferenceEntries(legacyRefText || '').length, 37);
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
