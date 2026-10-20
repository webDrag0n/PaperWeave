// PaperWeave MCP Server 端到端测试：以 MCP 宿主视角走完整 stdio 流程
// 用法：npm run mcptest
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const electron = process.env.PAPERWEAVE_TEST_EXE || require('electron');
const testDataDir = path.join(ROOT, '.mcptest-data');
try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch (_) {}

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log((cond ? '✓' : '✗') + ' ' + name + (detail ? '  (' + String(detail).slice(0, 160) + ')' : ''));
};

// ---------- 极简 MCP stdio 客户端 ----------
class McpClient {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        } else {
          this.notifications.push(msg);
        }
      }
    });
  }
  request(method, params, timeoutMs = 90000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP 请求超时: ' + method)), timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async callTool(name, args) {
    const r = await this.request('tools/call', { name, arguments: args || {} });
    if (r.error) return { error: r.error.message };
    const text = (r.result.content || []).map(c => c.text).join('\n');
    if (r.result.isError) return { error: text };
    try { return { data: JSON.parse(text) }; } catch (_) { return { data: text }; }
  }
}

async function main() {
  // 1. 启动 PaperWeave（无头）
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.PAPERWEAVE_HEADLESS = '1';
  env.PAPERWEAVE_AUTOFETCH = '0'; // 关闭自动引用解析，保持测试确定性
  const appChild = spawn(electron, ['.', '--user-data-dir=' + testDataDir], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  appChild.stdout.on('data', () => {});
  appChild.stderr.on('data', () => {});

  const infoFile = path.join(testDataDir, 'paperweave-data', 'agent-api.json');
  let mcpChild = null;

  try {
    let info = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (fs.existsSync(infoFile)) {
        try { info = JSON.parse(fs.readFileSync(infoFile, 'utf-8')); break; } catch (_) {}
      }
    }
    check('PaperWeave 启动（后台提供 Agent API）', !!info);
    if (!info) throw new Error('app not started');

    // 2. 启动 MCP Server（通过环境变量指向测试数据目录的连接信息）
    // 注意：本环境下的 node 可能是 Electron 托管的 shim，优先使用独立 Node 运行时
    const mcpEnv = { ...process.env };
    delete mcpEnv.ELECTRON_RUN_AS_NODE;
    mcpEnv.PAPERWEAVE_AGENT_API_JSON = infoFile;
    let nodeBin = process.execPath;
    const standalone = path.join(ROOT, 'tools', 'runtime', 'node-v24.21.0-win-x64', 'node.exe');
    if (process.env.ELECTRON_RUN_AS_NODE && fs.existsSync(standalone)) nodeBin = standalone;
    mcpChild = spawn(nodeBin, [path.join(ROOT, 'mcp', 'paperweave-mcp.js')], { env: mcpEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let mcpErr = '';
    mcpChild.stderr.on('data', d => { mcpErr += d; });
    const mcp = new McpClient(mcpChild);

    // 3. 握手
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1' },
    });
    check('initialize 握手', init.result && init.result.serverInfo.name === 'paperweave', JSON.stringify(init.result && init.result.serverInfo));
    check('协议版本协商', ['2025-06-18', '2025-03-26', '2024-11-05'].includes(init.result.protocolVersion), init.result.protocolVersion);
    check('capabilities 声明 tools/resources/prompts', !!(init.result.capabilities.tools && init.result.capabilities.resources && init.result.capabilities.prompts));
    mcp.notify('notifications/initialized');

    // 4. tools/list
    const list = await mcp.request('tools/list');
    const names = (list.result.tools || []).map(t => t.name);
    check('tools/list 返回 25 个工具', names.length === 25, names.length + ' 个');
    check('拆分工具存在', names.includes('paperweave_fetch_references') && names.includes('paperweave_fetch_citations'));
    check('下载工具存在', names.includes('paperweave_download_ref') && names.includes('paperweave_download_all_refs'));
    check('库管理工具存在', names.includes('paperweave_list_libraries') && names.includes('paperweave_create_library') && names.includes('paperweave_switch_library') && names.includes('paperweave_update_library') && names.includes('paperweave_reorder_libraries'));
    check('工具带 inputSchema', list.result.tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));

    // 5. 导入论文
    const samples = path.join(ROOT, 'assets', 'samples');
    const files = ['attention.pdf', 'bert.pdf', 'gpt.pdf', 'vit.pdf', 's2s.pdf', 'resnet.pdf'].map(f => path.join(samples, f));
    let r = await mcp.callTool('paperweave_import_path', { paths: files });
    check('import_path 批量导入', !r.error && r.data.filter(x => x.paper && !x.duplicate).length === 6, r.error || '');

    r = await mcp.callTool('paperweave_list_papers');
    const papers = r.data;
    const attention = papers.find(p => /Attention/.test(p.title));
    check('list_papers 返回 6 篇', papers.length === 6);

    r = await mcp.callTool('paperweave_list_papers', { query: 'bert' });
    check('list_papers query 过滤', r.data.length === 1 && /BERT/.test(r.data[0].title));

    // 6. 详情 / 更新
    r = await mcp.callTool('paperweave_update_paper', { id: attention.id, notes: '# MCP 笔记', tags: ['mcp'] });
    check('update_paper 写笔记', !r.error && r.data.notes.includes('MCP'));
    r = await mcp.callTool('paperweave_update_paper', { id: attention.id, lastPage: 3 });
    check('update_paper 写阅读位置 lastPage', !r.error && r.data.lastPage === 3, JSON.stringify(r.data && r.data.lastPage));
    r = await mcp.callTool('paperweave_update_paper', { id: attention.id, rating: 4 });
    check('update_paper 评星 rating', !r.error && r.data.rating === 4, JSON.stringify(r.data && r.data.rating));
    r = await mcp.callTool('paperweave_get_paper', { id: attention.id });
    check('get_paper 读详情', r.data.tags.includes('mcp'));

    // 7. 批注
    r = await mcp.callTool('paperweave_add_annotation', {
      paperId: attention.id,
      annotation: { type: 'sticky', page: 1, x: 0.5, y: 0.5, comment: 'MCP 便利贴' },
    });
    check('add_annotation 追加便利贴', !r.error && r.data.length === 1);
    r = await mcp.callTool('paperweave_list_annotations', { paperId: attention.id });
    check('list_annotations', r.data.length === 1 && r.data[0].comment === 'MCP 便利贴');
    r = await mcp.callTool('paperweave_set_annotations', { paperId: attention.id, annotations: [] });
    check('set_annotations 清空', !r.error && r.data.length === 0);

    // 8. 引用关系
    for (const p of papers) await mcp.callTool('paperweave_auto_match_refs', { paperId: p.id });
    r = await mcp.callTool('paperweave_list_links');
    check('auto_match + list_links ≥5 条边', r.data.length >= 5, 'links=' + r.data.length);

    const resnet = papers.find(p => /Residual/.test(p.title));
    r = await mcp.callTool('paperweave_add_link', { from: resnet.id, to: attention.id });
    check('add_link', !r.error && r.data.from === resnet.id);
    r = await mcp.callTool('paperweave_delete_link', { linkId: r.data.id });
    check('delete_link', !r.error && r.data.deleted === true);

    r = await mcp.callTool('paperweave_get_graph');
    check('get_graph 节点与边', r.data.nodes.length === 6 && r.data.edges.length >= 5);

    // 8.4 拆分抓取工具
    let fr = await mcp.callTool('paperweave_fetch_references', { paperId: attention.id });
    check('fetch_references 在线解析参考文献', !fr.error && fr.data.total >= 3 && fr.data.matched >= 3 && Array.isArray(fr.data.unresolved), fr.error || `source=${fr.data.source || 'pdf-parse'} total=${fr.data.total} matched=${fr.data.matched} external=${fr.data.external}`);
    let fc = await mcp.callTool('paperweave_fetch_citations', { paperId: attention.id });
    if (!fc.error) check('fetch_citations 抓取被引', fc.data.citeCount >= 0, `source=${fc.data.source} added=${fc.data.added}`);
    else check('fetch_citations [网络不可用，跳过]', true, fc.error);

    // 8.5 Resources
    let rr = await mcp.request('resources/list');
    check('resources/list 返回 2 个资源', rr.result.resources.length === 2);
    rr = await mcp.request('resources/templates/list');
    check('resources/templates/list 返回 3 个模板', rr.result.resourceTemplates.length === 3);
    rr = await mcp.request('resources/read', { uri: 'paperweave://papers' });
    check('读取资源 papers 列表', rr.result && JSON.parse(rr.result.contents[0].text).length === 6);
    rr = await mcp.request('resources/read', { uri: `paperweave://papers/${attention.id}` });
    check('读取资源论文详情', rr.result && /Attention/.test(rr.result.contents[0].text));
    rr = await mcp.request('resources/read', { uri: `paperweave://papers/${attention.id}/notes` });
    check('读取资源论文笔记', rr.result && rr.result.contents[0].mimeType === 'text/markdown' && rr.result.contents[0].text.includes('MCP 笔记'));
    rr = await mcp.request('resources/read', { uri: `paperweave://papers/${attention.id}/annotations` });
    check('读取资源论文批注', rr.result && Array.isArray(JSON.parse(rr.result.contents[0].text)));
    rr = await mcp.request('resources/read', { uri: 'paperweave://graph' });
    check('读取资源图谱快照', rr.result && JSON.parse(rr.result.contents[0].text).edges.length >= 5);
    rr = await mcp.request('resources/read', { uri: 'paperweave://unknown/x' });
    check('未知资源 URI 返回错误', !!rr.error, rr.error && rr.error.message);

    // 8.6 Prompts
    let pr = await mcp.request('prompts/list');
    check('prompts/list 返回 3 个模板', pr.result.prompts.length === 3, pr.result.prompts.map(p => p.name).join(','));
    pr = await mcp.request('prompts/get', { name: 'paperweave_read_paper', arguments: { paper: 'Attention' } });
    check('prompts/get 阅读模板含主题与步骤', pr.result && pr.result.messages.length === 1 && pr.result.messages[0].content.text.includes('Attention') && pr.result.messages[0].content.text.includes('paperweave_update_paper'));
    pr = await mcp.request('prompts/get', { name: 'paperweave_literature_review', arguments: { topic: 'Transformer' } });
    check('prompts/get 综述模板', pr.result && pr.result.messages[0].content.text.includes('Transformer'));
    pr = await mcp.request('prompts/get', { name: 'paperweave_import_and_link', arguments: { source: 'https://arxiv.org/abs/1706.03762' } });
    check('prompts/get 导入模板', pr.result && pr.result.messages[0].content.text.includes('arxiv.org'));
    pr = await mcp.request('prompts/get', { name: 'no_such_prompt', arguments: {} });
    check('未知提示模板返回错误', !!pr.error, pr.error && pr.error.message);

    // 9. 错误路径
    r = await mcp.callTool('paperweave_get_paper', { id: 'p_not_exist' });
    check('不存在论文返回 isError', !!r.error, r.error || '');
    r = await mcp.callTool('paperweave_no_such_tool');
    check('未知工具返回 isError', !!r.error, r.error || '');

    // 9.5 多论文库（0.8.0+）
    r = await mcp.callTool('paperweave_list_libraries');
    const defLib = r.data && r.data.current;
    check('list_libraries 返回当前库（默认名 New Weave）', !r.error && !!defLib && r.data.libraries.length === 1 && r.data.libraries[0].name === 'New Weave', JSON.stringify(r.data && r.data.libraries && r.data.libraries[0] && r.data.libraries[0].name));
    r = await mcp.callTool('paperweave_create_library', { name: 'MCP 临时库', desc: '临时', switch: false });
    check('create_library 不切换', !r.error && r.data.name === 'MCP 临时库' && r.data.desc === '临时');
    const tmpLib = r.data.id;
    r = await mcp.callTool('paperweave_update_library', { id: tmpLib, name: 'MCP 临时库·改', pinned: true });
    check('update_library 改名与置顶', !r.error && r.data.name === 'MCP 临时库·改' && r.data.pinned === true);
    r = await mcp.callTool('paperweave_reorder_libraries', { ids: [tmpLib, defLib] });
    check('reorder_libraries 排序', !r.error);
    r = await mcp.callTool('paperweave_switch_library', { id: tmpLib });
    check('switch_library', !r.error && r.data.current === tmpLib);
    r = await mcp.callTool('paperweave_list_papers');
    check('切换后新库为空', !r.error && r.data.length === 0, 'papers=' + r.data.length);
    r = await mcp.callTool('paperweave_switch_library', { id: defLib });
    check('切回默认库', !r.error && r.data.current === defLib);

    // 10. status
    r = await mcp.callTool('paperweave_status');
    check('status 统计', r.data.papers === 6 && r.data.annotations === 0, JSON.stringify(r.data).slice(0, 120));

    // 11. URL 导入（网络可用时）
    r = await mcp.callTool('paperweave_import_url', { url: 'https://arxiv.org/abs/1706.03762' });
    if (!r.error) {
      check('import_url (arXiv)', /attention/i.test(r.data.paper.title || ''), r.data.paper.title);
      await mcp.callTool('paperweave_delete_paper', { id: r.data.paper.id, deleteFile: true });
    } else {
      check('import_url [网络不可用，跳过]', true, r.error);
    }
  } catch (e) {
    check('测试异常终止: ' + e.message, false);
  } finally {
    if (mcpChild) mcpChild.kill('SIGKILL');
    await new Promise(r => {
      try {
        const tk = spawn('taskkill', ['/PID', String(appChild.pid), '/T', '/F'], { stdio: 'ignore' });
        tk.on('close', r);
        setTimeout(r, 5000);
      } catch (_) { r(); }
    });
  }

  const passed = results.filter(x => x.pass).length;
  console.log(`\n通过 ${passed}/${results.length}`);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(testDataDir, { recursive: true, force: true }); break; }
    catch (_) { await new Promise(r => setTimeout(r, 1000)); }
  }
  process.exit(passed === results.length ? 0 : 1);
}

main();
