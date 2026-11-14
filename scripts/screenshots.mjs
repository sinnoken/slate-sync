#!/usr/bin/env node
// screenshots.mjs — 重拍 docs/images/ 的文件截圖（場記板與分析器，英文與繁中各一套），存成調色盤 PNG。
//
// 流程：建置 dist/ → 啟動提供 dist/ 與測試檔的本機伺服器 → 每種語言各啟動一次 headless 瀏覽器（同時只開一個），
// 以 Chrome DevTools Protocol（Node 內建的 WebSocket）依 SHOTS 操作並截圖 → ffmpeg 轉成調色盤 PNG 寫進 docs/images/。
// 只用 Node 內建模組；需要 ffmpeg 在 PATH 上。
//
// 用法：
//   npm run screenshots                  # 全部重拍
//   npm run screenshots -- slate-tag     # 只拍檔名含這些字串的截圖
// 瀏覽器：與網頁測試共用 tests/web/run-analyzer.mjs 的 findBrowser()（環境變數 BROWSER，否則找常見安裝位置）。
// 需要 Node 22 以上（全域 WebSocket）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../tests/web/run-analyzer.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'docs', 'images');
const MAX_BYTES = 400 * 1024;

// 介面語言、檔名後綴與瀏覽器語言。瀏覽器語言要跟著換：<input type="time"> 等原生控制項依瀏覽器語言顯示
// （英文介面在中文系統上會出現「上午 08:56」），所以每種語言各啟動一次瀏覽器並加 --lang。
const LOCALES = [
  { suffix: 'en', lang: 'en', browserLang: 'en-US' },
  { suffix: 'zh-TW', lang: 'zh-Hant', browserLang: 'zh-TW' },
];

// 截圖清單：每項在每種語言各拍一張，檔名為 `${name}-${suffix}.png`。新增截圖只改這裡。
//   page：'slate'（手機尺寸，DPR 3）或 'analyzer'（桌機尺寸，DPR 1）
//   size：[寬, 高]（CSS px）
//   steps(p)：載入並按過「開始使用」後的操作
//   capture：'viewport'、'page'（整頁）、'sheet'（場記板設定頁整頁）或 { clip: 選擇器 }（元素四周留 16 px）
const SHOTS = [
  { name: 'slate-portrait', page: 'slate', size: [390, 844], capture: 'viewport',
    steps: async p => { await p.blackHalf(); } },
  { name: 'slate-countdown', page: 'slate', size: [390, 844], capture: 'viewport',
    steps: async p => {
      await p.click('#mCd'); await p.click('#chips .chip[data-dur="300"]');
      await p.wait(3400);                      // 進行中：剩 4:56 左右，狀態列顯示「倒數中」
      await p.blackHalf();
    } },
  { name: 'slate-tag', page: 'slate', size: [390, 844], capture: 'viewport',
    steps: async p => { await p.click('#mTag'); await p.wait(800); await p.blackHalf(); } },
  { name: 'slate-ltc', page: 'slate', size: [390, 844], capture: 'viewport',
    // LTC 行在 AudioContext 開始輸出後（約 0.4 s）才有時間碼，之前顯示「LTC 準備中」。
    steps: async p => { await p.click('#mLtc'); await p.wait(1500); await p.blackHalf(); } },
  { name: 'slate-landscape', page: 'slate', size: [844, 390], capture: 'viewport',
    steps: async p => { await p.blackHalf(); } },
  { name: 'slate-settings', page: 'slate', size: [390, 844], capture: 'sheet',
    steps: async p => { await p.click('#settingsBtn'); await p.wait(300); await p.blur(); } },
  { name: 'slate-schedule', page: 'slate', size: [390, 844], capture: 'viewport',
    steps: async p => { await p.click('#mCd'); await p.click('#schedBtn'); await p.wait(400); await p.blur(); } },
  // 自訂倒數平常從設定頁開（預設已有 2:00:00 的自訂長度，主畫面的「自訂」會直接開始倒數）。
  { name: 'slate-custom', page: 'slate', size: [390, 844], capture: 'viewport',
    steps: async p => { await p.click('#settingsBtn'); await p.wait(200); await p.click('#customEdit'); await p.wait(300); await p.blur(); } },
  { name: 'analyzer-full', page: 'analyzer', size: [1440, 900], capture: 'page',
    steps: async p => { await p.check('#optAv'); await p.analyze(['cam.mp4', 'picture.mp4']); } },
  // headless 不會把原生下拉選單畫進截圖，改把語言選單設成清單框（size＝選項數）來呈現展開的樣子；中文字較高，隱藏捲軸免得多出捲動箭頭。
  { name: 'analyzer-lang-menu', page: 'analyzer', size: [1440, 900], capture: 'viewport',
    steps: async p => { await p.ev(`(() => { const s = document.getElementById('lang'); s.size = s.options.length; s.style.overflow = 'hidden'; s.focus(); })()`); await p.wait(200); } },
  { name: 'analyzer-options', page: 'analyzer', size: [1440, 900], capture: { clip: '.opts' },
    steps: async () => {} },
];

