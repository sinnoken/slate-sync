// visual.js — 畫面碼（AprilTag，docs/visual-code.md）：碼表與字典、偵測、影格級邊緣、標示與量化誤差下限。
import { AR, CV } from './aruco.js';
import { TAG36H11_BIT_X, TAG36H11_BIT_Y, TAG36H11_CODES } from './slate.js';
import { NTSC, mod } from './util.js';

export const VIS_MOD = 540;       // ID = seconds since local midnight mod 540 (9 minutes)
export const VIS_SHORT = 360;     // frames are scaled to about this short side before detection
export const VCHUNK = 2.5;        // minimum seconds per video read; reads end on a keyframe so the next one needs no pre-roll
export const VCHUNK_KEY = 4.0;    // how far past VCHUNK to look for that keyframe
export const VIS_PLATEAU = 5.0;   // stop when the estimated error has not dropped for this many seconds of video
export const SOUND = 343;         // m/s, for the distance field

// js-aruco2 reads the 6 x 6 data cells row by row from the top left, the first cell being the most significant bit
// and white being 1. Data bit i (bit 35 - i of the code) sits at row bit_y[i] - 1, column bit_x[i] - 1 of those cells.
// Only IDs 0-539 are used by the slate; tau 3 allows up to 2 bit errors (tag36h11 codes are at least 11 apart).
AR.DICTIONARIES.TAG36H11 = { nBits: 36, tau: 3, codeList: TAG36H11_CODES.slice(0, VIS_MOD).map(code => {
  const cell = new Array(36);
  // Division instead of bit shifts: codes are 36 bits, wider than the 32-bit integer operators.
  for (let i = 0; i < 36; i++) cell[(TAG36H11_BIT_Y[i] - 1) * 6 + TAG36H11_BIT_X[i] - 1] = Math.floor(code / 2 ** (35 - i)) % 2;
  return cell.reduce((v, b) => v * 2 + b, 0);
}) };
let tagDetector = null;
// AR.Detector.detect() without its RGBA -> grey step (the frames are grey already) and without notTooNear(): of two
// quads whose corners are close it keeps only the larger, and for a small tag (about 2 px per cell) that is the white
// quiet zone's outline, which has no bits, instead of the black border. Every candidate is decoded instead.
export function detectTags(w, h, grey) {
  const d = tagDetector || (tagDetector = new AR.Detector({ dictionaryName: 'TAG36H11', maxHammingDistance: 3 }));
  d.grey = new CV.Image(w, h, grey);
  CV.adaptiveThreshold(d.grey, d.thres, 2, 7);
  d.contours = CV.findContours(d.thres, d.binary);
  let c = d.findCandidates(d.contours, w * 0.01, 0.05, 10);
  c = d.clockwiseCorners(c);
  return d.findMarkers(d.grey, c, 49);
}

// Frame-level edges: a frame showing ID n whose nearest earlier decoded frame showed n - 1 (mod 540), with only
// undecodable transition frames between them. Edge at the midpoint, ±half the gap. frames: Map file time -> ID|null.
export function frameEdges(frames, fi) {
  const out = [];
  let last = null, prev = null;
  for (const t of [...frames.keys()].sort((x, y) => x - y)) {
    const idx = frames.get(t);
    if (prev !== null && t - prev > 1.5 * fi) last = null;   // frames not contiguous (a gap between reads)
    prev = t;
    if (idx === null) continue;
    if (last && idx === (last[1] + 1) % VIS_MOD && t - last[0] <= 3.5 * fi)
      out.push({ t: (last[0] + t) / 2, half: (t - last[0]) / 2, val: idx, isMin: false });
    last = [t, idx];
  }
  return out;
}

// Visual counterpart of label(): keep the edges that step up by one ID per second (about 1 s apart).
export function labelVisual(edges, fi) {
  if (!edges.length) return null;
  edges = edges.slice().sort((p, q) => p.t - q.t);
  const agree = ref => edges.filter(e => {
    const dt = e.t - ref.t, k = Math.round(dt);
    return mod(ref.val + k, VIS_MOD) === e.val && Math.abs(dt - k) <= 0.01 * Math.abs(k) + 3 * fi;
  }).map(e => [e.t, e.val]);
  let good = [];
  for (const r of edges) { const g = agree(r); if (g.length > good.length) good = g; }
  if (good.length < Math.max(1, Math.floor(edges.length / 2))) return null;
  return { lab: good, mod: VIS_MOD };
}

export function exactFps(fps) {
  for (const e of NTSC) if (fps && Math.abs(fps - e) < 0.005) return e;   // 59.94 -> 59.94005994...
  return fps;
}

// Lower bounds for frame-level timing: [position error anywhere in the file in s,
// speed-ratio error]. h = half a frame. Frame-level edges only average out their quantisation when successive seconds
// fall at different phases of the frame grid; per end the residual F is the largest of:
//   - h when the frame rate divides one second, the frame grid is irregular (VFR) or the fit is unknown;
//   - sweep: the phase moves by step = |frac(fps x rate)| frames per real second; counting only the part of step the
//     speed bound cannot explain, sure = max(0, step - fps x 2F / base), an end whose edges span S seconds sweeps
//     sure x S frames and keeps h / max(1, sure x S);
//   - coverage: the phases the edges actually fell at (from the fit); the widest circular gap g between the n edges'
//     phases leaves h x min(1, g + 1/n).
// Speed bound: 2F / base over two ends (base = distance between their mean edge times), 3F / S for one end alone.
// Position bound: F + speed bound x reach, reach = largest distance from either end of the file to the nearer end's
// mean edge time. ends: the edges ({ t, half }) read at each end; D: file duration.
export function visFloor(fps, fit, ends, D, vfr) {
  const h = 0.5 / fps, fi = 1 / fps, mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  ends = ends.filter(es => es.length).map(es => es.slice().sort((p, q) => p.t - q.t));
  if (!ends.length) return [h, Infinity];
  const ts = ends.map(es => es.map(e => e.t));
  const span = Math.min(...ts.map(t => t[t.length - 1] - t[0]));
  const base = Math.max(ts.length > 1 ? mean(ts[ts.length - 1]) - mean(ts[0]) : span, 1);
  let F = h;
  if (fit && fit.rate !== undefined && !vfr && Math.abs(fps - Math.round(fps)) >= 1e-3) {
    const { rate, c } = fit;
    let step = fps * rate;
    step = Math.abs(step - Math.round(step));
    for (let k = 0; k < 5; k++) F = h / Math.max(1, Math.max(0, step - fps * 2 * F / base) * span);
    for (const es of ends) {
      const ph = es.map(e => mod(((c + rate * Math.round((e.t - c) / rate)) - (e.t - e.half)) / fi, 1)).sort((x, y) => x - y);
      let g = ph[0] + 1 - ph[ph.length - 1];
      for (let k = 1; k < ph.length; k++) g = Math.max(g, ph[k] - ph[k - 1]);
      F = Math.max(F, h * Math.min(1, g + 1 / es.length));
    }
  }
  const rateFloor = ts.length > 1 ? 2 * F / base : 3 * F / Math.max(span, 1);
  const reach = Math.max(mean(ts[0]), D - mean(ts[ts.length - 1]), 0);
  return [F + rateFloor * reach, rateFloor];
}
export const visWorst = (fit, D, fps, ends, vfr) =>
  Math.max(fit.predSe((0 - fit.c) / fit.rate), fit.predSe((D - fit.c) / fit.rate), visFloor(fps, fit, ends, D, vfr)[0]) * 1000;
