// wave.js — 波形碼解讀（docs/waveform-code.md）：從取樣值找出每一秒的前緣、秒數與音高，再標上 9 分鐘循環內的位置。
import { mod, percentile } from './util.js';
import { VIS_MOD } from './visual.js';

export function runs(mask, sr) {
  const minLen = Math.round(0.006 * sr), maxGap = Math.round(0.006 * sr), out = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const v = i < mask.length && mask[i];
    if (v && s < 0) s = i;
    else if (!v && s >= 0) {
      if (out.length && s - out[out.length - 1][1] < maxGap) out[out.length - 1][1] = i; else out.push([s, i]);
      s = -1;
    }
  }
  return out.filter(([a, b]) => b - a >= minLen);
}

// The 11 legal carrier pitches (pentatonic D5–D7, docs/waveform-code.md); same values as the slate's WAVE_PITCHES.
export const WAVE_HZ = [587.33, 659.26, 783.99, 880.00, 987.77, 1174.66, 1318.51, 1567.98, 1760.00, 1975.53, 2349.32];
// k (position in the 9-minute cycle, 0–539) from a second's number and its pitch number; null when the minute part
// comes out as 9 or 10, i.e. the second's number or its pitch was misread. Inverse of the slate's waveHz().
export const cycleK = (sec, pitch) => { const q = mod(pitch - 4 * sec, 11); return q <= 8 ? 60 * q + sec : null; };
// Leading edge of a burst whose carrier is at `phase` (rad) when its gate opens: first sample above 40 % of
// the burst amplitude, interpolated, minus the time the sine needs from `phase` to first reach |sin| = 0.4.
export function edgeTime(a, s, e, hz, phase, sr) {
  const amp = percentile(a.subarray(s, e), 99), b = Math.max(0, s - Math.round(0.0041667 * sr)), th = 0.4 * amp;
  let i1 = b; while (i1 < e && !(a[i1] > th)) i1++;
  const i0 = Math.max(i1 - 1, 0);
  const frac = i1 > i0 ? (th - a[i0]) / Math.max(a[i1] - a[i0], 1e-12) : 0;
  const ph = mod(phase, Math.PI), lo = Math.asin(0.4), hi = Math.PI - lo;
  const wait = ph >= lo && ph <= hi ? 0 : mod(lo - ph, Math.PI);
  return (i0 + frac) / sr - wait / (2 * Math.PI * hz);
}
// Which legal pitch a burst carries (Hann-windowed match against all 11): its number 0–10.
export function burstPitch(x, s, e, sr) {
  let best = 0, bestM = -1;
  const n = e - s;
  for (const [p, f] of WAVE_HZ.entries()) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)), v = x[s + i] * w, ang = 2 * Math.PI * f * i / sr;
      re += v * Math.cos(ang); im -= v * Math.sin(ang);
    }
    const m = re * re + im * im;
    if (m > bestM) { bestM = m; best = p; }
  }
  return best;
}

export function decode(x, t0, sr) {
  const N = x.length;
  if (N < sr) return [];
  const a = new Float64Array(N);
  for (let i = 0; i < N; i++) a[i] = Math.abs(x[i]);
  const k = Math.round(0.004 * sr);
  const env = new Float64Array(N);
  let acc = 0;
  for (let i = 0; i < N; i++) { acc += a[i]; if (i >= k) acc -= a[i - k]; env[i] = acc / k; }
  for (let i = 0; i < k - 1; i++) env[i] = env[k - 1];
  const blk = Math.round(0.01 * sr), nb = Math.floor(N / blk);
  if (nb < 3) return [];
  const bm = new Float64Array(nb);
  for (let j = 0; j < nb; j++) { let mx = 0; for (let i = j * blk; i < (j + 1) * blk; i++) if (env[i] > mx) mx = env[i]; bm[j] = mx; }
  const w = 60, roll = new Float64Array(nb);
  let gmax = 0;
  for (let j = 0; j < nb; j++) { let mx = 0; for (let q = Math.max(0, j - w); q <= Math.min(nb - 1, j + w); q++) if (bm[q] > mx) mx = bm[q]; roll[j] = mx; if (mx > gmax) gmax = mx; }
  if (gmax < 1e-4) return [];
  const floor = gmax * 1e-3, mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const r = Math.max(roll[Math.min(nb - 1, Math.floor(i / blk))], floor); mask[i] = env[i] > 0.25 * r ? 1 : 0; }
  const on = runs(mask, sr), bursts = on.map(([s, e]) => [s / sr, e / sr]), out = [];
  for (let i = 0; i < on.length; i++) {
    const [s, e] = on[i], dur = (e - s) / sr;
    let isMin;
    if (dur >= 0.025 && dur <= 0.07) isMin = false; else if (dur >= 0.2 && dur <= 0.3) isMin = true; else continue;
    const pitch = burstPitch(x, s, e, sr), hz = WAVE_HZ[pitch];   // one oscillator per second, phase 0 at the sync
    const onset = edgeTime(a, s, e, hz, 0, sr);
    if (onset + 0.95 > N / sr) continue;
    const pulses = bursts.slice(i + 1).filter(q => q[0] < onset + 0.97);
    const groups = []; let cur = [];
    for (const p of pulses) { if (cur.length && p[0] - cur[cur.length - 1][1] > 0.06) { groups.push(cur); cur = []; } cur.push(p); }
    if (cur.length) groups.push(cur);
    if (groups.length !== 2) continue;
    let digits = [], expect = onset + (isMin ? 0.3 : 0.1), nominal = isMin ? 0.3 : 0.1;
    const timed = [[onset, 0]];
    for (const g of groups) {
      if (Math.abs(g[0][0] - expect) > 0.02) { digits = null; break; }
      const lens = g.map(q => q[1] - q[0]);
      let gend, offs, nend;
      if (g.length === 1 && lens[0] >= 0.08 && lens[0] <= 0.125) { digits.push(0); gend = expect + 0.1; offs = [nominal]; nend = nominal + 0.1; }
      else if (lens.every(L => L >= 0.01 && L <= 0.035) && g.every((q, j) => j === 0 || (q[0] - g[j - 1][0] >= 0.034 && q[0] - g[j - 1][0] <= 0.046))) {
        digits.push(g.length); gend = expect + g.length * 0.04 - 0.02;
        offs = g.map((_, j) => nominal + j * 0.04); nend = nominal + g.length * 0.04 - 0.02;
      } else { digits = null; break; }
      // Every digit pulse is another timing point: fixed offset from the second's start, carrier phase 2*pi*pitch*offset.
      g.forEach((q, j) => timed.push([edgeTime(a, Math.round(q[0] * sr), Math.round(q[1] * sr), hz, 2 * Math.PI * hz * offs[j], sr), offs[j]]));
      expect = gend + 0.1; nominal = nend + 0.1;
    }
    if (!digits || digits[0] > 5 || digits[1] > 9) continue;
    const val = digits[0] * 10 + digits[1];
    if (!isMin && val === 0) continue;
    out.push({ t: t0 + onset, val, isMin, pitch, pulses: timed.map(([tp, off]) => [t0 + tp, off]) });
  }
  return out;
}

