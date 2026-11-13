#!/usr/bin/env node
// make_fixtures.mjs — 產生網頁分析器自動測試用的短測試檔（tests/fixtures/），並寫出各檔的真值（<名稱>.truth.json）。
//
// 測試檔由 tests/make_test_media.mjs 以固定參數產生，可重現；影片用 CPU 的 libx264（CI 沒有 NVENC）、640×360。
// 產生後的檔案一併放進版控，CI 不必重新產生。
//
// 頭尾兩端要相隔 60 秒以上，分析器才分開計算兩端（模式「頭尾」）；更短的檔案兩端會合併成單端。
// 因此 wave.wav 長 80 秒、只在頭尾各 8 秒放波形碼；WAV 只留波形碼（或 LTC）聲道並以 gzip 存檔，測試時解壓到暫存資料夾。
// 只有畫面的 picture.mp4 同樣 80 秒（關鍵格間隔 8 秒）。其他檔案 10–20 秒，全部合計約 4 MB 以內。
//
// 用法：
//   node tests/fixtures/make_fixtures.mjs                          # 用 tests/make_test_media.mjs
//   node tests/fixtures/make_fixtures.mjs --generator 其他版本.mjs  # 指定產生器（例如尚未 commit 的新版）
//   node tests/fixtures/make_fixtures.mjs --out 資料夾 [--only cam.mp4]
// 需要 ffmpeg（PATH 中）。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const SR = 48000;
const FPS = { '25': 25, '29.97': 30000 / 1001 };

// 每個測試檔：產生器參數與檢查項目。start 是聲音軌（沒有聲音軌時為畫面）第 0 秒的真實時間。
// cam.mp4 與 picture.mp4 起點相差 2 分鐘：兩者都有畫面碼（9 分鐘一輪），用來檢查跨檔案的起點差。
// mod 是預期的週期（波形碼音高 540、另有一致的分鐘標記時 10800、LTC 86400）；max_unc_ppm／max_worst_ms 是預估誤差的
// 上限，取產生時實測值的 2 倍。cam.mp4 的建立時間固定以 UTC+8 寫入（tz），測試時瀏覽器的時區須相同。
export const FIXTURES = [
  { name: 'wave.wav', seconds: 80, ppm: 833, start: '12:34:56.789', plug: 8, mono: true, gzip: true,
    mode: 'both', mod: 10800, max_unc_ppm: 0.15, max_worst_ms: 0.0081,
    note: 'WAV，頭尾各 8 秒有波形碼，兩端分開計算；只留波形碼聲道，以 gzip 存檔' },
  { name: 'aac.m4a', seconds: 20, ppm: -694, start: '12:35:00.039', plug: 7,
    mode: 'head', mod: 540, max_unc_ppm: 0.86, max_worst_ms: 0.0104,
    note: 'AAC（M4A），只有頭尾各 7 秒有波形碼' },
  { name: 'cam.mp4', seconds: 15, ppm: 200, start: '12:40:10.250', plug: 6, visual: true,
    fps: '29.97', av_offset_ms: 25.0, mode: 'head', created: 'end', tz: '+08:00',
    mod: 540, max_unc_ppm: 1.35, max_worst_ms: 0.0122,
    note: 'H.264＋AAC，畫面碼（AprilTag）與波形碼，畫面比聲音晚 25 ms；建立時間為錄影結束時間' },
  { name: 'picture.mp4', seconds: 80, ppm: -1200, start: '12:42:10.250', plug: 8, visual: true,
    fps: '25', audio: 'none', gop: 8, mode: 'both', mod: 540, max_unc_ppm: 1090, max_worst_ms: 43.7,
    note: 'H.264，只有畫面碼、沒有聲音軌，頭尾各 8 秒；起點比 cam.mp4 晚 2 分鐘' },
  { name: 'ltc.wav', seconds: 20, ppm: 300, start: '13:20:05.400', ltc: '25', mono: true, gzip: true,
    mode: 'head', mod: 86400, max_unc_ppm: 0.16, max_worst_ms: 0.0019,
    note: 'WAV，25 fps LTC；只留 LTC 聲道，以 gzip 存檔' },
  { name: 'bwf.wav', seconds: 12, ppm: -300, start: '09:15:20.125', created: 'start', created_offset: 0.8, mono: true, gzip: true,
    mode: 'head', mod: 540, max_unc_ppm: 1.9, max_worst_ms: 0.0132,
    note: 'WAV，整段波形碼，BWF time_reference（開始型，設備快 0.8 秒）；只留波形碼聲道，以 gzip 存檔' },
  { name: 'ltcdf.m4a', seconds: 10, ppm: -500, start: '10:00:03.300', ltc: '29.97', df: true, ltc_invert: true, ltc_noise: 20,
    mode: 'head', mod: 86400, max_unc_ppm: 0.41, max_worst_ms: 0.0024,
    note: 'AAC（M4A），29.97 DF LTC，反相、訊雜比 20 dB 的白雜訊；另一聲道為現場聲音' },
];

const parseClock = s => { const [h, m, sec] = s.split(':'); return +h * 3600 + +m * 60 + +sec; };
// Python 的 round()（.5 取偶數），與產生器相同。
const pyRound = v => { const f = Math.floor(v), d = v - f; return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f; };

