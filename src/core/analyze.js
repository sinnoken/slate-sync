// analyze.js — 分析流程：從頭尾往內讀、達到目標精度即停、抽查中段、聲畫同步檢查，組成每個檔案的結果。
// 讀檔與解碼由平台提供（網頁：WebCodecs；命令列：ffmpeg），這裡只用下列介面，不碰 DOM 或檔案：
//   m.name、m.modified（檔案修改時間，毫秒）、m.duration、m.movieDuration、m.hasAudio、m.hasVideo、m.aOff、m.aDur、m.vOff、m.vDur、
//   m.vFrames、m.fps、m.vfr、m.created（Unix 秒）、m.bextSec（午夜起秒數）；
//   m.readWindow(a, b) → { chans: Float32Array[], t0, sr }：檔案時間 [a, b) 的取樣，chans[*][0] 位於 t0；
//   m.openVideo() → 畫面讀取器（見 VEnd）或 { unsupported: { why, ... } }。
// opts：only（'head'／'tail'）、probe（中段抽查處數）、minute、av、distance（公尺），另有命令列用的
//   search（分鐘）、maxRead、target（ms）、channel（0 起算）。
import { mod, NTSC, polyfit1, wrap } from './util.js';
import { decode } from './wave.js';
import { ltcDecode, ltcSolve } from './ltc.js';
import { solve } from './fit.js';
import { SOUND, VCHUNK, VCHUNK_KEY, VIS_MOD, VIS_PLATEAU, exactFps, frameEdges, labelVisual, visFloor, visWorst, detectTags } from './visual.js';

const CHUNK = 8, STEP = 7;
// Search and read limits (seconds), with the defaults of both the page and the command line.
const readLimits = opts => ({ limit: (opts.search ?? 30) * 60, maxRead: opts.maxRead ?? 120, target: opts.target ?? 1.0 });
// The channels to decode: all, or only opts.channel (0-based) when given.
const channels = (w, opts) => opts.channel === undefined || opts.channel === null ? w.chans : w.chans.filter((_, c) => c === opts.channel);

// Reads chunks from one end toward the other: locating until the code is found (or the search limit),
// then one more chunk per call while the code continues, up to maxRead seconds. chan: the only channel to read
// (null: every channel, the one with the most seconds wins).
class End {
  constructor(m, start, dir, limit, maxRead, tick, chan = null) {
    Object.assign(this, { m, pos: start, origin: start, dir, limit, maxRead, tick, chan,
      found: [], used: null, ltc: [], ltcSeen: new Set(), ltcUsed: null, started: false, done: false, idle: 0, readSince: 0 });
  }
  async step() {
    if (this.done) return;
    const D = this.m.duration;
    const [a, b] = this.dir > 0 ? [this.pos, Math.min(this.pos + CHUNK, D)] : [Math.max(this.pos - CHUNK, 0), this.pos];
    if (b - a < 1) { this.done = true; return; }
    const w = await this.m.readWindow(a, b);
    if (!w.chans.length || !w.chans[0].length) { this.done = true; return; }
    let best = [null, []], lbest = [null, []];
    w.chans.forEach((ch, c) => {
      if (this.chan !== null && c !== this.chan) return;
      const d = decode(ch, w.t0, w.sr), L = ltcDecode(ch, w.t0, w.sr);
      if (d.length > best[1].length) best = [c, d];
      if (L.length > lbest[1].length) lbest = [c, L];
    });
    const fresh = best[1].filter(d => this.found.every(f => Math.abs(d.t - f.t) > 0.5));
    const lfresh = lbest[1].filter(q => !this.ltcSeen.has(q.n));
    if (fresh.length) { this.found.push(...fresh); this.used = best[0]; }
    if (lfresh.length) { lfresh.forEach(q => this.ltcSeen.add(q.n)); this.ltc.push(...lfresh); this.ltcUsed = lbest[0]; }
    if (fresh.length || lfresh.length) { this.started = true; this.idle = 0; }
    else if (this.started && ++this.idle >= 2) this.done = true;          // the code region has ended
    if (this.started) { this.readSince += STEP; if (this.readSince >= this.maxRead) this.done = true; }
    else if (Math.abs(this.pos - this.origin) >= this.limit) this.done = true;   // this end was not recorded
    this.pos += STEP * this.dir;
    if (this.tick) this.tick();
  }
  hasMinute() { return this.found.some(d => d.isMin); }
}

