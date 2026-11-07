// PDF 参考文献定位与无编号条目切分回归
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractPdfInfo, extractRefText, findReferencesBody } = require('../main/importer');
const { splitReferenceEntries } = require('../main/refs');

(async () => {
  const sample = path.join(__dirname, '..', '.tmp', '2603.01966.pdf');
  if (fs.existsSync(sample)) {
    const info = await extractPdfInfo(fs.readFileSync(sample));
    const entries = splitReferenceEntries(info.refText);
    assert.equal(info.pageCount, 38);
    assert.equal(entries.length, 37, 'arXiv 2603.01966 第 11–13 页应有 37 条参考文献');
    assert.ok(entries.filter(e => /arXiv:/i.test(e)).length >= 10);
    assert.ok(entries.some(e => /Mem0: Building production-ready ai agents/i.test(e)));
    assert.ok(entries.every(e => !/Published as a conference paper/i.test(e)));
    assert.doesNotMatch(info.refText, /A THE USE OF LARGE LANGUAGE MODELS/);
    console.log('PASS arXiv 2603.01966：37 条无编号参考文献与附录截断');
  } else {
    console.log('SKIP 未找到 .tmp/2603.01966.pdf，跳过真实论文回归');
  }

  assert.equal(typeof findReferencesBody, 'function');
  assert.equal(typeof extractRefText, 'function');
  const body = findReferencesBody([
    'Published as a conference paper at ICLR 2026',
    'REFERENCES',
    'OpenAI. Introducing a model, 2025. URL https://openai.com/model.',
    'Prateek Chhikara, Dev Khant. Mem0: Building production-ready agents with long-',
    'term memory. arXiv preprint arXiv:2504.19413, 2025.',
    'Z.ai. GLM-4.6, 2025. URL https://z.ai/model.',
    'A APPENDIX',
    'This text is not a reference.',
  ].join('\n'));
  assert.ok(body);
  const entries = splitReferenceEntries(body);
  assert.equal(entries.length, 3);
  assert.match(entries[1], /long-term memory/);
  assert.doesNotMatch(body, /not a reference/);
  console.log('PASS 机构作者、普通作者、跨行断词与附录截断');

  // 参考文献在倒数 24 页之前时，扩窗仍必须保持原始页序。
  const doc = {
    numPages: 40,
    async getPage(number) {
      return {
        async getTextContent() {
          if (number === 10) return { items: [{ str: 'REFERENCES' }, { str: '[1] First ordered reference. Journal 2020.' }] };
          if (number === 11) return { items: [{ str: '[2] Second ordered reference. Journal 2021.' }] };
          if (number === 12) return { items: [{ str: 'APPENDIX' }, { str: 'Not a reference.' }] };
          return { items: [{ str: number < 10 ? 'INTRODUCTION BODY' : 'APPENDIX BODY' }] };
        },
      };
    },
  };
  const ordered = await extractRefText(doc, items => items.map(item => item.str));
  assert.match(ordered, /First ordered reference/);
  assert.match(ordered, /Second ordered reference/);
  assert.ok(ordered.indexOf('First ordered') < ordered.indexOf('Second ordered'));
  assert.doesNotMatch(ordered, /INTRODUCTION BODY/);
  console.log('PASS 自适应扩窗保持页序且不吸入前文');

  const webPath = path.join(__dirname, '..', 'renderer', 'refs-web.js');
  const source = fs.readFileSync(webPath, 'utf8');
  const web = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.deepEqual(web.splitReferenceEntriesWeb(body), entries);
  const pdfMetaSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pdfmeta.js'), 'utf8');
  assert.match(pdfMetaSource, /async function extractRefTextWeb/);
  assert.doesNotMatch(pdfMetaSource, /const refStart = Math\.max/);
  console.log('PASS 浏览器与主进程无编号条目切分及自适应提取一致');
})().catch(err => { console.error(err); process.exit(1); });
