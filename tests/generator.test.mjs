// generator.test.mjs — 測試產生器（tests/make_test_media.mjs）本身，以及只靠它才做得出來的分析器回歸案例。
//
// - --help 列出全部選項；錯誤的參數以結束碼 2 結束。
// - 建立時間：--created end 搭配 --visual 時以影片長 nfr / fps 計算（固定的 creation_time 期望值）；WAV 的 BWF
//   time_reference 為 round((起點 + 偏差) × 48000)。以 ffprobe 讀回。
// - 分析器讀不到足夠的音高時退回只用秒數（週期 60 秒）：只錄 2 秒波形碼時週期為 60，3 秒時為 540（命令列版）。
// 需要 ffmpeg／ffprobe（PATH 中）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './lib/root.mjs';
import { run, tempDir } from './lib/tools.mjs';

const GEN = path.join(ROOT, 'tests', 'make_test_media.mjs');
const gen = (...args) => spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' });
const probeTags = f => JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', f]).toString()).format.tags || {};
const analyze = f => JSON.parse(run(process.execPath, [path.join(ROOT, 'cli', 'slate-sync.mjs'), f, '--json']).toString())[0];

test('--help 列出全部選項', () => {
  const p = gen('--help');
  assert.equal(p.status, 0);
  for (const o of ['minutes', 'ppm', 'start', 'plug', 'ppm-end', 'ltc', 'df', 'ltc-channel', 'ltc-with', 'ltc-noise', 'ltc-invert',
    'created', 'created-offset', 'date', 'tz', 'visual', 'fps', 'size', 'codec', 'encoder', 'gop', 'tag-size', 'blur', 'exposure',
    'tilt', 'shutter', 'av-offset', 'audio'])
    assert.match(p.stdout, new RegExp(`--${o}\\b`), `--help 沒有 --${o}`);
});

test('錯誤的參數以結束碼 2 結束', () => {
  for (const args of [['x.wav', '--ltc', '48'], ['x.wav', '--ltc', '25', '--df'], ['x.wav', '--created', 'end'],
    ['x.wav', '--visual'], ['x.wav', '--minutes', 'abc'], ['x.wav', '--nope'], []]) {
    const p = gen(...args);
    assert.equal(p.status, 2, `${args.join(' ')}：結束碼 ${p.status}（${p.stderr}）`);
  }
});

test('--created end 搭配 --visual：建立時間以影片長 nfr / fps 計算', t => {
  const f = path.join(tempDir(t), 'end.mp4');
  // 1 秒、29.97 fps → 30 格 = 1.001 秒。起點 12:00:00.9995：以 1 秒算是 12:00:01，以影片長算是 12:00:02。
  const p = gen(f, '--minutes', String(1 / 60), '--start', '12:00:00.9995', '--ppm', '0', '--visual', '--fps', '29.97',
    '--size', '320x180', '--encoder', 'cpu', '--audio', 'none', '--created', 'end', '--tz', '+08:00', '--date', '2026-11-12');
  assert.equal(p.status, 0, p.stderr);
  assert.equal(probeTags(f).creation_time, '2026-11-12T04:00:02.000000Z');
  assert.match(p.stdout, /檔長 1\.001000 秒）：r = -0\.000500 秒/);
});

test('--created start 的 WAV 寫 BWF time_reference', t => {
  const f = path.join(tempDir(t), 'bwf.wav');
  const p = gen(f, '--minutes', '0.05', '--start', '09:15:20.125', '--created', 'start', '--created-offset', '0.8');
  assert.equal(p.status, 0, p.stderr);
  assert.equal(probeTags(f).time_reference, String(Math.round((33320.125 + 0.8) * 48000)));
});

test('分析器：只錄 2 秒波形碼時退回只用秒數（週期 60），3 秒時用音高（週期 540）', t => {
  const d = tempDir(t);
  for (const [secs, mod] of [[3, 60], [4, 540]]) {
    // 起點 12:00:00.3：檔案長 secs 秒時，完整的波形碼秒數為 secs − 1。
    const f = path.join(d, `short${secs}.wav`);
    const p = gen(f, '--minutes', String(secs / 60), '--start', '12:00:00.3', '--ppm', '300');
    assert.equal(p.status, 0, p.stderr);
    const r = analyze(f);
    assert.ok(!r.error, JSON.stringify(r.error));
    assert.equal(r.mod, mod, `${secs - 1} 秒波形碼的週期`);
    const want = 43200.3 % mod, dms = (((r.start_label - want) % mod + mod * 1.5) % mod - mod / 2) * 1000;
    assert.ok(Math.abs(dms) <= r.worst_ms + 0.011, `起點誤差 ${dms.toFixed(4)} ms（預估 ±${r.worst_ms.toFixed(4)}）`);
  }
});
