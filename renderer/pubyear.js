// PaperWeave 发表年份推断（纯函数，无依赖）。主进程 main/pubyear.js 的网页版镜像，两份函数体必须保持一致
// 设计原则：宁缺毋错——正文里出现的四位数字（1945、2048 context length……）不是发表年份
const MIN_YEAR = 1900;

function currentYear(now) {
  return new Date(now === undefined || now === null ? Date.now() : now).getFullYear();
}

function validYear(y, now) {
  const n = Number(y);
  return Number.isInteger(n) && n >= MIN_YEAR && n <= currentYear(now) + 1;
}

// 文本里的“年份样”数字：排除 arXiv 编号（1907.01470）、页码区间之外的长数字等
function yearTokens(text) {
  const s = String(text || '');
  const out = [];
  const re = /(?:19|20)\d{2}/g;
  let m;
  while ((m = re.exec(s))) {
    const before = s[m.index - 1] || '';
    const after = s[m.index + 4] || '';
    const after2 = s[m.index + 5] || '';
    if (/[\d.:/]/.test(before)) continue;
    if (/\d/.test(after)) continue;
    if (after === '.' && /\d/.test(after2)) continue;
    out.push(m[0]);
  }
  return out;
}

// DOI / 链接 / "arXiv:xxxx" → arXiv 编号（不带版本号）；不是 arXiv 则返回 ''
function arxivIdOf(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const id = '(\\d{4}\\.\\d{4,5}|[a-z-]+(?:\\.[a-z]{2})?\\/\\d{7})';
  const m = s.match(new RegExp('^arxiv:\\s*' + id + '(?:v\\d+)?$', 'i'))
    || s.match(new RegExp('10\\.48550\\/arxiv\\.' + id, 'i'))
    || s.match(new RegExp('arxiv\\.org\\/(?:abs|pdf)\\/' + id, 'i'));
  return m ? m[1] : '';
}

// arXiv 编号 → 首次提交年份。新式 YYMM.NNNNN（2007-04 起），旧式 archive/YYMMNNN（1991–2007）
function arxivIdYear(id, now) {
  const s = String(id || '').trim().replace(/v\d+$/i, '');
  let m = s.match(/^(\d{2})(\d{2})\.\d{4,5}$/);
  if (m) {
    const y = 2000 + Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12 || y < 2007 || y > currentYear(now) + 1) return '';
    return String(y);
  }
  m = s.match(/^[a-z-]+(?:\.[a-z]{2})?\/(\d{2})(\d{2})\d{3}$/i);
  if (m) {
    const yy = Number(m[1]);
    const month = Number(m[2]);
    const y = yy >= 91 ? 1900 + yy : 2000 + yy;
    if (month < 1 || month > 12 || y < 1991 || y > 2007) return '';
    return String(y);
  }
  return '';
}

// 首页侧边的 arXiv 盖章：arXiv:2407.14207v1 [cs.LG] 19 Jul 2024（旧式没有方括号分类）
function arxivStampId(text) {
  const s = String(text || '');
  const m = s.match(/arXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?\s*(?:\[[A-Za-z-]+(?:\.[A-Za-z-]+)?\]|\s\d{1,2}\s+[A-Z][a-z]{2}\s+(?:19|20)\d{2})/);
  return m ? m[1] : '';
}

