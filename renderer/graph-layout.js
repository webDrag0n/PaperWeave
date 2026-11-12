// 引用图谱时间线布局：不依赖 Three.js，便于在 Node 与渲染进程中复用。
const DEFAULTS = { columnGap: 72, rowGap: 18 };

function publicationYear(value) {
  const match = String(value ?? '').trim().match(/^(?:19|20)\d{2}$/);
  return match ? Number(match[0]) : null;
}

/**
 * 按发表年份生成横向时间线坐标。
 * 同年节点保持输入顺序并纵向居中；未知年份始终位于最右侧。
 */
export function computeTimelineLayout(papers, options = {}) {
  const columnGap = Number.isFinite(options.columnGap) && options.columnGap > 0 ? options.columnGap : DEFAULTS.columnGap;
  const rowGap = Number.isFinite(options.rowGap) && options.rowGap > 0 ? options.rowGap : DEFAULTS.rowGap;
  const unknownLabel = options.unknownLabel || '未知';
  const groups = new Map();

  for (const paper of papers) {
    const year = publicationYear(paper.year);
    const key = year === null ? 'unknown' : String(year);
    if (!groups.has(key)) groups.set(key, { key, year, papers: [] });
    groups.get(key).papers.push(paper);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.year === null) return 1;
    if (b.year === null) return -1;
    return a.year - b.year;
  });
  const positions = new Map();
  const columns = ordered.map((group, index) => {
    const x = (index - (ordered.length - 1) / 2) * columnGap;
    group.papers.forEach((paper, row) => {
      positions.set(paper.id, {
        x,
        y: ((group.papers.length - 1) / 2 - row) * rowGap,
        z: 0,
      });
    });
    return {
      key: group.key,
      year: group.year,
      label: group.year === null ? unknownLabel : String(group.year),
      x,
    };
  });

  const maxRows = Math.max(0, ...ordered.map(group => group.papers.length));
  const maxY = maxRows > 1 ? (maxRows - 1) * rowGap / 2 : 0;
  return { positions, columns, yearLabelY: maxY + 14, minY: maxY === 0 ? 0 : -maxY, maxY };
}


/**
 * 收集论文的完整上下游谱系。
 * from → to 表示“from 引用 to”；参考文献方向为上游，被引方向为下游。
 */
export function collectLineageIds(links, selectedId) {
  const references = new Map();
  const citations = new Map();
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const link of links) {
    add(references, link.from, link.to);
    add(citations, link.to, link.from);
  }
  const walk = (start, adjacency) => {
    const visited = new Set();
    const queue = [start];
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (next === start || visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    return visited;
  };
  const upstream = walk(selectedId, references);
  const downstream = walk(selectedId, citations);
  return { upstream, downstream, ids: new Set([selectedId, ...upstream, ...downstream]) };
}

/**
 * 多选时收集选中论文两两之间的全部关联路径（时间线视图用）。
 * from → to 表示“from 引用 to”。对每一对 (a, b)：
 *   - 存在引用链（a 经若干次引用到达 b，或反向）时，取两个方向上的全部引用链。
 *     边 u→v 位于某条 s ⇝ t 链上 ⇔ u 可由 s 到达（含 s）且 v 可到达 t（含 t）；
 *   - 两个方向都没有引用链（例如二者只是共同引用了同一篇论文）时，退回全部最短无向路径。
 * 返回 { nodes: Set<id>, edges: Set<links 下标>, pairs: [{ a, b, kind: 'chain' | 'shortest' | 'none' }] }。
 */
export function collectPathsBetween(links, selectedIds) {
  const ids = [...new Set(selectedIds || [])];
  const nodes = new Set();
  const edges = new Set();
  const pairs = [];
  if (ids.length < 2) return { nodes, edges, pairs };

  const out = new Map();   // id → [被它引用的 id]
  const inc = new Map();   // id → [引用它的 id]
  const both = new Map();  // 无向邻接
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  links.forEach((link) => {
    if (link.from === link.to) return;
    add(out, link.from, link.to);
    add(inc, link.to, link.from);
    add(both, link.from, link.to);
    add(both, link.to, link.from);
  });
  // 广度优先：返回 起点 → 各节点 的距离（含起点，距离 0）
  const distances = (start, adjacency) => {
    const dist = new Map([[start, 0]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      for (const next of adjacency.get(current) || []) {
        if (dist.has(next)) continue;
        dist.set(next, dist.get(current) + 1);
        queue.push(next);
      }
    }
    return dist;
  };
  const reachCache = new Map();
  const reach = (kind, id) => {
    const key = kind + ':' + id;
    if (!reachCache.has(key)) reachCache.set(key, distances(id, kind === 'out' ? out : kind === 'in' ? inc : both));
    return reachCache.get(key);
  };
  const take = (index) => {
    edges.add(index);
    nodes.add(links[index].from);
    nodes.add(links[index].to);
  };
  // s 沿引用方向到达 t 的全部链
  const chains = (s, t) => {
    const fromS = reach('out', s);
    const toT = reach('in', t);
    if (!fromS.has(t)) return 0;
    let count = 0;
    links.forEach((link, index) => {
      if (link.from !== link.to && fromS.has(link.from) && toT.has(link.to)) { take(index); count++; }
    });
    return count;
  };

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const chained = chains(a, b) + chains(b, a);
      if (chained) { pairs.push({ a, b, kind: 'chain' }); continue; }
      const fromA = reach('both', a);
      const fromB = reach('both', b);
      if (!fromA.has(b)) { pairs.push({ a, b, kind: 'none' }); continue; }
      const total = fromA.get(b);
      links.forEach((link, index) => {
        if (link.from === link.to) return;
        const onShortest = (u, v) => fromA.has(u) && fromB.has(v) && fromA.get(u) + 1 + fromB.get(v) === total;
        if (onShortest(link.from, link.to) || onShortest(link.to, link.from)) take(index);
      });
      pairs.push({ a, b, kind: 'shortest' });
    }
  }
  return { nodes, edges, pairs };
}
