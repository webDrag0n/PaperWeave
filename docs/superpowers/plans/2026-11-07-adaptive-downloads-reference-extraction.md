# Adaptive Downloads and Reference Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This session uses inline execution because the user explicitly prohibits subagents.

**Goal:** Add network-adaptive parallel PDF downloads, coherent reader/graph progress, automatic post-import reference fetching, and reliable numbered/unnumbered PDF reference extraction.

**Architecture:** A dependency-free shared ESM scheduler executes deduplicated tasks with global and per-host limits. Main and web services adapt its outcomes to existing import/download APIs. PDF extraction caches page text and reconstructs pages in ascending order; pure reference splitting helpers remain synchronous and are mirrored in the existing main/web implementations.

**Tech Stack:** Electron 33, Node.js built-in test assertions, browser ES modules, pdf.js 4, existing JSON store and IPC.

## Global Constraints

- Default concurrency is 3; adaptive range is 1–6; Semantic Scholar retains its independent throttle.
- Do not recursively download newly discovered references.
- Preserve existing `downloadAllRefs` summary shape: `{ ok, total, downloaded, skipped, failed }`.
- Do not add runtime dependencies.
- Keep all file changes inside `J:\Projects\PaperGraph\PaperGraph`.
- Do not commit unless the user explicitly asks.
- Update `agents/AGENTS.md` and API version for the new batch IPC/progress fields and parallel behavior.

---

### Task 1: Shared adaptive scheduler

**Files:**
- Create: `shared/adaptive-scheduler.mjs`
- Create: `tools/adaptive-scheduler-test.js`
- Modify: `package.json` (test script and packaged `shared/**/*`)

**Interfaces:**
- Produces: `new AdaptiveScheduler({ minConcurrency=1, maxConcurrency=6, initialConcurrency=3, hostLimit=4, successThreshold=4, cooldownMs=1500 })`.
- Produces: `scheduler.run(tasks, { onProgress })`, where each task is `{ key, url, label, run }`; returns input-ordered `{ ok, value?, error? }[]` and deduplicates equal keys.
- Progress shape: `{ status, current, total, active, pending, concurrency, failed, key, currentItem, note, at }`.

- [ ] **Step 1: Write failing scheduler tests**

Use `node:assert/strict` and dynamic import. Test that a batch never exceeds three active tasks initially, four consecutive successes allow a fourth active task, a `429` lowers concurrency and applies `Retry-After`, duplicate keys execute once, and one rejection does not prevent later tasks. Tasks use deferred promises and short deterministic delays rather than network access.

```js
const outcomes = await scheduler.run([
  { key: 'a', url: 'https://example.test/a', label: 'A', run: async () => 'A' },
  { key: 'a', url: 'https://example.test/a', label: 'A duplicate', run: async () => { throw new Error('must not run'); } },
]);
assert.equal(outcomes.length, 2);
assert.equal(outcomes[0].value, 'A');
assert.equal(outcomes[1].value, 'A');
```

- [ ] **Step 2: Run tests and confirm the module is missing**

