// PaperWeave Connector 内容脚本：按需提取当前页面的论文元数据
// 仅响应 popup / background 的 pw:extract 消息，平时不做任何事

function metaContent(name) {
  const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
  return el ? (el.getAttribute('content') || '').trim() : '';
}
function metaAll(name) {
  return [...document.querySelectorAll(`meta[name="${name}"]`)]
    .map(el => (el.getAttribute('content') || '').trim())
    .filter(Boolean);
}
function text(sel) {
  const el = document.querySelector(sel);
  return el ? el.textContent.trim() : '';
}

// 从 arXiv 摘要页提取（页面结构 + citation_* 双保险）
function extractArxiv() {
  const m = location.pathname.match(/^\/abs\/([^/?#]+)/);
  if (!m) return null;
  const id = m[1].replace(/v\d+$/, '');
  const title = (metaContent('citation_title') || text('h1.title').replace(/^Title:\s*/i, '')).trim();
  let authors = metaAll('citation_author');
  if (!authors.length) {
    authors = [...document.querySelectorAll('.authors a')].map(a => a.textContent.trim()).filter(Boolean);
  }
  const abstract = (metaContent('citation_abstract') || text('blockquote.abstract').replace(/^Abstract:\s*/i, '')).trim();
  const dateStr = metaContent('citation_date') || metaContent('citation_publication_date') || '';
  return {
    kind: 'arxiv',
    url: location.href,
    pdfUrl: metaContent('citation_pdf_url') || `https://arxiv.org/pdf/${id}`,
    title,
    authors,
    year: (dateStr.match(/\d{4}/) || [''])[0],
    doi: metaContent('citation_doi') || '',
    abstract,
    venue: 'arXiv',
  };
}

// 通用页面：Google Scholar / HighWire citation_* 元标签（出版商页面普遍支持）
function extractGeneric() {
  const title = metaContent('citation_title') || metaContent('dc.title') || metaContent('og:title') || document.title || '';
  const authors = metaAll('citation_author').length ? metaAll('citation_author') : metaAll('dc.creator');
  const pdfUrl = metaContent('citation_pdf_url') || '';
  const dateStr = metaContent('citation_publication_date') || metaContent('citation_date') || metaContent('dc.date') || '';
  return {
    kind: pdfUrl ? 'webpage-pdf' : 'webpage',
    url: location.href,
    pdfUrl,
    title: title.trim(),
    authors,
    year: (dateStr.match(/\d{4}/) || [''])[0],
    doi: metaContent('citation_doi') || metaContent('dc.identifier') || '',
    abstract: metaContent('citation_abstract') || metaContent('description') || metaContent('og:description') || '',
    venue: metaContent('citation_journal_title') || metaContent('citation_conference_title') || '',
  };
}

function extract() {
  try {
    if (/\.pdf($|[?#])/i.test(location.pathname)) {
      return { kind: 'pdf', url: location.href, pdfUrl: location.href, title: document.title || '', authors: [], year: '', doi: '', abstract: '', venue: '' };
    }
    if (/arxiv\.org$/.test(location.hostname)) {
      const a = extractArxiv();
      if (a) return a;
    }
    return extractGeneric();
  } catch (e) {
    return { kind: 'error', url: location.href, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'pw:extract') {
    sendResponse(extract());
  }
  return false;
});
