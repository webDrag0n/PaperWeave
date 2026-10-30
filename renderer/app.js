// PaperWeave 渲染进程主逻辑
import { bridge, isWeb } from './bridge.js';
import { PdfViewer } from './pdfviewer.js';
import { GraphView, graphThemePalette } from './graph.js';
import { computeSimEdges, topSimilar, aggregateExternal } from './similarity.js';
import { renderMarkdown, inlineMd } from './markdown.js';
import { t, tf, applyI18n, getLang, setLangStorage } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  papers: [],
  links: [],
  view: 'library',          // library | reader | graph
  readerPaperId: null,
  graphSelectedId: null,
  search: '',
  annots: [],
  bulkMode: false,
  bulkSelected: new Set(),
  sort: localStorage.getItem('pg-sort') || 'rating',
  graphFrom: 'library',
  graphMinRating: localStorage.getItem('pg-graph-min-rating') || 'all',
  libraries: [],
  currentLibraryId: null,
};

let viewer = null;
let graph = null;

/* ---------------- 工具 ---------------- */
function toast(msg, isErr = false, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function refreshData() {
  state.papers = await bridge.listPapers();
  state.links = await bridge.listLinks();
  await loadLibraries(); // 库卡片计数同步刷新
}

/* ---------------- 论文库面板（左侧，可展开缩回） ---------------- */
let libDragId = null;
let libEditingId = null;

const DEFAULT_LIB_ICON = '📚';
const libIcon = (l) => (l && l.icon) || DEFAULT_LIB_ICON;

function currentLibrary() {
  return state.libraries.find(l => l.id === state.currentLibraryId) || state.libraries[0] || null;
}

function setLibSidebarCollapsed(collapsed) {
  $('#libSidebar').classList.toggle('collapsed', collapsed);
  localStorage.setItem('pg-lib-collapsed', collapsed ? '1' : '0');
}

async function loadLibraries() {
  const r = await bridge.listLibraries();
  state.libraries = r.libraries || [];
  state.currentLibraryId = r.current;
  renderLibCards();
}

function sortedLibraries() {
  // 星标组在前；组内保持存储顺序（默认即创建时间顺序，拖拽重排后持久化）
  return [...state.libraries].sort((a, b) => (b.pinned - a.pinned));
}

function renderLibCards() {
  const box = $('#libCards');
  if (!box) return;
  box.innerHTML = '';
  const libs = sortedLibraries();
  const pinnedLibs = libs.filter(l => l.pinned);
  const normalLibs = libs.filter(l => !l.pinned);

  const pinnedGroup = document.createElement('div');
  pinnedGroup.className = 'lib-group';
  pinnedGroup.dataset.group = 'pinned';
  const sep = document.createElement('div');
  // 星标区与普通区之间的细线分隔
  sep.className = 'lib-sep' + (pinnedLibs.length ? ' show' : '');
  sep.innerHTML = '<span class="lib-sep-star">★</span>';
  const normalGroup = document.createElement('div');
  normalGroup.className = 'lib-group';
  normalGroup.dataset.group = 'normal';

  for (const l of pinnedLibs) pinnedGroup.appendChild(buildLibCard(l));
  for (const l of normalLibs) normalGroup.appendChild(buildLibCard(l));
  if (!pinnedLibs.length) pinnedGroup.innerHTML = `<div class="lib-group-empty">${esc(t('拖到此处加星标'))}</div>`;
  if (!normalLibs.length) normalGroup.innerHTML = `<div class="lib-group-empty">${esc(t('拖到此处取消星标'))}</div>`;

  // 组容器 drop：追加到该组末尾；落入星标组自动加星标，落入普通组自动去除
  for (const g of [pinnedGroup, normalGroup]) {
    g.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; g.classList.add('drop-hint'); });
    // 光标在组内子元素间移动也会触发 dragleave，只有真正离开组才移除高亮（防闪动）
    g.addEventListener('dragleave', (e) => { if (!g.contains(e.relatedTarget)) g.classList.remove('drop-hint'); });
    g.addEventListener('drop', async (e) => {
      e.preventDefault();
      g.classList.remove('drop-hint');
      if (!libDragId) return;
      const dragged = state.libraries.find(x => x.id === libDragId);
      if (!dragged) return;
      const toPinned = g.dataset.group === 'pinned';
      const pinIds = pinnedLibs.map(x => x.id).filter(id => id !== libDragId);
      const norIds = normalLibs.map(x => x.id).filter(id => id !== libDragId);
      (toPinned ? pinIds : norIds).push(libDragId);
      if (!!dragged.pinned !== toPinned) await bridge.updateLibrary(libDragId, { pinned: toPinned });
      await bridge.reorderLibraries([...pinIds, ...norIds]);
      await loadLibraries();
    });
  }
  box.append(pinnedGroup, sep, normalGroup);
  renderLibRail();
  renderLibraryBanner();
}

function buildLibCard(l) {
  const card = document.createElement('div');
  card.className = 'lib-card' + (l.id === state.currentLibraryId ? ' current' : '');
  card.draggable = true;
  card.dataset.id = l.id;
  if (libEditingId === l.id) {
    // 编辑态：名称 + 简介内联编辑
    card.innerHTML = `
      <div class="lc-edit">
        <input class="lc-name-input" type="text" value="${esc(l.name)}" maxlength="60">
        <textarea class="lc-desc-input" rows="2" placeholder="${t('简介（可选）：这个库收录什么主题的论文？')}">${esc(l.desc || '')}</textarea>
      </div>`;
    const nameInput = card.querySelector('.lc-name-input');
    const descInput = card.querySelector('.lc-desc-input');
    const save = async () => {
      const name = nameInput.value.trim();
      await bridge.updateLibrary(l.id, { name: name || l.name, desc: descInput.value.trim() });
      libEditingId = null;
      await loadLibraries();
      toast(t('已保存'));
    };
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { libEditingId = null; renderLibCards(); } });
    descInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { libEditingId = null; renderLibCards(); } });
    nameInput.addEventListener('blur', save);
    descInput.addEventListener('blur', save);
    card.draggable = false;
    setTimeout(() => nameInput.focus(), 30);
    return card;
  }
  card.innerHTML = `
    <div class="lc-actions">
      <button class="lc-pin ${l.pinned ? 'on' : ''}" title="${t('星标置顶')}">★</button>
      <button class="lc-edit" title="${t('编辑名称与简介')}">✎</button>
      ${state.libraries.length > 1 ? `<button class="lc-del" title="${t('删除论文库')}">✕</button>` : ''}
    </div>
    <div class="lc-head"><span class="lc-icon">${esc(libIcon(l))}</span><span class="lc-name">${esc(l.name)}</span></div>
    <div class="lc-desc">${esc(l.desc || '')}</div>
    <div class="lc-foot">${tf('{n} 篇', { n: l.paperCount })} · ${tf('{n} 条关联', { n: l.linkCount })}</div>`;
  card.querySelector('.lc-pin').addEventListener('click', async (e) => {
    e.stopPropagation();
    await bridge.updateLibrary(l.id, { pinned: !l.pinned });
    await loadLibraries();
  });
  card.querySelector('.lc-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    libEditingId = l.id;
    renderLibCards();
  });
  const del = card.querySelector('.lc-del');
  if (del) del.addEventListener('click', (e) => {
    e.stopPropagation();
    openLibDeleteModal(l);
  });
  // 点击切换
  card.addEventListener('click', async () => {
    if (l.id === state.currentLibraryId) return;
    await bridge.switchLibrary(l.id);
    await loadLibraries();
    await reloadLibraryView();
    toast(tf('已切换到论文库「{n}」', { n: l.name }));
  });
  // 拖拽排序：落到星标组卡片上自动加星标，落到普通组卡片上自动去除
  card.addEventListener('dragstart', (e) => {
    libDragId = l.id;
    card.classList.add('dragging');
    $('#libCards').classList.add('drag-active');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    libDragId = null;
    card.classList.remove('dragging');
    $('#libCards').classList.remove('drag-active');
  });
  card.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!libDragId || libDragId === l.id) return;
    const dragged = state.libraries.find(x => x.id === libDragId);
    if (!dragged) return;
    const toPinned = !!l.pinned;
    // 按当前展示顺序重排：把拖动项插到目标项之前
    const order = $$('#libCards .lib-card').map(c => c.dataset.id).filter(id => id !== libDragId);
    order.splice(order.indexOf(l.id), 0, libDragId);
    if (!!dragged.pinned !== toPinned) await bridge.updateLibrary(libDragId, { pinned: toPinned });
    await bridge.reorderLibraries(order);
    await loadLibraries();
  });
  return card;
}

// 折叠态 emoji 栏：所有库的标志图标，点击直接跳转
function renderLibRail() {
  const rail = $('#libRailIcons');
  if (!rail) return;
  rail.innerHTML = '';
  for (const l of sortedLibraries()) {
    const b = document.createElement('button');
    b.className = 'rail-lib' + (l.id === state.currentLibraryId ? ' current' : '');
    b.textContent = libIcon(l);
    b.title = l.name + (l.pinned ? ' ★' : '');
    b.addEventListener('click', async () => {
      if (l.id === state.currentLibraryId) return;
      await bridge.switchLibrary(l.id);
      await loadLibraries();
      await reloadLibraryView();
      toast(tf('已切换到论文库「{n}」', { n: l.name }));
    });
    rail.appendChild(b);
  }
}

/* ---------------- 论文库头部 banner ---------------- */
function renderLibraryBanner() {
  const banner = $('#libraryBanner');
  if (!banner) return;
  const lib = currentLibrary();
  if (!lib) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  $('#libBannerIcon').textContent = libIcon(lib);
  $('#libBannerName').textContent = lib.name;
  const descEl = $('#libBannerDesc');
  descEl.textContent = lib.desc || t('点击添加简介…');
  descEl.classList.toggle('empty', !lib.desc);
  const star = $('#libBannerStar');
  star.textContent = lib.pinned ? '★' : '☆';
  star.classList.toggle('on', !!lib.pinned);
  $('#libBannerDelete').classList.toggle('hidden', state.libraries.length <= 1);
}

// banner 标题 / 简介点击内联编辑
function startBannerEdit(kind) {
  const lib = currentLibrary();
  if (!lib) return;
  const target = kind === 'name' ? $('#libBannerName') : $('#libBannerDesc');
  if (target.dataset.editing) return;
  target.dataset.editing = '1';
  const input = document.createElement(kind === 'name' ? 'input' : 'textarea');
  input.className = 'lb-edit lb-edit-' + kind;
  if (kind === 'name') { input.type = 'text'; input.maxLength = 60; input.value = lib.name; }
  else { input.rows = 2; input.value = lib.desc || ''; input.placeholder = t('简介（可选）：这个库收录什么主题的论文？'); }
  target.replaceWith(input);
  input.focus();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save) {
      if (kind === 'name') await bridge.updateLibrary(lib.id, { name: val || lib.name });
      else await bridge.updateLibrary(lib.id, { desc: val });
    }
    input.replaceWith(target);
    delete target.dataset.editing;
    await loadLibraries();
    if (save) toast(t('已保存'));
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (kind === 'name' || !e.shiftKey)) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
}

/* ---------------- 标志 emoji 选择弹层 ---------------- */
const LIB_EMOJIS = ['📚', '📖', '🧠', '🤖', '🦾', '💻', '🔬', '🧪', '🧬', '💊', '🩺', '🔭', '⚛️', '🧮', '📊', '📈', '🌍', '🌱', '🚀', '🛰️', '📡', '🔋', '⚙️', '🧩', '💡', '🎓', '📝', '🗂️', '⭐', '🔥', '❤️', '🎯', '🏆', '🗺️', '🎨', '🎵', '💰', '⚖️', '🏛️', '🧘', '🍀', '🐋', '🕸️', '🌀', '☁️', '🌊', '⛰️', '🧱'];

