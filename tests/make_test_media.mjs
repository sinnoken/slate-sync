#!/usr/bin/env node
// make_test_media.mjs — 產生已知漂移量與起點的波形碼測試檔，用來驗證分析器。
//
// 輸出立體聲：左聲道為模擬現場收音，右聲道為波形碼（格式見 docs/waveform-code.md）。
// 檔案時間 = (真實時間 − 起點) × 速率，速率 = 1 + ppm × 10⁻⁶。
//
// 波形碼的脈衝排程（waveBursts）、載波（waveHz）、畫面碼的 tag（drawTag）與 LTC 的取樣（ltcChunk）都直接用
// 場記板本身的函式（src/core/slate.js），保證和場記板一致；場記板本身算錯時由 tests/*.test.mjs 的獨立比對抓到。
//
// 加 --ltc 時一個聲道改放場記板的 LTC（docs/ltc.md），合成方式與場記板相同（手機以真實時間輸出、錄音設備以自己的
// 時鐘取樣，每個取樣取區間平均以保留取樣之間的邊緣），另一個聲道放現場聲音或波形碼（--ltc-with）。
// --created 寫入檔案建立時間（docs/start-time.md），產生器印出真值。
//
// 加 --visual 時改為模擬攝影機拍攝場記板螢幕：畫面上是畫面碼（AprilTag，格式見 docs/visual-code.md），
// 聲音軌照舊是波形碼。攝影機時鐘（--ppm）同時影響畫面與聲音軌；--av-offset 讓畫面相對聲音晚（正值）或早。
// 每格的曝光區間以該格的時間為中心、長 --shutter 格，跨過整秒時新舊 tag 依時間比例混合。
// 畫面在 JS 算成灰階 raw 影格，經 stdin 交給 ffmpeg 編碼。需要 ffmpeg（PATH 中；WAV 輸出且不寫建立時間時不需要）。
//
// 用法見 --help 與 docs/testing.md。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as slate from '../src/core/slate.js';

export const SR = 48000;
export const VIS_MOD = 540;                // ID = 午夜起秒數 mod 540（9 分鐘一輪，一天剛好 160 輪）
const FPS = { '23.976': [24000, 1001], '24': [24, 1], '25': [25, 1], '29.97': [30000, 1001], '30': [30, 1], '50': [50, 1],
  '59.94': [60000, 1001], '60': [60, 1] };
const LTC_FPS = { '23.976': [24000 / 1001, 24], '24': [24, 24], '25': [25, 25], '29.97': [30000 / 1001, 30], '30': [30, 30] };


// ---------------------------------------------------------------- 參數
const OPTIONS = [
  ['', [
    ['minutes', 'number', 4, '檔案長度（分鐘），預設 4'],
    ['ppm', 'number', 833, '時鐘偏差（ppm），正值代表檔案比真實時間長'],
    ['start', 'string', '12:34:56.789', '檔案第 0 秒對應的真實時間'],
    ['plug', 'number', 0, '只在頭尾各這麼多秒放波形碼（0＝全程）'],
    ['ppm-end', 'number', null, '結尾時的時鐘偏差；與 --ppm 之間線性變化（預設同 --ppm）'],
  ]],
  ['LTC（--ltc，docs/ltc.md）', [
    ['ltc', Object.keys(LTC_FPS), null, '在一個聲道放場記板的 LTC（影格率）；從檔案起點後的第一個格邊界開始'],
    ['df', 'boolean', false, 'LTC 用 DF（只用於 29.97）'],
    ['ltc-channel', ['0', '1'], '1', 'LTC 所在聲道（0 起算），預設 1'],
    ['ltc-with', ['scene', 'code'], 'scene', '另一個聲道：scene＝現場聲音（預設）、code＝波形碼'],
    ['ltc-noise', 'number', null, 'LTC 聲道加上白雜訊：訊雜比（dB，以 LTC 方波為準）'],
    ['ltc-invert', 'boolean', false, 'LTC 反相（模擬錄音設備反相）'],
  ]],
  ['檔案建立時間（docs/start-time.md）', [
    ['created', ['start', 'end'], null, '寫入建立時間：start＝開始錄的時間、end＝存檔（結束）的時間。MP4／MOV／M4A 寫 creation_time（整數秒），WAV 寫 BWF time_reference（只能 start）'],
    ['created-offset', 'number', 0, '設備時鐘比場記板快幾秒，預設 0'],
    ['date', 'string', '2026-11-12', '錄音日期（本地），預設 2026-11-12'],
    ['tz', 'string', null, '本地時區，例如 +08:00；預設為這台電腦在該日期的時區'],
  ]],
  ['畫面碼影片（--visual）', [
    ['visual', 'boolean', false, '畫面改為攝影機拍到的場記板畫面碼（輸出須為 .mp4／.mov）'],
    ['fps', Object.keys(FPS), '59.94', '影格率，預設 59.94'],
    ['size', 'string', '1280x720', '解析度，預設 1280x720'],
    ['codec', ['h264', 'h265'], 'h264', '視訊編碼，預設 h264'],
    ['encoder', ['auto', 'nvenc', 'cpu'], 'auto', '視訊編碼器：auto＝先試 NVIDIA NVENC，不能用時改用 libx264／libx265（預設）；nvenc；cpu'],
    ['gop', 'number', 1, '關鍵格間隔（秒），預設 1'],
    ['tag-size', 'number', 0.4, 'tag（含靜區）佔畫面短邊的比例，預設 0.4'],
    ['blur', 'number', 0, '高斯模糊（像素），預設 0'],
    ['exposure', 'number', 0, '亮度與自動曝光起伏幅度（0.3 = 增益 ±30%），預設 0'],
    ['tilt', 'number', 0, '手機繞垂直軸的傾斜角（度），預設 0'],
    ['shutter', 'number', 0.5, '曝光時間（格），預設 0.5（180° 快門）'],
    ['av-offset', 'number', 0, '畫面相對聲音的偏移（ms），正值為畫面晚'],
    ['audio', ['code', 'scene', 'none'], 'code', '聲音軌：code＝波形碼（預設）、scene＝只有現場聲音、none＝沒有聲音軌'],
  ]],
];