// The minute marker of these seconds, or null: none, or several that do not agree (each, carried back to the first
// second, must give the same time mod 3600); a misread minute number then cannot pass as the hour position.
function minuteMarker(secs) {
  const ms = secs.filter(s => s.isMin);
  if (!ms.length) return null;
  const at = m => mod(m.val * 60 - Math.round(m.t - secs[0].t), 3600);
  return ms.every(m => at(m) === at(ms[0])) ? ms[0] : null;
}

export function label(seconds) {
  if (!seconds.length) return null;
  seconds = seconds.slice().sort((p, q) => p.t - q.t);
  const ref = seconds[0], rRef = ref.isMin ? 0 : ref.val;
  const good = seconds.filter(s => {
    const dt = s.t - ref.t, k = Math.round(dt);
    return mod(rRef + k, 60) === (s.isMin ? 0 : s.val) && Math.abs(dt - k) <= 0.01 * Math.abs(k) + 0.005;
  });
  if (good.length < Math.max(1, Math.floor(seconds.length / 2))) return null;
  // Rules 5 and 6 of docs/waveform-code.md. Each second's k, carried back to the first good second, is a vote; most
  // seconds agreeing (at least 3, so one or two seconds of an old-slate recording cannot pass by chance) means the
  // pitch carries the 9-minute cycle. Seconds whose pitch disagrees are dropped and counted (pitchRejected).
  const g0 = good[0], kOf = s => s.pitch === undefined ? null : cycleK(s.isMin ? 0 : s.val, s.pitch);
  const votes = new Map();
  for (const s of good) {
    const k = kOf(s);
    if (k !== null) { const k0 = mod(k - Math.round(s.t - g0.t), VIS_MOD); votes.set(k0, (votes.get(k0) || 0) + 1); }
  }
  let k0 = null, nk = 0;
  for (const [k, n] of votes) if (n > nk) { k0 = k; nk = n; }
  if (nk >= 3 && nk > good.length / 2) {
    const kAt = s => mod(k0 + Math.round(s.t - g0.t), VIS_MOD), kept = good.filter(s => kOf(s) === kAt(s));
    const lab = kept.map(s => [s.t, kAt(s)]), pitchRejected = good.length - kept.length, marker = minuteMarker(kept);
    if (marker) {
      // The minute marker gives the time mod 3600 and k mod 540; both give it mod 180 (their gcd). Only when they
      // agree are they merged into seconds mod 10800 (3 hours).
      const km = kAt(marker), hm = marker.val * 60;
      if (mod(hm - km, 180) === 0) {
        const x = [0, 1, 2].map(j => hm + 3600 * j).find(v => v % VIS_MOD === km);
        return { lab: kept.map(s => [s.t, mod(x + Math.round(s.t - marker.t), 10800)]), mod: 10800, pitchRejected };
      }
    }
    return { lab, mod: VIS_MOD, pitchRejected };
  }
  const marker = minuteMarker(good);
  if (marker) return { lab: good.map(s => [s.t, mod(marker.val * 60 + Math.round(s.t - marker.t), 3600)]), mod: 3600, pitchRejected: 0 };
  return { lab: good.map(s => [s.t, mod(rRef + Math.round(s.t - ref.t), 60)]), mod: 60, pitchRejected: 0 };
}