// 分析器的測試檔：cam.mp4（波形碼＋畫面碼）與 picture.mp4（只有畫面碼）就涵蓋結果、聲畫同步、對齊與換算各區塊。
// 檔案以固定的修改時間（當地 12:30）交給分析器：沒有建立時間的檔案會用修改時間猜整點，否則報告隨 checkout 時間改變
// （tests/web/harness.html 同理）。wave.wav 等在 tests/fixtures/ 以 .gz 存放，也不需要。
const FIXTURES = ['cam.mp4', 'picture.mp4'];
const MTIME = 'new Date(2026, 0, 1, 12, 30, 0).getTime()';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.mp4': 'video/mp4' };

// 伺服器：/ 提供 dist/，/fixtures/ 提供分析器用的測試檔。
function serve() {
  const srv = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    // 分析器頁沒有指定圖示，瀏覽器會自己要 /favicon.ico；回 204，免得每張都記一筆 404。
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    let f;
    // 測試檔只提供清單裡的檔名；其餘路徑必須落在 dist/ 之內（擋掉 ../ 之類的路徑）。
    if (p.startsWith('/fixtures/')) {
      if (!FIXTURES.includes(p.slice(10))) { res.writeHead(404); res.end(); return; }
      f = path.join(ROOT, 'tests', 'fixtures', p.slice(10));
    } else {
      f = path.join(DIST, p.endsWith('/') ? p + 'index.html' : p);
      if (!f.startsWith(DIST + path.sep)) { res.writeHead(403); res.end(); return; }
    }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      res.end(d);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// 只停止自己啟動的瀏覽器（以 PID 指定，連同子程序）。
async function stopBrowser(proc) {
  if (!proc.pid) return;          // 沒有啟動成功
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise(r => proc.once('exit', r));
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* 已經結束 */ }
  await Promise.race([exited, new Promise(r => setTimeout(r, 10000))]);
}

async function launch(exe, profile, browserLang) {
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--lang=${browserLang}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-component-update',
    '--disable-background-networking', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const proc = spawn(exe, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  live.browser = proc;
  // 啟動失敗（找不到執行檔等）會發出 'error'，轉成 reject，不讓等待 port 的迴圈空等。
  const failed = new Promise((_, j) => proc.once('error', e => j(new Error(`無法啟動瀏覽器 ${exe}：${e.message}`))));
  failed.catch(() => {});        // 啟動成功之後才發生的錯誤不在這裡處理，避免成為未處理的 rejection
  let done = false;
  // --remote-debugging-port=0 讓瀏覽器自選埠，寫在 profile 的 DevToolsActivePort；檔案可能先建立、後寫入，讀到空值就再等。
  const portFile = path.join(profile, 'DevToolsActivePort');
  const waitPort = (async () => {
    for (let i = 0; i < 150 && !done; i++) {
      let port = '';
      try { port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(); } catch { /* 還沒建立 */ }
      if (/^\d+$/.test(port)) return port;
      await sleep(100);
    }
    throw new Error('等不到瀏覽器的 DevToolsActivePort（15 秒）');
  })();
  waitPort.catch(() => {});      // 啟動失敗而不再等待時，這個 promise 之後的 reject 不必處理
  try {
    return { proc, port: await Promise.race([waitPort, failed]) };
  } catch (e) {
    done = true;
    await stopBrowser(proc);
    throw e;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdp(port) {
  let list = [];
  for (let i = 0; i < 50 && !list.some(t => t.type === 'page'); i++) {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (!list.some(t => t.type === 'page')) await sleep(100);
  }
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const waiters = []; const problems = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); return; }
    // 頁面的錯誤與警告都收集起來，最後列出；有錯誤（不含警告）時以代碼 1 結束。
    if (m.method === 'Runtime.exceptionThrown') problems.push(['error', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text]);
    if (m.method === 'Runtime.consoleAPICalled' && /error|warning|assert/.test(m.params.type)) problems.push([m.params.type === 'warning' ? 'warning' : 'error', m.params.args.map(a => a.value ?? a.description).join(' ')]);
    if (m.method === 'Log.entryAdded' && /error|warning/.test(m.params.entry.level)) problems.push([m.params.entry.level, `${m.params.entry.text} ${m.params.entry.url || ''}`]);
    for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.r(m.params); }
  };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  const once = method => new Promise(r => waiters.push({ method, r }));
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  return { send, once, problems, close: () => ws.close() };
}

