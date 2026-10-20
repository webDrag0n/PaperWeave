// PaperGraph Agent HTTP API：内嵌在本地的智能体操作接口
// 默认监听 127.0.0.1:24680（占用时自动递增），除 /api/ping 外均需 X-PaperGraph-Token 鉴权
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 24680;

function readBody(req, cap = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > cap) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// onChanged(): 数据变更后通知渲染进程刷新
// refsProgress: 进度 Map；onProgress(paperId): 生成进度回调
function startAgentApi({ store, service, token, appVersion, onChanged, refsProgress, onProgress }) {
  const paperPublic = (p) => (p ? { ...p, refText: undefined } : null);
  const progressOf = (paperId) => (refsProgress && refsProgress.get(paperId)) || null;
  const progressFn = (paperId) => (onProgress ? onProgress(paperId) : undefined);

  async function route(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const parts = u.pathname.split('/').filter(Boolean); // ['api','papers',':id',...]

    // 公共探活
    if (u.pathname === '/api/ping') {
      return json(res, 200, { ok: true, name: 'PaperGraph', version: appVersion, api: 4 });
    }
    // 鉴权
    if (req.headers['x-papergraph-token'] !== token) {
      return json(res, 401, { ok: false, error: '缺少或错误的 X-PaperGraph-Token' });
    }

    const m = req.method;
    try {
      // ---------- 状态 ----------
      if (u.pathname === '/api/status' && m === 'GET') {
        return json(res, 200, {
          ok: true,
          data: {
            version: appVersion,
            papers: store.data.papers.length,
            links: store.data.links.length,
            annotations: Object.values(store.data.annotations).reduce((s, a) => s + a.length, 0),
            libraryDir: store.libraryDir,
            library: store.currentLibraryId(),
            libraries: store.listLibraries().length,
          },
        });
      }

      // ---------- 论文库（多库管理） ----------
      if (u.pathname === '/api/libraries' && m === 'GET') {
        return json(res, 200, { ok: true, data: { current: store.currentLibraryId(), libraries: store.listLibraries() } });
      }
      if (u.pathname === '/api/libraries' && m === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        const lib = store.createLibrary(body.name, body.desc, body.icon);
        if (body.switch !== false) store.setCurrentLibrary(lib.id);
        onChanged();
        return json(res, 200, { ok: true, data: lib });
      }
      if (u.pathname === '/api/libraries/reorder' && m === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        const okOrder = store.reorderLibraries(body.ids);
        onChanged();
        return json(res, okOrder ? 200 : 400, { ok: okOrder });
      }
      if (parts[0] === 'api' && parts[1] === 'libraries' && parts[2] && m === 'PATCH') {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        const lib = store.updateLibrary(parts[2], body);
        onChanged();
        return json(res, lib ? 200 : 404, lib ? { ok: true, data: lib } : { ok: false, error: '论文库不存在' });
      }
      if (u.pathname === '/api/libraries/current' && m === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        const okSwitch = store.setCurrentLibrary(body.id);
        onChanged();
        return json(res, okSwitch ? 200 : 404, okSwitch ? { ok: true, data: { current: store.currentLibraryId() } } : { ok: false, error: '论文库不存在' });
      }
      if (parts[0] === 'api' && parts[1] === 'libraries' && parts[2] && m === 'DELETE') {
        const ok = store.deleteLibrary(parts[2]);
        onChanged();
        return json(res, ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: '论文库不存在或至少需保留一个' });
      }

      // ---------- 论文 ----------
      if (u.pathname === '/api/papers' && m === 'GET') {
        return json(res, 200, { ok: true, data: store.listPapers() });
      }
      if (u.pathname === '/api/papers/import-path' && m === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        const paths = body.paths || (body.path ? [body.path] : []);
        if (!paths.length) return json(res, 400, { ok: false, error: '需要 path 或 paths 字段' });
        // Agent 无弹窗：冲突策略默认 auto（DOI 相同自动复用；仅标题相似时新建）
        const results = await service.importFromPaths(paths, { conflictPolicy: body.conflictPolicy || 'auto' });
        onChanged();
        const conflicts = results.filter(r => r.conflict);
        return json(res, 200, { ok: true, data: results, ...(conflicts.length ? { conflicts: conflicts.map(c => c.conflict) } : {}) });
      }
      if (u.pathname === '/api/papers/import-url' && m === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        if (!body.url) return json(res, 400, { ok: false, error: '需要 url 字段' });
        try {
          const r = await service.importFromUrl(body.url, { conflictPolicy: body.conflictPolicy || 'auto' });
          onChanged();
          return json(res, 200, { ok: true, data: r });
        } catch (e) {
          return json(res, 502, { ok: false, error: e.message });
        }
      }

      if (parts[0] === 'api' && parts[1] === 'papers' && parts[2]) {
        const id = parts[2];
        const paper = store.getPaper(id);
        if (!paper) return json(res, 404, { ok: false, error: '论文不存在' });

        if (parts.length === 3) {
          if (m === 'GET') return json(res, 200, { ok: true, data: paperPublic(paper) });
          if (m === 'PATCH') {
            const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
            const updated = store.updatePaper(id, body);
            if (!updated) return json(res, 400, { ok: false, error: '没有可更新的字段' });
            onChanged();
            return json(res, 200, { ok: true, data: paperPublic(updated) });
          }
          if (m === 'DELETE') {
            const ok = store.removePaper(id, u.searchParams.get('deleteFile') !== '0');
            onChanged();
            return json(res, 200, { ok, data: { deleted: ok } });
          }
        }
        if (parts[3] === 'pdf' && m === 'GET') {
          const fp = store.paperFilePath(paper);
          if (!fp || !fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'PDF 文件缺失' });
          const buf = fs.readFileSync(fp);
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
          return res.end(buf);
        }
        if (parts[3] === 'annotations') {
          if (m === 'GET') return json(res, 200, { ok: true, data: store.getAnnotations(id) });
          const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
          if (m === 'POST') {
            // 追加一条或多条批注
            const anns = store.getAnnotations(id);
            const items = Array.isArray(body) ? body : [body];
            for (const a of items) {
              if (!a || !a.type || !a.page) return json(res, 400, { ok: false, error: '批注至少需要 type 与 page 字段' });
              anns.push({
                id: 'a_' + Math.random().toString(36).slice(2, 10),
                type: a.type, page: a.page,
                quads: a.quads, x: a.x, y: a.y,
                color: a.color || (a.type === 'sticky' ? '#ff7a4a' : '#ffe74a'),
                text: a.text || '', comment: a.comment || '',
                createdAt: Date.now(),
              });
            }
            store.setAnnotations(id, anns);
            onChanged();
            return json(res, 200, { ok: true, data: anns });
          }
          if (m === 'PUT') {
            const list = Array.isArray(body) ? body : body.annotations;
            if (!Array.isArray(list)) return json(res, 400, { ok: false, error: '需要批注数组' });
            store.setAnnotations(id, list);
            onChanged();
            return json(res, 200, { ok: true, data: store.getAnnotations(id) });
          }
        }
        if (parts[3] === 'fetch-refs' && m === 'POST') {
          const r = await service.fetchRefs(id, progressFn(id));
          onChanged();
          return json(res, r.ok ? 200 : 502, r.ok ? { ok: true, data: r } : r);
        }
        if (parts[3] === 'fetch-references' && m === 'POST') {
          const r = await service.fetchReferences(id, progressFn(id));
          onChanged();
          return json(res, r.ok ? 200 : 422, r.ok ? { ok: true, data: r } : r);
        }
        if (parts[3] === 'fetch-citations' && m === 'POST') {
          const r = await service.fetchCitations(id, progressFn(id));
          onChanged();
          return json(res, r.ok ? 200 : 502, r.ok ? { ok: true, data: r } : r);
        }
        if (parts[3] === 'fetch-progress' && m === 'GET') {
          const p = progressOf(id);
          return json(res, 200, { ok: true, data: p || { note: '暂无进行中的抓取' } });
        }
        if (parts[3] === 'auto-match' && m === 'POST') {
          const r = service.autoMatch(id);
          onChanged();
          return json(res, r.ok ? 200 : 422, r.ok ? { ok: true, data: r } : r);
        }
        // 下载单条未入库引用文献（入库后默认无评分，自动建边）
        if (parts[3] === 'download-ref' && m === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
          if (!body.key) return json(res, 400, { ok: false, error: '需要 key 字段（externalRefs 条目的 key）' });
          try {
            const r = await service.downloadRef(id, body.key, progressFn(id));
            onChanged();
            return json(res, r.ok ? 200 : 502, r.ok ? { ok: true, data: r } : r);
          } catch (e) {
            return json(res, 502, { ok: false, error: e.message });
          }
        }
        // 一键下载全部未入库引用（dir: out=本文引用的 / in=引用本文的 / both=全部）
        if (parts[3] === 'download-all-refs' && m === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
          try {
            const r = await service.downloadAllRefs(id, body.dir || 'both', progressFn(id));
            onChanged();
            return json(res, r.ok ? 200 : 502, r.ok ? { ok: true, data: r } : r);
          } catch (e) {
            return json(res, 502, { ok: false, error: e.message });
          }
        }
      }

      // ---------- 引用关联 ----------
      if (u.pathname === '/api/links' && m === 'GET') {
        return json(res, 200, { ok: true, data: store.listLinks() });
      }
      if (u.pathname === '/api/links' && m === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        if (!body.from || !body.to) return json(res, 400, { ok: false, error: '需要 from 与 to（论文 id，含义：from 引用 to）' });
        if (!store.getPaper(body.from) || !store.getPaper(body.to)) return json(res, 404, { ok: false, error: 'from 或 to 论文不存在' });
        const link = store.addLink(body.from, body.to, 'agent');
        onChanged();
        return json(res, 200, { ok: true, data: link });
      }
      if (parts[0] === 'api' && parts[1] === 'links' && parts[2] && m === 'DELETE') {
        const ok = store.removeLink(parts[2]);
        onChanged();
        return json(res, ok ? 200 : 404, { ok, data: { deleted: ok } });
      }

      // ---------- 图谱 ----------
      if (u.pathname === '/api/graph' && m === 'GET') {
        return json(res, 200, {
          ok: true,
          data: {
            nodes: store.listPapers().map(p => ({
              id: p.id, title: p.title, authors: p.authors, year: p.year, doi: p.doi, tags: p.tags,
            })),
            // edges: from 引用了 to
            edges: store.listLinks().map(l => ({ id: l.id, from: l.from, to: l.to, source: l.source })),
          },
        });
      }

      return json(res, 404, { ok: false, error: '未知接口：' + m + ' ' + u.pathname });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      route(req, res).catch(e => json(res, 500, { ok: false, error: e.message }));
    });
    let port = DEFAULT_PORT;
    const tryListen = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && port < DEFAULT_PORT + 20) { port++; tryListen(); }
        else { console.error('agent api listen failed:', e.message); resolve(null); }
      });
      server.listen(port, '127.0.0.1', () => resolve({ server, port }));
    };
    tryListen();
  });
}

// 写入连接信息文件（数据目录 + 尽可能 exe 同目录）
function writeConnectionInfo({ dataDir, exeDir, port, token, version }) {
  const info = { api: 'PaperGraph Agent API', version, port, token, baseUrl: `http://127.0.0.1:${port}`, pid: process.pid, startedAt: new Date().toISOString() };
  const text = JSON.stringify(info, null, 2);
  const targets = [path.join(dataDir, 'agent-api.json')];
  if (exeDir) targets.push(path.join(exeDir, 'papergraph-agent-api.json'));
  const written = [];
  for (const t of targets) {
    try { fs.writeFileSync(t, text); written.push(t); } catch (_) {}
  }
  return written;
}

module.exports = { startAgentApi, writeConnectionInfo };
