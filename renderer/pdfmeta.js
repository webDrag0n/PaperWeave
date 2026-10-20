// PaperGraph 网页模式下的 PDF 元数据提取（与主进程 importer.js 同逻辑，基于浏览器 pdf.js）
import * as pdfjs from 'pdfjs';

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

  try {
    const meta = await doc.getMetadata();
    const info = (meta && meta.info) || {};
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
  const doiMatch = (headText + '\n' + tailText).match(DOI_RE);
  if (doiMatch) out.doi = doiMatch[0].replace(/[.,;)>\]]+$/, '');
  else {
    const ax = (headText + '\n' + tailText).match(ARXIV_RE);
    if (ax) out.doi = 'arXiv:' + ax[1];
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
  const yM = headText.match(/\b(19|20)\d{2}\b/);
  if (yM) out.year = yM[0];

  const refStart = Math.max(1, doc.numPages - 6);
  let full = '';
  for (let i = refStart; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      full += itemsToLines(tc.items).join('\n') + '\n';
    } catch (_) {}
  }
  const refM = full.match(/(?:^|\n)\s*(references|bibliography)\s*\n([\s\S]+)$/i);
  if (refM) out.refText = refM[2].slice(0, 40000);

  try { doc.destroy(); } catch (_) {}
  return out;
}