// 把值寫成可放進執行碼的 JS 字面值：JSON 之外再跳脫 < > / 與 U+2028／U+2029，字串無法跳出字面值。
const lit = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

// 每張截圖用的頁面操作；每張都從重新載入開始，彼此不互相影響。
function pageApi(c) {
  const p = {
    wait: sleep,
    async ev(expr, gesture = true) {
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: gesture });
      if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  in: ${expr.slice(0, 160)}`);
      return r.result.value;
    },
    click: sel => p.ev(`document.querySelector(${lit(sel)}).click()`),
    check: sel => p.ev(`(() => { const e = document.querySelector(${lit(sel)}); if (!e.checked) e.click(); })()`),
    // 開啟設定頁或對話框時焦點會移入第一個按鈕（無障礙行為），程式移入的焦點會畫出焦點框，拍照前先移開。
    blur: () => p.ev('document.activeElement && document.activeElement.blur()'),
    // 場記板的黑白方波每秒有半秒全白：等到黑色那半秒（毫秒 620–760）才拍，數字才看得清楚，每次結果也一致。
    blackHalf: () => p.ev(`new Promise(r => { const i = setInterval(() => { const m = Date.now() % 1000; if (m > 620 && m < 760) { clearInterval(i); setTimeout(r, 30); } }, 5); })`),
    async analyze(files) {
      await p.ev(`(async () => {
        const dt = new DataTransfer();
        for (const n of ${lit(files)}) {
          const b = await (await fetch('/fixtures/' + n)).blob();
          dt.items.add(new File([b], n, { type: b.type, lastModified: ${MTIME} }));
        }
        const pick = document.getElementById('pick'); pick.files = dt.files; pick.dispatchEvent(new Event('change'));
      })()`);
      await p.ev(`new Promise((r, j) => { const t0 = Date.now(); const i = setInterval(() => {
        if ((window.__done || 0) >= ${files.length}) { clearInterval(i); r(); }
        else if (Date.now() - t0 > 180000) { clearInterval(i); j(new Error('分析逾時')); } }, 100); })`);
      await sleep(800);
    },
  };
  return p;
}

async function size(c, w, h, dpr) {
  const mobile = dpr > 1;
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile,
    screenOrientation: w > h ? { type: 'landscapePrimary', angle: mobile ? 90 : 0 } : { type: 'portraitPrimary', angle: 0 } });
  await sleep(250);
}

async function load(c, url) {
  const loaded = c.once('Page.loadEventFired');
  await c.send('Page.navigate', { url }); await loaded;
}

async function shoot(c, base, shot, loc, rawFile) {
  const p = pageApi(c);
  const slate = shot.page === 'slate';
  const [w, h] = shot.size, dpr = slate ? 3 : 1;
  await size(c, w, h, dpr);
  const url = `${base}/${slate ? 'sync-slate.html' : 'sync-analyzer.html'}`;
  // localStorage 只能在頁面載入後設定（about:blank 不能存取），所以先載入一次、設定後再重新載入。
  // 用 127.0.0.1 而非 localhost：service worker 只在 localhost／https 註冊，避免拍到快取裡的舊版頁面。
  await load(c, url);
  await p.ev(`localStorage.clear(); localStorage.setItem('slate-lang', ${lit(loc.lang)});` +
    (slate ? ` localStorage.setItem('slate-tag', '12A');` : ''));
  await load(c, url);
  await p.ev('document.fonts.ready.then(() => true)');
  // 「開始使用」要有使用者手勢（userGesture）才會建立 AudioContext；LTC 行要等音訊開始輸出才有時間碼。
  if (slate) { await p.click('#go'); await sleep(700); }
  await shot.steps(p);
  const params = { format: 'png' };
  if (shot.capture === 'sheet') {
    // 設定頁是 position:fixed、自己捲動的圖層，captureBeyondViewport 拍不到下面的部分：把視窗拉高到整頁高度再拍。
    const full = await p.ev(`document.getElementById('sheetWrap').scrollHeight`);
    await size(c, w, full, dpr); await sleep(300);
  } else if (shot.capture === 'page') {
    const m = await c.send('Page.getLayoutMetrics');
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: w, height: Math.ceil(m.cssContentSize.height), scale: 1 };
  } else if (shot.capture.clip) {
    const r = await p.ev(`(() => { const b = document.querySelector(${lit(shot.capture.clip)}).getBoundingClientRect(); return { x: b.left, y: b.top + scrollY, w: b.width, h: b.height }; })()`);
    params.clip = { x: Math.round(r.x - 16), y: Math.round(r.y - 16), width: Math.round(r.w + 32), height: Math.round(r.h + 32), scale: 1 };
  }
  const shotData = await c.send('Page.captureScreenshot', params);
  fs.writeFileSync(rawFile, Buffer.from(shotData.data, 'base64'));
}

// 調色盤 PNG：介面只有少數顏色，256 色不抖動即可保持銳利，檔案約為全彩的三分之一。
function palettize(src, dst) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf',
    'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none', dst], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 轉檔失敗：${r.stderr || r.error}`);
}

