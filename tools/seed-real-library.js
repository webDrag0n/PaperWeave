// 通过已安装的 MCP 通道向真实论文库导入示例论文（演示用）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let nodeBin = process.execPath;
const standalone = path.join(ROOT, 'tools', 'runtime', 'node-v24.21.0-win-x64', 'node.exe');
if (process.env.ELECTRON_RUN_AS_NODE && fs.existsSync(standalone)) nodeBin = standalone;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PAPERGRAPH_AGENT_API_JSON;

const child = spawn(nodeBin, [path.join(ROOT, 'mcp', 'papergraph-mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const t = setTimeout(() => rej(new Error('timeout ' + method)), 60000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => {
  const r = await req('tools/call', { name, arguments: args || {} });
  const text = (r.result.content || []).map(c => c.text).join('\n');
  if (r.result.isError) throw new Error(text);
  return JSON.parse(text);
};

(async () => {
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'seed', version: '0.1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const files = ['attention.pdf', 'bert.pdf', 'gpt.pdf', 'vit.pdf', 's2s.pdf', 'resnet.pdf']
    .map(f => path.join(ROOT, 'assets', 'samples', f));
  const r = await call('papergraph_import_path', { paths: files });
  console.log('导入:', r.filter(x => x.paper && !x.duplicate).length, '篇；去重:', r.filter(x => x.duplicate).length, '篇');
  const papers = await call('papergraph_list_papers');
  for (const p of papers) {
    try { await call('papergraph_auto_match_refs', { paperId: p.id }); }
    catch (e) { console.log('跳过（无参考文献段落）:', p.title.slice(0, 40)); }
  }
  const g = await call('papergraph_get_graph');
  console.log('图谱:', g.nodes.length, '节点,', g.edges.length, '条引用边');
  child.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); child.kill(); process.exit(1); });
