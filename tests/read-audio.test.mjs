// read-audio.test.mjs — 回歸測試：命令列版（cli/media.mjs）的 readWindow() 從任何位置讀取，第一個取樣都必須正好落在
// 回傳的 t0（要求的時間移到取樣格點上）。
//
// 以 ffmpeg 產生 12 秒掃頻音訊（AAC 的 .m4a、.mp4 與 WAV），在 16 個位置（0、1 秒內、AAC 封包邊界附近、檔尾附近）
// 以 readWindow() 讀取，與 ffmpeg 整段解碼後的對應取樣比對：以互相關找出錯位，必須為 0 個取樣。
// （AAC 以輸入端 -ss 讀取時，ffmpeg 會從下一個封包邊界開始輸出，最多晚 1024 個取樣。）需要 ffmpeg／ffprobe（PATH 中）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/slate.mjs';
import { run, tempDir } from './lib/tools.mjs';

const SR = 48000, DUR = 12, LEN = 0.5, MAX_LAG = 2048, N = 8192;
const STARTS = [0, 0.001, 0.01, 0.0213, 0.03, 0.1, 0.5, 1.0, 1.05, 1.1, 2.0, 2.7, 1024 * 5 / SR, 1024 * 5 / SR + 0.001, 5.333, DUR - 1.2];

const full = f => { const b = run('ffmpeg', ['-v', 'error', '-i', f, '-vn', '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-']);
  return new Float32Array(Uint8Array.from(b).buffer); };        // 複製一份：Buffer 的位移不一定是 4 的倍數

// seg 相對 ref[start..] 的錯位（取樣）：在 ±MAX_LAG 內找互相關最大的位置。
function lag(ref, start, seg) {
  const n = Math.min(seg.length, N), lo = Math.max(0, start - MAX_LAG), hi = Math.min(ref.length - n, start + MAX_LAG);
  let best = -Infinity, at = 0;
  for (let o = lo; o <= hi; o++) {
    let c = 0;
    for (let i = 0; i < n; i++) c += ref[o + i] * seg[i];
    if (c > best) { best = c; at = o; }
  }
  return at - start;
}

test('readWindow() 從任何位置讀取都不錯位', async t => {
  const d = tempDir(t), wav = path.join(d, 'chirp.wav');
  // 頻率上升的掃頻：每個位置的波形都不同，錯位的讀取不會碰巧對上。
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*(100*t+150*t*t)):s=${SR}:d=${DUR}`, wav]);
  const files = { WAV: wav };
  for (const ext of ['m4a', 'mp4']) {
    files['AAC .' + ext] = path.join(d, 'chirp.' + ext);
    run('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '192k', files['AAC .' + ext]]);
  }
  const { openMedia } = await import(pathToFileURL(path.join(ROOT, 'cli', 'media.mjs')));
  for (const [name, f] of Object.entries(files)) {
    const ref = full(f), m = await openMedia(f), bad = [];
    for (const s of STARTS) {
      const w = await m.readWindow(s, s + LEN), k = lag(ref, Math.round(w.t0 * SR), w.chans[0]);
      if (k) bad.push(`${s} 秒：${k > 0 ? '+' : ''}${k}`);
    }
    assert.deepEqual(bad, [], `${name}：${bad.length}／${STARTS.length} 個位置錯位（取樣）`);
  }
});
