// PaperWeave 数据存储（0.8.0 多论文库架构）：
//   data.json              应用级：{ agentToken, agentPort, libraries[], currentLibraryId }
//   papers.json            全局论文注册表：每篇论文唯一 id（元数据/评星/笔记/未入库引用都在这里）
//   annotations.json       全局批注：{ paperId: [...] }
//   libraries/<id>.json    论文库：{ id, name, paperIds[], links[] }（关联属于库视角）
//   library/*.pdf          统一大文件存储（内容 hash 命名，多库共享，不重复占盘）
const fs = require('fs');
const path = require('path');
const { reconcileYear } = require('./pubyear');

class Store {
  // opts.libraryDir：PDF 文件目录（可由用户另行指定）；缺省为 <rootDir>/library
  constructor(rootDir, opts = {}) {
    this.rootDir = rootDir;                       // 数据目录，缺省 userData/paperweave-data
    this.libraryDir = opts.libraryDir || path.join(rootDir, 'library'); // PDF 文件库（全局共享）
    this.libsDir = path.join(rootDir, 'libraries');
    this.dataFile = path.join(rootDir, 'data.json');
    this.papersFile = path.join(rootDir, 'papers.json');
    this.annotsFile = path.join(rootDir, 'annotations.json');
    fs.mkdirSync(this.libraryDir, { recursive: true });
    fs.mkdirSync(this.libsDir, { recursive: true });
    this.meta = { libraries: [], currentLibraryId: null };  // data.json
    this.papers = [];                                // 全局论文注册表
    this.annotations = {};                           // 全局批注
    this._libsCache = new Map();                     // libId → { id, name, paperIds, links }
    this._load();
    if (!opts.libraryDir && typeof this.meta.libraryDir === 'string' && this.meta.libraryDir) {
      this.libraryDir = this.meta.libraryDir;
      fs.mkdirSync(this.libraryDir, { recursive: true });
    }
  }

