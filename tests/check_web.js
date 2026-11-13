#!/usr/bin/env node
// check_web.js — 檢查三個網頁：<script> 語法正確；四種語言的字串 key 完全相同、{var} 一致；程式與標記用到的 key 都有定義。
// 用法：node tests/check_web.js
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PAGES = ['web/index.html', 'web/sync-slate.html', 'web/sync-analyzer.html'];
let failed = 0;

// Inline <script> blocks of our own pages, found by plain string search (the pages only use bare <script> tags).
function scripts(html) {
  const out = [];
  for (let a = html.indexOf('<script>'); a >= 0; a = html.indexOf('<script>', a)) {
    const b = html.indexOf('</script>', a);
    out.push(html.slice(a + 8, b));
    a = b;
  }
  return out;
}

for (const rel of PAGES) {
  const h = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const src = scripts(h).join('\n;\n');
  try {
    new vm.Script(src, { filename: rel });
  } catch (e) {
    console.log(`✗ ${rel}：語法錯誤 ${e.message}`);
    failed++;
    continue;
  }
  // I18N 物件：從 `I18N = {` 起找到對應的右括號（略過字串內容）
  const i = src.indexOf('{', src.search(/I18N\s*=\s*\{/));
  let d = 0, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'") { const q = c; j++; while (src[j] !== q) { if (src[j] === '\\') j++; j++; } continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) break; }
  }
  const D = vm.runInNewContext('(' + src.slice(i, j + 1) + ')');
  const langs = Object.keys(D), base = Object.keys(D['zh-Hant']).sort().join();
  const vars = (l, k) => (String(D[l][k]).match(/\{\w+\}/g) || []).sort().join();
  const used = [...h.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1])
    .concat([...h.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap(m => m[1].split(';').map(p => p.split(':')[1])))
    .concat([...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('.')));
  const problems = [];
  for (const l of langs) if (Object.keys(D[l]).sort().join() !== base) problems.push(`${l} 的 key 和 zh-Hant 不同`);
  const varBad = Object.keys(D['zh-Hant']).filter(k => langs.some(l => vars(l, k) !== vars('zh-Hant', k)));
  if (varBad.length) problems.push(`{var} 不一致：${varBad.join(', ')}`);
  const missing = [...new Set(used)].filter(k => !(k in D['zh-Hant']));
  if (missing.length) problems.push(`未定義的 key：${missing.join(', ')}`);
  if (problems.length) {
    failed++;
    console.log(`✗ ${rel}：${problems.join('；')}`);
  } else {
    console.log(`✓ ${rel}：語法正確，${langs.length} 種語言各 ${Object.keys(D['zh-Hant']).length} 個 key 一致`);
  }
}
console.log(failed ? `結果：${failed} 個檔案不符` : '結果：全部通過');
process.exit(failed ? 1 : 0);
