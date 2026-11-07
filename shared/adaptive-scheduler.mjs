// 无依赖的自适应异步任务调度器，主进程与浏览器预览共用。
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function hostOf(url) {
  try { return new URL(url).hostname || 'unknown'; } catch (_) { return 'unknown'; }
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value || '任务失败'));
}

function isNetworkFailure(err) {
  return !!(err && (err.status === 429 || err.status >= 500 || /timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|网络/i.test(err.message || '')));
}

export class AdaptiveScheduler {
  constructor({
    minConcurrency = 1,
    maxConcurrency = 6,
    initialConcurrency = 3,
    hostLimit = 4,
    successThreshold = 4,
    cooldownMs = 1500,
    targetLatencyMs = 4000,
    slowLatencyMs = 10000,
  } = {}) {
    this.minConcurrency = Math.max(1, minConcurrency);
    this.maxConcurrency = Math.max(this.minConcurrency, maxConcurrency);
    this._limit = Math.min(this.maxConcurrency, Math.max(this.minConcurrency, initialConcurrency));
    this.hostLimit = Math.max(1, hostLimit);
    this.successThreshold = Math.max(1, successThreshold);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.targetLatencyMs = Math.max(0, targetLatencyMs);
    this.slowLatencyMs = Math.max(this.targetLatencyMs, slowLatencyMs);
    this._successStreak = 0;
    this._cooldowns = new Map();
  }

  get concurrency() { return this._limit; }

  _succeeded(durationMs) {
    if (durationMs > this.slowLatencyMs) {
      this._successStreak = 0;
      this._limit = Math.max(this.minConcurrency, this._limit - 1);
      return;
    }
    if (durationMs > this.targetLatencyMs) {
      this._successStreak = 0;
      return;
    }
    this._successStreak++;
    if (this._successStreak >= this.successThreshold) {
      this._successStreak = 0;
      this._limit = Math.min(this.maxConcurrency, this._limit + 1);
    }
  }

  _failed(err, host) {
    this._successStreak = 0;
    if (!isNetworkFailure(err)) return;
    this._limit = Math.max(this.minConcurrency, this._limit - 1);
    const retryMs = err && Number.isFinite(Number(err.retryAfter)) && Number(err.retryAfter) > 0
      ? Number(err.retryAfter) * 1000
      : this.cooldownMs;
    const until = Date.now() + Math.min(60000, Math.max(0, retryMs));
    this._cooldowns.set(host, Math.max(this._cooldowns.get(host) || 0, until));
  }

  async run(tasks, { onProgress } = {}) {
    const input = Array.isArray(tasks) ? tasks : [];
    if (!input.length) return [];

    // aliases 保存输入序号 → 去重任务序号，最终仍按输入顺序返回。
    const entries = [];
    const aliases = new Array(input.length);
    const byKey = new Map();
    input.forEach((task, i) => {
      const key = String(task.key || task.url || ('task-' + i));
      if (byKey.has(key)) {
        aliases[i] = byKey.get(key);
        return;
      }
      const index = entries.length;
      byKey.set(key, index);
      aliases[i] = index;
      entries.push({ task, key, host: hostOf(task.url), state: 'queued' });
    });

    const total = entries.length;
    const results = new Array(total);
    const hosts = new Map();
    let active = 0;
    let settled = 0;
    let failed = 0;
    let timer = null;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const emit = onProgress || (() => {});
    const hostState = host => {
      if (!hosts.has(host)) hosts.set(host, { active: 0 });
      return hosts.get(host);
    };

    const finish = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolveDone(aliases.map(i => results[i]));
    };

    const pump = () => {
      if (settled === total) { finish(); return; }
      if (timer) { clearTimeout(timer); timer = null; }
      let earliest = Infinity;

      while (active < this._limit) {
        const now = Date.now();
        let picked = -1;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.state !== 'queued') continue;
          const hs = hostState(entry.host);
          if (hs.active >= this.hostLimit) continue;
          const notBefore = this._cooldowns.get(entry.host) || 0;
          if (notBefore > now) {
            earliest = Math.min(earliest, notBefore);
            continue;
          }
          picked = i;
          break;
        }
        if (picked < 0) break;

        const entry = entries[picked];
        entry.state = 'active';
        hostState(entry.host).active++;
        active++;
        const startedAt = Date.now();
        emit({
          status: 'start', current: settled, total, active, pending: total - settled - active,
          concurrency: this._limit, failed, key: entry.key,
          currentItem: entry.task.label || entry.task.url || entry.key,
          note: '下载中…', at: startedAt,
        });

        Promise.resolve()
          .then(() => entry.task.run())
          .then(
            value => settle(entry, null, value, Date.now() - startedAt),
            err => settle(entry, asError(err), undefined, Date.now() - startedAt),
          );
      }

      if (settled === total) { finish(); return; }
      // 只剩冷却中的可运行任务时也要唤醒；其他完成事件会再次调用 pump。
      if (earliest < Infinity) {
        timer = setTimeout(pump, Math.max(1, earliest - Date.now()));
      }
    };

    const settle = (entry, err, value, durationMs) => {
      hostState(entry.host).active--;
      active--;
      entry.state = 'done';
      settled++;
      if (err) {
        failed++;
        results[entries.indexOf(entry)] = { ok: false, error: err };
        this._failed(err, entry.host);
      } else {
        results[entries.indexOf(entry)] = { ok: true, value };
        this._succeeded(durationMs);
      }
      emit({
        status: err ? 'error' : 'success', current: settled, total, active,
        pending: total - settled - active, concurrency: this._limit, failed,
        key: entry.key, currentItem: entry.task.label || entry.task.url || entry.key,
        note: err ? '失败：' + err.message : '完成 ✓', at: Date.now(),
      });
      pump();
    };

    pump();
    return done;
  }
}

export { hostOf, isNetworkFailure, sleep };
