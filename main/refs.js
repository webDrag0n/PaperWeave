// PaperWeave 引用关系：参考文献解析（DOI/arXiv/标题网络检索）+ 被引抓取（Semantic Scholar，含限流退避）+ OpenAlex 回退
const https = require('https');

function httpGetJson(url, timeoutMs = 15000, headers = {}, _redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'PaperWeave/0.2 (paper-library-app)', ...headers },
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (_redirectDepth >= 5) return reject(new Error('重定向次数过多'));
        return resolve(httpGetJson(new URL(res.headers.location, url).toString(), timeoutMs, headers, _redirectDepth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error('HTTP ' + res.statusCode);
        err.status = res.statusCode;
        err.retryAfter = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
        return reject(err);
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => { body += c; if (body.length > 20e6) req.destroy(new Error('too large')); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function httpGetText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'PaperWeave/0.1 (paper-library-app)' },
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error('HTTP ' + res.statusCode);
        err.status = res.statusCode;
        return reject(err);
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => { body += c; if (body.length > 10e6) req.destroy(new Error('too large')); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Semantic Scholar 限流串行队列（未认证约 1 req/s） ----------
let s2LastCall = 0;
async function s2Throttle() {
  const gap = Date.now() - s2LastCall;
  if (gap < 1100) await sleep(1100 - gap);
  s2LastCall = Date.now();
}

async function s2GetJson(url, retries = 2) {
  const key = process.env.PAPERWEAVE_S2_API_KEY;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await s2Throttle();
    try {
      return await httpGetJson(url, 15000, key ? { 'x-api-key': key } : {});
    } catch (e) {
      if (e.status === 429 && attempt < retries) {
        const wait = (e.retryAfter || Math.pow(2, attempt + 1) * 1.5) * 1000;
        await sleep(Math.min(wait, 20000));
        continue;
      }
      throw e;
    }
  }
}

function normTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
}

// 简易相似度：token 集合 Jaccard + 前缀包含
function titleSimilarity(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length > 25 && nb.length > 25 && (na.includes(nb) || nb.includes(na))) return 0.95;
  const sa = new Set(na.split(' ')), sb = new Set(nb.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// 从参考文献原文切分条目：[1] / 1. / 1) / [Vaswani+17] 等编号或作者-年份标签
// 无编号列表（一整段参考文献没有任何起始标记）时按「作者姓氏起始行」启发式切分；
// 并按 DOI / arXiv / 标题前缀去重，避免同一条目重复在线检索。
const REF_START_RE = /^\s*(\[\d{1,3}\]|\d{1,3}[.)]\s|\[[A-Za-z][A-Za-z0-9+&.'\-]{0,13}\d{2,4}[a-z]?\])\s*/;

function splitReferenceEntries(refText) {
  if (!refText) return [];
  const lines = refText.split('\n');
  // 第一遍：编号/标签切分
  const marked = [];
  let cur = '', sawMarker = false;
  for (const line of lines) {
    if (REF_START_RE.test(line)) {
      sawMarker = true;
      if (cur.trim()) marked.push(cur.trim());
      cur = line.replace(REF_START_RE, '');
    } else if (sawMarker) {
      cur += ' ' + line.trim();
    } else {
      cur += (cur ? ' ' : '') + line.trim();
    }
  }
  if (cur.trim()) marked.push(cur.trim());
  let entries = marked.filter(e => e.length > 15);
  // 第二遍：无编号兜底——只得到一条巨型条目时，按作者姓氏起始行重切
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
  // 去重：DOI > arXiv > 标题前缀（前 8 个词）；无法提取 key 的条目照常保留
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const ids = extractRefIdentifiers(e);
    const key = (ids.doi || '').toLowerCase()
      || (ids.arxivId || '').toLowerCase()
      || normTitle(ids.titleGuess || e).split(' ').filter(Boolean).slice(0, 8).join(' ');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(e);
  }
  return out.slice(0, 300);
}

// 从单条参考文献猜测标题：引号内、APA「(年份). 标题.」段、或作者年后到期刊前的最长片段
function guessRefTitle(entry) {
  const quoted = entry.match(/[“"]([^”"]{15,300})[”"]/);
  if (quoted) return quoted[1];
  // APA 风格：Author, A. (2017). Title goes here. Journal…
  const apa = entry.match(/\((?:19|20)\d{2}[a-z]?\)\.?\s+([^.]{15,300}?)(?:\.\s|\.$|$)/);
  if (apa) return apa[1].trim();
  // 去掉尾部标识符噪声（doi/arXiv/URL），避免污染标题段
  let s = entry
    .replace(/\bdoi[:\s]*10\.\S+/i, ' ')
    .replace(/\barxiv[:\s]*(preprint\s+)?(arXiv:)?\d{4}\.\d{4,5}(v\d+)?/i, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  // 去掉开头作者段（含 "and"/"&" 连接的多个作者，支持 "A. Vaswani" 与 "Vaswani, A." 两种写法；
  // 分隔符必须是逗号/and/&，不允许纯空格，防止把标题首词误当作者吃掉）
  s = s.replace(/^\s*(((?:[A-Z]\.\s*){0,3}[A-Z][A-Za-zÀ-ÿ'\-]+|[A-Z][A-Za-zÀ-ÿ'\-]+,\s*(?:[A-Z]\.\s*){1,3})(\s*,\s*|\s+and\s+|\s*&\s*))*/, '');
  const segs = s.split(/(?<=[.?!])\s+/).map(x => x.trim()).filter(x => x.length > 10);
  if (!segs.length) return null;
  segs.sort((a, b) => b.length - a.length);
  const best = segs[0].replace(/\.$/, '');
  return best.length >= 15 ? best.slice(0, 300) : null;
}

// 用本地参考文献原文与库内论文做匹配，返回 [{toId, score, refTitle}]
// 策略：DOI 精确匹配；否则用“论文标题词在条目中的覆盖率”≥0.85 判定
function matchReferencesToLibrary(refText, papers, selfId) {
  const entries = splitReferenceEntries(refText);
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
        // 短标题放宽到全中，长标题允许少量缺词
        hit = titleToks.size <= 4 ? score >= 1 : score >= 0.85;
      }
      if (hit) {
        matches.push({ toId: p.id, score, refTitle: guessRefTitle(entries[i]) || entries[i].slice(0, 120) });
        seen.add(p.id);
        break;
      }
    }
  }
  return matches;
}

// 从 DOI 字符串中提取 arXiv 编号（支持 10.48550/arXiv.1706.03762 与 arXiv:1706.03762）
function extractArxivId(doi) {
  if (!doi) return null;
  const s = String(doi);
  let m = s.match(/^arxiv:(\d{4}\.\d{4,5})(v\d+)?$/i) || s.match(/^arxiv:([a-z\-]+\/\d{7})(v\d+)?$/i);
  if (m) return m[1];
  m = s.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i) || s.match(/10\.48550\/arxiv\.([a-z\-]+\/\d{7})/i);
  if (m) return m[1];
  return null;
}

// Semantic Scholar：按 DOI / arXiv / 标题抓取引用与被引，匹配进库（带限流与 429 退避）
async function fetchSemanticScholar(paper, papers) {
  const fields = 'title,year,authors,externalIds,abstract,venue';
  const listFields = `references.${fields},citations.${fields}`;
  let data = null;

  const axId = extractArxivId(paper.doi);
  const tryIds = [];
  if (paper.doi && !/^arxiv:/i.test(paper.doi)) tryIds.push('DOI:' + paper.doi);
  if (axId) tryIds.push('ARXIV:' + axId);

  for (const pid of tryIds) {
    try {
      data = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(pid)}?fields=${fields},${listFields}`);
      if (data) break;
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) continue; // 404 换下一个标识符
      throw e; // 429 退避后仍失败或网络错误
    }
  }
  if (!data && paper.title) {
    const q = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(paper.title)}&limit=3&fields=${fields}`);
    const hit = (q.data || []).find(h => titleSimilarity(h.title, paper.title) >= 0.8);
    if (hit) {
      data = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/${hit.paperId}?fields=${fields},${listFields}`);
    }
  }
  if (!data) return { found: false, links: [], meta: null };

  const byId = new Map(papers.map(p => [p.id, p]));
  const selfId = paper.id;
  const newLinks = [];
  const consider = (ext, dir) => {
    // dir: 'ref'（paper 引用了 ext）/ 'cite'（ext 引用了 paper）
    if (!ext || !ext.title) return;
    const extDoi = ext.externalIds && (ext.externalIds.DOI || ext.externalIds.ArXiv);
    for (const p of papers) {
      if (p.id === selfId) continue;
      let hit = false;
      if (extDoi && p.doi) {
        const a = String(ext.externalIds.DOI || '').toLowerCase();
        const b = String(p.doi).replace(/^arxiv:/i, '').toLowerCase();
        const axA = String(ext.externalIds.ArXiv || '').toLowerCase();
        const axB = extractArxivId(p.doi);
        if ((a && a === b) || (axA && axB && axA === String(axB).toLowerCase())) hit = true;
      }
      if (!hit && titleSimilarity(ext.title, p.title) >= 0.8) hit = true;
      if (hit) {
        newLinks.push({ ...(dir === 'ref' ? { from: selfId, to: p.id } : { from: p.id, to: selfId }), dir });
        break;
      }
    }
  };
  (data.references || []).slice(0, 200).forEach(r => consider(r, 'ref'));
  (data.citations || []).slice(0, 200).forEach(c => consider(c, 'cite'));

  const meta = {
    title: data.title || null,
    year: data.year ? String(data.year) : null,
    venue: data.venue || null,
    abstract: data.abstract || null,
    authors: (data.authors || []).map(a => a.name).filter(Boolean).slice(0, 20),
    doi: (data.externalIds && (data.externalIds.DOI || (data.externalIds.ArXiv ? 'arXiv:' + data.externalIds.ArXiv : null))) || null,
    refCount: (data.references || []).length,
    citeCount: (data.citations || []).length,
  };
  void byId;
  return { found: true, links: newLinks, meta };
}

// OpenAlex：Semantic Scholar 不可用时的回退源（免费、限流宽松）
// 匹配规则与 S2 相同：DOI/arXiv 精确 + 标题相似度 ≥0.8
async function fetchOpenAlex(paper, papers) {
  const mailto = 'paperweave@example.local';
  let work = null;

  // 1) 定位该论文的 OpenAlex work
  if (paper.doi && !/^arxiv:/i.test(paper.doi)) {
    try {
      work = await httpGetJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(paper.doi)}?mailto=${mailto}`);
    } catch (e) { if (!/HTTP 4\d\d/.test(e.message)) throw e; }
  }
  if (!work && /^arxiv:/i.test(paper.doi || '')) {
    // arXiv 编号不是正式 DOI，但 OpenAlex 通常为其注册了 10.48550/arXiv.xxxx 形式的 DOI
    const ax = paper.doi.replace(/^arxiv:/i, '').replace(/^(\d{4})(\d{2})(\d{3,})$/, '$1.$2$3');
    const candidates = [`10.48550/arXiv.${ax}`];
    for (const d of candidates) {
      try {
        work = await httpGetJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(d)}?mailto=${mailto}`);
        break;
      } catch (_) {}
    }
  }
  if (!work && paper.title) {
    const q = await httpGetJson(`https://api.openalex.org/works?search=${encodeURIComponent(paper.title)}&per-page=3&mailto=${mailto}`);
    work = (q.results || []).find(w => titleSimilarity(w.title || w.display_name, paper.title) >= 0.8) || null;
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
        const axB = b.replace(/^(\d{4})(\d{2})(\d{3,})$/, '10.48550/arxiv.$1.$2$3');
        if (extDoi === b || extDoi === axB) hit = true;
      }
      if (!hit && titleSimilarity(ext.title || ext.display_name, p.title) >= 0.8) hit = true;
      if (hit) return p.id;
    }
    return null;
  };

  // 2) 参考文献：referenced_works 批量解析
  const refIds = (work.referenced_works || []).slice(0, 200);
  let refCount = refIds.length;
  for (let i = 0; i < refIds.length; i += 50) {
    const batch = refIds.slice(i, i + 50).map(u => u.replace(/^https:\/\/openalex\.org\//i, '')).join('|');
    if (!batch) continue;
    const r = await httpGetJson(`https://api.openalex.org/works?filter=openalex_id:${encodeURIComponent(batch)}&per-page=50&mailto=${mailto}`);
    for (const w of r.results || []) {
      const toId = matchIntoLibrary(w);
      if (toId) newLinks.push({ from: selfId, to: toId, dir: 'ref' });
    }
  }

  // 3) 被引：cites 过滤（同时收集未入库条目，供「未入库引用」展示与下载）
  const openalexId = (work.id || '').replace(/^https:\/\/openalex\.org\//i, '');
  let citeCount = 0;
  const externalCites = [];
  if (openalexId) {
    const c = await httpGetJson(`https://api.openalex.org/works?filter=cites:${openalexId}&per-page=200&mailto=${mailto}`);
    citeCount = c.meta ? c.meta.count : (c.results || []).length;
    for (const w of (c.results || []).slice(0, 200)) {
      const fromId = matchIntoLibrary(w);
      if (fromId) {
        newLinks.push({ from: fromId, to: selfId, dir: 'cite' });
      } else {
        externalCites.push(makeExternalRef({
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

  const meta = {
    title: work.title || work.display_name || null,
    year: work.publication_year ? String(work.publication_year) : null,
    venue: (work.primary_location && work.primary_location.source && work.primary_location.source.display_name) || null,
    abstract: null,
    authors: (work.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean).slice(0, 20),
    doi: (work.doi || '').replace(/^https:\/\/doi\.org\//i, '') || null,
    refCount,
    citeCount,
  };
  return { found: true, links: newLinks, meta, externalCites: externalCites.slice(0, 100) };
}

// ---------- 参考文献条目：提取标识符并在线解析 ----------

// 从单条参考文献提取 DOI / arXiv 编号 / 标题猜测
function extractRefIdentifiers(entry) {
  const out = { doi: null, arxivId: null, titleGuess: null };
  const doiM = entry.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (doiM) {
    out.doi = doiM[0].replace(/[.,;)>\]]+$/, '');
    const ax = extractArxivId(out.doi);
    if (ax) out.arxivId = ax;
  }
  if (!out.arxivId) {
    const axM = entry.match(/arxiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?/i) || entry.match(/arxiv[:\s]*([a-z\-]+\/\d{7})(v\d+)?/i);
    if (axM) out.arxivId = axM[1];
  }
  out.titleGuess = guessRefTitle(entry);
  return out;
}

// DOI → CrossRef 解析标题（429 / 5xx 自动退避重试一次）
async function resolveByDoi(doi) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await httpGetJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=paperweave@example.local`);
      const w = r.message || {};
      const title = (w.title || [])[0];
      if (!title) return null;
      return {
        title,
        doi: w.DOI || doi,
        year: w.issued && w.issued['date-parts'] && w.issued['date-parts'][0] ? String(w.issued['date-parts'][0][0]) : null,
        authors: (w.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 8),
        venue: (w['container-title'] || [])[0] || null,
      };
    } catch (e) {
      if (attempt === 0 && (e.status === 429 || (e.status && e.status >= 500))) {
        await sleep((e.retryAfter || 2) * 1000);
        continue;
      }
      throw e;
    }
  }
  return null;
}

// arXiv 编号 → arXiv API 解析标题（Atom XML）
async function resolveByArxiv(arxivId) {
  const meta = await fetchArxivMeta(arxivId);
  if (!meta || !meta.title) return null;
  return { title: meta.title, arxivId, authors: meta.authors || [], year: meta.year || null, venue: 'arXiv' };
}

// arXiv 编号 → 完整元数据（标题/摘要/作者/年份），用于导入时补全 PDF 里抽不到的摘要
async function fetchArxivMeta(arxivId) {
  const xml = await httpGetText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`);
  const em = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!em) return null;
  const e = em[1];
  const grab = (tag) => {
    const m = e.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };
  const title = grab('title');
  if (!title) return null;
  const authors = [...e.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map(m => m[1].trim()).filter(Boolean);
  const published = grab('published') || '';
  const ym = published.match(/\b(19|20)\d{2}\b/);
  return {
    title,
    abstract: grab('summary') || null,
    authors,
    year: ym ? ym[0] : null,
    doi: 'arXiv:' + arxivId,
  };
}

// 标题 → Semantic Scholar 标题匹配（语义级匹配，对不完美的标题猜测容忍度高）
async function resolveByS2Match(title) {
  const q = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(title)}&fields=title,year,authors.name,externalIds,venue`);
  const hit = (q && q.data && q.data[0]) || null;
  if (!hit || !hit.title) return null;
  // S2 已做语义匹配，仍需基本标题相似度防止跑偏
  if (titleSimilarity(hit.title, title) < 0.6) return null;
  return {
    title: hit.title,
    doi: (hit.externalIds && (hit.externalIds.DOI || (hit.externalIds.ArXiv ? 'arXiv:' + hit.externalIds.ArXiv : null))) || null,
    arxivId: (hit.externalIds && hit.externalIds.ArXiv) || extractArxivId(hit.externalIds && hit.externalIds.DOI) || null,
    year: hit.year ? String(hit.year) : null,
    authors: (hit.authors || []).map(a => a.name).filter(Boolean).slice(0, 8),
    venue: hit.venue || null,
  };
}

// 标题 → OpenAlex 检索解析
async function resolveByTitle(title) {
  const q = await httpGetJson(`https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=3&mailto=paperweave@example.local`);
  const hit = (q.results || []).find(w => titleSimilarity(w.title || w.display_name, title) >= 0.85);
  if (!hit) return null;
  return {
    title: hit.title || hit.display_name,
    doi: (hit.doi || '').replace(/^https:\/\/doi\.org\//i, '') || null,
    year: hit.publication_year ? String(hit.publication_year) : null,
    authors: (hit.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean).slice(0, 8),
    venue: (hit.primary_location && hit.primary_location.source && hit.primary_location.source.display_name) || null,
  };
}

// 未入库外部引用条目的稳定 key
function extKey(ref) {
  if (ref.doi) return 'doi:' + String(ref.doi).toLowerCase();
  if (ref.arxivId) return 'arxiv:' + String(ref.arxivId).toLowerCase();
  return 't:' + normTitle(ref.title).split(' ').filter(Boolean).slice(0, 8).join(' ');
}

function makeExternalRef(r, dir, source) {
  return {
    key: extKey(r),
    dir,
    title: r.title || '',
    authors: (r.authors || []).slice(0, 8),
    year: r.year || '',
    venue: r.venue || '',
    doi: r.doi || (r.arxivId ? 'arXiv:' + r.arxivId : ''),
    arxivId: r.arxivId || extractArxivId(r.doi) || null,
    citeCount: typeof r.citeCount === 'number' ? r.citeCount : null,
    source,
    fetchedAt: Date.now(),
  };
}

// 解析单条参考文献：DOI → arXiv → 标题检索，返回 { title, doi, authors, year, venue, source }
async function resolveReferenceEntry(entry) {
  const ids = extractRefIdentifiers(entry);
  if (ids.doi && !ids.arxivId) {
    try {
      const r = await resolveByDoi(ids.doi);
      if (r && r.title) return { ...r, source: 'crossref' };
    } catch (_) {}
  }
  if (ids.arxivId) {
    try {
      const r = await resolveByArxiv(ids.arxivId);
      if (r && r.title) return { ...r, source: 'arxiv' };
    } catch (_) {}
  }
  if (ids.titleGuess) {
    // 优先 S2 标题匹配（对粗糙的标题猜测容忍度更高），失败再走 OpenAlex
    try {
      const r = await resolveByS2Match(ids.titleGuess);
      if (r && r.title) return { ...r, source: 's2-match' };
    } catch (_) {}
    try {
      const r = await resolveByTitle(ids.titleGuess);
      if (r && r.title) return { ...r, source: 'openalex-search' };
    } catch (_) {}
  }
  return null;
}

// 用解析出的标题/DOI 匹配库内论文
function matchResolvedToLibrary(title, doi, lib) {
  for (const p of lib) {
    if (doi && p.doi) {
      const axA = extractArxivId(doi);
      const axB = extractArxivId(p.doi);
      if (axA && axB && axA.toLowerCase() === axB.toLowerCase()) return p.id;
      const a = String(doi).toLowerCase();
      const b = String(p.doi).toLowerCase();
      if (a === b) return p.id;
    }
    if (title && p.title && titleSimilarity(title, p.title) >= 0.8) return p.id;
  }
  return null;
}

// 抓取"引用"（参考文献）：优先 Semantic Scholar 结构化参考文献（收录时最准最全）；
// 未收录/无数据时回退「解析 PDF 参考文献段落，逐条经 DOI/arXiv/S2标题/OpenAlex 在线检索」
// onProgress({ stage:'references', current, total, currentItem, note })
async function fetchReferencesOnline(paper, papers, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  // 主源：S2 结构化参考文献
  try {
    const viaS2 = await fetchReferencesViaS2(paper, papers, onProgress);
    if (viaS2.found) {
      return {
        ok: true, total: viaS2.total, resolved: viaS2.total,
        links: viaS2.links, external: viaS2.external, unresolved: [],
        source: 'semanticscholar', details: [],
      };
    }
  } catch (_) { /* S2 不可用（限流/网络）→ 回退 PDF 逐条解析 */ }

  // 回退：PDF 参考文献段落逐条在线检索
  const entries = splitReferenceEntries(paper.refText || '');
  if (!entries.length) {
    return { ok: false, error: '未能从该 PDF 提取到参考文献条目', total: 0, resolved: 0, links: [] };
  }
  const selfId = paper.id;
  const lib = papers.filter(p => p.id !== selfId);
  const maxEntries = Math.min(entries.length, opts.maxEntries || 120);
  const results = new Array(maxEntries);
  const unresolved = []; // 未能在线识别的条目（供界面展示，便于用户人工补录）
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < maxEntries) {
      const my = idx++;
      const entry = entries[my];
      const short = entry.slice(0, 70);
      onProgress({ stage: 'references', current: done, total: maxEntries, currentItem: short, note: '解析中' });
      try {
        // 快速路径：条目直接覆盖库内标题（省请求）
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
          results[my] = { entry: entry.slice(0, 200), resolvedTitle: null, source: 'library-title-match', toId: hitId };
          done++;
          onProgress({ stage: 'references', current: done, total: maxEntries, currentItem: short, note: '命中库内标题' });
          continue;
        }
        const r = await resolveReferenceEntry(entry);
        if (r && r.title) {
          const toId = matchResolvedToLibrary(r.title, r.doi, lib);
          results[my] = {
            entry: entry.slice(0, 200), resolvedTitle: r.title, source: r.source, toId: toId || null,
            doi: r.doi || null, arxivId: r.arxivId || extractArxivId(r.doi) || null,
            authors: r.authors || [], year: r.year || null, venue: r.venue || null,
          };
          done++;
          onProgress({
            stage: 'references', current: done, total: maxEntries,
            currentItem: r.title.slice(0, 70),
            note: ({ crossref: 'CrossRef (DOI)', arxiv: 'arXiv', 'openalex-search': 'OpenAlex 检索' })[r.source] || r.source,
          });
        } else {
          results[my] = { entry: entry.slice(0, 200), resolvedTitle: null, source: null, toId: null };
          unresolved.push(entry.slice(0, 120));
          done++;
          onProgress({ stage: 'references', current: done, total: maxEntries, currentItem: short, note: '未能在线识别' });
        }
      } catch (e) {
        results[my] = { entry: entry.slice(0, 200), resolvedTitle: null, source: null, toId: null, error: e.message };
        done++;
        onProgress({ stage: 'references', current: done, total: maxEntries, currentItem: short, note: '解析失败: ' + e.message.slice(0, 40) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, maxEntries) }, worker));

  const links = [];
  const seen = new Set();
  const external = [];
  const extSeen = new Set();
  for (const r of results) {
    if (r && r.toId && !seen.has(r.toId)) {
      seen.add(r.toId);
      links.push({ from: selfId, to: r.toId, source: r.source || 'references-online' });
    } else if (r && r.resolvedTitle && !r.toId) {
      // 在线识别成功但不在库内 → 存为「未入库引用」，可一键下载入库
      const ext = makeExternalRef({ title: r.resolvedTitle, doi: r.doi, arxivId: r.arxivId, authors: r.authors, year: r.year, venue: r.venue }, 'out', r.source || 'references-online');
      if (!extSeen.has(ext.key)) { extSeen.add(ext.key); external.push(ext); }
    }
  }
  const resolved = results.filter(r => r && (r.resolvedTitle || r.source === 'library-title-match')).length;
  return { ok: true, total: maxEntries, resolved, links, external, unresolved: unresolved.slice(0, 20), details: results.filter(Boolean).slice(0, 50) };
}

// 在 Semantic Scholar 定位论文（DOI → arXiv → 标题搜索），返回 S2 paperId 与元数据
async function s2Locate(paper, onProgress, stage = 'citations') {
  const axId = extractArxivId(paper.doi);
  const tryIds = [];
  if (paper.doi && !/^arxiv:/i.test(paper.doi)) tryIds.push(['DOI:' + paper.doi, 'DOI']);
  if (axId) tryIds.push(['ARXIV:' + axId, 'arXiv']);
  for (const [pid, label] of tryIds) {
    onProgress({ stage, current: 0, total: 0, currentItem: paper.title.slice(0, 60), note: `正在通过 ${label} 在 Semantic Scholar 定位论文…` });
    try {
      const d = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(pid)}?fields=title,year,authors,externalIds,abstract,venue,citationCount`);
      if (d) return d;
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) continue;
      throw e;
    }
  }
  if (paper.title) {
    onProgress({ stage, current: 0, total: 0, currentItem: paper.title.slice(0, 60), note: '正在通过标题在 Semantic Scholar 搜索…' });
    const q = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(paper.title)}&limit=3&fields=title,citationCount,externalIds,year,authors,venue,abstract`);
    const hit = (q.data || []).find(h => titleSimilarity(h.title, paper.title) >= 0.8);
    if (hit) {
      return await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/${hit.paperId}?fields=title,year,authors,externalIds,abstract,venue,citationCount`);
    }
  }
  return null;
}

