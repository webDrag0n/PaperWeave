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
      return { ok: true, json: async () => ({ ok: true, name: 'PaperWeave', version: 'test', api: 7 }) };
    }
    throw new Error('not listening');
  }
  if (url.endsWith('/api/connector/pair')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 'paired-token' } }) };
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
  const paired = await vm.runInContext('pairConnector()', context);
  assert.equal(paired.ok, true);
  assert.equal(paired.authed, true);
  assert.equal(paired.status.papers, 6);
  assert.equal(localData.token, 'paired-token');
  const pairRequest = requests.find(r => r.url.endsWith('/api/connector/pair'));
  assert.equal(JSON.parse(pairRequest.options.body).extensionId, 'connector-test');
  console.log('PASS Connector 自动发现递增端口、配对授权与本地凭据保存');
})().catch(err => { console.error(err); process.exit(1); });
