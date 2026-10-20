#!/usr/bin/env node
/**
 * PaperGraph MCP Server（stdio，零依赖单文件）
 *
 * 让支持 MCP 的 Agent 宿主（Claude Desktop、Cursor、Kimi 等）以 stdio 方式
 * 直接操作运行中的 PaperGraph 论文库。本进程是 PaperGraph 本地 HTTP Agent API
 * 的薄包装：PaperGraph 必须处于运行状态。
 *
 * 连接自发现顺序：
 *   1. 环境变量 PAPERGRAPH_AGENT_API_JSON 指向的 json 文件
 *   2. 本脚本同目录的 papergraph-agent-api.json（便携版 exe 同目录）
 *   3. 平台数据目录：papergraph/papergraph-data/agent-api.json
 *
 * MCP 配置示例（宿主侧）：
 *   { "mcpServers": { "papergraph": { "command": "node", "args": ["<本文件路径>"] } } }
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_INFO = { name: 'papergraph', version: '0.9.0' };
const PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

/* ---------------- 连接信息 ---------------- */
function candidatePaths() {
  const list = [];
  if (process.env.PAPERGRAPH_AGENT_API_JSON) list.push(process.env.PAPERGRAPH_AGENT_API_JSON);
  list.push(path.join(__dirname, 'papergraph-agent-api.json'));
  const home = os.homedir();
  if (process.platform === 'win32') {
    list.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'papergraph', 'papergraph-data', 'agent-api.json'));
  } else if (process.platform === 'darwin') {
    list.push(path.join(home, 'Library', 'Application Support', 'papergraph', 'papergraph-data', 'agent-api.json'));
  } else {
    list.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'papergraph', 'papergraph-data', 'agent-api.json'));
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
      return resolve({ __error: '找不到 PaperGraph 连接信息（agent-api.json）。请先启动 PaperGraph 应用。' });
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
        'X-PaperGraph-Token': conn.token,
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (_) {}
        if (!json) return resolve({ __error: 'PaperGraph 返回了无法解析的响应（HTTP ' + res.statusCode + '）' });
        if (json.ok === false) return resolve({ __error: json.error || ('HTTP ' + res.statusCode) });
        resolve(json.data !== undefined ? json.data : json);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ __error: '请求超时' }); });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') resolve({ __error: 'PaperGraph 未在运行（连接被拒绝）。请先启动 PaperGraph 应用。' });
      else resolve({ __error: '连接 PaperGraph 失败：' + e.message });
    });
    if (data) req.write(data);
    req.end();
  });
}