const USAGE = `用法：node tests/make_test_media.mjs 輸出檔 [選項]
  輸出檔的副檔名決定格式：.wav、.m4a（AAC）、.mp4／.mov（另加測試畫面，或 --visual 的畫面碼）

例：
  node tests/make_test_media.mjs out.wav --minutes 4 --ppm 833 --start 12:34:56.789
  node tests/make_test_media.mjs out.wav --plug 70                 # 只有頭尾各 70 秒有波形碼
  node tests/make_test_media.mjs out.mp4 --minutes 4 --ppm -694    # 另以 ffmpeg 加上 59.94 fps 測試畫面
  node tests/make_test_media.mjs warm.wav --minutes 20 --ppm 800 --ppm-end 900   # 速率隨時間線性改變（機身變熱）
  node tests/make_test_media.mjs ltc.wav --ltc 29.97 --df --ltc-with code         # 右聲道 LTC，左聲道波形碼
  node tests/make_test_media.mjs cam.mp4 --created end --created-offset -0.6      # 結束型建立時間，設備慢 0.6 秒
  node tests/make_test_media.mjs rec.wav --created start --created-offset 1.5     # BWF time_reference
  node tests/make_test_media.mjs cam.mp4 --visual --fps 29.97 --av-offset 12      # 畫面碼影片，畫面比聲音晚 12 ms
  node tests/make_test_media.mjs cam.mp4 --visual --audio none --size 3840x2160 --codec h265 --plug 75`;

function help() {
  const lines = [USAGE, '', '選項：', '  -h, --help  顯示這份說明'];
  for (const [group, opts] of OPTIONS) {
    if (group) lines.push('', group + '：');
    for (const [name, type, , text] of opts) {
      const arg = type === 'boolean' ? '' : Array.isArray(type) ? ` {${type.join(',')}}` : ' 值';
      lines.push(`  --${name}${arg}`, `      ${text}`);
    }
  }
  return lines.join('\n');
}

class UsageError extends Error {}

export function parseArgs(argv) {
  const spec = new Map(OPTIONS.flatMap(([, o]) => o.map(x => [x[0], x])));
  const a = Object.fromEntries([...spec.values()].map(([name, , def]) => [name, def]));
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '-h' || s === '--help') return { help: true };
    if (!s.startsWith('--') || s === '--') { pos.push(s); continue; }
    let [name, val] = s.slice(2).split(/=(.*)/s);
    const o = spec.get(name);
    if (!o) throw new UsageError(`不認得的選項 --${name}`);
    const type = o[1];
    if (type === 'boolean') { a[name] = true; continue; }
    if (val === undefined) { if (i + 1 >= argv.length) throw new UsageError(`--${name} 需要一個值`); val = argv[++i]; }
    if (Array.isArray(type) && !type.includes(val)) throw new UsageError(`--${name} 只能是 ${type.join('、')}（收到 ${val}）`);
    if (type === 'number') { const v = Number(val); if (!Number.isFinite(v)) throw new UsageError(`--${name} 須為數字（收到 ${val}）`); a[name] = v; }
    else a[name] = val;
  }
  if (pos.length !== 1) throw new UsageError('需要一個輸出檔');
  a.out = pos[0];
  return a;
}

