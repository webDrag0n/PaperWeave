// 把浏览器插件打包进 release/：
//   1. 整目录拷贝为 release/extension/（Chrome/Edge「加载解压缩的扩展」直接选用）
//   2. 尽力打成 release/PaperWeave-Connector-<version>.zip（便于分发；无 zip 工具时跳过）
// 用法：node tools/pack-extension.js（构建脚本会在打包完成后自动调用）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function packExtension() {
  const pkg = require('../package.json');
  const releaseDir = path.join(ROOT, 'release');
  if (!fs.existsSync(SRC)) { console.log('[ext] 未找到 extension/，跳过'); return false; }
  fs.mkdirSync(releaseDir, { recursive: true });

  // 1. 目录拷贝（先清后拷，避免旧文件残留）
  const destDir = path.join(releaseDir, 'extension');
  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
  copyDir(SRC, destDir);
  console.log('[ext] 已拷入 release/extension/');

  // 2. zip 分发包（尽力而为）
  const zipName = `PaperWeave-Connector-${pkg.version}.zip`;
  const zipPath = path.join(releaseDir, zipName);
  try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
  let ok = false;
  try {
    if (process.platform === 'win32') {
      // PowerShell Compress-Archive；通配符必须走 -Path（-LiteralPath 不展开 *）
      const ps = [
        'Compress-Archive', '-Path', JSON.stringify(path.join(SRC, '*')),
        '-DestinationPath', JSON.stringify(zipPath), '-Force',
      ].join(' ');
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
      ok = r.status === 0 && fs.existsSync(zipPath);
    } else {
      const r = spawnSync('zip', ['-qr', zipPath, '.'], { cwd: SRC, stdio: 'ignore' });
      ok = r.status === 0 && fs.existsSync(zipPath);
    }
  } catch (_) { ok = false; }
  console.log(ok ? '[ext] 已生成 release/' + zipName : '[ext] zip 生成失败（不影响目录形式使用），已跳过');
  return true;
}

if (require.main === module) packExtension();
module.exports = { packExtension };