// Video counterpart of End: reads one end of the file toward the other and detects the tag in every frame. Reads
// start and end on keyframes where possible, so nothing is decoded twice; every frame's result is kept and the edges
// are rebuilt from all of them, so an edge that straddles two reads is not lost.
// vr: the platform's video reader: keyBefore(t) and keysIn(a, b) (keyframe file times), and
// read(k0, a, b, onFrame) -> bytes read, which hands every frame with a <= t < b to onFrame(t, grey, w, h).
class VEnd {
  constructor(vr, D, start, dir, limit, maxRead, fi, tick) {
    Object.assign(this, { vr, D, pos: start, origin: start, dir, limit, maxRead, fi, tick,
      frames: new Map(), edges: [], started: false, done: false, idle: 0, readSince: 0, roi: null, miss: 0, decoded: 0, bytes: 0 });
  }
  plan() {
    const D = this.D;
    let a, b;
    if (this.dir > 0) {
      a = this.pos;
      const later = this.vr.keysIn(a + VCHUNK - 1e-6, Math.min(a + VCHUNK + VCHUNK_KEY, D));
      b = Math.min(later.length ? later[0] : a + VCHUNK, D);
    } else {
      b = this.pos;
      const k = this.vr.keyBefore(b - VCHUNK);
      a = Math.max(k !== null ? k : Math.max(b - VCHUNK, 0), 0);
    }
    const k0 = this.vr.keyBefore(a);
    return [a, b, k0 !== null ? k0 : a];
  }
  // Tag ID in this frame, or null. After a hit only the tag's area (grown by 25 %) is searched; three misses in a
  // row go back to the whole frame. IDs 540-586 are not used by the slate.
  detect(grey, w, h) {
    let x0 = 0, y0 = 0, sw = w, sh = h, sub = grey;
    if (this.roi) {
      [x0, y0] = this.roi; sw = this.roi[2] - x0; sh = this.roi[3] - y0;
      sub = new Uint8Array(sw * sh);
      for (let y = 0; y < sh; y++) sub.set(grey.subarray((y + y0) * w + x0, (y + y0) * w + x0 + sw), y * sw);
    }
    let best = null;
    for (const d of detectTags(sw, sh, sub)) {
      if (d.id >= VIS_MOD) continue;
      const c = d.corners;
      let area = 0;
      for (let i = 0; i < 4; i++) { const p = c[i], q = c[(i + 3) % 4]; area += p.x * q.y - p.y * q.x; }
      area = Math.abs(area) / 2;
      if (!best || area > best[0]) best = [area, d];
    }
    if (!best) {
      if (this.roi && ++this.miss >= 3) { this.roi = null; this.miss = 0; }
      return null;
    }
    const xs = best[1].corners.map(p => p.x + x0), ys = best[1].corners.map(p => p.y + y0);
    const lx = Math.min(...xs), hx = Math.max(...xs), ly = Math.min(...ys), hy = Math.max(...ys);
    const mx = (hx - lx) * 0.25, my = (hy - ly) * 0.25;
    this.roi = [Math.trunc(Math.max(0, lx - mx)), Math.trunc(Math.max(0, ly - my)), Math.trunc(Math.min(w, hx + mx + 1)), Math.trunc(Math.min(h, hy + my + 1))];
    this.miss = 0;
    return best[1].id;
  }
  // Read one more stretch; returns its length in seconds (0 when finished).
  async step() {
    if (this.done) return 0;
    const D = this.D;
    if ((this.dir > 0 && D - this.pos < 0.2) || (this.dir < 0 && this.pos < 0.2)) { this.done = true; return 0; }
    const [a, b, k0] = this.plan();
    if (b - a < 0.05) { this.done = true; return 0; }
    this.bytes += await this.vr.read(k0, a, b, (t, grey, w, h) => this.frames.set(Math.round(t * 1e6) / 1e6, this.detect(grey, w, h)));
    this.decoded += b - k0;
    const n0 = this.edges.length;
    this.edges = frameEdges(this.frames, this.fi);
    if (this.edges.length > n0) { this.started = true; this.idle = 0; }
    else if (this.started && ++this.idle >= 2) this.done = true;
    if (this.started) { this.readSince += b - a; if (this.readSince >= this.maxRead) this.done = true; }
    else if (Math.abs(this.pos - this.origin) >= this.limit) this.done = true;
    this.pos = this.dir > 0 ? b : a;
    if (this.tick) this.tick();
    return b - a;
  }
}