function openEmojiPicker() {
  const lib = currentLibrary();
  if (!lib) return;
  const picker = $('#emojiPicker');
  picker.innerHTML = '';
  for (const em of LIB_EMOJIS) {
    const b = document.createElement('button');
    b.className = 'ep-item' + (lib.icon === em ? ' on' : '');
    b.textContent = em;
    b.addEventListener('click', async () => {
      closeEmojiPicker();
      await bridge.updateLibrary(lib.id, { icon: em });
      await loadLibraries();
    });
    picker.appendChild(b);
  }
  const r = $('#libBannerIcon').getBoundingClientRect();
  picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 316)) + 'px';
  picker.style.top = (r.bottom + 8) + 'px';
  picker.classList.remove('hidden');
}

function closeEmojiPicker() {
  $('#emojiPicker').classList.add('hidden');
}

// 切换论文库后整体重载当前视图
async function reloadLibraryView() {
  await refreshData();
  await updateAnnotCounts();
  state.graphSelectedId = null;
  if (state.view === 'library') renderLibrary();
  else if (state.view === 'graph' && graph) applyGraphFilter();
  else { showView('library'); renderLibrary(); }
}

// 新建论文库弹窗：选中的标志 emoji（空 = 默认 📚）
let libModalIcon = '';

function renderLibModalEmojis() {
  const row = $('#libEmojiRow');
  if (!row) return;
  row.innerHTML = '';
  for (const em of LIB_EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ep-item' + (libModalIcon === em ? ' on' : '');
    b.textContent = em;
    b.addEventListener('click', () => {
      libModalIcon = libModalIcon === em ? '' : em; // 再点一次取消选择
      renderLibModalEmojis();
    });
    row.appendChild(b);
  }
}

function openLibModal() {
  $('#libModal').classList.remove('hidden');
  $('#libNameInput').value = '';
  $('#libDescInput').value = '';
  libModalIcon = '';
  renderLibModalEmojis();
  setTimeout(() => $('#libNameInput').focus(), 50);
}

async function createLibraryFromModal() {
  const name = $('#libNameInput').value.trim();
  if (!name) { toast(t('论文库名称，如：Transformer 精读'), true); return; }
  const lib = await bridge.createLibrary(name, $('#libDescInput').value.trim(), libModalIcon);
  if (bridge.switchLibrary) await bridge.switchLibrary(lib.id);
  $('#libModal').classList.add('hidden');
  await loadLibraries();
  await reloadLibraryView();
  toast(tf('已创建并切换到论文库「{n}」', { n: lib.name }));
}

// 删除论文库：弹窗要求输入完整名称，一致才可删除
let libDeleteTarget = null;
function openLibDeleteModal(l) {
  libDeleteTarget = l;
  $('#libDeleteTip').textContent = tf('请输入完整名称「{n}」确认删除。论文本体保留在全局存储，库内关联将删除。', { n: l.name });
  $('#libDeleteInput').value = '';
  $('#libDeleteGo').disabled = true;
  $('#libDeleteModal').classList.remove('hidden');
  setTimeout(() => $('#libDeleteInput').focus(), 50);
}

/* ---------------- 导入冲突确认 ---------------- */
// 逐个弹窗确认：results 中含 conflict 的条目排队处理
async function resolveConflicts(results) {
  const finals = [];
  for (const r of results) {
    if (!r.conflict) { finals.push(r); continue; }
    const resolved = await askImportConflict(r.conflict);
    if (resolved) finals.push(resolved);
  }
  return finals;
}

function askImportConflict(conflict) {
  return new Promise((resolve) => {
    const cands = conflict.candidates || [];
    const reasonText = cands.map(c => t(c.reason === 'doi' ? 'DOI 相同（可能为不同版本）' : '标题高度相似')).join('、');
    $('#conflictTip').textContent = tf('正在导入的《{f}》与库中已有论文疑似重复（{reason}）。为避免重复下载与存储，建议复用已有论文。', { f: conflict.fileName || '', reason: reasonText });
    const list = $('#conflictList');
    list.innerHTML = '';
    for (const c of cands) {
      const item = document.createElement('div');
      item.className = 'ref-item';
      item.innerHTML = `<div class="r-title">${inlineMd(c.paper.title)}</div><div class="r-sub">${esc((c.paper.authors || []).slice(0, 3).join(', '))}${c.paper.year ? ' · ' + esc(c.paper.year) : ''}${c.paper.doi ? ' · ' + esc(c.paper.doi) : ''}</div>`;
      list.appendChild(item);
    }
    $('#conflictModal').classList.remove('hidden');
    const done = async (action) => {
      $('#conflictModal').classList.add('hidden');
      const r = await bridge.resolveImport(conflict.token, action);
      resolve(r && r.ok && !r.canceled ? r : null);
    };
    $('#conflictMerge').onclick = () => done('merge');
    $('#conflictNew').onclick = () => done('new');
    $('#conflictCancel').onclick = () => done('cancel');
  });
}

function paperById(id) { return state.papers.find(p => p.id === id); }

/* ---- 主题（浅色 / 深色） ---- */
function applyTheme(themeName) {
  document.documentElement.dataset.theme = themeName;
  localStorage.setItem('pg-theme', themeName);
  const btn = $('#btnTheme');
  if (btn) {
    btn.textContent = themeName === 'light' ? '🌙' : '☀️';
    btn.title = themeName === 'light' ? t('切换到深色主题') : t('切换到浅色主题');
  }
  // 主题联动 3D 图谱配色
  if (graph) graph.setTheme(themeName);
  // 图例圆点等 HTML 浮层元素同步图谱调色板
  const pal = graphThemePalette(themeName);
  const legendColors = [pal.selected, ...pal.hops, pal.other];
  $$('#graphLegend .dot').forEach((d, i) => { if (legendColors[i]) d.style.background = legendColors[i]; });
}
applyTheme(localStorage.getItem('pg-theme') || 'dark');

/* ---- 界面语言（中 / EN） ---- */
function applyLanguage(lang) {
  setLangStorage(lang);
  applyI18n();
  const lb = $('#btnLang');
  if (lb) lb.textContent = lang === 'en' ? '🌐 中' : '🌐 EN';
  applyTheme(localStorage.getItem('pg-theme') || 'dark'); // 刷新主题按钮 title
  // 重绘动态区域
  renderLibrary();
  renderLibCards();
  if (state.view === 'reader' && state.readerPaperId) {
    renderRefLists();
    renderAnnotList();
    renderOutline();
  }
  if (state.view === 'graph' && state.graphSelectedId) showGraphSide(state.graphSelectedId, graph ? graph.selectedIds : []);
  if (state.view === 'graph') $('#btnGraphBack').textContent = state.graphFrom === 'reader' ? t('← 继续阅读') : t('← 返回论文库');
}

function refsOf(id) { return state.links.filter(l => l.from === id).map(l => ({ link: l, paper: paperById(l.to) })).filter(x => x.paper); }
function citesOf(id) { return state.links.filter(l => l.to === id).map(l => ({ link: l, paper: paperById(l.from) })).filter(x => x.paper); }

/* ---------------- 视图切换 ---------------- */
// 图谱入口：记录来源（论文库 / 阅读器），退出时原路返回
function openGraph(from, paperId) {
  state.graphFrom = from;
  if (paperId) state.graphSelectedId = paperId;
  showView('graph');
}

function closeGraph() {
  if (state.graphFrom === 'reader' && state.readerPaperId && paperById(state.readerPaperId)) {
    showView('reader');
  } else {
    state.graphFrom = 'library';
    showView('library');
    renderLibrary();
  }
}

function showView(name) {
  state.view = name;
  $('#libraryView').classList.toggle('hidden', name !== 'library');
  $('#graphView').classList.toggle('hidden', name !== 'graph');
  $('#readerView').classList.toggle('hidden', name !== 'reader');
  $('#searchWrap').style.visibility = name === 'reader' ? 'hidden' : 'visible';
  if (name === 'graph') {
    $('#btnGraphBack').textContent = state.graphFrom === 'reader' ? '← 继续阅读' : '← 返回论文库';
    $('#graphMinRating').value = state.graphMinRating;
    ensureGraph();
    // 等待布局后再铺数据，确保容器尺寸就绪
    requestAnimationFrame(() => {
      applyGraphFilter();
    });
  }
}

/* 图谱星级过滤：按最低评星过滤节点与关联边，选中节点被过滤掉时清除选中 */
function applyGraphFilter() {
  if (!graph) return;
  const min = state.graphMinRating === 'all' ? null : parseInt(state.graphMinRating, 10);
  const papers = min === null ? state.papers : state.papers.filter(p => (typeof p.rating === 'number' ? p.rating : 1) >= min);
  const ids = new Set(papers.map(p => p.id));
  const links = state.links.filter(l => ids.has(l.from) && ids.has(l.to));
  if (state.graphSelectedId && !ids.has(state.graphSelectedId)) {
    state.graphSelectedId = null;
    $('#graphSide').classList.add('hidden');
  }
  graph.setData(papers, links);
  if (state.graphSelectedId && ids.has(state.graphSelectedId)) {
    graph.select(state.graphSelectedId);
    showGraphSide(state.graphSelectedId, graph.selectedIds);
  }
  $('#graphHopCtl').classList.toggle('hidden', !(graph && graph.selectedIds.length));
  $('#graphEmpty').classList.toggle('hidden', papers.length > 0);
}

/* ---------------- 论文库 ---------------- */
function ratingOf(p) { return typeof p.rating === 'number' ? p.rating : 1; }

function starWidgetHtml(p) {
  const r = ratingOf(p);
  let html = `<span class="stars" title="${t('重要性评星（点击设置，再点一次当前星级取消）')}">`;
  for (let i = 1; i <= 5; i++) html += `<button class="star ${i <= r ? 'on' : ''}" data-star="${i}">★</button>`;
  return html + '</span>';
}

function sortPapers(papers) {
  const arr = [...papers];
  switch (state.sort) {
    case 'added': return arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    case 'year': return arr.sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0) || (b.addedAt || 0) - (a.addedAt || 0));
    case 'title': return arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'en'));
    case 'links': return arr.sort((a, b) => (refsOf(b.id).length + citesOf(b.id).length) - (refsOf(a.id).length + citesOf(a.id).length));
    default: return arr.sort((a, b) => (b.favorite - a.favorite) || (b.addedAt - a.addedAt));
  }
}

