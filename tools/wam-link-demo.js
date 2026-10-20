// 通过已安装的 MCP 为指定论文抓取引用关系并接入图谱
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
  const t = setTimeout(() => rej(new Error('timeout ' + method)), 60000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => {
  const r = await req('tools/call', { name, arguments: args || {} });
  const text = (r.result.content || []).map(c => c.text).join('\n');
  if (r.result.isError) return { __error: text };
  try { return JSON.parse(text); } catch (_) { return { __raw: text }; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kimi', version: '2.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const papers = await call('papergraph_list_papers');
  const targets = papers.filter(p => /WAM/i.test(p.title));
  console.log('目标论文:', targets.map(t => t.title.slice(0, 50)).join(' | '));

  for (const p of targets) {
    console.log('\n== ' + p.title.slice(0, 60) + ' ==');
    console.log('  DOI:', p.doi || '(无)');
    // 离线匹配先行（不依赖网络）
    const m = await call('papergraph_auto_match_refs', { paperId: p.id });
    if (m.__error) console.log('  离线匹配:', m.__error);
    else console.log(`  离线匹配: 识别 ${m.matched} 篇，新增 ${m.added} 条`);
    // 在线抓取，429 时限流重试
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const r = await call('papergraph_fetch_refs', { paperId: p.id });
      if (r.__error) {
        console.log(`  在线抓取(第${attempt}次):`, r.__error);
        if (/429|超时|网络/.test(r.__error) && attempt < 3) { console.log('  等待 20s 后重试…'); await sleep(20000); continue; }
      } else {
        console.log(`  在线抓取: 参考文献 ${r.refCount} 条、被引 ${r.citeCount} 条，命中库内新增 ${r.added} 条关联`);
      }
      done = true;
    }
    await sleep(2000); // 礼貌间隔
  }

  // 最终图谱状态
  const g = await call('papergraph_get_graph');
  console.log(`\n最终图谱: ${g.nodes.length} 节点 / ${g.edges.length} 边`);
  for (const t of targets) {
    const refs = g.edges.filter(e => e.from === t.id);
    const cites = g.edges.filter(e => e.to === t.id);
    const name = (id) => { const n = g.nodes.find(n => n.id === id); return n ? n.title.slice(0, 45) : id; };
    console.log('== ' + t.title.slice(0, 50) + ' ==');
    console.log('  它引用的:', refs.length ? refs.map(e => name(e.to)).join('；') : '(库内无)');
    console.log('  引用它的:', cites.length ? cites.map(e => name(e.from)).join('；') : '(库内无)');
  }
  child.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); child.kill(); process.exit(1); });
