// 正文悬浮引用使用的本地索引：保留编号与作者年份，不发起网络请求。
const { splitReferenceEntries, guessRefTitle, extractArxivId } = require('./refs');

const LABEL_RE = /^\s*(\[\d{1,3}\]|\d{1,3}[.)]\s|\[[A-Za-z][A-Za-z0-9+&.'\-]{0,13}\d{2,4}[a-z]?\])\s*/;
const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

function labelNumber(label) {
  if (/^\[\d{1,3}\]$/.test(label) || /^\d{1,3}[.)]$/.test(label)) return parseInt(label.match(/\d{1,3}/)[0], 10);
  return null;
}

function splitLabeledReferences(refText) {
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
    } else if (current) {
      current.raw += ' ' + line.trim();
    } else if (line.trim()) {
      current = { label: '', number: null, raw: line.trim() };
    }
  }
  flush();
  // 无编号列表沿用项目已有的作者行切分逻辑。
  if (out.length <= 1 && out[0] && !out[0].label) {
    const plain = splitReferenceEntries(refText);
    if (plain.length > 1) return plain.map(raw => ({ label: '', number: null, raw }));
  }
  return out;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
}
function normDoi(s) {
  return String(s || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/[.,;)>\]]+$/, '');
}
function rawIdentifiers(raw) {
  const doiMatch = String(raw).match(DOI_RE);
  const doi = doiMatch ? normDoi(doiMatch[0]) : '';
  const axMatch = String(raw).match(/arxiv[:\s]*(\d{4}\.\d{4,5}|[a-z\-]+\/\d{7})(?:v\d+)?/i);
  return { doi, arxivId: axMatch ? axMatch[1].toLowerCase() : (extractArxivId(doi) || '').toLowerCase() };
}
function targetIdentifiers(target) {
  const doi = normDoi(target && target.doi);
  return {
    doi,
    arxivId: String((target && target.arxivId) || extractArxivId(doi) || '').toLowerCase(),
  };
}
function titleCoverage(raw, title) {
  const wanted = new Set(norm(title).split(' ').filter(Boolean));
  if (wanted.size < 2) return 0;
  const hay = new Set(norm(raw).split(' ').filter(Boolean));
  let hit = 0;
  for (const token of wanted) if (hay.has(token)) hit++;
  const score = hit / wanted.size;
  return wanted.size <= 4 ? (score === 1 ? score : 0) : score;
}
function matchScore(raw, target) {
  if (!target) return 0;
  const a = rawIdentifiers(raw), b = targetIdentifiers(target);
  if (a.arxivId && b.arxivId && a.arxivId === b.arxivId) return 1;
  if (a.doi && b.doi && a.doi === b.doi) return 1;
  const coverage = titleCoverage(raw, target.title);
  return coverage >= 0.85 ? coverage : 0;
}
function bestMatch(raw, candidates) {
  let best = null, bestScore = 0;
  for (const candidate of candidates || []) {
    const score = matchScore(raw, candidate);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}
function firstSurname(raw) {
  const m = String(raw).slice(0, 160).match(/^\s*(?:[A-Z]\.(?:\s*|$)){0,3}([A-Z][A-Za-zÀ-ÿ'\-]+)/);
  return m ? m[1].toLowerCase() : '';
}
function firstYear(raw) {
  const m = String(raw).match(/\b(?:19|20)\d{2}\b/);
  return m ? m[0] : '';
}
function publicPaper(p) {
  return p ? { ...p, refText: undefined, externalRefs: undefined } : null;
}

function buildCitationIndex(paper, papers) {
  if (!paper) return [];
  const entries = splitLabeledReferences(paper.refText || '');
  const library = (papers || []).filter(p => p && p.id !== paper.id);
  const external = Array.isArray(paper.externalRefs) ? paper.externalRefs.filter(e => e.dir === 'out') : [];
  return entries.map((entry, i) => {
    const lib = bestMatch(entry.raw, library);
    const ext = lib ? null : bestMatch(entry.raw, external);
    const target = lib || ext || {};
    const title = target.title || guessRefTitle(entry.raw) || entry.raw.slice(0, 180);
    return {
      id: 'ref_' + (i + 1),
      order: i + 1,
      label: entry.label,
      number: entry.number,
      surname: firstSurname(entry.raw),
      year: firstYear(entry.raw) || String(target.year || ''),
      raw: entry.raw,
      title,
      kind: lib ? 'library' : (ext ? 'external' : 'raw'),
      paper: publicPaper(lib),
      external: ext || null,
    };
  });
}

module.exports = { buildCitationIndex, splitLabeledReferences };
