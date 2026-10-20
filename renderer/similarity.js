// PaperWeave 库内相似度计算
// 复刻 Connected Papers 的核心思想（Co-citation × Bibliographic Coupling）：
// 两篇论文的参考文献（耦合，向后看）与被引名单（同被引，向前看）重叠越多，主题越相近，
// 即使它们之间没有直接引用关系。
// 数据源全部来自本地：externalRefs（未入库引用/被引条目，含 DOI/arXiv/标题标识）
// 与库内引用边 links。相似度 = 两类特征交集的余弦重叠度。

const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();

// 未入库条目的归一化标识键：优先 DOI，其次 arXiv，最后归一化标题
function extKey(e) {
  if (!e) return null;
  const doi = String(e.doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  const arxiv = String(e.arxivId || '').toLowerCase().replace(/^arxiv:/, '').trim();
  if (arxiv || /^(arxiv:|10\.48550)/.test(doi)) {
    const id = arxiv || doi.replace(/^arxiv:/, '').replace(/^10\.48550\/arxiv\./, '');
    if (id) return 'x:' + id;
  }
  if (doi) return 'd:' + doi;
  const t = normTitle(e.title);
  return t ? 't:' + t : null;
}

/**
 * 构建每篇论文的相似度特征档案。
 * resolveExt(ext) 可选：若未入库条目其实匹配库内论文，返回该论文 id，
 * 使「外部条目」与「库内节点」共用同一标识（p:<id>），重叠统计更准。
 */
export function buildSimProfiles(papers, links, resolveExt) {
  const prof = new Map();
  for (const p of papers) prof.set(p.id, { refs: new Set(), cites: new Set() });
  for (const l of links) {
    if (prof.has(l.from)) prof.get(l.from).refs.add('p:' + l.to);
    if (prof.has(l.to)) prof.get(l.to).cites.add('p:' + l.from);
  }
  for (const p of papers) {
    const pr = prof.get(p.id);
    if (!pr) continue;
    for (const e of (Array.isArray(p.externalRefs) ? p.externalRefs : [])) {
      let k = null;
      if (resolveExt) {
        const mid = resolveExt(e);
        if (mid) k = 'p:' + mid;
      }
      if (!k) k = extKey(e);
      if (!k) continue;
      (e.dir === 'in' ? pr.cites : pr.refs).add(k);
    }
  }
  return prof;
}

function interSize(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/* 余弦重叠：共同参考文献数 + 共同被引数 / 几何均值 */
export function simScore(pa, pb) {
  const inter = interSize(pa.refs, pb.refs) + interSize(pa.cites, pb.cites);
  const denom = Math.sqrt((pa.refs.size + pa.cites.size) * (pb.refs.size + pb.cites.size));
  return denom > 0 ? inter / denom : 0;
}

/**
 * 计算图内相似边：分数阈值 + 每节点 topK 限制，避免全连接糊成一团。
 * 返回 [{a, b, score}]，按分数降序。
 */
export function computeSimEdges(papers, links, { minScore = 0.08, topK = 3, resolveExt } = {}) {
  const prof = buildSimProfiles(papers, links, resolveExt);
  const ids = papers.map(p => p.id);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const s = simScore(prof.get(ids[i]), prof.get(ids[j]));
      if (s >= minScore) out.push({ a: ids[i], b: ids[j], score: s });
    }
  }
  out.sort((x, y) => y.score - x.score);
  const cnt = Object.create(null);
  return out.filter(e => {
    if ((cnt[e.a] || 0) >= topK && (cnt[e.b] || 0) >= topK) return false;
    cnt[e.a] = (cnt[e.a] || 0) + 1;
    cnt[e.b] = (cnt[e.b] || 0) + 1;
    return true;
  });
}

/* 详情栏「相似论文」：与指定论文最相似的前 n 篇（含分数） */
export function topSimilar(id, papers, links, n = 5, resolveExt) {
  const prof = buildSimProfiles(papers, links, resolveExt);
  const me = prof.get(id);
  if (!me) return [];
  return papers
    .filter(p => p.id !== id)
    .map(p => ({ paper: p, score: simScore(me, prof.get(p.id)) }))
    .filter(x => x.score >= 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/**
 * 库外发现（Connected Papers 的 Prior / Derivative Works 玩法）：
 * - 经典先驱：被库内 ≥2 篇论文共同引用、但尚未入库的参考文献条目
 * - 衍生新作：同时引用库内 ≥2 篇论文、但尚未入库的被引条目
 * resolveExt(ext) 返回库内论文 id 时视为「已在库」，不计入推荐。
 * 返回 { prior, derivative }，各自按共同引用数降序（同数按 citeCount），最多 30 条。
 */
export function aggregateExternal(papers, resolveExt) {
  const prior = new Map(), derivative = new Map();
  for (const p of papers) {
    const seen = new Set(); // 同一篇论文内同一条目只计一次
    for (const e of (Array.isArray(p.externalRefs) ? p.externalRefs : [])) {
      if (resolveExt && resolveExt(e)) continue;
      const k = extKey(e);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const map = e.dir === 'in' ? derivative : prior;
      if (!map.has(k)) map.set(k, { key: k, entry: e, count: 0, srcs: [] });
      const rec = map.get(k);
      rec.count++;
      rec.srcs.push({ pid: p.id, key: e.key }); // 记录来源论文与该论文内的条目 key，供下载入库定位
      // 保留引用量更高的元数据，展示与排序更稳
      if ((e.citeCount || 0) > (rec.entry.citeCount || 0)) rec.entry = e;
    }
  }
  const finalize = (m) => [...m.values()]
    .filter(r => r.count >= 2)
    .sort((a, b) => b.count - a.count || (b.entry.citeCount || 0) - (a.entry.citeCount || 0))
    .slice(0, 30);
  return { prior: finalize(prior), derivative: finalize(derivative) };
}
