// PaperGraph 自测运行器：隐藏窗口启动 Electron，跑完整用户场景
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const electron = process.env.PAPERGRAPH_TEST_EXE || require('electron');
const outFile = path.join(ROOT, 'selftest-report.json');
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PAPERGRAPH_SELFTEST = '1';
env.PAPERGRAPH_SELFTEST_OUT = outFile;
env.PAPERGRAPH_SAMPLE_DIR = path.join(ROOT, 'assets', 'samples');
env.PAPERGRAPH_SHOT_DIR = path.join(ROOT, 'shots');
fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const testDataDir = path.join(ROOT, '.selftest-data');
fs.rmSync(testDataDir, { recursive: true, force: true });

const child = spawn(electron, ['.', '--no-sandbox', '--user-data-dir=' + testDataDir], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
child.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
child.stderr.on('data', d => process.stderr.write(d));

const killer = setTimeout(() => {
  console.error('SELFTEST TIMEOUT');
  child.kill();
  process.exit(2);
}, 150000);

child.on('close', (code) => {
  clearTimeout(killer);
  // 清理可能残留的子进程树（便携版 wrapper 会派生孙进程）
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
  if (!fs.existsSync(outFile)) {
    console.error('自测未产出报告，退出码=' + code);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  console.log('\n===== 自测结果 =====');
  for (const r of report.results) {
    console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? '  (' + r.detail.replace(/\n/g, ' ') + ')' : ''}`);
  }
  console.log(`通过 ${report.passed}/${report.total}`);
  process.exit(report.ok ? 0 : 1);
});
