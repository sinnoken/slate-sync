// fit.js — 波形碼與畫面碼共用的擬合與誤差估計。
import { fitKeep, gcd, mod, polyfit1 } from './util.js';
import { label } from './wave.js';
import { VIS_MOD, labelVisual } from './visual.js';

// Fit file_t = c + rate * R over every labelled second (R: real seconds since the first head second, or the
// first second read in single-end mode). Middle probes are placed with the current line, then added.
export function solve(head, tail, probes, vis) {
  const fi = vis ? vis.fi : 0, labFn = vis ? s => labelVisual(s, fi) : label;
  const tol = vis ? 2 * fi : 0.002, maxRms = vis ? fi : 0.005;
  const LH = head.length ? labFn(head) : null, LT = tail.length ? labFn(tail) : null;
  if (!LH && !LT) return { error: { key: 'err.inconsistent' } };
  // step: the cycle both ends know at least (540 when both read the pitch or the visual code, else 60).
  const step = vis || (LH && LT && LH.mod % VIS_MOD === 0 && LT.mod % VIS_MOD === 0) ? VIS_MOD : 60;
  let pitchRejected = [LH, LT].reduce((a, L) => a + (L && L.pitchRejected || 0), 0);
  let pts, base, M, ambiguous = false, clusters, tailCluster = null;
  if (LH && LT) {
    const lh = LH.lab, lt = LT.lab, [tH, rH] = lh[0], [tT, rT] = lt[lt.length - 1], fileDiff = tT - tH;
    const localRatio = lab => {
      if (lab.length < 2) return null;
      const R0 = lab.map(([t]) => Math.round(t - lab[0][0])), span = R0[R0.length - 1] - R0[0];
      if (span < 2) return null;
      const k = polyfit1(R0, lab.map(([t]) => t))[0];
      return Math.abs(k - 1) <= 0.01 ? [k, span] : null;
    };
    const locs = [localRatio(lh), localRatio(lt)].filter(Boolean);
    const rho = locs.length ? locs.reduce((a, [k, w]) => a + k * w, 0) / locs.reduce((a, [, w]) => a + w, 0) : 1;
    const span = locs.length ? Math.max(...locs.map(([, w]) => w)) : 0;
    const pred = fileDiff / rho, rd = mod(rT - rH, step), realDiff = rd + step * Math.round((pred - rd) / step);
    if (realDiff <= 0) return { error: { key: 'err.headTail' } };
    ambiguous = (span ? 0.003 / span : 0.01) * pred > step / 4 || Math.abs(pred - realDiff) > step / 4;
    // Labels both ends know beyond `step` must agree with the elapsed time, or neither is used.
    let mh = LH.mod, mt = LT.mod;
    const g = gcd(mh, mt);
    if (g > step && mod(rT - rH - realDiff, g) !== 0) mh = mt = step;
    if (Math.max(mh, mt) > step && mh >= mt) { base = mod(rH, mh); M = mh; }
    else if (Math.max(mh, mt) > step) { base = mod(rT - realDiff, mt); M = mt; }
    else { base = mod(rH, step); M = step; }
    pts = lh.map(([t]) => [t, Math.round(t - tH)]).concat(lt.map(([t]) => [t, realDiff - Math.round(tT - t)]));
    clusters = [lh.map(([t]) => t)]; tailCluster = lt.map(([t]) => t);
  } else {
    const L = LH || LT, [t0, r0] = L.lab[0];
    M = L.mod; base = mod(r0, M);
    pts = L.lab.map(([t]) => [t, Math.round(t - t0)]);
    clusters = [L.lab.map(([t]) => t)];
  }
  const iters = vis ? 3 : 4;   // refits: 3 for the visual code, 4 for the waveform code, as each was first validated
  let { keep, rate, c } = fitKeep(pts, tol, iters);
  // Refine each second's start from ALL its pulses (pulse k at offset o_k sits at start + o_k * rate), with
  // median rejection at 1 ms; keep the refined times only if they scatter less than the sync edges alone.
  const pmap = new Map();
  for (const d of head.concat(tail, ...probes)) pmap.set(d.t.toFixed(6), d.pulses);
  const refine = (t, r) => {
    const pl = pmap.get(t.toFixed(6));
    if (!pl || pl.length < 2) return t;
    const est = pl.map(([tp, off]) => tp - off * r), srt = est.slice().sort((x, y) => x - y), med = srt[srt.length >> 1];
    const good = est.filter(v => Math.abs(v - med) < 0.001);
    return good.length ? good.reduce((x, y) => x + y, 0) / good.length : t;
  };
  const rmsOf = (P, F) => { const Q = P.filter((_, i) => F.keep[i]); return Math.sqrt(Q.reduce((x, p) => x + (p[0] - (F.c + F.rate * p[1])) ** 2, 0) / Q.length); };
  const syncFit = { keep, rate, c }, rmsSync = rmsOf(pts, syncFit);
  const refinedPts = pts.map(([t, R]) => [refine(t, rate), R]);
  const refFit = fitKeep(refinedPts, tol, iters);
  const usedPulses = rmsOf(refinedPts, refFit) < 0.9 * rmsSync;
  if (usedPulses) {
    const nh = clusters[0].length;
    pts = refinedPts; ({ keep, rate, c } = refFit);
    if (tailCluster) { clusters = [pts.slice(0, nh).map(p => p[0])]; tailCluster = pts.slice(nh).map(p => p[0]); }
    else clusters = [pts.map(p => p[0])];
  }
  const probeClusters = [];
  for (const secs of probes) {
    const L = labFn(secs);
    if (!L) continue;
    pitchRejected += L.pitchRejected || 0;
    const pstep = gcd(L.mod, step);                       // the cycle both the probe and the ends know
    const [tp0, rp0] = L.lab[0], rPred = (tp0 - c) / rate, rd = mod(rp0 - base, pstep);
    const R0 = rd + pstep * Math.round((rPred - rd) / pstep);
    const add = L.lab.map(([t]) => [usedPulses ? refine(t, rate) : t, R0 + Math.round(t - tp0)]);
    pts = pts.concat(add); probeClusters.push(add.map(([t]) => t));
  }
  if (probeClusters.length) ({ keep, rate, c } = fitKeep(pts, Math.max(0.05, tol), 1));
  const P = pts.filter((_, i) => keep[i]), n = P.length;
  const res = P.map(p => p[0] - (c + rate * p[1]));
  const rms = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / n);
  if (Math.abs(rate - 1) > 0.01 || (!probeClusters.length && rms > maxRms))
    return { error: { key: 'err.badFit', vars: { pct: ((rate - 1) * 100).toFixed(3), ms: (rms * 1000).toFixed(1) } } };
  const Rk = P.map(p => p[1]), Rm = Rk.reduce((a, v) => a + v, 0) / n;
  const sxx = Rk.reduce((a, v) => a + (v - Rm) ** 2, 0);
  let sigma = Math.max(n > 2 ? Math.sqrt(res.reduce((a, v) => a + v * v, 0) / (n - 2)) : 0.0003, 1e-5);
  if (vis) {
    // Each visual edge is only known to within ±half its gap: a uniform spread, sd = width / sqrt(12).
    // Take the larger of that and the scatter actually seen.
    const half = new Map(head.concat(tail, ...probes).map(d => [d.t.toFixed(6), d.half]));
    const w2 = P.map(p => { const h = half.get(p[0].toFixed(6)); return (2 * (h === undefined ? fi / 2 : h)) ** 2 / 12; });
    sigma = Math.max(n > 2 ? Math.sqrt(res.reduce((a, v) => a + v * v, 0) / (n - 2)) : 0, Math.sqrt(w2.reduce((a, v) => a + v, 0) / n));
  }
  const uncPpm = sxx > 0 ? sigma / Math.sqrt(sxx) * 1e6 : NaN;
  const predSe = Rx => sxx > 0 ? sigma * Math.sqrt(1 / n + (Rx - Rm) ** 2 / sxx) : Infinity;
  // Piecewise model when the middle sits off the line (full-recording mode only).
  let segs = null, maxDev = null;
  const cl = clusters.concat(probeClusters.sort((x, y) => x[0] - y[0]), tailCluster ? [tailCluster] : []);
  if (probeClusters.length && cl.length >= 3) {
    const centers = cl.map(ts => { const Q = pts.filter(p => ts.includes(p[0]));
      return [Q.reduce((a, p) => a + p[0], 0) / Q.length, Q.reduce((a, p) => a + p[1], 0) / Q.length]; });
    const devs = centers.map(([tc, rc]) => tc - (c + rate * rc));
    maxDev = Math.max(...devs.map(Math.abs)) * 1000;
    if (maxDev > (vis ? Math.max(2, 1000 * fi) : 2)) segs = centers.slice(1).map(([t2, r2], i) => { const [t1, r1] = centers[i]; return { from: t1, to: t2, rate: (t2 - t1) / (r2 - r1) }; });
  }
  return { rate, c, base, M, ambiguous, n, rejected: pts.length - n, rms, uncPpm, predSe, segs, maxDev,
    both: !!(LH && LT), which: LH && LT ? 'both' : (LH ? 'head' : 'tail'), usedPulses, pitchRejected };
}