// ---------------------------------------------------------------- 小工具
// Python 的 round()（.5 取偶數）；舊版產生器用它決定脈衝與格數的取樣位置，這裡照用，產生的檔案才與舊版相同。
export const pyRound = v => { const f = Math.floor(v), d = v - f; return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f; };
// JavaScript 的 Math.round（場記板用的捨入）。
const jsRound = v => Math.floor(v + 0.5);

export function parseClock(s) {
  const [h, m, sec] = s.split(':');
  if (sec === undefined) throw new UsageError(`時間格式須為 時:分:秒（收到 ${s}）`);
  return +h * 3600 + +m * 60 + +sec;
}
const p2 = v => String(v).padStart(2, '0');
export function fmtClock(t) {
  t = ((t % 86400) + 86400) % 86400;
  return `${p2(Math.floor(t / 3600))}:${p2(Math.floor(t % 3600 / 60))}:${(t % 60).toFixed(3).padStart(6, '0')}`;
}
const sgn = (v, d) => (v >= 0 ? '+' : '') + v.toFixed(d);

// 可重現的亂數（mulberry32）與常態分佈（Box–Muller）。
export class Rng {
  constructor(seed) { this.s = seed >>> 0; this.spare = null; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a, b) { return a + (b - a) * this.next(); }
  normal(sd = 1) {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return v * sd; }
    const u = 1 - this.next(), r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * this.next();
    this.spare = r * Math.sin(th);
    return r * Math.cos(th) * sd;
  }
}

function ffmpeg(args) {
  const p = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (p.error) throw new Error(`找不到 ffmpeg（請加進 PATH）：${p.error.message}`);
  if (p.status) throw new Error('ffmpeg 失敗：' + String(p.stderr).trim().slice(-800));
}

// 16-bit PCM WAV，chans 為各聲道的取樣（−1～1，超出削波，與舊版相同以截尾轉成整數）。
export function writeWav(file, chans) {
  const n = chans[0].length, nc = chans.length, buf = Buffer.alloc(44 + n * nc * 2);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(36 + n * nc * 2, 4); buf.write('WAVEfmt ', 8, 'latin1');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * nc * 2, 28); buf.writeUInt16LE(nc * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1'); buf.writeUInt32LE(n * nc * 2, 40);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < nc; c++, o += 2)
    buf.writeInt16LE(Math.trunc(Math.max(-1, Math.min(1, chans[c][i])) * 32767), o);
  fs.writeFileSync(file, buf);
}

// ---------------------------------------------------------------- 波形碼
// 畫面碼 ID 與波形碼循環位置：手機本地時間自午夜起的整秒數 mod 540。
export const tagId = secOfDay => ((Math.floor(secOfDay) % 86400) + 86400) % 86400 % VIS_MOD;
export const waveHz = secOfDay => slate.waveHz(tagId(secOfDay));

// 一秒的波形碼（0.95 秒長）：一個振盪器依場記板的 waveBursts() 開關，如同場記板。錄音設備的時鐘快 rate 倍時整秒
// （音高與脈衝間隔）一起拉長：在手機的時間軸上產生、以檔案時間取樣（手機時間 = 檔案時間 / rate）。
export function second(val, isMin, hz, rate = 1) {
  const n = Math.trunc(SR * 0.95 * rate), d = new Float64Array(n);
  for (const [t0, t1, amp] of slate.waveBursts(val, isMin)) {
    const a = pyRound(t0 * rate * SR), z = Math.min(n, pyRound(t1 * rate * SR));
    for (let j = a; j < z; j++) d[j] = amp * Math.sin(2 * Math.PI * hz * j / SR / rate);   // 振盪器在同步脈衝開始時相位 0
  }
  return d;
}

// ---------------------------------------------------------------- LTC（docs/ltc.md）
export function ltcParams(fps, df = false) {
  const [rate, nominal] = LTC_FPS[fps];
  return { rate, nominal, df: !!df && fps === '29.97' };
}
// LTC 從午夜後第 F0 個格邊界開始輸出時，第一格的格數（同場記板 ltcStart()）：DF 與整數影格率就是 F0；
// 23.976 與 29.97 NDF 每秒計 24／30 格，只在開始時對齊真實時間。
export const ltcStartCount = (F0, p) => p.df || p.rate === p.nominal ? F0 : jsRound(F0 / p.rate * p.nominal);

