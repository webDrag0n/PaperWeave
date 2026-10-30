// PaperWeave 主进程入口
const { app, BrowserWindow, ipcMain, dialog, shell, net, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { createService } = require('./service');
const { startAgentApi, writeConnectionInfo } = require('./agent-api');

// ES Module 需要通过标准 scheme 加载（file:// 下 module/CORS 受限）
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const SELFTEST = process.env.PAPERWEAVE_SELFTEST === '1';
const HEADLESS = process.env.PAPERWEAVE_HEADLESS === '1';
let store = null;
let service = null;
let mainWindow = null;
let agentServer = null;
// 抓取进度（内存态，HTTP API 供 Agent 轮询）
const refsProgress = new Map();

function notifyChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data:changed');
}

function progressEmitter(paperId) {
  // 节流转发到渲染进程（10Hz），避免抓取/下载高频进度把 IPC 打满导致界面卡顿
  let lastSent = 0;
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending) {
      mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('refs:progress', { paperId, ...pending });
      pending = null;
      lastSent = Date.now();
    }
  };
  return (p) => {
    refsProgress.set(paperId, { ...p, at: Date.now() });
    pending = p;
    if (Date.now() - lastSent >= 100) flush();
    else if (!timer) timer = setTimeout(flush, 100);
  };
}

