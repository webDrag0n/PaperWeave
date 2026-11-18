// 浏览器预览模式的本地引用索引；结构与 main/citation-index.js 保持一致。
const LABEL_RE = /^\s*(\[\d{1,3}\]|\d{1,3}[.)]\s|\[[A-Za-z][A-Za-z0-9+&.'\-]{0,13}\d{2,4}[a-z]?\])\s*/;
const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

function labelNumber(label) {
  return /^\[\d{1,3}\]$/.test(label) || /^\d{1,3}[.)]$/.test(label) ? parseInt(label.match(/\d{1,3}/)[0], 10) : null;
}
function referenceLines(refText) {
  const lines = String(refText).split('\n');
  const counts = new Map();
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0 && t.length <= 80 && /\p{L}/u.test(t) && !/\d/.test(t) && !/[.!?,;:]$/.test(t)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return lines.filter(line => (counts.get(line.trim()) || 0) < 2);
}
function splitPlainReferences(refText) {
  const lines = referenceLines(refText);
  const entries = [];
  let current = '', marked = false;
  for (const line of lines) {
    if (LABEL_RE.test(line)) {
      if (current.trim()) entries.push(current.trim());
      current = line.replace(LABEL_RE, '');
      marked = true;
    } else {
      current += (current ? ' ' : '') + line.trim();
    }
  }
  if (current.trim()) entries.push(current.trim());
  if (!marked && entries.length <= 1) {
    const rebuilt = [];
    current = '';
    const newEntryRe = /^\s*\p{Lu}[\p{L}\p{M}'\x60&.\-¨]*(?:\s+(?:\p{Lu}[\p{L}\p{M}'\x60&.\-¨]*|and|et al\.?)){0,10}(?:,|\.)/u;
    const completeEntry = text => /\b(?:19|20)\d{2}[a-z]?\s*[.,)]\s*$/i.test(text.trim()) || /https?:\s*\/\/[\s\S]+[.)\]]\s*$/i.test(text.trim());
    for (const line of lines) {
      const t = line.trim();
      if (newEntryRe.test(t) && current.trim().length > 25 && completeEntry(current)) {
        rebuilt.push(current.trim()); current = t;
      } else current += (current ? ' ' : '') + t;
    }
    if (current.trim()) rebuilt.push(current.trim());
    if (rebuilt.length > entries.length) return rebuilt.filter(x => x.length > 15);
  }
  return entries.filter(x => x.length > 15);
}
export function splitLabeledReferencesWeb(refText) {
  if (!refText) return [];
  const out = [];
  let current = null;
  const flush = () => {
    if (current && current.raw.trim().length > 15) out.push({ ...current, raw: current.raw.trim() });
    current = null;
  };
  for (const line of String(refText).split('\n')) {
    const match = line.match(LABEL_RE);
    if (match) {
      flush();
      const label = match[1].trim();
      current = { label, number: labelNumber(label), raw: line.slice(match[0].length).trim() };
    } else if (current) current.raw += ' ' + line.trim();
    else if (line.trim()) current = { label: '', number: null, raw: line.trim() };
  }
  flush();
  if (out.length <= 1 && out[0] && !out[0].label) {
    const plain = splitPlainReferences(refText);
    if (plain.length > 1) return plain.map(raw => ({ label: '', number: null, raw }));
  }
  return out;
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim(); }
function normDoi(s) { return String(s || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/[.,;)>\]]+$/, ''); }
function arxivOf(doi) {
  const s = String(doi || '');
  const m = s.match(/^arxiv:(\d{4}\.\d{4,5}|[a-z\-]+\/\d{7})(?:v\d+)?$/i) || s.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5}|[a-z\-]+\/\d{7})/i);
  return m ? m[1] : '';
}
function rawIds(raw) {
  const dm = String(raw).match(DOI_RE), doi = dm ? normDoi(dm[0]) : '';
  const am = String(raw).match(/arxiv[:\s]*(\d{4}\.\d{4,5}|[a-z\-]+\/\d{7})(?:v\d+)?/i);
  return { doi, arxivId: (am ? am[1] : arxivOf(doi)).toLowerCase() };
}
function targetIds(target) {
  const doi = normDoi(target && target.doi);
  return { doi, arxivId: String((target && target.arxivId) || arxivOf(doi)).toLowerCase() };
}
function coverage(raw, title) {
  const wanted = new Set(norm(title).split(' ').filter(Boolean));
  if (wanted.size < 2) return 0;
  const hay = new Set(norm(raw).split(' ').filter(Boolean));
  let hit = 0;
  for (const token of wanted) if (hay.has(token)) hit++;
  const score = hit / wanted.size;
  return wanted.size <= 4 ? (score === 1 ? score : 0) : score;
}
function score(raw, target) {
  if (!target) return 0;
  const a = rawIds(raw), b = targetIds(target);
  if (a.arxivId && b.arxivId && a.arxivId === b.arxivId) return 1;
  if (a.doi && b.doi && a.doi === b.doi) return 1;
  const c = coverage(raw, target.title);
  return c >= 0.85 ? c : 0;
}
function best(raw, candidates) {
  let hit = null, bestScore = 0;
  for (const candidate of candidates || []) {
    const s = score(raw, candidate);
    if (s > bestScore) { hit = candidate; bestScore = s; }
  }
  return hit;
}
function surname(raw) {
  const s = String(raw).slice(0, 160);
  const initial = s.match(/^\s*(?:\p{Lu}\.(?:\s*|$)){1,3}(\p{Lu}[\p{L}\p{M}'\x60\-]+)/u);
  if (initial) return initial[1].toLowerCase();
  const full = s.match(/^\s*(\p{Lu}[\p{L}\p{M}'\x60¨\-]+(?:\s+(?:\p{Lu}[\p{L}\p{M}'\x60¨\-]*|de|van|von|der|den|di|da|del|la)){0,5})/u);
  if (!full) return '';
  const words = full[1].split(/\s+/);
  return words[words.length - 1].toLowerCase();
}
function year(raw) { const m = String(raw).match(/\b(?:19|20)\d{2}\b/); return m ? m[0] : ''; }
function stripFullNameAuthors(s) {
  const name = String.raw`\p{Lu}[\p{L}\p{M}'\x60¨\-]+(?:\s+(?:\p{Lu}[\p{L}\p{M}'\x60¨\-]*|\p{Lu}\.|de|van|von|der|den|di|da|del|la)){0,5}`;
  const m = s.match(new RegExp(String.raw`^\s*${name}(?:\s*,\s*${name})*(?:\s*,?\s*(?:and|&)\s*${name})?\.\s+`, 'u'));
  return m ? s.slice(m[0].length) : null;
}
function guessTitle(raw) {
  const quoted = String(raw).match(/[“"]([^”"]{15,300})[”"]/);
  if (quoted) return quoted[1];
  const apa = String(raw).match(/\((?:19|20)\d{2}[a-z]?\)\.?\s+([^.]{15,300}?)(?:\.\s|\.$|$)/);
  if (apa) return apa[1].trim();
  let s = String(raw)
    .replace(/\bdoi[:\s]*10\.\S+/i, ' ')
    .replace(/\barxiv[:\s]*(preprint\s+)?(arXiv:)?\d{4}\.\d{4,5}(v\d+)?/i, ' ')
    .replace(/https?:\s*\/\/\S+/g, ' ');
  const etAl = s.match(/^\s*.*?\bet al\.\s+/);
  const stripped = etAl ? s.slice(etAl[0].length) : stripFullNameAuthors(s);
  if (stripped !== null) {
    const title = stripped.split(/(?<=[.?!])\s+/)[0].trim().replace(/\.$/, '').replace(/,\s*volume\s+\d+\s*$/i, '');
    return title.length >= 2 ? title.slice(0, 300) : '';
  }
  s = s.replace(/^\s*(((?:[A-Z]\.\s*){0,3}[A-Z][A-Za-zÀ-ÿ'\-]+|[A-Z][A-Za-zÀ-ÿ'\-]+,\s*(?:[A-Z]\.\s*){1,3})(\s*,\s*|\s+and\s+|\s*&\s*))*/, '');
  const segments = s.split(/(?<=[.?!])\s+/).map(x => x.trim()).filter(x => x.length > 10);
  segments.sort((a, b) => b.length - a.length);
  return segments[0] ? segments[0].replace(/\.$/, '').slice(0, 300) : '';
}
function publicPaper(p) { return p ? { ...p, refText: undefined, externalRefs: undefined } : null; }

export function buildCitationIndexWeb(paper, papers) {
  if (!paper) return [];
  const entries = splitLabeledReferencesWeb(paper.refText || '');
  const library = (papers || []).filter(p => p && p.id !== paper.id);
  const external = Array.isArray(paper.externalRefs) ? paper.externalRefs.filter(e => e.dir === 'out') : [];
  return entries.map((entry, i) => {
    const lib = best(entry.raw, library);
    const ext = lib ? null : best(entry.raw, external);
    const target = lib || ext || {};
    return {
      id: 'ref_' + (i + 1), order: i + 1, label: entry.label, number: entry.number,
      surname: surname(entry.raw), year: year(entry.raw) || String(target.year || ''), raw: entry.raw,
      title: target.title || guessTitle(entry.raw) || entry.raw.slice(0, 180),
      kind: lib ? 'library' : (ext ? 'external' : 'raw'), paper: publicPaper(lib), external: ext || null,
    };
  });
}
