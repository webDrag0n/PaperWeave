// PaperWeave 桥接层：Electron 下走 IPC，浏览器预览下走 localStorage + IndexedDB
// 0.8.0 多论文库：全局论文注册表 + 每库 paperIds/links，内容 hash / DOI / 标题冲突检测
import { extractPdfInfoWeb } from './pdfmeta.js';

function uid(p = 'p_') { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ---------------- Web 模式存储 ---------------- */
const LS_KEY = 'paperweave_data_v1';
let webProgressCb = null;
function loadData() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY));
    if (raw && Array.isArray(raw.papers)) {
      // 0.8.0 迁移：旧结构 {papers, links, annotations} → 全局注册表 + 默认库
      if (!Array.isArray(raw.libraries)) {
        raw.libraries = [{ id: 'lib_default', name: 'New Weave', desc: '', icon: '', pinned: false, paperIds: raw.papers.map(p => p.id), links: raw.links || [], createdAt: Date.now() }];
        raw.currentLibraryId = 'lib_default';
        delete raw.links;
      }
      for (const l of raw.libraries) { if (typeof l.desc !== 'string') l.desc = ''; if (typeof l.icon !== 'string') l.icon = ''; if (typeof l.pinned !== 'boolean') l.pinned = false; }
      if (!raw.libraries.some(l => l.id === raw.currentLibraryId)) raw.currentLibraryId = raw.libraries[0].id;
      for (const p of raw.papers) {
        if (typeof p.rating !== 'number') p.rating = 1;
        if (!Array.isArray(p.externalRefs)) p.externalRefs = [];
      }
      return { papers: raw.papers, libraries: raw.libraries, currentLibraryId: raw.currentLibraryId, annotations: raw.annotations || {} };
    }
  } catch (_) {}
  return {
    papers: [],
    libraries: [{ id: 'lib_default', name: 'New Weave', desc: '', icon: '', pinned: false, paperIds: [], links: [], createdAt: Date.now() }],
    currentLibraryId: 'lib_default',
    annotations: {},
  };
}
function saveData(d) { localStorage.setItem(LS_KEY, JSON.stringify(d)); }
function curLib(d) { return d.libraries.find(l => l.id === d.currentLibraryId) || d.libraries[0]; }
function libPapers(d, libId) {
  const lib = d.libraries.find(l => l.id === (libId || d.currentLibraryId)) || curLib(d);
  return lib.paperIds.map(id => d.papers.find(p => p.id === id)).filter(Boolean);
}
const pub = (p) => ({ ...p, refText: undefined });

const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('paperweave-files', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async put(name, buf) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(buf, name);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async get(name) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const r = db.transaction('files').objectStore('files').get(name);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  },
  async del(name) {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(name);
      tx.oncomplete = res;
    });
  },
};

