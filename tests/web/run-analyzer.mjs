#!/usr/bin/env node
// run-analyzer.mjs — 以 headless 瀏覽器執行網頁分析器，取回結果 JSON 與文字報告。
//
// 先以 `node scripts/build.mjs` 建置（約 1 秒），測的一定是目前原始碼建置出的 dist/sync-analyzer.html。
// 啟動本機 http 伺服器（127.0.0.1、隨機埠）提供 repo 根目錄，以 headless 瀏覽器開啟 tests/web/harness.html；
// 外框頁在同源 iframe 載入分析器、把測試檔交給它，分析完成後把結果 POST 回伺服器。只用 node 內建模組。
//
// 瀏覽器：環境變數 BROWSER，否則依序找 Chrome、Edge（Windows、Linux、macOS 常見路徑）。
// 不加 --disable-gpu（硬體解碼與實際使用相同）；不用 --virtual-time-budget（AAC 的 MP4 會卡住），改以逾時保護。
// 結束時只停止自己啟動的瀏覽器（以 PID 指定，連同它的子程序）。
//
// 用法：
//   node tests/web/run-analyzer.mjs a.wav b.m4a --av --lang zh-Hant --out result.json
//   node tests/web/run-analyzer.mjs x.mp4 --report report.txt      # 另存文字報告
// 輸出 JSON：{ results: [...分析器的 window.__results...], report: 文字報告, errors: [...], elapsedS, tzOffsetMin, ... }
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Content-Type 自己指定，不依賴系統設定。
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// PATH 中名為 name 的執行檔（Windows 另試 PATHEXT 的副檔名）。
function which(name) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE').split(';')] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter))
    for (const e of exts) {
      const p = path.join(dir, name + e);
      if (dir && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  return null;
}

export function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  for (const c of BROWSER_CANDIDATES) {
    const p = path.isAbsolute(c) ? c : which(c);
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome 或 Edge；請以環境變數 BROWSER 指定瀏覽器執行檔');
}

function browserArgs(profile, url) {
  const args = ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];
  // Ubuntu 24.04 的 AppArmor 限制非特權 user namespace，Chrome 的沙箱在 CI 上起不來；只開本機測試頁，不需要沙箱。
  if (process.platform === 'linux') args.push('--no-sandbox');
  return [...args, url];
}

// 只停止自己啟動的瀏覽器（連同它的子程序，以 PID 指定）。
async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise(r => proc.once('exit', r));
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* 已經結束 */ }
  const timer = new Promise(r => setTimeout(r, 10000, 'timeout'));
  if (await Promise.race([exited, timer]) === 'timeout') {
    try { process.kill(process.platform === 'win32' ? proc.pid : -proc.pid, 'SIGKILL'); } catch { /* 已經結束 */ }
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  }
}

// 建置網頁到 dist/；失敗時丟出錯誤。
export function build() {
  const p = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { encoding: 'utf8' });
  if (p.status) throw new Error('建置失敗（需先 npm ci）：\n' + (p.stderr || '').slice(-2000));
}

// repo 根目錄照常提供；/__files/<序號>/<檔名> 對應命令列給的測試檔；POST /__result 收結果。
function serve(files, onResult) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST') {
      if (u.pathname !== '/__result') { res.writeHead(404).end(); return; }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => { res.writeHead(204).end(); onResult(JSON.parse(Buffer.concat(chunks).toString('utf8'))); });
      return;
    }
    const parts = decodeURIComponent(u.pathname).split('/');
    const given = parts[1] === '__files' && /^\d+$/.test(parts[2]) && +parts[2] < files.length;
    let file = given ? files[+parts[2]] : path.join(ROOT, ...parts);
    if (!given && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
}

// 建置後分析 files（路徑清單，依序交給分析器），回傳外框頁 POST 回來的物件。逾時或瀏覽器提前結束時丟出錯誤。
export async function run(files, { av = false, lang = 'zh-Hant', full = false, minute = false, only = null, dist = 0,
  timeout = 300, browser = null } = {}) {
  files = files.map(f => path.resolve(f));
  build();
  for (const f of files) if (!fs.existsSync(f)) throw new Error('找不到 ' + f);
  const exe = browser || findBrowser();
  let gotResult;
  const result = new Promise(r => { gotResult = r; });
  const srv = serve(files, gotResult);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const q = new URLSearchParams();
  files.forEach((f, i) => q.append('f', `/__files/${i}/${encodeURIComponent(path.basename(f))}`));
  for (const [k, v] of Object.entries({ lang, av: av ? 1 : 0, full: full ? 1 : 0, minute: minute ? 1 : 0, only: only || '', dist, timeout }))
    q.append(k, String(v));
  const url = `http://127.0.0.1:${srv.address().port}/tests/web/harness.html?${q}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-analyzer-'));
  const t0 = performance.now();
  const proc = spawn(exe, browserArgs(profile, url), { stdio: 'ignore', detached: process.platform !== 'win32' });
  try {
    const exited = new Promise((_, rej) => {
      proc.once('error', e => rej(new Error(`瀏覽器無法啟動：${exe}（${e.message}）`)));
      proc.once('exit', code => rej(new Error(`瀏覽器提前結束（結束碼 ${code}）：${exe}`)));
    });
    exited.catch(() => {});        // 拿到結果後收掉瀏覽器時也會觸發，那時不是錯誤
    // 外框頁自己也有同樣的逾時；這裡多留 30 秒給瀏覽器啟動，再沒有結果就當作卡住。
    let timer;
    const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`逾時 ${timeout + 30} 秒沒有結果`)), (timeout + 30) * 1000); });
    try {
      const res = await Promise.race([result, exited, late]);
      res.browser = exe;
      res.wallS = (performance.now() - t0) / 1000;
      return res;
    } finally { clearTimeout(timer); }
  } finally {
    await stop(proc);
    await new Promise(r => srv.close(r));
    srv.closeAllConnections?.();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
  const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
    av: { type: 'boolean' }, full: { type: 'boolean' }, minute: { type: 'boolean' }, only: { type: 'string' },
    dist: { type: 'string', default: '0' }, lang: { type: 'string', default: 'zh-Hant' }, timeout: { type: 'string', default: '300' },
    out: { type: 'string' }, report: { type: 'string' } } });
  if (!positionals.length) { console.error('用法：node tests/web/run-analyzer.mjs 檔案… [--av] [--full] [--minute] [--only head|tail] [--dist 公尺] [--lang zh-Hant|en|ja|ko] [--timeout 秒] [--out 結果.json] [--report 報告.txt]'); return 2; }
  if (a.only && !['head', 'tail'].includes(a.only)) { console.error('--only 只能是 head 或 tail'); return 2; }
  const res = await run(positionals, { av: a.av, full: a.full, minute: a.minute, only: a.only, dist: +a.dist, lang: a.lang, timeout: +a.timeout });
  const text = JSON.stringify(res, null, 2) + '\n';
  if (a.out) fs.writeFileSync(a.out, text); else process.stdout.write(text);
  if (a.report) fs.writeFileSync(a.report, res.report || '');
  for (const e of res.errors || []) console.error('錯誤：' + e);
  console.error(`${positionals.length} 個檔案，分析 ${(res.elapsedS || 0).toFixed(1)} 秒（含瀏覽器啟動 ${res.wallS.toFixed(1)} 秒）`);
  return res.ok && !(res.errors || []).length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
