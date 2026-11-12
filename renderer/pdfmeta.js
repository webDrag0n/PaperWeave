// PaperWeave 网页模式下的 PDF 元数据提取（与主进程 importer.js 同逻辑，基于浏览器 pdf.js）
import * as pdfjs from 'pdfjs';
import { inferPublicationYear, arxivStampId } from './pubyear.js';

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
const ARXIV_RE = /arXiv:(\d{4}\.\d{4,5})(v\d+)?/i;

function cleanText(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function itemsToRichLines(items) {
  const lines = [];
  let cur = [], curY = null, curSize = 0;
  const flush = () => {
    const text = cur.join('').trim();
    if (text) lines.push({ text, size: curSize });
    cur = []; curSize = 0; curY = null;
  };
  for (const it of items) {
    const y = it.transform ? Math.round(it.transform[5]) : null;
    const size = it.transform ? Math.max(Math.abs(it.transform[0] || 0), Math.abs(it.transform[3] || 0)) : 0;
    const str = it.str || '';
    if (curY === null || (y !== null && Math.abs(y - curY) <= 2)) {
      cur.push(str);
      curSize = Math.max(curSize, size);
      if (curY === null) curY = y;
    } else {
      flush();
      cur.push(str); curSize = size; curY = y;
    }
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

function itemsToLines(items) {
  return itemsToRichLines(items).map(l => l.text);
}

function guessTitleByFontSize(richLines) {
  const head = richLines.slice(0, 40).filter(l => l.text.length >= 4 && l.size > 0);
  if (!head.length) return '';
  const maxSize = Math.max(...head.map(l => l.size));
  const startIdx = head.findIndex(l => l.size >= maxSize * 0.9);
  if (startIdx < 0) return '';
  const parts = [];
  for (let i = startIdx; i < head.length && parts.length < 3; i++) {
    if (head[i].size >= maxSize * 0.75) parts.push(head[i].text);
    else break;
  }
  const title = parts.join(' ').replace(/\s+/g, ' ').trim();
  return title.length >= 6 ? title.slice(0, 300) : '';
}

export async function extractPdfInfoWeb(buffer) {
  const doc = await pdfjs.getDocument({ data: buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer) }).promise;
  const out = { title: '', authors: [], year: '', doi: '', abstract: '', pageCount: doc.numPages, refText: '' };

  let creationDate = '';
  try {
    const meta = await doc.getMetadata();
    const info = (meta && meta.info) || {};
    creationDate = info.CreationDate || '';
    if (info.Title && cleanText(info.Title).length > 4) out.title = cleanText(info.Title);
    if (info.Author) out.authors = String(info.Author).split(/[;,]/).map(s => cleanText(s)).filter(Boolean);
  } catch (_) {}

  const headPageCount = Math.min(3, doc.numPages);
  let headLines = [], headRich = [], headText = '';
  for (let i = 1; i <= headPageCount; i++) {
    try {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const rich = itemsToRichLines(tc.items);
      headText += rich.map(l => l.text).join('\n') + '\n';
      if (i === 1) { headRich = rich; headLines = rich.map(l => l.text); }
    } catch (_) {}
  }

  let tailText = '';
  if (doc.numPages > headPageCount) {
    try {
      const page = await doc.getPage(doc.numPages);
      const tc = await page.getTextContent();
      tailText = itemsToLines(tc.items).join('\n');
    } catch (_) {}
  }
  // 论文自身的标识只可能出现在首页：首页 DOI → 首页 arXiv 盖章；其余位置多半属于参考文献，只作兜底
  const trimDoi = (s) => s.replace(/[.,;)>\]]+$/, '');
  const firstPageText = headLines.join('\n');
  const firstPageDoi = firstPageText.match(DOI_RE);
  const stampId = arxivStampId(firstPageText);
  let ownDoi = '';
  if (firstPageDoi) ownDoi = trimDoi(firstPageDoi[0]);
  else if (stampId) ownDoi = 'arXiv:' + stampId;
  if (ownDoi) {
    out.doi = ownDoi;
  } else {
    const doiMatch = (headText + '\n' + tailText).match(DOI_RE);
    if (doiMatch) {
      out.doi = trimDoi(doiMatch[0]);
    } else {
      const ax = (headText + '\n' + tailText).match(ARXIV_RE);
      if (ax) out.doi = 'arXiv:' + ax[1];
    }
  }

  if (!out.title) {
    out.title = guessTitleByFontSize(headRich);
  }
  if (!out.title) {
    const candidates = headLines.slice(0, 8).filter(l => l.length > 12 && !/^\d+$/.test(l));
    candidates.sort((a, b) => b.length - a.length);
    if (candidates[0]) out.title = cleanText(candidates[0]).slice(0, 300);
  }
  if (!out.authors.length && out.title) {
    const tIdx = headLines.findIndex(l => l.includes(out.title.slice(0, 30)));
    for (let i = Math.max(0, tIdx); i < Math.min(headLines.length, (tIdx < 0 ? 0 : tIdx) + 5); i++) {
      const l = headLines[i];
      if (l === out.title) continue;
      if (/^[A-Z][a-zA-Z.\- ]+(, [A-Z][a-zA-Z.\- ]+)+/.test(l) && l.length < 200 && !/abstract|university|department|@/i.test(l)) {
        out.authors = l.split(/,| and /).map(s => cleanText(s)).filter(s => s.length > 2).slice(0, 12);
        break;
      }
    }
  }
  const absM = headText.match(/abstract[.\s:—-]*([\s\S]{80,1200}?)(\n\s*\n|\n\s*1[.\s]|\n\s*I[.\s]|introduction|keywords|index terms)/i);
  if (absM) out.abstract = cleanText(absM[1]).slice(0, 1500);

  out.refText = await extractRefTextWeb(doc);
  // 年份：arXiv 编号 → 首页出版标记 → 受参考文献约束的创建日期；都没有则留空（与主进程一致）
  out.year = inferPublicationYear({ firstPageLines: headLines, ownDoi, creationDate, refText: out.refText });

  try { doc.destroy(); } catch (_) {}
  return out;
}