// 主源：Semantic Scholar 结构化参考文献（论文被 S2 收录时最准最全，免去逐条文本解析）
async function fetchReferencesViaS2(paper, papers, onProgress) {
  const lib = papers.filter(p => p.id !== paper.id);
  let located = null;
  try {
    located = await s2Locate(paper, onProgress, 'references');
  } catch (e) {
    return { found: false, error: e.message };
  }
  if (!located || !located.paperId) return { found: false };
  const links = [];
  const seen = new Set();
  const external = [];
  const extSeen = new Set();
  let offset = 0, fetched = 0;
  const maxFetch = 500;
  while (fetched < maxFetch) {
    onProgress({ stage: 'references', current: fetched, total: 0, currentItem: located.title || '', note: `正在从 Semantic Scholar 拉取参考文献 ${fetched + 1}–${fetched + 100}…` });
    const page = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/${located.paperId}/references?fields=title,externalIds,year,authors.name,venue,citationCount&limit=100&offset=${offset}`);
    const rows = (page.data || []).map(r => r.citedPaper).filter(Boolean);
    if (!rows.length) break;
    for (const rp of rows) {
      if (!rp.title) continue;
      const ids = rp.externalIds || {};
      let toId = null;
      for (const p of lib) {
        const a = String(ids.DOI || '').toLowerCase();
        const axA = String(ids.ArXiv || '').toLowerCase();
        const axB = extractArxivId(p.doi);
        if ((a && a === String(p.doi).toLowerCase()) || (axA && axB && axA === String(axB).toLowerCase())) { toId = p.id; break; }
        if (titleSimilarity(rp.title, p.title) >= 0.8) { toId = p.id; break; }
      }
      if (toId) {
        if (!seen.has(toId)) { seen.add(toId); links.push({ from: paper.id, to: toId, source: 'semanticscholar-refs' }); }
      } else {
        const ext = makeExternalRef({
          title: rp.title,
          doi: ids.DOI || null,
          arxivId: ids.ArXiv || extractArxivId(ids.DOI) || null,
          authors: (rp.authors || []).map(a => a.name).filter(Boolean),
          year: rp.year ? String(rp.year) : '',
          venue: rp.venue || '',
          citeCount: typeof rp.citationCount === 'number' ? rp.citationCount : null,
        }, 'out', 'semanticscholar');
        if (!extSeen.has(ext.key)) { extSeen.add(ext.key); external.push(ext); }
      }
      fetched++;
    }
    onProgress({ stage: 'references', current: fetched, total: 0, currentItem: '', note: `已处理 ${fetched} 条参考文献` });
    if (page.next == null || rows.length < 100) break;
    offset = page.next;
  }
  if (!fetched) return { found: false }; // S2 有论文但无参考文献数据 → 回退 PDF 解析
  // 未入库参考文献按被引数降序，便于优先下载高价值文献
  external.sort((a, b) => (b.citeCount || 0) - (a.citeCount || 0));
  return { found: true, total: fetched, links, external };
}

// 抓取"被引"（citations）：Semantic Scholar 分页抓取（限流+退避），失败回退 OpenAlex
// onProgress({ stage:'citations', current, total, currentItem, note })
async function fetchCitationsOnline(paper, papers, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const selfId = paper.id;
  const lib = papers.filter(p => p.id !== selfId);
  const matchLib = (title, extIds) => {
    for (const p of lib) {
      if (extIds) {
        const a = String(extIds.DOI || '').toLowerCase();
        const axA = String(extIds.ArXiv || '').toLowerCase();
        const axB = extractArxivId(p.doi);
        if ((a && a === String(p.doi).toLowerCase()) || (axA && axB && axA === String(axB).toLowerCase())) return p.id;
      }
      if (title && p.title && titleSimilarity(title, p.title) >= 0.8) return p.id;
    }
    return null;
  };

  // ---- Semantic Scholar 分页 ----
  let s2Error = null;
  try {
    const located = await s2Locate(paper, onProgress);
    if (located) {
      const total = located.citationCount || 0;
      const maxFetch = 500;
      const links = [];
      const seen = new Set();
      const external = [];
      let offset = 0, fetched = 0;
      while (fetched < Math.min(total, maxFetch)) {
        onProgress({ stage: 'citations', current: fetched, total, currentItem: '', note: `正在抓取被引列表 ${fetched + 1}–${Math.min(fetched + 100, Math.min(total, maxFetch))}…` });
        const page = await s2GetJson(`https://api.semanticscholar.org/graph/v1/paper/${located.paperId}/citations?fields=title,externalIds,year,authors.name,venue,citationCount&limit=100&offset=${offset}`);
        const rows = page.data || [];
        if (!rows.length) break;
        for (const row of rows) {
          const cp = row.citingPaper;
          if (!cp || !cp.title) continue;
          const fromId = matchLib(cp.title, cp.externalIds);
          if (fromId && !seen.has(fromId)) {
            seen.add(fromId);
            links.push({ from: fromId, to: selfId });
            onProgress({ stage: 'citations', current: fetched, total, currentItem: cp.title.slice(0, 60), note: '命中库内论文 ✓' });
          } else if (!fromId) {
            // 不在库内 → 未入库被引条目
            external.push(makeExternalRef({
              title: cp.title,
              doi: (cp.externalIds && cp.externalIds.DOI) || null,
              arxivId: (cp.externalIds && cp.externalIds.ArXiv) || null,
              authors: (cp.authors || []).map(a => a.name).filter(Boolean),
              year: cp.year ? String(cp.year) : '',
              venue: cp.venue || '',
              citeCount: typeof cp.citationCount === 'number' ? cp.citationCount : null,
            }, 'in', 'semanticscholar'));
          }
          fetched++;
        }
        onProgress({ stage: 'citations', current: fetched, total, currentItem: '', note: `已处理 ${fetched}/${Math.min(total, maxFetch)} 条被引` });
        if (page.next == null || rows.length < 100) break;
        offset = page.next;
      }
      // 未入库被引按被引数降序，最多保留 100 条
      external.sort((a, b) => (b.citeCount || 0) - (a.citeCount || 0));
      const externalTop = [];
      const extSeen = new Set();
      for (const e of external) {
        if (extSeen.has(e.key) || externalTop.length >= 100) continue;
        extSeen.add(e.key);
        externalTop.push(e);
      }
      const meta = {
        title: located.title || null,
        year: located.year ? String(located.year) : null,
        venue: located.venue || null,
        abstract: located.abstract || null,
        authors: (located.authors || []).map(a => a.name).filter(Boolean).slice(0, 20),
        doi: (located.externalIds && (located.externalIds.DOI || (located.externalIds.ArXiv ? 'arXiv:' + located.externalIds.ArXiv : null))) || null,
      };
      return { ok: true, source: 'semanticscholar', links, citeCount: total, fetchedCount: fetched, external: externalTop, meta };
    }
    s2Error = new Error('未在 Semantic Scholar 找到该论文');
  } catch (e) { s2Error = e; }

  // ---- OpenAlex 回退 ----
  onProgress({ stage: 'citations', current: 0, total: 0, currentItem: paper.title.slice(0, 60), note: 'Semantic Scholar 不可用，回退 OpenAlex…' });
  try {
    const r = await fetchOpenAlex(paper, papers);
    if (r.found) {
      const links = r.links.filter(l => l.dir === 'cite').map(({ from, to }) => ({ from, to }));
      links.forEach((l, i) => {
        const t = (lib.find(p => p.id === l.from) || {}).title || '';
        onProgress({ stage: 'citations', current: i + 1, total: r.meta.citeCount, currentItem: t.slice(0, 60), note: 'OpenAlex 命中库内论文 ✓' });
      });
      return { ok: true, source: 'openalex', links, citeCount: r.meta.citeCount, fetchedCount: r.links.length, external: r.externalCites || [], meta: r.meta };
    }
    return { ok: false, error: '两个数据源均未找到该论文（Semantic Scholar：' + s2Error.message + '）' };
  } catch (e2) {
    return { ok: false, error: 'Semantic Scholar：' + s2Error.message + '；OpenAlex：' + e2.message };
  }
}

