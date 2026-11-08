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