async function sha1Hex(buf) {
  const h = await crypto.subtle.digest('SHA-1', buf.slice ? buf.slice(0) : buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 待确认的导入（冲突弹窗）
const pendingImports = new Map();

async function webImportBuffer(buf, nameHint, opts = {}) {
  const data = loadData();
  const hash = await sha1Hex(buf);
  const fileName = hash.slice(0, 16) + '.pdf';
  // hash 命中全局注册表 → 复用
  const byHash = data.papers.find(p => p.file === fileName);
  if (byHash) {
    const lib = curLib(data);
    const inCurrent = lib.paperIds.includes(byHash.id);
    if (!inCurrent) { lib.paperIds.push(byHash.id); saveData(data); }
    return { paper: pub(byHash), duplicate: inCurrent, reused: !inCurrent };
  }
  // 先存 IndexedDB：pdf.js 提取时会 transfer 并 detach 原 buffer
  await idb.put(fileName, buf);
  let info = {};
  try { info = await extractPdfInfoWeb(buf.slice(0)); } catch (e) { console.warn('extract failed', e); }
  const titleGuess = info.title || (nameHint || '未命名论文').replace(/\.pdf$/i, '');
  // 冲突检测：DOI 相同但内容不同 / 标题高度相似
  const conflicts = [];
  if (info.doi) {
    const norm = String(info.doi).replace(/^arxiv:/i, '').toLowerCase();
    const byDoi = data.papers.find(p => p.doi && String(p.doi).replace(/^arxiv:/i, '').toLowerCase() === norm);
    if (byDoi) conflicts.push({ paper: pub(byDoi), reason: 'doi' });
  }
  if (titleGuess) {
    const { titleSimilarityWeb } = await import('./refs-web.js');
    for (const p of data.papers) {
      if (conflicts.some(c => c.paper.id === p.id)) continue;
      if (titleSimilarityWeb(titleGuess, p.title) >= 0.9) conflicts.push({ paper: pub(p), reason: 'title' });
    }
  }
  if (conflicts.length && (opts.conflictPolicy || 'ask') === 'ask') {
    const token = 'imp_' + Math.random().toString(36).slice(2, 10);
    pendingImports.set(token, { buf, nameHint, rating: opts.rating });
    return { conflict: { token, candidates: conflicts, fileName: nameHint || fileName } };
  }
  if (conflicts.length && (opts.conflictPolicy === 'merge' || (opts.conflictPolicy === 'auto' && conflicts[0].reason === 'doi'))) {
    const lib = curLib(loadData());
    const target = conflicts[0].paper;
    if (!lib.paperIds.includes(target.id)) { lib.paperIds.push(target.id); saveData(loadData()); }
    return { paper: target, duplicate: false, reused: true, merged: true };
  }
  const paper = {
    id: uid(),
    title: titleGuess,
    authors: info.authors || [],
    year: info.year || '',
    doi: info.doi || '',
    abstract: info.abstract || '',
    venue: '',
    tags: [],
    notes: '',
    file: fileName,
    hash,
    pageCount: info.pageCount || 0,
    refText: info.refText || '',
    referencesRaw: [],
    externalRefs: [],
    rating: typeof opts.rating === 'number' ? opts.rating : 1,
    favorite: false,
    addedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const d2 = loadData();
  d2.papers.push(paper);
  curLib(d2).paperIds.push(paper.id);
  saveData(d2);
  // 新论文入库后后台自动解析引用（种子数据与测试场景除外）
  if (!opts.noAutoFetch && typeof setTimeout === 'function') {
    setTimeout(() => { webBridge.fetchRefs(paper.id).catch(() => {}); }, 1500);
  }
  return { paper: pub(paper), duplicate: false };
}

const webBridge = {
  isElectron: false,
  async libInfo() { return { libraryDir: '(浏览器 IndexedDB)', dataDir: 'localStorage', platform: 'web', version: '0.8.0-web' }; },
  async listPapers() { return libPapers(loadData()).map(pub); },
  async getPaper(id) { return loadData().papers.find(p => p.id === id) || null; },
  async updatePaper(id, patch) {
    const d = loadData();
    const p = d.papers.find(x => x.id === id);
    if (!p) return null;
    const allowed = ['title', 'authors', 'year', 'doi', 'abstract', 'tags', 'venue', 'notes', 'refText', 'referencesRaw', 'favorite', 'lastPage', 'rating', 'externalRefs'];
    for (const k of allowed) if (k in patch) p[k] = patch[k];
    if ('rating' in patch) {
      const r = Math.round(Number(patch.rating));
      p.rating = Number.isFinite(r) ? Math.max(0, Math.min(5, r)) : 0;
    }
    p.updatedAt = Date.now();
    saveData(d);
    return { ...p, refText: undefined };
  },
  // 从当前库移除；不再属于任何库时彻底删除（含 IndexedDB 文件）
  async removePaper(id, deleteFile) {
    const d = loadData();
    const lib = curLib(d);
    lib.paperIds = lib.paperIds.filter(x => x !== id);
    lib.links = lib.links.filter(l => l.from !== id && l.to !== id);
    if (!d.libraries.some(l => l.paperIds.includes(id))) {
      const p = d.papers.find(x => x.id === id);
      if (deleteFile !== false && p) await idb.del(p.file);
      d.papers = d.papers.filter(x => x.id !== id);
      delete d.annotations[id];
    }
    saveData(d);
    return true;
  },
  async readPaperBytes(id) {
    const d = loadData();
    const p = d.papers.find(x => x.id === id);
    if (!p) return null;
    const buf = await idb.get(p.file);
    return buf ? new Uint8Array(buf) : null;
  },
  async openPaperFolder() { return false; },
  async importDialog() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.pdf'; input.multiple = true;
      input.onchange = async () => {
        const results = [];
        for (const f of input.files) {
          try { results.push(await webImportBuffer(await f.arrayBuffer(), f.name)); }
          catch (e) { results.push({ error: e.message }); }
        }
        resolve({ canceled: false, results });
      };
      input.oncancel = () => resolve({ canceled: true, results: [] });
      input.click();
    });
  },
  async importPaths() { return { canceled: false, results: [{ error: '浏览器模式不支持路径导入' }] }; },
  async importFiles(files) {
    const results = [];
    for (const f of files) {
      try { results.push(await webImportBuffer(await f.arrayBuffer(), f.name)); }
      catch (e) { results.push({ error: e.message }); }
    }
    return { canceled: false, results };
  },
  async importUrl(url) {
    try {
      let u = url.trim();
      const m = u.match(/^https?:\/\/arxiv\.org\/abs\/([^/?#]+)/i);
      if (m) u = 'https://arxiv.org/pdf/' + m[1];
      const res = await fetch(u);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 5));
      if (new TextDecoder('latin1').decode(head) !== '%PDF-') throw new Error('链接内容不是 PDF');
      return { ok: true, ...(await webImportBuffer(buf, u.split('/').pop() || 'download.pdf')) };
    } catch (e) {
      return { ok: false, error: '下载失败：' + e.message + '（浏览器模式受跨域限制，桌面版无此限制）' };
    }
  },
  async resolveImport(token, action) {
    const pend = pendingImports.get(token);
    if (!pend) return { ok: false, error: '导入会话已过期，请重新导入' };
    pendingImports.delete(token);
    if (action === 'cancel') return { ok: true, canceled: true };
    return { ok: true, ...(await webImportBuffer(pend.buf, pend.nameHint, { rating: pend.rating, conflictPolicy: action === 'merge' ? 'merge' : 'new' })) };
  },
  // ---------- 多论文库 ----------
  async listLibraries() {
    const d = loadData();
    return {
      current: d.currentLibraryId,
      libraries: d.libraries.map(l => ({ id: l.id, name: l.name, desc: l.desc || '', icon: l.icon || '', pinned: !!l.pinned, createdAt: l.createdAt, paperCount: l.paperIds.length, linkCount: l.links.length })),
    };
  },
  async createLibrary(name, desc, icon) {
    const d = loadData();
    const lib = { id: 'lib_' + Math.random().toString(36).slice(2, 10), name: name || 'New Weave', desc: desc || '', icon: (typeof icon === 'string' ? icon : '').trim().slice(0, 8), pinned: false, paperIds: [], links: [], createdAt: Date.now() };
    d.libraries.push(lib);
    d.currentLibraryId = lib.id;
    saveData(d);
    return lib;
  },
  async updateLibrary(id, patch) {
    const d = loadData();
    const lib = d.libraries.find(l => l.id === id);
    if (!lib) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) lib.name = patch.name.trim();
    if (typeof patch.desc === 'string') lib.desc = patch.desc;
    if (typeof patch.icon === 'string') lib.icon = patch.icon.trim().slice(0, 8);
    if (typeof patch.pinned === 'boolean') lib.pinned = patch.pinned;
    saveData(d);
    return lib;
  },
  async reorderLibraries(ids) {
    const d = loadData();
    if (!Array.isArray(ids)) return false;
    const byId = new Map(d.libraries.map(l => [l.id, l]));
    const next = [];
    for (const id of ids) if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); }
    for (const l of byId.values()) next.push(l);
    d.libraries = next;
    saveData(d);
    return true;
  },
  async switchLibrary(id) {
    const d = loadData();
    if (!d.libraries.some(l => l.id === id)) return false;
    d.currentLibraryId = id;
    saveData(d);
    return true;
  },
  async deleteLibrary(id) {
    const d = loadData();
    if (d.libraries.length <= 1) return false;
    d.libraries = d.libraries.filter(l => l.id !== id);
    if (d.currentLibraryId === id) d.currentLibraryId = d.libraries[0].id;
    saveData(d);
    return true;
  },
  async listAnnotations(paperId) { return loadData().annotations[paperId] || []; },
  async saveAnnotations(paperId, anns) {
    const d = loadData();
    d.annotations[paperId] = Array.isArray(anns) ? anns : [];
    saveData(d);
    return d.annotations[paperId];
  },
  async listLinks() { return curLib(loadData()).links; },
  onRefsProgress(cb) { webProgressCb = cb; return () => { webProgressCb = null; }; },
  async addLink(from, to, source) {
    const d = loadData();
    if (from === to) return null;
    const lib = curLib(d);
    const exist = lib.links.find(l => l.from === from && l.to === to);
    if (exist) return exist;
    const link = { id: 'lk_' + Math.random().toString(36).slice(2, 10), from, to, source: source || 'manual', createdAt: Date.now() };
    lib.links.push(link);
    saveData(d);
    return link;
  },
  async removeLink(id) {
    const d = loadData();
    const lib = curLib(d);
    const i = lib.links.findIndex(l => l.id === id);
    if (i < 0) return false;
    lib.links.splice(i, 1);
    saveData(d);
    return true;
  },
  async fetchRefs(paperId) {
    const references = await this.fetchReferences(paperId);
    const citations = await this.fetchCitations(paperId);
    const ok = references.ok || citations.ok;
    const errors = [];
    if (!references.ok) errors.push('参考文献：' + references.error);
    if (!citations.ok) errors.push('被引：' + citations.error);
    return {
      ok,
      error: ok ? undefined : errors.join('；'),
      references,
      citations,
      added: (references.added || 0) + (citations.added || 0),
      refCount: references.total || 0,
      citeCount: citations.citeCount || 0,
      source: citations.source || (references.ok ? 'references-online' : undefined),
    };
  },
  async fetchReferences(paperId) {
    const d = loadData();
    const paper = d.papers.find(p => p.id === paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    try {
      const { fetchReferencesOnlineWeb, matchResolvedToLibraryWeb } = await import('./refs-web.js');
      const lib = libPapers(d);
      const r = await fetchReferencesOnlineWeb(paper, lib, {
        onProgress: (p) => webProgressCb && webProgressCb({ paperId, ...p }),
      });
      if (!r.ok) return r;
      let added = 0;
      for (const l of r.links) {
        const before = curLib(loadData()).links.length;
        await this.addLink(l.from, l.to, l.source || 'references-online');
        if (curLib(loadData()).links.length > before) added++;
      }
      if (r.external) {
        const cur = loadData();
        const pp = cur.papers.find(x => x.id === paperId);
        if (pp) {
          const libList = libPapers(cur).filter(x => x.id !== paperId);
          const ext = r.external.filter(e => !matchResolvedToLibraryWeb(e.title, e.doi, libList));
          pp.externalRefs = (pp.externalRefs || []).filter(x => x.dir !== 'out').concat(ext);
          saveData(cur);
        }
      }
      return { ok: true, total: r.total, resolved: r.resolved, matched: r.links.length, added, unresolved: r.unresolved || [], external: (r.external || []).length };
    } catch (e) {
      return { ok: false, error: '参考文献解析失败：' + e.message };
    }
  },
  async fetchCitations(paperId) {
    const d = loadData();
    const paper = d.papers.find(p => p.id === paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    try {
      const { fetchCitationsOnlineWeb, matchResolvedToLibraryWeb } = await import('./refs-web.js');
      const lib = libPapers(d);
      const r = await fetchCitationsOnlineWeb(paper, lib, {
        onProgress: (p) => webProgressCb && webProgressCb({ paperId, ...p }),
      });
      if (!r.ok) return r;
      let added = 0;
      for (const l of r.links) {
        const before = curLib(loadData()).links.length;
        await this.addLink(l.from, l.to, r.source);
        if (curLib(loadData()).links.length > before) added++;
      }
      if (r.external) {
        const cur = loadData();
        const pp = cur.papers.find(x => x.id === paperId);
        if (pp) {
          const libList = libPapers(cur).filter(x => x.id !== paperId);
          const ext = r.external.filter(e => !matchResolvedToLibraryWeb(e.title, e.doi, libList));
          pp.externalRefs = (pp.externalRefs || []).filter(x => x.dir !== 'in').concat(ext);
          saveData(cur);
        }
      }
      const patch = { referencesRaw: [{ fetchedAt: Date.now(), source: r.source, citeCount: r.citeCount }] };
      if (r.meta) {
        if (!paper.abstract && r.meta.abstract) patch.abstract = r.meta.abstract;
        if (!paper.venue && r.meta.venue) patch.venue = r.meta.venue;
        if (!paper.year && r.meta.year) patch.year = r.meta.year;
        if ((!paper.authors || !paper.authors.length) && r.meta.authors.length) patch.authors = r.meta.authors;
        if (!paper.doi && r.meta.doi) patch.doi = r.meta.doi;
      }
      await this.updatePaper(paperId, patch);
      return { ok: true, source: r.source, added, citeCount: r.citeCount, external: (r.external || []).length };
    } catch (e) {
      return { ok: false, error: '被引抓取失败：' + e.message };
    }
  },
  // 下载单条未入库引用（浏览器模式受跨域限制，arXiv / OA 来源大多可用）
  async downloadRef(paperId, key) {
    const d = loadData();
    const paper = d.papers.find(p => p.id === paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    const ref = (paper.externalRefs || []).find(r => r.key === key);
    if (!ref) return { ok: false, error: '未找到该引用条目' };
    const { findRefPdfUrlWeb } = await import('./refs-web.js');
    const url = await findRefPdfUrlWeb(ref);
    if (!url) return { ok: false, error: '未找到开放获取的 PDF 下载地址' };
    const r = await this.importUrl(url);
    if (!r.ok && !r.paper) return { ok: false, error: r.error || '下载失败' };
    // 冲突：自动复用已有论文
    let newPaper = r.paper;
    if (r.conflict) {
      const rr = await this.resolveImport(r.conflict.token, 'merge');
      if (!rr.ok) return { ok: false, error: rr.error || '合并失败' };
      newPaper = rr.paper;
    }
    // 引用下载的文献默认无评分（重复入库时不覆盖已有评星）
    if (!r.duplicate && !newPaper.merged) await this.updatePaper(newPaper.id, { rating: 0 });
    if (ref.dir === 'out') await this.addLink(paperId, newPaper.id, 'ref-download');
    else await this.addLink(newPaper.id, paperId, 'ref-download');
    const cur = loadData();
    const pp = cur.papers.find(x => x.id === paperId);
    if (pp) { pp.externalRefs = (pp.externalRefs || []).filter(x => x.key !== key); saveData(cur); }
    return { ok: true, paper: newPaper, duplicate: !!(r.duplicate || newPaper.merged) };
  },
  async downloadAllRefs(paperId, dir) {
    const d = loadData();
    const paper = d.papers.find(p => p.id === paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    const want = (paper.externalRefs || []).filter(r => dir === 'both' || !dir || r.dir === dir);
    let downloaded = 0, skipped = 0;
    const failed = [];
    for (let i = 0; i < want.length; i++) {
      webProgressCb && webProgressCb({ paperId, stage: 'download', current: i, total: want.length, currentItem: want[i].title.slice(0, 60), note: '下载中…' });
      try {
        const r = await this.downloadRef(paperId, want[i].key);
        if (r.ok) { if (r.duplicate) skipped++; else downloaded++; }
        else failed.push({ title: want[i].title.slice(0, 80), error: r.error });
      } catch (e) {
        failed.push({ title: want[i].title.slice(0, 80), error: e.message });
      }
      webProgressCb && webProgressCb({ paperId, stage: 'download', current: i + 1, total: want.length, currentItem: want[i].title.slice(0, 60), note: '' });
    }
    return { ok: true, total: want.length, downloaded, skipped, failed };
  },
  async autoMatchRefs(paperId) {
    const d = loadData();
    const paper = d.papers.find(p => p.id === paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    if (!paper.refText) return { ok: false, error: '未能从该 PDF 提取到参考文献段落' };
    const { matchReferencesToLibraryWeb } = await import('./refs-web.js');
    const matches = matchReferencesToLibraryWeb(paper.refText, libPapers(d), paperId);
    let added = 0;
    for (const m of matches) {
      const before = curLib(loadData()).links.length;
      await this.addLink(paperId, m.toId, 'local-match');
      if (curLib(loadData()).links.length > before) added++;
    }
    return { ok: true, matched: matches.length, added };
  },
  // Web 种子示例数据（首次打开预览时载入）
  async seedSamplesIfEmpty() {
    const d = loadData();
    if (d.papers.length || localStorage.getItem('paperweave_seeded')) return false;
    localStorage.setItem('paperweave_seeded', '1');
    try {
      const manifest = await fetch('../assets/samples/index.json').then(r => r.json());
      for (const s of manifest) {
        const buf = await fetch('../assets/samples/' + s.file).then(r => r.arrayBuffer());
        const r = await webImportBuffer(buf, s.file, { noAutoFetch: true });
        if (r.paper && s.title) {
          await this.updatePaper(r.paper.id, { title: s.title, authors: s.authors || [], year: s.year || '', doi: s.doi || '', abstract: s.abstract || '' });
        }
      }
      return true;
    } catch (e) { console.warn('seed failed', e); return false; }
  },
};

// Electron 模式适配：preload 暴露的就是 Promise API
const electronBridge = window.paperweave ? {
  ...window.paperweave,
  importFiles: null, // Electron 拖拽通过 pathForFile + importPaths 处理
  seedSamplesIfEmpty: async () => false,
} : null;

export const bridge = electronBridge || webBridge;
export const isWeb = !electronBridge;
