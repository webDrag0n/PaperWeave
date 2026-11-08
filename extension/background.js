// PaperWeave Connector 后台服务：自动发现本地桌面端，一键配对后调用 Agent API

const DEFAULT_SERVER = 'http://127.0.0.1:24680';
const LOCAL_PORT_COUNT = 21;

async function getConfig() {
  const local = await chrome.storage.local.get(['serverUrl', 'token']);
  const legacy = await chrome.storage.sync.get(['serverUrl', 'token']);
  return {
    serverUrl: (local.serverUrl || legacy.serverUrl || DEFAULT_SERVER).replace(/\/+$/, ''),
    token: local.token || legacy.token || '',
  };
}

async function probe(serverUrl) {
  try {
    const res = await fetch(serverUrl + '/api/ping', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const app = await res.json();
    return app.ok && app.name === 'PaperWeave' ? app : null;
  } catch (_) {
    return null;
  }
}

async function discover() {
  const cfg = await getConfig();
  const candidates = [...new Set([
    cfg.serverUrl,
    ...Array.from({ length: LOCAL_PORT_COUNT }, (_, i) => `http://127.0.0.1:${24680 + i}`),
  ])];
  const results = await Promise.all(candidates.map(async serverUrl => ({ serverUrl, app: await probe(serverUrl) })));
  const found = results.find(r => r.app);
  if (!found) return { ok: false, error: '未发现 PaperWeave 桌面端，请先打开应用' };
  if (found.serverUrl !== cfg.serverUrl) await chrome.storage.local.set({ serverUrl: found.serverUrl });
  return { ok: true, serverUrl: found.serverUrl, app: found.app };
}

async function apiFetch(path, { method = 'GET', body } = {}) {
  const { serverUrl, token } = await getConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000); // 下载大 PDF 给足时间
  try {
    const res = await fetch(serverUrl + path, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-PaperWeave-Token': token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function ping() {
  const found = await discover();
  if (!found.ok) return found;
  const { token } = await getConfig();
  if (!token) return { ...found, authed: false, needsPair: true };
  const st = await apiFetch('/api/status');
  if (st.status === 401) return { ...found, authed: false, needsPair: true, authError: true };
  return { ...found, authed: true, status: st.data && st.data.data };
}

async function pairConnector() {
  const found = await discover();
  if (!found.ok) return found;
  try {
    const res = await fetch(found.serverUrl + '/api/connector/pair', {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'PaperWeave Connector', extensionId: chrome.runtime.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.data || !data.data.token) {
      return { ...found, authed: false, needsPair: true, error: data.error || ('配对失败：HTTP ' + res.status) };
    }
    await chrome.storage.local.set({ serverUrl: found.serverUrl, token: data.data.token });
    return ping();
  } catch (e) {
    return { ...found, authed: false, needsPair: true, error: e.name === 'TimeoutError' ? '连接等待超时，请重试' : e.message };
  }
}

async function connect() {
  const current = await ping();
  if (current.ok && current.authed) return current;
  if (!current.ok) return current;
  return pairConnector();
}

async function listLibraries() {
  const connected = await connect();
  if (!connected.ok || !connected.authed) return { ok: false, error: connected.error || '无法连接 PaperWeave' };
  const { status, data } = await apiFetch('/api/libraries');
  if (status === 401) return { ok: false, error: '连接已失效，请重试' };
  if (!data.ok) return { ok: false, error: data.error || ('HTTP ' + status) };
  return { ok: true, current: data.data.current, libraries: data.data.libraries || [] };
}

async function importPaper(meta) {
  const connected = await connect();
  if (!connected.ok || !connected.authed) return { ok: false, error: connected.error || '无法连接 PaperWeave' };
  const payload = {
    url: meta.url,
    pdfUrl: meta.pdfUrl || undefined,
    title: meta.title || undefined,
    authors: (meta.authors || []).length ? meta.authors : undefined,
    year: meta.year || undefined,
    doi: meta.doi || undefined,
    abstract: meta.abstract || undefined,
    venue: meta.venue || undefined,
    libraryId: meta.libraryId || undefined,
  };
  const { status, data } = await apiFetch('/api/papers/import-web', { method: 'POST', body: payload });
  if (status === 401) return { ok: false, error: '连接已失效，请重试' };
  if (!data.ok) return { ok: false, error: data.error || ('HTTP ' + status) };
  return { ok: true, paper: data.data && data.data.paper, duplicate: !!(data.data && data.data.duplicate) };
}

/* ---------------- arXiv 元数据回退（PDF 查看器页面无法注入内容脚本） ---------------- */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function metaFromHtml(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  if (m) return decodeEntities(m[1]);
  // content 在前的写法
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]) : '';
}
function metaAllFromHtml(html, name) {
  const out = [];
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push(decodeEntities(m[1]));
  return out;
}

async function arxivMetaFromAbs(absUrl) {
  try {
    const res = await fetch(absUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();
    const dateStr = metaFromHtml(html, 'citation_date') || metaFromHtml(html, 'citation_online_date');
    return {
      title: metaFromHtml(html, 'citation_title'),
      authors: metaAllFromHtml(html, 'citation_author'),
      year: (dateStr.match(/\d{4}/) || [''])[0],
      doi: metaFromHtml(html, 'citation_doi'),
      abstract: metaFromHtml(html, 'citation_abstract'),
      venue: 'arXiv',
    };
  } catch (_) {
    return null;
  }
}

/* ---------------- 上下文菜单（类似 Zotero 的右键保存） ---------------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'pw-save-page', title: '保存页面论文到 PaperWeave', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'pw-save-link', title: '保存链接论文到 PaperWeave', contexts: ['link'] });
});

async function flashBadge(tabId, okFlag) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: okFlag ? '#7bf1a8' : '#ff5a5a' });
    await chrome.action.setBadgeText({ tabId, text: okFlag ? '✓' : '✕' });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
  } catch (_) {}
}

async function saveTab(tab) {
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) return;
  let meta = null;
  try {
    meta = await chrome.tabs.sendMessage(tab.id, { type: 'pw:extract' });
  } catch (_) {}
  meta = await withFallbackMeta(tab, meta);
  const r = await importPaper(meta);
  flashBadge(tab.id, r.ok);
}

// 内容脚本拿不到（PDF 查看器等）时，按 URL 推断
async function withFallbackMeta(tab, meta) {
  if (meta && meta.kind && meta.kind !== 'error' && (meta.pdfUrl || meta.title)) return meta;
  const url = tab.url;
  const mPdf = url.match(/arxiv\.org\/pdf\/([^?#]+)/i);
  if (mPdf) {
    const id = mPdf[1].replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
    const extra = await arxivMetaFromAbs('https://arxiv.org/abs/' + id) || {};
    return { kind: 'arxiv', url, pdfUrl: url, ...extra };
  }
  if (/\.pdf($|[?#])/i.test(url)) {
    return { kind: 'pdf', url, pdfUrl: url, title: (tab.title || '').replace(/\.pdf$/i, ''), authors: [], year: '', doi: '', abstract: '', venue: '' };
  }
  return meta && meta.kind !== 'error' ? meta : { kind: 'webpage', url, title: tab.title || '', authors: [], year: '', doi: '', abstract: '', venue: '' };
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'pw-save-link' && info.linkUrl) {
    importPaper({ url: info.linkUrl }).then(r => flashBadge(tab && tab.id, r.ok));
    return;
  }
  if (info.menuItemId === 'pw-save-page') saveTab(tab);
});

/* ---------------- 消息总线（popup → background） ---------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'pw:ping') return sendResponse(await ping());
      if (msg.type === 'pw:discover') return sendResponse(await discover());
      if (msg.type === 'pw:connect') return sendResponse(await connect());
      if (msg.type === 'pw:libraries') return sendResponse(await listLibraries());
      if (msg.type === 'pw:pair') return sendResponse(await pairConnector());
      if (msg.type === 'pw:import') return sendResponse(await importPaper(msg.meta || {}));
      if (msg.type === 'pw:arxivMeta') return sendResponse(await arxivMetaFromAbs(msg.absUrl));
      if (msg.type === 'pw:saveTab') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await saveTab(tab);
        return sendResponse({ ok: true });
      }
      sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // 异步 sendResponse
});
