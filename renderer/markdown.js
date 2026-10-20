// 极简 Markdown 渲染器（笔记预览用）
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

// 行内 Markdown → HTML（标题等纯文本场景，不含链接/块级元素）
export function inlineMd(s) {
  let t = escapeHtml(String(s ?? ''));
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return t;
}

// 行内 Markdown → 分段（供 Canvas 绘制：逐段切换字体样式）
export function parseInlineMd(text) {
  const segs = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/g;
  let last = 0, m;
  const src = String(text ?? '');
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) segs.push({ text: src.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**')) segs.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith('~~')) segs.push({ text: tok.slice(2, -2), strike: true });
    else if (tok.startsWith('`')) segs.push({ text: tok.slice(1, -1), code: true });
    else segs.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < src.length) segs.push({ text: src.slice(last) });
  return segs.filter(s => s.text.length > 0);
}

export function renderMarkdown(src) {
  const lines = (src || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++; }
      out.push('<ul>' + buf.join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { buf.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; }
      out.push('<ol>' + buf.join('') + '</ol>');
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    // 段落：吃到空行为止
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push('<p>' + inline(buf.join(' ')) + '</p>');
  }
  return out.join('\n');
}