function buildCard(p) {
  const refs = refsOf(p.id), cites = citesOf(p.id);
  const selected = state.bulkSelected.has(p.id);
  const card = document.createElement('div');
  card.className = 'card' + (selected ? ' bulk-selected' : '');
  card.dataset.paperId = p.id;
  card.innerHTML = `
    ${state.bulkMode ? `<input type="checkbox" class="bulk-check" ${selected ? 'checked' : ''} title="${t('选择')}">` : ''}
    <button class="fav-btn ${p.favorite ? 'on' : ''}" title="${t('收藏')}">${p.favorite ? '★' : '☆'}</button>
    <h3>${inlineMd(p.title)}</h3>
    <div class="authors">${esc((p.authors || []).join(', ') || t('未知作者'))}</div>
    <div class="meta-row">
      ${p.year ? `<span class="chip">${esc(p.year)}</span>` : ''}
      ${p.venue ? `<span class="chip">${esc(p.venue)}</span>` : ''}
      ${p.doi ? `<span class="chip doi">${esc(p.doi)}</span>` : ''}
      ${(p.tags || []).map(tag => `<span class="chip">#${esc(tag)}</span>`).join('')}
    </div>
    <div class="card-sub">
      ${starWidgetHtml(p)}
      <span class="stats">
        <span>📄 <b>${p.pageCount || '?'}</b> ${t('页')}</span>
        <span>📤 <b>${refs.length}</b></span>
        <span>📥 <b>${cites.length}</b></span>
        <span>🖍 <b>${(p._annCount || 0)}</b></span>
      </span>
    </div>
    <div class="card-actions">
      <button class="btn btn-primary" data-act="open">${t('📖 阅读')}</button>
      <button class="btn" data-act="graph">${t('🌐 关系')}</button>
      <button class="btn" data-act="fetch" title="${t('抓取引用/被引（含未入库条目）')}">${t('🔄 引用')}</button>
      <button class="btn" data-act="match" title="${t('解析参考文献并匹配库内论文')}">🧩</button>
      <button class="btn btn-danger" data-act="del" title="${t('从论文库删除（含 PDF、批注、引用关联）')}">🗑</button>
    </div>`;
  card.addEventListener('click', (e) => {
    // 评星
    const star = e.target.closest('.star');
    if (star) {
      e.stopPropagation();
      const v = parseInt(star.dataset.star, 10);
      const next = ratingOf(p) === v ? 0 : v; // 再点当前星级 = 取消评分
      bridge.updatePaper(p.id, { rating: next }).then(() => refreshData().then(renderLibrary));
      return;
    }
    if (e.target.closest('.fav-btn')) {
      bridge.updatePaper(p.id, { favorite: !p.favorite }).then(() => refreshData().then(renderLibrary));
      return;
    }
    // 批量管理模式下，点击卡片 = 勾选/取消勾选
    if (state.bulkMode) {
      toggleBulkSelect(p.id);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') openReader(p.id);
    else if (act === 'graph') openGraph('library', p.id);
    else if (act === 'fetch') fetchRefsFor(p.id);
    else if (act === 'match') autoMatchFor(p.id);
    else if (act === 'del') {
      (async () => {
        if (await deletePaper(p)) {
          await refreshData();
          await updateAnnotCounts();
          renderLibrary();
          if (state.view === 'graph') applyGraphFilter();
          toast(t('已删除'));
        }
      })();
    }
    else openReader(p.id);
  });
  return card;
}

const RATING_SECTIONS = [
  [5, '★★★★★ 核心必读'], [4, '★★★★ 很重要'], [3, '★★★ 重要'],
  [2, '★★ 一般'], [1, '★ 默认'], [0, '☆ 未评分（多为引用自动下载）'],
];

function renderLibrary() {
  renderLibraryBanner();
  const grid = $('#libraryGrid');
  const q = state.search.trim().toLowerCase();
  const papers = state.papers
    .filter(p => !q || [p.title, (p.authors || []).join(' '), (p.tags || []).join(' '), p.doi, p.venue].join(' ').toLowerCase().includes(q));

  $('#libraryEmpty').classList.toggle('hidden', state.papers.length > 0);
  $('#libraryToolbar').classList.toggle('hidden', state.papers.length === 0);
  grid.innerHTML = '';
  grid.classList.toggle('flat', state.sort !== 'rating');

  // 库统计条
  const favCount = state.papers.filter(p => p.favorite).length;
  const annTotal = state.papers.reduce((s, p) => s + (p._annCount || 0), 0);
  $('#libraryStats').textContent = state.papers.length
    ? tf('共 {p} 篇 · {l} 条引用关联 · {f} 篇收藏 · {a} 条批注', { p: state.papers.length, l: state.links.length, f: favCount, a: annTotal })
    : '';
  const sel = $('#sortSelect');
  if (sel && sel.value !== state.sort) sel.value = state.sort;

  if (state.sort === 'rating' && !q) {
    // 默认：按星级分区（收藏置顶仅在各区内部生效）
    for (const [r, label] of RATING_SECTIONS) {
      const group = papers.filter(p => ratingOf(p) === r);
      if (!group.length) continue;
      const section = document.createElement('div');
      section.className = 'rating-section';
      section.dataset.rating = r;
      const head = document.createElement('div');
      head.className = 'rating-head';
      head.innerHTML = `<span class="rating-title">${esc(t(label))}</span><span class="rating-count">${tf('{n} 篇', { n: group.length })}</span>`;
      const body = document.createElement('div');
      body.className = 'grid';
      for (const p of sortPapers(group)) body.appendChild(buildCard(p));
      section.append(head, body);
      grid.appendChild(section);
    }
  } else {
    for (const p of sortPapers(papers)) grid.appendChild(buildCard(p));
  }
}

async function updateAnnotCounts() {
  for (const p of state.papers) {
    p._annCount = (await bridge.listAnnotations(p.id)).length;
  }
}

/* ---------------- 导入 ---------------- */
async function handleImportResults(results) {
  // 疑似重复的条目先逐个弹窗请用户确认（合并复用 / 作为新论文 / 取消）
  results = await resolveConflicts(results);
  let ok = 0, dup = 0, fail = 0, reused = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.error) { fail++; console.warn(r.error); }
    else if (r.duplicate) dup++;
    else if (r.reused || r.merged) reused++;
    else ok++;
  }
  await refreshData();
  await updateAnnotCounts();
  renderLibrary();
  if (state.view === 'graph') applyGraphFilter();
  const parts = [];
  if (ok) parts.push(tf('成功导入 {n} 篇', { n: ok }));
  if (reused) parts.push(tf('{n} 篇复用已有论文', { n: reused }));
  if (dup) parts.push(tf('{n} 篇已存在', { n: dup }));
  if (fail) parts.push(tf('{n} 个失败', { n: fail }));
  toast(parts.join(getLang() === 'en' ? ', ' : '，') || t('没有可导入的文件'), fail > 0 && ok === 0);
}

/* ---------------- 统一导入（链接 + 拖文件 + 选文件） ---------------- */
let pendingImportFiles = [];

function openImportModal() {
  $('#importModal').classList.remove('hidden');
  $('#urlInput').value = '';
  pendingImportFiles = [];
  const prog = $('#urlProgress');
  prog.classList.add('hidden');
  prog.innerHTML = '';
  setTimeout(() => $('#importDrop').focus(), 50);
}

/* ---------------- 浏览器插件连接信息 ---------------- */
async function openExtModal() {
  $('#extModal').classList.remove('hidden');
  try {
    const info = await bridge.agentConnectionInfo();
    $('#extConnUrl').textContent = (info && info.baseUrl) || t('（Agent API 未启动）');
    $('#extConnToken').textContent = (info && info.token) || '—';
  } catch (_) {
    $('#extConnUrl').textContent = '—';
    $('#extConnToken').textContent = '—';
  }
}

/* ---- 库外发现：经典先驱（共同被引的参考文献）/ 衍生新作（同时引用库内多篇） ---- */
function openDiscoverModal() {
  $('#discoverModal').classList.remove('hidden');
  const agg = aggregateExternal(state.papers, resolveExtToLibrary);
  const fillDisc = (el, arr, badgeTpl) => {
    el.innerHTML = '';
    if (!arr.length) {
      el.innerHTML = `<div class="ref-empty">${t('暂无推荐——先对库内论文「抓取引用关系」累积数据')}</div>`;
      return;
    }
    for (const rec of arr) {
      const e = rec.entry;
      const item = document.createElement('div');
      item.className = 'ref-item ext-item';
      item.innerHTML = `
        <div class="r-title">${inlineMd(e.title || '(未知标题)')}</div>
        <div class="r-sub">${esc((e.authors || []).slice(0, 3).join(', '))}${e.year ? ' · ' + esc(e.year) : ''}${e.venue ? ' · ' + esc(e.venue) : ''}${e.citeCount ? (getLang() === 'en' ? ' · cited ' + e.citeCount : ' · 被引 ' + e.citeCount) : ''}</div>
        <div class="disc-row">
          <span class="disc-cnt">${tf(badgeTpl, { n: rec.count })}</span>
          <button class="btn small ext-dl">${t('⏬ 下载入库')}</button>
        </div>`;
      const btn = item.querySelector('.ext-dl');
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        btn.textContent = t('⏳ 下载中…');
        // 以其中一篇库内论文为宿主下载，入库后其余论文的引用面板可一键补建关联
        const src = rec.srcs[0];
        const r = await bridge.downloadRef(src.pid, src.key || rec.key);
        if (r && r.ok) {
          btn.textContent = t('✓ 已入库');
          btn.classList.add('inlib');
          await refreshData();
        } else {
          btn.disabled = false;
          btn.textContent = t('⏬ 下载入库');
          toast((r && r.error) || t('下载失败'), true, 4500);
        }
      });
      el.appendChild(item);
    }
  };
  fillDisc($('#discPriorList'), agg.prior, '被库内 {n} 篇引用');
  fillDisc($('#discDerivativeList'), agg.derivative, '引用了库内 {n} 篇');
}

function renderImportQueue() {
  const prog = $('#urlProgress');
  prog.classList.toggle('hidden', pendingImportFiles.length === 0);
  prog.innerHTML = pendingImportFiles.map(f => `<div>📄 ${esc(f.name)}（${t('待导入')}）</div>`).join('');
}

async function runImport() {
  const urls = $('#urlInput').value.split('\n').map(s => s.trim()).filter(Boolean);
  const files = pendingImportFiles;
  if (!urls.length && !files.length) { toast(t('请先粘贴链接或选择文件'), true); return; }
  const prog = $('#urlProgress');
  prog.classList.remove('hidden');
  prog.innerHTML = '';
  $('#importGo').disabled = true;
  const results = [];
  // 1) 文件
  if (files.length) {
    const line = document.createElement('div');
    line.textContent = tf('⏳ 正在导入 {n} 个文件…', { n: files.length });
    prog.appendChild(line);
    let r;
    if (isWeb) {
      r = await bridge.importFiles(files);
    } else {
      const paths = files.map(f => bridge.pathForFile(f)).filter(Boolean);
      r = await bridge.importPaths(paths);
    }
    results.push(...(r.results || []));
    line.className = 'ok';
    line.textContent = tf('✓ 文件导入完成（{n} 个）', { n: files.length });
    pendingImportFiles = [];
  }
  // 2) 链接
  for (const u of urls) {
    const line = document.createElement('div');
    line.textContent = '⏳ ' + u;
    prog.appendChild(line);
    const r = await bridge.importUrl(u);
    if (r.ok === false || r.error) {
      line.className = 'err';
      line.textContent = '✗ ' + u + ' — ' + (r.error || '失败');
      results.push({ error: r.error || '失败' });
    } else if (r.conflict) {
      line.textContent = '❓ ' + u;
      results.push({ conflict: r.conflict });
    } else {
      line.className = 'ok';
      line.textContent = (r.duplicate ? '↺ 已存在：' : r.reused ? '↺ 复用已有：' : '✓ ') + (r.paper ? r.paper.title : u);
      results.push(r);
    }
  }
  $('#importGo').disabled = false;
  await handleImportResults(results);
  if (results.every(r => !r.error)) $('#importModal').classList.add('hidden');
}

/* ---------------- 阅读器 ---------------- */
async function openReader(paperId) {
  const paper = await bridge.getPaper(paperId);
  if (!paper) { toast(t('论文不存在'), true); return; }
  state.readerPaperId = paperId;
  showView('reader');
  $('#readerTitle').innerHTML = inlineMd(paper.title);
  $('#readerTitle').title = paper.title;

  const bytes = await bridge.readPaperBytes(paperId);
  if (!bytes) { toast(t('找不到 PDF 文件'), true); showView('library'); return; }

  state.annots = await bridge.listAnnotations(paperId);

  if (!viewer) {
    viewer = new PdfViewer({
      pagesEl: $('#pdfPages'),
      scrollEl: $('#pdfScroll'),
      selPopup: $('#selPopup'),
      notePopup: $('#notePopup'),
      onPageCount: (n) => {
        $('#pageTotalLabel').textContent = '/ ' + n;
        $('#pageJumpInput').max = n;
      },
      onChange: async (anns) => {
        state.annots = anns;
        await bridge.saveAnnotations(state.readerPaperId, anns);
        renderAnnotList();
      },
      onAnnotClick: (a, ev) => viewer.openNotePopup(a, ev.clientX, ev.clientY),
      onStickyPlaced: () => $('#btnStickyMode').classList.remove('on'),
    });
  }
  $('#pdfScroll').scrollTop = 0;
  $('#pageJumpInput').value = '';
  searchState.query = ''; searchState.results = []; searchState.index = -1;
  $('#sideSearchInput').value = '';
  $('#searchCountLabel').textContent = '';
  renderSearchResults();
  try {
    await viewer.open(paperId, bytes, state.annots);
  } catch (e) {
    console.error(e);
    toast(t('PDF 打开失败：') + e.message, true);
    showView('library');
    return;
  }
  updateZoomLabel();
  fillMetaForm(paper);
  renderAnnotList();
  loadNotes(paper);
  renderRefLists();
  renderOutline();
  renderUnresolvedRefs(null);
  setOutlineOpen(false);
  // 护眼模式偏好
  const eye = localStorage.getItem('pg-eye-care') === '1';
  $('#readerView').classList.toggle('eye-care', eye);
  $('#btnEyeCare').classList.toggle('on', eye);
  // 面板收起偏好
  applyPanelCollapsed(localStorage.getItem('pg-panel-collapsed') === '1', true);
  switchTab('info');
  // 恢复上次阅读位置
  if (paper.lastPage && paper.lastPage > 1 && paper.lastPage <= viewer.doc.numPages) {
    await viewer.jumpToPage(paper.lastPage);
    toast(tf('已恢复到上次阅读位置（第 {n} 页）', { n: paper.lastPage }), false, 1800);
  }
}

/* ---- 右侧面板收起 ---- */
function applyPanelCollapsed(collapsed, silent) {
  $('#readerPanel').classList.toggle('hidden', collapsed);
  $('#btnTogglePanel').textContent = collapsed ? '⇤' : '⇥';
  $('#btnTogglePanel').title = collapsed ? t('展开右侧面板') : t('收起右侧面板');
  localStorage.setItem('pg-panel-collapsed', collapsed ? '1' : '0');
  // 面板宽度变化后，若当前是适应宽度（缩放比≈1），重新适配
  if (viewer && viewer.doc && Math.abs(viewer.zoomRatio() - 1) < 0.02) {
    viewer.fitWidth().then(updateZoomLabel);
  }
  if (!silent) toast(t(collapsed ? '面板已收起，专注阅读' : '面板已展开'), false, 1200);
}

function updateZoomLabel() {
  $('#zoomLabel').textContent = Math.round((viewer ? viewer.zoomRatio() : 1) * 100) + '%';
}

/* ---- 目录大纲（左侧半透明侧边栏） ---- */
function setOutlineOpen(open) {
  $('#outlinePanel').classList.toggle('hidden', !open);
  $('#btnOutline').classList.toggle('on', open);
}

async function renderOutline() {
  const box = $('#outlineList');
  box.innerHTML = '';
  const outline = viewer && viewer.outline;
  if (!outline || !outline.length) {
    box.innerHTML = `<div class="outline-empty">${t('该 PDF 没有内嵌目录大纲。')}<br>${t('可用顶栏页码跳转快速定位。')}</div>`;
    return;
  }
  const walk = async (items, depth) => {
    for (const it of items) {
      const btn = document.createElement('button');
      btn.className = 'outline-item';
      btn.style.paddingLeft = (10 + depth * 14) + 'px';
      btn.textContent = it.title || '(未命名)';
      const target = await viewer.resolveOutlineTarget(it);
      if (target && target.page) {
        const span = document.createElement('span');
        span.className = 'ol-page';
        span.textContent = 'p.' + target.page;
        btn.appendChild(span);
        btn.addEventListener('click', () => {
          viewer.jumpToOutline(it); // 精确定位到子段落标题处
          setOutlineOpen(false);
        });
      }
      box.appendChild(btn);
      if (it.items && it.items.length) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);
}

/* ---- 全文搜索 ---- */
const searchState = { query: '', results: [], index: -1 };

async function runSearch() {
  const q = $('#sideSearchInput').value;
  const box = $('#searchResults');
  if (!q.trim()) { searchState.query = ''; searchState.results = []; searchState.index = -1; $('#searchCountLabel').textContent = ''; renderSearchResults(); return; }
  box.innerHTML = `<div class="outline-empty">${t('搜索中…')}</div>`;
  const results = await viewer.searchText(q);
  searchState.query = q;
  searchState.results = results;
  searchState.index = results.length ? 0 : -1;
  $('#searchCountLabel').textContent = results.length ? (getLang() === 'en' ? `${results.length} hits` : `${results.length} 条`) : '';
  renderSearchResults();
  if (results.length) await gotoSearchResult(0);
}

function renderSearchResults() {
  const box = $('#searchResults');
  box.innerHTML = '';
  const { query, results, index } = searchState;
  if (!query.trim()) {
    box.innerHTML = `<div class="outline-empty">${t('输入关键词后按回车，在整篇 PDF 中搜索；点击结果跳转到对应位置，↑↓ 在结果间移动。')}</div>`;
    return;
  }
  if (!results.length) {
    box.innerHTML = `<div class="outline-empty">${t('没有找到匹配内容。')}</div>`;
    return;
  }
  const q = query.trim().toLowerCase();
  results.forEach((r, i) => {
    const b = document.createElement('button');
    b.className = 'search-hit-item' + (i === index ? ' active' : '');
    const snip = r.snippet;
    const pos = snip.toLowerCase().indexOf(q);
    const head = pos <= 0 ? '' : esc(snip.slice(0, pos)) ;
    const hit = pos < 0 ? '' : esc(snip.slice(pos, pos + q.length));
    const tail = pos < 0 ? esc(snip) : esc(snip.slice(pos + q.length));
    b.innerHTML = `<span class="sh-page">${tf('第 {n} 页', { n: r.page })}</span> ${r.prefixCut ? '…' : ''}${head}${hit ? `<mark>${hit}</mark>` : ''}${tail}${r.suffixCut ? '…' : ''}`;
    b.addEventListener('click', () => gotoSearchResult(i));
    box.appendChild(b);
  });
}

async function gotoSearchResult(i) {
  if (i < 0 || i >= searchState.results.length) return;
  searchState.index = i;
  $$('#searchResults .search-hit-item').forEach((el, k) => el.classList.toggle('active', k === i));
  await viewer.flashMatches(searchState.results[i].page);
}

/* ---- 信息面板 ---- */
function fillMetaForm(p) {
  $('#metaTitle').value = p.title || '';
  $('#metaAuthors').value = (p.authors || []).join(', ');
  $('#metaYear').value = p.year || '';
  $('#metaVenue').value = p.venue || '';
  $('#metaDoi').value = p.doi || '';
  $('#metaTags').value = (p.tags || []).join(', ');
  $('#metaAbstract').value = p.abstract || '';
}

async function saveMeta() {
  const patch = {
    title: $('#metaTitle').value.trim() || '未命名论文',
    authors: $('#metaAuthors').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    year: $('#metaYear').value.trim(),
    venue: $('#metaVenue').value.trim(),
    doi: $('#metaDoi').value.trim(),
    tags: $('#metaTags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    abstract: $('#metaAbstract').value.trim(),
  };
  await bridge.updatePaper(state.readerPaperId, patch);
  $('#readerTitle').innerHTML = inlineMd(patch.title);
  $('#readerTitle').title = patch.title;
  await refreshData();
  toast(t('已保存论文信息'));
}

async function deletePaper(p) {
  if (!p) return false;
  if (!confirm(tf('确定删除《{t}》吗？\n（PDF 文件、批注、笔记和引用关联都会删除）', { t: p.title }))) return false;
  await bridge.removePaper(p.id, true);
  return true;
}

async function deleteCurrentPaper() {
  const p = paperById(state.readerPaperId);
  if (!(await deletePaper(p))) return;
  viewer && viewer.destroy();
  state.readerPaperId = null;
  await refreshData();
  await updateAnnotCounts();
  showView('library');
  renderLibrary();
  toast(t('已删除'));
}

/* ---- 批量管理 ---- */
function setBulkMode(on) {
  state.bulkMode = on;
  if (!on) state.bulkSelected.clear();
  $('#bulkBar').classList.toggle('hidden', !on);
  $('#btnBulkMode').classList.toggle('on', on);
  updateBulkBar();
  renderLibrary();
}

function toggleBulkSelect(id) {
  if (state.bulkSelected.has(id)) state.bulkSelected.delete(id);
  else state.bulkSelected.add(id);
  updateBulkBar();
  renderLibrary();
}

function updateBulkBar() {
  $('#bulkCount').textContent = tf('已选 {n} 篇', { n: state.bulkSelected.size });
  const allVisible = state.papers.length > 0 && state.bulkSelected.size === state.papers.length;
  $('#bulkAll').checked = allVisible;
}

async function deleteBulkSelected() {
  const ids = [...state.bulkSelected];
  if (!ids.length) { toast(t('请先勾选要删除的论文'), true); return; }
  if (!confirm(tf('确定删除选中的 {n} 篇论文吗？\n（PDF 文件、批注、笔记和引用关联都会删除，且不可恢复）', { n: ids.length }))) return;
  let ok = 0;
  for (const id of ids) {
    try { if (await bridge.removePaper(id, true)) ok++; } catch (e) { console.warn('删除失败', id, e); }
  }
  state.bulkSelected.clear();
  await refreshData();
  await updateAnnotCounts();
  updateBulkBar();
  renderLibrary();
  toast(tf('已删除 {n} 篇', { n: ok }));
}

/* ---- 批注面板 ---- */
function renderAnnotList() {
  const list = $('#annotList');
  const anns = [...state.annots].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  $('#annotCount').textContent = anns.length;
  list.innerHTML = '';
  if (!anns.length) {
    list.innerHTML = `<div class="ref-empty">${t('还没有批注。选中正文文字即可高亮；点工具栏「📌 便利贴」可在任意位置放置便签。')}</div>`;
    return;
  }
  for (const a of anns) {
    const item = document.createElement('div');
    item.className = 'annot-item';
    item.innerHTML = `
      <div class="a-head">
        <span class="a-color" style="background:${esc(a.color || '#ffe74a')}"></span>
        <span>${a.type === 'sticky' ? t('📌 便利贴') : t('🖍 高亮')}</span>
        <button class="a-del" title="${t('删除')}">✕</button>
        <span class="a-page">${tf('第 {n} 页', { n: a.page })}</span>
      </div>
      ${a.text ? `<div class="a-text">“${esc(a.text)}”</div>` : ''}
      ${a.comment ? `<div class="a-comment">💬 ${esc(a.comment)}</div>` : ''}`;
    item.querySelector('.a-del').addEventListener('click', (e) => {
      e.stopPropagation();
      viewer.removeAnnotation(a.id);
    });
    item.addEventListener('click', () => {
      if (a.type === 'sticky') viewer.scrollToAnnotation({ ...a, text: '', comment: '' });
      viewer.scrollToAnnotation(a);
      viewer.openNotePopup(a, window.innerWidth - 340, 140);
    });
    list.appendChild(item);
  }
}

/* ---- 笔记 ---- */
let notesMode = 'edit';
let notesSaveTimer = null;

function loadNotes(p) {
  $('#notesEditor').value = p.notes || '';
  renderNotesPreview();
  setNotesMode('edit');
}

function setNotesMode(m) {
  notesMode = m;
  $('#notesEditor').classList.toggle('hidden', m !== 'edit');
  $('#notesPreview').classList.toggle('hidden', m !== 'preview');
  $('#btnNotesEdit').classList.toggle('btn-primary', m === 'edit');
  $('#btnNotesPreview').classList.toggle('btn-primary', m === 'preview');
  if (m === 'preview') renderNotesPreview();
}

function renderNotesPreview() {
  $('#notesPreview').innerHTML = renderMarkdown($('#notesEditor').value) || `<span style="color:var(--text-dim)">${t('暂无笔记')}</span>`;
}

function onNotesInput() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(async () => {
    await bridge.updatePaper(state.readerPaperId, { notes: $('#notesEditor').value });
    toast(t('笔记已自动保存'), false, 1200);
  }, 800);
}

/* ---- 引用面板 ---- */
// 未入库条目是否已匹配库内论文（用户可能已手动导入）
function matchExtToLibrary(ext) {  const selfId = state.readerPaperId;
  const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
  for (const p of state.papers) {
    if (p.id === selfId) continue;
    if (ext.doi && p.doi) {
      const a = String(ext.doi).replace(/^arxiv:/i, '').toLowerCase();
      const b = String(p.doi).replace(/^arxiv:/i, '').toLowerCase();
      if (a === b || a.endsWith(b) || b.endsWith(a)) return p;
    }
    if (ext.arxivId && p.doi && String(p.doi).toLowerCase().includes(String(ext.arxivId).toLowerCase())) return p;
    if (ext.title && p.title) {
      const ta = new Set(norm(ext.title).split(' ')), tb = new Set(norm(p.title).split(' '));
      let inter = 0;
      for (const w of ta) if (tb.has(w)) inter++;
      if (ta.size && inter / (ta.size + tb.size - inter) >= 0.8) return p;
    }
  }
  return null;
}

// 相似度计算的解析器：未入库条目若能匹配库内论文，归并到该节点 id 参与重叠统计
function resolveExtToLibrary(ext) {
  const m = matchExtToLibrary(ext);
  return m ? m.id : null;
}

function renderRefLists() {
  const id = state.readerPaperId;
  const paper = paperById(id) || {};
  const out = refsOf(id), inn = citesOf(id);
  const extAll = Array.isArray(paper.externalRefs) ? paper.externalRefs : [];
  const extOut = extAll.filter(e => e.dir === 'out');
  const extIn = extAll.filter(e => e.dir === 'in');
  const extSuffix = (n) => n ? (getLang() === 'en' ? ` +${n} external` : ` +${n} 未入库`) : '';
  $('#refOutCount').textContent = out.length + extSuffix(extOut.length);
  $('#refInCount').textContent = inn.length + extSuffix(extIn.length);
  const fill = (el, arr, unlinkTitle) => {
    el.innerHTML = '';
    if (!arr.length) {
      el.innerHTML = `<div class="ref-empty">${t('库内暂无关联论文。试试「抓取引用」或「离线匹配」。')}</div>`;
      return;
    }
    for (const { link, paper } of arr) {
      const item = document.createElement('div');
      item.className = 'ref-item';
      item.innerHTML = `
        <div class="r-title">${inlineMd(paper.title)}</div>
        <div class="r-sub">${esc((paper.authors || []).slice(0, 3).join(', '))}${paper.year ? ' · ' + esc(paper.year) : ''} · ${t('来源')}:${esc(link.source)}</div>
        <button class="r-unlink" title="${t(unlinkTitle)}">✕</button>`;
      item.querySelector('.r-unlink').addEventListener('click', async (e) => {
        e.stopPropagation();
        await bridge.removeLink(link.id);
        await refreshData();
        renderRefLists();
        toast(t('已移除关联'));
      });
      item.addEventListener('click', () => openReader(paper.id));
      el.appendChild(item);
    }
  };
  fill($('#refOutList'), out, '移除这条引用关联');
  fill($('#refInList'), inn, '移除这条引用关联');

  // 未入库引用条目：可单篇下载入库，也可一键全部下载
  const fillExt = (el, arr) => {
    el.innerHTML = '';
    if (!arr.length) return;
    const head = document.createElement('div');
    head.className = 'ext-head';
    head.textContent = tf('◌ 未入库 {n} 条（可下载入库，自动建立关联）', { n: arr.length });
    el.appendChild(head);
    for (const ext of arr) {
      const inLib = matchExtToLibrary(ext);
      const item = document.createElement('div');
      item.className = 'ref-item ext-item';
      item.innerHTML = `
        <div class="r-title">${inlineMd(ext.title || '(未知标题)')}</div>
        <div class="r-sub">${esc((ext.authors || []).slice(0, 3).join(', '))}${ext.year ? ' · ' + esc(ext.year) : ''}${ext.venue ? ' · ' + esc(ext.venue) : ''}${ext.citeCount ? (getLang() === 'en' ? ' · cited ' + ext.citeCount : ' · 被引 ' + ext.citeCount) : ''}</div>
        <div class="r-sub ext-doi">${esc(ext.doi || '')}</div>
        <button class="btn small ext-dl">${inLib ? t('✓ 已在库中 · 关联') : t('⏬ 下载入库')}</button>`;
      const btn = item.querySelector('.ext-dl');
      if (inLib) btn.classList.add('inlib');
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (inLib) {
          // 已在库中：直接补建关联边
          if (ext.dir === 'out') await bridge.addLink(id, inLib.id, 'ext-match');
          else await bridge.addLink(inLib.id, id, 'ext-match');
          await bridge.updatePaper(id, { externalRefs: extAll.filter(x => x.key !== ext.key) });
          await refreshData();
          renderRefLists();
          toast(t('已关联库内论文'));
          return;
        }
        await downloadOneRef(ext, btn);
      });
      el.appendChild(item);
    }
  };
  fillExt($('#refOutExt'), extOut);
  fillExt($('#refInExt'), extIn);
  $('#btnDlAllOut').classList.toggle('hidden', !extOut.length);
  $('#btnDlAllIn').classList.toggle('hidden', !extIn.length);
}

async function downloadOneRef(ext, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('⏳ 下载中…');
  refsProgressUI.begin();
  let r;
  try { r = await bridge.downloadRef(state.readerPaperId, ext.key); }
  finally { refsProgressUI.end(); }
  if (!r.ok) {
    btn.disabled = false;
    btn.textContent = orig;
    refsMsg(r.error, true);
    toast(r.error, true, 4500);
    return;
  }
  await afterRefsChanged(state.readerPaperId);
  refsMsg(`《${(r.paper.title || '').slice(0, 40)}》${t(r.duplicate ? '库中已存在，已关联' : '已下载入库（默认未评分）并建立关联')}`);
  toast(t(r.duplicate ? '已关联库内已有论文' : '下载入库成功'));
}

async function downloadAllRefs(dir) {
  const label = dir === 'out' ? t('参考文献') : t('被引文献');
  refsProgressUI.begin();
  let r;
  try { r = await bridge.downloadAllRefs(state.readerPaperId, dir); }
  finally { refsProgressUI.end(); }
  await afterRefsChanged(state.readerPaperId);
  if (!r.ok) { refsMsg(r.error, true); toast(r.error, true, 4500); return; }
  const parts = [tf('{label}：共 {t} 条待下载，成功 {d} 篇', { label, t: r.total, d: r.downloaded })];
  if (r.skipped) parts.push(tf('{n} 篇库中已存在（已关联）', { n: r.skipped }));
  if (r.failed && r.failed.length) parts.push(tf('{n} 条失败（多为无开放获取 PDF）', { n: r.failed.length }));
  refsMsg(parts.join(getLang() === 'en' ? '; ' : '，'));
  toast(tf('下载完成：新增 {n} 篇', { n: r.downloaded }), false, 3500);
}

async function fetchRefsFor(paperId) {
  // 组合：参考文献 + 被引（卡片与图谱按钮走这里）
  const p = paperById(paperId);
  toast(tf('正在抓取《{t}》的引用关系…', { t: (p.title || '').slice(0, 30) + '…' }));
  refsProgressUI.begin();
  let r;
  try { r = await bridge.fetchRefs(paperId); }
  finally { refsProgressUI.end(); }
  await afterRefsChanged(paperId);
  if (!r.ok) { refsMsg(r.error, true); toast(r.error, true, 5000); return; }
  const parts = [];
  if (r.references && r.references.ok) parts.push(tf('参考文献识别 {r}/{t} 条，新增 {a} 条关联', { r: r.references.resolved, t: r.references.total, a: r.references.added }));
  if (r.citations && r.citations.ok) parts.push(tf('被引 {c} 条（{s}），新增 {a} 条关联', { c: r.citations.citeCount, s: r.citations.source === 'semanticscholar' ? 'Semantic Scholar' : 'OpenAlex', a: r.citations.added }));
  if (r.references && !r.references.ok) parts.push(t('参考文献') + ': ' + r.references.error);
  if (r.citations && !r.citations.ok) parts.push(t('被引') + ': ' + r.citations.error);
  refsMsg(parts.join(getLang() === 'en' ? '; ' : '；'));
  if (r.references && r.references.ok) renderUnresolvedRefs(r.references.unresolved);
  toast(tf('共新增 {n} 条库内关联', { n: r.added }));
}

async function fetchReferencesFor(paperId) {
  const p = paperById(paperId);
  toast(tf('正在解析《{t}》的参考文献并在线检索…', { t: (p.title || '').slice(0, 30) + '…' }));
  refsProgressUI.begin();
  let r;
  try { r = await bridge.fetchReferences(paperId); }
  finally { refsProgressUI.end(); }
  await afterRefsChanged(paperId);
  if (!r.ok) { refsMsg(r.error, true); toast(r.error, true, 5000); return; }
  const un = (r.unresolved || []).length;
  refsMsg(tf('参考文献：共 {t} 条，在线识别 {r} 条，命中库内 {m} 篇，新增 {a} 条关联', { t: r.total, r: r.resolved, m: r.matched, a: r.added })
    + (r.external ? tf('，{n} 条未入库（可下载）', { n: r.external }) : '') + (un ? tf('，{n} 条未能识别', { n: un }) : '') + (getLang() === 'en' ? '.' : '。'));
  renderUnresolvedRefs(r.unresolved);
  toast(tf('参考文献新增 {n} 条关联', { n: r.added }));
}

/* 展示未能在线识别的参考文献条目，便于人工核对 / 补录 */
function renderUnresolvedRefs(list) {
  const wrap = $('#refsUnresolvedWrap');
  if (!list || !list.length) { wrap.classList.add('hidden'); wrap.open = false; return; }
  $('#refsUnresolvedSummary').textContent = tf('⚠️ {n} 条参考文献未能在线识别（点击展开，可用「手动关联」补录）', { n: list.length });
  $('#refsUnresolvedList').innerHTML = list.map(e => `<div class="unresolved-item">${esc(e)}</div>`).join('');
  wrap.classList.remove('hidden');
}

async function fetchCitationsFor(paperId) {
  const p = paperById(paperId);
  toast(tf('正在从 Semantic Scholar 抓取《{t}》的被引…', { t: (p.title || '').slice(0, 30) + '…' }));
  refsProgressUI.begin();
  let r;
  try { r = await bridge.fetchCitations(paperId); }
  finally { refsProgressUI.end(); }
  await afterRefsChanged(paperId);
  if (!r.ok) { refsMsg(r.error, true); toast(r.error, true, 5000); return; }
  refsMsg(tf('被引：共 {c} 条（来源 {s}），命中库内新增 {a} 条关联', { c: r.citeCount, s: r.source === 'semanticscholar' ? 'Semantic Scholar' : t('OpenAlex 回退'), a: r.added })
    + (r.external ? tf('，{n} 条未入库（可下载）', { n: r.external }) : '') + (getLang() === 'en' ? '.' : '。'));
  toast(tf('被引新增 {n} 条关联', { n: r.added }));
}

async function afterRefsChanged(paperId) {
  await refreshData();
  if (state.view === 'reader' && state.readerPaperId === paperId) renderRefLists();
  if (state.view === 'graph' && graph) applyGraphFilter();
  if (state.view === 'library') renderLibrary();
}

async function autoMatchFor(paperId) {
  const r = await bridge.autoMatchRefs(paperId);
  await refreshData();
  if (state.view === 'reader' && state.readerPaperId === paperId) renderRefLists();
  if (state.view === 'graph' && graph) applyGraphFilter();
  if (state.view === 'library') renderLibrary();
  if (!r.ok) { refsMsg(r.error, true); toast(r.error, true, 3500); return; }
  refsMsg(tf('离线匹配完成：从参考文献中识别出 {m} 篇库内论文，新增 {a} 条关联。', { m: r.matched, a: r.added }));
  toast(tf('离线匹配新增 {n} 条关联', { n: r.added }));
}

function refsMsg(msg, isErr = false) {
  const el = $('#refsMsg');
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
  el.classList.toggle('busy', false);
  el.classList.toggle('ok', !!msg && !isErr);
}

/* ---- 抓取/下载进度条（事件已在主进程节流至 10Hz，渲染开销小） ---- */
const refsProgressUI = {
  active: 0,
  begin() {
    this.active++;
    this.setButtonsBusy(true);
    $('#refsProgress').classList.remove('hidden');
  },
  end() {
    this.active = Math.max(0, this.active - 1);
    if (!this.active) {
      this.setButtonsBusy(false);
      setTimeout(() => { if (!this.active) $('#refsProgress').classList.add('hidden'); }, 1500);
    }
  },
  setButtonsBusy(busy) {
    for (const id of ['#btnFetchReferences', '#btnFetchCitations', '#btnAutoMatch', '#btnManualLink', '#btnDlAllOut', '#btnDlAllIn']) {
      const b = $(id);
      if (b) b.disabled = busy;
    }
  },
  update(p) {
    // 后台自动抓取的进度也要可见（无 begin/end 配对，3 秒无事件自动隐藏）
    $('#refsProgress').classList.remove('hidden');
    clearTimeout(this._hideT);
    this._hideT = setTimeout(() => { if (!this.active) $('#refsProgress').classList.add('hidden'); }, 3000);
    const stageEl = $('#rpStage'), countEl = $('#rpCount'), fill = $('#rpFill'), item = $('#rpItem');
    const stageName = { citations: t('📥 抓取被引'), references: t('📤 抓取引用（参考文献）'), download: t('⏬ 下载引用文献') }[p.stage] || p.stage;
    stageEl.textContent = stageName;
    if (p.total > 0) {
      countEl.textContent = `${Math.min(p.current, p.total)} / ${p.total}`;
      fill.classList.remove('indeterminate');
      fill.style.width = Math.min(100, Math.round(p.current / p.total * 100)) + '%';
    } else {
      countEl.textContent = '…';
      fill.classList.add('indeterminate');
    }
    const note = p.note ? `<span class="rp-note">${esc(p.note)}</span> ` : '';
    item.innerHTML = note + (p.currentItem ? esc(p.currentItem) : '');
  },
};

/* ---- 手动关联 ---- */
function openLinkModal() {
  $('#linkModal').classList.remove('hidden');
  $('#linkSearch').value = '';
  renderLinkCandidates('');
  setTimeout(() => $('#linkSearch').focus(), 50);
}

function renderLinkCandidates(q) {
  const box = $('#linkCandidates');
  box.innerHTML = '';
  const self = state.readerPaperId;
  const query = q.trim().toLowerCase();
  const existing = new Set(refsOf(self).map(x => x.paper.id));
  const cands = state.papers
    .filter(p => p.id !== self && !existing.has(p.id))
    .filter(p => !query || [p.title, (p.authors || []).join(' '), p.doi].join(' ').toLowerCase().includes(query))
    .slice(0, 30);
  if (!cands.length) {
    box.innerHTML = `<div class="ref-empty">${t('没有可关联的论文')}</div>`;
    return;
  }
  for (const p of cands) {
    const item = document.createElement('div');
    item.className = 'ref-item';
    item.innerHTML = `<div class="r-title">${inlineMd(p.title)}</div><div class="r-sub">${esc((p.authors || []).slice(0, 3).join(', '))}${p.year ? ' · ' + esc(p.year) : ''}</div>`;
    item.addEventListener('click', async () => {
      await bridge.addLink(self, p.id, 'manual');
      await refreshData();
      renderRefLists();
      renderLinkCandidates($('#linkSearch').value);
      toast(t('已添加引用关联'));
    });
    box.appendChild(item);
  }
}

/* ---------------- 3D 图谱 ---------------- */
function ensureGraph() {
  if (graph) return;
  graph = new GraphView({
    wrap: $('#graphCanvasWrap'),
    tooltipEl: $('#graphTooltip'),
    theme: localStorage.getItem('pg-theme') || 'dark',
    onSelect: (primaryId, selectedIds) => {
      state.graphSelectedId = primaryId;
      // 跳数滑条：有选中时显示
      $('#graphHopCtl').classList.toggle('hidden', !(selectedIds && selectedIds.length));
      if (primaryId) showGraphSide(primaryId, selectedIds);
      else if (!selectedIds || !selectedIds.length) $('#graphSide').classList.add('hidden');
    },
    onOpen: (id) => openReader(id),
  });
  // 跳数档位偏好（默认 2）
  graph.hopDepth = parseInt(localStorage.getItem('pg-graph-hop') || '2', 10);
  $('#hopRange').value = graph.hopDepth;
  $('#hopLabel').textContent = graph.hopDepth;
}

/* ---------------- BibTeX 生成与复制 ---------------- */
function bibtexOf(p) {
  const firstAuthor = ((p.authors || [])[0] || '').trim();
  const last = firstAuthor ? firstAuthor.split(/\s+/).pop() : 'unknown';
  const word = (p.title || 'untitled').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/)[0] || 'paper';
  const key = (last + (p.year || '') + word).replace(/[^A-Za-z0-9:_-]/g, '') || 'ref';
  const arxivM = /^arxiv:(.+)$/i.exec(p.doi || '') || /10\.48550\/arxiv\.(.+)/i.exec(p.doi || '');
  const arxiv = arxivM ? arxivM[1] : '';
  const fields = [
    ['title', '{' + (p.title || '') + '}'],
    (p.authors || []).length && ['author', p.authors.join(' and ')],
    p.year && ['year', String(p.year)],
    p.venue && ['journal', p.venue],
    p.doi && !arxiv && ['doi', p.doi],
    arxiv && ['eprint', arxiv],
    arxiv && ['archivePrefix', 'arXiv'],
  ].filter(Boolean);
  const type = p.venue ? '@article' : '@misc';
  return `${type}{${key},\n` + fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n') + '\n}';
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
    ta.remove();
  }
  toast(okMsg);
}

/* ---------------- 图谱右侧详情栏 ---------------- */
// 引用 / 被引分区：默认前 3 条，可展开全部；支持整区与单条复制 BibTeX
function buildRelationSection(container, arr, label, color, onJump) {
  container.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'gs-rel-head';
  head.innerHTML = `<b style="color:${color}">${esc(label)}</b><span class="cnt">${tf('{n} 篇', { n: arr.length })}</span>`;
  if (arr.length) {
    const all = document.createElement('button');
    all.className = 'gs-bib-all';
    all.textContent = t('📋 全部 BibTeX');
    all.title = t('复制该区全部论文的 BibTeX');
    all.addEventListener('click', () =>
      copyText(arr.map(x => bibtexOf(x.paper)).join('\n\n'), tf('已复制 {n} 条 BibTeX', { n: arr.length })));
    head.appendChild(all);
  }
  container.appendChild(head);
  const list = document.createElement('div');
  list.className = 'gs-rel-list';
  container.appendChild(list);
  if (!arr.length) {
    list.innerHTML = '<div class="cnt">—</div>';
    return;
  }
  let expanded = false;
  const renderItems = () => {
    list.innerHTML = '';
    for (const x of (expanded ? arr : arr.slice(0, 3))) {
      const item = document.createElement('div');
      item.className = 'gs-item';
      item.innerHTML = `
        <div class="gs-item-main">
          <div class="gs-item-title">${inlineMd(x.paper.title)}</div>
          <div class="gs-item-sub">${esc((x.paper.authors || []).join(', ') || t('未知作者'))}${x.paper.year ? ' · ' + esc(x.paper.year) : ''}</div>
        </div>
        <button class="gs-bib" title="${t('复制该论文 BibTeX')}">📋</button>`;
      item.querySelector('.gs-bib').addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(bibtexOf(x.paper), t('已复制 BibTeX'));
      });
      item.addEventListener('click', () => onJump && onJump(x.paper.id));
      list.appendChild(item);
    }
    if (arr.length > 3) {
      const tg = document.createElement('button');
      tg.className = 'gs-expand';
      tg.textContent = expanded ? t('收起 ▴') : tf('展开全部 {n} 篇 ▾', { n: arr.length });
      tg.addEventListener('click', () => { expanded = !expanded; renderItems(); });
      list.appendChild(tg);
    }
  };
  renderItems();
}

/* 作者名单折叠：超过 3 行时省略中间，只保留首行与最后一位，点击展开 */
let graphAuthorsExpandedFor = null; // 记录当前展开作者名单的论文 id
function renderGraphAuthors(el, p) {
  if (!el) return;
  const authors = (p.authors || []).filter(Boolean);
  const bindToggle = (expand) => {
    const btn = el.querySelector('.gs-auth-toggle');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      graphAuthorsExpandedFor = expand ? p.id : null;
      renderGraphAuthors(el, p);
    });
  };
  if (!authors.length) { el.textContent = t('未知作者'); return; }
  if (authors.length <= 2 || graphAuthorsExpandedFor === p.id) {
    const expanded = graphAuthorsExpandedFor === p.id && authors.length > 2;
    el.innerHTML = esc(authors.join(', '))
      + (expanded ? ` <button type="button" class="gs-auth-toggle">${t('收起 ▴')}</button>` : '');
    if (expanded) bindToggle(false);
    return;
  }
  // 折叠判定：整串超过 3 行才折叠（依赖 #graphSide 已显示，否则 scrollHeight 恒为 0）
  el.textContent = authors.join(', ');
  const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19;
  if (el.scrollHeight <= lineH * 3 + 2) return;
  let fit = 1;
  for (let i = 2; i < authors.length - 1; i++) {
    el.textContent = authors.slice(0, i).join(', ');
    if (el.scrollHeight > lineH * 1.5 + 2) break;
    fit = i;
  }
  const omit = authors.length - fit - 1;
  el.innerHTML = esc(authors.slice(0, fit).join(', '))
    + ` <span class="gs-auth-omit">… ${tf('等 {n} 位', { n: omit })} …</span> `
    + esc(authors[authors.length - 1])
    + ` <button type="button" class="gs-auth-toggle">${t('展开 ▾')}</button>`;
  bindToggle(true);
}

/* 详情栏「相似论文」区：文献耦合 × 同被引重叠度最高的前 5 篇，点击跳转 */
function buildSimilarSection(container, id, onJump) {
  container.innerHTML = '';
  const sims = topSimilar(id, state.papers, state.links, 5, resolveExtToLibrary);
  if (!sims.length) return;
  const head = document.createElement('div');
  head.className = 'gs-rel-head';
  head.innerHTML = `<b style="color:#2ec4b6">${t('📊 相似论文：')}</b><span class="cnt">${sims.length} · ${t('按参考文献与被引重叠度')}</span>`;
  container.appendChild(head);
  const list = document.createElement('div');
  list.className = 'gs-rel-list';
  container.appendChild(list);
  for (const { paper, score } of sims) {
    const item = document.createElement('div');
    item.className = 'gs-item';
    item.innerHTML = `
      <div class="gs-item-main">
        <div class="gs-item-title">${inlineMd(paper.title)}</div>
        <div class="gs-item-sub">${esc((paper.authors || []).slice(0, 3).join(', '))}${paper.year ? ' · ' + esc(paper.year) : ''}</div>
      </div>
      <span class="gs-sim-score">${Math.round(score * 100)}%</span>`;
    item.addEventListener('click', () => onJump(paper.id));
    list.appendChild(item);
  }
}

function showGraphSide(id, selectedIds) {
  const p = paperById(id);
  if (!p) return;
  const refs = refsOf(id), cites = citesOf(id);
  const extN = (p.externalRefs || []).length;
  // 先显示面板再填充：作者折叠依赖 scrollHeight 测量
  $('#graphSide').classList.remove('hidden');
  $('#graphSideTitle').innerHTML = inlineMd(p.title);
  const multi = selectedIds && selectedIds.length > 1
    ? `<div style="color:#ffd54a;margin-bottom:6px">${tf('◈ 已多选 {n} 篇，它们之间的最短关联已用轮廓高亮', { n: selectedIds.length })}</div>` : '';
  $('#graphSideMeta').innerHTML = multi + `
    <div id="graphSideAuthors"></div>
    <div>${[p.year, p.venue, p.doi].filter(Boolean).map(esc).join(' · ')}</div>`;
  renderGraphAuthors($('#graphSideAuthors'), p);
  // 点击条目：相机聚焦并选中对应节点
  const jump = (pid) => {
    if (!graph || !paperById(pid)) return;
    graph.focusNode(pid);
    graph.select(pid);
    state.graphSelectedId = pid;
    showGraphSide(pid, graph.selectedIds);
  };
  buildRelationSection($('#graphSideRefs'), refs, t('📤 它引用的：'), '#4aa3ff', jump);
  buildRelationSection($('#graphSideCites'), cites, t('📥 引用它的：'), '#ff7a4a', jump);
  buildSimilarSection($('#graphSideSim'), id, jump);
  if (extN) {
    const ext = document.createElement('div');
    ext.className = 'cnt';
    ext.style.marginTop = '4px';
    ext.textContent = tf('◌ 另有 {n} 条未入库引用，可在阅读器「引用」页签下载', { n: extN });
    $('#graphSideCites').appendChild(ext);
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('#brandHome').addEventListener('click', () => { showView('library'); renderLibrary(); });
  // 论文库面板：收起/展开 + 新建 + 删除确认弹窗
  $('#btnLibToggle').addEventListener('click', () => setLibSidebarCollapsed(false));
  $('#btnLibCollapse').addEventListener('click', () => setLibSidebarCollapsed(true));
  // 论文库 banner：换图标 / 编辑名称简介 / 星标 / 删除
  $('#libBannerIcon').addEventListener('click', () => {
    const p = $('#emojiPicker');
    if (p.classList.contains('hidden')) openEmojiPicker(); else closeEmojiPicker();
  });
  $('#libBannerName').addEventListener('click', () => startBannerEdit('name'));
  $('#libBannerDesc').addEventListener('click', () => startBannerEdit('desc'));
  $('#libBannerStar').addEventListener('click', async () => {
    const lib = currentLibrary();
    if (!lib) return;
    await bridge.updateLibrary(lib.id, { pinned: !lib.pinned });
    await loadLibraries();
  });
  $('#libBannerDelete').addEventListener('click', () => {
    const lib = currentLibrary();
    if (lib) openLibDeleteModal(lib);
  });
  document.addEventListener('click', (e) => {
    const p = $('#emojiPicker');
    if (p.classList.contains('hidden')) return;
    if (e.target.closest('#emojiPicker') || e.target.closest('#libBannerIcon')) return;
    closeEmojiPicker();
  }, true);
  $('#btnNewLibrary').addEventListener('click', openLibModal);
  $('#libCancel').addEventListener('click', () => $('#libModal').classList.add('hidden'));
  $('#libCreate').addEventListener('click', createLibraryFromModal);
  $('#libNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createLibraryFromModal(); });
  $('#libDeleteCancel').addEventListener('click', () => $('#libDeleteModal').classList.add('hidden'));
  $('#libDeleteInput').addEventListener('input', (e) => {
    $('#libDeleteGo').disabled = !libDeleteTarget || e.target.value !== libDeleteTarget.name;
  });
  $('#libDeleteGo').addEventListener('click', async () => {
    if (!libDeleteTarget || $('#libDeleteInput').value !== libDeleteTarget.name) return;
    const name = libDeleteTarget.name;
    const ok = await bridge.deleteLibrary(libDeleteTarget.id);
    $('#libDeleteModal').classList.add('hidden');
    if (!ok) { toast(t('至少保留一个论文库'), true); return; }
    libDeleteTarget = null;
    await loadLibraries();
    await reloadLibraryView();
    toast(tf('已删除论文库「{n}」', { n: name }));
  });
  $('#btnImport').addEventListener('click', openImportModal);
  $('#btnImportEmpty').addEventListener('click', openImportModal);
  // 浏览器插件：连接信息弹窗
  $('#btnExt').addEventListener('click', openExtModal);
  $('#extClose').addEventListener('click', () => $('#extModal').classList.add('hidden'));
  $('#extCopyUrl').addEventListener('click', () => {
    const v = $('#extConnUrl').textContent;
    if (v && v !== '—') copyText(v, t('已复制到剪贴板'));
  });
  $('#extCopyToken').addEventListener('click', () => {
    const v = $('#extConnToken').textContent;
    if (v && v !== '—') copyText(v, t('已复制到剪贴板'));
  });
  $('#extOpenFolder').addEventListener('click', async () => {
    const okOpen = await bridge.openExtensionFolder();
    if (!okOpen) toast(t('未找到插件目录，请从项目仓库获取 extension 文件夹'), true, 4000);
  });
  // 库外发现：经典先驱 / 衍生新作
  $('#btnDiscover').addEventListener('click', openDiscoverModal);
  $('#discoverClose').addEventListener('click', () => $('#discoverModal').classList.add('hidden'));
  // 图谱入口：论文库工具条 / 阅读器顶栏 / 卡片「关系」按钮；退出时原路返回
  $('#btnGraphFromLib').addEventListener('click', () => openGraph('library'));
  $('#btnGraphFromReader').addEventListener('click', () => openGraph('reader', state.readerPaperId));
  $('#btnGraphBack').addEventListener('click', closeGraph);
  $('#graphMinRating').addEventListener('change', (e) => {
    state.graphMinRating = e.target.value;
    localStorage.setItem('pg-graph-min-rating', state.graphMinRating);
    applyGraphFilter();
  });
  // 跳数滑条
  $('#hopRange').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('#hopLabel').textContent = v;
    if (graph) graph.setHopDepth(v);
    localStorage.setItem('pg-graph-hop', String(v));
  });
  $('#searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.view === 'library') renderLibrary();
    if (state.view === 'graph' && graph) {
      const q = state.search.trim().toLowerCase();
      if (q) {
        const hit = state.papers.find(p => (p.title || '').toLowerCase().includes(q));
        if (hit) { graph.focusNode(hit.id); graph.select(hit.id); showGraphSide(hit.id); state.graphSelectedId = hit.id; }
      }
    }
  });

  // 统一导入弹窗：链接 + 拖文件 + 选文件
  $('#importCancel').addEventListener('click', () => $('#importModal').classList.add('hidden'));
  $('#importGo').addEventListener('click', runImport);
  $('#importDrop').addEventListener('click', async () => {
    // 点击区域打开文件管理器选择
    const r = await bridge.importDialog();
    if (r.canceled) return;
    toast(t('正在导入并解析 PDF…'));
    await handleImportResults(r.results);
    if (r.results.every(x => !x.error)) $('#importModal').classList.add('hidden');
  });
  $('#importDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('#importDrop').classList.add('over'); });
  $('#importDrop').addEventListener('dragleave', () => $('#importDrop').classList.remove('over'));
  $('#importDrop').addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('#importDrop').classList.remove('over');
    const files = [...e.dataTransfer.files].filter(f => /\.pdf$/i.test(f.name));
    if (!files.length) { toast(t('只支持 PDF 文件'), true); return; }
    pendingImportFiles.push(...files);
    renderImportQueue();
  });

  // 手动关联
  $('#linkCancel').addEventListener('click', () => $('#linkModal').classList.add('hidden'));
  $('#linkSearch').addEventListener('input', (e) => renderLinkCandidates(e.target.value));
  $('#btnManualLink').addEventListener('click', openLinkModal);

  // 阅读器
  $('#btnBackLib').addEventListener('click', () => { showView('library'); renderLibrary(); });
  $('#zoomIn').addEventListener('click', async () => { await viewer.zoom(1.2); updateZoomLabel(); });
  $('#zoomOut').addEventListener('click', async () => { await viewer.zoom(1 / 1.2); updateZoomLabel(); });
  $('#btnFitWidth').addEventListener('click', async () => { await viewer.fitWidth(); updateZoomLabel(); toast(t('已适应页面宽度'), false, 1200); });
  $('#btnTogglePanel').addEventListener('click', () => applyPanelCollapsed($('#readerPanel').classList.contains('hidden') === false));
  $('#btnTheme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  $('#btnLang').addEventListener('click', () => {
    applyLanguage(getLang() === 'en' ? 'zh' : 'en');
  });
  $('#btnStickyMode').addEventListener('click', () => {
    const on = !viewer.stickyMode;
    viewer.setStickyMode(on);
    $('#btnStickyMode').classList.toggle('on', on);
    if (on) toast(t('点击 PDF 页面任意位置放置便利贴'), false, 1800);
  });
  $('#hlColors').addEventListener('click', (e) => {
    const b = e.target.closest('.hl-dot');
    if (!b) return;
    viewer.hlColor = b.dataset.color;
    $$('#hlColors .hl-dot').forEach(x => x.classList.toggle('active', x === b));
    toast(t('高亮颜色已切换'), false, 1200);
  });
  $$('#hlColors .hl-dot')[0].classList.add('active');

  // 批量管理
  $('#btnBulkMode').addEventListener('click', () => setBulkMode(!state.bulkMode));
  $('#bulkExit').addEventListener('click', () => setBulkMode(false));
  $('#bulkDelete').addEventListener('click', deleteBulkSelected);
  $('#bulkAll').addEventListener('change', (e) => {
    state.bulkSelected = e.target.checked ? new Set(state.papers.map(p => p.id)) : new Set();
    updateBulkBar();
    renderLibrary();
  });

  // 目录侧边栏
  $('#btnOutline').addEventListener('click', () => setOutlineOpen($('#outlinePanel').classList.contains('hidden')));
  $('#btnOutlineClose').addEventListener('click', () => setOutlineOpen(false));

  // 阅读器：页码跳转
  $('#pageJumpInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const n = parseInt(e.target.value, 10);
    if (n >= 1) await viewer.jumpToPage(n);
    e.target.blur();
  });

  // 阅读器：护眼模式
  $('#btnEyeCare').addEventListener('click', () => {
    const on = !$('#readerView').classList.contains('eye-care');
    $('#readerView').classList.toggle('eye-care', on);
    $('#btnEyeCare').classList.toggle('on', on);
    localStorage.setItem('pg-eye-care', on ? '1' : '0');
  });

  // 阅读器：全文搜索
  $('#sideSearchInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); await runSearch(); }
    else if (e.key === 'ArrowDown' && searchState.results.length) { e.preventDefault(); await gotoSearchResult(Math.min(searchState.results.length - 1, searchState.index + 1)); }
    else if (e.key === 'ArrowUp' && searchState.results.length) { e.preventDefault(); await gotoSearchResult(Math.max(0, searchState.index - 1)); }
  });

  // 阅读器：滚动进度 + 当前页码联动 + 记忆阅读位置
  let progRaf = null;
  let lastPageTimer = null;
  $('#pdfScroll').addEventListener('scroll', () => {
    if (progRaf) return;
    progRaf = requestAnimationFrame(() => {
      progRaf = null;
      const el = $('#pdfScroll');
      if (viewer && state.view === 'reader' && document.activeElement !== $('#pageJumpInput')) {
        const cur = viewer.visiblePageNum();
        $('#pageJumpInput').value = cur;
        clearTimeout(lastPageTimer);
        lastPageTimer = setTimeout(() => {
          if (state.readerPaperId && state.view === 'reader' && cur >= 1) {
            bridge.updatePaper(state.readerPaperId, { lastPage: cur });
            const p = paperById(state.readerPaperId);
            if (p) p.lastPage = cur;
          }
        }, 800);
      }
    });
  });

  // 阅读器：Ctrl + 滚轮 / 触控板捏合缩放；按滚动幅度连续变化，并锁定鼠标下的内容。
  $('#pdfScroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !viewer || state.view !== 'reader') return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? $('#pdfScroll').clientHeight : 1);
    const factor = Math.max(0.8, Math.min(1.25, Math.exp(-e.deltaY * unit * 0.001)));
    viewer.zoom(factor, { clientX: e.clientX, clientY: e.clientY });
    updateZoomLabel();
  }, { passive: false });

  // 选中弹条
  $('#selPopup').addEventListener('mousedown', (e) => e.preventDefault());
  $$('#selPopup .hl-dot').forEach(b => b.addEventListener('click', () => {
    viewer.createHighlightFromSelection(b.dataset.color, false);
    renderAnnotList();
  }));
  $('#selComment').addEventListener('click', () => {
    viewer.createHighlightFromSelection(viewer.hlColor, true);
    renderAnnotList();
  });
  $('#selCopy').addEventListener('click', async () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      await navigator.clipboard.writeText(sel.toString());
      toast(t('已复制'), false, 1200);
    }
    $('#selPopup').classList.add('hidden');
  });

  // 便利贴弹窗
  $('#notePopupSave').addEventListener('click', () => { viewer.closeNotePopup(true); renderAnnotList(); });
  $('#notePopupCancel').addEventListener('click', () => viewer.closeNotePopup(false));
  $('#notePopupDelete').addEventListener('click', () => { viewer.deleteNoteEditing(); renderAnnotList(); });

  // 面板页签
  $$('.tabs .tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 信息
  $('#btnSaveMeta').addEventListener('click', saveMeta);
  $('#btnDeletePaper').addEventListener('click', deleteCurrentPaper);
  $('#btnOpenFolder').addEventListener('click', () => bridge.openPaperFolder(state.readerPaperId));

  // 笔记
  $('#btnNotesEdit').addEventListener('click', () => setNotesMode('edit'));
  $('#btnNotesPreview').addEventListener('click', () => setNotesMode('preview'));
  $('#notesEditor').addEventListener('input', onNotesInput);

  // 引用
  $('#btnFetchReferences').addEventListener('click', () => fetchReferencesFor(state.readerPaperId));
  $('#btnFetchCitations').addEventListener('click', () => fetchCitationsFor(state.readerPaperId));
  $('#btnAutoMatch').addEventListener('click', () => autoMatchFor(state.readerPaperId));
  $('#btnDlAllOut').addEventListener('click', () => {
    if (confirm(t('将逐条解析并下载全部「未入库参考文献」的开放获取 PDF（arXiv / OpenAlex OA）。\n下载的论文默认无评分，并自动与本文建立引用关联。开始吗？'))) downloadAllRefs('out');
  });
  $('#btnDlAllIn').addEventListener('click', () => {
    if (confirm(t('将逐条解析并下载全部「未入库被引文献」的开放获取 PDF（arXiv / OpenAlex OA）。\n下载的论文默认无评分，并自动与本文建立被引关联。开始吗？'))) downloadAllRefs('in');
  });

  // 排序方式
  $('#sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    localStorage.setItem('pg-sort', state.sort);
    renderLibrary();
  });

  // 图谱侧栏
  $('#graphSideClose').addEventListener('click', () => { $('#graphSide').classList.add('hidden'); graph.select(null); state.graphSelectedId = null; });
  $('#graphSideOpen').addEventListener('click', () => { if (state.graphSelectedId) openReader(state.graphSelectedId); });
  $('#graphSideFetch').addEventListener('click', () => { if (state.graphSelectedId) fetchRefsFor(state.graphSelectedId); });

  // 拖拽导入
  const dropHint = $('#dropHint');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    dropHint.classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropHint.classList.add('hidden');
    const files = [...e.dataTransfer.files].filter(f => /\.pdf$/i.test(f.name));
    if (!files.length) { toast(t('只支持 PDF 文件'), true); return; }
    toast(tf('正在导入 {n} 个 PDF…', { n: files.length }));
    if (isWeb) {
      const r = await bridge.importFiles(files);
      await handleImportResults(r.results);
    } else {
      const paths = files.map(f => bridge.pathForFile(f)).filter(Boolean);
      if (paths.length !== files.length) {
        // 退化方案：读 ArrayBuffer 走 URL 导入通道不可行，提示
        console.warn('pathForFile failed for some files');
      }
      const r = await bridge.importPaths(paths);
      await handleImportResults(r.results);
    }
  });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#importModal').classList.add('hidden');
      $('#libModal').classList.add('hidden');
      $('#libDeleteModal').classList.add('hidden');
      $('#linkModal').classList.add('hidden');
      $('#conflictModal').classList.add('hidden');
      $('#notePopup').classList.add('hidden');
      $('#selPopup').classList.add('hidden');
      setOutlineOpen(false);
      if (state.view === 'graph') { closeGraph(); return; }
      if (viewer && viewer.stickyMode) { viewer.setStickyMode(false); $('#btnStickyMode').classList.remove('on'); }
    }
    if (e.key === '+' && e.ctrlKey && state.view === 'reader') { e.preventDefault(); viewer.zoom(1.2); updateZoomLabel(); }
    if (e.key === '-' && e.ctrlKey && state.view === 'reader') { e.preventDefault(); viewer.zoom(1 / 1.2); updateZoomLabel(); }
    // Ctrl+F：打开阅读器内全文搜索
    if (e.key === 'f' && e.ctrlKey && state.view === 'reader') {
      e.preventDefault();
      switchTab('search');
      setTimeout(() => { $('#sideSearchInput').focus(); $('#sideSearchInput').select(); }, 60);
    }
    // 翻页与滚动（输入框聚焦时不拦截）
    if (state.view === 'reader' && !e.ctrlKey && !e.metaKey && !e.target.closest('input, textarea, select')) {
      const el = $('#pdfScroll');
      if (e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); el.scrollBy({ top: el.clientHeight * 0.9, behavior: 'smooth' }); }
      else if (e.key === 'PageUp') { e.preventDefault(); el.scrollBy({ top: -el.clientHeight * 0.9, behavior: 'smooth' }); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); el.scrollBy({ top: 60, behavior: 'smooth' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); el.scrollBy({ top: -60, behavior: 'smooth' }); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); viewer && viewer.jumpToPage(Math.max(1, viewer.visiblePageNum() - 1)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); viewer && viewer.jumpToPage(Math.min(viewer.pages.length, viewer.visiblePageNum() + 1)); }
      else if (e.key === 'Home') { e.preventDefault(); el.scrollTo({ top: 0, behavior: 'smooth' }); }
      else if (e.key === 'End') { e.preventDefault(); el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }
    }
  });

  // 点击其他地方隐藏选中弹条
  window.addEventListener('mousedown', (e) => {
    if (!$('#selPopup').contains(e.target) && !e.target.closest('.note-popup')) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) $('#selPopup').classList.add('hidden');
    }
    if (!e.target.closest('.note-popup') && !e.target.closest('.sticky-icon') && !e.target.closest('.annot-item') && !e.target.closest('.hl-box')) {
      if (!$('#notePopup').classList.contains('hidden')) viewer && viewer.closeNotePopup(true);
    }
  });
}

function switchTab(name) {
  $$('.tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-page').forEach(p => p.classList.add('hidden'));
  $('#tab-' + name).classList.remove('hidden');
}

/* ---------------- 启动 ---------------- */
async function init() {
  applyLanguage(getLang()); // 应用界面语言（含静态文案与动态区域）
  bindEvents();
  setLibSidebarCollapsed(localStorage.getItem('pg-lib-collapsed') === '1');
  await loadLibraries(); // 多论文库：载入列表与当前库
  if (isWeb) {
    // 浏览器预览模式：首次载入示例论文库
    await bridge.seedSamplesIfEmpty();
  }
  await refreshData();
  await updateAnnotCounts();
  renderLibrary();
  showView('library');

  // Agent API 等外部数据源变更时刷新界面
  if (bridge.onDataChanged) {
    let t = null;
    bridge.onDataChanged(() => {
      clearTimeout(t);
      t = setTimeout(async () => {
        await loadLibraries();
        await refreshData();
        await updateAnnotCounts();
        if (state.view === 'library') renderLibrary();
        else if (state.view === 'graph' && graph) applyGraphFilter();
        else if (state.view === 'reader' && state.readerPaperId) {
          const p = paperById(state.readerPaperId);
          if (p) { fillMetaForm(p); renderRefLists(); }
          state.annots = await bridge.listAnnotations(state.readerPaperId);
          if (viewer) { viewer.annotations = state.annots; viewer._renderAnnotations(); }
          renderAnnotList();
        }
      }, 250);
    });
  }

  // 抓取进度事件 → 进度条（含 Agent API 触发的抓取）
  if (bridge.onRefsProgress) {
    bridge.onRefsProgress((p) => {
      if (p.paperId !== state.readerPaperId || state.view !== 'reader') return;
      refsProgressUI.update(p);
    });
  }

  // 自测钩子
  if (new URLSearchParams(location.search).has('selftest')) {
    const { runSelftest } = await import('./selftest.js');
    runSelftest({ bridge, state, openReader, showView, refreshData, renderLibrary, refsOf, citesOf, toast });
  }
}

window.addEventListener('DOMContentLoaded', init);

// 暴露给自测
window.__pg = { state, get viewer() { return viewer; }, get graph() { return graph; }, refsProgressUI, resolveConflicts, bibtexOf, sim: { computeSimEdges, topSimilar, aggregateExternal } };
