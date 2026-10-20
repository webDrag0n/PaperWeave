// PaperGraph 浏览器预览模式开发服务器（npm run dev）
// 仅用于预览 UI/联调网页桥接层；桌面功能请用 npm start（Electron）
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function argVal(name, dflt) {
  const i = argv.findIndex(a => a === name || a.startsWith(name + '='));
  if (i < 0) return dflt;
  const a = argv[i];
  return a.includes('=') ? a.split('=')[1] : (argv[i + 1] || dflt);
}
const PORT = parseInt(process.env.PORT || argVal('--port', '7100'), 10);
const HOST = process.env.HOST || argVal('--host', '127.0.0.1');
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') {
    // 重定向到真实路径，保证页面内相对资源正确解析
    res.writeHead(302, { Location: '/renderer/index.html' });
    res.end();
    return;
  }
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`PaperGraph preview: http://${HOST}:${PORT}/`);
});