function findReferencesBodyWeb(full) {
  const lines = String(full || '').split('\n').filter(line => {
    const t = line.trim();
    return !/^Published as a conference paper at\b/i.test(t) && !/^\d{1,4}$/.test(t);
  });
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^(references|bibliography)\b/i.test(l) && l.length <= 30 && !/\[\d+\]/.test(l)) idx = i;
  }
  if (idx < 0) return null;
  const body = lines.slice(idx + 1);
  let entryStarts = 0;
  let cut = -1;
  for (let i = 0; i < body.length; i++) {
    const t = body[i].trim();
    if (/^\s*(\[\d+\]|\d{1,3}[.)])\s+/.test(t)) entryStarts++;
    const appendix = /^(appendix|supplementary material|checklist)\b/i.test(t)
      || /^[A-Z](?:\.?\s+)+[A-Z][A-Z\s-]{3,}$/.test(t);
    const meaningful = entryStarts >= 1 || body.slice(0, i).join('\n').length > 200;
    if (meaningful && t.length < 100 && appendix) { cut = i; break; }
  }
  const text = (cut >= 0 ? body.slice(0, cut) : body).join('\n').trim();
  const hasYear = /\b(?:19|20)\d{2}[a-z]?\b/.test(text);
  return (entryStarts >= 1 || hasYear) && text.length > 40 ? text.slice(0, 40000) : null;
}

async function extractRefTextWeb(doc) {
  const pages = new Map();
  for (const w of [6, 12, 24, Number.MAX_SAFE_INTEGER]) {
    const start = Math.max(1, doc.numPages - w + 1);
    for (let i = start; i <= doc.numPages; i++) {
      if (pages.has(i)) continue;
      let text = '';
      try {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        text = itemsToLines(tc.items).join('\n');
      } catch (_) {}
      pages.set(i, text);
      if (pages.size % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const full = [];
    for (let i = start; i <= doc.numPages; i++) full.push(pages.get(i) || '');
    const body = findReferencesBodyWeb(full.join('\n'));
    if (body) return body;
    if (start === 1) break;
  }
  return '';
}