// 執行中的瀏覽器、伺服器與暫存資料夾：正常結束、出錯或被中斷（Ctrl+C）時都由 cleanup() 收掉。
const live = { browser: null, srv: null, tmp: null };
async function cleanup() {
  const { browser, srv, tmp } = live;
  live.browser = live.srv = live.tmp = null;
  if (browser) await stopBrowser(browser);
  if (srv) srv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { console.error(`收到 ${sig}，收掉瀏覽器與伺服器後結束`); cleanup().finally(() => process.exit(130)); });
}

async function main() {
  // CDP 連線用全域 WebSocket，Node 22 起才有。
  if (typeof WebSocket === 'undefined') { console.error('截圖腳本需要 Node 22 以上'); process.exitCode = 1; return; }
  const t0 = Date.now();
  const filters = process.argv.slice(2);
  const jobs = SHOTS.flatMap(s => LOCALES.map(l => ({ shot: s, loc: l, file: `${s.name}-${l.suffix}.png` })))
    .filter(j => !filters.length || filters.some(f => j.file.includes(f)));
  if (!jobs.length) throw new Error(`沒有符合 ${filters.join(' ')} 的截圖`);
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('找不到 ffmpeg：請把 ffmpeg 加進 PATH');
  const exe = findBrowser();
  // 低優先權：子程序（建置、瀏覽器、ffmpeg）沿用這個優先權，截圖時不拖慢前景的工作。
  try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 不支援時照常執行 */ }

  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
  if (build.status !== 0) throw new Error('建置失敗');

  live.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-shots-'));
  live.srv = await serve();
  const base = `http://127.0.0.1:${live.srv.address().port}`;
  const problems = [];
  try {
    for (const loc of LOCALES) {
      const mine = jobs.filter(j => j.loc === loc);
      if (!mine.length) continue;
      // 同時只開一個瀏覽器：每種語言一個，拍完就收掉。
      const profile = fs.mkdtempSync(path.join(live.tmp, 'profile-'));
      const browser = await launch(exe, profile, loc.browserLang);
      const c = await cdp(browser.port);
      for (const j of mine) {
        const before = c.problems.length;
        const raw = path.join(live.tmp, j.file);
        try {
          await shoot(c, base, j.shot, loc, raw);
        } catch (e) {
          // 出錯時，頁面上已收集到的錯誤與警告常常就是原因，一起印出來。
          const seen = c.problems.slice(before);
          if (seen.length) console.error(`${j.file} 的頁面訊息：\n  ` + seen.map(([level, text]) => `[${level}] ${text}`).join('\n  '));
          throw new Error(`${j.file} 截圖失敗：${e.message}`, { cause: e });
        }
        palettize(raw, path.join(OUT, j.file));
        const bytes = fs.statSync(path.join(OUT, j.file)).size;
        console.log(`${j.file}  ${(bytes / 1024).toFixed(0)} KB${bytes > MAX_BYTES ? '  ⚠ 超過 400 KB' : ''}`);
        for (const [level, text] of c.problems.slice(before)) problems.push({ level, text: `${j.file}: ${text}` });
      }
      c.close();
      await stopBrowser(browser.proc); live.browser = null;
    }
  } finally {
    await cleanup();
  }
  console.log(`共 ${jobs.length} 張，${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  for (const level of ['warning', 'error']) {
    const list = [...new Set(problems.filter(x => x.level === level).map(x => x.text))];
    if (list.length) console.error(`頁面的${level === 'error' ? '錯誤' : '警告'}：\n  ` + list.join('\n  '));
  }
  if (problems.some(x => x.level === 'error')) process.exitCode = 1;
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
