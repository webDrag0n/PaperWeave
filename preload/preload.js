// PaperWeave preload：向渲染进程暴露受控 API
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('paperweave', {
  isElectron: true,
  libInfo: () => ipcRenderer.invoke('lib:info'),

  listPapers: () => ipcRenderer.invoke('papers:list'),
  getPaper: (id) => ipcRenderer.invoke('paper:get', id),
  updatePaper: (id, patch) => ipcRenderer.invoke('paper:update', id, patch),
  removePaper: (id, deleteFile) => ipcRenderer.invoke('paper:remove', id, deleteFile),
  readPaperBytes: async (id) => {
    const buf = await ipcRenderer.invoke('paper:readBytes', id);
    return buf ? new Uint8Array(buf) : null;
  },
  openPaperFolder: (id) => ipcRenderer.invoke('paper:openFolder', id),

  importDialog: () => ipcRenderer.invoke('papers:importDialog'),
  importPaths: (paths) => ipcRenderer.invoke('papers:importPaths', paths),
  importUrl: (url) => ipcRenderer.invoke('papers:importUrl', url),
  // 浏览器插件：连接信息 + 打开插件目录
  agentConnectionInfo: () => ipcRenderer.invoke('agent:connectionInfo'),
  openExtensionFolder: () => ipcRenderer.invoke('agent:openExtensionFolder'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return null; }
  },

  listAnnotations: (paperId) => ipcRenderer.invoke('ann:list', paperId),
  saveAnnotations: (paperId, anns) => ipcRenderer.invoke('ann:save', paperId, anns),

  listLinks: () => ipcRenderer.invoke('links:list'),
  addLink: (from, to, source) => ipcRenderer.invoke('link:add', from, to, source),
  removeLink: (id) => ipcRenderer.invoke('link:remove', id),

  fetchRefs: (paperId) => ipcRenderer.invoke('refs:fetch', paperId),
  fetchReferences: (paperId) => ipcRenderer.invoke('refs:fetchReferences', paperId),
  fetchCitations: (paperId) => ipcRenderer.invoke('refs:fetchCitations', paperId),
  autoMatchRefs: (paperId) => ipcRenderer.invoke('refs:autoMatch', paperId),
  downloadRef: (paperId, key) => ipcRenderer.invoke('refs:downloadRef', paperId, key),
  downloadAllRefs: (paperId, dir) => ipcRenderer.invoke('refs:downloadAllRefs', paperId, dir),

  // 多论文库
  listLibraries: () => ipcRenderer.invoke('libs:list'),
  createLibrary: (name, desc, icon) => ipcRenderer.invoke('libs:create', name, desc, icon),
  updateLibrary: (id, patch) => ipcRenderer.invoke('libs:update', id, patch),
  reorderLibraries: (ids) => ipcRenderer.invoke('libs:reorder', ids),
  switchLibrary: (id) => ipcRenderer.invoke('libs:switch', id),
  deleteLibrary: (id) => ipcRenderer.invoke('libs:delete', id),
  resolveImport: (token, action) => ipcRenderer.invoke('import:resolve', token, action),

  // Agent API 等外部变更通知
  onDataChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('data:changed', listener);
    return () => ipcRenderer.removeListener('data:changed', listener);
  },
  // 抓取进度事件
  onRefsProgress: (cb) => {
    const listener = (e, payload) => cb(payload);
    ipcRenderer.on('refs:progress', listener);
    return () => ipcRenderer.removeListener('refs:progress', listener);
  },

  // 自测钩子
  selftestReport: (report) => ipcRenderer.invoke('selftest:report', report),
  selftestSampleDir: () => ipcRenderer.invoke('selftest:sampleDir'),
  selftestShot: (name) => ipcRenderer.invoke('selftest:shot', name),
  selftestMakeVariant: (name) => ipcRenderer.invoke('selftest:makeVariant', name),
});
