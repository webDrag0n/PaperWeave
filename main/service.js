// PaperWeave 业务服务层：供 IPC 与 Agent HTTP API 共用
const path = require('path');
const fs = require('fs');
const { net } = require('electron');
const { extractPdfInfo, bufferIntoLibrary } = require('./importer');
const { fetchReferencesOnline, fetchCitationsOnline, matchReferencesToLibrary, extractArxivId, fetchArxivMeta, findRefPdfUrl } = require('./refs');

function uid() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function createService(store, opts = {}) {
  const progressFor = typeof opts.progressFor === 'function' ? opts.progressFor : () => undefined;
  // 待确认的导入（GUI 弹窗确认走这里）：token → { buf, nameHint, info, candidates }
  const pendingImports = new Map();
  const PENDING_TTL = 10 * 60 * 1000;
  function stashPending(entry) {
    const token = 'imp_' + Math.random().toString(36).slice(2, 10);
    pendingImports.set(token, { ...entry, at: Date.now() });
    // 惰性清理
    for (const [k, v] of pendingImports) if (Date.now() - v.at > PENDING_TTL) pendingImports.delete(k);
    return token;
  }

  // 冲突检测：DOI 相同但内容 hash 不同（不同版本），或标题高度相似（≥0.9）
  function findImportConflicts(info, hash) {
    const conflicts = [];
    if (info.doi) {
      const byDoi = store.findByDoi(info.doi);
      if (byDoi && byDoi.hash !== hash) conflicts.push({ paper: pub(byDoi), reason: 'doi' });
    }
    if (info.title) {
      const { titleSimilarity } = require('./refs');
      for (const p of store.papers) {
        if (p.hash === hash || conflicts.some(c => c.paper.id === p.id)) continue;
        if (titleSimilarity(info.title, p.title) >= 0.9) {
          conflicts.push({ paper: pub(p), reason: 'title' });
        }
      }
    }
    return conflicts;
  }

  const pub = (p) => ({ ...p, refText: undefined });
  // 下载/导入后自动引用解析：后台串行队列，静默补全引用关系与未入库条目
  // 可用 PAPERWEAVE_AUTOFETCH=0 关闭（测试环境默认关闭，避免网络不确定性）
  const autoFetchEnabled = process.env.PAPERWEAVE_AUTOFETCH !== '0' && process.env.PAPERWEAVE_SELFTEST !== '1';
  const autoQueue = [];
  let autoRunning = false;
  async function autoFetchWorker() {
    if (autoRunning) return;
    autoRunning = true;
    while (autoQueue.length) {
      const { paperId, onProgress } = autoQueue.shift();
      try { await fetchRefs(paperId, onProgress); } catch (_) { /* 静默：网络不可用时跳过 */ }
    }
    autoRunning = false;
  }
  function scheduleAutoFetch(paperId, onProgress) {
    if (!autoFetchEnabled || !paperId) return;
    if (autoQueue.some(q => q.paperId === paperId)) return;
    autoQueue.push({ paperId, onProgress });
    setTimeout(autoFetchWorker, 1200); // 稍作延迟，让导入流程先完成
  }
  // opts.rating：手动导入/下载默认 1 星；引用文献批量下载默认 0（未评分）
  // opts.conflictPolicy：'ask'(GUI 默认，弹窗确认) | 'auto'(Agent 默认：DOI 冲突自动复用) | 'merge' | 'new'
  async function importOnePdfBuffer(buf, nameHint, opts = {}) {
    const { fileName, hash } = bufferIntoLibrary(store.libraryDir, buf, nameHint);
    // 1) 内容 hash 命中全局注册表 → 复用同一论文 id，不重复存储
    const byHash = store.findByHash(hash);
    if (byHash) {
      const inCurrent = store.paperInLibraries(byHash.id).includes(store.currentLibraryId());
      if (!inCurrent) store.addToLibrary(byHash.id);
      return { paper: pub(byHash), duplicate: inCurrent, reused: !inCurrent };
    }
    // 2) 提取元数据
    let info = { title: path.basename(nameHint || '未命名论文', '.pdf'), authors: [], year: '', doi: '', abstract: '', refText: '', pageCount: 0 };
    try {
      const extracted = await extractPdfInfo(buf);
      info = { ...info, ...Object.fromEntries(Object.entries(extracted).filter(([, v]) => v && !(Array.isArray(v) && !v.length))) };
      if (!info.title) info.title = path.basename(nameHint || '未命名论文', '.pdf');
    } catch (e) {
      console.error('extract failed:', e.message);
    }
    // 3) 疑似重复冲突：DOI 相同（不同版本）或标题高度相似
    const conflicts = findImportConflicts(info, hash);
    if (conflicts.length) {
      const policy = opts.conflictPolicy || 'ask';
      if (policy === 'ask') {
        const token = stashPending({ buf, nameHint, info, hash, rating: opts.rating });
        return { conflict: { token, candidates: conflicts, fileName: nameHint || fileName } };
      }
      if (policy === 'merge' || (policy === 'auto' && conflicts[0].reason === 'doi')) {
        const target = store.getPaper(conflicts[0].paper.id);
        store.addToLibrary(target.id);
        return { paper: pub(target), duplicate: false, reused: true, merged: true };
      }
      // policy 'new' / auto 但仅标题相似 → 作为新论文
    }
    // 4) 新论文：入全局注册表 + 加入当前库
    const paper = {
      id: uid(),
      title: info.title || '未命名论文',
      authors: info.authors || [],
      year: info.year || '',
      doi: info.doi || '',
      abstract: info.abstract || '',
      venue: info.venue || '',
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
    store.addPaper(paper);
    // 新论文入库后立即后台自动解析引用关系（静默，失败不影响导入）
    scheduleAutoFetch(paper.id, progressFor(paper.id));
    return { paper: pub(paper), duplicate: false };
  }

  // GUI 冲突弹窗确认后的处理：action = 'merge'（用已有论文）| 'new'（作为新论文）
  async function resolveImport(token, action) {
    const pend = pendingImports.get(token);
    if (!pend) return { ok: false, error: '导入会话已过期，请重新导入' };
    pendingImports.delete(token);
    if (action === 'cancel') return { ok: true, canceled: true };
    return {
      ok: true,
      ...(await importOnePdfBuffer(pend.buf, pend.nameHint, {
        rating: pend.rating,
        conflictPolicy: action === 'merge' ? 'merge' : 'new',
      })),
    };
  }

  async function importFromPaths(paths, opts = {}) {
    const results = [];
    for (const p of paths || []) {
      try {
        if (!fs.existsSync(p)) { results.push({ error: '文件不存在', path: p }); continue; }
        if (!/\.pdf$/i.test(p)) { results.push({ error: '不是 PDF 文件', path: p }); continue; }
        const buffer = fs.readFileSync(p);
        results.push(await importOnePdfBuffer(buffer, path.basename(p), opts));
      } catch (e) {
        results.push({ error: e.message, path: p });
      }
    }
    return results;
  }

  function normalizePaperUrl(url) {
    try {
      const u = new URL(url);
      if (/arxiv\.org$/.test(u.hostname) && u.pathname.startsWith('/abs/')) {
        return 'https://arxiv.org/pdf/' + u.pathname.slice(5).replace(/\/$/, '');
      }
      return url;
    } catch (_) { return url; }
  }

  async function importFromUrl(url, opts = {}) {
    const finalUrl = normalizePaperUrl(url);
    const res = await net.fetch(finalUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 PaperWeave/0.3' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    const looksPdf = buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-';
    if (!ct.includes('pdf') && !looksPdf) {
      throw new Error('该链接不是 PDF 文件（内容类型：' + (ct || '未知') + '）。支持 PDF 直链或 arXiv 摘要页链接。');
    }
    const name = decodeURIComponent(path.basename(new URL(finalUrl).pathname)) || 'download.pdf';
    const result = await importOnePdfBuffer(buf, name.endsWith('.pdf') ? name : name + '.pdf', opts);
    // arXiv 导入补全：PDF 正文通常不含摘要，经 arXiv API 补回（不覆盖已提取字段）
    try {
      const paper = result && result.paper;
      if (paper && (!paper.abstract || !(paper.authors || []).length)) {
        const urlM = String(url).match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
        const axId = extractArxivId(paper.doi) || (urlM ? urlM[1] : null);
        if (axId) {
          const meta = await fetchArxivMeta(axId);
          if (meta) {
            const patch = {};
            if (!paper.abstract && meta.abstract) patch.abstract = meta.abstract;
            if (!(paper.authors || []).length && meta.authors.length) patch.authors = meta.authors;
            if (!paper.year && meta.year) patch.year = meta.year;
            if (Object.keys(patch).length) store.updatePaper(paper.id, patch);
          }
        }
      }
    } catch (e) {
      console.error('arXiv 元数据补全失败：', e.message);
    }
    return result;
  }

  // 抓取"引用"（参考文献）：解析 PDF 参考文献段落，经 DOI/arXiv/标题网络检索匹配进库；
  // 识别成功但不在库内的条目保存为 externalRefs（dir=out），供界面展示与下载入库
  async function fetchReferences(paperId, onProgress) {
    const paper = store.getPaper(paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    try {
      const r = await fetchReferencesOnline(paper, store.data.papers, { onProgress });
      if (!r.ok) return r;
      let added = 0;
      for (const l of r.links) {
        const before = store.data.links.length;
        store.addLink(l.from, l.to, l.source || 'references-online');
        if (store.data.links.length > before) added++;
      }
      if (r.external) store.setExternalRefs(paperId, 'out', filterExternalsAgainstLibrary(r.external, paperId));
      return { ok: true, total: r.total, resolved: r.resolved, matched: r.links.length, added, unresolved: r.unresolved || [], external: (r.external || []).length };
    } catch (e) {
      return { ok: false, error: '参考文献解析失败：' + e.message };
    }
  }

  // 抓取"被引"（citations）：Semantic Scholar（限流+退避），失败回退 OpenAlex；
  // 不在库内的被引保存为 externalRefs（dir=in）
  async function fetchCitations(paperId, onProgress) {
    const paper = store.getPaper(paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    const r = await fetchCitationsOnline(paper, store.data.papers, { onProgress });
    if (!r.ok) return r;
    let added = 0;
    for (const l of r.links) {
      const before = store.data.links.length;
      store.addLink(l.from, l.to, r.source);
      if (store.data.links.length > before) added++;
    }
    if (r.external) store.setExternalRefs(paperId, 'in', filterExternalsAgainstLibrary(r.external, paperId));
    // 顺手补全元数据（不覆盖用户已填字段）
    if (r.meta) {
      const patch = {};
      if (!paper.abstract && r.meta.abstract) patch.abstract = r.meta.abstract;
      if (!paper.venue && r.meta.venue) patch.venue = r.meta.venue;
      if (!paper.year && r.meta.year) patch.year = r.meta.year;
      if ((!paper.authors || !paper.authors.length) && r.meta.authors && r.meta.authors.length) patch.authors = r.meta.authors;
      if (!paper.doi && r.meta.doi) patch.doi = r.meta.doi;
      patch.referencesRaw = [{ fetchedAt: Date.now(), source: r.source, citeCount: r.citeCount }];
      store.updatePaper(paperId, patch);
    }
    return { ok: true, source: r.source, added, citeCount: r.citeCount, fetchedCount: r.fetchedCount, external: (r.external || []).length };
  }

  // 外部引用条目若已能匹配库内论文（DOI/arXiv/标题），则不再列为「未入库」
  function filterExternalsAgainstLibrary(items, selfId) {
    const { matchResolvedToLibrary } = require('./refs');
    const lib = store.data.papers.filter(p => p.id !== selfId);
    return (items || []).filter(e => !matchResolvedToLibrary(e.title, e.doi, lib));
  }

  // 下载单条未入库引用：解析 PDF 地址 → 下载入库（rating=0 未评分）→ 自动建边 → 移除外部条目
  async function downloadRef(paperId, key, onProgress) {
    const paper = store.getPaper(paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    const ref = (paper.externalRefs || []).find(r => r.key === key);
    if (!ref) return { ok: false, error: '未找到该引用条目（可能已入库或已被移除）' };
    const emit = onProgress || (() => {});
    emit({ stage: 'download', current: 0, total: 1, currentItem: ref.title.slice(0, 60), note: '正在解析下载地址…' });
    const url = await findRefPdfUrl(ref);
    if (!url) return { ok: false, error: '未找到开放获取的 PDF（非 arXiv / OpenAlex OA 来源），可尝试手动下载后导入' };
    emit({ stage: 'download', current: 0, total: 1, currentItem: ref.title.slice(0, 60), note: '正在下载 PDF…' });
    const result = await importFromUrl(url, { rating: 0, conflictPolicy: 'merge' }); // 引用下载：冲突自动复用已有论文
    const newPaper = result.paper;
    if (!newPaper) return { ok: false, error: '导入失败' };
    // 建边：dir=out 表示本文引用了它；dir=in 表示它引用了本文
    if (ref.dir === 'out') store.addLink(paperId, newPaper.id, 'ref-download');
    else store.addLink(newPaper.id, paperId, 'ref-download');
    store.removeExternalRef(paperId, key);
    emit({ stage: 'download', current: 1, total: 1, currentItem: newPaper.title.slice(0, 60), note: result.duplicate ? '库中已存在，已关联 ✓' : '下载入库 ✓' });
    return { ok: true, paper: { ...newPaper, refText: undefined }, duplicate: !!result.duplicate };
  }

  // 一键下载全部未入库引用（dir: out / in / both），逐条处理并推送进度
  async function downloadAllRefs(paperId, dir, onProgress) {
    const paper = store.getPaper(paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    const emit = onProgress || (() => {});
    const want = (paper.externalRefs || []).filter(r => dir === 'both' || !dir || r.dir === dir);
    if (!want.length) return { ok: true, total: 0, downloaded: 0, skipped: 0, failed: [] };
    let downloaded = 0, skipped = 0;
    const failed = [];
    for (let i = 0; i < want.length; i++) {
      const ref = want[i];
      emit({ stage: 'download', current: i, total: want.length, currentItem: ref.title.slice(0, 60), note: '解析下载地址…' });
      try {
        const r = await downloadRef(paperId, ref.key);
        if (r.ok) { if (r.duplicate) skipped++; else downloaded++; }
        else failed.push({ title: ref.title.slice(0, 80), error: r.error });
      } catch (e) {
        failed.push({ title: ref.title.slice(0, 80), error: e.message });
      }
      emit({ stage: 'download', current: i + 1, total: want.length, currentItem: ref.title.slice(0, 60), note: failed.length && failed[failed.length - 1].title === ref.title.slice(0, 80) ? '失败：' + failed[failed.length - 1].error.slice(0, 40) : '完成 ✓' });
    }
    return { ok: true, total: want.length, downloaded, skipped, failed };
  }

  // 组合抓取（兼容旧接口）：先参考文献后被引
  async function fetchRefs(paperId, onProgress) {
    const paper = store.getPaper(paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    const references = await fetchReferences(paperId, onProgress);
    const citations = await fetchCitations(paperId, onProgress);
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
  }

  function autoMatch(paperId) {
    const paper = store.getPaper(paperId);
    if (!paper) return { ok: false, error: '论文不存在' };
    if (!paper.refText) return { ok: false, error: '未能从该 PDF 提取到参考文献段落' };
    const matches = matchReferencesToLibrary(paper.refText, store.data.papers, paperId);
    let added = 0;
    for (const m of matches) {
      const before = store.data.links.length;
      store.addLink(paperId, m.toId, 'local-match');
      if (store.data.links.length > before) added++;
    }
    return { ok: true, matched: matches.length, added };
  }

  return { importOnePdfBuffer, importFromPaths, importFromUrl, fetchRefs, fetchReferences, fetchCitations, autoMatch, downloadRef, downloadAllRefs, resolveImport };
}

module.exports = { createService };