Run: `node tools/adaptive-scheduler-test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `shared/adaptive-scheduler.mjs`.

- [ ] **Step 3: Implement the scheduler**

Implement a central pump, not one fixed worker per task. Track queued entries, active count, per-host active count, per-host `notBefore`, success streak and current limit. On success raise the limit by one after `successThreshold`; on timeout, 429 or 5xx reduce it and set host cooldown. Scan for the first runnable host so a cooling host does not block unrelated hosts. Map duplicate aliases to the canonical result before resolving.

```js
const retriable = err => err && (err.status === 429 || err.status >= 500 || /timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(err.message || ''));
const retryDelay = err => err && err.retryAfter ? Math.max(0, Number(err.retryAfter) * 1000) : this.cooldownMs;
```

- [ ] **Step 4: Run scheduler tests**

Run: `node tools/adaptive-scheduler-test.js`
Expected: PASS for concurrency, backoff, deduplication and failure isolation.

### Task 2: Ordered PDF extraction and unnumbered references

**Files:**
- Modify: `main/importer.js:162-218`
- Modify: `main/refs.js:99-153`
- Modify: `renderer/pdfmeta.js:116-127`
- Modify: `renderer/refs-web.js:15-65`
- Create: `tools/reference-extraction-test.js`
- Modify: `package.json` (`citationtest` includes the new test)

**Interfaces:**
- `extractRefText(doc, itemsToLines)` remains async and returns a string.
- Export `findReferencesBody(full)` for unit tests.
- `splitReferenceEntries(refText)` and `splitReferenceEntriesWeb(refText)` retain their synchronous signatures.

- [ ] **Step 1: Write failing extraction tests**

Cover ascending page reconstruction, unnumbered institution/person authors, dehyphenation, appendix truncation, and the real sample when `.tmp/2603.01966.pdf` exists.

```js
const body = findReferencesBody([
  'REFERENCES',
  'OpenAI. Introducing a model, 2025. URL https://openai.com/model.',
  'Prateek Chhikara, Dev Khant. Mem0: Building production-ready agents. arXiv preprint arXiv:2504.19413, 2025.',
  'A APPENDIX',
  'This text is not a reference.',
].join('\n'));
assert.match(body, /OpenAI/);
assert.doesNotMatch(body, /not a reference/);
const entries = splitReferenceEntries(body);
assert.equal(entries.length, 2);
```

The real-file assertion is `entries.length === 37` and at least ten entries contain `arXiv:`.

- [ ] **Step 2: Run tests and capture the existing failure**

Run: `node tools/reference-extraction-test.js`
Expected: the real sample reports zero extracted entries before the fix.

- [ ] **Step 3: Implement ordered extraction**

Cache page text in a `Map`; for windows 6, 12, 24 and full document, read only missing pages, then concatenate all cached pages from `start` through `numPages` in ascending order. Strip repeated publisher headers and numeric page footers. Accept an unnumbered body with bibliographic years as well as numbered bodies; cut short appendix/supplement headings after meaningful reference content.

```js
const pages = new Map();
for (const w of [6, 12, 24, Number.MAX_SAFE_INTEGER]) {
  const start = Math.max(1, doc.numPages - w + 1);
  for (let i = start; i <= doc.numPages; i++) if (!pages.has(i)) pages.set(i, await readPage(i));
  const full = Array.from({ length: doc.numPages - start + 1 }, (_, n) => pages.get(start + n) || '').join('\n');
  const body = findReferencesBody(full);
  if (body) return body;
  if (start === 1) break;
}
return '';
```

- [ ] **Step 4: Implement robust unnumbered splitting**

Keep the numbered pass. If it yields at most one entry, split lines only when the next line resembles an author/institution start and the accumulated entry already has a year, URL, DOI or arXiv terminator. Join hyphenated line breaks without removing ordinary hyphens.

```js
const completed = /(?:\b(?:19|20)\d{2}[a-z]?\s*[.,)]?|https?:\/\/\S+|10\.\d{4,9}\/\S+|arXiv:\d{4}\.\d{4,5})\s*$/i;
const normalized = entry.replace(/([A-Za-z])-\s*\n\s*([a-z])/g, '$1$2').replace(/\s*\n\s*/g, ' ').trim();
```

Mirror the pure splitting behavior in `refs-web.js` and adaptive page scanning in `pdfmeta.js`.

- [ ] **Step 5: Run real and synthetic extraction tests**

Run: `node tools/reference-extraction-test.js`
Expected: PASS, including exactly 37 entries for arXiv 2603.01966.

### Task 3: Parallel main-process URL import and citation downloads

**Files:**
- Modify: `main/service.js:42-62,65-124,156-202,282-304,342`
- Create: `main/download-queue.js`
- Modify: `main/main.js:161-168,200-203`
- Modify: `preload/preload.js:18-21,52-63`
- Create: `tools/download-service-test.js`

**Interfaces:**
- `importFromUrls(urls, opts, onProgress)` returns `{ results }` in input order.
- `downloadAllRefs(paperId, dir, onProgress)` keeps its existing public signature and response.
- IPC `papers:importUrls(urls, operationId)` emits `import:progress` events with `operationId` plus scheduler progress.

- [ ] **Step 1: Write failing service tests**

Mock task runners and store operations to prove batch failures are isolated, progress is monotonic, duplicate URL tasks execute once, the second hash check reuses a concurrently registered paper, and `scheduleAutoFetch` deduplicates both queued and running IDs.

```js
assert.deepEqual(progress.map(p => p.current), [0, 1, 2, 3]);
assert.ok(progress.every(p => p.active >= 0 && p.pending >= 0));
assert.equal(store.addedPaperIds.length, 1);
```

- [ ] **Step 2: Run tests before implementation**

Run: `node tools/download-service-test.js`
Expected: FAIL because the batch module and `importFromUrls` do not exist.

- [ ] **Step 3: Add the main download queue adapter**

Dynamically import the shared scheduler once per service and expose `runDownloadTasks(tasks, onProgress)`. Convert thrown task errors to the existing per-item error objects in the service. Preserve HTTP status and `Retry-After` on `importFromUrl` errors so scheduler feedback works.

- [ ] **Step 4: Integrate imports and citation downloads**

Add the post-extraction hash check before conflict handling. Implement `importFromUrls` using normalized URL keys. Replace the serial `downloadAllRefs` loop with scheduler tasks that call `downloadRef` without child progress callbacks. Aggregate scheduler events into `stage: 'download'` and preserve the final summary. Add `autoActiveId` so queued and running automatic fetches are both deduplicated.

- [ ] **Step 5: Add batch IPC and run service tests**

Run: `node tools/download-service-test.js && node tools/adaptive-scheduler-test.js`
Expected: PASS; existing single-URL IPC remains unchanged.

### Task 4: Browser parity for batch downloads

**Files:**
- Modify: `renderer/bridge.js:1-10,225-247,463-482`
- Modify: `tools/adaptive-scheduler-test.js`

**Interfaces:**
- `webBridge.importUrls(urls, operationId)` returns `{ results }` and emits `import:progress` through a web callback.
- `webBridge.downloadAllRefs` uses the same scheduler class and preserves its return shape.

- [ ] **Step 1: Add failing source-contract and scheduler parity checks**

Load `shared/adaptive-scheduler.mjs` directly as ESM and verify browser and main use the same module. Assert the bridge exposes `importUrls` and no longer contains a serial `downloadAllRefs` loop.

- [ ] **Step 2: Implement browser integration**

Instantiate one scheduler in `bridge.js`, wrap `{ ok: false }` import results as task errors, emit aggregate progress through `webProgressCb`, and leave existing CORS errors intact. Preserve `webImportBuffer` auto-fetch behavior.

- [ ] **Step 3: Run scheduler and citation tests**

Run: `node tools/adaptive-scheduler-test.js && npm run citationtest`
Expected: PASS.

### Task 5: Reader and 3D graph progress

**Files:**
- Modify: `renderer/index.html:142-153,244-251`
- Modify: `renderer/styles.css:794-815`
- Modify: `renderer/app.js:769-817,1288-1360,1399-1439,1655-1687,2096-2102`
- Modify: `renderer/i18n.js`
- Modify: `renderer/selftest.js`

**Interfaces:**
- Shared renderer helper `renderRefsProgress(root, progress)` targets `[data-rp-stage]`, `[data-rp-count]`, `[data-rp-fill]`, and `[data-rp-item]` inside either progress container.
- `latestRefsProgress: Map<paperId, progress>` stores throttled events for graph selection restoration.

- [ ] **Step 1: Add failing UI self-checks**

Verify graph markup contains the progress region, graph events are not discarded when `state.view !== 'reader'`, completed counts are monotonic during parallel downloads, and selecting another node does not show the previous node's progress.

- [ ] **Step 2: Implement reusable progress rendering**

Render known totals as a percentage and unknown totals as indeterminate. Include `active`, `pending`, and `concurrency` only when supplied. Add a graph container between metadata and relationship sections, using the existing visual style.

- [ ] **Step 3: Route all progress events**

Store every event by `paperId`; update reader only for `readerPaperId` and graph only for `graphSelectedId`. `showGraphSide` restores recent progress for the newly selected node. Manual graph fetch shows a locating event immediately and disables its fetch button until completion.

- [ ] **Step 4: Add live batch import progress**

Create URL status rows before starting the batch. `onImportProgress` updates the matching row and a batch summary; the existing conflict-resolution and result-summary path remains unchanged.

- [ ] **Step 5: Run UI regression**

Run: `npm run selftest`
Expected: all existing checks plus new graph/import progress checks PASS.

### Task 6: API documentation and full verification

**Files:**
- Modify: `agents/AGENTS.md`
- Modify: `main/agent-api.js:54-57`
- Modify: `README.md`
- Modify: `tools/api-test.js`
- Modify: `tools/mcp-test.js`

**Interfaces:**
- API version becomes 6; existing endpoint paths remain compatible.
- `fetch-progress` documents optional adaptive fields and the 1–6 range.

- [ ] **Step 1: Update API assertions and documentation**

Document parallel `download-all-refs`, optional progress fields, automatic post-download fetching, unnumbered PDF support and non-recursive download behavior. Add assertions that ping reports API 6 and progress fields, when present, are nonnegative integers.

- [ ] **Step 2: Run complete regression**

Run: `npm run citationtest && npm run apitest && npm run mcptest && npm run selftest`
Expected: all suites PASS.

- [ ] **Step 3: Verify the requested real paper end to end**

Run the existing importer and reference resolver against `.tmp/2603.01966.pdf`; record 37 extracted entries and the number resolved online. Network-dependent websites may remain unresolved, but arXiv entries must produce structured metadata without aborting the batch.

- [ ] **Step 4: Review final diff and workspace state**

Run: `git diff --check && git status --short`
Expected: no whitespace errors; only intended source, test and documentation files plus the local diagnostic sample are changed. Do not commit.
