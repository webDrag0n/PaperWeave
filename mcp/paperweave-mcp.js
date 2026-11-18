#!/usr/bin/env node
/**
 * PaperWeave MCP Server（stdio，零依赖单文件）
 *
 * 让支持 MCP 的 Agent 宿主（Claude Desktop、Cursor、Kimi 等）以 stdio 方式
 * 直接操作运行中的 PaperWeave 论文库。本进程是 PaperWeave 本地 HTTP Agent API
 * 的薄包装：PaperWeave 必须处于运行状态。
 *
 * 连接自发现顺序：
 *   1. 环境变量 PAPERWEAVE_AGENT_API_JSON 指向的 json 文件
 *   2. 本脚本同目录的 paperweave-agent-api.json（便携版 exe 同目录）
 *   3. 平台数据目录：paperweave/paperweave-data/agent-api.json
 *
 * MCP 配置示例（宿主侧）：
 *   { "mcpServers": { "paperweave": { "command": "node", "args": ["<本文件路径>"] } } }
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_INFO = { name: 'paperweave', version: '1.1.0' };
const SERVER_INSTRUCTIONS = '你是用户的科研助理。先确认研究问题与当前论文库，再用论文详情、逐页正文、原文检索、批注和引用图谱取证；区分论文原文、作者主张与自己的推断，结论标注论文 id 和页码。总结需包含方法、证据、局限与后续问题；寻找关联时说明引用方向（from 引用 to）及依据。根据用户主题和已有批注推荐值得高亮的原文，调用 find_text 取得页码与 quads 后才可 add_annotation；不要凭空编造坐标。写入笔记、批注或下载文献前遵循用户意图，保留已有内容。PDF 可能是扫描件，提取不到文字时如实说明。';
const PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

/* ---------------- 连接信息 ---------------- */
function candidatePaths() {
  const list = [];
  if (process.env.PAPERWEAVE_AGENT_API_JSON) list.push(process.env.PAPERWEAVE_AGENT_API_JSON);
  list.push(path.join(__dirname, 'paperweave-agent-api.json'));
  const home = os.homedir();
  if (process.platform === 'win32') {
    list.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'paperweave', 'paperweave-data', 'agent-api.json'));
  } else if (process.platform === 'darwin') {
    list.push(path.join(home, 'Library', 'Application Support', 'paperweave', 'paperweave-data', 'agent-api.json'));
  } else {
    list.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'paperweave', 'paperweave-data', 'agent-api.json'));
  }
  return list;
}

function loadConn() {
  for (const p of candidatePaths()) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (j.baseUrl && j.token) return { baseUrl: j.baseUrl, token: j.token, from: p };
    } catch (_) {}
  }
  return null;
}

/* ---------------- HTTP 调用 ---------------- */
function callApi(method, apiPath, body) {
  return new Promise((resolve) => {
    const conn = loadConn();
    if (!conn) {
      return resolve({ __error: '找不到 PaperWeave 连接信息（agent-api.json）。请先启动 PaperWeave 应用。' });
    }
    const u = new URL(conn.baseUrl + apiPath);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-PaperWeave-Token': conn.token,
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (_) {}
        if (!json) return resolve({ __error: 'PaperWeave 返回了无法解析的响应（HTTP ' + res.statusCode + '）' });
        if (json.ok === false) return resolve({ __error: json.error || ('HTTP ' + res.statusCode) });
        resolve(json.data !== undefined ? json.data : json);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ __error: '请求超时' }); });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') resolve({ __error: 'PaperWeave 未在运行（连接被拒绝）。请先启动 PaperWeave 应用。' });
      else resolve({ __error: '连接 PaperWeave 失败：' + e.message });
    });
    if (data) req.write(data);
    req.end();
  });
}

