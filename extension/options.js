// PaperWeave Connector 设置页逻辑
const isZh = (chrome.i18n && chrome.i18n.getUILanguage() || 'zh').toLowerCase().startsWith('zh');
const S = (zh, en) => (isZh ? zh : en);

const $ = (s) => document.querySelector(s);

document.querySelectorAll('[data-zh]').forEach(el => {
  el.textContent = S(el.dataset.zh, el.dataset.en || el.dataset.zh);
});

async function load() {
  const cfg = await chrome.storage.sync.get(['serverUrl', 'token']);
  $('#serverUrl').value = cfg.serverUrl || 'http://127.0.0.1:24680';
  $('#token').value = cfg.token || '';
}

function setStatus(text, ok) {
  const el = $('#optStatus');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

$('#saveBtn').addEventListener('click', async () => {
  const serverUrl = $('#serverUrl').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:24680';
  const token = $('#token').value.trim();
  await chrome.storage.sync.set({ serverUrl, token });
  setStatus(S('✓ 已保存', '✓ Saved'), true);
});

$('#testBtn').addEventListener('click', async () => {
  // 先保存再测，保证测的是当前输入
  const serverUrl = $('#serverUrl').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:24680';
  const token = $('#token').value.trim();
  await chrome.storage.sync.set({ serverUrl, token });
  setStatus(S('测试中…', 'Testing…'), true);
  const r = await chrome.runtime.sendMessage({ type: 'pw:ping' });
  if (r && r.ok && r.authed) {
    setStatus(S(`✓ 连接成功：PaperWeave ${r.app.version}，库内 ${r.status ? r.status.papers : '?'} 篇论文`, `✓ Connected: PaperWeave ${r.app.version}, ${r.status ? r.status.papers : '?'} papers`), true);
  } else if (r && r.ok) {
    setStatus(S('✕ 已找到 PaperWeave，但访问令牌无效', '✕ PaperWeave found, but the token is invalid'), false);
  } else {
    setStatus('✕ ' + ((r && r.error) || S('无法连接', 'Cannot connect')), false);
  }
});

load();
