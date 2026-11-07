// 自适应下载调度器：并发、退避、去重、失败隔离与进度聚合
const assert = require('node:assert/strict');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const { AdaptiveScheduler } = await import('../shared/adaptive-scheduler.mjs');

  // 初始并发上限、输入顺序、重复 key 与失败隔离
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const progress = [];
  const scheduler = new AdaptiveScheduler({ initialConcurrency: 3, maxConcurrency: 6, successThreshold: 100, hostLimit: 6 });
  const tasks = Array.from({ length: 7 }, (_, i) => ({
    key: 'task-' + i,
    url: 'https://example.test/' + i,
    label: 'Paper ' + i,
    run: async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(8 + (i % 3) * 4);
      active--;
      if (i === 2) throw new Error('not a pdf');
      return 'value-' + i;
    },
  }));
  tasks.splice(3, 0, { ...tasks[1], label: 'duplicate', run: async () => { throw new Error('duplicate ran'); } });
  const outcomes = await scheduler.run(tasks, { onProgress: p => progress.push(p) });
  assert.equal(outcomes.length, 8);
  assert.equal(runs, 7);
  assert.equal(maxActive, 3);
  assert.equal(outcomes[0].value, 'value-0');
  assert.equal(outcomes[1].value, 'value-1');
  assert.equal(outcomes[3].value, 'value-1');
  assert.equal(outcomes[2].ok, false);
  assert.match(outcomes[2].error.message, /not a pdf/);
  assert.equal(outcomes[4].value, 'value-3');
  assert.equal(outcomes[7].value, 'value-6');
  assert.equal(progress.at(-1).current, 7);
  assert.equal(progress.at(-1).failed, 1);
  assert.ok(progress.every(p => p.current >= 0 && p.current <= 7 && p.active >= 0 && p.pending >= 0));
  console.log('PASS 调度器初始并发、去重、失败隔离与单调进度');

  // 连续成功后升档，后续任务可以并行
  active = 0;
  maxActive = 0;
  const growing = new AdaptiveScheduler({ initialConcurrency: 1, maxConcurrency: 2, successThreshold: 2, hostLimit: 4 });
  await growing.run(Array.from({ length: 4 }, (_, i) => ({
    key: 'grow-' + i,
    url: 'https://fast.test/' + i,
    run: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      active--;
      return i;
    },
  })));
  assert.equal(maxActive, 2);
  assert.equal(growing.concurrency, 2);
  console.log('PASS 连续成功逐步提高并发');

  // 429 触发降档与主机冷却，但不阻塞其他主机
  const backingOff = new AdaptiveScheduler({ initialConcurrency: 1, maxConcurrency: 3, successThreshold: 100, cooldownMs: 30, hostLimit: 2 });
  const started = Date.now();
  const seen = [];
  const backoffResults = await backingOff.run([
    {
      key: 'slow-fail', url: 'https://slow.test/a', run: async () => {
        seen.push('slow-fail');
        const err = new Error('HTTP 429');
        err.status = 429;
        err.retryAfter = 0.03;
        throw err;
      },
    },
    { key: 'slow-next', url: 'https://slow.test/b', run: async () => { seen.push('slow-next'); return 'slow-ok'; } },
    { key: 'other', url: 'https://other.test/c', run: async () => { seen.push('other'); return 'other-ok'; } },
  ]);
  assert.equal(backoffResults[0].ok, false);
  assert.equal(backoffResults[1].value, 'slow-ok');
  assert.equal(backoffResults[2].value, 'other-ok');
  assert.equal(seen[1], 'other');
  assert.equal(backingOff.concurrency, 1);
  assert.ok(Date.now() - started >= 20, '应等待 Retry-After 后再访问同一主机');
  console.log('PASS 429 降档、Retry-After 与跨主机调度');

  // 请求虽然成功，但延迟明显升高时也应降档，而不是只看成功次数升档。
  const latencyAware = new AdaptiveScheduler({ initialConcurrency: 2, maxConcurrency: 4, successThreshold: 1, targetLatencyMs: 5, slowLatencyMs: 20 });
  await latencyAware.run([{ key: 'slow-success', url: 'https://latency.test/slow', run: async () => { await sleep(35); return 'ok'; } }]);
  assert.equal(latencyAware.concurrency, 1);
  console.log('PASS 高延迟成功请求触发并发降档');
})().catch(err => { console.error(err); process.exit(1); });
