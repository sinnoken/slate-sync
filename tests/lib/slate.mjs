// slate.mjs — 從場記板 web/sync-slate.html 取出指定的 function 宣告與 var 宣告，在 node 的 vm 裡執行。
// 場記板是單一 HTML 檔、程式內嵌在 <script>，不能 import；這樣測試與測試產生器用的是場記板實際的程式，而不是另抄一份。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const SLATE = path.join(ROOT, 'web', 'sync-slate.html');

// src[start..] 起第一個 { 到對應 } 的結尾位置（取出的這些函式，字串與註解裡沒有大括號）。
function blockEnd(src, start) {
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && !--depth) return j + 1;
  }
  throw new Error('場記板的大括號不成對');
}

// 場記板中名為 names 的 function 宣告，或 var 宣告（取到該行的分號）的原始碼。
export function extract(names) {
  const html = fs.readFileSync(SLATE, 'utf8');
  return names.map(name => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m = new RegExp(`\\bfunction ${esc}\\(`).exec(html);
    if (m) return html.slice(m.index, blockEnd(html, m.index));
    m = new RegExp(`\\bvar ${esc}\\s*=`).exec(html);
    if (!m) throw new Error(`場記板找不到 ${name}`);
    return html.slice(m.index, html.indexOf(';', m.index) + 1);
  }).join('\n');
}

// 在新的 vm context 執行場記板的 names（globals 先放進 context，例如模擬的 AudioContext），回傳 context：
// 場記板的函式與變數都是它的屬性。日期依 process.env.TZ（node 執行中改 TZ 會立即生效）。
// vm 裡建立的陣列屬於另一個 realm，與測試的陣列比較前先用 Array.from() 或 JSON 轉成這邊的值。
export function loadSlate(names, globals = {}) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(extract(names), ctx, { filename: 'web/sync-slate.html' });
  return ctx;
}
