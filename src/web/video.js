// video.js — 瀏覽器端的畫面讀取：WebCodecs VideoDecoder 解碼影片軌，縮小成灰階影格交給分析核心（core/analyze.js 的 VEnd）。
import { CV } from '../core/aruco.js';
import { VIS_SHORT } from '../core/visual.js';

const READ_BLOCK = 16e6;   // bytes of video read from the file at a time

// ---- video track decoding (WebCodecs)
function videoCodec(v) {
  const b = v.desc, hex = x => x.toString(16).padStart(2, '0');
  if (v.cfg === 'avcC') return `${v.fmt}.${hex(b[1])}${hex(b[2])}${hex(b[3])}`;
  // hvcC: profile space / tier / profile, compatibility flags (bit-reversed), level, constraint bytes
  let flags = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev * 2) + (flags & 1); flags >>>= 1; }
  const cons = Array.from(b.subarray(6, 12));
  while (cons.length && !cons[cons.length - 1]) cons.pop();
  return `${v.fmt}.${['', 'A', 'B', 'C'][b[1] >> 6]}${b[1] & 31}.${rev.toString(16)}.${(b[1] >> 5) & 1 ? 'H' : 'L'}${b[12]}` +
    cons.map(x => '.' + x.toString(16)).join('');
}

// Decodes stretches of the video track and hands every frame, in presentation order, to a callback as a small grey
// image (short side about VIS_SHORT px). Hardware decoding is preferred; if it fails the read is repeated with the
// browser's default choice and the file stays there. decoders collects what was used ('hardware' / 'software').
export class VideoReader {
  static async open(m) {
    const v = m.video;
    if (m.videoUnsupported) return { unsupported: { why: m.videoUnsupported } };
    if (!v || typeof VideoDecoder === 'undefined') return { unsupported: { why: 'why.codec', codec: v ? v.fmt : '?' } };
    const codec = videoCodec(v), base = { codec, codedWidth: v.width, codedHeight: v.height, description: v.desc };
    for (const hw of ['prefer-hardware', 'no-preference']) {
      try { if ((await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: hw })).supported) return new VideoReader(m, base, hw); }
      catch (e) { /* try the next preference */ }
    }
    return { unsupported: { why: 'why.codec', codec } };
  }
  constructor(m, config, hw) {
    Object.assign(this, { m, v: m.video, config, hw, decoders: new Set(), fallback: null });
    const s = Math.min(1, VIS_SHORT / Math.min(this.v.width, this.v.height));
    this.w = 2 * Math.round(this.v.width * s / 2); this.h = 2 * Math.round(this.v.height * s / 2);
    this.canvas = new OffscreenCanvas(this.w, this.h);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingQuality = 'high';
    this.grey = new Uint8Array(this.w * this.h);
  }
  // Keyframe at or before t (file time), or null.
  keyBefore(t) { let k = null; for (const i of this.v.keys) { if (this.v.pts[i] <= t + 1e-6) k = this.v.pts[i]; else break; } return k; }
  keysIn(a, b) { return this.v.keys.map(i => this.v.pts[i]).filter(t => t >= a && t <= b); }
  // Decode so that every frame with a <= pts < b reaches onFrame(t, grey, w, h). Starts at keyframe k0.
  async read(k0, a, b, onFrame) {
    try { return await this.decodeRange(k0, a, b, onFrame, this.hw); }
    catch (e) {
      if (this.hw !== 'prefer-hardware') throw e;
      this.fallback = String((e && e.message) || e).slice(0, 200);
      this.hw = 'no-preference';
      return this.decodeRange(k0, a, b, onFrame, this.hw);
    }
  }
  async decodeRange(k0, a, b, onFrame, hw) {
    const v = this.v, BIAS = 1000, us = t => Math.round((t + BIAS) * 1e6);
    let i0 = v.keys.find(i => Math.abs(v.pts[i] - k0) < 1e-6);
    if (i0 === undefined) i0 = v.keys[0];
    let last = -1;
    for (let j = i0; j < v.n && v.pts[j] < b + 1; j++) if (v.pts[j] < b) last = j;   // decode order; reordering < 1 s
    if (last < i0) return 0;
    const byUs = new Map();
    for (let j = i0; j <= last; j++) byUs.set(us(v.pts[j]), v.pts[j]);
    // File bytes are read in blocks of at most READ_BLOCK, so a very long GOP is not loaded in one piece.
    let buf = null, bufLo = 0, bufHi = 0;
    const sample = async j => {
      if (!buf || v.off[j] < bufLo || v.off[j] + v.size[j] > bufHi) {
        bufLo = v.off[j]; bufHi = bufLo + v.size[j];
        for (let k = j + 1; k <= last && v.off[k] >= bufLo && v.off[k] + v.size[k] - bufLo <= READ_BLOCK; k++) bufHi = Math.max(bufHi, v.off[k] + v.size[k]);
        buf = new Uint8Array(await this.m.file.slice(bufLo, bufHi).arrayBuffer());
      }
      return buf.subarray(v.off[j] - bufLo, v.off[j] - bufLo + v.size[j]);
    };
    let failed = null, bytes = 0;
    const dec = new VideoDecoder({
      output: frame => {
        const t = byUs.get(frame.timestamp);
        if (t === undefined || t < a - 1e-3 || t >= b) { frame.close(); return; }
        this.ctx.drawImage(frame, 0, 0, this.w, this.h);
        frame.close();
        const img = this.ctx.getImageData(0, 0, this.w, this.h);
        CV.grayscale({ data: img.data, width: this.w, height: this.h }, { data: this.grey });
        onFrame(t, this.grey, this.w, this.h);
      },
      error: e => { failed = e; },
    });
    dec.configure({ ...this.config, hardwareAcceleration: hw });
    for (let j = i0; j <= last; j++) {
      if (failed) break;
      const data = await sample(j);
      if (failed) break;
      dec.decode(new EncodedVideoChunk({ type: v.key[j] ? 'key' : 'delta', timestamp: us(v.pts[j]), data }));
      if (v.pts[j] >= k0 - 1e-6 && v.pts[j] < b) bytes += v.size[j];
      if (dec.decodeQueueSize > 16) await new Promise(r => dec.addEventListener('dequeue', r, { once: true }));
    }
    try { if (!failed) await dec.flush(); } catch (e) { failed = failed || e; }
    if (dec.state !== 'closed') dec.close();
    if (failed) throw failed;
    this.decoders.add(hw === 'prefer-hardware' ? 'hardware' : 'software');
    return bytes;
  }
}

// Video counterpart of End: reads one end of the file toward the other and detects the tag in every frame. Reads
// start and end on keyframes where possible, so nothing is decoded twice; every frame's result is kept and the edges
