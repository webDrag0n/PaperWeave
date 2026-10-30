// electron-builder 启动包装：
// 1. 在 Kimi(Electron) 托管的 node 环境下，process.versions.electron 会让 yargs
//    错误地少切一个参数，导致把 cli.js 自身当参数——先删除该标记。
// 2. 默认把构建输出放到系统临时目录，完成后只把发行物（安装包 / 便携版 / blockmap 等）
//    拷回 release/；免安装的 *-unpacked 目录留在临时目录并删除。
//    原因：工作区文件监听（Kimi / 编辑器等）会长期锁定 release/**/app.asar，
//    一旦 unpacked 目录落进工作区，下次构建就会因占用而失败。
//    需要免安装目录时：npm run pack（--dir），或显式传 -c.directories.output=...，
//    这两种情况原样透传给 electron-builder CLI。
if (process.versions && process.versions.electron) {
  try { delete process.versions.electron; } catch (_) { process.versions.electron = undefined; }
  // Electron 托管 node 的 fs 会把 *.asar 路径当压缩包拦截，导致 app.asar 写入时报
  // "Invalid package"；关闭 asar 拦截后再打包（electron-builder 在同一进程内写 asar）。
  try { process.noAsar = true; } catch (_) {}
}
const path = require('path');
const fs = require('fs');
const os = require('os');

const args = process.argv.slice(2);
if (args.includes('--dir') || args.some(a => a.startsWith('-c.directories.output'))) {
  require('electron-builder/out/cli/cli');
  return;
}

const builder = require('electron-builder');
const pkg = require('../package.json');

const platforms = [];
if (args.includes('--win')) platforms.push(builder.Platform.WINDOWS);
if (args.includes('--mac')) platforms.push(builder.Platform.MAC);
if (args.includes('--linux')) platforms.push(builder.Platform.LINUX);
if (!platforms.length) platforms.push(builder.Platform.current());

const archStr = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : null;
const targets = builder.createTargets(platforms, null, archStr);

const out0 = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paperweave-dist-'));
const releaseDir = path.join(__dirname, '..', 'release');

(async () => {
  // 工作区文件可能被宿主进程 / 编辑器 / MCP 进程短暂占用（copyfile EBUSY），
  // 做有限次退避重试；每次重试换一个新的临时输出目录，避免半成品残留。
  const maxTry = 6;
  let out = null;
  for (let attempt = 1; ; attempt++) {
    out = out0();
    const config = { ...pkg.build, directories: { ...(pkg.build.directories || {}), output: out } };
    if (attempt === 1) console.log('[build] 临时输出目录：' + out);
    try {
      await builder.build({ targets, projectDir: path.join(__dirname, '..'), config });
      break;
    } catch (e) {
      try { fs.rmSync(out, { recursive: true, force: true }); } catch (_) { /* 留待系统清理 */ }
      if (e && e.code === 'EBUSY' && attempt < maxTry) {
        const wait = 1500 * attempt;
        console.log(`[build] 文件被占用（${e.path || '?'}），${wait}ms 后重试（第 ${attempt + 1}/${maxTry} 次）…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  // 拷回发行物（不含 *-unpacked 目录）
  const artifacts = fs.readdirSync(out)
    .filter(f => !/^builder-(debug|effective)/i.test(f))
    .filter(f => /\.(exe|blockmap|AppImage|deb|rpm|dmg|zip|msi|yml|yaml)$/i.test(f));
  for (const f of artifacts) {
    fs.copyFileSync(path.join(out, f), path.join(releaseDir, f));
    console.log('[build] 已拷回 release/' + f);
  }
  try { fs.rmSync(out, { recursive: true, force: true }); }
  catch (_) { console.log('[build] 临时目录留待系统清理：' + out); }
  // 浏览器插件同步进 release/（目录 + zip）
  try { require('./pack-extension').packExtension(); }
  catch (e) { console.log('[build] 插件打包跳过：' + e.message); }
  console.log('[build] 完成');
})().catch(e => { console.error(e); process.exit(1); });
