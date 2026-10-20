// 线上验证抓取进度端点：后台触发 Zero-WAM 参考文献抓取，轮询进度
const http = require('http');
const fs = require('fs');
const path = require('path');

const info = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, 'papergraph', 'papergraph-data', 'agent-api.json'), 'utf-8'));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(info.baseUrl + p);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', 'X-PaperGraph-Token': info.token },
      timeout: 180000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const papers = (await req('GET', '/api/papers')).json.data;
  const zero = papers.find(p => /Zero-WAM/.test(p.title));
  if (!zero) throw new Error('Zero-WAM 不在库中');
  console.log('目标:', zero.title.slice(0, 60));

  // 后台触发抓取
  let finished = null;
  req('POST', `/api/papers/${zero.id}/fetch-references`).then(r => { finished = r.json; });

  // 轮询进度
  let lastKey = '';
  for (let i = 0; i < 40 && !finished; i++) {
    await sleep(1500);
    const pr = (await req('GET', `/api/papers/${zero.id}/fetch-progress`)).json.data;
    const key = pr.stage + '|' + pr.current + '|' + (pr.currentItem || '');
    if (key !== lastKey && pr.stage) {
      lastKey = key;
      console.log(`  [${String(pr.current).padStart(3)}/${pr.total}] ${pr.note || ''} ${(pr.currentItem || '').slice(0, 60)}`);
    }
  }
  if (finished) {
    const d = finished.data || finished;
    console.log(`\n完成: total=${d.total} resolved=${d.resolved} matched=${d.matched} added=${d.added}`);
  } else {
    console.log('\n(仍在进行中，进度事件流已验证)');
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
