// 正文引用悬浮卡片：只负责展示与交互，数据和下载由 app.js 注入。
import { t } from './i18n.js';

export class CitationPopup {
  constructor({ root, onOpenPaper, onDownload }) {
    this.root = root;
    this.onOpenPaper = onOpenPaper || (() => {});
    this.onDownload = onDownload || (async () => null);
    this.entries = [];
    this.hovered = false;
    this._showTimer = null;
    this._hideTimer = null;
    this.cards = document.createElement('div');
    this.cards.className = 'citation-cards';
    this.root.classList.add('citation-popup', 'hidden');
    this.root.replaceChildren(this.cards);
    this.root.addEventListener('pointerenter', () => {
      this.hovered = true;
      clearTimeout(this._hideTimer);
    });
    this.root.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.scheduleHide();
    });
    this._keyHandler = (ev) => { if (ev.key === 'Escape') this.hide(); };
    document.addEventListener('keydown', this._keyHandler);
  }

  setDownloadHandler(fn) { this.onDownload = fn; }

  scheduleShow(entries, point) {
    clearTimeout(this._showTimer);
    clearTimeout(this._hideTimer);
    this._showTimer = setTimeout(() => this.show(entries, point), 250);
  }

  show(entries, point) {
    clearTimeout(this._showTimer);
    clearTimeout(this._hideTimer);
    this.entries = (entries || []).filter(Boolean);
    if (!this.entries.length) return;
    this.render();
    this.root.classList.remove('hidden');
    this.position(point || { clientX: 0, clientY: 0 });
  }

  position(point) {
    const margin = 10;
    const width = this.root.offsetWidth || 360;
    const height = this.root.offsetHeight || 200;
    let left = point.clientX + 16;
    if (left + width > window.innerWidth - margin) left = point.clientX - width - 16;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
    const top = Math.max(margin, Math.min(window.innerHeight - height - margin, point.clientY + 16));
    this.root.style.left = left + 'px';
    this.root.style.top = top + 'px';
  }

  scheduleHide() {
    clearTimeout(this._showTimer);
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => { if (!this.hovered) this.hide(); }, 180);
  }

  hide() {
    clearTimeout(this._showTimer);
    clearTimeout(this._hideTimer);
    this.root.classList.add('hidden');
  }

  render() {
    this.cards.replaceChildren(...this.entries.map(entry => this.renderCard(entry)));
  }

  renderCard(entry) {
    const card = document.createElement('article');
    card.className = `citation-card ${entry.kind}`;
    card.dataset.entryId = entry.id;
    const status = document.createElement('span');
    status.className = 'citation-status';
    status.textContent = entry.kind === 'library' ? t('已在库中') : (entry.kind === 'external' ? t('未入库') : t('尚未识别'));
    const title = document.createElement('div');
    title.className = 'citation-title';
    title.textContent = entry.title || (entry.paper && entry.paper.title) || t('（未知标题）');
    const source = entry.paper || entry.external || {};
    const authors = document.createElement('div');
    authors.className = 'citation-meta';
    const authorText = (source.authors || []).slice(0, 3).join(', ');
    const bits = [authorText + ((source.authors || []).length > 3 ? ' …' : ''), source.year, source.venue].filter(Boolean);
    authors.textContent = bits.join(' · ');
    card.append(status, title, authors);
    const doiText = source.doi || (source.arxivId ? 'arXiv:' + source.arxivId : '');
    if (doiText) {
      const doi = document.createElement('div');
      doi.className = 'citation-doi';
      doi.textContent = doiText;
      card.appendChild(doi);
    }
    if (entry.kind === 'library') this.appendLibraryActions(card, entry);
    else if (entry.kind === 'external') this.appendDownloadAction(card, entry);
    else {
      const raw = document.createElement('div');
      raw.className = 'citation-raw';
      raw.textContent = entry.raw || '';
      const note = document.createElement('div');
      note.className = 'citation-note';
      note.textContent = t('尚未识别，暂不可下载');
      card.append(raw, note);
    }
    return card;
  }

  appendLibraryActions(card, entry) {
    const actions = document.createElement('div');
    actions.className = 'citation-actions';
    const open = document.createElement('button');
    open.className = 'btn small citation-open';
    open.textContent = t('打开论文');
    open.addEventListener('click', () => this.onOpenPaper(entry.paper.id));
    actions.appendChild(open);
    card.appendChild(actions);
    const details = document.createElement('details');
    details.className = 'citation-abstract';
    const summary = document.createElement('summary');
    summary.textContent = 'Abstract';
    const body = document.createElement('div');
    body.className = 'citation-abstract-body';
    body.textContent = entry.paper.abstract || t('暂无摘要');
    details.append(summary, body);
    card.appendChild(details);
  }

  appendDownloadAction(card, entry) {
    const actions = document.createElement('div');
    actions.className = 'citation-actions';
    const button = document.createElement('button');
    button.className = 'btn small btn-primary citation-download';
    button.textContent = t('下载入库');
    button.addEventListener('click', () => this.download(entry, button, card));
    actions.appendChild(button);
    card.appendChild(actions);
  }

  async download(entry, button, card) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = t('⏳ 下载中…');
    card.querySelector('.citation-error')?.remove();
    try {
      const paper = await this.onDownload(entry.external, button);
      if (!paper) throw new Error(t('下载失败，请重试'));
      const updated = { ...entry, kind: 'library', title: paper.title || entry.title, paper, external: null };
      const index = this.entries.findIndex(e => e.id === entry.id);
      if (index >= 0) this.entries[index] = updated;
      const nextCard = this.renderCard(updated);
      card.replaceWith(nextCard);
    } catch (err) {
      button.disabled = false;
      button.textContent = original;
      const error = document.createElement('div');
      error.className = 'citation-error';
      error.textContent = err && err.message ? err.message : t('下载失败，请重试');
      card.appendChild(error);
    }
  }

  destroy() {
    clearTimeout(this._showTimer);
    clearTimeout(this._hideTimer);
    document.removeEventListener('keydown', this._keyHandler);
    this.root.classList.add('hidden');
  }
}
