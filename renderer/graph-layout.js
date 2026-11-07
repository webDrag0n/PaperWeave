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
