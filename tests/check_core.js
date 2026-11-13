#!/usr/bin/env node
// check_core.js — 分析核心（src/core/）不依賴瀏覽器：每個模組都能在 node 直接 import，原始碼不使用 DOM、WebCodecs、
// 檔案存取等平台 API；再以 tests/fixtures/ 的 WAV（波形碼與 LTC，在這裡直接解析 16-bit PCM）實際跑一次 analyze()，
// 結果須在報告自己的預估誤差內符合真值；並以單元案例檢查建立時間的採用條件。
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
// Creation-time clock (docs/start-time.md): the cases that must not be adopted, or must be, at the edges.
{
  const { createdClock } = await import(pathToFileURL(path.join(CORE, 'analyze.js')));
  const { startDiff } = await import(pathToFileURL(path.join(CORE, 'report.js')));
  const day = Date.UTC(2026, 10, 12) / 1000;          // 2026-11-12 00:00 UTC
  // A result as buildResult() makes it, for the cross-file checks.
  const result = (L, M, ck) => ({ mod: M, startLabel: L, rate: 1, ltc: null, clockType: ck.type || null, clockMatch: !!ck.match,
    startClock: ck.clock === undefined ? L : ck.clock });
  const cases = [];
  // Two files 5 s apart, M = 60, the second device 60 s fast: its creation time passes the 2 s test (whole minutes are
  // invisible at M = 60), so it may only be shown; matching stays on the 60 s cycle and gives 5 s.
  process.env.TZ = 'UTC';
  {
    const ckA = createdClock({ created: day + 36000 }, 0, 60, 30), ckB = createdClock({ created: day + 36065 }, 5, 60, 30);
    const d = startDiff(result(5, 60, ckB), result(0, 60, ckA));
    cases.push(['M = 60、設備快 60 秒：只顯示、不用於比對，差值 5 秒', ckB.type === 'start' && !ckB.match && Math.abs(d - 5) < 1e-9,
      `type ${ckB.type}，match ${ckB.match}，差值 ${d}`]);
  }
  // r = +2.000001 s is 2.000 after rounding to 1 ms: adopted.
  {
    const L = (36000.999999) % 540, ck = createdClock({ created: day + 36003 }, L, 540, 30);
    cases.push(['r = +2.000001 秒：四捨五入到 1 ms 後採用', ck.type === 'start' && ck.r === 2 && ck.match, `type ${ck.type}，r ${ck.r}`]);
  }
  // UTC+9, local time written as UTC: the offset (9 h) is a multiple of 540 s, so both readings pass and none is used.
  process.env.TZ = 'Asia/Tokyo';
  {
    const ck = createdClock({ created: day + 36000 }, 36000 % 540, 540, 30);
    cases.push(['UTC+9、本地時間寫成 UTC：兩種解讀都通過，不採用', ck.type === undefined && ck.bad, `type ${ck.type}，bad ${JSON.stringify(ck.bad)}`]);
  }
  // UTC+8 (not a multiple of 540 s): a proper UTC creation time and a local one written as UTC are each found.
  process.env.TZ = 'Asia/Taipei';
  {
    const L = (10 * 3600) % 540;                        // start 10:00:00 local = 02:00:00 UTC
    const utc = createdClock({ created: day + 2 * 3600 }, L, 540, 30), face = createdClock({ created: day + 10 * 3600 }, L, 540, 30);
    cases.push(['UTC+8：UTC 與本地時間寫成 UTC 各自判讀', utc.zone === 'utc' && face.zone === 'local' && utc.clock === 36000 && face.clock === 36000,
      `${utc.zone} ${utc.clock}，${face.zone} ${face.clock}`]);
  }
  delete process.env.TZ;
  for (const [name, ok, detail] of cases) if (ok) console.log(`✓ 建立時間：${name}`); else fail(`建立時間：${name}（${detail}）`);
}

// Minute markers (docs/waveform-code.md rule 6): several must agree, or none is used.
{
  const { label } = await import(pathToFileURL(path.join(CORE, 'wave.js')));
  // Seconds 10:59:58 .. 11:02:05 local (k from the slate's formula), with minute markers whose minute can be misread.
  const secs = (minutes, pitch) => Array.from({ length: 128 }, (_, i) => {
    const T = 39598 + i, sec = T % 60, k = T % 540, d = { t: 100 + i * 1.0005, val: sec, isMin: sec === 0 };
    if (d.isMin) d.val = minutes.shift();
    if (pitch) d.pitch = (Math.floor(k / 60) + 4 * (k % 60)) % 11;
    return d;
  });
  const cases = [
    ['只有秒數、兩個分鐘標記一致', label(secs([0, 1, 2])).mod === 3600],
    ['只有秒數、分鐘標記不一致：捨棄', label(secs([0, 5, 2])).mod === 60],
    ['音高、兩個分鐘標記一致：3 小時', label(secs([0, 1, 2], true)).mod === 10800],
    ['音高、分鐘標記不一致：捨棄、維持 9 分鐘', label(secs([0, 4, 2], true)).mod === 540],
  ];
  for (const [name, ok] of cases) if (ok) console.log(`✓ 分鐘標記：${name}`); else fail(`分鐘標記：${name}`);
}

// Cross-file range notes (docs/start-time.md): the cycle the alignment used decides the note shown.
{
  const { relRows, relNoteKey } = await import(pathToFileURL(path.join(CORE, 'report.js')));
  const res = (M, ltc = null) => ({ file: 'x', mod: M, startLabel: 1, rate: 1, length: 1, ltc });
  const note = rs => { const rel = relRows(rs.map((r, i) => ({ ...r, file: 'f' + i })), null); return relNoteKey(rel.M); };
  const ltc25 = { label: '25', tcScale: 1 };
  const cases = [[[res(60), res(540)], 'rel.note60'], [[res(540), res(10800)], 'rel.note540'], [[res(10800), res(10800)], 'rel.note10800'],
    [[res(3600), res(10800)], null], [[res(86400, ltc25), res(86400, ltc25)], 'rel.note86400'], [[res(3600), res(540)], 'rel.note180']];
  const bad = cases.filter(([rs, want]) => note(rs) !== want);
  if (bad.length) fail(`比對範圍註記：${bad.map(([rs, want]) => `${rs.map(r => r.mod).join('/')} → ${note(rs)}（應為 ${want}）`).join('；')}`);
  else console.log(`✓ 比對範圍註記：${cases.length} 種循環組合`);
}

console.log(failed ? `結果：${failed} 項不符` : '結果：全部通過');
process.exit(failed ? 1 : 0);