export function genArgs(fx, out) {
  const a = [out, '--minutes', String(fx.seconds / 60), '--ppm', String(fx.ppm), '--start', fx.start];
  if (fx.plug) a.push('--plug', String(fx.plug));
  if (fx.created) a.push('--created', fx.created);
  if (fx.created_offset) a.push('--created-offset', String(fx.created_offset));
  if (fx.tz) a.push('--tz', fx.tz);
  if (fx.ltc) a.push('--ltc', fx.ltc);
  if (fx.df) a.push('--df');
  if (fx.ltc_invert) a.push('--ltc-invert');
  if (fx.ltc_noise !== undefined) a.push('--ltc-noise', String(fx.ltc_noise));
  if (fx.visual) a.push('--visual', '--fps', fx.fps, '--size', '640x360', '--encoder', 'cpu',
    '--av-offset', String(fx.av_offset_ms ?? 0), '--audio', fx.audio || 'code', '--gop', String(fx.gop || 1));
  return a;
}

// 立體聲 16-bit WAV 只留右聲道（波形碼或 LTC）：逐取樣複製，不重新取樣；其他區塊（如 BWF 的 bext）原樣保留。
export function keepRightChannel(file) {
  const buf = fs.readFileSync(file), out = [buf.subarray(0, 12)];
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('latin1', o, o + 4), size = buf.readUInt32LE(o + 4), body = buf.subarray(o + 8, o + 8 + size);
    let chunk = buf.subarray(o, o + 8 + size + (size & 1));
    if (id === 'fmt ') {
      if (body.readUInt16LE(2) !== 2 || body.readUInt16LE(14) !== 16) throw new Error(`${file}：不是立體聲 16-bit`);
      chunk = Buffer.from(chunk);
      chunk.writeUInt16LE(1, 10); chunk.writeUInt32LE(SR * 2, 16); chunk.writeUInt16LE(2, 20);
    } else if (id === 'data') {
      const right = Buffer.alloc(size / 2);
      for (let i = 0; i < size / 4; i++) right.writeInt16LE(body.readInt16LE(4 * i + 2), 2 * i);
      const head = Buffer.alloc(8);
      head.write('data', 0, 'latin1'); head.writeUInt32LE(right.length, 4);
      chunk = Buffer.concat([head, right, Buffer.alloc(right.length & 1)]);
    }
    out.push(chunk);
    o += 8 + size + (size & 1);
  }
  const res = Buffer.concat(out);
  res.writeUInt32LE(res.length - 8, 4);
  fs.writeFileSync(file, res);
}

// 與產生器相同的公式（固定 ppm）：檔案時間 = (真實時間 − 起點) × 速率。
export function truthOf(fx) {
  const rate = 1 + fx.ppm * 1e-6, start = parseClock(fx.start), dur = fx.seconds;
  const t = { file: fx.name, note: fx.note, mode: fx.mode, ppm: fx.ppm, rate, start, start_text: fx.start,
    has_audio: (fx.audio || 'code') !== 'none', has_video: !!fx.visual, clock_type: fx.created || null, ltc: fx.ltc || null,
    df: !!fx.df, tz: fx.tz || null, mod: fx.mod, pitch_rejected: 0, max_unc_ppm: fx.max_unc_ppm, max_worst_ms: fx.max_worst_ms };
  if (fx.visual) {
    const fps = FPS[fx.fps], nfr = pyRound(dur * fps);
    Object.assign(t, { fps, frames: nfr, av_offset_ms: t.has_audio ? fx.av_offset_ms ?? 0 : null });
    t.media_length = nfr / fps;                          // 有畫面軌時，分析器以畫面軌的長度與起點為準
  } else t.media_length = dur;
  t.corrected_length = t.media_length / rate;
  if (fx.created) {
    // 設備時鐘差 r：WAV 的 time_reference 是取樣數；MP4 的建立時間是整數秒，結束型以媒體長度（有畫面軌時為 nfr / fps）換算回開始時間。
    const dev = start + (fx.created_offset || 0), end = fx.created === 'end';
    const C = fx.name.endsWith('.wav') ? pyRound(dev * SR) / SR : Math.floor(dev + (end ? t.media_length : 0));
    t.clock_r = Math.round((C - (end ? t.media_length : 0) - start) * 1e6) / 1e6;
  }
  return t;
}

const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function main() {
  const { values: a } = parseArgs({ options: { generator: { type: 'string', default: path.join(ROOT, 'tests', 'make_test_media.mjs') },
    out: { type: 'string', default: HERE }, only: { type: 'string', multiple: true } } });
  let total = 0;
  for (const fx of FIXTURES.filter(f => !a.only || a.only.includes(f.name))) {
    let out = path.join(a.out, fx.name);
    const p = spawnSync(process.execPath, [a.generator, ...genArgs(fx, out)], { stdio: 'inherit' });
    if (p.status) throw new Error(`產生 ${fx.name} 失敗（結束碼 ${p.status}）`);
    if (fx.mono) keepRightChannel(out);
    const t = truthOf(fx);
    t.generator_args = genArgs(fx, fx.name);
    t.sha256 = sha256(out);
    if (fx.gzip) {                                        // gzip 標頭的時間為 0：同樣內容得到同樣的 .gz
      fs.writeFileSync(out + '.gz', zlib.gzipSync(fs.readFileSync(out), { level: 9 }));
      fs.rmSync(out);
      out += '.gz';
    }
    fs.writeFileSync(path.join(a.out, fx.name.replace(/\.\w+$/, '.truth.json')), JSON.stringify(t, null, 2) + '\n');
    const size = fs.statSync(out).size;
    total += size;
    console.log(`${fx.name}: ${(size / 1e6).toFixed(2)} MB`);
  }
  console.log(`合計 ${(total / 1e6).toFixed(2)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
