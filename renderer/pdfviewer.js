// PaperWeave PDF 阅读器：pdf.js 渲染 + 文本层高亮 + 便利贴
import * as pdfjs from 'pdfjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

function uid() { return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

export class PdfViewer {
  /**
   * opts: { pagesEl, scrollEl, selPopup, notePopup, onChange(annotations), onPageCount(n) }
   */
  constructor(opts) {
    this.opts = opts;
    this.doc = null;
    this.paperId = null;
    this.annotations = [];
    this.scale = 1;
    this.baseScale = 1;
    this.stickyMode = false;
    this.hlColor = '#ffe74a';
    this.pages = []; // { num, wrap, canvas, hlLayer, textLayerEl, iconLayer, viewport1 }
    this._selHandler = this._onMouseUp.bind(this);
    this._renderToken = 0;
    this._boundPopup = null;
  }

  async open(paperId, bytes, annotations) {
    this.destroy();
    this.paperId = paperId;
    this.annotations = Array.isArray(annotations) ? annotations : [];
    this.doc = await pdfjs.getDocument({ data: bytes }).promise;
    this.opts.onPageCount && this.opts.onPageCount(this.doc.numPages);
    this.outline = null;
    this._textCache = new Map();
    try { this.outline = await this.doc.getOutline() || null; } catch (_) {}

    // 以第一页宽度适配容器
    const first = await this.doc.getPage(1);
    const v1 = first.getViewport({ scale: 1 });
    this.page1Width = v1.width;
    const avail = Math.max(420, this.opts.scrollEl.clientWidth - 60);
    this.baseScale = avail / v1.width;
    this.scale = this.baseScale;

    // 页面骨架
    for (let n = 1; n <= this.doc.numPages; n++) {
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.dataset.page = n;
      const canvas = document.createElement('canvas');
      const hlLayer = document.createElement('div');
      hlLayer.className = 'hlLayer';
      const textLayerEl = document.createElement('div');
      textLayerEl.className = 'textLayer';
      const iconLayer = document.createElement('div');
      iconLayer.className = 'iconLayer';
      iconLayer.style.cssText = 'position:absolute;inset:0;z-index:3;pointer-events:none;';
      const badge = document.createElement('div');
      badge.className = 'page-num-badge';
      badge.textContent = n + ' / ' + this.doc.numPages;
      wrap.append(canvas, hlLayer, textLayerEl, iconLayer, badge);
      wrap.addEventListener('click', (ev) => this._onPageClick(ev, n, wrap));
      this.opts.pagesEl.appendChild(wrap);
      this.pages.push({ num: n, wrap, canvas, hlLayer, textLayerEl, iconLayer, rendered: false });
    }
    document.addEventListener('mouseup', this._selHandler);
    await this.renderAll();
  }

  async renderAll() {
    const token = ++this._renderToken;
    // 先为每页测量尺寸（不渲染），占位避免滚动跳动
    for (const p of this.pages) {
      const page = await this.doc.getPage(p.num);
      const viewport = page.getViewport({ scale: this.scale });
      p.viewport = viewport;
      p.wrap.style.width = viewport.width + 'px';
      p.wrap.style.height = viewport.height + 'px';
      p.canvas.style.width = viewport.width + 'px';
      p.canvas.style.height = viewport.height + 'px';
      p.rendered = false;
    }
    // 懒渲染：接近视口的页面才渲染，长文档秒开
    if (this._observer) this._observer.disconnect();
    this._observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const p = this.pages.find(x => x.wrap === en.target);
        if (p && !p.rendered && !p.rendering) {
          p.rendering = true;
          this._renderPage(p).then(() => {
            if (token === this._renderToken) this._renderAnnotationsFor(p);
          });
        }
        this._observer.unobserve(en.target);
      }
    }, { root: this.opts.scrollEl, rootMargin: '600px 0px' });
    for (const p of this.pages) this._observer.observe(p.wrap);
    // 滚动兜底：某些环境下 IO 回调不及时，直接在滚动时检查
    this._scrollFallback = () => this._renderVisiblePages();
    this.opts.scrollEl.addEventListener('scroll', this._scrollFallback);
    // 首屏兜底：立即渲染第一页
    if (this.pages[0] && !this.pages[0].rendered) {
      await this._renderPage(this.pages[0]);
      this._observer.unobserve(this.pages[0].wrap);
    }
    this._renderVisiblePages();
  }

  _renderVisiblePages() {
    const rootRect = this.opts.scrollEl.getBoundingClientRect();
    const margin = 800;
    for (const p of this.pages) {
      if (p.rendered || p.rendering) continue;
      const r = p.wrap.getBoundingClientRect();
      if (r.bottom > rootRect.top - margin && r.top < rootRect.bottom + margin) {
        p.rendering = true;
        this._renderPage(p).then(() => this._renderAnnotationsFor(p));
      }
    }
  }

  _renderAnnotationsFor(p) {
    p.hlLayer.innerHTML = '';
    p.iconLayer.innerHTML = '';
    if (!p.viewport) return;
    const W = p.viewport.width, H = p.viewport.height;
    for (const a of this.annotations.filter(x => x.page === p.num)) {
      if (a.type === 'highlight' && Array.isArray(a.quads)) {
        // 渲染时同样做防重叠规范化，兼容升级前已保存的旧高亮
        for (const q of PdfViewer.normalizeQuads(a.quads)) {
          const box = document.createElement('div');
          box.className = 'hl-box';
          box.style.left = (q.x * W) + 'px';
          box.style.top = (q.y * H) + 'px';
          box.style.width = (q.w * W) + 'px';
          box.style.height = (q.h * H) + 'px';
          box.style.background = a.color || '#ffe74a';
          box.title = a.comment || a.text || '';
          box.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.opts.onAnnotClick && this.opts.onAnnotClick(a, ev);
          });
          p.hlLayer.appendChild(box);
        }
      } else if (a.type === 'sticky') {
        const icon = document.createElement('div');
        icon.className = 'sticky-icon';
        icon.style.left = (a.x * W) + 'px';
        icon.style.top = (a.y * H) + 'px';
        icon.style.pointerEvents = 'auto';
        icon.textContent = '📌';
        icon.title = a.comment || '便利贴';
        icon.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.openNotePopup(a, ev.clientX, ev.clientY);
        });
        p.iconLayer.appendChild(icon);
      }
    }
  }

  async _renderPage(p) {
    const page = await this.doc.getPage(p.num);
    const viewport = page.getViewport({ scale: this.scale });
    p.viewport = viewport;
    p.wrap.style.width = viewport.width + 'px';
    p.wrap.style.height = viewport.height + 'px';
    const dpr = window.devicePixelRatio || 1;
    p.canvas.width = Math.floor(viewport.width * dpr);
    p.canvas.height = Math.floor(viewport.height * dpr);
    p.canvas.style.width = viewport.width + 'px';
    p.canvas.style.height = viewport.height + 'px';
    const ctx = p.canvas.getContext('2d');
    await page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    // 文本层
    p.textLayerEl.innerHTML = '';
    p.textLayerEl.style.width = viewport.width + 'px';
    p.textLayerEl.style.height = viewport.height + 'px';
    // pdf.js 4.x 文本层依赖 --scale-factor 计算字号/坐标，缺失会导致文字层与画布错位、选区不重合
    p.textLayerEl.style.setProperty('--scale-factor', String(this.scale));
    p.textLayerEl.style.setProperty('--total-scale-factor', String(this.scale));
    const tl = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: p.textLayerEl,
      viewport,
    });
    await tl.render();
    p.rendered = true;
  }

  /* ---------------- 批注渲染 ---------------- */
  _renderAnnotations() {
    for (const p of this.pages) if (p.rendered) this._renderAnnotationsFor(p);
  }

  /* ---------------- 交互 ---------------- */
  setStickyMode(on) {
    this.stickyMode = on;
    for (const p of this.pages) p.wrap.classList.toggle('sticky-mode', on);
  }

  _onPageClick(ev, pageNum, wrap) {
    if (!this.stickyMode) return;
    const rect = wrap.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / rect.width;
    const y = (ev.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const ann = { id: uid(), type: 'sticky', page: pageNum, x, y, color: '#ff7a4a', comment: '', createdAt: Date.now() };
    this.annotations.push(ann);
    this._save();
    this._renderAnnotations();
    this.openNotePopup(ann, ev.clientX, ev.clientY);
    this.setStickyMode(false);
    this.opts.onStickyPlaced && this.opts.onStickyPlaced();
  }

  _onMouseUp() {
    const popup = this.opts.selPopup;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.doc) { popup.classList.add('hidden'); return; }
    const range = sel.getRangeAt(0);
    const pageWrap = this._findPageWrap(range.commonAncestorContainer);
    if (!pageWrap) { popup.classList.add('hidden'); return; }
    const text = sel.toString().trim();
    if (!text) { popup.classList.add('hidden'); return; }

    const textLayerEl = pageWrap.querySelector('.textLayer');
    const lr = textLayerEl.getBoundingClientRect();
    // 浏览器对逐 span 的选区会返回碎片矩形；按行合并成连续的整行 quad，高亮才能连贯且与文字重合
    const rawRects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
    const lineMap = new Map(); // top -> merged line rect
    for (const r of rawRects) {
      let key = null;
      for (const k of lineMap.keys()) {
        if (Math.abs(k - r.top) <= Math.max(2, r.height * 0.35)) { key = k; break; }
      }
      if (key === null) {
        key = r.top;
        lineMap.set(key, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      } else {
        const L = lineMap.get(key);
        L.left = Math.min(L.left, r.left);
        L.top = Math.min(L.top, r.top);
        L.right = Math.max(L.right, r.right);
        L.bottom = Math.max(L.bottom, r.bottom);
      }
    }
    const rects = PdfViewer.normalizeQuads([...lineMap.values()]
      .sort((a, b) => (a.top - b.top) || (a.left - b.left))
      .map(r => ({
        x: Math.max(0, (r.left - lr.left) / lr.width),
        y: Math.max(0, (r.top - lr.top) / lr.height),
        w: Math.min(1, (r.right - lr.left) / lr.width) - Math.max(0, (r.left - lr.left) / lr.width),
        h: Math.min(1, (r.bottom - lr.top) / lr.height) - Math.max(0, (r.top - lr.top) / lr.height),
      }))
      .filter(q => q.w > 0 && q.h > 0));
    if (!rects.length) { popup.classList.add('hidden'); return; }

    const pageNum = parseInt(pageWrap.dataset.page, 10);
    const first = rects[0];
    popup.classList.remove('hidden');
    const pr = pageWrap.getBoundingClientRect();
    const pw = popup.offsetWidth;
    popup.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, pr.left + (first.x + first.w / 2) * pr.width - pw / 2)) + 'px';
    popup.style.top = Math.max(8, pr.top + first.y * pr.height - popup.offsetHeight - 8) + 'px';

    // 绑定本次选择
    this._boundPopup = { text, pageNum, quads: rects };
  }

  _findPageWrap(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      if (el.classList && el.classList.contains('pdf-page')) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 把同一批高亮 quad 规范化为互不重叠的区域：
   * 行与行之间若因像素取整/字号差异出现交叠，会把上一行的底边压到下一行顶边，
   * 避免多行高亮在行交界处叠出双倍颜色浓度，保证整段高亮颜色均匀。
   */
  static normalizeQuads(quads) {
    const qs = quads
      .map(q => ({
        x: Math.min(Math.max(0, q.x), 1),
        y: Math.min(Math.max(0, q.y), 1),
        w: Math.min(Math.max(0, q.w), 1),
        h: Math.min(Math.max(0, q.h), 1),
      }))
      .filter(q => q.w > 0.001 && q.h > 0.001)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (let i = 1; i < qs.length; i++) {
      const prev = qs[i - 1], cur = qs[i];
      const prevBottom = prev.y + prev.h;
      // 垂直方向有交叠（同一行或相邻行重叠）时收敛边界
      if (cur.y < prevBottom) {
        // 水平不重叠的同行 quad 不影响垂直切分
        if (cur.x >= prev.x + prev.w || prev.x >= cur.x + cur.w) continue;
        const overlap = prevBottom - cur.y;
        cur.y = prevBottom;
        cur.h -= overlap;
        if (cur.h <= 0.001) { qs.splice(i, 1); i--; }
      }
    }
    return qs;
  }

  // 供 app.js 的弹条按钮调用
  createHighlightFromSelection(color, withComment) {
    const b = this._boundPopup;
    if (!b) return null;
    const ann = {
      id: uid(), type: 'highlight', page: b.pageNum, quads: PdfViewer.normalizeQuads(b.quads),
      color: color || this.hlColor, text: b.text, comment: '', createdAt: Date.now(),
    };
    this.annotations.push(ann);
    this._save();
    this._renderAnnotations();
    window.getSelection().removeAllRanges();
    this.opts.selPopup.classList.add('hidden');
    if (withComment) {
      // 在页面高亮位置附近弹出批注框
      const wrap = this.pages[b.pageNum - 1].wrap;
      const r = wrap.getBoundingClientRect();
      this.openNotePopup(ann, r.left + b.quads[0].x * r.width, r.top + b.quads[0].y * r.height + 20);
    }
    return ann;
  }

  openNotePopup(ann, clientX, clientY) {
    const popup = this.opts.notePopup;
    const textarea = popup.querySelector('textarea');
    popup.classList.remove('hidden');
    textarea.value = ann.comment || '';
    const w = 300;
    popup.style.left = Math.max(8, Math.min(window.innerWidth - w - 16, clientX - w / 2)) + 'px';
    popup.style.top = Math.max(8, Math.min(window.innerHeight - 220, clientY + 10)) + 'px';
    this._noteEditing = ann;
    setTimeout(() => textarea.focus(), 30);
  }

  closeNotePopup(save) {
    const popup = this.opts.notePopup;
    const ann = this._noteEditing;
    if (ann && save) {
      ann.comment = popup.querySelector('textarea').value.trim();
      this._save();
      this._renderAnnotations();
    }
    popup.classList.add('hidden');
    this._noteEditing = null;
  }

  deleteNoteEditing() {
    const ann = this._noteEditing;
    if (ann) this.removeAnnotation(ann.id);
    this.opts.notePopup.classList.add('hidden');
    this._noteEditing = null;
  }

  removeAnnotation(id) {
    const i = this.annotations.findIndex(a => a.id === id);
    if (i >= 0) {
      this.annotations.splice(i, 1);
      this._save();
      this._renderAnnotations();
    }
  }

  updateAnnotation(id, patch) {
    const a = this.annotations.find(x => x.id === id);
    if (a) { Object.assign(a, patch); this._save(); this._renderAnnotations(); }
  }

  scrollToAnnotation(a) {
    const p = this.pages[a.page - 1];
    if (!p) return;
    p.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // 闪烁提示
    setTimeout(() => {
      const boxes = p.hlLayer.querySelectorAll('.hl-box');
      for (const b of boxes) {
        if (b.title === (a.comment || a.text || '')) {
          b.style.outline = '2px solid #fff';
          setTimeout(() => { b.style.outline = ''; }, 900);
        }
      }
    }, 450);
  }

  /* ---------------- 阅读辅助：跳页 / 目录 / 全文搜索 ---------------- */

  /** 跳转到指定页（页码从 1 开始），未渲染的页面先补渲染 */
  async jumpToPage(n, behavior = 'smooth') {
    const p = this.pages[n - 1];
    if (!p) return false;
    if (!p.rendered && !p.rendering) {
      p.rendering = true;
      await this._renderPage(p);
      this._renderAnnotationsFor(p);
    }
    p.wrap.scrollIntoView({ behavior, block: 'start' });
    return true;
  }

  /**
   * 目录条目精确跳转：解析大纲 dest（XYZ/FitH 的 y 坐标），
   * 没有坐标时在页面文本中定位标题行，把子段落标题滚动到视口顶部附近。
   */
  async jumpToOutline(item) {
    const t = await this.resolveOutlineTarget(item);
    if (!t) return false;
    await this.jumpToPage(t.page, 'auto');
    const p = this.pages[t.page - 1];
    if (!p) return true;
    const scrollEl = this.opts.scrollEl;
    const rect = p.wrap.getBoundingClientRect();
    const rootRect = scrollEl.getBoundingClientRect();
    const yPx = t.yRatio != null ? t.yRatio * p.viewport.height : 0;
    const top = scrollEl.scrollTop + (rect.top - rootRect.top) + yPx - scrollEl.clientHeight * 0.12;
    scrollEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    return true;
  }

  /** 当前可视区域中心的页码（用于进度显示与页码框联动） */
  visiblePageNum() {
    const rootRect = this.opts.scrollEl.getBoundingClientRect();
    const mid = rootRect.top + rootRect.height / 2;
    let best = 1, bestDist = Infinity;
    for (const p of this.pages) {
      const r = p.wrap.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestDist) { bestDist = d; best = p.num; }
    }
    return best;
  }

  /** 提取某页纯文本（带缓存），供全文搜索使用 */
  async getPageText(n) {
    if (this._textCache.has(n)) return this._textCache.get(n);
    let text = '';
    try {
      const page = await this.doc.getPage(n);
      const tc = await page.getTextContent();
      text = tc.items.map(it => it.str || '').join(' ');
    } catch (_) {}
    this._textCache.set(n, text);
    return text;
  }

  /**
   * 全文搜索：返回 [{ page, start, snippet }]；同时记录供 flashMatches 使用。
   * 结果按页码排序，snippet 为匹配处前后约 40 字符的上下文。
   */
  async searchText(query) {
    const q = (query || '').trim().toLowerCase();
    this._lastSearch = q;
    this._searchHits = new Map(); // page -> [{start, end}]
    const results = [];
    if (!q || !this.doc) return results;
    for (let n = 1; n <= this.doc.numPages; n++) {
      const text = (await this.getPageText(n)).toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(q, idx)) >= 0) {
        if (!this._searchHits.has(n)) this._searchHits.set(n, []);
        this._searchHits.get(n).push({ start: idx, end: idx + q.length });
        results.push({
          page: n, start: idx,
          snippet: text.slice(Math.max(0, idx - 40), idx + q.length + 40).replace(/\s+/g, ' '),
          prefixCut: idx >= 40,
          suffixCut: idx + q.length + 40 < text.length,
        });
        idx += q.length;
        if (results.length >= 500) return results; // 上限，防超大文档卡顿
      }
    }
    return results;
  }

  /**
   * 在某页上把当前搜索词的命中位置画成临时高亮框（青色，1.6s 后自动消失），
   * 并滚动到第一个命中处。位置由 textContent 的 transform 直接推算，与文本层无关。
   */
  async flashMatches(pageNum) {
    const hits = this._searchHits && this._searchHits.get(pageNum);
    const p = this.pages[pageNum - 1];
    if (!p) return false;
    if (!hits || !hits.length) { this.jumpToPage(pageNum); return true; }
    if (!p.rendered && !p.rendering) {
      p.rendering = true;
      await this._renderPage(p);
      this._renderAnnotationsFor(p);
    }
    // 计算命中所在的 textContent 项及其行矩形
    const page = await this.doc.getPage(pageNum);
    const tc = await page.getTextContent();
    const full = tc.items.map(it => it.str || '').join(' ');
    const offsetOf = [];
    let acc = 0;
    for (const it of tc.items) { offsetOf.push(acc); acc += (it.str || '').length + 1; }
    const vp = p.viewport;
    const Util = pdfjs.Util;
    let firstTop = null;
    for (const hit of hits) {
      // 找到覆盖命中区间的项
      for (let i = 0; i < tc.items.length; i++) {
        const s = offsetOf[i], e = s + (tc.items[i].str || '').length;
        if (e < hit.start || s > hit.end) continue;
        const it = tc.items[i];
        const t = Util.transform(vp.transform, it.transform);
        const lineH = Math.max(6, (it.height || 10) * vp.scale);
        const box = document.createElement('div');
        box.className = 'hl-box search-hit';
        box.style.left = (t[4] - 1) + 'px';
        box.style.top = (t[5] - lineH * 0.8) + 'px';
        box.style.width = ((it.width || 5) * vp.scale + 2) + 'px';
        box.style.height = lineH + 'px';
        p.hlLayer.appendChild(box);
        if (firstTop === null) firstTop = t[5] - lineH * 0.8;
      }
    }
    if (firstTop !== null) {
      const target = this.opts.scrollEl.scrollTop + p.wrap.getBoundingClientRect().top + firstTop - this.opts.scrollEl.getBoundingClientRect().top - 120;
      this.opts.scrollEl.scrollTo({ top: target, behavior: 'smooth' });
    }
    setTimeout(() => {
      p.hlLayer.querySelectorAll('.search-hit').forEach(b => b.remove());
    }, 1600);
    return true;
  }

  /**
   * 解析大纲目标：返回 { page, yRatio }。
   * yRatio 为标题在页面中的纵向位置（0=页顶，1=页底，相对当前缩放后的页面高度）；
   * 优先取 dest 坐标（XYZ / FitH），缺失时在页面文本中匹配标题行兜底。
   */
  async resolveOutlineTarget(item) {
    try {
      let dest = item.dest;
      if (typeof dest === 'string') dest = await this.doc.getDestination(dest);
      if (!dest) return null;
      const idx = await this.doc.getPageIndex(dest[0]);
      const pageNum = idx + 1;
      const page = await this.doc.getPage(pageNum);
      const vp1 = page.getViewport({ scale: 1 });
      const mode = dest[1] && dest[1].name;
      let yRatio = null;
      // XYZ: [ref, XYZ, x, y, zoom]；FitH/FitBH: [ref, FitH, y]（PDF 坐标系 y 轴向上）
      const py = mode === 'XYZ' ? dest[3] : (mode === 'FitH' || mode === 'FitBH') ? dest[2] : null;
      if (typeof py === 'number' && py !== null && vp1.height > 0) {
        yRatio = Math.min(1, Math.max(0, 1 - py / vp1.height));
      }
      if (yRatio === null && item.title) {
        // 兜底：在页面文本项中定位标题行，取其实际 y 位置
        const needle = String(item.title).replace(/\s+/g, ' ').trim().toLowerCase();
        if (needle) {
          const tc = await page.getTextContent();
          let acc = '';
          for (const it of tc.items) {
            acc += (it.str || '');
            const norm = acc.replace(/\s+/g, ' ').trim().toLowerCase();
            if (norm.includes(needle.slice(0, 24)) && it.transform) {
              yRatio = Math.min(1, Math.max(0, 1 - it.transform[5] / vp1.height));
              break;
            }
            if (it.hasEOL) acc = '';
          }
        }
      }
      return { page: pageNum, yRatio };
    } catch (_) { return null; }
  }

  async zoom(factor) {
    this.scale = Math.max(0.4, Math.min(4, this.scale * factor));
    await this.renderAll();
    return this.scale / this.baseScale;
  }
  /** 适应宽度：按当前容器宽度重算基准缩放（侧栏收起/展开后同样适用） */
  async fitWidth() {
    if (this.page1Width) {
      const avail = Math.max(420, this.opts.scrollEl.clientWidth - 60);
      this.baseScale = avail / this.page1Width;
    }
    this.scale = this.baseScale;
    await this.renderAll();
    return this.zoomRatio();
  }
  zoomRatio() { return this.scale / this.baseScale; }

  _save() {
    this.opts.onChange && this.opts.onChange(this.annotations);
  }

  destroy() {
    document.removeEventListener('mouseup', this._selHandler);
    if (this._scrollFallback) this.opts.scrollEl.removeEventListener('scroll', this._scrollFallback);
    if (this._observer) this._observer.disconnect();
    this.opts.selPopup.classList.add('hidden');
    this.opts.notePopup.classList.add('hidden');
    this.opts.pagesEl.innerHTML = '';
    this.pages = [];
    if (this.doc) { try { this.doc.destroy(); } catch (_) {} this.doc = null; }
    this.annotations = [];
    this._boundPopup = null;
  }
}