// Read the visual code from both ends inward, the same way as the audio. fit is null when no edge was found anywhere.
async function visualScan(m, vr, opts, tick) {
  const D = m.movieDuration || m.duration, fps = exactFps(m.fps) || 30, fi = 1 / fps, vis = { fi };
  const { limit, maxRead, target } = readLimits(opts);
  const head = new VEnd(vr, D, 0, +1, limit, maxRead, fi, tick), tail = new VEnd(vr, D, D, -1, limit, maxRead, fi, tick);
  if (opts.only === 'head') tail.done = true;
  if (opts.only === 'tail') head.done = true;
  while (!((head.started || head.done) && (tail.started || tail.done))) {
    if (!(head.started || head.done)) await head.step();
    if (!(tail.started || tail.done)) await tail.step();
    if (head.pos >= tail.pos) { if (!head.started) head.done = true; if (!tail.started) tail.done = true; break; }
  }
  const ends = [head, tail], sc = { ends, fit: null, probes: [], singleFrom: null, fps, vis, vr, D };
  if (!head.edges.length && !tail.edges.length) return sc;
  if (head.edges.length && tail.edges.length &&
      Math.min(...tail.edges.map(e => e.t)) - Math.max(...head.edges.map(e => e.t)) < 60) {
    for (const [t, id] of tail.frames) head.frames.set(t, id);
    head.edges = frameEdges(head.frames, fi);
    tail.edges = []; tail.done = true;
    if (head.edges[0].t > D / 2) sc.singleFrom = 'tail';
  }
  // Refine until the target is met, the error stops dropping for VIS_PLATEAU seconds, or the code ends.
  let fit, best = Infinity, flat = 0;
  for (;;) {
    fit = solve(head.edges, tail.edges, [], vis);
    if (fit.error) break;
    const worst = visWorst(fit, D, fps, ends.map(x => x.edges), m.vfr);
    if (worst <= target) break;
    if (worst < best - 1e-9) { best = worst; flat = 0; }
    if (flat >= VIS_PLATEAU) break;
    let read = 0;
    for (const e of ends) if (e.edges.length && !e.done) read = Math.max(read, await e.step());
    if (!read) break;
    flat += read;
  }
  if (!fit.error && opts.probe) {
    const lo = (head.edges.length ? Math.max(...head.edges.map(e => e.t)) : 0) + 30;
    const hi = (tail.edges.length ? Math.min(...tail.edges.map(e => e.t)) : D) - 30;
    for (let k = 0; k < opts.probe && hi - lo >= 60; k++) {
      const pe = new VEnd(vr, D, lo + (hi - lo) * (k + 1) / (opts.probe + 1), +1, 6, 6, fi, tick);
      for (let s = 0; s < 3; s++) await pe.step();
      head.decoded += pe.decoded; head.bytes += pe.bytes;
      if (pe.edges.length) sc.probes.push(pe.edges);
    }
    if (sc.probes.length) fit = solve(head.edges, tail.edges, sc.probes, vis);
  }
  sc.fit = fit;
  return sc;
}

