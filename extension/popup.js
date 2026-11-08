// PaperWeave Connector 弹出页：立即展示进度，自动连接并选择目标论文库
const isZh = (chrome.i18n && chrome.i18n.getUILanguage() || 'zh').toLowerCase().startsWith('zh');
const S = (zh, en) => (isZh ? zh : en);
const $ = (s) => document.querySelector(s);

function applyI18n() {
  document.querySelectorAll('[data-zh]').forEach(el => {
    el.textContent = S(el.dataset.zh, el.dataset.en || el.dataset.zh);
  });
}

function show(viewId) {
  for (const id of ['loadingView', 'errorView', 'paperView', 'noPaperView']) {
    $('#' + id).classList.toggle('hidden', id !== viewId);
  }
}

let lastStage = '';
function setProgress(percent, text) {
  if (lastStage && lastStage !== text) {
    const item = document.createElement('li');
    item.textContent = '✓ ' + lastStage;
    const log = $('#loadingLog');
    log.appendChild(item);
    while (log.children.length > 4) log.firstChild.remove();
  }
  lastStage = text;
  $('#loadingStage').textContent = text;
  $('#loadingBar').style.width = percent + '%';
  $('#loadingBar').parentElement.setAttribute('aria-valuenow', String(percent));
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

function renderLibraries(data) {
  const select = $('#librarySelect');
  select.innerHTML = '';
  for (const lib of data.libraries) {
    const option = document.createElement('option');
    option.value = lib.id;
    option.textContent = `${lib.icon || '📚'} ${lib.name || lib.id}`;
    select.appendChild(option);
  }
  const saved = localStorage.getItem('pw-last-library');
  select.value = data.libraries.some(lib => lib.id === saved) ? saved : data.current;
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
  show('loadingView');
  $('#loadingLog').innerHTML = '';
  lastStage = '';
  $('#connDot').className = 'conn-dot';
  setProgress(5, S('正在读取当前页面…', 'Reading the current page…'));
  const tabPromise = chrome.tabs.query({ active: true, currentWindow: true });
  setProgress(20, S('正在自动检测并连接 PaperWeave…', 'Detecting and connecting to PaperWeave…'));
  const connectPromise = chrome.runtime.sendMessage({ type: 'pw:connect' });
  const [tabs, connected] = await Promise.all([tabPromise, connectPromise]);
  if (!connected || !connected.ok || !connected.authed) {
    throw new Error((connected && connected.error) || S('无法连接 PaperWeave，请先打开桌面端', 'Cannot connect. Open PaperWeave first'));
  }
  $('#connDot').className = 'conn-dot ok';
  setProgress(50, S('已连接，正在获取论文库列表…', 'Connected. Loading libraries…'));
  const librariesPromise = chrome.runtime.sendMessage({ type: 'pw:libraries' });
  setProgress(65, S('正在识别页面论文信息…', 'Extracting paper metadata…'));
  const tab = tabs && tabs[0];
  const metaPromise = tab && /^https?:/.test(tab.url || '') ? detectPaper(tab) : Promise.resolve(null);
  const [libraries, meta] = await Promise.all([librariesPromise, metaPromise]);
  if (!libraries || !libraries.ok) throw new Error((libraries && libraries.error) || S('论文库列表获取失败', 'Failed to load libraries'));
  renderLibraries(libraries);
  $('#connStatus').textContent = S(`已连接 · ${libraries.libraries.length} 个论文库`, `Connected · ${libraries.libraries.length} libraries`);
  setProgress(90, S('正在准备保存选项…', 'Preparing save options…'));
  if (meta && (meta.pdfUrl || meta.title)) renderPaper(meta);
  else show('noPaperView');
  setProgress(100, S('已就绪', 'Ready'));
}

$('#saveBtn').addEventListener('click', async () => {
  if (!currentMeta) return;
  const btn = $('#saveBtn');
  const box = $('#resultBox');
  btn.disabled = true;
  box.classList.add('hidden');
  try {
    btn.textContent = S('⏳ 正在确认连接…', '⏳ Checking connection…');
    const connected = await chrome.runtime.sendMessage({ type: 'pw:connect' });
    if (!connected || !connected.ok || !connected.authed) throw new Error((connected && connected.error) || S('无法连接桌面端', 'Cannot connect to desktop'));
    const libraryName = $('#librarySelect').selectedOptions[0] ? $('#librarySelect').selectedOptions[0].textContent : '';
    btn.textContent = S('⏳ 正在下载并保存…', '⏳ Downloading and saving…');
    const r = await chrome.runtime.sendMessage({
      type: 'pw:import',
      meta: { ...currentMeta, libraryId: $('#librarySelect').value },
    });
    box.classList.remove('hidden');
    if (r && r.ok) {
      box.classList.remove('err');
      const title = r.paper && r.paper.title ? r.paper.title : '';
      box.innerHTML = (r.duplicate ? S('✓ 库中已存在，已复用', '✓ Already in library, reused') : S('✓ 已入库', '✓ Saved'))
        + S(` 到「${libraryName}」`, ` to “${libraryName}”`)
        + (title ? `<div class="r-title">${escapeHtml(title)}</div>` : '');
      btn.textContent = S('✓ 完成', '✓ Done');
    } else {
      throw new Error((r && r.error) || S('未知错误', 'Unknown error'));
    }
  } catch (e) {
    box.classList.remove('hidden');
    box.classList.add('err');
    box.textContent = S('保存失败：', 'Failed: ') + e.message;
    btn.disabled = false;
    btn.textContent = S('📥 重试', '📥 Retry');
  }
});

$('#librarySelect').addEventListener('change', (e) => {
  localStorage.setItem('pw-last-library', e.target.value);
});
$('#retryBtn').addEventListener('click', () => {
  refresh().catch(showError);
});
function showError(error) {
  $('#connDot').className = 'conn-dot err';
  $('#errorText').textContent = error && error.message ? error.message : String(error);
  $('#connStatus').textContent = S('连接或加载失败', 'Connection or loading failed');
  show('errorView');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const openOpts = () => chrome.runtime.openOptionsPage();
$('#openOptions1').addEventListener('click', openOpts);
$('#openOptions2').addEventListener('click', openOpts);

// 立即渲染加载界面；异步工作只更新阶段，不阻塞弹窗首屏。
refresh().catch(showError);
