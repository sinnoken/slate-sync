// wave-pitch.test.mjs — 波形碼載波（docs/waveform-code.md「載波」）：場記板與分析核心都符合規格。
//
// 比對對象是這裡獨立寫的規格公式（與測試產生器相同：k = 午夜起秒數 mod 540，音高編號 = (⌊k / 60⌋ + 4 × (k mod 60)) mod 11）
// 與固定的音高表、抽查值：
// - 場記板（vm 執行 web/sync-slate.html 的 cycleK()／waveHz()）：UTC 與 UTC+8 各連續兩天逐秒（含跨午夜，另抽查整秒內的毫秒），
//   k 與音高都與公式相同，相鄰兩秒都不同音。
// - 分析核心（src/core/wave.js 的 WAVE_HZ、cycleK(秒, 音高編號)）：60 × 11 種組合中 540 種解回 0–539 的每個 k 各一次、
//   與公式一致，其餘 120 種判為讀錯（null）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadSlate } from './lib/slate.mjs';

const PITCHES = [587.33, 659.26, 783.99, 880.00, 987.77, 1174.66, 1318.51, 1567.98, 1760.00, 1975.53, 2349.32];
const VIS_MOD = 540;
const kOf = secOfDay => Math.floor(secOfDay) % 86400 % VIS_MOD;
const pitchOf = k => (Math.floor(k / 60) + 4 * (k % 60)) % 11;
const DAYS = 2;
const ZONES = [['UTC', 0], ['Asia/Taipei', 8 * 3600]];      // 與 UTC 的差（秒），兩者都沒有日光節約時間
const BASE_UTC = Date.UTC(2026, 10, 12) / 1000;

const core = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'wave.js')));

test('規格公式的抽查值', () => {
  // [k, 音高編號]：k = 0、1、59、60、539 與 10:24:37（k = 217）
  for (const [k, p] of [[0, 0], [1, 4], [59, 5], [60, 1], [539, 2], [217, 8]]) assert.equal(pitchOf(k), p, `k = ${k}`);
  assert.equal(kOf(10 * 3600 + 24 * 60 + 37.9), 217);
  assert.equal(kOf(86400 + 5), 5);
});

test('音高表：場記板與分析核心相同', () => {
  assert.deepEqual(Array.from(loadSlate(['WAVE_PITCHES']).WAVE_PITCHES), PITCHES);
  assert.deepEqual(Array.from(core.WAVE_HZ), PITCHES);
});

for (const [tz, off] of ZONES) {
  test(`場記板 ${tz}：${DAYS} 天逐秒的 k 與音高符合公式，相鄰兩秒不同音`, () => {
    const saved = process.env.TZ;
    process.env.TZ = tz;
    try {
      const slate = loadSlate(['cycleK', 'WAVE_PITCHES', 'waveHz']);
      const base = (BASE_UTC - off) * 1000;               // 該時區的本地午夜
      let prevHz = null, checked = 0;
      for (let i = 0; i < DAYS * 86400; i++) {
        const k = slate.cycleK(base + i * 1000), hz = slate.waveHz(k), want = kOf(i);
        if (k !== want) assert.fail(`第 ${i} 秒：k = ${k}，應為 ${want}`);
        if (hz !== PITCHES[pitchOf(want)]) assert.fail(`第 ${i} 秒：${hz} Hz，應為 ${PITCHES[pitchOf(want)]}`);
        if (hz === prevHz) assert.fail(`第 ${i} 秒與前一秒同音 ${hz} Hz`);
        if (i % 997 === 0) {
          const sub = slate.cycleK(base + i * 1000 + 999);
          if (sub !== want) assert.fail(`第 ${i} 秒 + 999 ms：k = ${sub}`);
        }
        // 分析核心由秒數與音高解回同一個 k
        if (core.cycleK(want % 60, core.WAVE_HZ.indexOf(hz)) !== want) assert.fail(`第 ${i} 秒：分析核心解不回 k = ${want}`);
        prevHz = hz;
        checked++;
      }
      assert.equal(checked, DAYS * 86400);
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
}

test(`測試產生器：${DAYS} 天逐秒的 k 與音高符合公式`, async () => {
  const gen = await import(pathToFileURL(path.join(ROOT, 'tests', 'make_test_media.mjs')));
  for (let i = 0; i < DAYS * 86400; i++) {
    if (gen.tagId(i + 0.5) !== kOf(i)) assert.fail(`第 ${i} 秒：k = ${gen.tagId(i + 0.5)}，應為 ${kOf(i)}`);
    if (gen.waveHz(i) !== PITCHES[pitchOf(kOf(i))]) assert.fail(`第 ${i} 秒：${gen.waveHz(i)} Hz，應為 ${PITCHES[pitchOf(kOf(i))]}`);
  }
});

test('分析核心 cycleK()：540 種組合解回 0–539 各一次，其餘 120 種判為讀錯', () => {
  const seen = new Set();
  let invalid = 0;
  for (let sec = 0; sec < 60; sec++) for (let p = 0; p < 11; p++) {
    const k = core.cycleK(sec, p);
    if (k === null) { invalid++; continue; }
    assert.ok(Number.isInteger(k) && k >= 0 && k < VIS_MOD, `(${sec}, ${p}) → ${k} 不在 0–539`);
    assert.equal(k % 60, sec, `(${sec}, ${p}) → ${k}：秒數不符`);
    assert.equal(pitchOf(k), p, `(${sec}, ${p}) → ${k}：音高不符`);
    assert.ok(!seen.has(k), `k = ${k} 出現兩次`);
    seen.add(k);
  }
  assert.equal(seen.size, VIS_MOD);
  assert.equal(invalid, 120);
});