function readStats(r, sc) {
  r.visualReadS = sc.ends.reduce((a, e) => a + e.decoded, 0);
  r.visualReadMb = sc.ends.reduce((a, e) => a + e.bytes, 0) / 1e6;
  r.videoDecoder = [...sc.vr.decoders].sort().join('+') || null;
  if (sc.vr.fallback) { r.hwFallback = sc.vr.fallback; if (sc.vr.fallbackKey) r.hwFallbackKey = sc.vr.fallbackKey; }
}

// Consistent visual edges per end: [[name, [[file_t, ID]], Map file_t -> half width]].
function visualGroups(sc) {
  const out = [];
  sc.ends.forEach((e, k) => {
    const L = e.edges.length ? labelVisual(e.edges, sc.vis.fi) : null;
    if (!L) return;
    const name = k === 0 && sc.singleFrom !== 'tail' ? 'head' : 'tail';   // only the tail recorded: merged into head
    out.push([name, L.lab, new Map(e.edges.map(x => [x.t.toFixed(6), x.half]))]);
  });
  return out;
}

// Time result from the visual code alone (no waveform code in the audio, or no audio track).
async function analyzeVideo(m, vr, opts, tick) {
  const sc = await visualScan(m, vr, opts, tick);
  const fit = sc.fit;
  if (!fit) return { file: m.name, error: { key: 'err.noCodeAny' } };
  if (fit.error) return { file: m.name, error: fit.error };
  const r = buildResult(m, fit, sc.probes, sc.singleFrom, [null, null], sc.D);
  const [floor, rateFloor] = visFloor(sc.fps, fit, sc.ends.map(x => x.edges), sc.D, m.vfr);
  if (!r.segments) r.worstMs = Math.max(r.worstMs, floor * 1000);
  r.uncPpm = Math.max(r.uncPpm, rateFloor * 1e6);
  r.source = 'video';
  r.visFloorMs = floor * 1000;
  r.visualEdges = visualGroups(sc).reduce((a, g) => a + g[1].length, 0);
  readStats(r, sc);
  r.label540 = r.startLabel;
  if (opts.av) r.avError = { key: 'av.noAudio' };
  return r;
}

