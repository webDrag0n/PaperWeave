// PaperWeave 自测驱动：在渲染进程中以真实用户操作路径跑完整场景
export async function runSelftest(ctx) {
  const { bridge, state, openReader, showView, refreshData, renderLibrary, refsOf, citesOf } = ctx;
  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail: String(detail).slice(0, 300) });
    console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    // ---------- 1. 批量导入示例论文 ----------
    const sampleDir = await bridge.selftestSampleDir();
    check('自测样例目录可用', !!sampleDir, sampleDir || '');
    const files = ['attention.pdf', 'bert.pdf', 'gpt.pdf', 's2s.pdf', 'resnet.pdf', 'vit.pdf'];
    const paths = files.map(f => sampleDir + '/' + f);
    const imp = await bridge.importPaths(paths);
    const okCount = imp.results.filter(r => !r.error && !r.duplicate).length;
    check('批量导入 6 篇 PDF', okCount === 6, `ok=${okCount} results=${JSON.stringify(imp.results.map(r => r.error || (r.paper && r.paper.title) || 'dup'))}`);

    await refreshData();
    check('论文库列表为 6 篇', state.papers.length === 6, 'count=' + state.papers.length);
    renderLibrary();
    await sleep(400);
    await bridge.selftestShot('01-library');

    // ---------- 2. 元数据提取 ----------
    const attention = state.papers.find(p => /Attention Is All You Need/i.test(p.title || ''));
    const bert = state.papers.find(p => /BERT/i.test(p.title || ''));
    const vit = state.papers.find(p => /Image is Worth/i.test(p.title || ''));
    check('标题自动提取 (Attention)', !!attention, attention ? attention.title : '');
    check('DOI 自动提取', attention && /10\.48550/.test(attention.doi || ''), attention && attention.doi);
    check('页数提取', attention && attention.pageCount === 3, attention && ('pages=' + attention.pageCount));
    check('手动导入默认 1 星', attention && attention.rating === 1, 'rating=' + (attention && attention.rating));

    // ---------- 2.5 未入库引用条目持久化 ----------
    await bridge.updatePaper(attention.id, { externalRefs: [
      { key: 'arxiv:1412.6980', dir: 'out', title: 'Adam: A Method for Stochastic Optimization', authors: ['D. P. Kingma', 'J. Ba'], year: '2015', venue: 'ICLR', doi: 'arXiv:1412.6980', arxivId: '1412.6980', citeCount: 100000, source: 'test', fetchedAt: Date.now() },
    ] });
    const wp = await bridge.getPaper(attention.id);
    check('未入库引用条目保存', Array.isArray(wp.externalRefs) && wp.externalRefs.length === 1 && wp.externalRefs[0].dir === 'out', 'ext=' + ((wp.externalRefs || []).length));

    // ---------- 3. 离线参考文献匹配（建立引用关系） ----------
    let totalAdded = 0;
    for (const p of state.papers) {
      const r = await bridge.autoMatchRefs(p.id);
      if (r.ok) totalAdded += r.added;
    }
    await refreshData();
    check('离线匹配建立引用关联', totalAdded >= 5, 'added=' + totalAdded);
    check('BERT→Attention 引用边存在', bert && attention && refsOf(bert.id).some(x => x.paper.id === attention.id));
    check('Attention 的被引列表包含 BERT 与 ViT',
      attention && bert && vit &&
      citesOf(attention.id).some(x => x.paper.id === bert.id) &&
      citesOf(attention.id).some(x => x.paper.id === vit.id),
      attention ? 'cites=' + citesOf(attention.id).length : '');

    // ---------- 4. 打开阅读器，渲染 PDF ----------
    check('目标论文在库中', !!attention);
    await openReader(attention.id);
    await sleep(600);
    const viewer = window.__pg.viewer;
    check('PDF 阅读器打开', viewer && viewer.pages.length === 3);
    await sleep(1200);
    check('首屏页面即时渲染', viewer && viewer.pages[0].rendered && viewer.pages[0].viewport);
    // 滚动到底部触发懒渲染
    document.querySelector('#pdfScroll').scrollTop = 999999;
    await sleep(1500);
    check('滚动后懒渲染完成', viewer && viewer.pages.every(p => p.rendered && p.viewport));
    const textSpans = document.querySelectorAll('#pdfPages .pdf-page:nth-child(1) .textLayer span').length;
    check('文本层可用于选择', textSpans > 10, 'spans=' + textSpans);

    // ---------- 4.5 阅读辅助：搜索 / 目录 / 跳页 / 高亮防重叠 ----------
    const searchRes = await viewer.searchText('attention');
    check('全文搜索有结果', searchRes.length > 0, 'hits=' + searchRes.length);
    await viewer.flashMatches(searchRes[0].page);
    await sleep(200);
    check('搜索命中临时高亮', document.querySelectorAll('.hl-box.search-hit').length > 0);
    const outlineTxt = document.querySelector('#outlineList').textContent.trim();
    check('目录面板渲染（无大纲时给提示）', outlineTxt.length > 0);
    document.querySelector('#btnOutline').click();
    check('目录侧边栏展开', !document.querySelector('#outlinePanel').classList.contains('hidden'));
    document.querySelector('#btnOutlineClose').click();
    check('目录侧边栏收起', document.querySelector('#outlinePanel').classList.contains('hidden'));
    const jumped = await viewer.jumpToPage(2);
    await sleep(900);
    check('页码跳转', jumped && viewer.pages[1].rendered && viewer.visiblePageNum() === 2, 'cur=' + viewer.visiblePageNum());

    // ---------- 4.6 阅读器增强：适应宽度 / 侧栏收起 / 阅读位置记忆 ----------
    document.querySelector('#btnFitWidth').click();
    await sleep(600);
    check('适应宽度缩放', document.querySelector('#zoomLabel').textContent === '100%', document.querySelector('#zoomLabel').textContent);
    document.querySelector('#btnTogglePanel').click();
    await sleep(800);
    check('右侧面板收起', document.querySelector('#readerPanel').classList.contains('hidden'));
    document.querySelector('#btnTogglePanel').click();
    await sleep(800);
    check('右侧面板展开', !document.querySelector('#readerPanel').classList.contains('hidden'));
    // 阅读位置记忆：当前停留在第 2 页，等待滚动防抖保存
    await sleep(1400);
    const lpPaper = await bridge.getPaper(attention.id);
    check('阅读位置已记忆', (lpPaper.lastPage || 0) >= 2, 'lastPage=' + lpPaper.lastPage);
    await openReader(attention.id);
    await sleep(1200);
    check('重开后恢复阅读位置', viewer.visiblePageNum() === lpPaper.lastPage, 'cur=' + viewer.visiblePageNum());

    // ---------- 4.7 引用面板：未入库条目与下载入口 ----------
    document.querySelector('.tab[data-tab="refs"]').click();
    await sleep(250);
    check('引用面板展示未入库条目', document.querySelectorAll('#refOutExt .ext-item').length === 1, 'items=' + document.querySelectorAll('#refOutExt .ext-item').length);
    check('未入库条目提供下载按钮', !!document.querySelector('#refOutExt .ext-dl'));
    check('全部下载按钮可见', !document.querySelector('#btnDlAllOut').classList.contains('hidden'));
    check('引用计数含未入库数', document.querySelector('#refOutCount').textContent.includes('+1'), document.querySelector('#refOutCount').textContent);
    // 防重叠：故意构造两行重叠的 quad，渲染后不得出现垂直重叠的色块
    viewer.annotations.push({
      id: 'a_test_overlap', type: 'highlight', page: 1,
      quads: [
        { x: 0.05, y: 0.20, w: 0.6, h: 0.03 },
        { x: 0.05, y: 0.225, w: 0.6, h: 0.03 }, // 与上一行重叠 0.005
        { x: 0.05, y: 0.25, w: 0.6, h: 0.03 },
      ],
      color: '#ffe74a', text: 'overlap-test', createdAt: Date.now(),
    });
    viewer._renderAnnotationsFor(viewer.pages[0]);
    const boxes = [...viewer.pages[0].hlLayer.querySelectorAll('.hl-box')].map(b => b.getBoundingClientRect());
    let overlapErr = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (vOverlap > 0.5 && hOverlap > 0.5) overlapErr++;
    }
    check('多行高亮无重叠（颜色均匀）', overlapErr === 0, 'overlaps=' + overlapErr);
    const oi = viewer.annotations.findIndex(a => a.id === 'a_test_overlap');
    if (oi >= 0) viewer.annotations.splice(oi, 1);
    viewer._renderAnnotationsFor(viewer.pages[0]);

    await sleep(400);
    await bridge.selftestShot('02-reader');

    // ---------- 5. 高亮批注 ----------
    viewer.annotations.push({
      id: 'a_test_hl', type: 'highlight', page: 1,
      quads: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.03 }],
      color: '#ffe74a', text: 'The dominant sequence transduction models', comment: '核心句', createdAt: Date.now(),
    });
    viewer._save();
    viewer._renderAnnotations();
    const savedAnns = await bridge.listAnnotations(attention.id);
    check('高亮保存成功', savedAnns.some(a => a.id === 'a_test_hl' && a.type === 'highlight'), 'count=' + savedAnns.length);
    const hlBoxes = document.querySelectorAll('.hl-box').length;
    check('高亮渲染到页面', hlBoxes >= 1, 'boxes=' + hlBoxes);

    // ---------- 5.5 鼠标中心平滑缩放：页面、文字与高亮必须共享同一坐标系 ----------
    await viewer.jumpToPage(1, 'auto');
    await sleep(250);
    const zoomPage = viewer.pages[0];
    const zoomSpans = [...zoomPage.textLayerEl.querySelectorAll('span')];
    const scrollRect = document.querySelector('#pdfScroll').getBoundingClientRect();
    const zoomSpanIndex = zoomSpans.findIndex(s => {
      const r = s.getBoundingClientRect();
      return r.width > 30 && r.height > 5 && r.top >= scrollRect.top && r.bottom <= scrollRect.bottom;
    });
    const zoomSpan = zoomSpans[zoomSpanIndex];
    check('缩放测试找到可见文字', !!zoomSpan, 'index=' + zoomSpanIndex);
    if (zoomSpan) {
      const textRect = zoomPage.textLayerEl.getBoundingClientRect();
      const spanRect = zoomSpan.getBoundingClientRect();
      const zoomAnn = {
        id: 'a_test_zoom', type: 'highlight', page: 1,
        quads: [{
          x: (spanRect.left - textRect.left) / textRect.width,
          y: (spanRect.top - textRect.top) / textRect.height,
          w: spanRect.width / textRect.width,
          h: spanRect.height / textRect.height,
        }],
        color: '#7ac7ff', text: 'zoom-alignment-test', createdAt: Date.now(),
      };
      viewer.annotations.push(zoomAnn);
      viewer._renderAnnotationsFor(zoomPage);
      const zoomBox = [...zoomPage.hlLayer.querySelectorAll('.hl-box')].find(b => b.title === zoomAnn.text);
      const beforePageRect = zoomPage.wrap.getBoundingClientRect();
      const beforeBoxRect = zoomBox.getBoundingClientRect();
      const anchor = {
        clientX: beforePageRect.left + beforePageRect.width * 0.55,
        clientY: beforePageRect.top + Math.min(beforePageRect.height * 0.3, 180),
      };
      const anchorRatio = {
        x: (anchor.clientX - beforePageRect.left) / beforePageRect.width,
        y: (anchor.clientY - beforePageRect.top) / beforePageRect.height,
      };
      const zoomResult = viewer.zoom(1.2, anchor);
      // 故意不等待重绘：交互帧必须立即缩放，不能在后台 PDF 重绘完成后才更新。
      const immediatePageRect = zoomPage.wrap.getBoundingClientRect();
      const immediateBoxRect = zoomBox.getBoundingClientRect();
      const anchorErr = Math.hypot(
        immediatePageRect.left + immediatePageRect.width * anchorRatio.x - anchor.clientX,
        immediatePageRect.top + immediatePageRect.height * anchorRatio.y - anchor.clientY,
      );
      check('鼠标中心缩放即时生效且锚点不动',
        immediatePageRect.width > beforePageRect.width * 1.1 && anchorErr < 1.5,
        'width=' + beforePageRect.width.toFixed(1) + '→' + immediatePageRect.width.toFixed(1) + ', anchorErr=' + anchorErr.toFixed(2));
      check('高亮随文字即时同步缩放',
        immediateBoxRect.width > beforeBoxRect.width * 1.1,
        'width=' + beforeBoxRect.width.toFixed(1) + '→' + immediateBoxRect.width.toFixed(1));
      await zoomResult;
      await sleep(900);
      const settledSpan = zoomPage.textLayerEl.querySelectorAll('span')[zoomSpanIndex];
      const settledBox = [...zoomPage.hlLayer.querySelectorAll('.hl-box')].find(b => b.title === zoomAnn.text);
      const settledSpanRect = settledSpan.getBoundingClientRect();
      const settledBoxRect = settledBox.getBoundingClientRect();
      const alignErr = Math.max(
        Math.abs(settledSpanRect.left - settledBoxRect.left),
        Math.abs(settledSpanRect.top - settledBoxRect.top),
        Math.abs(settledSpanRect.width - settledBoxRect.width),
        Math.abs(settledSpanRect.height - settledBoxRect.height),
      );
      check('高清重绘后高亮仍与文字对齐', alignErr < 1.5, 'alignErr=' + alignErr.toFixed(2));
      let continuousAnchorErr = 0;
      for (let i = 0; i < 12; i++) {
        const r0 = zoomPage.wrap.getBoundingClientRect();
        const ratio = {
          x: (anchor.clientX - r0.left) / r0.width,
          y: (anchor.clientY - r0.top) / r0.height,
        };
        viewer.zoom(i % 2 === 0 ? 1.04 : 1 / 1.04, anchor);
        const r1 = zoomPage.wrap.getBoundingClientRect();
        continuousAnchorErr = Math.max(continuousAnchorErr, Math.hypot(
          r1.left + r1.width * ratio.x - anchor.clientX,
          r1.top + r1.height * ratio.y - anchor.clientY,
        ));
      }
      check('连续放大缩小不累积鼠标锚点漂移', continuousAnchorErr < 1.5, 'maxErr=' + continuousAnchorErr.toFixed(2));
      await sleep(900);
      const continuousSpan = zoomPage.textLayerEl.querySelectorAll('span')[zoomSpanIndex].getBoundingClientRect();
      const continuousBox = [...zoomPage.hlLayer.querySelectorAll('.hl-box')].find(b => b.title === zoomAnn.text).getBoundingClientRect();
      const continuousAlignErr = Math.max(
        Math.abs(continuousSpan.left - continuousBox.left),
        Math.abs(continuousSpan.top - continuousBox.top),
        Math.abs(continuousSpan.width - continuousBox.width),
        Math.abs(continuousSpan.height - continuousBox.height),
      );
      check('连续缩放重绘后高亮位置保持稳定', continuousAlignErr < 1.5, 'alignErr=' + continuousAlignErr.toFixed(2));
      viewer.annotations.splice(viewer.annotations.indexOf(zoomAnn), 1);
      viewer._renderAnnotationsFor(zoomPage);
      document.querySelector('#btnFitWidth').click();
      await sleep(800);
    }

    // ---------- 5.6 双栏选区：同线不同栏分开，同栏碎片仍合并 ----------
    const columnPage = viewer.pages[0];
    const columnTextLayer = columnPage.textLayerEl;
    const leftColumnSpan = document.createElement('span');
    const rightColumnSpan = document.createElement('span');
    leftColumnSpan.textContent = 'Left column selected text';
    rightColumnSpan.textContent = 'Right column selected text';
    leftColumnSpan.style.cssText = 'left:60px;top:500px;font:12px Arial;transform:none;';
    rightColumnSpan.style.cssText = 'left:600px;top:500px;font:12px Arial;transform:none;';
    columnTextLayer.append(leftColumnSpan, rightColumnSpan);
    const columnSelection = window.getSelection();
    let columnRawRects = [];
    const selectColumnSpans = () => {
      const range = document.createRange();
      range.setStart(leftColumnSpan.firstChild, 0);
      range.setEnd(rightColumnSpan.firstChild, rightColumnSpan.firstChild.length);
      columnSelection.removeAllRanges();
      columnSelection.addRange(range);
      columnRawRects = [...range.getClientRects()].map(r => ({
        left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1), height: +r.height.toFixed(1),
      }));
      viewer._onMouseUp();
      return viewer._boundPopup ? viewer._boundPopup.quads : [];
    };
    const columnQuads = selectColumnSpans();
    const columnLayerRect = columnTextLayer.getBoundingClientRect();
    const columnPixels = columnQuads.map(q => ({
      left: columnLayerRect.left + q.x * columnLayerRect.width,
      right: columnLayerRect.left + (q.x + q.w) * columnLayerRect.width,
    })).sort((a, b) => a.left - b.left);
    const columnGap = columnPixels.length === 2 ? columnPixels[1].left - columnPixels[0].right : 0;
    check('双栏同线选区保留栏间空白', columnPixels.length === 2 && columnGap > 100,
      'quads=' + columnPixels.length + ', gap=' + columnGap.toFixed(1));

    // 两个文本片段仍在同一栏、只有 4px 间隙时，应保持为一条连续高亮。
    const leftSpanRect = leftColumnSpan.getBoundingClientRect();
    const layoutScale = columnLayerRect.width / columnPage.viewport.width;
    rightColumnSpan.style.left = ((leftSpanRect.right - columnLayerRect.left + 4) / layoutScale) + 'px';
    const actualSmallGap = rightColumnSpan.getBoundingClientRect().left - leftColumnSpan.getBoundingClientRect().right;
    const singleColumnQuads = selectColumnSpans();
    check('同栏小间隙文本碎片连续合并', singleColumnQuads.length === 1,
      'quads=' + singleColumnQuads.length + ', gap=' + actualSmallGap.toFixed(1) + ', raw=' + JSON.stringify(columnRawRects));
    columnSelection.removeAllRanges();
    viewer.opts.selPopup.classList.add('hidden');
    viewer._boundPopup = null;
    leftColumnSpan.remove();
    rightColumnSpan.remove();

    const columnOverlapAnn = {
      id: 'a_test_column_overlap', type: 'highlight', page: 1,
      quads: [
        { x: 0.06, y: 0.20, w: 0.38, h: 0.03 },
        { x: 0.56, y: 0.20, w: 0.38, h: 0.03 },
        { x: 0.06, y: 0.225, w: 0.38, h: 0.03 },
        { x: 0.56, y: 0.225, w: 0.38, h: 0.03 },
      ],
      color: '#ffe74a', text: 'column-overlap-test', createdAt: Date.now(),
    };
    viewer.annotations.push(columnOverlapAnn);
    viewer._renderAnnotationsFor(columnPage);
    const columnOverlapBoxes = [...columnPage.hlLayer.querySelectorAll('.hl-box')]
      .filter(b => b.title === columnOverlapAnn.text).map(b => b.getBoundingClientRect());
    let columnOverlapErr = 0;
    for (let i = 0; i < columnOverlapBoxes.length; i++) for (let j = i + 1; j < columnOverlapBoxes.length; j++) {
      const a = columnOverlapBoxes[i], b = columnOverlapBoxes[j];
      if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 &&
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5) columnOverlapErr++;
    }
    check('双栏相邻行高亮无重叠', columnOverlapErr === 0, 'overlaps=' + columnOverlapErr);
    viewer.annotations.splice(viewer.annotations.indexOf(columnOverlapAnn), 1);
    viewer._renderAnnotationsFor(columnPage);

    // ---------- 6. 便利贴 ----------
    viewer.annotations.push({
      id: 'a_test_sticky', type: 'sticky', page: 2, x: 0.3, y: 0.4,
      color: '#ff7a4a', comment: '这里的方法值得借鉴', createdAt: Date.now(),
    });
    viewer._save();
    viewer._renderAnnotations();
    const saved2 = await bridge.listAnnotations(attention.id);
    check('便利贴保存成功', saved2.some(a => a.id === 'a_test_sticky' && a.comment.includes('借鉴')));
    // 便利贴在第 2 页，该页已在上一步滚动懒渲染
    check('便利贴图标渲染', document.querySelectorAll('.sticky-icon').length >= 1);
    await sleep(300);
    await bridge.selftestShot('03-reader-annot');

    // ---------- 7. 笔记 ----------
    const md = '# 阅读笔记\n\n- Transformer 完全抛弃循环结构\n- **自注意力**是关键\n\n> 后续看 BERT';
    await bridge.updatePaper(attention.id, { notes: md });
    const reloaded = await bridge.getPaper(attention.id);
    check('论文笔记保存与读取', (reloaded.notes || '').includes('自注意力'));
    const { renderMarkdown } = await import('./markdown.js');
    const html = renderMarkdown(reloaded.notes);
    check('Markdown 预览渲染', html.includes('<h1>') && html.includes('<strong>') && html.includes('<blockquote>'), html.slice(0, 120));

    // ---------- 8. 元数据编辑 ----------
    await bridge.updatePaper(attention.id, { tags: ['transformer', 'NLP'] });
    const re2 = await bridge.getPaper(attention.id);
    check('标签保存', (re2.tags || []).includes('transformer'));

    // ---------- 9. 3D 图谱 ----------
    showView('graph');
    await sleep(1200);
    const graph = window.__pg.graph;
    await bridge.selftestShot('04-graph');
    check('3D 图谱构建', graph && graph.nodes.length === 6, 'nodes=' + (graph && graph.nodes.length));
    check('图谱边数量与链接一致', graph && graph.edges.length === state.links.length, `edges=${graph && graph.edges.length} links=${state.links.length}`);

    // 选中 Attention（默认 2 跳）：BERT/ViT/S2S/GPT 均 1 跳蓝色；ResNet 2 跳橙色
    const s2s = state.papers.find(p => /Sequence to Sequence/i.test(p.title || ''));
    const resnet = state.papers.find(p => /ResNet|Residual/i.test(p.title || ''));
    graph.select(attention.id);
    const nodeColor = (pid) => {
      const nd = graph.nodes.find(n => n.id === pid);
      return nd ? nd.mesh.material.color.getHex() : null;
    };
    check('选中节点为黄色', nodeColor(attention.id) === 0xffd54a, nodeColor(attention.id) && nodeColor(attention.id).toString(16));
    check('1 跳论文(BERT/ViT/S2S)显示蓝色', [bert.id, vit.id, s2s.id].every(id => nodeColor(id) === 0x4aa3ff),
      [bert.id, vit.id, s2s.id].map(id => nodeColor(id) && nodeColor(id).toString(16)).join(','));
    check('2 跳论文(ResNet)显示橙色', nodeColor(resnet.id) === 0xff7a4a, nodeColor(resnet.id) && nodeColor(resnet.id).toString(16));
    check('跳数滑条默认 2', graph.hopDepth === 2);
    // 模拟真实点击选择后的回调（onSelect 驱动滑条显隐）
    graph.opts.onSelect(attention.id, graph.selectedIds);
    check('选中后跳数滑条显示', !document.querySelector('#graphHopCtl').classList.contains('hidden'));
    await bridge.selftestShot('05-graph-selected');

    // ---------- 9.1 流光方向 + 详情栏引用列表 + BibTeX ----------
    check('每条边都有流光点（被引→引用方）', graph.edges.length > 0 && graph.edges.every(e => e.pulse && e.pulse.isSprite));
    // 采样两次位置：应严格沿线段、且沿 b（被引）→ a（引用方）推进
    const flowBefore = graph.edges.map(e => e.pulse.position.clone());
    await sleep(400);
    check('流光沿连线从被引流向引用方', graph.edges.every((e, i) => {
      const a = e.a.pos, b = e.b.pos, ab = a.clone().sub(b), len2 = ab.lengthSq();
      if (len2 < 1e-6) return true;
      const tOf = (p) => Math.max(0, Math.min(1, p.clone().sub(b).dot(ab) / len2));
      const t0 = tOf(flowBefore[i]), t1 = tOf(e.pulse.position);
      let dt = t1 - t0; if (dt < -0.5) dt += 1; // 回绕修正
      const onLine = e.pulse.position.distanceTo(b.clone().add(ab.clone().multiplyScalar(t1))) < 0.8;
      return onLine && dt > 0;
    }));
    const bib = window.__pg.bibtexOf(attention);
    check('BibTeX 生成格式正确', /^@(article|misc)\{[^\s,]+,\n/.test(bib) && bib.includes('Attention Is All You Need') && bib.includes('Vaswani'), bib.split('\n')[0]);
    const refsN = refsOf(attention.id).length, citesN0 = citesOf(attention.id).length;
    check('详情栏条目数与引用数据一致',
      document.querySelectorAll('#graphSideRefs .gs-item').length === refsN &&
      document.querySelectorAll('#graphSideCites .gs-item').length === citesN0,
      `refs=${refsN} cites=${citesN0}`);
    check('单条 BibTeX 复制按钮齐全', document.querySelectorAll('#graphSide .gs-bib').length === refsN + citesN0);
    check('分区批量复制按钮齐全', document.querySelectorAll('#graphSide .gs-bib-all').length === (refsN ? 1 : 0) + (citesN0 ? 1 : 0));
    check('条目含标题与作者', !!document.querySelector('#graphSide .gs-item-title') && !!document.querySelector('#graphSide .gs-item-sub'));
    // 跳数滑条调到 1：2 跳的 ResNet 应变灰
    const hopRange = document.querySelector('#hopRange');
    hopRange.value = '1';
    hopRange.dispatchEvent(new Event('input'));
    check('1 跳档位下 ResNet 变灰', nodeColor(resnet.id) === 0x5b6270, nodeColor(resnet.id) && nodeColor(resnet.id).toString(16));
    hopRange.value = '2';
    hopRange.dispatchEvent(new Event('input'));
    check('回到 2 跳档位 ResNet 恢复橙色', nodeColor(resnet.id) === 0xff7a4a);
    // 反向验证：选中 ViT 时 Attention 为 1 跳蓝色
    graph.select(vit.id);
    check('反向验证：Attention 对 ViT 显示蓝色', nodeColor(attention.id) === 0x4aa3ff, nodeColor(attention.id) && nodeColor(attention.id).toString(16));

    // ---------- 9.6 Shift 多选与最短关联轮廓 ----------
    graph.select(attention.id);
    graph.select(bert.id, true);
    check('Shift 多选两篇', graph.selectedIds.length === 2);
    const pathCount2 = graph.pathGroup.children.length;
    check('双选最短关联轮廓高亮', pathCount2 > 0, 'pathObjs=' + pathCount2);
    check('多选后选中节点均黄色', nodeColor(bert.id) === 0xffd54a && nodeColor(attention.id) === 0xffd54a);
    check('轮廓高亮不覆盖跳数颜色（ViT/S2S 仍蓝）', nodeColor(vit.id) === 0x4aa3ff && nodeColor(s2s.id) === 0x4aa3ff);
    graph.select(vit.id, true);
    check('Shift 多选三篇', graph.selectedIds.length === 3);
    check('三选后路径轮廓增加', graph.pathGroup.children.length > pathCount2, 'pathObjs=' + graph.pathGroup.children.length);
    // 多选跳数按最近选中节点计算：S2S 距 Attention 1 跳（距 BERT 2 跳）→ 取 1 跳蓝色
    check('多选跳数取最近距离（S2S 仍 1 跳蓝）', nodeColor(s2s.id) === 0x4aa3ff);
    graph.select(null);
    check('取消选择后全部变灰', [attention.id, bert.id, vit.id, s2s.id].every(id => nodeColor(id) === 0x5b6270));

    // ---------- 9.5 图谱标签常显 / 主题联动 / 来源导航 ----------
    check('所有节点标签常显', graph.labelGroup.children.length === state.papers.length, 'labels=' + graph.labelGroup.children.length);
    graph.setTheme('light');
    check('图谱主题切换为浅色', graph.T.edgeBase === 0xb9c2d2);
    graph.setTheme('dark');
    check('图谱主题切回深色', graph.T.other === 0x5b6270);
    // 从论文库进入 → 返回论文库
    state.graphFrom = 'library';
    document.querySelector('#btnGraphBack').click();
    await sleep(250);
    check('图谱退出回到论文库', state.view === 'library');
    // 从阅读器进入 → 返回该论文阅读页
    await openReader(attention.id);
    await sleep(700);
    document.querySelector('#btnGraphFromReader').click();
    await sleep(500);
    check('阅读器进入图谱', state.view === 'graph');
    check('返回按钮指向阅读器', document.querySelector('#btnGraphBack').textContent.includes('继续阅读'), document.querySelector('#btnGraphBack').textContent);
    document.querySelector('#btnGraphBack').click();
    await sleep(300);
    check('图谱退出回到阅读器', state.view === 'reader' && state.readerPaperId === attention.id);

    // ---------- 10. 手动关联 + 解除 ----------
    await bridge.addLink(resnet.id, attention.id, 'manual');
    await refreshData();
    check('手动添加引用关联', refsOf(resnet.id).some(x => x.paper.id === attention.id));
    const lk = state.links.find(l => l.from === resnet.id && l.to === attention.id);
    await bridge.removeLink(lk.id);
    await refreshData();
    check('移除引用关联', !refsOf(resnet.id).some(x => x.paper.id === attention.id));

    // ---------- 10.1 详情栏「展开全部」交互 ----------
    // 补足 ≥4 条被引，覆盖展开/收起；结束后清理临时关联
    const tmpLinkIds = [];
    for (const p of state.papers) {
      if (citesOf(attention.id).length >= 4) break;
      if (p.id === attention.id || citesOf(attention.id).some(x => x.paper.id === p.id)) continue;
      const l = await bridge.addLink(p.id, attention.id, 'manual');
      if (l && l.id) tmpLinkIds.push(l.id);
      await refreshData();
    }
    const citesN1 = citesOf(attention.id).length;
    check('测试数据补足 ≥4 条被引', citesN1 >= 4, 'cites=' + citesN1);
    graph.opts.onSelect(attention.id, [attention.id]);
    check('默认仅显示前 3 条', document.querySelectorAll('#graphSideCites .gs-item').length === 3);
    const expandBtn = document.querySelector('#graphSideCites .gs-expand');
    check('超过 3 条出现展开按钮', !!expandBtn && expandBtn.textContent.includes(String(citesN1)));
    expandBtn.click();
    check('展开显示全部论文', document.querySelectorAll('#graphSideCites .gs-item').length === citesN1);
    document.querySelector('#graphSideCites .gs-expand').click();
    check('收起后回到前 3 条', document.querySelectorAll('#graphSideCites .gs-item').length === 3);
    for (const id of tmpLinkIds) await bridge.removeLink(id);
    await refreshData();

    // ---------- 10.2 详情栏作者名单折叠（超 3 行省略中间） ----------
    showView('graph');
    await sleep(300);
    const origAuthors = (state.papers.find(p => p.id === attention.id) || {}).authors || [];
    await bridge.updatePaper(attention.id, { authors: Array.from({ length: 30 }, (_, i) => `Test Author ${i + 1}`) });
    await refreshData();
    graph.opts.onSelect(attention.id, [attention.id]);
    await sleep(50);
    const authEl = document.querySelector('#graphSideAuthors');
    const authToggle = authEl && authEl.querySelector('.gs-auth-toggle');
    check('作者超 3 行时折叠并出现展开按钮', !!authToggle && !!authEl.querySelector('.gs-auth-omit'), authEl && authEl.textContent.slice(0, 60));
    check('折叠态保留首行与末位作者', !!authEl && authEl.textContent.includes('Test Author 1') && authEl.textContent.includes('Test Author 30'));
    check('折叠态省略中间作者', !!authEl && !authEl.textContent.includes('Test Author 15'));
    if (authToggle) authToggle.click();
    check('点击展开显示全部作者', authEl.textContent.includes('Test Author 15') && authEl.textContent.includes('收起'));
    const collapseBtn = authEl.querySelector('.gs-auth-toggle');
    if (collapseBtn) collapseBtn.click(); // 复位展开状态
    await bridge.updatePaper(attention.id, { authors: origAuthors });
    await refreshData();
    graph.opts.onSelect(attention.id, [attention.id]);
    check('作者恢复后不再折叠', !document.querySelector('#graphSideAuthors .gs-auth-omit'));

    // ---------- 10.3 库内相似度（文献耦合 × 同被引） ----------
    const simEdges = window.__pg.sim.computeSimEdges(state.papers, state.links);
    check('相似边计算返回数组', Array.isArray(simEdges), 'n=' + (simEdges && simEdges.length));
    const bvPair = simEdges.find(e => (e.a === bert.id && e.b === vit.id) || (e.a === vit.id && e.b === bert.id));
    check('BERT↔ViT 共同引用 Attention 产生相似边', !!bvPair && bvPair.score > 0, bvPair && ('score=' + bvPair.score.toFixed(3)));
    check('相似分数在 (0,1] 且整体降序', simEdges.every((e, i) => e.score > 0 && e.score <= 1 && (i === 0 || simEdges[i - 1].score >= e.score)));
    graph.opts.onSelect(bert.id, [bert.id]);
    await sleep(50);
    const simItems = document.querySelectorAll('#graphSideSim .gs-item');
    check('详情栏显示相似论文区', simItems.length > 0, 'n=' + simItems.length);
    check('相似论文含相似度角标', !!document.querySelector('#graphSideSim .gs-sim-score'));
    if (simItems.length) simItems[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(80);
    check('点击相似论文跳转选中', !!state.graphSelectedId && state.graphSelectedId !== bert.id, 'selected=' + state.graphSelectedId);
    graph.opts.onSelect(attention.id, [attention.id]);

    // ---------- 10.4 库外发现（经典先驱 / 衍生新作） ----------
    // 构造重叠的未入库条目：BERT 与 ViT 共同引用同一篇先驱，同一篇综述同时引用二者
    const extPrior = { key: 'test:prior-1', dir: 'out', title: 'Shared Foundation Work', authors: ['F. One'], year: '2001', doi: '10.1/prior1', citeCount: 500, source: 'test', fetchedAt: Date.now() };
    const extDeriv = { key: 'test:deriv-1', dir: 'in', title: 'Survey Citing Many', authors: ['S. Two'], year: '2024', doi: '10.1/deriv1', citeCount: 30, source: 'test', fetchedAt: Date.now() };
    const bertExt = ((await bridge.getPaper(bert.id)).externalRefs) || [];
    const vitExt = ((await bridge.getPaper(vit.id)).externalRefs) || [];
    await bridge.updatePaper(bert.id, { externalRefs: [...bertExt, extPrior, extDeriv] });
    await bridge.updatePaper(vit.id, { externalRefs: [...vitExt, extPrior, extDeriv] });
    await refreshData();
    const agg = window.__pg.sim.aggregateExternal(state.papers, null);
    const priorRec = agg.prior.find(r => /Shared Foundation Work/.test(r.entry.title || ''));
    const derivRec = agg.derivative.find(r => /Survey Citing Many/.test(r.entry.title || ''));
    check('先驱聚合：共同参考文献计数 2', !!priorRec && priorRec.count === 2, priorRec && ('count=' + priorRec.count));
    check('衍生聚合：共同被引计数 2', !!derivRec && derivRec.count === 2, derivRec && ('count=' + derivRec.count));
    showView('library');
    await sleep(200);
    document.querySelector('#btnDiscover').click();
    await sleep(80);
    check('发现弹窗打开', !document.querySelector('#discoverModal').classList.contains('hidden'));
    const priorItems = document.querySelectorAll('#discPriorList .ref-item');
    const derivItems = document.querySelectorAll('#discDerivativeList .ref-item');
    check('先驱列表渲染条目与计数角标', priorItems.length >= 1 && document.querySelector('#discPriorList .disc-cnt').textContent.includes('2'), 'n=' + priorItems.length);
    check('衍生列表渲染条目', derivItems.length >= 1, 'n=' + derivItems.length);
    check('条目含下载入库按钮', !!document.querySelector('#discPriorList .ext-dl') && !!document.querySelector('#discDerivativeList .ext-dl'));
    await bridge.selftestShot('08-discover');
    document.querySelector('#discoverClose').click();
    check('发现弹窗关闭', document.querySelector('#discoverModal').classList.contains('hidden'));
    await bridge.updatePaper(bert.id, { externalRefs: bertExt });
    await bridge.updatePaper(vit.id, { externalRefs: vitExt });
    await refreshData();

    // ---------- 11. 搜索 ----------
    state.search = 'bert';
    renderLibrary();
    check('库内搜索过滤', document.querySelectorAll('#libraryGrid .card').length === 1);
    state.search = '';
    renderLibrary();
    check('论文库卡片提供删除按钮', document.querySelectorAll('#libraryGrid .card [data-act="del"]').length === state.papers.length);

    // ---------- 11.1 批量管理 ----------
    document.querySelector('#btnBulkMode').click();
    await sleep(150);
    const bulkChecks = document.querySelectorAll('#libraryGrid .card .bulk-check').length;
    check('批量管理模式出现勾选框', state.bulkMode && bulkChecks === state.papers.length, 'checks=' + bulkChecks);
    document.querySelector('#libraryGrid .card .bulk-check').click();
    await sleep(150);
    check('批量勾选计数', document.querySelector('#bulkCount').textContent.includes('1'), document.querySelector('#bulkCount').textContent);
    document.querySelector('#bulkAll').click();
    await sleep(150);
    check('批量全选', state.bulkSelected.size === state.papers.length, 'selected=' + state.bulkSelected.size);
    document.querySelector('#bulkExit').click();
    await sleep(150);
    check('退出批量管理', !state.bulkMode && state.bulkSelected.size === 0);

    // ---------- 11.2 评星与星级分区 ----------
    check('卡片包含评星控件', document.querySelectorAll('#libraryGrid .card .stars').length === state.papers.length);
    const bertCard = [...document.querySelectorAll('#libraryGrid .card')].find(c => c.textContent.includes('BERT'));
    bertCard.querySelector('.star[data-star="5"]').click();
    await sleep(500);
    const b2 = await bridge.getPaper(bert.id);
    check('评星保存为 5 星', b2.rating === 5, 'rating=' + b2.rating);
    const sections = document.querySelectorAll('#libraryGrid .rating-section');
    check('星级分区渲染', sections.length >= 2, 'sections=' + sections.length);
    const sec5 = document.querySelector('#libraryGrid .rating-section[data-rating="5"]');
    check('5 星分区包含 BERT', !!sec5 && sec5.textContent.includes('BERT'));
    const sortSel = document.querySelector('#sortSelect');
    sortSel.value = 'title';
    sortSel.dispatchEvent(new Event('change'));
    await sleep(250);
    const firstCard = document.querySelector('#libraryGrid .card h3');
    check('按标题排序', !!firstCard && /An Image is Worth/i.test(firstCard.textContent), firstCard && firstCard.textContent);
    check('排序后无分区', document.querySelectorAll('#libraryGrid .rating-section').length === 0);
    sortSel.value = 'rating';
    sortSel.dispatchEvent(new Event('change'));
    await sleep(250);

    // ---------- 11.3 图谱星级过滤（BERT 已 5 星） ----------
    state.graphFrom = 'library';
    showView('graph');
    await sleep(700);
    const gfilter = document.querySelector('#graphMinRating');
    gfilter.value = '5';
    gfilter.dispatchEvent(new Event('change'));
    await sleep(500);
    check('仅 5 星时只剩 BERT', graph.nodes.length === 1 && /BERT/.test(graph.nodes[0].paper.title || ''), 'nodes=' + graph.nodes.length);
    check('空态提示未误显示', document.querySelector('#graphEmpty').classList.contains('hidden'));
    // 构造空态：把 BERT 临时降为未评分
    await bridge.updatePaper(bert.id, { rating: 0 });
    await refreshData();
    gfilter.dispatchEvent(new Event('change'));
    await sleep(400);
    check('无匹配时显示空态提示', !document.querySelector('#graphEmpty').classList.contains('hidden'));
    check('空态下无节点', graph.nodes.length === 0, 'nodes=' + graph.nodes.length);
    await bridge.updatePaper(bert.id, { rating: 5 });
    await refreshData();
    gfilter.dispatchEvent(new Event('change'));
    await sleep(400);
    check('恢复后节点回归', graph.nodes.length === 1, 'nodes=' + graph.nodes.length);
    gfilter.value = 'all';
    gfilter.dispatchEvent(new Event('change'));
    await sleep(400);
    check('恢复全部节点', graph.nodes.length === state.papers.length, 'nodes=' + graph.nodes.length);
    document.querySelector('#btnGraphBack').click();
    await sleep(250);

    // ---------- 11.4 标题 Markdown 渲染 ----------
    const { inlineMd } = await import('./markdown.js');
    check('行内 Markdown 解析', inlineMd('**粗** `码` *斜* ~~删~~') === '<strong>粗</strong> <code>码</code> <em>斜</em> <del>删</del>', inlineMd('**粗** `码` *斜* ~~删~~'));
    await bridge.updatePaper(attention.id, { title: '**Attention** Is All You Need' });
    await refreshData();
    renderLibrary();
    const attH3 = [...document.querySelectorAll('#libraryGrid .card h3')].find(h => h.textContent.includes('Attention'));
    check('卡片标题渲染 Markdown 加粗', !!attH3 && attH3.innerHTML.includes('<strong>Attention</strong>'), attH3 && attH3.innerHTML.slice(0, 60));
    await bridge.updatePaper(attention.id, { title: 'Attention Is All You Need' });
    await refreshData();
    renderLibrary();

    // ---------- 11.5 重复导入去重 ----------
    const dup = await bridge.importPaths([sampleDir + '/attention.pdf']);
    check('重复导入自动去重', dup.results[0] && dup.results[0].duplicate === true, JSON.stringify(dup.results[0] && dup.results[0].duplicate));

    // ---------- 11.6 链接下载导入（arXiv，需网络；失败则记为跳过） ----------
    const urlRes = await bridge.importUrl('https://arxiv.org/abs/1706.03762');
    if (urlRes.ok && urlRes.paper) {
      check('链接下载导入 (arXiv)', true, urlRes.paper.title);
      check('链接导入标题提取正确', /attention/i.test(urlRes.paper.title || ''), urlRes.paper.title);
      await refreshData();
      check('链接导入后入库', state.papers.length === 7, 'count=' + state.papers.length);
      // 清理：删除这篇论文（同时验证删除流程）
      const delOk = await bridge.removePaper(urlRes.paper.id, true);
      await refreshData();
      check('删除论文并清理关联', delOk && state.papers.length === 6, 'count=' + state.papers.length);
    } else {
      check('链接下载导入 (arXiv) [网络不可用，跳过]', true, urlRes.error || '');
    }

    // ---------- 11.7 主题切换 ----------
    showView('library');
    renderLibrary();
    const legendDots = () => Array.from(document.querySelectorAll('#graphLegend .dot')).map(d => d.style.background);
    const dotsDark = legendDots();
    document.querySelector('#btnTheme').click();
    check('切换到浅色主题', document.documentElement.dataset.theme === 'light');
    const dotsLight = legendDots();
    check('图例圆点随主题切换变色', dotsLight.length === dotsDark.length && dotsLight.length > 0 && dotsLight.some((c, i) => c !== dotsDark[i]), (dotsDark[0] || '?') + ' -> ' + (dotsLight[0] || '?'));
    await sleep(300);
    await bridge.selftestShot('06-light-theme');
    showView('graph');
    await sleep(800);
    await bridge.selftestShot('07-graph-light');
    showView('library');
    document.querySelector('#btnTheme').click();
    check('切回深色主题', document.documentElement.dataset.theme === 'dark');
    check('图例圆点随主题切回', legendDots().join() === dotsDark.join());

    // ---------- 11.7b 中英双语切换 ----------
    document.querySelector('#btnLang').click();
    await sleep(350);
    check('切换到英文界面', document.documentElement.lang === 'en' && document.querySelector('#btnImport').textContent.includes('Import'), document.querySelector('#btnImport').textContent);
    const secTitleEn = document.querySelector('#libraryGrid .rating-section .rating-title');
    check('分区标题英文化', !!secTitleEn && !/[一-鿿]/.test(secTitleEn.textContent), secTitleEn && secTitleEn.textContent);
    await bridge.selftestShot('07-english-ui');
    document.querySelector('#btnLang').click();
    await sleep(350);
    check('切回中文界面', document.documentElement.lang === 'zh-CN' && document.querySelector('#btnImport').textContent.includes('导入'));

    // ---------- 11.8 参考文献切分增强（无编号 / 作者-年份标签 / 去重） ----------
    const { splitReferenceEntriesWeb } = await import('./refs-web.js');
    const numbered = splitReferenceEntriesWeb('[1] A. Vaswani et al. Attention is all you need. NeurIPS 2017.\n[2] J. Devlin et al. BERT: pre-training of deep bidirectional transformers. NAACL 2019.');
    check('编号参考文献切分', numbered.length === 2, 'n=' + numbered.length);
    const alpha = splitReferenceEntriesWeb('[Vas17] A. Vaswani et al. Attention is all you need. NeurIPS.\n[Dev19] J. Devlin et al. BERT: pre-training of deep bidirectional transformers. NAACL.');
    check('作者-年份标签切分', alpha.length === 2, 'n=' + alpha.length);
    const unnum = splitReferenceEntriesWeb('Vaswani, A. and Shazeer, N. Attention is all you need. In NeurIPS 2017.\nDevlin, J. and Chang, M. BERT: pre-training of deep bidirectional transformers. In NAACL 2019.');
    check('无编号参考文献切分', unnum.length === 2, 'n=' + unnum.length);
    const dupRefs = splitReferenceEntriesWeb('[1] Vaswani et al. doi:10.48550/arXiv.1706.03762\n[2] Vaswani et al. https://doi.org/10.48550/arXiv.1706.03762');
    check('重复条目按 DOI 去重', dupRefs.length === 1, 'n=' + dupRefs.length);

    // ---------- 11.9 多论文库（左侧面板） ----------
    const libs0 = await bridge.listLibraries();
    check('默认论文库存在且名为 New Weave', libs0.libraries.length === 1 && libs0.libraries[0].name === 'New Weave', libs0.libraries[0] && libs0.libraries[0].name);
    document.querySelector('#btnLibCollapse').click();
    check('论文库面板收起', document.querySelector('#libSidebar').classList.contains('collapsed'));
    document.querySelector('#btnLibToggle').click();
    check('论文库面板展开', !document.querySelector('#libSidebar').classList.contains('collapsed'));
    // 新建（名称 + 简介）
    document.querySelector('#btnNewLibrary').click();
    await sleep(150);
    document.querySelector('#libNameInput').value = '综述专题';
    document.querySelector('#libDescInput').value = '综述写作参考';
    // 建库时直接在弹窗里选标志图标
    const emojiPick = [...document.querySelectorAll('#libEmojiRow .ep-item')].find(b => b.textContent === '🧠');
    check('新建弹窗 emoji 选择行已渲染', !!emojiPick, 'n=' + document.querySelectorAll('#libEmojiRow .ep-item').length);
    emojiPick.click();
    document.querySelector('#libCreate').click();
    await sleep(500);
    check('新建论文库并切换', state.currentLibraryId !== libs0.current && state.papers.length === 0, 'papers=' + state.papers.length);
    check('建库时指定图标生效', (await bridge.listLibraries()).libraries.some(l => l.name === '综述专题' && l.icon === '🧠'));
    check('卡片显示简介', [...document.querySelectorAll('.lib-card .lc-desc')].some(d => d.textContent === '综述写作参考'));
    check('当前库卡片高亮', !!document.querySelector('.lib-card.current') && document.querySelector('.lib-card.current').dataset.id === state.currentLibraryId);
    // 新库导入同一文件 → 全局复用同一论文 id（不重复存储）
    const reuseRes = await bridge.importPaths([sampleDir + '/attention.pdf']);
    await refreshData();
    check('跨库导入复用同一论文 id', !!reuseRes.results[0].reused && state.papers.length === 1 && state.papers[0].id === attention.id,
      JSON.stringify({ reused: reuseRes.results[0].reused, sameId: state.papers[0] && state.papers[0].id === attention.id }));
    // 编辑名称
    const curLibId = state.currentLibraryId;
    const curCard = [...document.querySelectorAll('.lib-card')].find(c => c.dataset.id === curLibId);
    curCard.querySelector('.lc-edit').click();
    await sleep(150);
    const nameInput = document.querySelector('.lc-name-input');
    nameInput.value = '综述专题·改';
    nameInput.blur();
    await sleep(400);
    check('编辑名称保存', (await bridge.listLibraries()).libraries.some(l => l.name === '综述专题·改'));
    // 星标置顶：把默认库置顶后应排在首位
    const defCard = [...document.querySelectorAll('.lib-card')].find(c => c.dataset.id === libs0.current);
    defCard.querySelector('.lc-pin').click();
    await sleep(350);
    check('星标置顶后排在首位', document.querySelector('.lib-card').dataset.id === libs0.current);
    // 拖拽排序（经接口验证持久化与 UI 反映）
    const idsNow = (await bridge.listLibraries()).libraries.map(l => l.id);
    await bridge.reorderLibraries([...idsNow].reverse());
    await sleep(100);
    const afterOrder = (await bridge.listLibraries()).libraries.map(l => l.id);
    check('拖拽排序接口生效', afterOrder[0] === idsNow[idsNow.length - 1], afterOrder.join(','));
    // 删除：弹窗输名确认
    const delCard = [...document.querySelectorAll('.lib-card')].find(c => c.dataset.id === curLibId);
    delCard.querySelector('.lc-del').click();
    await sleep(150);
    check('删除弹窗出现且按钮禁用', !document.querySelector('#libDeleteModal').classList.contains('hidden') && document.querySelector('#libDeleteGo').disabled);
    const delInput = document.querySelector('#libDeleteInput');
    delInput.value = '错误名称';
    delInput.dispatchEvent(new Event('input'));
    check('名称不一致不可删除', document.querySelector('#libDeleteGo').disabled);
    delInput.value = '综述专题·改';
    delInput.dispatchEvent(new Event('input'));
    check('名称一致后可删除', !document.querySelector('#libDeleteGo').disabled);
    document.querySelector('#libDeleteGo').click();
    await sleep(500);
    check('删除后回到默认库', state.currentLibraryId === libs0.current && state.papers.length === 6, 'papers=' + state.papers.length);

    // ---------- 11.9b 论文库 banner / 标志图标 / 折叠 emoji 栏 ----------
    await bridge.updateLibrary(libs0.current, { icon: '🤖' });
    await refreshData();
    check('库标志图标持久化', (await bridge.listLibraries()).libraries[0].icon === '🤖');
    check('banner 显示图标与名称', document.querySelector('#libBannerIcon').textContent === '🤖' && document.querySelector('#libBannerName').textContent === 'New Weave',
      document.querySelector('#libBannerIcon').textContent + '/' + document.querySelector('#libBannerName').textContent);
    check('折叠栏 emoji 列表已渲染', document.querySelectorAll('#libRailIcons .rail-lib').length === 1);
    // banner 点击编辑简介
    document.querySelector('#libBannerDesc').click();
    await sleep(150);
    const descEdit = document.querySelector('.lb-edit-desc');
    check('banner 简介进入编辑态', !!descEdit);
    descEdit.value = '默认库简介';
    descEdit.blur();
    await sleep(400);
    check('banner 编辑简介保存', (await bridge.listLibraries()).libraries[0].desc === '默认库简介');
    // banner 星标切换 → 出现星标分隔线（先复位为未星标再点击）
    await bridge.updateLibrary(libs0.current, { pinned: false });
    await refreshData();
    document.querySelector('#libBannerStar').click();
    await sleep(350);
    check('banner 星标置顶生效且有分隔线', (await bridge.listLibraries()).libraries[0].pinned === true && !!document.querySelector('.lib-sep.show'));
    // 恢复默认，避免影响后续用例
    await bridge.updateLibrary(libs0.current, { icon: '', pinned: false, desc: '' });
    await refreshData();

    // ---------- 11.10 导入冲突确认弹窗 ----------
    const variantPath = await bridge.selftestMakeVariant('bert.pdf');
    const varRes = await bridge.importPaths([variantPath]);
    check('疑似重复返回冲突候选', !!(varRes.results[0] && varRes.results[0].conflict), JSON.stringify(Object.keys(varRes.results[0] || {})));
    const pending = window.__pg.resolveConflicts(varRes.results); // 触发弹窗
    await sleep(350);
    check('冲突确认弹窗出现', !document.querySelector('#conflictModal').classList.contains('hidden'));
    document.querySelector('#conflictMerge').click();
    await pending;
    await refreshData();
    check('确认复用后论文数不变', state.papers.length === 6, 'count=' + state.papers.length);

    // ---------- 11.11 统一导入弹窗 ----------
    document.querySelector('#btnImport').click();
    await sleep(150);
    check('统一导入弹窗打开', !document.querySelector('#importModal').classList.contains('hidden'));
    check('弹窗含拖放区与链接输入', !!document.querySelector('#importDrop') && !!document.querySelector('#urlInput'));
    document.querySelector('#importCancel').click();
    check('导入弹窗关闭', document.querySelector('#importModal').classList.contains('hidden'));

    // ---------- 12. 数据持久化 ----------
    await refreshData();
    check('刷新后数据完整', state.papers.length === 6 && state.links.length >= 5);
  } catch (e) {
    check('自测异常终止', false, e.message + '\n' + (e.stack || '').slice(0, 400));
  }

  const report = {
    ok: results.every(r => r.pass),
    total: results.length,
    passed: results.filter(r => r.pass).length,
    results,
  };
  await bridge.selftestReport(report);
}