// 手機輸出的 LTC：以模擬的 AudioContext 執行場記板的 ltcChunk()（漂移鎖定沒有介入時），回傳位準的變化點
// { pos: 取樣位置（手機的取樣率，從第一格起點算起）, level: 變化後的位準 }；最後一點是結束（位準回到 0）。
export function ltcLevels(p, startCount, nFrames, sr = SR) {
  const pos = [], level = [];
  let total = 0, last = 0;
  const bufs = [];
  const ctx = {
    getOutputTimestamp: null, destination: {},        // no output timestamp: the drift lock stays out
    createBuffer(c, n) { const d = new Float32Array(n); bufs.push(d); return { getChannelData: () => d }; },
    createBufferSource: () => ({ connect() {}, start() {} }),
  };
  const ltc = { p, sr, T0: 0, startCount, frame: 0, sample: 0, level: 1, adj: 0, err: 0, sources: [] };
  for (let done = 0; done < nFrames; done += 200) {
    slate.ltcChunk(ltc, ctx, Math.min(200, nFrames - done));
    for (const d of bufs.splice(0)) {
      for (let i = 0; i < d.length; i++) if (d[i] !== last) { pos.push(total + i); level.push(d[i]); last = d[i]; }
      total += d.length;
    }
  }
  pos.push(total); level.push(0);
  return { pos: Float64Array.from(pos), level: Float64Array.from(level) };
}

// 在檔案取樣位置 u（含小數）變化的方波，以每個取樣前後各半個取樣間隔內的平均值取成 n 點（中心在取樣點上，
// 邊緣不偏移半個取樣），保留取樣之間的邊緣位置。
export function boxSampled(u, level, n) {
  const d = new Float64Array(n + 2);
  for (let j = 0; j < u.length; j++) {
    const x = u[j] + 0.5;                          // sample i averages [i − 1/2, i + 1/2)
    if (!(x >= 0 && x < n)) continue;
    const delta = level[j] - (j ? level[j - 1] : 0), fl = Math.floor(x), fr = x - fl;
    d[fl] += delta * (1 - fr);
    d[fl + 1] += delta * fr;
  }
  const out = new Float64Array(n);
  for (let i = 0, acc = 0; i < n; i++) { acc += d[i]; out[i] = acc; }
  return out;
}

export function fmtTc(t, df) { return `${p2(t.h)}:${p2(t.m)}:${p2(t.s)}${df ? ';' : ':'}${p2(t.f)}`; }

// ---------------------------------------------------------------- 檔案建立時間
// "+08:00" → 與 UTC 的差（分鐘）；沒給時用這台電腦在該日期的時區。
function tzMinutes(tz, y, mo, d) {
  if (tz === null) return -new Date(y, mo - 1, d, 12).getTimezoneOffset();
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(tz);
  if (!m) throw new UsageError(`--tz 格式須為 +08:00（收到 ${tz}）`);
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
}
// 本地日期 date、本地時間 C 秒（整數，可超過一天）的 creation_time 字串（UTC）。
export function creationStamp(date, tz, C) {
  const [y, mo, d] = date.split('-').map(Number);
  const ms = Date.UTC(y, mo - 1, d) - tzMinutes(tz, y, mo, d) * 60000 + C * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000000Z');
}

