// 新版回退源线上验证：WAM 论文 + 经典论文的引用抓取
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mcpJsonPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home', 'mcp.json');
const registered = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')).mcpServers.papergraph;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PAPERGRAPH_AGENT_API_JSON;

const child = spawn(registered.command, registered.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});
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
  const t = setTimeout(() => rej(new Error('timeout ' + method)), 90000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => {
  const r = await req('tools/call', { name, arguments: args || {} });
  const text = (r.result.content || []).map(c => c.text).join('\n');
  if (r.result.isError) return { __error: text };
  try { return JSON.parse(text); } catch (_) { return { __raw: text }; }
};

(async () => {
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kimi', version: '2.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const before = await call('papergraph_status');
  console.log(`抓取前: ${before.papers} 篇 / ${before.links} 条边`);

  const papers = await call('papergraph_list_papers');
  const targets = [
    papers.find(p => /Zero-WAM/.test(p.title)),
    papers.find(p => /OpenWAM/.test(p.title)),
    papers.find(p => /Attention Is All You Need/.test(p.title)),
  ].filter(Boolean);

  for (const p of targets) {
    const r = await call('papergraph_fetch_refs', { paperId: p.id });
    if (r.__error) {
      console.log(`✗ ${p.title.slice(0, 40)}: ${r.__error}`);
    } else {
      console.log(`✓ ${p.title.slice(0, 40)}: 源=${r.source} 参考文献=${r.refCount} 被引=${r.citeCount} 新增库内关联=${r.added}`);
    }
  }

  const after = await call('papergraph_status');
  console.log(`\n抓取后: ${after.papers} 篇 / ${after.links} 条边（净增 ${after.links - before.links}）`);

  const g = await call('papergraph_get_graph');
  for (const p of targets) {
    const refs = g.edges.filter(e => e.from === p.id).map(e => (g.nodes.find(n => n.id === e.to) || {}).title);
    const cites = g.edges.filter(e => e.to === p.id).map(e => (g.nodes.find(n => n.id === e.from) || {}).title);
    console.log('== ' + p.title.slice(0, 45) + ' ==');
    console.log('  它引用的:', refs.length ? refs.map(t => t.slice(0, 40)).join('；') : '(库内无)');
    console.log('  引用它的:', cites.length ? cites.map(t => t.slice(0, 40)).join('；') : '(库内无)');
  }
  child.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); child.kill(); process.exit(1); });