// 首页明确的出版标记：版权行、会议 / 期刊行、收稿日期。只认带关键词的行，不取正文里的任意数字
const DATE_RE = '(?:\\d{1,2}\\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+(?:\\d{1,2},?\\s+)?(?:19|20)\\d{2}|(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.]\\d{1,2}[/.](?:19|20)\\d{2}';
const MARKER_RULES = [
  /^\s*year\s*[:\uff1a]?\s+(.{0,6})/i,
  /(?:\u00a9|\(c\)|copyright)\s*(?:\u00a9|\(c\))?\s*(?:by\s+)?(.{0,6})/i,
  /published as an?\s+(?:[a-z]+\s+)?paper\s+(?:at|in)\b(.*)/i,
  /\b(?:proceedings of|conference on|workshop on|symposium on|journal of|transactions on|advances in neural information processing systems)\b(.*)/i,
  // 收稿 / 录用 / 发表日期：关键词后必须紧跟一个完整日期，避免把正文里的 “accepted since 1990” 当成标记
  new RegExp('\\b(?:received|accepted|published(?: online)?|submitted)\\b(?:\\s+on)?[:\\s]+(' + DATE_RE + ')', 'i'),
];
const DATED_RULE = MARKER_RULES[MARKER_RULES.length - 1];
function markerYear(lines, now) {
  const list = (lines || []).map(l => String(l || '')).filter(l => l.length <= 240);
  for (const re of MARKER_RULES) {
    for (const line of list) {
      const m = line.match(re);
      if (!m) continue;
      // 日期规则的捕获组本身就是一个完整日期；其余规则在关键词之后找第一个年份样数字
      const found = re === DATED_RULE ? (m[1].match(/(?:19|20)\d{2}/g) || []) : yearTokens(m[1]);
      const y = found.find(t => validYear(t, now));
      if (y) return y;
    }
  }
  return '';
}

// 参考文献里最新的年份（发表年份的下界）。取第二大值，避免单个离群数字（页码、编号）干扰
function latestReferenceYear(refText, now) {
  const years = yearTokens(refText).filter(t => validYear(t, now)).map(Number).sort((a, b) => b - a);
  if (!years.length) return '';
  return String(years.length >= 2 ? years[1] : years[0]);
}

// PDF 元数据 CreationDate（D:YYYYMMDD…）→ 年份
function creationDateYear(value, now) {
  const m = String(value || '').match(/^(?:D:)?\s*(\d{4})/);
  return m && validYear(m[1], now) && Number(m[1]) >= 1990 ? m[1] : '';
}

/**
 * 推断发表年份，按可靠程度依次尝试，全部落空时返回 ''（留空，由联网元数据补全）：
 *   1. arXiv 编号的年份（首页盖章，或论文自身的 arXiv DOI）——首次提交时间，不受后续版本影响
 *   2. 首页明确标记（版权 / 会议 / 期刊 / 收稿日期行）
 *   3. PDF 创建日期，且必须与参考文献的最新年份相容（排除多年后扫描或重新生成的文件）
 * input: { firstPageLines, ownDoi, creationDate, refText, now }
 */
function inferPublicationYear(input) {
  const o = input || {};
  const lines = Array.isArray(o.firstPageLines) ? o.firstPageLines : [];
  const byStamp = arxivIdYear(arxivStampId(lines.join('\n')), o.now);
  if (byStamp) return byStamp;
  const byDoi = arxivIdYear(arxivIdOf(o.ownDoi), o.now);
  if (byDoi) return byDoi;
  const byMarker = markerYear(lines, o.now);
  if (byMarker) return byMarker;
  const created = creationDateYear(o.creationDate, o.now);
  if (!created) return '';
  const latestRef = latestReferenceYear(o.refText, o.now);
  if (latestRef && (Number(created) < Number(latestRef) - 1 || Number(created) > Number(latestRef) + 3)) return '';
  return created;
}

/**
 * 校正已保存的年份：arXiv 论文的年份应落在 [编号年份, 编号年份 + 3]（正式发表通常略晚于预印本），
 * 否则以编号年份为准；非 arXiv 论文只清除明显不可能的未来年份。
 */
function reconcileYear(year, doi, now) {
  const y = String(year === undefined || year === null ? '' : year).trim();
  const n = /^\d{4}$/.test(y) ? Number(y) : NaN;
  const idYear = arxivIdYear(arxivIdOf(doi), now);
  if (idYear) {
    if (!Number.isFinite(n) || n < Number(idYear) || n > Number(idYear) + 3) return idYear;
    return y;
  }
  if (Number.isFinite(n) && n > currentYear(now) + 1) return '';
  return y;
}
export { arxivIdOf, arxivIdYear, arxivStampId, markerYear, latestReferenceYear, creationDateYear, inferPublicationYear, reconcileYear };