// ---------------------------------------------------------------- 畫面碼（AprilTag）
// 3 × 3 投影轉換：把 src 的四點對到 dst 的四點（8 × 8 線性方程，部分主元高斯消去）。
function homography(src, dst) {
  const A = [];
  src.forEach(([x, y], i) => {
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) if (r !== c) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

// 灰階影像的可分離高斯模糊（邊緣延伸）。
function gaussianBlur(img, W, H, sigma) {
  const r = Math.ceil(3 * sigma), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += (k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += k[i + r] * img[y * W + Math.min(W - 1, Math.max(0, x + i))];
    tmp[y * W + x] = acc;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += k[i + r] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
    out[y * W + x] = acc;
  }
  return out;
}

// 以模擬的 canvas 執行場記板的 drawTag()，回傳 (12 × cell)² 的灰階 tag（含 1 格靜區，0／255）。
export function drawTag(idx, cell) {
  const side = 12 * cell, px = new Uint8Array(side * side);
  const vtCtx = { fillStyle: '#000000',
    fillRect(x, y, w, h) { const v = this.fillStyle === '#ffffff' ? 255 : 0; for (let j = y; j < y + h; j++) px.fill(v, j * side + x, j * side + x + w); } };
  slate.drawTag(vtCtx, cell, idx);
  return px;
}

// 攝影機拍到的場記板畫面：靜態背景上一支橫拿的手機，螢幕上是外框帶（方波）、白底面板與 tag。
// 每種狀態（ID、外框黑白）只算一次透視投影、模糊與感光雜訊，之後每格只做混合與曝光。
export class SlateCamera {
  constructor(W, H, tagSize, tilt, blur, exposure, seed = 2) {
    Object.assign(this, { W, H, blur, exposure });
    const rng = (this.rng = new Rng(seed));
    // Smooth background: a coarse random grid scaled up bilinearly.
    const gw = Math.floor(W / 40) + 2, gh = Math.floor(H / 40) + 2, low = new Float32Array(gw * gh);
    for (let i = 0; i < low.length; i++) low[i] = Math.floor(rng.uniform(60, 160));
    this.bg = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(gh - 1, Math.max(0, (y + 0.5) * gh / H - 0.5)), y0 = Math.min(gh - 2, Math.floor(sy)), fy = sy - y0;
      for (let x = 0; x < W; x++) {
        const sx = Math.min(gw - 1, Math.max(0, (x + 0.5) * gw / W - 0.5)), x0 = Math.min(gw - 2, Math.floor(sx)), fx = sx - x0;
        const a = low[y0 * gw + x0], b = low[y0 * gw + x0 + 1], c = low[(y0 + 1) * gw + x0], d = low[(y0 + 1) * gw + x0 + 1];
        this.bg[y * W + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
    const panelPx = tagSize * Math.min(W, H);           // tag 含靜區（12 格）在畫面上的邊長
    const cell = (this.cell = Math.max(2, Math.ceil(panelPx * 1.3 / 12)));
    // Phone texture (held sideways): bezel, then the screen with the square-wave band around the digit area.
    const hs = pyRound(12 * cell / 0.62), ws = 2 * hs, band = Math.max(2, pyRound(0.06 * hs)), bez = Math.max(2, pyRound(0.04 * hs));
    Object.assign(this, { hs, ws, band, bez, tw: ws + 2 * bez, th: hs + 2 * bez });
    const side = 12 * cell;
    this.panel = [bez + Math.floor((ws - side) / 2), bez + pyRound(0.45 * hs - side / 2)];
    const { tw, th } = this, k = panelPx / side, f = W;  // texture px -> frame px at the phone's centre; focal length in px
    const tr = tilt * Math.PI / 180, roll = 1.5 * Math.PI / 180, cx = W / 2, cy = H / 2;
    const corners = [[0, 0], [tw, 0], [tw, th], [0, th]];
    const dst = corners.map(([x, y]) => {
      const X = (x - tw / 2) * k, Y = (y - th / 2) * k, Xr = X * Math.cos(tr), Zr = X * Math.sin(tr);   // turn about the vertical axis
      const u = f * Xr / (f + Zr), v = f * Y / (f + Zr);
      return [cx + u * Math.cos(roll) - v * Math.sin(roll), cy + u * Math.sin(roll) + v * Math.cos(roll)];
    });
    this.inv = inv3(homography(corners, dst));          // frame px -> texture px
    const xs = dst.map(p => p[0]), ys = dst.map(p => p[1]);
    this.box = [Math.max(0, Math.floor(Math.min(...xs)) - 1), Math.max(0, Math.floor(Math.min(...ys)) - 1),
      Math.min(W, Math.ceil(Math.max(...xs)) + 2), Math.min(H, Math.ceil(Math.max(...ys)) + 2)];
    this.cache = new Map();
  }

  texture(idx, white) {
    const { tw, th, bez: b, band: bd, hs, ws, cell } = this, t = new Uint8Array(tw * th).fill(25);   // phone body
    const rect = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) t.fill(v, y * tw + x0, y * tw + x1); };
    rect(b, b, b + ws, b + hs, white ? 255 : 0);       // square-wave band
    rect(b + bd, b + bd, b + ws - bd, b + hs - bd, 0); // slate background
    const tag = drawTag(idx, cell), side = 12 * cell, [px, py] = this.panel;   // white panel = tag with its quiet zone
    for (let y = 0; y < side; y++) t.set(tag.subarray(y * side, (y + 1) * side), (py + y) * tw + px);
    return t;
  }

  // state = { id, white } 或 null（手機不在畫面中）。
  stateImage(state) {
    const key = state ? `${state.id},${state.white}` : 'none';
    if (this.cache.has(key)) return this.cache.get(key);
    const { W, H, tw, th, inv } = this;
    let img = Float32Array.from(this.bg);
    if (state) {
      const tex = this.texture(state.id, state.white);
      const at = (x, y) => (x >= 0 && y >= 0 && x < tw && y < th ? 1 : 0);
      const [x0, y0, x1, y1] = this.box;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        // Inverse perspective map at the pixel centre, bilinear sampling; outside the texture counts as uncovered.
        const X = x + 0.5, Y = y + 0.5, w = inv[2][0] * X + inv[2][1] * Y + inv[2][2];
        const u = (inv[0][0] * X + inv[0][1] * Y + inv[0][2]) / w - 0.5, v = (inv[1][0] * X + inv[1][1] * Y + inv[1][2]) / w - 0.5;
        const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
        if (iu < -1 || iv < -1 || iu >= tw || iv >= th) continue;
        let val = 0, cov = 0;
        for (const [dx, dy, wt] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]]) {
          const c = at(iu + dx, iv + dy) * wt;
          cov += c;
          if (c) val += c * tex[(iv + dy) * tw + iu + dx];
        }
        img[y * W + x] = val + (1 - cov) * img[y * W + x];
      }
    }
    if (this.blur > 0) img = gaussianBlur(img, W, H, this.blur);
    // Sensor noise is baked into each state (it changes every half second), which keeps 4K rendering fast.
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.floor(img[i] + this.rng.normal(2) + 0.5)));
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, out);
    return out;
  }

  // weights: [[state, 曝光時間比例]]；ft：該格的檔案時間（決定自動曝光的起伏）。
  frame(weights, ft) {
    let img;
    if (weights.length === 1) img = this.stateImage(weights[0][0]);
    else {                                               // exposure spans a change: mix the states by time
      const mix = new Float32Array(this.W * this.H);
      for (const [s, w] of weights) { const a = this.stateImage(s); for (let i = 0; i < mix.length; i++) mix[i] += w * a[i]; }
      img = new Uint8Array(mix.length);
      for (let i = 0; i < mix.length; i++) img[i] = Math.max(0, Math.min(255, Math.floor(mix[i] + 0.5)));
    }
    if (this.exposure) {
      const gain = 1 + this.exposure * Math.sin(2 * Math.PI * ft / 5.3), lift = 25 * this.exposure * Math.sin(2 * Math.PI * ft / 3.1 + 1);
      const lut = Uint8Array.from({ length: 256 }, (_, v) => Math.max(0, Math.min(255, Math.floor(v * gain + lift + 0.5))));
      const o = new Uint8Array(img.length);
      for (let i = 0; i < o.length; i++) o[i] = lut[img[i]];
      img = o;
    }
    return img;
  }
}

