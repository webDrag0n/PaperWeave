// 全局论文视图与可配置存储目录回归
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../main/store');

const root = path.join(__dirname, '..', '.tmp', 'store-test-' + process.pid);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

function paper(id, title) {
  return {
    id, title, authors: [], year: '2024', doi: '', abstract: '', venue: '', tags: [], notes: '',
    file: id + '.pdf', hash: id, pageCount: 1, refText: 'secret', referencesRaw: [], externalRefs: [],
    rating: 1, favorite: false, addedAt: Date.now(), updatedAt: Date.now(),
  };
}

try {
  const sourceDir = path.join(root, 'source');
  const store = new Store(sourceDir);
  store.addPaper(paper('a', 'Paper A'));
  store.addPaper(paper('b', 'Paper B'));
  const second = store.createLibrary('Second');
  store.addToLibrary('a', second.id);
  store.addLink('a', 'b', 'test');
  store.addLink('a', 'b', 'test', second.id);
  store.addLink('b', 'a', 'test', second.id);
  fs.writeFileSync(path.join(store.libraryDir, 'a.pdf'), '%PDF-a');
  fs.writeFileSync(path.join(store.libraryDir, 'b.pdf'), '%PDF-b');

  const all = store.listAllPapers();
  assert.equal(all.length, 2);
  assert.deepEqual(all.find(p => p.id === 'a').libraryIds, ['lib_default', second.id]);
  assert.deepEqual(all.find(p => p.id === 'b').libraryIds, ['lib_default']);
  assert.ok(all.every(p => p.refText === undefined));
  const links = store.listAllLinks();
  assert.equal(links.length, 2, '跨库重复关系只显示一次');
  assert.equal(links.find(l => l.from === 'a').libraryLinks.length, 2);
  assert.equal(store.removeLink(links.find(l => l.from === 'a').libraryLinks[1].id, second.id), true);
  assert.equal(store.listAllLinks().find(l => l.from === 'a').libraryLinks.length, 1);
  console.log('PASS 全局论文、所属库与跨库关系合并');

  const copiedDir = path.join(root, 'copied-data');
  store.copyDataTo(copiedDir);
  const copied = new Store(copiedDir);
  assert.equal(copied.listAllPapers().length, 2);
  assert.equal(copied.listLibraries().length, 2);
  assert.throws(() => store.copyDataTo(copiedDir), /请选择空目录/);
  assert.ok(fs.existsSync(path.join(sourceDir, 'papers.json')), '原数据目录保留');
  console.log('PASS 数据目录复制、重启读取与禁止覆盖');

  const pdfDir = path.join(root, 'new-pdfs');
  copied.useLibraryDir(pdfDir);
  assert.equal(copied.libraryDir, pdfDir);
  assert.ok(fs.existsSync(path.join(pdfDir, 'a.pdf')) && fs.existsSync(path.join(pdfDir, 'b.pdf')));
  assert.ok(fs.existsSync(path.join(sourceDir, 'library', 'a.pdf')), '原 PDF 保留');
  assert.equal(copied.paperFilePath(copied.getPaper('a')), path.join(pdfDir, 'a.pdf'));
  const restarted = new Store(copiedDir);
  assert.equal(restarted.libraryDir, pdfDir, '自定义 PDF 目录持久化');
  console.log('PASS PDF 目录复制、立即切换与持久化');

  assert.equal(restarted.purgePaper('a', true), true);
  assert.equal(restarted.getPaper('a'), null);
  assert.equal(restarted.listAllPapers().length, 1);
  assert.ok(restarted.listAllLinks().every(l => l.from !== 'a' && l.to !== 'a'));
  assert.ok(!fs.existsSync(path.join(pdfDir, 'a.pdf')));
  assert.ok(fs.existsSync(path.join(sourceDir, 'library', 'a.pdf')), '全局删除只影响当前存储位置');
  console.log('PASS 全局删除清理所有库、关系、批注与当前 PDF');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