// Audio/video sync check: pair audio and visual edges of the same second (less than 0.5 s apart).
// offset = visual edge - (audio edge - distance / 343 m/s).
async function avCheck(r, m, vr, opts, tick) {
  if (vr.unsupported) { r.avError = { key: m.hasVideo ? 'av.codec' : 'av.noVideo', vars: vr.unsupported }; return; }
  const sc = await visualScan(m, vr, opts, tick);
  r.source = 'audio';
  readStats(r, sc);
  const groups = visualGroups(sc);
  r.visualEdges = groups.reduce((a, g) => a + g[1].length, 0);
  if (!groups.length) { r.avError = { key: 'av.noVisual' }; return; }
  r.source = 'both';
  // The picture also tells where in the 9-minute cycle the file starts: widens the cross-file start window.
  const [tv, idx] = groups[0][1][0], tgt = mod(idx - (tv - m.vOff) / r.rate, VIS_MOD), base = mod(r.startLabel, 60);
  r.label540 = mod(base + 60 * Math.round((tgt - base) / 60), VIS_MOD);
  const lag = opts.distance / SOUND, pairs = {};
  let nAudio = 0;
  for (const [name, lab, half] of groups) {
    const ts = lab.map(([t]) => t), a0 = Math.max(0, Math.min(...ts) - 0.5);
    const w = await m.readWindow(a0, Math.max(...ts) + 1.0);
    let secs = [];
    for (const ch of channels(w, opts)) { const d = decode(ch, w.t0, w.sr); if (d.length > secs.length) secs = d; }
    nAudio += secs.length;
    const out = [];
    for (const [t, i] of lab) {
      const s = secs.find(s => (s.isMin ? 0 : s.val) === i % 60 && Math.abs(t - s.t) < 0.5);
      if (s) out.push([t, t - (s.t - lag), half.get(t.toFixed(6))]);
    }
    if (out.length) pairs[name] = out;
    if (tick) tick();
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  r.audioEdges = nAudio;
  r.avDistance = opts.distance;
  r.avOffsetMs = null;
  r.avJitterMs = r.avDriftPpm = r.avDriftUncPpm = null;
  const keys = Object.keys(pairs);
  if (!keys.length) { r.avError = { key: 'av.noPairs' }; return; }
  r.avOffsetMs = {};
  for (const k of ['head', 'tail'])
    r.avOffsetMs[k] = pairs[k] ? { mean: mean(pairs[k].map(p => p[1])) * 1000, half: mean(pairs[k].map(p => p[2])) * 1000, pairs: pairs[k].length } : null;
  const dev = keys.flatMap(k => pairs[k].map(p => p[1] - r.avOffsetMs[k].mean / 1000));
  if (dev.length > 1) { const mu = mean(dev); r.avJitterMs = Math.sqrt(dev.reduce((a, v) => a + (v - mu) ** 2, 0) / (dev.length - 1)) * 1000; }
  if (keys.length === 2) {
    const all = pairs.head.concat(pairs.tail), T = all.map(p => p[0]), Y = all.map(p => p[1]);
    const [slope, icpt, sxx] = polyfit1(T, Y), n = all.length;
    const res = all.map((p, i) => Y[i] - (icpt + slope * T[i]));
    const sd = n > 2 ? Math.sqrt(res.reduce((a, v) => a + v * v, 0) / (n - 2)) : 0;
    const sig = Math.max(sd, Math.sqrt(mean(all.map(p => (2 * p[2]) ** 2 / 12))));
    // Each end's mean offset can carry the same frame quantisation (see visFloor).
    const vfit = sc.fit && !sc.fit.error ? sc.fit : null;
    const unc = Math.max(sig / Math.sqrt(sxx), visFloor(sc.fps, vfit, sc.ends.map(x => x.edges), sc.D, m.vfr)[1]);
    r.avDriftPpm = slope * 1e6; r.avDriftUncPpm = unc * 1e6;
  }
}

export async function analyze(m, opts, tick) {
  // The video track is decoded only when needed: no waveform code in the audio, or the A/V sync check.
  let vr = null;
  const video = async () => vr || (vr = await m.openVideo());
  if (!m.hasAudio) {
    const v = await video();
    if (v.unsupported) return { file: m.name, error: { key: 'err.vcodec', vars: v.unsupported } };
    return analyzeVideo(m, v, opts, tick);
  }
  const D = m.duration, { limit, maxRead, target } = readLimits(opts), chan = opts.channel ?? null;
  const head = new End(m, 0, +1, limit, maxRead, tick, chan), tail = new End(m, D, -1, limit, maxRead, tick, chan);
  if (opts.only === 'head') tail.done = true;
  if (opts.only === 'tail') head.done = true;
  // 1) Locate: search inward from both ends at once.
  while (!((head.started || head.done) && (tail.started || tail.done))) {
    if (!(head.started || head.done)) await head.step();
    if (!(tail.started || tail.done)) await tail.step();
    if (head.pos >= tail.pos) { if (!head.started) head.done = true; if (!tail.started) tail.done = true; break; }
  }
  if (head.ltc.length || tail.ltc.length) return analyzeLtc(m, head, tail, opts, tick, video);
  if (!head.found.length && !tail.found.length) {
    if (!m.hasVideo) return { file: m.name, error: { key: 'err.noCode' } };
    const v = await video();                             // a camera that only saw the slate's screen
    if (v.unsupported) return { file: m.name, error: { key: 'err.noCodeVcodec', vars: v.unsupported } };
    return analyzeVideo(m, v, opts, tick);
  }
  let singleFrom = null;
  if (head.found.length && tail.found.length &&
      Math.min(...tail.found.map(d => d.t)) - Math.max(...head.found.map(d => d.t)) < 60) {
    for (const d of tail.found) if (head.found.every(f => Math.abs(d.t - f.t) > 0.5)) head.found.push(d);
    head.found.sort((x, y) => x.t - y.t);
    if (head.used === null) head.used = tail.used;
    tail.found = []; tail.done = true;
    if (head.found[0].t > D / 2) singleFrom = 'tail';
  }
  // 2) Refine to the target precision.
  let fit;
  for (;;) {
    fit = solve(head.found, tail.found, []);
    if (fit.error) break;
    const worst = Math.max(fit.predSe((0 - fit.c) / fit.rate), fit.predSe((D - fit.c) / fit.rate)) * 1000;
    const needMin = opts.minute && ![head, tail].filter(e => e.found.length).every(e => e.hasMinute());
    if (worst <= target && !needMin) break;
    let progressed = false;
    for (const e of [head, tail]) if (e.found.length && !e.done) { await e.step(); progressed = true; }
    if (!progressed) break;
  }
  if (fit.error) return { file: m.name, error: fit.error };
  // 3) Full-recording mode: probe the middle.
  const probes = [];
  if (opts.probe) {
    const lo = (head.found.length ? Math.max(...head.found.map(d => d.t)) : 0) + 30;
    const hi = (tail.found.length ? Math.min(...tail.found.map(d => d.t)) : D) - 30;
    for (let k = 0; k < opts.probe && hi - lo >= 60; k++) {
      const p0 = lo + (hi - lo) * (k + 1) / (opts.probe + 1);
      const w = await m.readWindow(p0, p0 + 3 * CHUNK);
      if (!w.chans.length || !w.chans[0].length) continue;
      let best = [];
      channels(w, opts).forEach(ch => { const d = decode(ch, w.t0, w.sr); if (d.length > best.length) best = d; });
      if (best.length) probes.push(best);
      if (tick) tick();
    }
    if (probes.length) { fit = solve(head.found, tail.found, probes); if (fit.error) return { file: m.name, error: fit.error }; }
  }
  const used = [head, tail].filter(e => e.found.length).map(e => e.used);
  const r = buildResult(m, fit, probes, singleFrom, [used[0], used[used.length - 1]]);
  if (opts.av) {
    try { await avCheck(r, m, await video(), opts, tick); }
    catch (e) {                                          // the timing result from the audio still stands
      for (const k of ['source', 'visualReadS', 'visualReadMb', 'videoDecoder', 'hwFallback', 'hwFallbackKey', 'visualEdges', 'label540']) delete r[k];
      r.avError = { key: 'av.codec', vars: { why: 'why.decode', msg: String((e && e.message) || e).slice(0, 200) } };
    }
  }
  return r;
}

// The file's own clock (docs/start-time.md): C = the container's creation time (m.created, Unix seconds UTC) or the BWF
// time reference (m.bextSec, local), in seconds since local midnight. L: the measured start in its M-second cycle;
// D: the file length. Candidates: r = wrap(C - L, M) (start type) and wrap(C - D - L, M) (end type), each also with C
// read as local time written as UTC (the UTC clock face, as many cameras do; only when it differs from the local one).
// r is rounded to 1 ms, so a µs-level error cannot flip the 2 s limit. Exactly one candidate within 2 s gives the full
// start clock; when the time-zone offset is a multiple of M both readings pass and none is used. BWF is a local start
// time by definition, so it has the one candidate. match: the clock may be used to match files, only for M a multiple
// of 540 (with 60 or 3600 a device whole minutes off would pass unnoticed): otherwise it is only shown.
// Returns {} without C; { src, bad: { start, end, startLocal, endLocal }, badWhy } when no single candidate fits (badWhy:
// 'ambiguous' when several pass, so start and end, or UTC and local time, cannot be told apart; 'mismatch' when none does);
// { src, type, zone, r, clock, match } when adopted.
export function createdClock(m, L, M, D) {
  const cands = [];
  let src;
  if (m.created) {
    src = 'created';
    const d = new Date(m.created * 1000), local = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    const face = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    for (const [zone, C] of local === face ? [['utc', local]] : [['utc', local], ['local', face]])
      for (const type of ['start', 'end']) cands.push({ key: type + (zone === 'local' ? 'Local' : ''), type, zone, C });
  } else if (m.bextSec) { src = 'bext'; cands.push({ key: 'start', type: 'start', zone: 'local', C: m.bextSec }); }
  else return {};
  for (const c of cands) c.r = Math.round(wrap(c.C - (c.type === 'end' ? D : 0) - L, M) * 1000) / 1000;
  const fits = cands.filter(c => Math.abs(c.r) <= 2);
  if (fits.length !== 1) return { src, bad: Object.fromEntries(cands.map(c => [c.key, c.r])), badWhy: fits.length ? 'ambiguous' : 'mismatch' };
  const { type, zone, r, C } = fits[0], c0 = C - (type === 'end' ? D : 0);
  return { src, type, zone, r, clock: Math.round((c0 - L) / M) * M + L, match: M % VIS_MOD === 0 };
}

// Time result from LTC (docs/ltc.md): the same steps as the waveform code in analyze(), on frame starts. When a file
// carries both, LTC is used.
async function analyzeLtc(m, head, tail, opts, tick, video) {
  const D = m.duration, ts = e => e.ltc.map(q => q.t);
  let singleFrom = null;
  if (head.ltc.length && tail.ltc.length && Math.min(...ts(tail)) - Math.max(...ts(head)) < 60) {
    for (const q of tail.ltc) if (!head.ltcSeen.has(q.n)) { head.ltcSeen.add(q.n); head.ltc.push(q); }
    if (head.ltcUsed === null) head.ltcUsed = tail.ltcUsed;
    tail.ltc = []; tail.done = true;
    if (Math.min(...ts(head)) > D / 2) singleFrom = 'tail';
  }
  let fit;
  for (;;) {
    fit = ltcSolve(head.ltc, tail.ltc, [], m.fps);
    if (fit.error) return { file: m.name, error: fit.error };
    if (Math.max(fit.predSe((0 - fit.c) / fit.rate), fit.predSe((D - fit.c) / fit.rate)) * 1000 <= 1.0) break;
    let progressed = false;
    for (const e of [head, tail]) if (e.ltc.length && !e.done) { await e.step(); progressed = true; }
    if (!progressed) break;
  }
  const probes = [];
  if (opts.probe) {
    const lo = (head.ltc.length ? Math.max(...ts(head)) : 0) + 30, hi = (tail.ltc.length ? Math.min(...ts(tail)) : D) - 30;
    for (let k = 0; k < opts.probe && hi - lo >= 60; k++) {
      const p0 = lo + (hi - lo) * (k + 1) / (opts.probe + 1), w = await m.readWindow(p0, p0 + 3 * CHUNK);
      let best = [];
      for (const ch of channels(w, opts)) { const L = ltcDecode(ch, w.t0, w.sr); if (L.length > best.length) best = L; }
      if (best.length) probes.push(best);
      if (tick) tick();
    }
    if (probes.length) { fit = ltcSolve(head.ltc, tail.ltc, probes, m.fps); if (fit.error) return { file: m.name, error: fit.error }; }
  }
  const used = [head, tail].filter(e => e.ltc.length).map(e => e.ltcUsed);
  const r = buildResult(m, fit, probes, singleFrom, [used[0], used[used.length - 1]]);
  if (opts.av) {
    try { await avCheck(r, m, await video(), opts, tick); }
    catch (e) { r.avError = { key: 'av.codec', vars: { why: 'why.decode', msg: String((e && e.message) || e).slice(0, 200) } }; }
  }
  r.source = 'ltc';
  return r;
}

// Turn a fit into the per-file result (same fields for the waveform code and the visual code).
// D: the duration the reads planned from (the visual code uses the container's, m.movieDuration).
function buildResult(m, fit, probes, singleFrom, channel, D = m.duration) {
  const { rate, c, base, M } = fit;
  const sc = fit.ltc ? fit.ltc.tcScale : 1, realAt = t => mod(base + (t - c) / rate * sc, M);
  let fps = m.fps || null;
  for (const e of NTSC) if (fps && Math.abs(fps - e) < 0.005) fps = e;
  const hasV = m.vOff !== null && m.vOff !== undefined;
  let mOff, mLen, kind;
  if (hasV) { mOff = m.vOff; mLen = fps && m.vFrames ? m.vFrames / fps : m.vDur; kind = 'video'; }
  else { mOff = m.aOff; mLen = m.aDur; kind = 'audio'; }
  let corrected = mLen / rate, segments = null;
  let worstMs = Math.max(fit.predSe((0 - c) / rate), fit.predSe((D - c) / rate)) * 1000;
  if (fit.segs) {
    const bounds = [mOff, ...fit.segs.slice(0, -1).map(g => g.to), mOff + mLen], rates = fit.segs.map(g => g.rate);
    segments = rates.map((r, i) => ({ fileFrom: bounds[i] - mOff, fileTo: bounds[i + 1] - mOff, speed: r }));
    corrected = segments.reduce((a, g) => a + (g.fileTo - g.fileFrom) / g.speed, 0);
    worstMs = 0;
    segments.forEach((g, i) => {
      const dr = Math.max(...[i - 1, i + 1].filter(j => j >= 0 && j < segments.length).map(j => Math.abs(g.speed - segments[j].speed)));
      worstMs = Math.max(worstMs, 1.3 * dr * (g.fileTo - g.fileFrom) / 8 * 1000);
    });
  }
  const startLabel = realAt(mOff);
  const ck = fit.ltc ? {} : createdClock(m, startLabel, M, mLen);   // LTC already gives the clock
  let startClock = startLabel, clockMod = M, hintSrc = null;
  if (fit.ltc) clockMod = 86400;
  else if (ck.clock !== undefined) { startClock = ck.clock; clockMod = 86400; }
  else if (M === 3600 || M === 10800) {
    // Display only: the hour guessed from the file's modification time (never used to match files).
    const d = new Date(m.modified), hint = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    startClock = Math.round((hint - startLabel) / M) * M + startLabel; clockMod = 86400; hintSrc = 'mtime';
  }
  // mode: 'full' (middle probed), 'both' (head and tail), or the single end read: 'head' / 'tail'
  const mode = probes.length ? 'full' : (fit.both ? 'both' : (singleFrom || fit.which));
  return { file: m.name, kind, mode, channel, startLabel, mod: M, startClock, clockMod, hintSrc,
    ltc: fit.ltc || null, clockSrc: ck.src || null, clockType: ck.type || null, clockZone: ck.zone || null,
    clockR: ck.r === undefined ? null : ck.r, clockMatch: !!ck.match, clockBad: ck.bad || null, clockBadWhy: ck.badWhy || null,
    length: mLen, correctedLength: corrected, frames: hasV ? m.vFrames : null, fps: hasV ? fps : null,
    rate, ppm: (rate - 1) * 1e6, uncPpm: fit.uncPpm, worstMs, edgesUsed: fit.n, edgesRejected: fit.rejected,
    fitRmsMs: fit.rms * 1000, pitchRejected: fit.pitchRejected || 0, segments, midDevMs: fit.maxDev, aOff: m.aOff, vOff: hasV ? m.vOff : null, ambiguous: fit.ambiguous };
}