/* ---------------- 工具定义 ---------------- */
const TOOLS = [
  {
    name: 'papergraph_status',
    description: '查看 PaperGraph 论文库状态（论文数、引用边数、批注数、库目录）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'papergraph_list_papers',
    description: '列出论文库中的论文；可用 query 按标题/作者/标签/DOI 过滤。返回每篇的 id、标题、作者、年份、DOI、标签、页数等。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '可选过滤关键词' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'papergraph_get_paper',
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
    name: 'papergraph_update_paper',
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
    name: 'papergraph_delete_paper',
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
    name: 'papergraph_import_path',
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
    name: 'papergraph_import_url',
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
    name: 'papergraph_list_annotations',
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
    name: 'papergraph_add_annotation',
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
    name: 'papergraph_set_annotations',
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
    name: 'papergraph_list_links',
    description: '列出库内全部引用关联。语义：from 引用了 to。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'papergraph_add_link',
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
    name: 'papergraph_delete_link',
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
    name: 'papergraph_fetch_references',
    description: '抓取该论文的"引用"（参考文献）：解析 PDF 参考文献段落，逐条经 DOI（CrossRef）/ arXiv 编号 / 标题（OpenAlex）网络检索确认，并匹配库内论文建立引用边。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'papergraph_fetch_citations',
    description: '抓取该论文的"被引"（谁引用了它）：从 Semantic Scholar 查询（限流退避），失败自动回退 OpenAlex；命中库内论文建立被引边。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'papergraph_fetch_refs',
    description: '组合抓取（参考文献 + 被引）。等价于依次调用 papergraph_fetch_references 与 papergraph_fetch_citations。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'papergraph_auto_match_refs',
    description: '离线解析该论文 PDF 的参考文献段落，与库内论文标题模糊匹配建立引用边（无需网络）。',
    inputSchema: {
      type: 'object',
      properties: { paperId: { type: 'string' } },
      required: ['paperId'],
      additionalProperties: false,
    },
  },
  {
    name: 'papergraph_download_ref',
    description: '下载单条「未入库引用」（externalRefs 中的条目）：经 arXiv / OpenAlex 开放获取解析 PDF 地址，下载入库（默认无评分），并自动建立引用边。',
    inputSchema: {
      type: 'object',
      properties: {
        paperId: { type: 'string' },
        key: { type: 'string', description: 'externalRefs 条目的 key（见 papergraph_get_paper 返回的 externalRefs）' },
      },
      required: ['paperId', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'papergraph_download_all_refs',
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
    name: 'papergraph_list_libraries',
    description: '列出全部论文库及当前库（含每个库的论文数与引用边数）。多库共享统一论文存储，同一论文跨库复用同一 id。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'papergraph_create_library',
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
    name: 'papergraph_update_library',
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
    name: 'papergraph_reorder_libraries',
    description: '按给定 id 顺序重排论文库列表（拖拽排序持久化）。',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'papergraph_switch_library',
    description: '切换当前论文库。之后的论文列表、引用图谱、导入与抓取都作用于该库。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '论文库 id（见 papergraph_list_libraries）' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'papergraph_get_graph',
    description: '获取引用图谱快照：nodes（论文）与 edges（{from,to,source}，from 引用 to）。渲染约定：选中节点的引用方为橙色、被引方为蓝色、互引为紫色。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

/* ---------------- 工具执行 ---------------- */
async function runTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'papergraph_status':
      return callApi('GET', '/api/status');
    case 'papergraph_list_papers': {
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
    case 'papergraph_get_paper':
      return callApi('GET', '/api/papers/' + encodeURIComponent(a.id));
    case 'papergraph_update_paper': {
      const { id, ...patch } = a;
      return callApi('PATCH', '/api/papers/' + encodeURIComponent(id), patch);
    }
    case 'papergraph_delete_paper':
      return callApi('DELETE', '/api/papers/' + encodeURIComponent(a.id) + '?deleteFile=' + (a.deleteFile === false ? '0' : '1'));
    case 'papergraph_import_path':
      return callApi('POST', '/api/papers/import-path', { paths: a.paths || [], conflictPolicy: a.conflictPolicy || 'auto' });
    case 'papergraph_import_url':
      return callApi('POST', '/api/papers/import-url', { url: a.url, conflictPolicy: a.conflictPolicy || 'auto' });
    case 'papergraph_list_annotations':
      return callApi('GET', '/api/papers/' + encodeURIComponent(a.paperId) + '/annotations');
    case 'papergraph_add_annotation':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/annotations', a.annotation);
    case 'papergraph_set_annotations':
      return callApi('PUT', '/api/papers/' + encodeURIComponent(a.paperId) + '/annotations', a.annotations || []);
    case 'papergraph_list_links':
      return callApi('GET', '/api/links');
    case 'papergraph_add_link':
      return callApi('POST', '/api/links', { from: a.from, to: a.to });
    case 'papergraph_delete_link':
      return callApi('DELETE', '/api/links/' + encodeURIComponent(a.linkId));
    case 'papergraph_fetch_references':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/fetch-references');
    case 'papergraph_fetch_citations':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/fetch-citations');
    case 'papergraph_fetch_refs':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/fetch-refs');
    case 'papergraph_auto_match_refs':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/auto-match');
    case 'papergraph_download_ref':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/download-ref', { key: a.key });
    case 'papergraph_download_all_refs':
      return callApi('POST', '/api/papers/' + encodeURIComponent(a.paperId) + '/download-all-refs', { dir: a.dir || 'both' });
    case 'papergraph_list_libraries':
      return callApi('GET', '/api/libraries');
    case 'papergraph_create_library':
      return callApi('POST', '/api/libraries', { name: a.name, desc: a.desc, icon: a.icon, switch: a.switch });
    case 'papergraph_update_library': {
      const { id, ...patch } = a;
      return callApi('PATCH', '/api/libraries/' + encodeURIComponent(id), patch);
    }
    case 'papergraph_reorder_libraries':
      return callApi('POST', '/api/libraries/reorder', { ids: a.ids || [] });
    case 'papergraph_switch_library':
      return callApi('POST', '/api/libraries/current', { id: a.id });
    case 'papergraph_get_graph':
      return callApi('GET', '/api/graph');
    default:
      return { __error: '未知工具：' + name };
  }
}

/* ---------------- 资源（Resources） ---------------- */
const RESOURCE_LIST = [
  {
    uri: 'papergraph://papers',
    name: '论文库列表',
    description: '全部论文的 JSON 列表（id、标题、作者、年份、DOI、标签等）',
    mimeType: 'application/json',
  },
  {
    uri: 'papergraph://graph',
    name: '引用图谱快照',
    description: '引用网络 JSON：nodes（论文）+ edges（from 引用 to）',
    mimeType: 'application/json',
  },
];

const RESOURCE_TEMPLATE_LIST = [
  {
    uriTemplate: 'papergraph://papers/{id}',
    name: '论文详情',
    description: '单篇论文详情 JSON（含 Markdown 笔记）',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'papergraph://papers/{id}/notes',
    name: '论文笔记',
    description: '单篇论文的 Markdown 笔记纯文本',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'papergraph://papers/{id}/annotations',
    name: '论文批注',
    description: '单篇论文的高亮与便利贴 JSON',
    mimeType: 'application/json',
  },
];

async function readResource(uri) {
  const m = uri.match(/^papergraph:\/\/(papers|graph)(?:\/([^/]+)(?:\/(notes|annotations))?)?$/);
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
    const data = await callApi('GET', '/api/papers/' + id);
    if (data.__error) return data;
    return { mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  if (kind === 'papers' && id && sub === 'notes') {
    const data = await callApi('GET', '/api/papers/' + id);
    if (data.__error) return data;
    return { mimeType: 'text/markdown', text: data.notes || '（暂无笔记）' };
  }
  if (kind === 'papers' && id && sub === 'annotations') {
    const data = await callApi('GET', '/api/papers/' + id + '/annotations');
    if (data.__error) return data;
    return { mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  return { __error: '未知资源 URI：' + uri };
}

/* ---------------- 提示模板（Prompts） ---------------- */
const PROMPT_LIST = [
  {
    name: 'papergraph_read_paper',
    description: '精读一篇库内论文：拉取元数据、笔记与批注，产出结构化阅读报告并回写笔记。',
    arguments: [
      { name: 'paper', description: '论文 id 或标题关键词', required: true },
    ],
  },
  {
    name: 'papergraph_literature_review',
    description: '围绕一个主题在论文库中做小型文献综述：检索相关论文、分析引用网络、生成综述并回写。',
    arguments: [
      { name: 'topic', description: '综述主题', required: true },
    ],
  },
  {
    name: 'papergraph_import_and_link',
    description: '导入一篇新论文并接入引用网络：导入、补全元数据、建立引用边、报告它与库内论文的关系。',
    arguments: [
      { name: 'source', description: '本机 PDF 绝对路径或下载链接（支持 arXiv 页面）', required: true },
    ],
  },
];

function getPrompt(name, args) {
  const a = args || {};
  const wrap = (text) => ({ description: PROMPT_LIST.find(p => p.name === name).description, messages: [{ role: 'user', content: { type: 'text', text } }] });
  if (name === 'papergraph_read_paper') {
    return wrap(`请使用 papergraph 的 MCP 工具精读论文「${a.paper || ''}」并产出阅读报告。步骤：
1. 用 papergraph_list_papers（query 过滤）找到目标论文，若给出的是 id 可直接 papergraph_get_paper。
2. 读取 papergraph_list_annotations 查看已有高亮与便利贴；读取资源 papergraph://papers/{id}/notes 查看已有笔记。
3. 结合论文标题、摘要（abstract）、批注与笔记，产出结构化阅读报告：研究问题、核心方法、关键创新、实验结论、局限性、值得跟进的方向。
4. 用 papergraph_update_paper 把报告要点追加写入该论文的 notes（Markdown，保留原有内容）。
5. 最后用 papergraph_list_links 报告它的引用（它引用了谁）与被引（谁引用了它）情况。`);
  }
  if (name === 'papergraph_literature_review') {
    return wrap(`请使用 papergraph 的 MCP 工具围绕主题「${a.topic || ''}」做小型文献综述。步骤：
1. 用 papergraph_list_papers（query 多次换关键词）检索库内相关论文。
2. 对每篇相关论文用 papergraph_get_paper 读取摘要与笔记。
3. 用 papergraph_get_graph 分析这些论文之间的引用关系（谁引用谁、哪些是核心节点）。
4. 产出综述：主题脉络、各论文定位与贡献、方法对比、研究空白。
5. 把综述以 Markdown 写入主题最相关论文的 notes（papergraph_update_paper），并在回复中给出全文。`);
  }
  if (name === 'papergraph_import_and_link') {
    return wrap(`请使用 papergraph 的 MCP 工具导入论文「${a.source || ''}」并接入引用网络。步骤：
1. 判断来源类型：本机路径用 papergraph_import_path，URL 用 papergraph_import_url。
2. 导入后用 papergraph_get_paper 检查自动提取的元数据（标题/作者/年份/DOI），缺失时用 papergraph_update_paper 补全。
3. 用 papergraph_auto_match_refs 离线匹配库内参考文献建边；有网络时用 papergraph_fetch_refs 进一步抓取引用与被引。
4. 用 papergraph_get_graph 查看新的引用网络，报告：该论文引用了库内哪些论文、被库内哪些论文引用、与哪些论文互引。`);
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
      send({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: r.mimeType, text: r.text }] } });
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
console.error('[papergraph-mcp] started, connection search order: ' + candidatePaths().join(' | '));
