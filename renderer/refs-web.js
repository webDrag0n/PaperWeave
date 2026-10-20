// PaperGraph 网页模式下的引用抓取（Semantic Scholar）与本地参考文献模糊匹配
function normTitle(t) { return (t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim(); }

export function titleSimilarityWeb(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length > 25 && nb.length > 25 && (na.includes(nb) || nb.includes(na))) return 0.95;
  const sa = new Set(na.split(' ')), sb = new Set(nb.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// 与 main/refs.js 保持一致：[1] / 1. / [Vaswani+17] 编号或作者-年份标签切分；
// 无编号列表按作者姓氏起始行启发式切分；按 DOI / arXiv / 标题前缀去重
const REF_START_RE_WEB = /^\s*(\[\d{1,3}\]|\d{1,3}[.)]\s|\[[A-Za-z][A-Za-z0-9+&.'\-]{0,13}\d{2,4}[a-z]?\])\s*/;

export function splitReferenceEntriesWeb(refText) {
  if (!refText) return [];
  const lines = refText.split('\n');
  const marked = [];
  let cur = '', sawMarker = false;
  for (const line of lines) {
    if (REF_START_RE_WEB.test(line)) {
      sawMarker = true;
      if (cur.trim()) marked.push(cur.trim());
      cur = line.replace(REF_START_RE_WEB, '');
    } else if (sawMarker) {
      cur += ' ' + line.trim();
    } else {
      cur += (cur ? ' ' : '') + line.trim();
    }
  }
  if (cur.trim()) marked.push(cur.trim());
  let entries = marked.filter(e => e.length > 15);
  if (entries.length <= 1) {
    const newEntryRe = /^\s*[A-Z][A-Za-zÀ-ÿ'\-]{1,30}(,\s*[A-Z]\.|\s+[A-Z]\.)/;
    const rebuilt = [];
    cur = '';
    for (const line of lines) {
      const t = line.trim();
      if (t && newEntryRe.test(t) && cur.trim().length > 25) {
        rebuilt.push(cur.trim());
        cur = t;
      } else {
        cur += (cur ? ' ' : '') + t;
      }
    }
    if (cur.trim()) rebuilt.push(cur.trim());
    if (rebuilt.length > entries.length) entries = rebuilt.filter(e => e.length > 15);
  }
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const ids = extractRefIdentifiersWeb(e);
    const key = (ids.doi || '').toLowerCase()
      || (ids.arxivId || '').toLowerCase()
      || normTitle(ids.titleGuess || e).split(' ').filter(Boolean).slice(0, 8).join(' ');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(e);
  }
  return out.slice(0, 300);
}

function guessRefTitle(entry) {
  const quoted = entry.match(/[“"]([^”"]{15,300})[”"]/);
  if (quoted) return quoted[1];
  const apa = entry.match(/\((?:19|20)\d{2}[a-z]?\)\.?\s+([^.]{15,300}?)(?:\.\s|\.$|$)/);
  if (apa) return apa[1].trim();
  let s = entry
    .replace(/\bdoi[:\s]*10\.\S+/i, ' ')
    .replace(/\barxiv[:\s]*(preprint\s+)?(arXiv:)?\d{4}\.\d{4,5}(v\d+)?/i, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/^\s*(((?:[A-Z]\.\s*){0,3}[A-Z][A-Za-zÀ-ÿ'\-]+|[A-Z][A-Za-zÀ-ÿ'\-]+,\s*(?:[A-Z]\.\s*){1,3})(\s*,\s*|\s+and\s+|\s*&\s*))*/, '');
  const segs = s.split(/(?<=[.?!])\s+/).map(x => x.trim()).filter(x => x.length > 10);
  if (!segs.length) return null;
  segs.sort((a, b) => b.length - a.length);
  const best = segs[0].replace(/\.$/, '');
  return best.length >= 15 ? best.slice(0, 300) : null;
}

export function matchReferencesToLibraryWeb(refText, papers, selfId) {
  const entries = splitReferenceEntriesWeb(refText);
  const matches = [];
  const seen = new Set();
  const entryTokens = entries.map(e => new Set(normTitle(e).split(' ').filter(Boolean)));
  const entryDois = entries.map(e => {
    const m = e.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    return m ? normTitle(m[0].replace(/[.,;)>\]]+$/, '')) : null;
  });
  for (const p of papers) {
    if (p.id === selfId || seen.has(p.id) || !p.title) continue;
    const titleToks = new Set(normTitle(p.title).split(' ').filter(Boolean));
    if (titleToks.size < 2) continue;
    const pDoi = p.doi ? normTitle(String(p.doi).replace(/^arxiv:/i, '')) : null;
    for (let i = 0; i < entries.length; i++) {
      let hit = false, score = 0;
      if (pDoi && entryDois[i] && (entryDois[i] === pDoi || entryDois[i].endsWith(pDoi) || pDoi.endsWith(entryDois[i]))) {
        hit = true; score = 1;
      } else {
        let cover = 0;
        for (const t of titleToks) if (entryTokens[i].has(t)) cover++;
        score = cover / titleToks.size;
        hit = titleToks.size <= 4 ? score >= 1 : score >= 0.85;
      }
      if (hit) {
        matches.push({ toId: p.id, score, refTitle: entries[i].slice(0, 120) });
        seen.add(p.id);
        break;
      }
    }
  }
  return matches;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function fetchSemanticScholarWeb(paper, papers) {  const fields = 'title,year,authors,externalIds,abstract,venue';
  const listFields = `references.${fields},citations.${fields}`;
  let data = null;

  if (paper.doi && !/^arxiv:/i.test(paper.doi)) {
    try { data = await getJson(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(paper.doi)}?fields=${fields},${listFields}`); }
    catch (e) { if (!/HTTP 4\d\d/.test(e.message)) throw e; }
  }
  if (!data && /^arxiv:/i.test(paper.doi || '')) {
    const ax = paper.doi.replace(/^arxiv:/i, '');
    try { data = await getJson(`https://api.semanticscholar.org/graph/v1/paper/arXiv:${encodeURIComponent(ax)}?fields=${fields},${listFields}`); }
    catch (e) { if (!/HTTP 4\d\d/.test(e.message)) throw e; }
  }
  if (!data && paper.title) {
    const q = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(paper.title)}&limit=3&fields=${fields}`);
    const hit = (q.data || []).find(h => titleSimilarityWeb(h.title, paper.title) >= 0.8);
    if (hit) data = await getJson(`https://api.semanticscholar.org/graph/v1/paper/${hit.paperId}?fields=${fields},${listFields}`);
  }
  if (!data) return { found: false, links: [], meta: null };

  const selfId = paper.id;
  const newLinks = [];
  const consider = (ext, dir) => {
    if (!ext || !ext.title) return;
    for (const p of papers) {
      if (p.id === selfId) continue;
      let hit = false;
      if (ext.externalIds && p.doi) {
        const a = String(ext.externalIds.DOI || '').toLowerCase();
        const b = String(p.doi).replace(/^arxiv:/i, '').toLowerCase();
        const axA = String(ext.externalIds.ArXiv || '').toLowerCase();
        if ((a && a === b) || (axA && axA === b)) hit = true;
      }
      if (!hit && titleSimilarityWeb(ext.title, p.title) >= 0.8) hit = true;
      if (hit) { newLinks.push(dir === 'ref' ? { from: selfId, to: p.id } : { from: p.id, to: selfId }); break; }
    }
  };
  (data.references || []).slice(0, 200).forEach(r => consider(r, 'ref'));
  (data.citations || []).slice(0, 200).forEach(c => consider(c, 'cite'));

  return {
    found: true,
    links: newLinks,
    meta: {
      title: data.title || null,
      year: data.year ? String(data.year) : null,
      venue: data.venue || null,
      abstract: data.abstract || null,
      authors: (data.authors || []).map(a => a.name).filter(Boolean).slice(0, 20),
      doi: (data.externalIds && (data.externalIds.DOI || (data.externalIds.ArXiv ? 'arXiv:' + data.externalIds.ArXiv : null))) || null,
      refCount: (data.references || []).length,
      citeCount: (data.citations || []).length,
    },
  };
}

// OpenAlex 回退源（Semantic Scholar 不可用时；免费且支持 CORS）
export async function fetchOpenAlexWeb(paper, papers) {
  let work = null;
  if (paper.doi && !/^arxiv:/i.test(paper.doi)) {
    try { work = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(paper.doi)}`); }
    catch (e) { if (!/HTTP 4\d\d/.test(e.message)) throw e; }
  }
  if (!work && /^arxiv:/i.test(paper.doi || '')) {
    const ax = paper.doi.replace(/^arxiv:/i, '');
    try { work = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent('10.48550/arXiv.' + ax)}`); }
    catch (_) {}
  }
  if (!work && paper.title) {
    const q = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(paper.title)}&per-page=3`);
    work = (q.results || []).find(w => titleSimilarityWeb(w.title || w.display_name, paper.title) >= 0.8) || null;
  }
  if (!work) return { found: false, links: [], meta: null };

  const selfId = paper.id;
  const newLinks = [];
  const matchIntoLibrary = (ext) => {
    if (!ext || !(ext.title || ext.display_name)) return null;
    const extDoi = (ext.doi || '').replace(/^https:\/\/doi\.org\//i, '').toLowerCase();
    for (const p of papers) {
      if (p.id === selfId) continue;
      let hit = false;
      if (extDoi && p.doi) {
        const b = String(p.doi).replace(/^arxiv:/i, '').toLowerCase();
        if (extDoi === b || extDoi === '10.48550/arxiv.' + b) hit = true;
      }
      if (!hit && titleSimilarityWeb(ext.title || ext.display_name, p.title) >= 0.8) hit = true;
      if (hit) return p.id;
    }
    return null;
  };

  const refIds = (work.referenced_works || []).slice(0, 200);
  for (let i = 0; i < refIds.length; i += 50) {
    const batch = refIds.slice(i, i + 50).map(u => u.replace(/^https:\/\/openalex\.org\//i, '')).join('|');
    if (!batch) continue;
    const r = await getJson(`https://api.openalex.org/works?filter=openalex_id:${encodeURIComponent(batch)}&per-page=50`);
    for (const w of r.results || []) {
      const toId = matchIntoLibrary(w);
      if (toId) newLinks.push({ from: selfId, to: toId, dir: 'ref' });
    }
  }
  const openalexId = (work.id || '').replace(/^https:\/\/openalex\.org\//i, '');
  let citeCount = 0;
  const externalCites = [];
  if (openalexId) {
    const c = await getJson(`https://api.openalex.org/works?filter=cites:${openalexId}&per-page=200`);
    citeCount = c.meta ? c.meta.count : (c.results || []).length;
    for (const w of (c.results || []).slice(0, 200)) {
      const fromId = matchIntoLibrary(w);
      if (fromId) {
        newLinks.push({ from: fromId, to: selfId, dir: 'cite' });
      } else {
        externalCites.push(makeExternalRefWeb({
          title: w.title || w.display_name,
          doi: (w.doi || '').replace(/^https:\/\/doi\.org\//i, '') || null,
          authors: (w.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean),
          year: w.publication_year ? String(w.publication_year) : '',
          venue: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || '',
          citeCount: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
        }, 'in', 'openalex'));
      }
    }
    externalCites.sort((a, b) => (b.citeCount || 0) - (a.citeCount || 0));
  }

  return {
    found: true,
    links: newLinks,
    externalCites: externalCites.slice(0, 100),
    meta: {
      title: work.title || work.display_name || null,
      year: work.publication_year ? String(work.publication_year) : null,
      venue: (work.primary_location && work.primary_location.source && work.primary_location.source.display_name) || null,
      abstract: null,
      authors: (work.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean).slice(0, 20),
      doi: (work.doi || '').replace(/^https:\/\/doi\.org\//i, '') || null,
      refCount: refIds.length,
      citeCount,
    },
  };
}

// 组合抓取：先 Semantic Scholar，失败回退 OpenAlex
export async function fetchRefsCombinedWeb(paper, papers) {
  let s2Error = null;
  try {
    const r = await fetchSemanticScholarWeb(paper, papers);
    if (r.found) return { ...r, source: 'semanticscholar' };
    s2Error = new Error('未在 Semantic Scholar 找到该论文');
  } catch (e) { s2Error = e; }
  try {
    const r = await fetchOpenAlexWeb(paper, papers);
    if (r.found) return { ...r, source: 'openalex' };
    throw new Error('两个数据源均未找到该论文（Semantic Scholar：' + s2Error.message + '）');
  } catch (e2) {
    if (/两个数据源/.test(e2.message)) throw e2;
    throw new Error('Semantic Scholar：' + s2Error.message + '；OpenAlex：' + e2.message);
  }
}

// ---------- 参考文献条目在线解析（网页版镜像） ----------
function extractArxivIdWeb(doi) {
  if (!doi) return null;
  const s = String(doi);
  let m = s.match(/^arxiv:(\d{4}\.\d{4,5})(v\d+)?$/i) || s.match(/^arxiv:([a-z\-]+\/\d{7})(v\d+)?$/i);
  if (m) return m[1];
  m = s.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i) || s.match(/10\.48550\/arxiv\.([a-z\-]+\/\d{7})/i);
  if (m) return m[1];
  return null;
}

function extractRefIdentifiersWeb(entry) {
  const out = { doi: null, arxivId: null, titleGuess: null };
  const doiM = entry.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (doiM) {
    out.doi = doiM[0].replace(/[.,;)>\]]+$/, '');
    const ax = extractArxivIdWeb(out.doi);
    if (ax) out.arxivId = ax;
  }
  if (!out.arxivId) {
    const axM = entry.match(/arxiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?/i) || entry.match(/arxiv[:\s]*([a-z\-]+\/\d{7})(v\d+)?/i);
    if (axM) out.arxivId = axM[1];
  }
  out.titleGuess = guessRefTitle(entry);
  return out;
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return res.text();
}

async function getJsonStrict(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return res.json();
}

async function resolveByDoiWeb(doi) {
  const r = await getJsonStrict(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=papergraph@example.local`);
  const w = r.message || {};
  const title = (w.title || [])[0];
  if (!title) return null;
  return {
    title, doi: w.DOI || doi,
    year: w.issued && w.issued['date-parts'] && w.issued['date-parts'][0] ? String(w.issued['date-parts'][0][0]) : null,
    authors: (w.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 8),
    venue: (w['container-title'] || [])[0] || null,
  };
}

async function resolveByArxivWeb(arxivId) {
  const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`);
  const em = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!em) return null;
  const e = em[1];
  const tm = e.match(/<title>([\s\S]*?)<\/title>/);
  if (!tm) return null;
  const pm = (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '';
  const ym = pm.match(/\b(19|20)\d{2}\b/);
  return {
    title: tm[1].replace(/\s+/g, ' ').trim(),
    arxivId,
    authors: [...e.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map(m => m[1].trim()).filter(Boolean).slice(0, 8),
    year: ym ? ym[0] : null,
    venue: 'arXiv',
  };
}

async function resolveByTitleWeb(title) {
  const q = await getJsonStrict(`https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=3&mailto=papergraph@example.local`);
  const hit = (q.results || []).find(w => titleSimilarityWeb(w.title || w.display_name, title) >= 0.85);
  if (!hit) return null;
  return {
    title: hit.title || hit.display_name,
    doi: (hit.doi || '').replace(/^https:\/\/doi\.org\//i, '') || null,
    year: hit.publication_year ? String(hit.publication_year) : null,
    authors: (hit.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean).slice(0, 8),
    venue: (hit.primary_location && hit.primary_location.source && hit.primary_location.source.display_name) || null,
  };
}

async function resolveByS2MatchWeb(title) {
  const q = await s2GetJsonWeb(`https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(title)}&fields=title,year,authors.name,externalIds,venue`);
  const hit = (q && q.data && q.data[0]) || null;
  if (!hit || !hit.title) return null;
  if (titleSimilarityWeb(hit.title, title) < 0.6) return null;
  return {
    title: hit.title,
    doi: (hit.externalIds && (hit.externalIds.DOI || (hit.externalIds.ArXiv ? 'arXiv:' + hit.externalIds.ArXiv : null))) || null,
    arxivId: (hit.externalIds && hit.externalIds.ArXiv) || extractArxivIdWeb(hit.externalIds && hit.externalIds.DOI) || null,
    year: hit.year ? String(hit.year) : null,
    authors: (hit.authors || []).map(a => a.name).filter(Boolean).slice(0, 8),
    venue: hit.venue || null,
  };
}

export async function resolveReferenceEntryWeb(entry) {
  const ids = extractRefIdentifiersWeb(entry);
  if (ids.doi && !ids.arxivId) {
    try { const r = await resolveByDoiWeb(ids.doi); if (r && r.title) return { ...r, source: 'crossref' }; } catch (_) {}
  }
  if (ids.arxivId) {
    // 浏览器下 arXiv API 可能受 CORS 限制，失败则落到标题检索
    try { const r = await resolveByArxivWeb(ids.arxivId); if (r && r.title) return { ...r, source: 'arxiv' }; } catch (_) {}
  }
  if (ids.titleGuess) {
    try { const r = await resolveByS2MatchWeb(ids.titleGuess); if (r && r.title) return { ...r, source: 's2-match' }; } catch (_) {}
    try { const r = await resolveByTitleWeb(ids.titleGuess); if (r && r.title) return { ...r, source: 'openalex-search' }; } catch (_) {}
  }
  return null;
}

export function matchResolvedToLibraryWeb(title, doi, lib) {
  for (const p of lib) {
    if (doi && p.doi) {
      const axA = extractArxivIdWeb(doi);
      const axB = extractArxivIdWeb(p.doi);
      if (axA && axB && axA.toLowerCase() === axB.toLowerCase()) return p.id;
      if (String(doi).toLowerCase() === String(p.doi).toLowerCase()) return p.id;
    }
    if (title && p.title && titleSimilarityWeb(title, p.title) >= 0.8) return p.id;
  }
  return null;
}

// 未入库外部引用条目（与 main/refs.js 保持一致）
export function extKeyWeb(ref) {
  if (ref.doi) return 'doi:' + String(ref.doi).toLowerCase();
  if (ref.arxivId) return 'arxiv:' + String(ref.arxivId).toLowerCase();
  return 't:' + normTitle(ref.title).split(' ').filter(Boolean).slice(0, 8).join(' ');
}

function makeExternalRefWeb(r, dir, source) {
  return {
    key: extKeyWeb(r),
    dir,
    title: r.title || '',
    authors: (r.authors || []).slice(0, 8),
    year: r.year || '',
    venue: r.venue || '',
    doi: r.doi || (r.arxivId ? 'arXiv:' + r.arxivId : ''),
    arxivId: r.arxivId || extractArxivIdWeb(r.doi) || null,
    citeCount: typeof r.citeCount === 'number' ? r.citeCount : null,
    source,
    fetchedAt: Date.now(),
  };
}

export async function fetchReferencesOnlineWeb(paper, papers, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  // 主源：S2 结构化参考文献（收录时最准最全）
  try {
    onProgress({ stage: 'references', current: 0, total: 0, currentItem: (paper.title || '').slice(0, 60), note: '正在 Semantic Scholar 定位论文…' });
    const r = await fetchSemanticScholarThrottled(paper, papers);
    if (r.found && r.links.some(l => l.dir === 'ref') || (r.found && (r.external || []).some(e => e.dir === 'out'))) {
      const links = r.links.filter(l => l.dir === 'ref').map(({ from, to }) => ({ from, to, source: 'semanticscholar-refs' }));
      const external = (r.external || []).filter(e => e.dir === 'out').map(e => ({ ...e, source: 'semanticscholar' }));
      external.sort((a, b) => (b.citeCount || 0) - (a.citeCount || 0));
      const total = links.length + external.length;
      return { ok: true, total, resolved: total, links, external, unresolved: [], source: 'semanticscholar' };
    }
  } catch (_) { /* S2 不可用 → 回退 PDF 逐条解析 */ }
  const entries = splitReferenceEntriesWeb(paper.refText || '');
  if (!entries.length) return { ok: false, error: '未能从该 PDF 提取到参考文献条目' };
  const selfId = paper.id;
  const lib = papers.filter(p => p.id !== selfId);
  const maxEntries = Math.min(entries.length, opts.maxEntries || 120);
  const links = [];
  const seen = new Set();
  const unresolved = [];
  const external = [];
  const extSeen = new Set();
  let resolved = 0;
  for (let i = 0; i < maxEntries; i++) {
    const entry = entries[i];
    const short = entry.slice(0, 70);
    onProgress({ stage: 'references', current: i, total: maxEntries, currentItem: short, note: '解析中' });
    // 快速路径：直接覆盖库内标题
    const entryTokens = new Set(normTitle(entry).split(' ').filter(Boolean));
    let hitId = null;
    for (const p of lib) {
      const toks = new Set(normTitle(p.title).split(' ').filter(Boolean));
      if (toks.size < 2) continue;
      let cover = 0;
      for (const t of toks) if (entryTokens.has(t)) cover++;
      const score = cover / toks.size;
      if (toks.size <= 4 ? score >= 1 : score >= 0.85) { hitId = p.id; break; }
    }
    if (hitId) {
      resolved++;
      if (!seen.has(hitId)) { seen.add(hitId); links.push({ from: selfId, to: hitId, source: 'library-title-match' }); }
      onProgress({ stage: 'references', current: i + 1, total: maxEntries, currentItem: short, note: '命中库内标题' });
      continue;
    }
    const r = await resolveReferenceEntryWeb(entry);
    if (r && r.title) {
      resolved++;
      const toId = matchResolvedToLibraryWeb(r.title, r.doi, lib);
      if (toId && !seen.has(toId)) { seen.add(toId); links.push({ from: selfId, to: toId, source: r.source }); }
      if (!toId) {
        const ext = makeExternalRefWeb(r, 'out', r.source);
        if (!extSeen.has(ext.key)) { extSeen.add(ext.key); external.push(ext); }
      }
      onProgress({
        stage: 'references', current: i + 1, total: maxEntries,
        currentItem: r.title.slice(0, 70),
        note: ({ crossref: 'CrossRef (DOI)', arxiv: 'arXiv', 'openalex-search': 'OpenAlex 检索' })[r.source] || r.source,
      });
    } else {
      unresolved.push(entry.slice(0, 120));
      onProgress({ stage: 'references', current: i + 1, total: maxEntries, currentItem: short, note: '未能在线识别' });
    }
  }
  return { ok: true, total: maxEntries, resolved, links, external, unresolved: unresolved.slice(0, 20) };
}

// ---------- 被引抓取（网页版，S2 限流 + OpenAlex 回退） ----------
let s2LastCallWeb = 0;
const sleepWeb = (ms) => new Promise(r => setTimeout(r, ms));

async function s2GetJsonWeb(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const gap = Date.now() - s2LastCallWeb;
    if (gap < 1100) await sleepWeb(1100 - gap);
    s2LastCallWeb = Date.now();
    try {
      return await getJsonStrict(url);
    } catch (e) {
      if (e.status === 429 && attempt < retries) {
        await sleepWeb(Math.min(Math.pow(2, attempt + 1) * 2000, 30000));
        continue;
      }
      throw e;
    }
  }
}

export async function fetchSemanticScholarThrottled(paper, papers) {
  const fields = 'title,year,authors,externalIds,abstract,venue,citationCount';
  const listFields = `references.${fields},citations.${fields}`;
  let data = null;
  const axId = extractArxivIdWeb(paper.doi);
  const tryIds = [];
  if (paper.doi && !/^arxiv:/i.test(paper.doi)) tryIds.push('DOI:' + paper.doi);
  if (axId) tryIds.push('ARXIV:' + axId);
  for (const pid of tryIds) {
    try {
      data = await s2GetJsonWeb(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(pid)}?fields=${fields},${listFields}`);
      if (data) break;
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) continue;
      throw e;
    }
  }
  if (!data && paper.title) {
    const q = await s2GetJsonWeb(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(paper.title)}&limit=3&fields=${fields}`);
    const hit = (q.data || []).find(h => titleSimilarityWeb(h.title, paper.title) >= 0.8);
    if (hit) data = await s2GetJsonWeb(`https://api.semanticscholar.org/graph/v1/paper/${hit.paperId}?fields=${fields},${listFields}`);
  }
  if (!data) return { found: false, links: [], meta: null };

  const selfId = paper.id;
  const newLinks = [];
  const external = [];
  const extSeen = new Set();
  const consider = (ext, dir) => {
    if (!ext || !ext.title) return;
    for (const p of papers) {
      if (p.id === selfId) continue;
      let hit = false;
      if (ext.externalIds && p.doi) {
        const a = String(ext.externalIds.DOI || '').toLowerCase();
        const axA = String(ext.externalIds.ArXiv || '').toLowerCase();
        const axB = extractArxivIdWeb(p.doi);
        if ((a && a === String(p.doi).toLowerCase()) || (axA && axB && axA === String(axB).toLowerCase())) hit = true;
      }
      if (!hit && titleSimilarityWeb(ext.title, p.title) >= 0.8) hit = true;
      if (hit) { newLinks.push({ ...(dir === 'ref' ? { from: selfId, to: p.id } : { from: p.id, to: selfId }), dir }); return; }
    }
    // 不在库内 → 未入库条目
    const er = makeExternalRefWeb({
      title: ext.title,
      doi: (ext.externalIds && ext.externalIds.DOI) || null,
      arxivId: (ext.externalIds && ext.externalIds.ArXiv) || null,
      authors: (ext.authors || []).map(a => a.name).filter(Boolean),
      year: ext.year ? String(ext.year) : '',
      venue: ext.venue || '',
      citeCount: typeof ext.citationCount === 'number' ? ext.citationCount : null,
    }, dir === 'ref' ? 'out' : 'in', 'semanticscholar');
    if (!extSeen.has(er.key)) { extSeen.add(er.key); external.push(er); }
  };
  (data.references || []).slice(0, 200).forEach(r => consider(r, 'ref'));
  (data.citations || []).slice(0, 200).forEach(c => consider(c, 'cite'));
  // 未入库被引按被引数降序截断
  external.sort((a, b) => (b.dir === 'in' ? 1 : 0) - (a.dir === 'in' ? 1 : 0) || (b.citeCount || 0) - (a.citeCount || 0));
  return {
    found: true,
    links: newLinks,
    external: external.slice(0, 100),
    meta: {
      title: data.title || null,
      year: data.year ? String(data.year) : null,
      venue: data.venue || null,
      abstract: data.abstract || null,
      authors: (data.authors || []).map(a => a.name).filter(Boolean).slice(0, 20),
      doi: (data.externalIds && (data.externalIds.DOI || (data.externalIds.ArXiv ? 'arXiv:' + data.externalIds.ArXiv : null))) || null,
      refCount: (data.references || []).length,
      citeCount: (data.citations || []).length,
    },
  };
}

export async function fetchCitationsOnlineWeb(paper, papers, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  let s2Error = null;
  try {
    onProgress({ stage: 'citations', current: 0, total: 0, currentItem: (paper.title || '').slice(0, 60), note: '正在 Semantic Scholar 定位论文…' });
    const r = await fetchSemanticScholarThrottled(paper, papers);
    if (r.found) {
      const links = r.links.filter(l => l.dir === 'cite');
      const external = (r.external || []).filter(e => e.dir === 'in');
      onProgress({ stage: 'citations', current: links.length, total: r.meta.citeCount, currentItem: '', note: `已处理 ${links.length} 条被引` });
      return { ok: true, source: 'semanticscholar', links, citeCount: r.meta.citeCount, external, meta: r.meta };
    }
    s2Error = new Error('未在 Semantic Scholar 找到该论文');
  } catch (e) { s2Error = e; }
  try {
    onProgress({ stage: 'citations', current: 0, total: 0, currentItem: (paper.title || '').slice(0, 60), note: '回退 OpenAlex…' });
    const r = await fetchOpenAlexWeb(paper, papers);
    if (r.found) {
      const links = r.links.filter(l => l.dir === 'cite');
      onProgress({ stage: 'citations', current: links.length, total: r.meta.citeCount, currentItem: '', note: `OpenAlex 命中 ${links.length} 篇库内论文` });
      return { ok: true, source: 'openalex', links, citeCount: r.meta.citeCount, external: r.externalCites || [], meta: r.meta };
    }
    return { ok: false, error: '两个数据源均未找到该论文（Semantic Scholar：' + s2Error.message + '）' };
  } catch (e2) {
    return { ok: false, error: 'Semantic Scholar：' + s2Error.message + '；OpenAlex：' + e2.message };
  }
}

// 为未入库引用条目寻找可下载 PDF：arXiv 直链 → OpenAlex 开放获取
export async function findRefPdfUrlWeb(ref) {
  const ax = ref.arxivId || extractArxivIdWeb(ref.doi);
  if (ax) return `https://arxiv.org/pdf/${ax}`;
  const oaPdf = (w) => w && ((w.best_oa_location && w.best_oa_location.pdf_url)
    || (w.open_access && w.open_access.is_oa && w.open_access.oa_url) || null);
  if (ref.doi && !/^arxiv:/i.test(ref.doi)) {
    try {
      const w = await getJsonStrict(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(ref.doi)}?mailto=papergraph@example.local`);
      const u = oaPdf(w);
      if (u) return u;
    } catch (_) {}
  }
  if (ref.title) {
    try {
      const q = await getJsonStrict(`https://api.openalex.org/works?search=${encodeURIComponent(ref.title)}&per-page=3&mailto=papergraph@example.local`);
      const hit = (q.results || []).find(w => titleSimilarityWeb(w.title || w.display_name, ref.title) >= 0.85);
      const u = hit && oaPdf(hit);
      if (u) return u;
    } catch (_) {}
  }
  return null;
}
