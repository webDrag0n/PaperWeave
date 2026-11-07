// 主进程下载队列：懒加载共享 ESM 调度器，每个业务服务保留网络反馈状态。
function createDownloadQueue() {
  let schedulerPromise = null;
  return async function runDownloadTasks(tasks, onProgress) {
    if (!schedulerPromise) {
      schedulerPromise = import('../shared/adaptive-scheduler.mjs')
        .then(({ AdaptiveScheduler }) => new AdaptiveScheduler());
    }
    const scheduler = await schedulerPromise;
    return scheduler.run(tasks, { onProgress });
  };
}

module.exports = { createDownloadQueue };