// 为未入库的引用条目寻找可下载的 PDF 地址：arXiv 直链 → OpenAlex 开放获取位置
async function findRefPdfUrl(ref) {
  const ax = ref.arxivId || extractArxivId(ref.doi);
  if (ax) return `https://arxiv.org/pdf/${ax}`;
  const mailto = 'paperweave@example.local';
  const oaPdf = (w) => w && ((w.best_oa_location && w.best_oa_location.pdf_url)
    || (w.open_access && w.open_access.is_oa && w.open_access.oa_url) || null);
  if (ref.doi && !/^arxiv:/i.test(ref.doi)) {
    try {
      const w = await httpGetJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(ref.doi)}?mailto=${mailto}`);
      const u = oaPdf(w);
      if (u) return u;
    } catch (_) {}
  }
  if (ref.title) {
    try {
      const q = await httpGetJson(`https://api.openalex.org/works?search=${encodeURIComponent(ref.title)}&per-page=3&mailto=${mailto}`);
      const hit = (q.results || []).find(w => titleSimilarity(w.title || w.display_name, ref.title) >= 0.85);
      const u = hit && oaPdf(hit);
      if (u) return u;
    } catch (_) {}
  }
  return null;
}

module.exports = {
  fetchSemanticScholar,
  fetchOpenAlex,
  fetchReferencesOnline,
  fetchCitationsOnline,
  resolveReferenceEntry,
  matchReferencesToLibrary,
  matchResolvedToLibrary,
  splitReferenceEntries,
  titleSimilarity,
  guessRefTitle,
  extractArxivId,
  fetchArxivMeta,
  findRefPdfUrl,
  extKey,
};