// cpu：libx264／libx265；nvenc：NVIDIA 硬體編碼；auto：先以一小段測試 NVENC，能用就用，否則退回 CPU。
function pickEncoder(codec, choice, W, H) {
  const [cpu, gpu] = codec === 'h264' ? ['libx264', 'h264_nvenc'] : ['libx265', 'hevc_nvenc'];
  if (choice === 'cpu') return cpu;
  const t = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=gray:s=${W}x${H}:r=30:d=0.2`, '-c:v', gpu, '-f', 'null', '-']);
  if (t.error) throw new Error(`找不到 ffmpeg（請加進 PATH）：${t.error.message}`);
  if (!t.status) return gpu;
  if (choice === 'nvenc') throw new Error(`${gpu} 無法使用：` + String(t.stderr).trim().slice(-300));
  return cpu;
}

const VENC = {
  libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'],
  libx265: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '20', '-x265-params', 'log-level=error'],
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
  hevc_nvenc: ['-c:v', 'hevc_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '21', '-b:v', '0'],
};

// 算出攝影機的畫面，與（可有可無的）聲音軌一起交給 ffmpeg 編碼成 a.out。
async function makeVisual(a, wavPath, t) {
  const [num, den] = FPS[a.fps], fps = num / den, [W, H] = a.size.toLowerCase().split('x').map(Number);
  const nfr = t.nfr, off = a['av-offset'] / 1000, shutter = a.shutter / fps;
  const cam = new SlateCamera(W, H, a['tag-size'], a.tilt, a.blur, a.exposure);
  const encoder = pickEncoder(a.codec, a.encoder, W, H);
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-framerate', `${num}/${den}`, '-i', '-'];
  if (wavPath) args.push('-i', wavPath, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
  args.push(...VENC[encoder], ...(a.codec === 'h265' ? ['-tag:v', 'hvc1'] : []), '-g', String(Math.max(1, pyRound(a.gop * fps))),
    '-pix_fmt', 'yuv420p', '-frames:v', String(nfr), ...t.meta, a.out);
  const enc = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => { enc.once('error', rej); enc.once('exit', code => code ? rej(new Error('ffmpeg 編碼失敗')) : res()); });
  done.catch(() => {});
  const state = r => { const S = Math.floor(r); return t.visible(S) ? { id: tagId(S), white: r - S < 0.5 } : null; };
  for (let k = 0; k < nfr; k++) {
    const ft = k / fps;
    // Exposure window centred on the frame's time; the picture lags the sound by `off`.
    const ra = t.r0 + t.realOffset(ft - off - shutter / 2), rb = t.r0 + t.realOffset(ft - off + shutter / 2);
    const cuts = [ra];
    for (let h = Math.floor(ra * 2) + 1; h < Math.ceil(rb * 2); h++) cuts.push(h / 2);
    cuts.push(rb);
    const weights = new Map();
    for (let i = 0; i + 1 < cuts.length; i++) {
      const s = state((cuts[i] + cuts[i + 1]) / 2), key = s ? `${s.id},${s.white}` : 'none';
      const w = (cuts[i + 1] - cuts[i]) / (rb - ra);
      weights.set(key, [s, (weights.get(key)?.[1] || 0) + w]);
    }
    const img = cam.frame([...weights.values()], ft);
    if (!enc.stdin.write(img)) await Promise.race([new Promise(res => enc.stdin.once('drain', res)), done]);
  }
  enc.stdin.end();
  await done;
  const vLen = nfr / fps, shown0 = t.r0 + t.realOffset(-off), realLen = t.realOffset(vLen - off) - t.realOffset(-off);
  console.log(`${a.out}: ${a.fps} fps ${W}x${H} ${encoder}（GOP ${a.gop} 秒），${nfr} 格（畫面長 ${vLen.toFixed(6)} 秒），` +
    `時鐘偏差 ${sgn(t.p0 * 1e6, 3)} ppm，速度比例 ${(t.rate * 100).toFixed(6)} %，真實長度 ${realLen.toFixed(6)} 秒`);
  console.log(`    聲音軌第 0 秒＝${fmtClock(t.r0)}；畫面第 0 格顯示 ${fmtClock(shown0)}（ID ${tagId(shown0)}）；` +
    `畫面相對聲音 ${sgn(a['av-offset'], 3)} ms；聲音軌：${{ code: '波形碼', scene: '只有現場聲音', none: '無' }[a.audio]}`);
}

// ---------------------------------------------------------------- 主程式
export async function main(argv) {
  const a = parseArgs(argv);
  if (a.help) { console.log(help()); return 0; }
  const ext = path.extname(a.out).toLowerCase();
  if (a.visual && !['.mp4', '.mov'].includes(ext)) throw new UsageError('--visual 的輸出須為 .mp4 或 .mov');
  if (a.df && a.ltc !== '29.97') throw new UsageError('--df 只用於 --ltc 29.97');
  if (a.created === 'end' && ext === '.wav') throw new UsageError('WAV 的 BWF time_reference 規格上是開始時間，只能 --created start');

  const rate = 1 + a.ppm * 1e-6, p0 = a.ppm * 1e-6, p1 = (a['ppm-end'] ?? a.ppm) * 1e-6;
  const r0 = parseClock(a.start), dur = a.minutes * 60, n = Math.trunc(dur * SR);
  const realSpan = dur / (1 + (p0 + p1) / 2);                  // real seconds covered by the file
  const fileTime = d => d + (p0 * d + (p1 - p0) * d * d / (2 * realSpan));   // file seconds after d real seconds
  const realOffset = ft => {                                     // inverse of fileTime
    const q = (p1 - p0) / (2 * realSpan);
    return q === 0 ? ft / (1 + p0) : (-(1 + p0) + Math.sqrt((1 + p0) ** 2 + 4 * q * ft)) / (2 * q);
  };
  const visible = R => { const ft = fileTime(R - r0); return !a.plug || ft < a.plug - 1 || ft > dur - a.plug; };   // slate shown / sounding
  const rng = new Rng(1);
  const code = new Float64Array(n);
  if (!(a.visual && a.audio === 'scene')) {
    for (let R = Math.ceil(r0); ; R++) {
      const ft = fileTime(R - r0);
      if ((ft + 1) * SR >= n) break;
      if (!visible(R)) continue;
      const m = Math.floor((R % 3600) / 60), s = R % 60;
      const local = 1 + p0 + (p1 - p0) * (R - r0) / realSpan;  // the recorder's clock ratio at this moment
      const b = second(s === 0 ? m : s, s === 0, waveHz(R), local), i = pyRound(ft * SR);
      for (let j = 0; j < b.length; j++) code[i + j] += b[j];
    }
  }
  const scene = new Float64Array(n);
  for (let i = 0, g = 0; i < n; i++) {
    if (i % 2400 === 0) g = rng.next() ** 2;                   // loudness changes every 50 ms
    scene[i] = rng.normal(0.1) * g;
  }
  const half = Float64Array.from(code, v => 0.5 * v);
  const chans = [scene, half];
  const notes = [];
  if (a.ltc) {
    const p = ltcParams(a.ltc, a.df), ch = +a['ltc-channel'];
    const F0 = Math.ceil(r0 * p.rate);                           // first frame boundary at or after the file's first sample
    const startCount = ltcStartCount(F0, p);
    const nFrames = Math.ceil((r0 + realSpan - F0 / p.rate) * p.rate) + 1;
    const { pos, level } = ltcLevels(p, startCount, nFrames);
    // The phone plays its samples on real time; the recorder samples them on its own clock (fileTime).
    const q = (p1 - p0) / (2 * realSpan);
    const u = pos.map(x => { const d = F0 / p.rate + x / SR - r0; return (d + p0 * d + q * d * d) * SR; });
    const ltc = boxSampled(u, level, n), sign = a['ltc-invert'] ? -1 : 1;
    const sd = a['ltc-noise'] === null ? 0 : slate.LTC_AMP * 10 ** (-a['ltc-noise'] / 20);
    for (let i = 0; i < n; i++) ltc[i] = ltc[i] * sign + (sd ? rng.normal(sd) : 0);
    chans[1 - ch] = a['ltc-with'] === 'code' ? half : scene;
    chans[ch] = ltc;
    const kind = p.df ? ' DF' : a.ltc === '29.97' ? ' NDF' : '';
    notes.push(`    LTC ${a.ltc}${kind}（第 ${ch + 1} 聲道）：第一格 ${fmtTc(slate.countToTC(startCount, p), p.df)}（格數 ${startCount}），` +
      `格起點在真實時間 ${fmtClock(F0 / p.rate)}、檔案 ${fileTime(F0 / p.rate - r0).toFixed(6)} 秒，共 ${nFrames} 格` +
      (p.rate !== p.nominal && !p.df ? '；時間碼每秒計整數格，只在第一格對齊真實時間' : ''));
  }

  // Video length: the analyzer times a file with a picture track by that track (nfr frames).
  const fpsV = a.visual ? FPS[a.fps][0] / FPS[a.fps][1] : null, nfr = a.visual ? pyRound(dur * fpsV) : null;
  const mediaLen = a.visual ? nfr / fpsV : dur;
  // Creation time: the device's clock (slate clock + offset) when recording started or when the file was saved.
  let meta = [];
  if (a.created) {
    const devStart = r0 + a['created-offset'];
    if (ext === '.wav') {
      const ref = ((pyRound(devStart * SR) % (86400 * SR)) + 86400 * SR) % (86400 * SR);
      meta = ['-write_bext', '1', '-metadata', `time_reference=${ref}`];
      notes.push(`    BWF time_reference ${ref}（${fmtClock(ref / SR)}，開始型），r = ${sgn(ref / SR - r0, 6)} 秒`);
    } else {
      const end = a.created === 'end', C = Math.floor(devStart + (end ? mediaLen : 0));   // mvhd keeps whole seconds
      const stamp = creationStamp(a.date, a.tz, C);
      meta = ['-metadata', `creation_time=${stamp}`];
      notes.push(`    creation_time ${stamp}（本地 ${fmtClock(C)}，${end ? '結束' : '開始'}型，檔長 ${mediaLen.toFixed(6)} 秒）：` +
        `r = ${sgn(C - (end ? mediaLen : 0) - r0, 6)} 秒（設定偏差 ${sgn(a['created-offset'], 3)} 秒，取整數秒後）`);
    }
  }

  const needAudio = !(a.visual && a.audio === 'none');
  let tmp = null, wavPath = a.out;
  if (ext !== '.wav' || meta.length) {                          // ffmpeg muxes it (a BWF time_reference needs its WAV muxer)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-media-'));
    wavPath = path.join(tmp, 'audio.wav');
  }
  try {                                                          // the temporary WAV is removed even when encoding fails
    if (needAudio) writeWav(wavPath, chans);
    if (a.visual) {
      await makeVisual(a, needAudio ? wavPath : null, { nfr, meta, r0, rate, p0, realOffset, visible });
      for (const x of notes) console.log(x);
      return 0;
    }
    if (ext === '.wav' && meta.length) ffmpeg(['-i', wavPath, '-c:a', 'copy', ...meta, a.out]);
    else if (ext !== '.wav') {
      const v = ['.mp4', '.mov'].includes(ext) ? ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60000/1001', '-i', wavPath,
        '-map', '0:v', '-map', '1:a', '-t', String(dur), '-c:v', 'libx264', '-preset', 'ultrafast'] : ['-i', wavPath];
      ffmpeg([...v, '-c:a', 'aac', '-b:a', '192k', ...meta, a.out]);
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (p0 === p1) console.log(`${a.out}: 起點 ${a.start}，時鐘偏差 ${sgn(a.ppm, 3)} ppm，速度比例 ${(rate * 100).toFixed(6)} %，真實長度 ${(dur / rate).toFixed(6)} 秒`);
  else console.log(`${a.out}: 起點 ${a.start}，時鐘偏差由 ${sgn(p0 * 1e6, 1)} 變到 ${sgn(p1 * 1e6, 1)} ppm，真實長度 ${realSpan.toFixed(6)} 秒`);
  for (const x of notes) console.log(x);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (e) {
    if (e instanceof UsageError) { console.error(`錯誤：${e.message}\n\n${USAGE}\n（--help 列出全部選項）`); process.exitCode = 2; }
    else { console.error('錯誤：' + (e && e.message || e)); process.exitCode = 1; }
  }
}
