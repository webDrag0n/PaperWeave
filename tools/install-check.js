// 安装验证：以宿主方式拉起 MCP（默认自发现），验证握手与调用
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let nodeBin = process.execPath;
const standalone = path.join(ROOT, 'tools', 'runtime', 'node-v24.21.0-win-x64', 'node.exe');
if (process.env.ELECTRON_RUN_AS_NODE && require('fs').existsSync(standalone)) nodeBin = standalone;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PAPERWEAVE_AGENT_API_JSON; // 必须走默认自发现路径

const child = spawn(nodeBin, [path.join(ROOT, 'mcp', 'paperweave-mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.setEncoding('utf-8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let nextId = 1;
const req = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  const t = setTimeout(() => rej(new Error('timeout ' + method)), 20000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

(async () => {
  const init = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'install-check', version: '0.1' } });
  console.log('握手:', init.result.serverInfo.name, init.result.protocolVersion, 'capabilities:', Object.keys(init.result.capabilities).join('/'));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const status = await req('tools/call', { name: 'paperweave_status', arguments: {} });
  console.log('status:', status.result.content[0].text.replace(/\n/g, ' ').slice(0, 200));
  const papers = await req('resources/read', { uri: 'paperweave://papers' });
  const list = JSON.parse(papers.result.contents[0].text);
  console.log('库内论文:', list.length, '篇；自发现路径 OK');
  const prompt = await req('prompts/get', { name: 'paperweave_literature_review', arguments: { topic: 'Transformer' } });
  console.log('prompt 长度:', prompt.result.messages[0].content.text.length, '字符');
  child.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); child.kill(); process.exit(1); });
