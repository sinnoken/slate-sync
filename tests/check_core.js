#!/usr/bin/env node
// check_core.js — 分析核心（src/core/）不依賴瀏覽器：每個模組都能在 node 直接 import，原始碼不使用 DOM、WebCodecs、
// 檔案存取等平台 API；再以 tests/fixtures/ 的 WAV（波形碼與 LTC，在這裡直接解析 16-bit PCM）實際跑一次 analyze()，
// 結果須在報告自己的預估誤差內符合真值。
// 用法：node tests/check_core.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE = path.join(ROOT, 'src', 'core');
// Platform APIs the core must not touch (the page and the command line supply them through m.readWindow / m.openVideo).
const FORBIDDEN = /\b(document|window|navigator|localStorage|AudioDecoder|VideoDecoder|EncodedAudioChunk|EncodedVideoChunk|OffscreenCanvas|fetch|Blob|File|FileReader|require|process|Buffer)\b|from ['"]node:/;
let failed = 0;
const fail = msg => { failed++; console.log('✗ ' + msg); };

const files = fs.readdirSync(CORE).filter(f => f.endsWith('.js'));
for (const f of files) {
  const src = fs.readFileSync(path.join(CORE, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const m = src.match(FORBIDDEN);
  if (m) fail(`${f}：使用了平台 API「${m[0]}」`);
  try { await import(pathToFileURL(path.join(CORE, f))); } catch (e) { fail(`${f}：無法在 node import（${e.message}）`); }
}
if (!failed) console.log(`✓ ${files.length} 個核心模組都能在 node import，沒有使用平台 API`);

// A mono 16-bit PCM WAV (the fixtures' format) as the core's media interface.
function wavMedia(name) {
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', name + '.gz')));
  let o = 12, fmt = null, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('latin1', o, o + 4), size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(o + 10), sr: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') { data = [o + 8, size]; break; }
    o += 8 + size + (size & 1);
  }
  if (!fmt || fmt.channels !== 1 || fmt.bits !== 16) throw new Error(`${name}：只支援單聲道 16-bit`);
  const total = data[1] / 2, x = new Float32Array(total);
  for (let i = 0; i < total; i++) x[i] = buf.readInt16LE(data[0] + 2 * i) / 32768;
  const sr = fmt.sr, D = total / sr;
  return { name, modified: 0, duration: D, movieDuration: D, hasAudio: true, hasVideo: false, aOff: 0, aDur: D, vOff: null,
    readWindow: async (a, b) => {
      const f0 = Math.max(0, Math.ceil(a * sr - 1e-9)), f1 = Math.min(total, Math.ceil(b * sr));
      return { chans: f1 > f0 ? [x.subarray(f0, f1)] : [], t0: f0 / sr, sr };
    },
    openVideo: async () => ({ unsupported: { why: 'why.codec', codec: '?' } }) };
}

const { analyze } = await import(pathToFileURL(path.join(CORE, 'analyze.js')));
const { mod } = await import(pathToFileURL(path.join(CORE, 'util.js')));
for (const name of ['wave.wav', 'ltc.wav']) {
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', name.replace('.wav', '.truth.json')), 'utf8'));
  const r = await analyze(wavMedia(name), {});
  if (r.error) { fail(`${name}：分析失敗 ${JSON.stringify(r.error)}`); continue; }
  const dPpm = r.ppm - truth.ppm, dStart = (mod(r.startLabel - truth.start + r.mod / 2, r.mod) - r.mod / 2) * 1000;
  const tol = r.worstMs + 0.5 / 48000 * 1000;      // the generator rounds each second to a sample
  if (r.mode !== truth.mode || Math.abs(dPpm) > r.uncPpm || Math.abs(dStart) > tol)
    fail(`${name}：模式 ${r.mode}，速度比例誤差 ${dPpm.toFixed(3)} ppm（±${r.uncPpm.toFixed(3)}），起點誤差 ${dStart.toFixed(4)} ms（±${tol.toFixed(4)}）`);
  else console.log(`✓ ${name}：node 執行 analyze()，${r.ppm.toFixed(3)} ppm，起點誤差 ${dStart.toFixed(4)} ms（±${tol.toFixed(4)}）`);
}
console.log(failed ? `結果：${failed} 項不符` : '結果：全部通過');
process.exit(failed ? 1 : 0);
