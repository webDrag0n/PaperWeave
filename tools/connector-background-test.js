// Connector 后台：在模拟 Chrome 环境中验证自动发现、配对与本地凭据保存
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const localData = {};
const syncData = {};
const storageArea = data => ({
  get: async keys => Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k, data[k]])),
  set: async values => { Object.assign(data, values); },
});
const chrome = {
  storage: { local: storageArea(localData), sync: storageArea(syncData) },
  runtime: { id: 'connector-test', onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
  contextMenus: { create() {}, onClicked: { addListener() {} } },
  action: {},
  tabs: {},
};
const requests = [];
async function fetchMock(url, options = {}) {
  requests.push({ url, options });
  if (url.endsWith('/api/ping')) {
    if (url.startsWith('http://127.0.0.1:24681')) {
      return { ok: true, json: async () => ({ ok: true, name: 'PaperWeave', version: 'test', api: 8 }) };
    }
    throw new Error('not listening');
  }
  if (url.endsWith('/api/connector/pair')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 'paired-token' } }) };
  }
  if (url.endsWith('/api/libraries')) {
    return { status: 200, json: async () => ({ ok: true, data: { current: 'lib_default', libraries: [{ id: 'lib_default', name: '默认库' }, { id: 'lib_review', name: '综述库' }] } }) };
  }
  if (url.endsWith('/api/papers/import-web')) {
    return { status: 200, json: async () => ({ ok: true, data: { paper: { id: 'p1', title: 'Test' }, duplicate: false } }) };
  }
  if (url.endsWith('/api/status')) {
    return { status: 200, json: async () => ({ ok: true, data: { papers: 6 } }) };
  }
  throw new Error('unexpected URL: ' + url);
}

const context = vm.createContext({ chrome, fetch: fetchMock, AbortController, AbortSignal, setTimeout, clearTimeout, console });
const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
vm.runInContext(source, context);

(async () => {
  const found = await vm.runInContext('discover()', context);
  assert.equal(found.ok, true);
  assert.equal(found.serverUrl, 'http://127.0.0.1:24681');
  assert.equal(localData.serverUrl, found.serverUrl);
  const paired = await vm.runInContext('connect()', context);
  assert.equal(paired.ok, true);
  assert.equal(paired.authed, true);
  assert.equal(paired.status.papers, 6);
  assert.equal(localData.token, 'paired-token');
  const pairRequest = requests.find(r => r.url.endsWith('/api/connector/pair'));
  assert.equal(JSON.parse(pairRequest.options.body).extensionId, 'connector-test');
  const libraryData = await vm.runInContext('listLibraries()', context);
  assert.equal(libraryData.ok, true);
  assert.equal(libraryData.libraries.length, 2);
  assert.equal(libraryData.current, 'lib_default');
  const imported = await vm.runInContext('importPaper({ url: "https://example.com/a.pdf", libraryId: "lib_review" })', context);
  assert.equal(imported.ok, true);
  const importRequest = requests.find(r => r.url.endsWith('/api/papers/import-web'));
  assert.equal(JSON.parse(importRequest.options.body).libraryId, 'lib_review');
  const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');
  assert.match(popupHtml, /id="loadingView"/);
  assert.match(popupHtml, /id="librarySelect"/);
  assert.doesNotMatch(popupHtml, /id="loadingView" class="hidden"/);
  assert.match(popupJs, /pw:connect/);
  assert.match(popupJs, /pw:libraries/);
  console.log('PASS Connector 自动连接、目标库导入与即时加载界面');
})().catch(err => { console.error(err); process.exit(1); });