  /* ---------------- 加载与迁移 ---------------- */
  _readJson(file, fallback) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return raw && typeof raw === 'object' ? raw : fallback;
      }
    } catch (e) {
      try { fs.copyFileSync(file, file + '.broken-' + Date.now()); } catch (_) {}
    }
    return fallback;
  }

  _load() {
    const meta = this._readJson(this.dataFile, null);
    if (meta && Array.isArray(meta.papers)) {
      // ---- 旧单库结构迁移（0.7.x 及之前） ----
      this.papers = meta.papers;
      this.annotations = meta.annotations && typeof meta.annotations === 'object' ? meta.annotations : {};
      const lib = { id: 'lib_default', name: 'New Weave', paperIds: this.papers.map(p => p.id), links: Array.isArray(meta.links) ? meta.links : [], createdAt: Date.now() };
      this.meta = {
        agentToken: meta.agentToken,
        agentPort: meta.agentPort,
        libraries: [{ id: lib.id, name: lib.name, desc: '', pinned: false, createdAt: lib.createdAt }],
        currentLibraryId: lib.id,
      };
      this._libsCache.set(lib.id, lib);
      this.saveMeta();
      this.savePapers();
      this.saveAnnots();
      this._saveLib(lib);
      try { fs.renameSync(this.dataFile, this.dataFile + '.migrated-' + Date.now()); } catch (_) {}
      return;
    }
    // ---- 新结构 ----
    this.meta = meta || {};
    if (!Array.isArray(this.meta.libraries)) this.meta.libraries = [];
    const papersData = this._readJson(this.papersFile, { papers: [] });
    this.papers = Array.isArray(papersData.papers) ? papersData.papers : [];
    const anns = this._readJson(this.annotsFile, { annotations: {} });
    this.annotations = anns.annotations && typeof anns.annotations === 'object' ? anns.annotations : {};
    // 首个库自动创建（任何语言下默认名都是 "New Weave"）
    if (!this.meta.libraries.length) {
      const lib = { id: 'lib_default', name: 'New Weave', desc: '', pinned: false, createdAt: Date.now() };
      this.meta.libraries = [{ id: lib.id, name: lib.name, desc: '', pinned: false, createdAt: lib.createdAt }];
      this.meta.currentLibraryId = lib.id;
      this.saveMeta();
    }
    if (!this.meta.libraries.some(l => l.id === this.meta.currentLibraryId)) {
      this.meta.currentLibraryId = this.meta.libraries[0].id;
      this.saveMeta();
    }
    // 字段迁移：rating / externalRefs
    for (const p of this.papers) {
      if (typeof p.rating !== 'number') p.rating = 1;
      if (!Array.isArray(p.externalRefs)) p.externalRefs = [];
    }
    // 一次性修复：1.3.0 及之前把正文里第一个四位数字当成年份（1945、2048……）。
    // arXiv 论文按编号年份校正，其余只清除不可能的未来年份；修复后用户手工修改不再被覆盖。
    if (this.meta.yearRepair !== 1) {
      let changed = false;
      for (const p of this.papers) {
        const fixed = reconcileYear(p.year, p.doi);
        if (fixed !== String(p.year === undefined || p.year === null ? '' : p.year).trim()) {
          p.year = fixed;
          changed = true;
        }
      }
      this.meta.yearRepair = 1;
      if (changed) this.savePapers();
      this.saveMeta();
    }
  }

  /* ---------------- 落盘 ---------------- */
  _atomicWrite(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  }
  saveMeta() { this._atomicWrite(this.dataFile, this.meta); }
  savePapers() { this._atomicWrite(this.papersFile, { papers: this.papers }); }
  saveAnnots() { this._atomicWrite(this.annotsFile, { annotations: this.annotations }); }
  _libFile(libId) { return path.join(this.libsDir, libId + '.json'); }
  _saveLib(lib) { this._atomicWrite(this._libFile(lib.id), lib); }
  // 兼容旧调用点（service/agent-api 里 store.save()）
  save() { this.saveMeta(); this.savePapers(); this.saveAnnots(); }

  _lib(libId) {
    const id = libId || this.meta.currentLibraryId;
    if (this._libsCache.has(id)) return this._libsCache.get(id);
    const raw = this._readJson(this._libFile(id), null);
    const lib = raw && Array.isArray(raw.paperIds)
      ? raw
      : { id, name: (this.meta.libraries.find(l => l.id === id) || {}).name || id, paperIds: [], links: [] };
    if (!Array.isArray(lib.links)) lib.links = [];
    this._libsCache.set(id, lib);
    return lib;
  }

  /* ---------------- 论文库管理 ---------------- */
  listLibraries() {
    return this.meta.libraries.map(l => {
      const lib = this._lib(l.id);
      return { id: l.id, name: l.name, desc: l.desc || '', icon: l.icon || '', pinned: !!l.pinned, createdAt: l.createdAt, paperCount: lib.paperIds.length, linkCount: lib.links.length };
    });
  }
  currentLibraryId() { return this.meta.currentLibraryId; }
  getLibrary(id) { return this.meta.libraries.find(l => l.id === id) || null; }
  createLibrary(name, desc, icon) {
    const ic = (typeof icon === 'string' ? icon : '').trim().slice(0, 8);
    const lib = { id: 'lib_' + Math.random().toString(36).slice(2, 10), name: name || 'New Weave', desc: desc || '', icon: ic, pinned: false, createdAt: Date.now() };
    this.meta.libraries.push({ id: lib.id, name: lib.name, desc: lib.desc, icon: ic, pinned: false, createdAt: lib.createdAt });
    this._libsCache.set(lib.id, { id: lib.id, name: lib.name, paperIds: [], links: [] });
    this.saveMeta();
    this._saveLib(this._libsCache.get(lib.id));
    return lib;
  }
  // 更新名称 / 简介 / 图标 / 置顶
  updateLibrary(id, patch) {
    const m = this.getLibrary(id);
    if (!m) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) m.name = patch.name.trim();
    if (typeof patch.desc === 'string') m.desc = patch.desc;
    if (typeof patch.icon === 'string') m.icon = patch.icon.trim().slice(0, 8);
    if (typeof patch.pinned === 'boolean') m.pinned = patch.pinned;
    const lib = this._lib(id);
    lib.name = m.name;
    this.saveMeta();
    this._saveLib(lib);
    return m;
  }
  // 拖拽排序：按给定 id 顺序重排
  reorderLibraries(ids) {
    if (!Array.isArray(ids)) return false;
    const byId = new Map(this.meta.libraries.map(l => [l.id, l]));
    const next = [];
    for (const id of ids) if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); }
    for (const l of byId.values()) next.push(l); // 防御：未覆盖的排到最后
    this.meta.libraries = next;
    this.saveMeta();
    return true;
  }
  setCurrentLibrary(id) {
    if (!this.getLibrary(id)) return false;
    this.meta.currentLibraryId = id;
    this.saveMeta();
    return true;
  }
  // 删除论文库：库内关联随之删除；论文本体保留在全局注册表（可被其他库/再次导入复用）
  deleteLibrary(id) {
    if (!this.getLibrary(id)) return false;
    if (this.meta.libraries.length <= 1) return false; // 至少保留一个库
    this.meta.libraries = this.meta.libraries.filter(l => l.id !== id);
    this._libsCache.delete(id);
    try { fs.unlinkSync(this._libFile(id)); } catch (_) {}
    if (this.meta.currentLibraryId === id) this.meta.currentLibraryId = this.meta.libraries[0].id;
    this.saveMeta();
    return true;
  }
  paperInLibraries(paperId) {
    const out = [];
    for (const l of this.meta.libraries) {
      if (this._lib(l.id).paperIds.includes(paperId)) out.push(l.id);
    }
    return out;
  }

  /* ---------------- papers（全局注册表） ---------- */
  listPapers(libId) {
    const lib = this._lib(libId);
    return lib.paperIds.map(id => this.getPaper(id)).filter(Boolean).map(p => ({ ...p, refText: undefined }));
  }
  // 全局注册表里的全部论文（不限于某个论文库），每篇附带所属库 libraryIds（可能为空：所属库已被删除）
  listAllPapers() {
    const membership = new Map();
    for (const l of this.meta.libraries) {
      for (const id of this._lib(l.id).paperIds) {
        if (!membership.has(id)) membership.set(id, []);
        membership.get(id).push(l.id);
      }
    }
    return this.papers.map(p => ({ ...p, refText: undefined, libraryIds: membership.get(p.id) || [] }));
  }
  getPaper(id) { return this.papers.find(p => p.id === id) || null; }
  findByHash(hash) { return this.papers.find(p => p.hash === hash) || null; }
  findByDoi(doi) {
    if (!doi) return null;
    const norm = String(doi).replace(/^arxiv:/i, '').toLowerCase();
    return this.papers.find(p => p.doi && String(p.doi).replace(/^arxiv:/i, '').toLowerCase() === norm) || null;
  }
  addPaper(paper, libId) {
    this.papers.push(paper);
    this._lib(libId).paperIds.push(paper.id);
    this.savePapers();
    this._saveLib(this._lib(libId));
    return paper;
  }
  // 把全局已有论文加入指定库（复用 id，不重复存储）
  addToLibrary(paperId, libId) {
    const lib = this._lib(libId);
    if (!lib.paperIds.includes(paperId)) {
      lib.paperIds.push(paperId);
      this._saveLib(lib);
    }
    return true;
  }
  updatePaper(id, patch) {
    const p = this.getPaper(id);
    if (!p) return null;
    const allowed = ['title', 'authors', 'year', 'doi', 'abstract', 'tags', 'venue', 'notes', 'refText', 'referencesRaw', 'favorite', 'lastPage', 'rating', 'externalRefs'];
    for (const k of allowed) if (k in patch) p[k] = patch[k];
    if ('rating' in patch) {
      const r = Math.round(Number(patch.rating));
      p.rating = Number.isFinite(r) ? Math.max(0, Math.min(5, r)) : 0;
    }
    p.updatedAt = Date.now();
    this.savePapers();
    return p;
  }
  // 从当前库移除；若不再属于任何库 → 彻底删除（全局记录 + 批注 + 可选 PDF 文件）
  removePaper(id, deleteFile, libId) {
    const p = this.getPaper(id);
    if (!p) return false;
    const lib = this._lib(libId);
    lib.paperIds = lib.paperIds.filter(x => x !== id);
    lib.links = lib.links.filter(l => l.from !== id && l.to !== id);
    this._saveLib(lib);
    if (this.paperInLibraries(id).length === 0) {
      if (deleteFile && p.file) {
        try { fs.unlinkSync(path.join(this.libraryDir, p.file)); } catch (_) {}
      }
      this.papers = this.papers.filter(x => x.id !== id);
      delete this.annotations[id];
      this.savePapers();
      this.saveAnnots();
    }
    return true;
  }
  // 彻底删除：从所有论文库移除（连同各库内的关联）并删除全局记录、批注与可选的 PDF 文件
  purgePaper(id, deleteFile) {
    const p = this.getPaper(id);
    if (!p) return false;
    for (const l of this.meta.libraries) {
      const lib = this._lib(l.id);
      if (!lib.paperIds.includes(id) && !lib.links.some(k => k.from === id || k.to === id)) continue;
      lib.paperIds = lib.paperIds.filter(x => x !== id);
      lib.links = lib.links.filter(k => k.from !== id && k.to !== id);
      this._saveLib(lib);
    }
    if (deleteFile && p.file) {
      try { fs.unlinkSync(path.join(this.libraryDir, p.file)); } catch (_) {}
    }
    this.papers = this.papers.filter(x => x.id !== id);
    delete this.annotations[id];
    this.savePapers();
    this.saveAnnots();
    return true;
  }
  paperFilePath(paper) {
    return paper && paper.file ? path.join(this.libraryDir, paper.file) : null;
  }
  // 切换 PDF 目录：复制已有文件后立即使用新目录；原文件保留，已存在的同名哈希文件不覆盖。
  useLibraryDir(targetDir) {
    const target = path.resolve(targetDir);
    if (target === path.resolve(this.libraryDir)) return this.libraryDir;
    fs.mkdirSync(target, { recursive: true });
    for (const p of this.papers) {
      if (!p.file) continue;
      const src = path.join(this.libraryDir, p.file);
      const dest = path.join(target, p.file);
      if (fs.existsSync(src) && !fs.existsSync(dest)) fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    }
    this.libraryDir = target;
    this.meta.libraryDir = target;
    this.saveMeta();
    return target;
  }
  // 为更改数据目录制作一致副本。绝不覆盖目标中的已有 PaperWeave 数据。
  copyDataTo(targetDir) {
    const target = path.resolve(targetDir);
    if (target === path.resolve(this.rootDir)) return this.rootDir;
    const protectedFiles = ['data.json', 'papers.json', 'annotations.json', 'libraries'];
    if (protectedFiles.some(name => fs.existsSync(path.join(target, name)))) {
      throw new Error('目标目录已有 PaperWeave 数据，请选择空目录，以免覆盖现有论文库');
    }
    this.meta.libraryDir = this.libraryDir;
    this.saveMeta();
    this.savePapers();
    this.saveAnnots();
    fs.mkdirSync(target, { recursive: true });
    for (const name of protectedFiles.slice(0, 3)) fs.copyFileSync(path.join(this.rootDir, name), path.join(target, name), fs.constants.COPYFILE_EXCL);
    fs.mkdirSync(path.join(target, 'libraries'), { recursive: true });
    for (const l of this.meta.libraries) {
      this._saveLib(this._lib(l.id));
      fs.copyFileSync(this._libFile(l.id), path.join(target, 'libraries', path.basename(this._libFile(l.id))), fs.constants.COPYFILE_EXCL);
    }
    return target;
  }

  /* ---------------- links（当前库视角，from 引用 to） ---------- */
  listLinks(libId) { return this._lib(libId).links; }
  // 全局视图合并各库关系；同一对论文只显示一次，并保留可逐库解除的原始 id。
  listAllLinks() {
    const byPair = new Map();
    for (const l of this.meta.libraries) {
      for (const link of this._lib(l.id).links) {
        const key = link.from + '\0' + link.to;
        const origin = { id: link.id, libraryId: l.id };
        if (byPair.has(key)) byPair.get(key).libraryLinks.push(origin);
        else byPair.set(key, { ...link, libraryId: l.id, libraryLinks: [origin] });
      }
    }
    return [...byPair.values()];
  }
  addLink(from, to, source, libId) {
    if (from === to) return null;
    const lib = this._lib(libId);
    const exist = lib.links.find(l => l.from === from && l.to === to);
    if (exist) return exist;
    const link = { id: 'lk_' + Math.random().toString(36).slice(2, 10), from, to, source: source || 'manual', createdAt: Date.now() };
    lib.links.push(link);
    this._saveLib(lib);
    return link;
  }
  removeLink(id, libId) {
    const lib = this._lib(libId);
    const idx = lib.links.findIndex(l => l.id === id);
    if (idx < 0) return false;
    lib.links.splice(idx, 1);
    this._saveLib(lib);
    return true;
  }

  /* ---------------- annotations（全局，按论文 id） ---------- */
  getAnnotations(paperId) { return this.annotations[paperId] || []; }
  setAnnotations(paperId, anns) {
    this.annotations[paperId] = Array.isArray(anns) ? anns : [];
    this.saveAnnots();
    return this.annotations[paperId];
  }

  /* ---------------- 未入库外部引用（随论文全局保存） ---------- */
  setExternalRefs(id, dir, items) {
    const p = this.getPaper(id);
    if (!p) return null;
    if (!Array.isArray(p.externalRefs)) p.externalRefs = [];
    // 重新抓取会整体替换该方向的条目；同一条目上一次的下载失败记录要带过来
    const failures = new Map(p.externalRefs.filter(r => r.dir === dir && r.downloadError).map(r => [r.key, r]));
    const next = (items || []).map(r => {
      const old = failures.get(r.key);
      return old && !r.downloadError ? { ...r, downloadError: old.downloadError, downloadTriedAt: old.downloadTriedAt } : r;
    });
    p.externalRefs = p.externalRefs.filter(r => r.dir !== dir).concat(next);
    p.updatedAt = Date.now();
    this.savePapers();
    return p.externalRefs;
  }
  // 记录某条未入库引用的下载失败原因（下载成功后条目本身会被移除，无需清除）
  setExternalRefError(id, key, error) {
    const p = this.getPaper(id);
    const ref = p && Array.isArray(p.externalRefs) ? p.externalRefs.find(r => r.key === key) : null;
    if (!ref) return false;
    ref.downloadError = String(error || '下载失败').slice(0, 500);
    ref.downloadTriedAt = Date.now();
    this.savePapers();
    return true;
  }
  removeExternalRef(id, key) {
    const p = this.getPaper(id);
    if (!p || !Array.isArray(p.externalRefs)) return;
    p.externalRefs = p.externalRefs.filter(r => r.key !== key);
    p.updatedAt = Date.now();
    this.savePapers();
  }

  // 兼容旧代码对 store.data.papers / store.data.links 的只读访问（agent-api / service）
  get data() {
    return {
      papers: this.listPapers().map(p => this.getPaper(p.id)),
      links: this.listLinks(),
      annotations: this.annotations,
      agentToken: this.meta.agentToken,
      agentPort: this.meta.agentPort,
    };
  }
}

module.exports = { Store };
