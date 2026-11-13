// media.mjs — 命令列的讀檔：以 ffprobe 取得檔案資訊、ffmpeg 解出 PCM 與縮小的灰階影格，組成分析核心的 media 介面
// （見 src/core/analyze.js 開頭）。ffmpeg／ffprobe 須在 PATH 中。
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { VIS_SHORT } from '../src/core/visual.js';

// Runs a program and collects its output. Resolves { code, stdout: Buffer, stderr: Buffer }; a missing program rejects.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', e => reject(e.code === 'ENOENT' ? new Error(`找不到 ${cmd}：請安裝 ffmpeg 並加進 PATH`) : e));
    p.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
  });
}

const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const ratio = s => { const [a, b] = String(s || '0/1').split('/').map(Number); return a && b ? a / b : null; };

// The name ffmpeg and ffprobe are given for a file: "file:" and the absolute path, so a name that starts with "-" is not
// read as an option, "-" not as standard input, and one with ":" not as another protocol ("rtmp:", "concat:").
const input = path => 'file:' + resolve(path);

async function ffprobe(src) {
  const p = await run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,start_time:format_tags=creation_time,time_reference:' +
    'stream=codec_type,avg_frame_rate,r_frame_rate,channels,sample_rate,nb_frames,duration,start_time:stream_disposition=attached_pic',
    '-of', 'json', '-i', src]);
  if (p.code) throw new Error(p.stderr.toString('utf8').trim() || 'ffprobe 執行失敗');
  return JSON.parse(p.stdout.toString('utf8'));
}

// The core's media object for one file. fps: --fps (overrides the file's frame rate); hwaccel: false for --no-hwaccel.
export async function openMedia(path, { fps = null, hwaccel = true } = {}) {
  const src = input(path), j = await ffprobe(src), fmt = j.format || {}, tags = fmt.tags || {};
  const fStart = num(fmt.start_time) || 0, D = num(fmt.duration);
  if (D === null) throw new Error('ffprobe 讀不到檔案長度');
  const streams = j.streams || [];
  const a = streams.find(s => s.codec_type === 'audio');
  const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!a && !v) throw Object.assign(new Error('err.noAudio'), { i18n: { key: 'err.noAudio' } });
  const off = s => num(s.start_time) === null ? 0 : num(s.start_time) - fStart;
  const m = { name: path, modified: statSync(path).mtimeMs, movieDuration: D, hasAudio: !!a, hasVideo: !!v,
    aOff: 0, aDur: null, vOff: null, vDur: null, vFrames: null, fps: null, vfr: false, created: null, bextSec: null };
  if (a) {
    Object.assign(m, { aOff: off(a), sr: Number(a.sample_rate), channels: Number(a.channels) || 1 });
    m.aDur = num(a.duration) ?? D - m.aOff;          // the edit list is applied: AAC priming and padding are cut off
  }
  if (v) {
    m.vOff = off(v);
    m.vDur = num(v.duration) ?? D - m.vOff;
    m.vFrames = parseInt(v.nb_frames, 10) || null;
    m.fps = ratio(v.avg_frame_rate);
    const nominal = ratio(v.r_frame_rate);
    // Average and nominal rates disagree: variable frame rate (phones). The frame grid is irregular (visFloor).
    m.vfr = !!(m.fps && nominal && Math.abs(nominal - m.fps) > 1e-3 * m.fps);
  }
  if (fps) m.fps = fps;
  m.duration = Math.max(a ? m.aOff + m.aDur : 0, v ? m.vOff + m.vDur : 0) || D;
  if (tags.creation_time) { const t = Date.parse(tags.creation_time); if (Number.isFinite(t) && t > 0) m.created = t / 1000; }
  if (a && tags.time_reference && Number(tags.time_reference) > 0) m.bextSec = Number(tags.time_reference) / m.sr;
  m.readWindow = (x, y) => readAudio(src, m, x, y);
  m.openVideo = async () => {
    if (!v) return { unsupported: { why: 'why.codec', codec: '?' } };
    const vr = new FfmpegVideo(src, fStart, hwaccel);
    await vr.index();
    return vr;
  };
  return m;
}

// File time [a, b) of the first audio track as 32-bit float PCM at the track's own rate, one Float32Array per channel.
// An input-side -ss on AAC makes ffmpeg start the output at the next packet boundary (up to 1024 samples, 21 ms, late;
// a full packet late at 0), so the input seeks to 1 s before the target and the output side cuts exactly, dropping
// decoded samples by timestamp; near the start the file is decoded from the top. The start is moved onto the track's
// sample grid (and the cut placed a quarter sample before it), so chans[*][0] sits exactly at t0.
async function readAudio(src, m, a, b) {
  const sr = m.sr, ch = m.channels;
  const t0 = Math.max(m.aOff, m.aOff + Math.ceil((Math.max(0, a) - m.aOff) * sr - 1e-6) / sr);
  if (b <= t0) return { chans: [], t0, sr };
  const cut = Math.max(0, t0 - 0.25 / sr), pre = cut >= 1.1 ? cut - 1.0 : 0;
  const p = await run('ffmpeg', ['-v', 'error', ...(pre ? ['-ss', pre.toFixed(6)] : []), '-i', src,
    '-ss', (cut - pre).toFixed(6), '-t', (b - t0).toFixed(6), '-vn', '-map', '0:a:0', '-f', 'f32le', '-']);
  if (p.code) throw new Error('ffmpeg 解碼失敗：' + p.stderr.toString('utf8').trim().slice(-300));
  const n = Math.floor(p.stdout.length / 4 / ch);
  const all = new Float32Array(p.stdout.buffer.slice(p.stdout.byteOffset, p.stdout.byteOffset + n * ch * 4));
  const chans = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < ch; c++) chans[c][i] = all[k++];
  return { chans: n ? chans : [], t0, sr };
}

