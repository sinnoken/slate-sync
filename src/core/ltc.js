// ltc.js — LTC 解讀與擬合（docs/ltc.md）。
import { fitKeep, mod, percentile, wrap } from './util.js';

export const LTC_SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
export const LTC_DF_DAY = 2589408;                      // frames in a day at 29.97 DF
export const ltcDay = (nominal, df) => df ? LTC_DF_DAY : nominal * 86400;
// Real frame rates of each time-code frame count (23.976 and 29.97 count 24 and 30 frames a second).
export const ltcRates = (nominal, df) => df ? [30000 / 1001] : nominal === 25 ? [25] : [nominal * 1000 / 1001, nominal];

// Zero crossings, interpolated between samples. Hysteresis at 30 % of the level keeps noise near zero from adding
// crossings: each crossing is the last sign change before the signal passes the opposite threshold.
export function zeroCrossings(x, t0, sr) {
  const N = x.length, ab = new Float64Array(Math.ceil(N / 7)), out = [];
  for (let i = 0, j = 0; i < N; i += 7, j++) ab[j] = Math.abs(x[i]);
  const h = 0.3 * percentile(ab, 99);
  if (!(h > 3e-5)) return out;
  let st = 0, last = 0;
  for (let i = 0; i < N; i++) {
    const v = x[i];
    if (!(st >= 0 && v < -h) && !(st <= 0 && v > h)) continue;
    if (st) {
      let k = i;
      while (k > last + 1 && (st > 0 ? x[k - 1] < 0 : x[k - 1] > 0)) k--;
      const a = x[k - 1], b = x[k];
      out.push(t0 + (k - 1 + (a === b ? 0.5 : a / (a - b))) / sr);
    }
    st = v > 0 ? 1 : -1; last = i;
  }
  return out;
}

// Frame number since midnight from a time code (DF: the dropped frame numbers taken back out).
export function tcToCount(h, m, s, f, nominal, df) {
  const n = ((h * 60 + m) * 60 + s) * nominal + f, tm = h * 60 + m;
  return df ? n - 2 * (tm - Math.floor(tm / 10)) : n;
}

// Biphase-mark frames from the crossings, for bit period T: an interval of about T is a 0, two of about T/2 a 1.
// A frame is the 64 bits before a sync word; its time is the crossing that starts bit 0. Polarity does not matter.
export function ltcFrames(cx, T, nominal) {
  const bits = [], at = [], lo = 0.25 * T, mid = 0.75 * T, hi = 1.5 * T, out = [];
  for (let i = 0; i + 1 < cx.length;) {
    const d = cx[i + 1] - cx[i], d2 = i + 2 < cx.length ? cx[i + 2] - cx[i + 1] : 0;
    at.push(cx[i]);
    if (d >= mid && d < hi) { bits.push(0); i++; }
    else if (d >= lo && d < mid && d2 >= lo && d2 < mid) { bits.push(1); i += 2; }
    else { bits.push(-1); i++; }
  }
  for (let k = 64; k + 16 <= bits.length; k++) {
    let ok = true;
    for (let j = 0; j < 16 && ok; j++) ok = bits[k + j] === LTC_SYNC[j];
    for (let j = k - 64; j < k && ok; j++) ok = bits[j] >= 0;
    if (!ok) continue;
    const v = (a, n) => { let r = 0; for (let j = 0; j < n; j++) r |= bits[k - 64 + a + j] << j; return r; };
    const u = [v(0, 4), v(16, 4), v(32, 4), v(48, 4)], df = bits[k - 54];
    if (u.some(x => x > 9)) continue;
    const f = v(8, 2) * 10 + u[0], sec = v(24, 3) * 10 + u[1], m = v(40, 3) * 10 + u[2], h = v(56, 2) * 10 + u[3];
    if (f >= nominal || sec > 59 || m > 59 || h > 23 || (df && (nominal !== 30 || (sec === 0 && f < 2 && m % 10)))) continue;
    out.push({ t: at[k - 64], n: tcToCount(h, m, sec, f, nominal, df), nominal, df: !!df });
  }
  // Continuity: a frame is kept only when the frame decoded just before it is the previous frame, one frame earlier.
  return out.filter((q, i) => i > 0 && q.df === out[i - 1].df && mod(q.n - out[i - 1].n, ltcDay(nominal, q.df)) === 1 &&
    Math.abs((q.t - out[i - 1].t) * nominal - 1) < 0.05);
}

// LTC frames in one channel: [{ t, n, nominal, df }]. Each frame-count class (24, 25, 30) is tried at its bit rate and
// the one giving the most frames is kept, if its measured frame rate is within 1 % of a legal LTC rate.
export function ltcDecode(x, t0, sr) {
  const cx = zeroCrossings(x, t0, sr);
  let best = [];
  if (cx.length < 200) return best;
  for (const nominal of [24, 25, 30]) { const F = ltcFrames(cx, 1 / (80 * nominal), nominal); if (F.length > best.length) best = F; }
  if (best.length < 2) return [];
  const gaps = best.slice(1).map((q, i) => q.t - best[i].t).filter(d => Math.abs(d * best[0].nominal - 1) < 0.05);
  const fps = 1 / percentile(gaps, 50);
  return ltcRates(best[0].nominal, false).some(r => Math.abs(fps / r - 1) <= 0.01) ? best : [];
}

