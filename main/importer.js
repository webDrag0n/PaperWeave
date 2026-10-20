// PaperGraph 导入器：PDF 元数据提取（pdf.js Node 版）、DOI 识别、参考文献段落提取
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdfjs-dist v4 legacy 构建可在 Node/Electron 主进程中运行（仅文本提取，无渲染）
      // Node 环境下自动使用 fake worker，无需设置 workerSrc
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    })();
  }
  return pdfjsPromise;
}

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
const ARXIV_RE = /arXiv:(\d{4}\.\d{4,5})(v\d+)?/i;

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// 从文本项重建按行文本（带最大字号）
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

// 标题猜测：首页字号最大的连续若干行（论文标题通常是首页最大字）
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

async function extractPdfInfo(buffer) {
  const pdfjs = await loadPdfjs();
  // Node Buffer 需转成纯 Uint8Array（pdf.js 拒绝 Buffer 实例）
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const out = {
    title: '', authors: [], year: '', doi: '', abstract: '', venue: '',
    pageCount: doc.numPages, refText: '',
  };

  // 1) PDF 元数据
  try {
    const meta = await doc.getMetadata();
    const info = (meta && meta.info) || {};
    if (info.Title && cleanText(info.Title).length > 4) out.title = cleanText(info.Title);
    if (info.Author) out.authors = String(info.Author).split(/[;,]/).map(s => cleanText(s)).filter(Boolean);
  } catch (_) {}

  // 2) 前几页文本：标题/作者/DOI/摘要
  const headPageCount = Math.min(3, doc.numPages);
  let headLines = [], headRich = [];
  let headText = '';
  for (let i = 1; i <= headPageCount; i++) {
    try {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const rich = itemsToRichLines(tc.items);
      headText += rich.map(l => l.text).join('\n') + '\n';
      if (i === 1) { headRich = rich; headLines = rich.map(l => l.text); }
    } catch (_) {}
    // 让出事件循环：批量导入/下载时避免主进程长时间占用
    await new Promise(r => setImmediate(r));
  }

  // DOI：前三页 + 最后一页
  let tailText = '';
  if (doc.numPages > headPageCount) {
    try {
      const page = await doc.getPage(doc.numPages);
      const tc = await page.getTextContent();
      tailText = itemsToLines(tc.items).join('\n');
    } catch (_) {}
  }
  const doiMatch = (headText + '\n' + tailText).match(DOI_RE);
  if (doiMatch) {
    let doi = doiMatch[0].replace(/[.,;)>\]]+$/, '');
    out.doi = doi;
  } else {
    const ax = (headText + '\n' + tailText).match(ARXIV_RE);
    if (ax) out.doi = 'arXiv:' + ax[1];
  }

  // 标题猜测：优先首页最大字号行；退化到最长行
  if (!out.title) {
    out.title = guessTitleByFontSize(headRich);
  }
  if (!out.title) {
    const candidates = headLines.slice(0, 8).filter(l => l.length > 12 && !/^\d+$/.test(l));
    candidates.sort((a, b) => b.length - a.length);
    if (candidates[0]) out.title = cleanText(candidates[0]).slice(0, 300);
  }
  // 作者猜测：标题之后的第一个短行（含逗号分隔的人名）
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

  // 摘要
  const absM = headText.match(/abstract[.\s:—-]*([\s\S]{80,1200}?)(\n\s*\n|\n\s*1[.\s]|\n\s*I[.\s]|introduction|keywords|index terms)/i);
  if (absM) out.abstract = cleanText(absM[1]).slice(0, 1500);

  // 年份
  const yM = headText.match(/\b(19|20)\d{2}\b/);
  if (yM) out.year = yM[0];

  // 3) 参考文献段落：从尾部向前自适应扩窗查找 References 标题
  // （长论文的参考文献常位于正文后、附录前，固定扫最后 6 页会漏掉）
  out.refText = await extractRefText(doc, itemsToLines);

  try { doc.destroy(); } catch (_) {}
  return out;
}

// 从已拼接的行文本中定位 References 正文：取最后一个短标题行，跳过目录行
function findReferencesBody(full) {
  const lines = full.split('\n');
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    // 标题行：以 References/Bibliography 开头、整行很短、不含条目编号（排除目录长行与引用条目）
    if (/^(references|bibliography)\b/i.test(l) && l.length <= 30 && !/\[\d+\]/.test(l)) idx = i;
  }
  if (idx < 0) return null;
  const body = lines.slice(idx + 1);
  // 参考文献之后的附录正文会被无编号行粘到最后一条上；出现附录类短标题且已有足够条目时截断
  let entryStarts = 0;
  const cut = body.findIndex(l => {
    if (/^\s*(\[\d+\]|\d{1,2}[.)])\s+/.test(l)) entryStarts++;
    const t = l.trim();
    return entryStarts >= 5 && t.length < 40 && /^(appendix|supplementary material|checklist|a\.?\s+appendix)\b/i.test(t);
  });
  const text = (cut >= 0 ? body.slice(0, cut) : body).join('\n');
  // 接受门槛：至少 1 个条目起始且正文不太短（样例/短文参考文献可能不足 200 字符）
  return entryStarts >= 1 && text.length > 40 ? text.slice(0, 40000) : null;
}

async function extractRefText(doc, itemsToLines) {
  // 窗口逐步扩大：6 → 12 → 24 → 全文；每扩一次尝试匹配，命中即返回
  const windows = [6, 12, 24, Number.MAX_SAFE_INTEGER];
  let nextFrom = doc.numPages + 1;
  let full = '';
  let pageCount = 0;
  for (const w of windows) {
    const start = Math.max(1, doc.numPages - w + 1);
    if (start < nextFrom) {
      for (let i = start; i < nextFrom; i++) {
        try {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          full += itemsToLines(tc.items).join('\n') + '\n';
        } catch (_) {}
        // 每 4 页让出一次事件循环，避免长文档提取阻塞主进程
        if (++pageCount % 4 === 0) await new Promise(r => setImmediate(r));
      }
      nextFrom = start;
    }
    const body = findReferencesBody(full);
    if (body) return body;
    if (start === 1) break;
  }
  return '';
}

// 把外部文件复制进库，文件名用 hash 避免冲突
function copyIntoLibrary(libraryDir, srcPath, originalName) {
  const buf = fs.readFileSync(srcPath);
  const hash = sha1(buf);
  const ext = path.extname(originalName || srcPath).toLowerCase() || '.pdf';
  const fileName = hash.slice(0, 16) + ext;
  const dest = path.join(libraryDir, fileName);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return { fileName, hash, buffer: buf };
}

function bufferIntoLibrary(libraryDir, buf, nameHint) {
  const hash = sha1(buf);
  const ext = (path.extname(nameHint || '').toLowerCase()) || '.pdf';
  const fileName = hash.slice(0, 16) + ext;
  const dest = path.join(libraryDir, fileName);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return { fileName, hash };
}

module.exports = { extractPdfInfo, copyIntoLibrary, bufferIntoLibrary, sha1, loadPdfjs };
