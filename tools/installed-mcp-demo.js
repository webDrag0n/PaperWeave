// 以"已安装的 MCP"为通道做一次真实 Agent 工作流演示
// 直接使用 mcp.json 中注册的 command + args 拉起 papergraph-mcp.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mcpJsonPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home', 'mcp.json');
const registered = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')).mcpServers.papergraph;
console.log('使用已注册配置拉起 MCP：');
console.log('  command:', registered.command);
console.log('  args   :', registered.args[0]);

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
  const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => {
  const r = await req('tools/call', { name, arguments: args || {} });
  const text = (r.result.content || []).map(c => c.text).join('\n');
  if (r.result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch (_) { return text; }
};

(async () => {
  // 握手
  const init = await req('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'kimi', version: '2.0' },
  });
  console.log('\n① 握手:', init.result.serverInfo.name, '| 协议', init.result.protocolVersion,
    '| 能力', Object.keys(init.result.capabilities).join('/'));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 清单
  const tools = await req('tools/list');
  console.log('② 工具:', tools.result.tools.length, '个');
  const res = await req('resources/list');
  const tpl = await req('resources/templates/list');
  const prompts = await req('prompts/list');
  console.log('③ 资源:', res.result.resources.length, '+', tpl.result.resourceTemplates.length, '模板; Prompt:', prompts.result.prompts.length, '个');

  // 库状态
  const status = await call('papergraph_status');
  console.log(`④ 库状态: ${status.papers} 篇论文, ${status.links} 条引用边, ${status.annotations} 条批注`);

  // 列表 + 搜索
  const papers = await call('papergraph_list_papers');
  console.log('⑤ 论文列表:');
  for (const p of papers) console.log(`   - [${p.id.slice(0, 10)}…] ${p.title} (${p.year || '?'})`);
  const hits = await call('papergraph_list_papers', { query: 'transformer' });
  console.log('⑥ 搜索 "transformer":', hits.length, '篇命中');

  // 图谱
  const g = await call('papergraph_get_graph');
  const attention = papers.find(p => /Attention Is All You Need/.test(p.title));
  const cites = g.edges.filter(e => e.to === attention.id);
  const refs = g.edges.filter(e => e.from === attention.id);
  console.log(`⑦ 图谱: ${g.nodes.length} 节点 / ${g.edges.length} 边；Attention 引用 ${refs.length} 篇、被引 ${cites.length} 篇`);

  // 精读一篇：详情 + 资源 + 写批注 + 写笔记
  const detail = await call('papergraph_get_paper', { id: attention.id });
  console.log('⑧ 精读《' + detail.title.slice(0, 40) + '》摘要前 60 字:', (detail.abstract || '(无)').slice(0, 60));
  const ann = await call('papergraph_add_annotation', {
    paperId: attention.id,
    annotation: {
      type: 'highlight', page: 1,
      quads: [{ x: 0.09, y: 0.115, w: 0.55, h: 0.035 }],
      color: '#7bf1a8', text: 'Attention Is All You Need',
      comment: '由已安装的 MCP 通过 Agent 添加的高亮',
    },
  });
  console.log('⑨ 通过 MCP 添加高亮批注 → 当前批注数:', ann.length);
  const sticky = await call('papergraph_add_annotation', {
    paperId: attention.id,
    annotation: { type: 'sticky', page: 3, x: 0.5, y: 0.3, comment: '参考文献部分值得逐篇跟进 —— MCP Agent' },
  });
  console.log('⑩ 通过 MCP 放置便利贴 → 当前批注数:', sticky.length);
  await call('papergraph_update_paper', {
    id: attention.id,
    notes: (detail.notes || '') + '\n\n## MCP Agent 测试笔记\n\n- 该论文的引用/被引关系已通过 MCP 读取验证\n- 高亮与便利贴均由 Agent 通过 MCP 写入\n',
  });
  const notesRes = await req('resources/read', { uri: `papergraph://papers/${attention.id}/notes` });
  console.log('⑪ 资源回读笔记，尾部:', notesRes.result.contents[0].text.trim().split('\n').slice(-2).join(' / '));

  // Prompt 模板
  const pr = await req('prompts/get', { name: 'papergraph_read_paper', arguments: { paper: 'Attention' } });
  console.log('⑫ Prompt 模板生成', pr.result.messages[0].content.text.length, '字符的精读指引');

  child.kill();
  console.log('\n全部通过 ✓（应用界面上现在就能看到新增的 1 条高亮和 1 张便利贴）');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); child.kill(); process.exit(1); });