// 便携版 exe 的真实目录（portable 构建会设置 PORTABLE_EXECUTABLE_DIR；否则退回 execPath 目录）
function portableExeDir() {
  if (!app.isPackaged) return null;
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

// 把 Agent 配套文件（AGENTS.md、MCP Server）放到 exe 同目录
// （便携版即用户要求的"同文件夹"），失败静默（如 Program Files 无写权限）
function placeAgentsDoc() {
  const files = ['AGENTS.md', 'paperweave-mcp.js'];
  for (const name of files) {
    try {
      const src = app.isPackaged
        ? path.join(process.resourcesPath, name)
        : path.join(app.getAppPath(), name === 'AGENTS.md' ? path.join('agents', name) : path.join('mcp', name));
      if (!fs.existsSync(src)) continue;
      const dest = path.join(portableExeDir(), name);
      if (path.normalize(src) !== path.normalize(dest)) fs.copyFileSync(src, dest);
    } catch (_) {}
  }
}

async function startAgentInterface() {
  if (process.env.PAPERWEAVE_AGENT_API === '0') return;
  // 令牌持久化在应用级元数据中，同一安装保持稳定
  if (!store.meta.agentToken) {
    store.meta.agentToken = crypto.randomBytes(16).toString('hex');
    store.saveMeta();
  }
  const token = store.meta.agentToken;
  const started = await startAgentApi({
    store,
    service,
    token,
    appVersion: app.getVersion(),
    onChanged: notifyChanged,
    refsProgress,
    onProgress: progressEmitter,
  });
  if (!started) return;
  agentServer = started.server;
  store.meta.agentPort = started.port;
  store.saveMeta();
  const exeDir = portableExeDir();
  const written = writeConnectionInfo({
    dataDir: store.rootDir,
    exeDir,
    port: started.port,
    token,
    version: app.getVersion(),
  });
  console.log('PaperWeave Agent API listening on http://127.0.0.1:' + started.port, 'info files:', written.join(', '));
}

function registerIpc() {
  ipcMain.handle('lib:info', () => ({
    libraryDir: store.libraryDir,
    dataDir: store.rootDir,
    platform: process.platform,
    version: app.getVersion(),
    agentApi: store.data.agentToken ? `http://127.0.0.1:${store.data.agentPort || 24680}` : null,
  }));

  // 浏览器插件连接信息（地址 + 令牌），供「浏览器插件」弹窗展示与复制
  ipcMain.handle('agent:connectionInfo', () => ({
    baseUrl: store.meta.agentToken ? `http://127.0.0.1:${store.meta.agentPort || 24680}` : null,
    port: store.meta.agentPort || null,
    token: store.meta.agentToken || null,
    extensionDir: app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(app.getAppPath(), 'extension'),
  }));
  // 在系统文件管理器中打开浏览器插件目录（加载已解压扩展用）
  ipcMain.handle('agent:openExtensionFolder', async () => {
    const dir = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(app.getAppPath(), 'extension');
    if (!fs.existsSync(dir)) return false;
    const err = await shell.openPath(dir);
    return !err;
  });

  ipcMain.handle('papers:list', () => store.listPapers());
  ipcMain.handle('paper:get', (e, id) => {
    const p = store.getPaper(id);
    return p ? { ...p } : null;
  });
  ipcMain.handle('paper:update', (e, id, patch) => {
    const p = store.updatePaper(id, patch || {});
    return p ? { ...p, refText: undefined } : null;
  });
  ipcMain.handle('paper:remove', (e, id, deleteFile) => store.removePaper(id, !!deleteFile));
  ipcMain.handle('paper:readBytes', async (e, id) => {
    const p = store.getPaper(id);
    const fp = store.paperFilePath(p);
    if (!fp || !fs.existsSync(fp)) return null;
    const buf = fs.readFileSync(fp);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  ipcMain.handle('paper:openFolder', async (e, id) => {
    const p = store.getPaper(id);
    const fp = store.paperFilePath(p);
    if (fp) shell.showItemInFolder(fp);
  });

  ipcMain.handle('papers:importDialog', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的 PDF 论文（可多选）',
      filters: [{ name: 'PDF 论文', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true, results: [] };
    return { canceled: false, results: await service.importFromPaths(r.filePaths) };
  });
  ipcMain.handle('papers:importPaths', async (e, paths) => ({ canceled: false, results: await service.importFromPaths(paths) }));
  ipcMain.handle('papers:importUrl', async (e, url) => {
    try {
      return { ok: true, ...(await service.importFromUrl(url)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('ann:list', (e, paperId) => store.getAnnotations(paperId));
  ipcMain.handle('ann:save', (e, paperId, anns) => store.setAnnotations(paperId, anns));

  ipcMain.handle('links:list', () => store.listLinks());
  ipcMain.handle('link:add', (e, from, to, source) => store.addLink(from, to, source));
  ipcMain.handle('link:remove', (e, id) => store.removeLink(id));

  // 多论文库
  ipcMain.handle('libs:list', () => ({ current: store.currentLibraryId(), libraries: store.listLibraries() }));
  ipcMain.handle('libs:create', (e, name, desc, icon) => { const lib = store.createLibrary(name, desc, icon); notifyChanged(); return lib; });
  ipcMain.handle('libs:update', (e, id, patch) => { const r = store.updateLibrary(id, patch || {}); notifyChanged(); return r; });
  ipcMain.handle('libs:reorder', (e, ids) => { const r = store.reorderLibraries(ids); notifyChanged(); return r; });
  ipcMain.handle('libs:switch', (e, id) => { const ok = store.setCurrentLibrary(id); if (ok) notifyChanged(); return ok; });
  ipcMain.handle('libs:delete', (e, id) => { const ok = store.deleteLibrary(id); if (ok) notifyChanged(); return ok; });

  // 导入冲突确认
  ipcMain.handle('import:resolve', (e, token, action) => service.resolveImport(token, action));

  ipcMain.handle('refs:fetch', (e, paperId) => service.fetchRefs(paperId, progressEmitter(paperId)));
  ipcMain.handle('refs:fetchReferences', (e, paperId) => service.fetchReferences(paperId, progressEmitter(paperId)));
  ipcMain.handle('refs:fetchCitations', (e, paperId) => service.fetchCitations(paperId, progressEmitter(paperId)));
  ipcMain.handle('refs:autoMatch', (e, paperId) => service.autoMatch(paperId));
  ipcMain.handle('refs:downloadRef', async (e, paperId, key) => {
    try { return await service.downloadRef(paperId, key, progressEmitter(paperId)); }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('refs:downloadAllRefs', async (e, paperId, dir) => {
    try { return await service.downloadAllRefs(paperId, dir, progressEmitter(paperId)); }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    show: !HEADLESS,
    title: 'PaperWeave',
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('app://paperweave/renderer/index.html' + (SELFTEST ? '?selftest=1' : ''));
  if (SELFTEST) {
    mainWindow.webContents.on('console-message', (e, level, msg) => console.log('[renderer]', msg));
    mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[main] did-fail-load', code, desc, url));
  }
}

app.whenReady().then(async () => {
  // app://paperweave/<path> → 应用目录静态资源
  protocol.handle('app', (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname);
      if (!p || p === '/') p = '/renderer/index.html';
      const file = path.normalize(path.join(app.getAppPath(), p));
      if (!file.startsWith(path.normalize(app.getAppPath()))) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(file).toString());
    } catch (e) {
      return new Response('bad request', { status: 400 });
    }
  });
  // 品牌更名 PaperGraph → PaperWeave：首次启动时迁移旧数据目录，老用户不丢库
  try {
    const newRoot = path.join(app.getPath('userData'), 'paperweave-data');
    const legacyRoot = path.join(path.dirname(app.getPath('userData')), 'papergraph', 'papergraph-data');
    if (!fs.existsSync(newRoot) && fs.existsSync(legacyRoot)) fs.renameSync(legacyRoot, newRoot);
  } catch (_) { /* 迁移失败不影响全新启动 */ }
  store = new Store(path.join(app.getPath('userData'), 'paperweave-data'));
  service = createService(store, { progressFor: (id) => progressEmitter(id) });
  registerIpc();
  placeAgentsDoc();
  await startAgentInterface();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (agentServer) { try { agentServer.close(); } catch (_) {} }
});

// 自测模式：渲染进程跑完用例后回写结果
if (SELFTEST) {
  ipcMain.handle('selftest:report', (e, report) => {
    const out = process.env.PAPERWEAVE_SELFTEST_OUT || path.join(app.getPath('temp'), 'paperweave-selftest.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log('SELFTEST_DONE ' + out);
    setTimeout(() => { app.exit(report && report.ok ? 0 : 1); }, 300);
    return true;
  });
  ipcMain.handle('selftest:sampleDir', () => process.env.PAPERWEAVE_SAMPLE_DIR || null);
  // 自测辅助：复制样例 PDF 并追加注释字节（内容 hash 不同但提取的 DOI 相同），用于导入冲突用例
  ipcMain.handle('selftest:makeVariant', (e, name) => {
    try {
      const dir = process.env.PAPERWEAVE_SAMPLE_DIR;
      const src = path.join(dir, name);
      const dst = path.join(app.getPath('temp'), '.pg-variant-' + name);
      const buf = fs.readFileSync(src);
      fs.writeFileSync(dst, Buffer.concat([buf, Buffer.from('\n% selftest variant')]));
      return dst;
    } catch (_) { return null; }
  });
  ipcMain.handle('selftest:shot', async (e, name) => {
    try {
      mainWindow.setAlwaysOnTop(true);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      await new Promise(r => setTimeout(r, 400));
      const img = await mainWindow.webContents.capturePage();
      const dir = process.env.PAPERWEAVE_SHOT_DIR || app.getPath('temp');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
      mainWindow.setAlwaysOnTop(false);
      return true;
    } catch (err) {
      console.log('[main] shot failed:', name, err.message);
      return false;
    }
  });
}
