// ltc-bits.test.mjs — 場記板的 LTC 輸出（docs/ltc.md「場記板輸出」）符合規格。
//
// 比對對象：
// - 這裡獨立寫的參考實作（與測試產生器的算法相同：SMPTE 12M 的位元位置、DF 丟格、極性位元、雙相位標記的取樣位置）。
//   場記板（src/core/slate.js）的 countToTC()／ltcBits()，24、25、29.97 DF、29.97 NDF、30、23.976 各約 5400 格逐格比對
//   （午夜前後、每分鐘與每 10 分鐘的邊界、全天抽查）；再以模擬的 AudioContext 執行 ltcChunk()（漂移鎖定不介入），
//   連續 4 個區塊跨過午夜，與參考實作逐個取樣比對（位元、極性、振幅 0.5、格起點的取樣位置、跨區塊連續）。
// - 固定的期望值：DF 丟格規則（每分鐘跳過 ;00、;01，每 10 分鐘不跳、一天 2589408 格）、同步字與振幅。
// - 分析核心（src/core/ltc.js）：tcToCount() 把場記板的時間碼換回同一個格數；ltcDecode() 從場記板輸出的取樣解回連續的格數。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as slate from '../src/core/slate.js';
import { ROOT } from './lib/root.mjs';

const core = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'ltc.js')));
const AMP = 0.5;
const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];   // SMPTE 12M 的同步字（位元 64–79）
const SR = 48000;
const CHUNKS = 4;                                                 // ltcChunk(8) 的呼叫次數
const CASES = [['24', 24, 24, false], ['25', 25, 25, false], ['29.97 DF', 30000 / 1001, 30, true],
  ['29.97 NDF', 30000 / 1001, 30, false], ['30', 30, 30, false], ['23.976', 24000 / 1001, 24, false]];

// ---- 參考實作（與測試產生器相同的算法） ----
const dayOf = p => p.df ? 2589408 : p.nominal * 86400;
function refTC(n, p) {
  const day = dayOf(p);
  n = ((n % day) + day) % day;
  if (p.df) { const D = Math.floor(n / 17982), M = n % 17982; n += 18 * D + (M > 1 ? 2 * Math.floor((M - 2) / 1798) : 0); }
  const nb = p.nominal;
  return [Math.floor(n / (nb * 3600)) % 24, Math.floor(n / (nb * 60)) % 60, Math.floor(n / nb) % 60, n % nb];
}
function refBits(n, p) {
  const [h, m, s, f] = refTC(n, p), bits = new Array(80).fill(0);
  const put = (v, at, len) => { for (let j = 0; j < len; j++) bits[at + j] = (v >> j) & 1; };
  put(f % 10, 0, 4); put(Math.floor(f / 10), 8, 2); bits[10] = p.df ? 1 : 0;
  put(s % 10, 16, 4); put(Math.floor(s / 10), 24, 3);
  put(m % 10, 32, 4); put(Math.floor(m / 10), 40, 3);
  put(h % 10, 48, 4); put(Math.floor(h / 10), 56, 2);
  SYNC.forEach((b, i) => { bits[64 + i] = b; });
  bits[p.nominal === 25 ? 59 : 27] = bits.reduce((a, b) => a + b, 0) % 2;    // 極性位元：1 的個數為偶數
  return bits;
}
// 手機輸出的取樣：每個位元開頭翻轉、位元為 1 時中點再翻轉，第一個位準為 −0.5；第 g 個半位元的邊界在 round(g × spb)。
function refSamples(p, startCount, nFrames) {
  const spb = SR / (p.rate * 80), at = x => Math.floor(x * spb + 0.5);
  const out = new Float64Array(at(nFrames * 80));
  let lvl = AMP;
  for (let fi = 0; fi < nFrames; fi++) {
    const bits = refBits(startCount + fi, p);
    for (let b = 0; b < 80; b++) {
      const g = fi * 80 + b;
      lvl = -lvl;
      out.fill(lvl, at(g), at(g + 0.5));
      if (bits[b]) lvl = -lvl;
      out.fill(lvl, at(g + 0.5), at(g + 1));
    }
  }
  return out;
}

// 要比對的格數：午夜前後、DF 每分鐘與每 10 分鐘的邊界（前 5 小時）、全天以固定種子抽查 3000 格。
function frames(p) {
  const day = dayOf(p), ns = new Set();
  for (let i = 0; i < 200; i++) ns.add(i);
  for (let i = day - 200; i < day + 200; i++) ns.add(i);
  for (let k = 0; k < 300; k++) {
    const b = p.df ? Math.floor(k / 10) * 17982 + (k % 10) * 1798 + (k % 10 ? 2 : 0) : k * 60 * p.nominal;
    for (let i = Math.max(0, b - 3); i < b + 3; i++) ns.add(i);
  }
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 3000; i++) ns.add(Math.floor(rnd() * day));
  return [...ns].sort((a, b) => a - b);
}