const HWACCELS = ['cuda', 'd3d11va'];
const SHOWINFO = /pts_time:\s*(\S+).*?\bs:(\d+)x(\d+)/;

// The video reader VEnd uses (src/core/analyze.js): keyframe times from ffprobe's packet list, frames from ffmpeg.
// Hardware decoding: the first of cuda, d3d11va that decodes a short piece of the file cleanly (tried once); if a read
// fails or its output does not add up, it is repeated in software and the file stays on software.
class FfmpegVideo {
  constructor(path, fStart, hwaccel) {
    Object.assign(this, { path, fStart, hwaccel, decoders: new Set(), fallback: null, packets: null, keys: [], hw: undefined });
    this.fallbackKey = 'rep.hwFallbackSw';
  }
  // Every video packet (file time, size, keyframe): demuxing only, no decoding.
  async index() {
    const p = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,size,flags',
      '-of', 'csv=p=0', '-i', this.path]);
    this.packets = [];
    for (const line of p.stdout.toString('utf8').split(/\r?\n/)) {
      const [t, size, flags] = line.split(',');
      if (num(t) !== null && flags !== undefined) this.packets.push({ t: num(t) - this.fStart, size: Number(size), key: flags.includes('K') });
    }
    this.packets.sort((x, y) => x.t - y.t);
    this.keys = this.packets.filter(q => q.key).map(q => q.t);
  }
  keyBefore(t) { let k = null; for (const x of this.keys) { if (x <= t + 1e-6) k = x; else break; } return k; }
  keysIn(a, b) { return this.keys.filter(t => t >= a && t <= b); }
  async method() {
    if (this.hw !== undefined) return this.hw;
    this.hw = null;
    if (!this.hwaccel) return null;
    for (const hw of HWACCELS) {
      const p = await run('ffmpeg', ['-hide_banner', '-nostats', '-v', 'error', '-hwaccel', hw, '-t', '0.2', '-i', this.path,
        '-map', '0:v:0', '-an', '-vf', 'scale=w=-2:h=64,format=gray', '-f', 'rawvideo', '-']);
      if (p.code === 0 && p.stdout.length && !p.stderr.toString().trim()) { this.hw = hw; break; }
    }
    return this.hw;
  }
  // Every frame with a <= file time < b, in presentation order, goes to onFrame(t, grey, w, h). Returns the bytes of the
  // packets from the keyframe k0 up to b (what has to be read from the file to decode them).
  async read(k0, a, b, onFrame) {
    let frames;
    const hw = await this.method();
    if (hw) {
      try { frames = await this.decode(a, b, hw); this.decoders.add(hw); }
      catch (e) { this.fallback = String(e.message || e).slice(0, 200); this.hw = null; }
    }
    if (!frames) { frames = await this.decode(a, b, null); this.decoders.add('software'); }
    for (const [t, grey, w, h] of frames) if (t >= a - 1e-3 && t < b) onFrame(t, grey, w, h);
    return this.packets.reduce((s, q) => s + (q.t >= k0 - 1e-6 && q.t < b ? q.size : 0), 0);
  }
  // ffmpeg seeks to the keyframe before a and drops earlier frames; -copyts keeps the file's own timestamps and
  // showinfo prints each output frame's PTS (rawvideo carries none). passthrough keeps one output frame per decoded
  // frame, so the showinfo lines and the frames line up one to one.
  async decode(a, b, hw) {
    const vf = `scale=w='if(gt(iw,ih),-2,min(${VIS_SHORT},iw))':h='if(gt(iw,ih),min(${VIS_SHORT},ih),-2)':flags=area,format=gray,showinfo`;
    const p = await run('ffmpeg', ['-hide_banner', '-nostats', '-v', 'info', ...(hw ? ['-hwaccel', hw] : []),
      '-copyts', '-ss', Math.max(a, 0).toFixed(6), '-t', (b - a).toFixed(6), '-i', this.path, '-map', '0:v:0', '-an',
      '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
    if (p.code) throw new Error('ffmpeg 解碼畫面失敗：' + p.stderr.toString('utf8').trim().slice(-300));
    const out = [];
    let pos = 0;
    for (const line of p.stderr.toString('latin1').split(/\r?\n/)) {
      if (!line.includes('Parsed_showinfo')) continue;
      const mm = SHOWINFO.exec(line), t = mm ? num(mm[1]) : null;
      if (t === null) continue;
      const w = Number(mm[2]), h = Number(mm[3]);
      if (pos + w * h > p.stdout.length) throw new Error('ffmpeg 輸出的影格數與時間戳記數不符');
      out.push([t - this.fStart, new Uint8Array(p.stdout.buffer, p.stdout.byteOffset + pos, w * h), w, h]);
      pos += w * h;
    }
    return out;
  }
}
