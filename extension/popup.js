// PaperWeave Connector 弹出页逻辑
const isZh = (chrome.i18n && chrome.i18n.getUILanguage() || 'zh').toLowerCase().startsWith('zh');
const S = (zh, en) => (isZh ? zh : en);

const $ = (s) => document.querySelector(s);

function applyI18n() {
  document.querySelectorAll('[data-zh]').forEach(el => {
    el.textContent = S(el.dataset.zh, el.dataset.en || el.dataset.zh);
  });
}

function show(viewId) {
  for (const id of ['setupView', 'paperView', 'noPaperView']) {
    $('#' + id).classList.toggle('hidden', id !== viewId);
  }
}

const KIND_LABEL = {
  arxiv: 'arXiv',
  pdf: 'PDF',
  'webpage-pdf': S('网页 · PDF', 'Web · PDF'),
  webpage: S('网页', 'Webpage'),
};

let currentMeta = null;

async function detectPaper(tab) {
  let meta = null;
  try {
    meta = await chrome.tabs.sendMessage(tab.id, { type: 'pw:extract' });
  } catch (_) { /* PDF 查看器等页面无法注入 */ }

  if (meta && meta.kind !== 'error' && (meta.pdfUrl || meta.title)) return meta;

  // 回退：按 URL 推断（arXiv PDF / 直链 PDF）
  const url = tab.url || '';
  const mPdf = url.match(/arxiv\.org\/pdf\/([^?#]+)/i);
  if (mPdf) {
    const id = mPdf[1].replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
    const extra = await chrome.runtime.sendMessage({ type: 'pw:arxivMeta', absUrl: 'https://arxiv.org/abs/' + id }) || {};
    return { kind: 'arxiv', url, pdfUrl: url, ...extra };
  }
  if (/\.pdf($|[?#])/i.test(url)) {
    return { kind: 'pdf', url, pdfUrl: url, title: (tab.title || '').replace(/\.pdf$/i, ''), authors: [] };
  }
  return meta && meta.kind !== 'error' ? meta : null;
}

function renderPaper(meta) {
  currentMeta = meta;
  $('#paperKind').textContent = KIND_LABEL[meta.kind] || meta.kind;
  $('#paperTitle').textContent = meta.title || S('（未识别标题，将按 PDF 内容提取）', '(Title will be extracted from the PDF)');
  $('#paperAuthors').textContent = (meta.authors || []).slice(0, 4).join(', ') + ((meta.authors || []).length > 4 ? ' …' : '');
  const bits = [];
  if (meta.year) bits.push(meta.year);
  if (meta.venue) bits.push(meta.venue);
  if (meta.doi) bits.push(meta.doi);
  $('#paperMeta').textContent = bits.join(' · ');
  show('paperView');
}

async function refresh() {
  applyI18n();
  const cfg = await chrome.storage.sync.get(['serverUrl', 'token']);
  if (!cfg.token) {
    show('setupView');
    $('#connStatus').textContent = S('未配置', 'Not configured');
    $('#connDot').className = 'conn-dot err';
    return;
  }

  // 连接状态
  const pong = await chrome.runtime.sendMessage({ type: 'pw:ping' });
  if (pong && pong.ok && pong.authed) {
    $('#connDot').className = 'conn-dot ok';
    $('#connStatus').textContent = S(`已连接 · 库内 ${pong.status ? pong.status.papers : '?'} 篇`, `Connected · ${pong.status ? pong.status.papers : '?'} papers`);
  } else if (pong && pong.ok) {
    $('#connDot').className = 'conn-dot err';
    $('#connStatus').textContent = S('已连接，但令牌无效', 'Connected, token invalid');
  } else {
    $('#connDot').className = 'conn-dot err';
    $('#connStatus').textContent = (pong && pong.error) || S('未连接', 'Disconnected');
  }

  // 识别当前页面
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) { show('noPaperView'); return; }
  const meta = await detectPaper(tab);
  if (meta && (meta.pdfUrl || meta.title)) renderPaper(meta);
  else show('noPaperView');
}

$('#saveBtn').addEventListener('click', async () => {
  if (!currentMeta) return;
  const btn = $('#saveBtn');
  const box = $('#resultBox');
  btn.disabled = true;
  btn.textContent = S('⏳ 正在下载入库…', '⏳ Downloading…');
  box.classList.add('hidden');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'pw:import', meta: currentMeta });
    box.classList.remove('hidden');
    if (r && r.ok) {
      box.classList.remove('err');
      const title = r.paper && r.paper.title ? r.paper.title : '';
      box.innerHTML = r.duplicate
        ? S('✓ 库中已存在，已复用', '✓ Already in library, reused') + (title ? `<div class="r-title">${escapeHtml(title)}</div>` : '')
        : S('✓ 已入库', '✓ Saved') + (title ? `<div class="r-title">${escapeHtml(title)}</div>` : '');
      btn.textContent = S('✓ 完成', '✓ Done');
    } else {
      box.classList.add('err');
      box.textContent = S('保存失败：', 'Failed: ') + ((r && r.error) || S('未知错误', 'unknown'));
      btn.disabled = false;
      btn.textContent = S('📥 重试', '📥 Retry');
    }
  } catch (e) {
    box.classList.remove('hidden');
    box.classList.add('err');
    box.textContent = S('保存失败：', 'Failed: ') + e.message;
    btn.disabled = false;
    btn.textContent = S('📥 重试', '📥 Retry');
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const openOpts = () => chrome.runtime.openOptionsPage();
$('#openOptions1').addEventListener('click', openOpts);
$('#openOptions2').addEventListener('click', openOpts);

refresh();