test('參考實作與固定期望值：DF 丟格規則', () => {
  const p = { rate: 30000 / 1001, nominal: 30, df: true };
  const expect = [[1799, [0, 0, 59, 29]], [1800, [0, 1, 0, 2]], [17981, [0, 9, 59, 29]], [17982, [0, 10, 0, 0]],
    [17982 + 1800, [0, 11, 0, 2]], [2589407, [23, 59, 59, 29]], [2589408, [0, 0, 0, 0]]];
  for (const [n, tc] of expect) {
    assert.deepEqual(refTC(n, p), tc, `參考實作第 ${n} 格`);
    const t = slate.countToTC(n, p);
    assert.deepEqual([t.h, t.m, t.s, t.f], tc, `場記板第 ${n} 格`);
  }
});

test('同步字與振幅', () => {
  assert.equal(slate.LTC_AMP, AMP);
  assert.deepEqual(slate.LTC_SYNC, SYNC);
});

for (const [name, rate, nominal, df] of CASES) {
  const p = { rate, nominal, df };
  test(`${name}：時間碼與 80 個位元逐格相同`, () => {
    const ns = frames(p), day = dayOf(p);
    let n0 = 0;
    for (const n of ns) {
      const t = slate.countToTC(n, p), tc = [t.h, t.m, t.s, t.f], want = refTC(n, p);
      if (tc.join() !== want.join()) assert.fail(`第 ${n} 格：場記板 ${tc}，參考 ${want}`);
      const bits = slate.ltcBits(n, p), wb = refBits(n, p);
      if (bits.join('') !== wb.join('')) assert.fail(`第 ${n} 格的位元不同：\n場記板 ${bits.join('')}\n參考   ${wb.join('')}`);
      if (core.tcToCount(...tc, nominal, df) !== n % day) assert.fail(`第 ${n} 格：分析核心換回 ${core.tcToCount(...tc, nominal, df)}`);
      n0++;
    }
    assert.ok(n0 > 5000, `只比對了 ${n0} 格`);
  });

  test(`${name}：ltcChunk() ${CHUNKS} 個區塊（跨午夜）的取樣相同，分析核心解得回來`, () => {
    const bufs = [];
    const ctx = {
      getOutputTimestamp: null, destination: {},
      createBuffer(c, n) { const d = new Float32Array(n); bufs.push(d); return { getChannelData: () => d }; },
      createBufferSource: () => ({ connect() {}, start() {} }),
    };
    const startCount = dayOf(p) - 12;                    // 午夜前 12 格開始
    const ltc = { p, sr: SR, T0: 0, startCount, frame: 0, sample: 0, level: 1, adj: 0, err: 0, sources: [] };
    for (let i = 0; i < CHUNKS; i++) slate.ltcChunk(ltc, ctx, 8);
    const got = new Float64Array(bufs.reduce((a, d) => a + d.length, 0));
    let o = 0;
    for (const d of bufs) { got.set(d, o); o += d.length; }
    const want = refSamples(p, startCount, 8 * CHUNKS);
    assert.equal(got.length, want.length, '取樣數');
    const k = got.findIndex((v, i) => v !== want[i]);
    assert.equal(k, -1, `第 ${k} 個取樣不同：場記板 ${got[k]}，參考 ${want[k]}`);
    // 分析核心的解碼器（獨立的零交越與雙相位解讀）讀回的格數連續，且就是場記板送出的那幾格。
    const dec = core.ltcDecode(Float32Array.from(got), 0, SR);
    assert.ok(dec.length >= 8 * CHUNKS - 4, `只解出 ${dec.length} 格`);
    for (const q of dec) {
      const i = Math.round(q.t * rate);
      assert.equal(q.n, (startCount + i) % dayOf(p), `第 ${i} 格（${q.t.toFixed(4)} 秒）`);
      assert.equal(q.df, df);
    }
  });

  test(`${name}：測試產生器的 LTC 變化點與參考實作相同（跨午夜、跨區塊）`, async () => {
    const gen = await import(pathToFileURL(path.join(ROOT, 'tests', 'make_test_media.mjs')));
    const startCount = dayOf(p) - 300, nFrames = 450;     // 產生器每 200 格呼叫一次 ltcChunk()
    const { pos, level } = gen.ltcLevels(p, startCount, nFrames);
    const want = refSamples(p, startCount, nFrames), got = new Float64Array(want.length);
    assert.equal(pos[pos.length - 1], want.length, '結束位置');
    assert.equal(level[level.length - 1], 0, '結束後位準回到 0');
    for (let j = 0; j + 1 < pos.length; j++) got.fill(level[j], pos[j], pos[j + 1]);
    const k = got.findIndex((v, i) => v !== want[i]);
    assert.equal(k, -1, `第 ${k} 個取樣不同：產生器 ${got[k]}，參考 ${want[k]}`);
    assert.equal(gen.ltcStartCount(36000 * 30, gen.ltcParams('29.97', true)), 36000 * 30, 'DF 的第一格就是格邊界數');
    // 29.97 NDF 在 10:00:00 後的第一個格邊界（第 1078922 個，10:00:00.0307）標成最接近的 10:00:00:01（格數 1080001）。
    assert.equal(gen.ltcStartCount(Math.ceil(36000 * 30000 / 1001), gen.ltcParams('29.97')), 36000 * 30 + 1, 'NDF 的第一格對齊真實時間');
  });
}
