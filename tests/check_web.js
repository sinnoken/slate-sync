#!/usr/bin/env node
// check_web.js — 檢查三個網頁：程式語法正確；四種語言的字串 key 完全相同、{var} 一致；程式與標記用到的 key 都有定義。
// 首頁與場記板檢查 web/ 內嵌的 <script>；分析器檢查原始碼（src/web/sync-analyzer.html 範本與 src/ 下的模組），
// 語法以 esbuild 打包檢查（需先 npm ci）。
// 用法：node tests/check_web.js
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

const jsUnder = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? jsUnder(p) : p.endsWith('.js') ? [p] : [];
});

// [name, markup, script source, syntax error or null]
function inlinePage(rel) {
  const h = fs.readFileSync(path.join(ROOT, rel), 'utf8'), src = scripts(h).join('\n;\n');
  try { new vm.Script(src, { filename: rel }); return [rel, h, src, null]; } catch (e) { return [rel, h, src, e.message]; }
}
function analyzerPage() {
  const h = fs.readFileSync(path.join(ROOT, 'src/web/sync-analyzer.html'), 'utf8');
  const src = jsUnder(path.join(ROOT, 'src')).map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
  try {
    esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src/web/main.js')], bundle: true, write: false, logLevel: 'silent' });
    return ['分析器（src/）', h, src, null];
  } catch (e) { return ['分析器（src/）', h, src, e.message]; }
}

for (const [name, h, src, err] of [inlinePage('web/index.html'), inlinePage('web/sync-slate.html'), analyzerPage()]) {
  if (err) {
    console.log(`✗ ${name}：語法錯誤 ${err}`);
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
    console.log(`✗ ${name}：${problems.join('；')}`);
  } else {
    console.log(`✓ ${name}：語法正確，${langs.length} 種語言各 ${Object.keys(D['zh-Hant']).length} 個 key 一致`);
  }
}
console.log(failed ? `結果：${failed} 個檔案不符` : '結果：全部通過');
process.exit(failed ? 1 : 0);
