// media.js — 瀏覽器端的讀檔：解析 MP4／MOV／WAV 的索引，以 WebCodecs（AAC）或直接轉換（PCM）讀出一段音訊。
// Errors carry a dictionary key, not text, so a result can be re-rendered after the language changes.
export const fail = (key, vars) => Object.assign(new Error(key), { i18n: { key, vars } });

const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
const u64 = (dv, o) => dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);
const sliceDV = async (file, a, b) => new DataView(await file.slice(a, b).arrayBuffer());

function eachBox(dv, start, end, cb) {
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o), hdr = 8;
    const type = fourcc(dv, o + 4);
    if (size === 1) { size = u64(dv, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    cb(type, o + hdr, o + size);
    o += size;
  }
}

async function topBoxes(file) {
  const out = [];
  let off = 0;
  while (off + 8 <= file.size) {
    const dv = await sliceDV(file, off, Math.min(off + 16, file.size));
    let size = dv.getUint32(0), hdr = 8;
    const type = fourcc(dv, 4);
    if (size === 1) { size = u64(dv, 8); hdr = 16; } else if (size === 0) size = file.size - off;
    if (size < hdr) break;
    out.push({ type, off, size });
    off += size;
  }
  return out;
}

function parseEsds(dv, p, q) {
  let o = p + 4;
  const len = () => { let n = 0, b; do { b = dv.getUint8(o++); n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
  while (o < q) {
    const tag = dv.getUint8(o++), n = len();
    if (tag === 0x03) { o += 2; const f = dv.getUint8(o++); if (f & 0x80) o += 2; if (f & 0x40) o += 1 + dv.getUint8(o); if (f & 0x20) o += 2; continue; }
    if (tag === 0x04) { o += 13; continue; }
    if (tag === 0x05) return new Uint8Array(dv.buffer, dv.byteOffset + o, n).slice();
    o += n;
  }
  return null;
}

function parseStsd(dv, a) {
  const size = dv.getUint32(a + 8), fmt = fourcc(dv, a + 12), s = a + 16, e = a + 8 + size;
  const en = { fmt, ver: dv.getUint16(s + 8), channels: dv.getUint16(s + 16), bits: dv.getUint16(s + 18), sr: dv.getUint32(s + 24) / 65536 };
  let child = s + 28;
  if (en.ver === 1) { en.bytesPerFrame = dv.getUint32(s + 36); en.bytesPerSample = dv.getUint32(s + 40); child += 16; }
  else if (en.ver === 2) {
    en.sr = dv.getFloat64(s + 32); en.channels = dv.getUint32(s + 40); en.bits = dv.getUint32(s + 48);
    en.lpcmFlags = dv.getUint32(s + 52); en.bytesPerFrame = dv.getUint32(s + 56); child += 36;
  }
  const scan = (x, y) => eachBox(dv, x, y, (t, p, q) => {
    if (t === 'esds') en.asc = parseEsds(dv, p, q);
    else if (t === 'wave') scan(p, q);
    else if (t === 'enda') en.littleEndian = dv.getUint16(p) !== 0;
    else if (t === 'pcmC') { en.pcmLE = (dv.getUint8(p + 4) & 1) === 1; en.pcmBits = dv.getUint8(p + 5); }
  });
  if (child < e) scan(child, e);
  return en;
}

// Video sample entry (avc1/avc3/hvc1/hev1): size and the decoder configuration box VideoDecoder takes as description.
function parseVisualStsd(dv, a) {
  const size = dv.getUint32(a + 8), s = a + 16, e = a + 8 + size;
  const en = { fmt: fourcc(dv, a + 12), width: dv.getUint16(s + 24), height: dv.getUint16(s + 26) };
  eachBox(dv, s + 78, e, (t, p, q) => {
    if (t === 'avcC' || t === 'hvcC') { en.cfg = t; en.desc = new Uint8Array(dv.buffer, dv.byteOffset + p, q - p).slice(); }
  });
  return en;
}

function parseTrak(dv, s, e) {
  const tr = { elst: [] };
  const walk = (x, y) => eachBox(dv, x, y, (t, a, b) => {
    switch (t) {
      case 'mdia': case 'minf': case 'stbl': case 'edts': walk(a, b); break;
      case 'elst': {
        const v = dv.getUint8(a), n = dv.getUint32(a + 4);
        let o = a + 8;
        for (let i = 0; i < n; i++) {
          let dur, mt;
          if (v === 1) { dur = u64(dv, o); mt = Number(dv.getBigInt64(o + 8)); o += 16; }
          else { dur = dv.getUint32(o); mt = dv.getInt32(o + 4); o += 8; }
          o += 4;
          tr.elst.push({ dur, mt });
        }
        break;
      }
      case 'mdhd': {
        const v = dv.getUint8(a);
        if (v === 1) { tr.ts = dv.getUint32(a + 20); tr.mdur = u64(dv, a + 24); }
        else { tr.ts = dv.getUint32(a + 12); tr.mdur = dv.getUint32(a + 16); }
        break;
      }
      case 'hdlr': if (!tr.handler) tr.handler = fourcc(dv, a + 8); break;   // MOV: minf has a data-handler hdlr too
      case 'stsd': tr.entry = tr.handler === 'vide' ? parseVisualStsd(dv, a) : parseStsd(dv, a); break;
      case 'stts': {
        const n = dv.getUint32(a + 4); tr.stts = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) { tr.stts[2 * i] = dv.getUint32(a + 8 + 8 * i); tr.stts[2 * i + 1] = dv.getUint32(a + 12 + 8 * i); }
        break;
      }
      case 'ctts': {
        // The video track keeps every entry: each frame's presentation time is needed to read the visual code.
        const v = dv.getUint8(a), n = tr.handler === 'vide' ? dv.getUint32(a + 4) : Math.min(dv.getUint32(a + 4), 64); tr.ctts = [];
        // Offsets are read signed in both versions, as ffmpeg does.
        for (let i = 0; i < n; i++) tr.ctts.push([dv.getUint32(a + 8 + 8 * i), dv.getInt32(a + 12 + 8 * i)]);
        if (!n) tr.ctts = null;
        break;
      }
      case 'stsc': {
        const n = dv.getUint32(a + 4); tr.stsc = new Float64Array(n * 3);
        for (let i = 0; i < n * 3; i++) tr.stsc[i] = dv.getUint32(a + 8 + 4 * i);
        break;
      }
      case 'stsz': {
        tr.sampleSize = dv.getUint32(a + 4); tr.sampleCount = dv.getUint32(a + 8);
        if (tr.sampleSize === 0 && (tr.handler === 'soun' || tr.handler === 'vide')) {
          tr.sizes = new Uint32Array(tr.sampleCount);
          for (let i = 0; i < tr.sampleCount; i++) tr.sizes[i] = dv.getUint32(a + 12 + 4 * i);
        }
        break;
      }
      case 'stss': { const n = dv.getUint32(a + 4); tr.stss = new Uint32Array(n); for (let i = 0; i < n; i++) tr.stss[i] = dv.getUint32(a + 8 + 4 * i); break; }
      case 'stco': { const n = dv.getUint32(a + 4); tr.co = new Float64Array(n); for (let i = 0; i < n; i++) tr.co[i] = dv.getUint32(a + 8 + 4 * i); break; }
      case 'co64': { const n = dv.getUint32(a + 4); tr.co = new Float64Array(n); for (let i = 0; i < n; i++) tr.co[i] = u64(dv, a + 8 + 8 * i); break; }
    }
  });
  walk(s, e);
  return tr;
}

function parseMoov(dv) {
  const m = { tracks: [], movieTs: 1000, created: null };
  eachBox(dv, 0, dv.byteLength, (t, s, e) => {
    if (t !== 'moov') return;
    eachBox(dv, s, e, (t2, a, b) => {
      if (t2 === 'mvhd') {
        if (dv.getUint8(a) === 1) { m.created = u64(dv, a + 4); m.movieTs = dv.getUint32(a + 20); m.movieDur = u64(dv, a + 24); }
        else { m.created = dv.getUint32(a + 4); m.movieTs = dv.getUint32(a + 12); m.movieDur = dv.getUint32(a + 16); }
      } else if (t2 === 'trak') m.tracks.push(parseTrak(dv, a, b));
    });
  });
  return m;
}

// Track presentation start in seconds, following the edit list the way ffmpeg does. dur: the length of the first
// non-empty edit in seconds (null without one), which cuts off e.g. the AAC encoder's padding at the end.
function editStart(tr, movieTs) {
  let empty = 0, mt = 0, dur = null;
  for (const e of tr.elst) { if (e.mt === -1) empty += e.dur / movieTs; else { mt = e.mt; dur = e.dur > 0 ? e.dur / movieTs : null; break; } }
  return { empty, mt, dur };
}

function pcmSpec(en) {
  const f = en.fmt;
  const s = { float: false, le: false, bytes: 2 };
  if (f === 'sowt') { s.le = true; s.bytes = en.bits === 8 ? 1 : 2; }
  else if (f === 'twos') { s.bytes = en.bits === 8 ? 1 : 2; }
  else if (f === 'in24') { s.bytes = 3; s.le = !!en.littleEndian; }
  else if (f === 'in32') { s.bytes = 4; s.le = !!en.littleEndian; }
  else if (f === 'fl32') { s.bytes = 4; s.float = true; s.le = !!en.littleEndian; }
  else if (f === 'fl64') { s.bytes = 8; s.float = true; s.le = !!en.littleEndian; }
  else if (f === 'lpcm') { s.bytes = en.bits / 8; s.float = !!(en.lpcmFlags & 1); s.le = !(en.lpcmFlags & 2); }
  else if (f === 'ipcm' || f === 'fpcm') { s.bytes = (en.pcmBits || en.bits) / 8; s.float = f === 'fpcm'; s.le = !!en.pcmLE; }
  else return null;
  s.frame = en.bytesPerFrame && en.ver !== 0 ? en.bytesPerFrame : s.bytes * en.channels;
  return s;
}

async function openMp4(file) {
  const boxes = await topBoxes(file);
  const mv = boxes.find(b => b.type === 'moov');
  if (!mv) throw fail('err.noMoov');
  if (boxes.some(b => b.type === 'moof')) throw fail('err.frag');
  const m = parseMoov(new DataView(await file.slice(mv.off, mv.off + mv.size).arrayBuffer()));
  const aud = m.tracks.find(t => t.handler === 'soun');
  const vid = m.tracks.find(t => t.handler === 'vide');
  const hasVid = !!(vid && vid.stts);
  if ((!aud || !aud.entry) && !hasVid) throw fail('err.noAudio');
  // A file without an audio track can still be timed from the visual code.
  const created = m.created ? m.created - 2082844800 : null;   // mvhd counts seconds from 1904; the core takes Unix time
  const media = aud && aud.entry ? mp4Audio(file, m, aud) : { kind: 'mp4', file, hasAudio: false, aStartAbs: null };
  media.created = created;
  // The movie header's duration (what ffprobe reports as the format duration): the visual-code reads plan from it,
  // as the command line does. The audio path keeps using the track-derived duration.
  if (m.movieDur && m.movieTs) media.movieDuration = m.movieDur / m.movieTs;
  return mp4Video(media, m, hasVid ? vid : null);
}

// Chunk table -> number of samples in each chunk.
function chunkCounts(tr) {
  const nChunks = tr.co.length, stsc = tr.stsc, out = new Float64Array(nChunks);
  for (let i = 0; i < stsc.length / 3; i++) {
    const first = stsc[3 * i] - 1, next = i + 1 < stsc.length / 3 ? stsc[3 * (i + 1)] - 1 : nChunks;
    for (let c = first; c < next && c < nChunks; c++) out[c] = stsc[3 * i + 1];
  }
  return out;
}

function mp4Audio(file, m, aud) {
  // ---- audio sample/time tables
  const en = aud.entry, ed = editStart(aud, m.movieTs);
  const isAac = en.fmt === 'mp4a';
  const pcm = isAac ? null : pcmSpec(en);
  if (!isAac && !pcm) throw fail('err.codec', { fmt: en.fmt });
  let sr = aud.ts, channels = en.channels, codec = null;
  if (isAac) {
    if (!en.asc) throw fail('err.asc');
    const b0 = en.asc[0], b1 = en.asc[1];
    const aot = b0 >> 3, sfi = ((b0 & 7) << 1) | (b1 >> 7), cc = (b1 >> 3) & 15;
    const SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    if (sfi < 13) sr = SR[sfi];
    if (cc > 0 && cc < 8) channels = [0, 1, 2, 3, 4, 5, 6, 8][cc];
    codec = 'mp4a.40.' + aot;
  }
  // chunk table -> per-sample file offsets (AAC) or per-chunk frame runs (PCM)
  const nChunks = aud.co.length, chunkSamples = chunkCounts(aud);
  const media = { kind: 'mp4', file, hasAudio: true, isAac, codec, pcm, sr, channels, asc: en.asc };
  // media time (track timescale) of each sample start; for PCM one "sample" may hold several frames
  const tsOf = []; // [count, delta] runs
  for (let i = 0; i < aud.stts.length / 2; i++) tsOf.push([aud.stts[2 * i], aud.stts[2 * i + 1]]);
  const toSec = mtick => ed.empty + (mtick - ed.mt) / aud.ts;

  if (isAac) {
    const n = aud.sampleCount, off = new Float64Array(n), size = new Uint32Array(n), mtime = new Float64Array(n + 1);
    let si = 0;
    for (let c = 0; c < nChunks; c++) {
      let o = aud.co[c];
      for (let k = 0; k < chunkSamples[c] && si < n; k++, si++) {
        const z = aud.sizes ? aud.sizes[si] : aud.sampleSize;
        off[si] = o; size[si] = z; o += z;
      }
    }
    let t = 0, j = 0;
    for (const [cnt, d] of tsOf) for (let k = 0; k < cnt && j < n; k++, j++) { mtime[j] = t; t += d; }
    mtime[n] = t;
    Object.assign(media, { n, off, size, timeOf: i => toSec(mtime[i]), endTime: toSec(mtime[n]), mtime, tsc: aud.ts });
  } else {
    const fps = aud.sampleSize > 1 ? aud.sampleSize / pcm.frame : 1;   // PCM frames per container sample
    const framesPerSample = Math.max(1, Math.round(fps));
    const delta = tsOf.length ? tsOf[0][1] : framesPerSample;
    const tickPerFrame = delta / framesPerSample;
    const cFirst = new Float64Array(nChunks + 1);
    for (let c = 0; c < nChunks; c++) cFirst[c + 1] = cFirst[c] + chunkSamples[c] * framesPerSample;
    const total = cFirst[nChunks];
    Object.assign(media, { cFirst, co: aud.co, total, tickPerFrame,
      frameTime: f => toSec(f * tickPerFrame), endTime: toSec(total * tickPerFrame), sr: aud.ts / tickPerFrame });
  }
  const aStart = isAac ? media.timeOf(0) : media.frameTime(0);
  media.aStartAbs = Math.max(aStart, ed.empty);   // samples before the edit's media_time are not presented
  if (ed.dur !== null) media.endTime = Math.min(media.endTime, ed.empty + ed.dur);   // nor those after its end
  media.aDur = media.endTime - media.aStartAbs;
  return media;
}

function mp4Video(media, m, vid) {
  // ---- video track: frame count, rate, presentation start
  let vStart = null, vEnd = null, ve = null;
  if (vid) {
    ve = editStart(vid, m.movieTs);
    let best = [0, 0];
    for (let i = 0; i < vid.stts.length / 2; i++) if (vid.stts[2 * i] > best[0]) best = [vid.stts[2 * i], vid.stts[2 * i + 1]];
    media.vFrames = vid.sampleCount;
    media.fps = best[1] ? vid.ts / best[1] : null;
    // Variable frame rate (phones): the sample durations (all but the last) differ and the average rate is more than
    // 0.1 % off the most common one. The frame grid is then irregular (see visFloor).
    let nS = 0, sum = 0, minD = Infinity, maxD = -Infinity;
    for (let i = 0; i < vid.stts.length / 2; i++) {
      const cnt = vid.stts[2 * i] - (i === vid.stts.length / 2 - 1 ? 1 : 0), d = vid.stts[2 * i + 1];
      if (cnt > 0) { nS += cnt; sum += cnt * d; minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
    }
    media.vfr = !!(media.fps && nS && minD !== maxD && Math.abs(nS * vid.ts / sum - media.fps) > 1e-3 * media.fps);
    let minPts = Infinity, dts = 0, j = 0, ci = 0, cLeft = vid.ctts ? vid.ctts[0][0] : 0;
    for (let i = 0; i < vid.stts.length / 2 && j < 64; i++) {
      for (let k = 0; k < vid.stts[2 * i] && j < 64; k++, j++) {
        let c = 0;
        if (vid.ctts && ci < vid.ctts.length) { c = vid.ctts[ci][1]; if (--cLeft === 0 && ++ci < vid.ctts.length) cLeft = vid.ctts[ci][0]; }
        minPts = Math.min(minPts, dts + c); dts += vid.stts[2 * i + 1];
      }
    }
    vStart = ve.empty + (minPts - ve.mt) / vid.ts;
    vEnd = ve.empty + (vid.mdur - ve.mt) / vid.ts;
  }
  const fStart = vStart === null ? media.aStartAbs : (media.hasAudio ? Math.min(vStart, media.aStartAbs) : vStart);
  media.fStart = fStart;
  media.aOff = media.hasAudio ? media.aStartAbs - fStart : 0;
  media.vOff = vStart === null ? null : vStart - fStart;
  media.duration = Math.max(media.hasAudio ? media.endTime : 0, vEnd || 0) - fStart;
  media.vDur = vStart === null ? null : vEnd - vStart;
  const en = vid && vid.entry;
  // Several non-empty edits would play parts of the track out of order: frame times cannot be mapped that simply.
  if (vid && vid.elst.filter(e => e.mt !== -1).length > 1) media.videoUnsupported = 'why.edits';
  else if (en && en.desc && vid.co && vid.stsc) {
    // Per-sample presentation time (file time: stts + ctts, through the edit list), file offset, size, keyframe.
    const n = vid.sampleCount, pts = new Float64Array(n), off = new Float64Array(n), size = new Uint32Array(n), key = new Uint8Array(n);
    const cs = chunkCounts(vid);
    let si = 0;
    for (let c = 0; c < cs.length; c++) {
      let o = vid.co[c];
      for (let k = 0; k < cs[c] && si < n; k++, si++) { const z = vid.sizes ? vid.sizes[si] : vid.sampleSize; off[si] = o; size[si] = z; o += z; }
    }
    let dts = 0, j = 0, ci = 0, cLeft = vid.ctts ? vid.ctts[0][0] : 0;
    for (let i = 0; i < vid.stts.length / 2; i++) {
      for (let k = 0; k < vid.stts[2 * i] && j < n; k++, j++) {
        let c = 0;
        if (vid.ctts && ci < vid.ctts.length) { c = vid.ctts[ci][1]; if (--cLeft === 0 && ++ci < vid.ctts.length) cLeft = vid.ctts[ci][0]; }
        pts[j] = ve.empty + (dts + c - ve.mt) / vid.ts - fStart;
        dts += vid.stts[2 * i + 1];
      }
    }
    if (vid.stss) for (const s of vid.stss) { if (s >= 1 && s <= n) key[s - 1] = 1; } else key.fill(1);
    const keys = [];
    for (let i = 0; i < n; i++) if (key[i]) keys.push(i);
    keys.sort((x, y) => pts[x] - pts[y]);
    media.video = { fmt: en.fmt, cfg: en.cfg, desc: en.desc, width: en.width, height: en.height, n, pts, off, size, key, keys };
  }
  media.hasVideo = !!(media.video || media.videoUnsupported);
  return media;
}

async function openWav(file) {
  let off = 12, fmt = null, dataOff = null, dataSize = null, ds64Data = null, bext = null;
  const head = await sliceDV(file, 0, 12);
  const riff = fourcc(head, 0);
  if ((riff !== 'RIFF' && riff !== 'RF64' && riff !== 'BW64') || fourcc(head, 8) !== 'WAVE') throw fail('err.wav');
  while (off + 8 <= file.size) {
    const h = await sliceDV(file, off, off + 8);
    const id = fourcc(h, 0);
    let size = h.getUint32(4, true);
    if (id === 'ds64') { const d = await sliceDV(file, off + 8, off + 8 + 28); ds64Data = d.getUint32(8, true) + d.getUint32(12, true) * 4294967296; }
    else if (id === 'fmt ') {
      const d = await sliceDV(file, off + 8, off + 8 + Math.min(size, 40));
      let tag = d.getUint16(0, true);
      if (tag === 0xFFFE && size >= 26) tag = d.getUint16(24, true);
      fmt = { tag, channels: d.getUint16(2, true), sr: d.getUint32(4, true), block: d.getUint16(12, true), bits: d.getUint16(14, true) };
    } else if (id === 'bext' && size >= 346) {
      const d = await sliceDV(file, off + 8, off + 8 + 346);
      bext = { timeRef: d.getUint32(338, true) + d.getUint32(342, true) * 4294967296 };
    } else if (id === 'data') {
      dataOff = off + 8;
      dataSize = (size === 0xFFFFFFFF && ds64Data !== null) ? ds64Data : size;
      if (riff !== 'RIFF' && ds64Data !== null) dataSize = ds64Data;
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataOff === null) throw fail('err.wavChunks');
  if (fmt.tag !== 1 && fmt.tag !== 3) throw fail('err.wavCodec');
  const bytes = fmt.bits / 8;
  const pcm = { float: fmt.tag === 3, le: true, bytes, frame: fmt.block };
  dataSize = Math.min(dataSize, file.size - dataOff);
  const total = Math.floor(dataSize / fmt.block);
  return { kind: 'wav', file, hasAudio: true, hasVideo: false, isAac: false, pcm, sr: fmt.sr, channels: fmt.channels, total,
    cFirst: new Float64Array([0, total]), co: [dataOff], frameTime: f => f / fmt.sr,
    aOff: 0, vOff: null, fStart: 0, duration: total / fmt.sr, aDur: total / fmt.sr, bextSec: bext ? bext.timeRef / fmt.sr : null };
}

export async function openMedia(file) {
  return /\.wav$/i.test(file.name) ? openWav(file) : openMp4(file);
}

// ----------------------------------------------------------- audio reading
function convertPcm(buf, spec, channels, chans, at) {
  const dv = new DataView(buf), n = Math.floor(buf.byteLength / spec.frame), le = spec.le;
  for (let f = 0; f < n; f++) {
    const base = f * spec.frame;
    for (let c = 0; c < channels; c++) {
      const o = base + c * spec.bytes;
      let v;
      if (spec.float) v = spec.bytes === 4 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
      else if (spec.bytes === 2) v = dv.getInt16(o, le) / 32768;
      else if (spec.bytes === 3) {
        const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
        let x = le ? (b0 | (b1 << 8) | (b2 << 16)) : (b2 | (b1 << 8) | (b0 << 16));
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (spec.bytes === 4) v = dv.getInt32(o, le) / 2147483648;
      else v = dv.getInt8(o) / 128;
      chans[c][at + f] = v;
    }
  }
  return n;
}

// Read [a, b) seconds of the file timeline. Returns { chans: Float32Array[], t0: file time of chans[*][0], sr }.
export async function readWindow(m, a, b) {
  a = Math.max(0, a);
  if (m.isAac) return readAac(m, a, b);
  const sr = m.sr, f0abs = m.fStart + a, f1abs = m.fStart + b;
  // frame index range via the linear frame clock
  const t0frame = m.frameTime(0);
  let f0 = Math.max(0, Math.ceil((f0abs - t0frame) * sr - 1e-9)), f1 = Math.min(m.total, Math.ceil((f1abs - t0frame) * sr));
  if (f1 <= f0) return { chans: [], t0: a, sr };
  const chans = Array.from({ length: m.channels }, () => new Float32Array(f1 - f0));
  const parts = [];
  // chunks overlapping [f0, f1)
  let lo = 0, hi = m.cFirst.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (m.cFirst[mid] <= f0) lo = mid; else hi = mid; }
  for (let c = lo; c < m.cFirst.length - 1 && m.cFirst[c] < f1; c++) {
    const s = Math.max(f0, m.cFirst[c]), e = Math.min(f1, m.cFirst[c + 1]);
    if (e <= s) continue;
    const byte = m.co[c] + (s - m.cFirst[c]) * m.pcm.frame;
    parts.push({ at: s - f0, p: m.file.slice(byte, byte + (e - s) * m.pcm.frame).arrayBuffer() });
  }
  for (const part of parts) convertPcm(await part.p, m.pcm, m.channels, chans, part.at);
  return { chans, t0: m.frameTime(f0) - m.fStart, sr };
}

function findSample(m, tAbs) { // last sample whose start <= tAbs
  let lo = 0, hi = m.n;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (m.timeOf(mid) <= tAbs) lo = mid; else hi = mid; }
  return lo;
}

async function readAac(m, a, b) {
  const sr = m.sr;
  const tA = m.fStart + a, tB = m.fStart + b;
  let i0 = findSample(m, tA);
  if (m.timeOf(i0) < tA - 1e-9) i0 += 1;                 // first frame starting at or after a
  let i1 = Math.min(m.n, findSample(m, tB) + 1);
  if (i1 <= i0) return { chans: [], t0: a, sr };
  const st = Math.max(0, i0 - 2);                        // warm-up frames for the decoder's overlap
  const bufs = await Promise.all(Array.from({ length: i1 - st }, (_, k) =>
    m.file.slice(m.off[st + k], m.off[st + k] + m.size[st + k]).arrayBuffer()));
  const BIAS = 1000;                                     // s; keeps priming frames' timestamps positive
  const usec = i => Math.round((m.timeOf(i) + BIAS) * 1e6);
  const outs = await new Promise((res, rej) => {
    const got = [];
    const dec = new AudioDecoder({ output: d => got.push(d), error: e => rej(e) });
    dec.configure({ codec: m.codec, sampleRate: sr, numberOfChannels: m.channels, description: m.asc });
    bufs.forEach((buf, k) => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: usec(st + k), data: buf })));
    dec.flush().then(() => { dec.close(); res(got); }, rej);
  });
  // place each decoded frame by its own timestamp (robust to dropped/extra outputs)
  const startTick = m.mtime[i0], len = Math.round((m.mtime[i1] - startTick) * sr / m.tsc);
  const chans = Array.from({ length: m.channels }, () => new Float32Array(len));
  for (const d of outs) {
    const tSec = d.timestamp / 1e6 - BIAS;
    const idx = findSample(m, tSec + 0.5 / sr);
    if (idx >= i0 && idx < i1) {
      const at = Math.round((m.mtime[idx] - startTick) * sr / m.tsc), nf = Math.min(d.numberOfFrames, len - at);
      for (let c = 0; c < Math.min(m.channels, d.numberOfChannels); c++) {
        const tmp = new Float32Array(d.numberOfFrames);
        d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        chans[c].set(tmp.subarray(0, nf), at);
      }
    }
    d.close();
  }
  return { chans, t0: m.timeOf(i0) - m.fStart, sr };
}