function readPdfResource(paperId) {
  return new Promise(resolve => {
    const conn = loadConn();
    if (!conn) return resolve({ __error: '找不到 PaperWeave 连接信息。请先启动应用。' });
    const u = new URL(conn.baseUrl + '/api/papers/' + encodeURIComponent(paperId) + '/pdf');
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { 'X-PaperWeave-Token': conn.token }, timeout: 120000 }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { done({ __error: 'PDF 超过 MCP 资源的 64 MiB 限制，可通过 HTTP API 获取原文件。' }); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          let error = 'HTTP ' + res.statusCode;
          try { error = JSON.parse(buf.toString('utf8')).error || error; } catch (_) {}
          return done({ __error: error });
        }
        done({ mimeType: 'application/pdf', blob: buf.toString('base64') });
      });
    });
    req.on('timeout', () => { req.destroy(); done({ __error: '读取 PDF 超时' }); });
    req.on('error', e => done({ __error: '读取 PDF 失败：' + e.message }));
    req.end();
  });
}

/* ---------------- 工具定义 ---------------- */
const TOOLS = [
  {
    name: 'paperweave_status',
    description: '查看 PaperWeave 论文库状态（论文数、引用边数、批注数、库目录）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_list_papers',
    description: '列出论文库中的论文；可用 query 按标题/作者/标签/DOI 过滤。返回每篇的 id、标题、作者、年份、DOI、标签、页数等。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '可选过滤关键词' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_get_paper',
    description: '获取单篇论文详情（含 Markdown 笔记 notes）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '论文 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_update_paper',
    description: '更新论文元数据或笔记。可更新字段：title、authors(数组)、year、venue、doi、abstract、tags(数组)、notes(Markdown 字符串)、favorite、lastPage(阅读位置页码)、rating(重要性评星 0-5，0 为未评分)。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        authors: { type: 'array', items: { type: 'string' } },
        year: { type: 'string' },
        venue: { type: 'string' },
        doi: { type: 'string' },
        abstract: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string', description: 'Markdown 格式论文笔记' },
        favorite: { type: 'boolean' },
        lastPage: { type: 'number', description: '最近阅读到的页码（阅读位置记忆）' },
        rating: { type: 'number', description: '重要性评星 0-5（0 = 未评分）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_delete_paper',
    description: '删除论文及其批注与引用关联。deleteFile 默认 true（同时删除库内 PDF）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        deleteFile: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'paperweave_import_path',
    description: '从本机路径批量导入 PDF 论文（自动提取标题/作者/DOI/摘要/参考文献；统一全局存储，内容哈希或 DOI 命中已有论文时复用同一 id）。conflictPolicy 控制疑似重复：auto（默认，DOI 冲突自动合并）/ merge / new。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'PDF 绝对路径数组' },
        conflictPolicy: { type: 'string', enum: ['auto', 'merge', 'new'] },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_import_url',
    description: '从 URL 下载导入论文。支持 PDF 直链与 arXiv 摘要页链接（自动转 PDF）；统一全局存储去重，conflictPolicy 同 import_path。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        conflictPolicy: { type: 'string', enum: ['auto', 'merge', 'new'] },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_list_annotations',
    description: '读取某篇论文的全部批注（高亮与便利贴）。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_add_annotation',
    description: '为论文追加批注。highlight（文字高亮）需要 page、quads（归一化矩形组 {x,y,w,h}，0~1 相对页面宽高）、可选 text/comment/color；sticky（便利贴）需要 page、x、y（归一化坐标）与 comment。',
    inputSchema: {
      type: 'object',
      properties: {
        paperId: { type: 'string' },
        annotation: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['highlight', 'sticky'] },
            page: { type: 'integer', minimum: 1 },
            quads: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'] } },
            x: { type: 'number' }, y: { type: 'number' },
            color: { type: 'string' },
            text: { type: 'string' },
            comment: { type: 'string' },
          },
          required: ['type', 'page'],
        },
      },
      required: ['paperId', 'annotation'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_set_annotations',
    description: '全量替换某篇论文的批注数组（可用于修改或删除既有批注）。',
    inputSchema: {
      type: 'object',
      properties: {
        paperId: { type: 'string' },
        annotations: { type: 'array', items: { type: 'object' } },
      },
      required: ['paperId', 'annotations'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'paperweave_list_links',
    description: '列出库内全部引用关联。语义：from 引用了 to。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_add_link',
    description: '新增引用关联：from 引用了 to（均为论文 id）。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '引用方论文 id' },
        to: { type: 'string', description: '被引方论文 id' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_delete_link',
    description: '按关联 id 删除一条引用边。',
    inputSchema: {
      type: 'object',
      properties: { linkId: { type: 'string' } },
      required: ['linkId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'paperweave_fetch_references',
    description: '抓取该论文的"引用"（参考文献）：解析 PDF 参考文献段落，逐条经 DOI（CrossRef）/ arXiv 编号 / 标题（OpenAlex）网络检索确认，并匹配库内论文建立引用边。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_fetch_citations',
    description: '抓取该论文的"被引"（谁引用了它）：从 Semantic Scholar 查询（限流退避），失败自动回退 OpenAlex；命中库内论文建立被引边。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_fetch_refs',
    description: '组合抓取（参考文献 + 被引）。等价于依次调用 paperweave_fetch_references 与 paperweave_fetch_citations。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_auto_match_refs',
    description: '离线解析该论文 PDF 的参考文献段落，与库内论文标题模糊匹配建立引用边（无需网络）。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_download_ref',
    description: '下载单条「未入库引用」（externalRefs 中的条目）：经 arXiv / OpenAlex 开放获取解析 PDF 地址，下载入库（默认无评分）并自动建边；失败返回 key/dir/title/error 并记录 downloadError，可用原 key 重试。',
    inputSchema: {
      type: 'object',
      properties: {
        paperId: { type: 'string' },
        key: { type: 'string', description: 'externalRefs 条目的 key（见 paperweave_get_paper 返回的 externalRefs）' },
      },
      required: ['paperId', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_download_all_refs',
    description: '一键下载该论文全部未入库引用文献：dir 可选 out（本文引用的）/ in（引用本文的）/ both（默认全部）。逐条下载入库并自动建边，返回失败列表。',
    inputSchema: {
      type: 'object',
      properties: {
        paperId: { type: 'string' },
        dir: { type: 'string', enum: ['out', 'in', 'both'] },
      },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_list_libraries',
    description: '列出全部论文库及当前库（含每个库的论文数与引用边数）。多库共享统一论文存储，同一论文跨库复用同一 id。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_create_library',
    description: '新建论文库。默认同时切换到新库（switch=false 可只建不切）。支持简介 desc 与标志图标 icon（emoji）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        desc: { type: 'string', description: '论文库简介' },
        icon: { type: 'string', description: '标志图标（单个 emoji，如 🤖）' },
        switch: { type: 'boolean' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_update_library',
    description: '更新论文库的名称 / 简介 / 标志图标（icon，一个 emoji）/ 置顶（pinned）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        desc: { type: 'string' },
        icon: { type: 'string', description: '标志图标（单个 emoji，如 🤖）' },
        pinned: { type: 'boolean', description: '星标置顶' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_reorder_libraries',
    description: '按给定 id 顺序重排论文库列表（拖拽排序持久化）。',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_switch_library',
    description: '切换当前论文库。之后的论文列表、引用图谱、导入与抓取都作用于该库。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '论文库 id（见 paperweave_list_libraries）' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'paperweave_get_graph',
    description: '获取引用图谱快照：nodes（论文）与 edges（{from,to,source}，from 引用 to）。渲染约定：选中节点的引用方为橙色、被引方为蓝色、互引为紫色。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_list_all_papers',
    description: '列出所有论文库中的全部论文，含未归属论文与 libraryIds。用于跨库发现和去重。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_read_pages',
    description: '逐页读取库内 PDF 正文文本，带页码和 nextPage。总结论文时必须结合正文，不要只凭摘要；扫描件可能返回空文本。每次最多 10 页。',
    inputSchema: { type: 'object', properties: {
      paperId: { type: 'string' }, startPage: { type: 'integer', minimum: 1 },
      pageCount: { type: 'integer', minimum: 1, maximum: 10 },
    }, required: ['paperId'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_find_text',
    description: '在 PDF 正文中查找原文短语，返回页码、上下文和近似归一化 quads，可供 add_annotation 定位。若有多个匹配，先核对上下文再高亮；每次最多检索 50 页。',
    inputSchema: { type: 'object', properties: {
      paperId: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 200 },
      startPage: { type: 'integer', minimum: 1 }, pageCount: { type: 'integer', minimum: 1, maximum: 50 },
    }, required: ['paperId', 'query'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_update_annotation',
    description: '按批注 id 修改评论、颜色、文本或位置，保留同篇论文的其他批注。',
    inputSchema: { type: 'object', properties: {
      paperId: { type: 'string' }, annotationId: { type: 'string' },
      comment: { type: 'string' }, color: { type: 'string' }, text: { type: 'string' },
      page: { type: 'integer', minimum: 1 }, quads: { type: 'array', items: { type: 'object' } },
      x: { type: 'number' }, y: { type: 'number' },
    }, required: ['paperId', 'annotationId'], additionalProperties: false },
  },
  {
    name: 'paperweave_delete_annotation',
    description: '按批注 id 删除单条高亮或便利贴，保留其他批注。',
    inputSchema: { type: 'object', properties: { paperId: { type: 'string' }, annotationId: { type: 'string' } }, required: ['paperId', 'annotationId'], additionalProperties: false },
    annotations: { destructiveHint: true },
  },
  {
    name: 'paperweave_list_all_links',
    description: '跨论文库汇总引用边，同一 from/to 仅显示一次，libraryLinks 保留各库原始关联 id。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_add_to_library',
    description: '把已下载的论文加入指定论文库，复用全局论文 id。',
    inputSchema: { type: 'object', properties: { paperId: { type: 'string' }, libraryId: { type: 'string' } }, required: ['paperId', 'libraryId'], additionalProperties: false },
  },
  {
    name: 'paperweave_delete_library',
    description: '删除指定论文库；全局论文本体可能仍属于其他库。至少须保留一个库。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { destructiveHint: true },
  },
  {
    name: 'paperweave_get_fetch_progress',
    description: '查询某篇论文当前的引用抓取与下载进度。',
    inputSchema: { type: 'object', properties: { paperId: { type: 'string' } }, required: ['paperId'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'paperweave_import_web',
    description: '从网页 PDF 地址导入并补齐网页元数据，可指定目标论文库；已有非空元数据不会被覆盖。',
    inputSchema: { type: 'object', properties: {
      url: { type: 'string' }, pdfUrl: { type: 'string' }, libraryId: { type: 'string' },
      title: { type: 'string' }, authors: { type: 'array', items: { type: 'string' } },
      year: { type: 'string' }, doi: { type: 'string' }, abstract: { type: 'string' },
      venue: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      rating: { type: 'number' }, conflictPolicy: { type: 'string', enum: ['auto', 'merge', 'new'] },
    }, additionalProperties: false },
  },
];

/* ---------------- 工具执行 ---------------- */
async function runTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'paperweave_status':
      return callApi('GET', '/api/status');
    case 'paperweave_list_papers': {
      const data = await callApi('GET', '/api/papers');
      if (data.__error) return data;
      let papers = data;
      if (a.query) {
        const q = String(a.query).toLowerCase();
        papers = papers.filter(p => [p.title, (p.authors || []).join(' '), (p.tags || []).join(' '), p.doi, p.venue]
          .join(' ').toLowerCase().includes(q));
      }
      return papers;
    }
    case 'paperweave_get_paper':
      return callApi('GET', '/api/papers/' + encodeURIComponent(a.id));
    case 'paperweave_update_paper': {
      const { id, ...patch } = a;
      return callApi('PATCH', '/api/papers/' + encodeURIComponent(id), patch);
    }
    case 'paperweave_delete_paper':
      return callApi('DELETE', '/api/papers/' + encodeURIComponent(a.id) + '?deleteFile=' + (a.deleteFile === false ? '0' : '1'));
    case 'paperweave_import_path':
      return callApi('POST', '/api/papers/import-path', { paths: a.paths || [], conflictPolicy: a.conflictPolicy || 'auto' });
    case 'paperweave_import_url':
      return callApi('POST', '/api/papers/import-url', { url: a.url, conflictPolicy: a.conflictPolicy || 'auto' });
    case 'paperweave_list_annotations':
      return callApi('GET', '/api/papers/' + encodeURIComponent(a.paperId) + '/annotations');
    case 'paperweave_add_annotation':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/annotations', a.annotation);
    case 'paperweave_set_annotations':
      return callApi('PUT', '/api/papers/' + encodeURIComponent(a.paperId) + '/annotations', a.annotations || []);
    case 'paperweave_list_links':
      return callApi('GET', '/api/links');
    case 'paperweave_add_link':
      return callApi('POST', '/api/links', { from: a.from, to: a.to });
    case 'paperweave_delete_link':
      return callApi('DELETE', '/api/links/' + encodeURIComponent(a.linkId));
    case 'paperweave_fetch_references':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/fetch-references');
    case 'paperweave_fetch_citations':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/fetch-citations');
    case 'paperweave_fetch_refs':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/fetch-refs');
    case 'paperweave_auto_match_refs':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/auto-match');
    case 'paperweave_download_ref':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/download-ref', { key: a.key });
    case 'paperweave_download_all_refs':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/download-all-refs', { dir: a.dir || 'both' });
    case 'paperweave_list_libraries':
      return callApi('GET', '/api/libraries');
    case 'paperweave_create_library':
      return callApi('POST', '/api/libraries', { name: a.name, desc: a.desc, icon: a.icon, switch: a.switch });
    case 'paperweave_update_library': {
      const { id, ...patch } = a;
      return callApi('PATCH', '/api/libraries/' + encodeURIComponent(id), patch);
    }
    case 'paperweave_reorder_libraries':
      return callApi('POST', '/api/libraries/reorder', { ids: a.ids || [] });
    case 'paperweave_switch_library':
      return callApi('POST', '/api/libraries/current', { id: a.id });
    case 'paperweave_get_graph':
      return callApi('GET', '/api/graph');
    case 'paperweave_list_all_papers':
      return callApi('GET', '/api/papers/all');
    case 'paperweave_read_pages': {
      const query = new URLSearchParams({ startPage: String(a.startPage ?? 1), pageCount: String(a.pageCount ?? 3) });
      return callApi('GET', '/api/papers/' + encodeURIComponent(a.paperId) + '/text?' + query);
    }
    case 'paperweave_find_text': {
      const query = new URLSearchParams({ query: String(a.query || ''), startPage: String(a.startPage ?? 1), pageCount: String(a.pageCount ?? 30) });
      return callApi('GET', '/api/papers/' + encodeURIComponent(a.paperId) + '/find-text?' + query);
    }
    case 'paperweave_update_annotation': {
      const { paperId, annotationId, ...patch } = a;
      return callApi('PATCH', '/api/papers/' + encodeURIComponent(paperId) + '/annotations/' + encodeURIComponent(annotationId), patch);
    }
    case 'paperweave_delete_annotation':
      return callApi('DELETE', '/api/papers/' + encodeURIComponent(a.paperId) + '/annotations/' + encodeURIComponent(a.annotationId));
    case 'paperweave_list_all_links':
      return callApi('GET', '/api/links/all');
    case 'paperweave_add_to_library':
      return callApi('POST', '/api/libraries/' + encodeURIComponent(a.libraryId) + '/papers', { paperId: a.paperId });
    case 'paperweave_delete_library':
      return callApi('DELETE', '/api/libraries/' + encodeURIComponent(a.id));
    case 'paperweave_get_fetch_progress':
      return callApi('GET', '/api/papers/' + encodeURIComponent(a.paperId) + '/fetch-progress');
    case 'paperweave_import_web':
      return callApi('POST', '/api/papers/import-web', a);
    default:
      return { __error: '未知工具：' + name };
  }
}

/* ---------------- 资源（Resources） ---------------- */
const RESOURCE_LIST = [
  {
    uri: 'paperweave://guide', name: '科研助理使用指南',
    description: '取证、总结、关联分析与高亮建议的工作准则', mimeType: 'text/markdown',
  },
  {
    uri: 'paperweave://all-papers', name: '全部已下载论文',
    description: '跨库论文列表，包含 libraryIds', mimeType: 'application/json',
  },
  {
    uri: 'paperweave://all-links', name: '跨库引用关系',
    description: '跨库去重的引用边列表', mimeType: 'application/json',
  },
  {
    uri: 'paperweave://papers',
    name: '论文库列表',
    description: '全部论文的 JSON 列表（id、标题、作者、年份、DOI、标签等）',
    mimeType: 'application/json',
  },
  {
    uri: 'paperweave://graph',
    name: '引用图谱快照',
    description: '引用网络 JSON：nodes（论文）+ edges（from 引用 to）',
    mimeType: 'application/json',
  },
];

const RESOURCE_TEMPLATE_LIST = [
  {
    uriTemplate: 'paperweave://papers/{id}/pdf',
    name: 'PDF 原文件', description: '论文 PDF 的 base64 二进制资源（最大 64 MiB）', mimeType: 'application/pdf',
  },
  {
    uriTemplate: 'paperweave://papers/{id}/pages/{page}',
    name: 'PDF 单页正文', description: '指定论文与页码的提取文本', mimeType: 'text/plain',
  },
  {
    uriTemplate: 'paperweave://papers/{id}',
    name: '论文详情',
    description: '单篇论文详情 JSON（含 Markdown 笔记）',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'paperweave://papers/{id}/notes',
    name: '论文笔记',
    description: '单篇论文的 Markdown 笔记纯文本',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'paperweave://papers/{id}/annotations',
    name: '论文批注',
    description: '单篇论文的高亮与便利贴 JSON',
    mimeType: 'application/json',
  },
];

async function readResource(uri) {
  const pdfMatch = uri.match(/^paperweave:\/\/papers\/([^/]+)\/pdf$/);
  if (pdfMatch) return readPdfResource(pdfMatch[1]);
  if (uri === 'paperweave://guide') return { mimeType: 'text/markdown', text: '# PaperWeave 科研助理\n\n' + SERVER_INSTRUCTIONS + '\n\n工作顺序：列出或定位论文 → 读取元数据、正文、批注 → 核对图谱与引用方向 → 给出带页码的分析 → 按用户意图保存笔记或高亮。原文检索返回的 quads 是近似坐标，高亮前应核对上下文。' };
  if (uri === 'paperweave://all-papers' || uri === 'paperweave://all-links') {
    const data = await callApi('GET', uri.endsWith('papers') ? '/api/papers/all' : '/api/links/all');
    if (data.__error) return data;
    return { mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  const pageMatch = uri.match(/^paperweave:\/\/papers\/([^/]+)\/pages\/(\d+)$/);
  if (pageMatch) {
    const data = await callApi('GET', '/api/papers/' + encodeURIComponent(pageMatch[1]) + '/text?startPage=' + pageMatch[2] + '&pageCount=1');
    if (data.__error) return data;
    if (!data.pages.length) return { __error: '页码超出范围：' + pageMatch[2] };
    return { mimeType: 'text/plain', text: data.pages[0].text };
  }
  const m = uri.match(/^paperweave:\/\/(papers|graph)(?:\/([^/]+)(?:\/(notes|annotations))?)?$/);
  if (!m) return { __error: '未知资源 URI：' + uri };
  const [, kind, id, sub] = m;
  if (kind === 'graph') {
    const data = await callApi('GET', '/api/graph');
    if (data.__error) return data;
    return { mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  if (kind === 'papers' && !id) {
    const data = await callApi('GET', '/api/papers');
    if (data.__error) return data;
    return { mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  if (kind === 'papers' && id && !sub) {
    const data = await callApi('GET', '/api/papers/' + encodeURIComponent(id));
    if (data.__error) return data;
    return { mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  if (kind === 'papers' && id && sub === 'notes') {
    const data = await callApi('GET', '/api/papers/' + encodeURIComponent(id));
    if (data.__error) return data;
    return { mimeType: 'text/markdown', text: data.notes || '（暂无笔记）' };
  }
  if (kind === 'papers' && id && sub === 'annotations') {
    const data = await callApi('GET', '/api/papers/' + encodeURIComponent(id) + '/annotations');
    if (data.__error) return data;
    return { mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  return { __error: '未知资源 URI：' + uri };
}

/* ---------------- 提示模板（Prompts） ---------------- */
const PROMPT_LIST = [
  {
    name: 'paperweave_read_paper',
    description: '精读一篇库内论文：拉取元数据、笔记与批注，产出结构化阅读报告并回写笔记。',
    arguments: [
      { name: 'paper', description: '论文 id 或标题关键词', required: true },
    ],
  },
  {
    name: 'paperweave_literature_review',
    description: '围绕一个主题在论文库中做小型文献综述：检索相关论文、分析引用网络、生成综述并回写。',
    arguments: [
      { name: 'topic', description: '综述主题', required: true },
    ],
  },
  {
    name: 'paperweave_import_and_link',
    description: '导入一篇新论文并接入引用网络：导入、补全元数据、建立引用边、报告它与库内论文的关系。',
    arguments: [
      { name: 'source', description: '本机 PDF 绝对路径或下载链接（支持 arXiv 页面）', required: true },
    ],
  },
  {
    name: 'paperweave_research_insights',
    description: '围绕研究问题寻找跨论文关联、矛盾、证据缺口和后续实验方向。',
    arguments: [{ name: 'question', description: '研究问题或主题', required: true }],
  },
  {
    name: 'paperweave_highlight_interests',
    description: '按用户兴趣从原文推荐并定位值得高亮的段落。',
    arguments: [
      { name: 'paper', description: '论文 id 或标题关键词', required: true },
      { name: 'interests', description: '用户关注的方法、结论或主题', required: true },
    ],
  },
];

function getPrompt(name, args) {
  const a = args || {};
  const wrap = (text) => ({ description: PROMPT_LIST.find(p => p.name === name).description, messages: [{ role: 'user', content: { type: 'text', text } }] });
  if (name === 'paperweave_read_paper') {
    return wrap(`请使用 paperweave 的 MCP 工具精读论文「${a.paper || ''}」并产出阅读报告。步骤：
1. 用 paperweave_list_papers（query 过滤）找到目标论文，若给出的是 id 可直接 paperweave_get_paper。
2. 读取 paperweave_list_annotations 与现有 notes，使用 paperweave_read_pages 按 nextPage 逐页阅读正文，特别核对方法、实验与结论；扫描件无文本时说明限制。
3. 结合原文证据产出结构化阅读报告：研究问题、核心方法、关键创新、实验结论、局限性、值得跟进的方向。关键论断标注论文 id 与 PDF 页码，明确区分原文和你的推断。
4. 如用户希望保存，用 paperweave_update_paper 把报告追加写入 notes，保留原内容。
5. 用 paperweave_get_graph 核对它引用了谁及谁引用它，说明关联依据。`);
  }
  if (name === 'paperweave_literature_review') {
    return wrap(`请使用 paperweave 的 MCP 工具围绕主题「${a.topic || ''}」做小型文献综述。步骤：
1. 用 paperweave_list_papers（query 多次换关键词）检索库内相关论文。
2. 对相关论文用 paperweave_get_paper 读取摘要与笔记，再用 paperweave_read_pages 阅读关键正文页；必要时用 paperweave_find_text 定位主张。
3. 用 paperweave_get_graph 分析引用方向、共同参考文献、研究路线与可能的矛盾。
4. 产出综述：主题脉络、论文贡献对比、证据强弱、研究空白；每条重要结论附论文 id 与页码，推断须明确标出。
5. 只有用户希望保存时，才用 paperweave_update_paper 追加 Markdown 笔记。`);
  }
  if (name === 'paperweave_import_and_link') {
    return wrap(`请使用 paperweave 的 MCP 工具导入论文「${a.source || ''}」并接入引用网络。步骤：
1. 判断来源类型：本机路径用 paperweave_import_path，URL 用 paperweave_import_url。
2. 导入后用 paperweave_get_paper 检查自动提取的元数据（标题/作者/年份/DOI），缺失时用 paperweave_update_paper 补全。
3. 用 paperweave_auto_match_refs 离线匹配库内参考文献建边；有网络时用 paperweave_fetch_refs 进一步抓取引用与被引。
4. 用 paperweave_get_graph 查看新的引用网络，报告：该论文引用了库内哪些论文、被库内哪些论文引用、与哪些论文互引。`);
  }
  if (name === 'paperweave_research_insights') {
    return wrap(`请围绕「${a.question || ''}」使用 PaperWeave 做研究洞察：先用 paperweave_list_all_papers 和 paperweave_list_all_links 找到跨库相关论文；读取相关论文的摘要、批注与关键正文页；用 paperweave_get_graph 核对引用方向。寻找共同来源、方法差异、互相矛盾的结果与尚缺的证据，提出可验证的研究问题。每条洞察附论文 id、页码和证据摘述；明确标明推断，不把相关性写成因果。`);
  }
  if (name === 'paperweave_highlight_interests') {
    return wrap(`请在论文「${a.paper || ''}」中围绕用户兴趣「${a.interests || ''}」寻找值得标注的亮点。用 paperweave_get_paper 与 paperweave_list_annotations 了解背景和已有标注，再用 paperweave_read_pages 逐页阅读。列出少量候选原文、页码及对用户有用的原因；调用 paperweave_find_text 核对原文与上下文并取得 quads。只有用户要求保存高亮时，才用 paperweave_add_annotation 写入 type=highlight、page、quads、text、comment；不要凭空猜测坐标或重复标注。`);
  }
  return { __error: '未知提示模板：' + name };
}

/* ---------------- stdio JSON-RPC ---------------- */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    const clientVer = params && params.protocolVersion;
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOL_VERSIONS.has(clientVer) ? clientVer : '2025-06-18',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { if (isRequest) send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const data = await runTool(name, args);
      if (data && data.__error) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: data.__error }], isError: true } });
      } else {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '工具执行失败：' + e.message }], isError: true } });
    }
    return;
  }
  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: RESOURCE_LIST } });
    return;
  }
  if (method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id, result: { resourceTemplates: RESOURCE_TEMPLATE_LIST } });
    return;
  }
  if (method === 'resources/read') {
    const uri = params && params.uri;
    const r = await readResource(String(uri || ''));
    if (r.__error) {
      send({ jsonrpc: '2.0', id, error: { code: -32002, message: r.__error } });
    } else {
      send({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: r.mimeType, ...(r.blob ? { blob: r.blob } : { text: r.text }) }] } });
    }
    return;
  }
  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: PROMPT_LIST } });
    return;
  }
  if (method === 'prompts/get') {
    const r = getPrompt(params && params.name, params && params.arguments);
    if (r.__error) send({ jsonrpc: '2.0', id, error: { code: -32602, message: r.__error } });
    else send({ jsonrpc: '2.0', id, result: r });
    return;
  }
  if (isRequest) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    handleMessage(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
// 诊断日志只走 stderr，保持 stdout 干净
console.error('[paperweave-mcp] started, connection search order: ' + candidatePaths().join(' | '));
