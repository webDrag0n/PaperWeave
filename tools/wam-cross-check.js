// 分析两篇 WAM 论文的 PDF 全文，找交叉引用证据，并通过 MCP 建立关联
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
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

async function extractText(pdfPath) {
  const pdfjs = await import(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]:)/, 'file:///$1'));
  const buf = fs.readFileSync(pdfPath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map(it => it.str).join(' ') + '\n';
  }
  try { doc.destroy(); } catch (_) {}
  return text;
}

(async () => {
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kimi', version: '2.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const status = await call('papergraph_status');
  const papers = await call('papergraph_list_papers');
  const zeroWam = papers.find(p => /Zero-WAM/.test(p.title));
  const openWam = papers.find(p => /OpenWAM/.test(p.title));
  if (!zeroWam || !openWam) throw new Error('未找到两篇 WAM 论文');

  const zeroText = await extractText(path.join(status.libraryDir, zeroWam.file));
  const openText = await extractText(path.join(status.libraryDir, openWam.file));

  const checks = [
    { from: openWam, to: zeroWam, text: openText, label: 'OpenWAM 引用 Zero-WAM' },
    { from: zeroWam, to: openWam, text: zeroText, label: 'Zero-WAM 引用 OpenWAM' },
  ];
  let added = 0;
  for (const c of checks) {
    const axId = (c.to.doi || '').replace(/^arxiv:/i, '');
    const titleKey = c.to.title.split(':')[0].trim(); // "Zero-WAM" / "OpenWAM"
    const mentionTitle = c.text.toLowerCase().includes(titleKey.toLowerCase());
    const mentionAx = axId && c.text.includes(axId);
    console.log(`${c.label}: 标题提及=${mentionTitle} arXiv号提及=${mentionAx}`);
    if (mentionTitle || mentionAx) {
      // 定位一处上下文作为证据
      const hay = c.text.toLowerCase();
      const idx = hay.indexOf(titleKey.toLowerCase());
      const ctx = idx >= 0 ? c.text.slice(Math.max(0, idx - 80), idx + 80).replace(/\s+/g, ' ').trim() : '';
      if (ctx) console.log('  证据: …' + ctx + '…');
      const r = await call('papergraph_add_link', { from: c.from.id, to: c.to.id });
      if (r.__error) console.log('  建边失败:', r.__error);
      else { console.log('  ✓ 已通过 MCP 建立引用关联'); added++; }
    }
  }

  const g = await call('papergraph_get_graph');
  console.log(`\n最终图谱: ${g.nodes.length} 节点 / ${g.edges.length} 边（本次新增 ${added} 条）`);
  child.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); child.kill(); process.exit(1); });