// Fit file_t = c + rate * R over every LTC frame start (R: real seconds since the first frame, n / frame rate). Same
// statistics as solve(). 23.976 and 24 (29.97 NDF and 30) count frames alike and differ by only 0.1 %: a video track
// in the same file decides when its frame rate is a whole multiple of one of them (cameras record at the time-code
// rate or a multiple); otherwise the rate giving a speed nearer 1 wins, flagged when the drift is large enough for
// that guess to be wrong (docs/ltc.md).
export function ltcSolve(head, tail, probes, videoFps = null) {
  const all = head.concat(tail, ...probes);
  const count = f => all.filter(f).length;
  const nominal = [24, 25, 30].reduce((a, b) => count(q => q.nominal === b) > count(q => q.nominal === a) ? b : a);
  const df = count(q => q.nominal === nominal && q.df) * 2 > count(q => q.nominal === nominal);
  const use = q => q.nominal === nominal && q.df === df;
  const groups = [head, ...probes.slice().sort((x, y) => x[0].t - y[0].t), tail].map(g => g.filter(use).sort((x, y) => x.t - y.t)).filter(g => g.length);
  const frames = groups.flat();
  if (frames.length < 2) return { error: { key: 'err.inconsistent' } };
  const day = ltcDay(nominal, df), n0 = groups[0][0].n;
  const rates = ltcRates(nominal, df);
  const byVideo = videoFps ? rates.filter(fr => { const k = Math.round(videoFps / fr); return k >= 1 && Math.abs(videoFps / (k * fr) - 1) < 1e-4; }) : [];
  let best = null;
  for (const fr of byVideo.length === 1 ? byVideo : rates) {
    const pts = frames.map(q => [q.t, wrap(q.n - n0, day) / fr]), F = fitKeep(pts, 0.002, 4);
    if (!best || Math.abs(F.rate - 1) < Math.abs(best.F.rate - 1)) best = { fr, pts, F };
  }
  const fromVideo = byVideo.length === 1;
  const { fr, pts, F: { keep, rate, c } } = best;
  const P = pts.filter((_, i) => keep[i]), n = P.length;
  const res = P.map(p => p[0] - (c + rate * p[1])), ss = res.reduce((a, v) => a + v * v, 0), rms = Math.sqrt(ss / n);
  if (Math.abs(rate - 1) > 0.01 || (!probes.length && rms > 0.005))
    return { error: { key: 'err.badFit', vars: { pct: ((rate - 1) * 100).toFixed(3), ms: (rms * 1000).toFixed(1) } } };
  const Rm = P.reduce((a, p) => a + p[1], 0) / n, sxx = P.reduce((a, p) => a + (p[1] - Rm) ** 2, 0);
  const sigma = Math.max(n > 2 ? Math.sqrt(ss / (n - 2)) : 0.0003, 1e-5);
  const predSe = Rx => sxx > 0 ? sigma * Math.sqrt(1 / n + (Rx - Rm) ** 2 / sxx) : Infinity;
  // Piecewise model when the middle sits off the line (full-recording mode only), as in solve().
  let segs = null, maxDev = null, i0 = 0;
  if (probes.length && groups.length >= 3) {
    const centers = groups.map(g => { const Q = pts.slice(i0, i0 += g.length);
      return [Q.reduce((a, p) => a + p[0], 0) / Q.length, Q.reduce((a, p) => a + p[1], 0) / Q.length]; });
    maxDev = Math.max(...centers.map(([tc, rc]) => Math.abs(tc - (c + rate * rc)))) * 1000;
    if (maxDev > 2) segs = centers.slice(1).map(([t2, r2], i) => { const [t1, r1] = centers[i]; return { from: t1, to: t2, rate: (t2 - t1) / (r2 - r1) }; });
  }
  // DF and whole-number rates: n / rate is the slate's clock. 23.976 and 29.97 NDF: the time code itself (n / nominal),
  // which runs 0.1 % slow; tcScale turns real seconds into time-code seconds.
  const ndf = !df && fr !== nominal, label = nominal === 25 ? '25' : fr !== nominal ? (nominal === 24 ? '23.976' : df ? '29.97 DF' : '29.97 NDF') : String(nominal);
  const hd = head.some(use), tl = tail.some(use);
  return { rate, c, base: n0 / (ndf ? nominal : fr), M: 86400, ambiguous: false, n, rejected: pts.length - n, rms,
    uncPpm: sxx > 0 ? sigma / Math.sqrt(sxx) * 1e6 : NaN, predSe, segs, maxDev, both: hd && tl, which: hd && tl ? 'both' : (hd ? 'head' : 'tail'),
    usedPulses: false, pitchRejected: 0,
    // 30 vs 29.97 NDF (24 vs 23.976) differ by only 0.1 %: the rate with the drift nearest zero was chosen, which
    // can be wrong once the device drifts by several hundred ppm, so a drift above 100 ppm without a video track is flagged.
    ltc: { label, tcScale: ndf ? fr / nominal : 1, rateGuess: rates.length > 1 && !fromVideo && Math.abs(rate - 1) > 100e-6 } };
}
