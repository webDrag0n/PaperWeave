// PaperWeave Agent API 端到端测试：以 Agent 视角走完整接口流程
// 用法：npm run apitest   （可选 PAPERWEAVE_TEST_EXE 指定被测程序）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const electron = process.env.PAPERWEAVE_TEST_EXE || require('electron');
const testDataDir = path.join(ROOT, '.apitest-data');
try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放时由收尾重试清理 */ }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PAPERWEAVE_HEADLESS = '1';
env.PAPERWEAVE_AUTOFETCH = '0'; // 测试期间关闭导入后的自动引用解析，保持结果确定

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log((cond ? '✓' : '✗') + ' ' + name + (detail ? '  (' + String(detail).slice(0, 160) + ')' : ''));
};

function req(baseUrl, method, p, body, token, raw = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + p);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-PaperWeave-Token': token } : {}),
        ...(data ? { 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, buf, type: res.headers['content-type'] });
        let json = null;
        try { json = JSON.parse(buf.toString('utf-8')); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const child = spawn(electron, ['.', '--user-data-dir=' + testDataDir], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  let appLog = '';
  child.stdout.on('data', d => { appLog += d; });

  const infoFile = path.join(testDataDir, 'paperweave-data', 'agent-api.json');

  try {
    // 等待连接信息文件出现
    let info = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (fs.existsSync(infoFile)) {
        try { info = JSON.parse(fs.readFileSync(infoFile, 'utf-8')); break; } catch (_) {}
      }
    }
    check('Agent API 启动并写入连接信息', !!info, info ? info.baseUrl : 'agent-api.json 未生成');
    if (!info) throw new Error('no connection info');
    const base = info.baseUrl, tk = info.token;

    // 探活与鉴权
    const ping = await req(base, 'GET', '/api/ping');
    check('ping 无需令牌', ping.status === 200 && ping.json.ok);
    const noAuth = await req(base, 'GET', '/api/papers');
    check('无令牌被拒绝 401', noAuth.status === 401);
    const badAuth = await req(base, 'GET', '/api/papers', null, 'wrong-token');
    check('错误令牌被拒绝 401', badAuth.status === 401);

    // 空库
    let r = await req(base, 'GET', '/api/papers', null, tk);
    check('初始库为空', r.json.ok && r.json.data.length === 0);

    // 批量导入
    const samples = path.join(ROOT, 'assets', 'samples');
    const files = ['attention.pdf', 'bert.pdf', 'gpt.pdf', 'vit.pdf', 's2s.pdf', 'resnet.pdf'].map(f => path.join(samples, f));
    r = await req(base, 'POST', '/api/papers/import-path', { paths: files }, tk);
    check('批量导入 6 篇', r.json.ok && r.json.data.filter(x => x.paper && !x.duplicate).length === 6, JSON.stringify(r.json.data.map(x => x.paper && x.paper.title)).slice(0, 120));

    r = await req(base, 'GET', '/api/papers', null, tk);
    const papers = r.json.data;
    const attention = papers.find(p => /Attention Is All You Need/.test(p.title));
    const bert = papers.find(p => /BERT/.test(p.title));
    check('导入后元数据完整', attention && attention.doi.includes('10.48550'), attention && attention.doi);

    // 重复导入去重
    r = await req(base, 'POST', '/api/papers/import-path', { path: files[0] }, tk);
    check('重复导入去重', r.json.ok && r.json.data[0].duplicate === true);

    // URL 导入（网络可用时）
    r = await req(base, 'POST', '/api/papers/import-url', { url: 'https://arxiv.org/abs/1706.03762' }, tk);
    if (r.status === 200 && r.json.ok) {
      check('链接导入 (arXiv)', /attention/i.test(r.json.data.paper.title || ''), r.json.data.paper.title);
      // 删除这篇以保持库为 6 篇
      await req(base, 'DELETE', '/api/papers/' + r.json.data.paper.id + '?deleteFile=1', null, tk);
    } else {
      check('链接导入 (arXiv) [网络不可用，跳过]', true, r.json && r.json.error);
    }

    // PDF 字节下载
    r = await req(base, 'GET', `/api/papers/${attention.id}/pdf`, null, tk, true);
    check('下载 PDF 字节', r.status === 200 && r.type === 'application/pdf' && r.buf.slice(0, 5).toString('latin1') === '%PDF-', 'bytes=' + r.buf.length);

    // 元数据与笔记
    r = await req(base, 'PATCH', `/api/papers/${attention.id}`, { notes: '# Agent 笔记\n- 自回归测试', tags: ['agent', 'test'] }, tk);
    check('PATCH 更新笔记与标签', r.json.ok && r.json.data.notes.includes('Agent 笔记'));
    r = await req(base, 'GET', `/api/papers/${attention.id}`, null, tk);
    check('GET 详情包含笔记', r.json.data.notes.includes('自回归测试') && r.json.data.tags.includes('agent'));
    // 阅读位置字段（0.2.0 新增）
    r = await req(base, 'PATCH', `/api/papers/${attention.id}`, { lastPage: 2 }, tk);
    check('PATCH 更新阅读位置 lastPage', r.json.ok && r.json.data.lastPage === 2, JSON.stringify(r.json.data && r.json.data.lastPage));

    // 批注
    r = await req(base, 'POST', `/api/papers/${attention.id}/annotations`, {
      type: 'highlight', page: 1, quads: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.02 }], text: 'Transformer', comment: 'Agent 高亮',
    }, tk);
    check('POST 追加高亮批注', r.json.ok && r.json.data.length === 1);
    r = await req(base, 'POST', `/api/papers/${attention.id}/annotations`, {
      type: 'sticky', page: 2, x: 0.3, y: 0.4, comment: 'Agent 便利贴',
    }, tk);
    check('POST 追加便利贴', r.json.ok && r.json.data.length === 2);
    r = await req(base, 'GET', `/api/papers/${attention.id}/annotations`, null, tk);
    check('GET 批注列表', r.json.data.length === 2 && r.json.data.some(a => a.comment === 'Agent 便利贴'));
    const keep = r.json.data.filter(a => a.type === 'highlight');
    r = await req(base, 'PUT', `/api/papers/${attention.id}/annotations`, keep, tk);
    check('PUT 全量替换批注（删除便利贴）', r.json.ok && r.json.data.length === 1);

    // 引用关系：离线匹配
    for (const p of papers) await req(base, 'POST', `/api/papers/${p.id}/auto-match`, null, tk);
    r = await req(base, 'GET', '/api/links', null, tk);
    check('离线匹配建立引用边 ≥5', r.json.ok && r.json.data.length >= 5, 'links=' + r.json.data.length);

    // 手动关联
    const resnet = papers.find(p => /Residual/.test(p.title));
    r = await req(base, 'POST', '/api/links', { from: resnet.id, to: attention.id }, tk);
    check('POST 新增引用关联', r.json.ok && r.json.data.from === resnet.id);
    const linkId = r.json.data.id;
    r = await req(base, 'DELETE', '/api/links/' + linkId, null, tk);
    check('DELETE 引用关联', r.json.ok);

    // 图谱
    r = await req(base, 'GET', '/api/graph', null, tk);
    const g = r.json.data;
    check('图谱节点与边', g.nodes.length === 6 && g.edges.length >= 5, `nodes=${g.nodes.length} edges=${g.edges.length}`);
    const cites = g.edges.filter(e => e.to === attention.id).length;
    const refs = g.edges.filter(e => e.from === attention.id).length;
    check('双向引用语义（from 引用 to）', cites >= 2 && refs >= 2, `被引=${cites} 引用=${refs}`);

    // 拆分抓取：参考文献（S2 结构化主源 / PDF 解析回退）与被引（S2 限流）
    r = await req(base, 'POST', `/api/papers/${attention.id}/fetch-references`, null, tk);
    check('fetch-references 解析参考文献', r.status === 200 && r.json.ok && r.json.data.total >= 3 && r.json.data.matched >= 3 && Array.isArray(r.json.data.unresolved),
      r.json.ok ? `source=${r.json.data.source || 'pdf-parse'} total=${r.json.data.total} resolved=${r.json.data.resolved} matched=${r.json.data.matched} added=${r.json.data.added} external=${r.json.data.external}` : r.json && r.json.error);
    r = await req(base, 'POST', `/api/papers/${attention.id}/fetch-citations`, null, tk);
    if (r.status === 200 && r.json.ok) {
      check('fetch-citations 抓取被引', true, `source=${r.json.data.source} citeCount=${r.json.data.citeCount} added=${r.json.data.added}`);
    } else {
      check('fetch-citations [网络不可用，跳过]', true, r.json && r.json.error);
    }
    // 组合接口兼容
    r = await req(base, 'POST', `/api/papers/${attention.id}/fetch-refs`, null, tk);
    check('fetch-refs 组合接口返回子结果', r.status === 200 && r.json.ok && r.json.data.references && r.json.data.citations);

    // 未入库引用捕获 + 下载入库（0.3.0+）：追加一条库外的 Adam 参考文献（PDF 回退路径可兜底）
    r = await req(base, 'PATCH', `/api/papers/${attention.id}`, { refText: '[1] J. Devlin, M. Chang. BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. NAACL 2019.\n[2] A. Radford. Improving Language Understanding by Generative Pre-Training. OpenAI 2018.\n[3] I. Sutskever. Sequence to Sequence Learning with Neural Networks. NeurIPS 2014.\n[4] D. P. Kingma, J. Ba. Adam: A Method for Stochastic Optimization. ICLR 2015. arXiv:1412.6980' }, tk);
    check('PATCH refText 可更新', r.json.ok);
    r = await req(base, 'POST', `/api/papers/${attention.id}/fetch-references`, null, tk);
    check('fetch-references 捕获未入库条目', r.status === 200 && r.json.ok && r.json.data.external >= 1,
      r.json.ok ? `source=${r.json.data.source || 'pdf-parse'} total=${r.json.data.total} matched=${r.json.data.matched} external=${r.json.data.external}` : r.json && r.json.error);
    r = await req(base, 'GET', `/api/papers/${attention.id}`, null, tk);
    const extAll = ((r.json.data && r.json.data.externalRefs) || []);
    const ext = extAll.find(e => /adam/i.test(e.title || '')) || extAll.find(e => e.arxivId);
    check('externalRefs 持久化含未入库条目', !!ext, ext && ext.key);
    if (ext) {
      r = await req(base, 'POST', `/api/papers/${attention.id}/download-ref`, { key: ext.key }, tk);
      check('download-ref 下载入库', r.status === 200 && r.json.ok && !!r.json.data.paper, r.json.ok ? (r.json.data.paper.title || '').slice(0, 50) : (r.json && r.json.error));
      const dlId = r.json.ok && r.json.data.paper && r.json.data.paper.id;
      if (dlId) {
        check('下载文献默认无评分', r.json.data.paper.rating === 0, 'rating=' + r.json.data.paper.rating);
        r = await req(base, 'GET', '/api/links', null, tk);
        check('下载后自动建立引用边', r.json.ok && r.json.data.some(l => l.from === attention.id && l.to === dlId));
        // 清理：删除下载的论文及其关联
        await req(base, 'DELETE', '/api/papers/' + dlId + '?deleteFile=1', null, tk);
      }
    }
    // download-all-refs 用没有未入库条目的论文验证汇总结构（避免真实批量下载）
    const resnet0 = papers.find(p => /Residual/.test(p.title));
    r = await req(base, 'POST', `/api/papers/${resnet0.id}/download-all-refs`, { dir: 'both' }, tk);
    check('download-all-refs 返回汇总', r.status === 200 && r.json.ok && typeof r.json.data.total === 'number', JSON.stringify((r.json && r.json.data) || {}).slice(0, 120));

    // ---------- 多论文库（0.8.0+） ----------
    r = await req(base, 'GET', '/api/libraries', null, tk);
    const defaultLibId = r.json.data && r.json.data.current;
    check('libraries 列表与当前库（默认名 New Weave）', r.json.ok && r.json.data.libraries.length === 1 && !!defaultLibId && r.json.data.libraries[0].name === 'New Weave', JSON.stringify(r.json.data && r.json.data.libraries && r.json.data.libraries[0] && r.json.data.libraries[0].name));
    r = await req(base, 'POST', '/api/libraries', { name: '综述库', desc: '综述参考' }, tk);
    check('创建论文库并自动切换', r.json.ok && r.json.data.name === '综述库' && r.json.data.desc === '综述参考');
    const reviewLibId = r.json.data.id;
    // 更新名称/简介/置顶（0.9.0）
    r = await req(base, 'PATCH', '/api/libraries/' + reviewLibId, { name: '综述库·改', pinned: true }, tk);
    check('PATCH 更新名称与置顶', r.json.ok && r.json.data.name === '综述库·改' && r.json.data.pinned === true, JSON.stringify(r.json.data));
    // 排序
    r = await req(base, 'POST', '/api/libraries/reorder', { ids: [defaultLibId, reviewLibId] }, tk);
    check('reorder 重排论文库', r.json.ok);
    r = await req(base, 'GET', '/api/libraries', null, tk);
    check('重排后顺序生效', r.json.data.libraries[0].id === defaultLibId, r.json.data.libraries.map(l => l.id).join(','));
    r = await req(base, 'GET', '/api/papers', null, tk);
    check('新库初始为空', r.json.ok && r.json.data.length === 0, 'papers=' + r.json.data.length);
    // 跨库导入同一文件：复用全局论文 id（不重复存储）
    r = await req(base, 'POST', '/api/papers/import-path', { path: path.join(ROOT, 'assets', 'samples', 'attention.pdf') }, tk);
    check('跨库导入复用同一论文 id', r.json.ok && r.json.data[0].reused === true && r.json.data[0].paper.id === attention.id,
      JSON.stringify({ reused: r.json.data[0] && r.json.data[0].reused, same: r.json.data[0] && r.json.data[0].paper && r.json.data[0].paper.id === attention.id }));
    // DOI 冲突（同 DOI 不同内容）：auto 策略自动合并复用
    const variantPath = path.join(testDataDir, 'attention-variant.pdf');
    fs.writeFileSync(variantPath, Buffer.concat([fs.readFileSync(path.join(ROOT, 'assets', 'samples', 'attention.pdf')), Buffer.from('\n% variant')]));
    r = await req(base, 'POST', '/api/papers/import-path', { path: variantPath }, tk);
    check('DOI 冲突 auto 策略自动合并', r.json.ok && r.json.data[0].merged === true && r.json.data[0].paper.id === attention.id,
      JSON.stringify({ merged: r.json.data[0] && r.json.data[0].merged, conflict: !!(r.json.data[0] && r.json.data[0].conflict) }));
    // conflictPolicy=new：作为新论文
    const variantPath2 = path.join(testDataDir, 'attention-variant2.pdf');
    fs.writeFileSync(variantPath2, Buffer.concat([fs.readFileSync(path.join(ROOT, 'assets', 'samples', 'attention.pdf')), Buffer.from('\n% variant2')]));
    r = await req(base, 'POST', '/api/papers/import-path', { path: variantPath2, conflictPolicy: 'new' }, tk);
    check('conflictPolicy=new 强制新建', r.json.ok && r.json.data[0].paper && r.json.data[0].paper.id !== attention.id);
    // 清理新库并切回默认库
    const newLibPaperIds = [r.json.data[0].paper.id];
    for (const pid of newLibPaperIds) await req(base, 'DELETE', '/api/papers/' + pid + '?deleteFile=1', null, tk);
    r = await req(base, 'DELETE', '/api/libraries/' + reviewLibId, null, tk);
    check('删除论文库并回退当前库', r.json.ok);
    r = await req(base, 'POST', '/api/libraries/current', { id: defaultLibId }, tk);
    check('切回默认库', r.json.ok && r.json.data.current === defaultLibId);
    r = await req(base, 'GET', '/api/papers', null, tk);
    check('默认库论文恢复为 6 篇', r.json.data.length === 6, 'papers=' + r.json.data.length);

    // 在线抓取（旧路径，网络可用时）

    // 404 / 错误处理
    r = await req(base, 'GET', '/api/papers/p_not_exist', null, tk);
    check('不存在论文返回 404', r.status === 404 && !r.json.ok);
    r = await req(base, 'POST', '/api/links', { from: 'bad', to: 'bad' }, tk);
    check('非法关联返回 404', r.status === 404);

    // 状态汇总
    r = await req(base, 'GET', '/api/status', null, tk);
    check('status 统计正确', r.json.data.papers === 6 && r.json.data.annotations === 1, JSON.stringify(r.json.data));
  } catch (e) {
    check('测试异常终止: ' + e.message, false, appLog.slice(-500));
  } finally {
    // 杀整个进程树，避免便携版 wrapper 派生的孙进程残留
    await new Promise(r => {
      try {
        const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        tk.on('close', r);
        setTimeout(r, 5000);
      } catch (_) { r(); }
    });
    child.kill('SIGKILL');
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
