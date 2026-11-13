// checks.test.mjs — 網頁分析器回歸測試的檢查邏輯（checks.mjs）本身：以真值做出「正確」的結果，再逐項改壞，
// 每一項都必須被抓到。不開瀏覽器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../lib/tools.mjs';
import { Checker, checkTimezone, checkTruth, normalize, tzOffsetMin } from './checks.mjs';

const truth = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// 與真值完全相符的分析結果（欄位同分析器的 buildResult()）。
function perfect(t) {
  return { file: t.file, mode: t.mode, mod: t.mod, pitchRejected: 0, ppm: t.ppm, uncPpm: t.max_unc_ppm / 4,
    worstMs: t.max_worst_ms / 4, startLabel: t.start % t.mod, correctedLength: t.corrected_length,
    clockType: t.clock_type, clockR: t.clock_r ?? null, startClock: t.start, clockMod: t.clock_type || t.ltc ? 86400 : t.mod,
    source: t.ltc ? 'ltc' : null,
    avOffsetMs: t.av_offset_ms !== null && t.av_offset_ms !== undefined ? { head: { mean: t.av_offset_ms, half: 10 } } : {} };
}
const fails = (r, t) => { const c = new Checker(); checkTruth(c, r, t); return c.fails; };

test('正確的結果全部通過', () => {
  for (const f of ['wave', 'aac', 'cam', 'picture', 'ltc']) {
    const t = truth(f + '.truth.json');
    assert.deepEqual(fails(perfect(t), t), [], f);
  }
});

test('音高循環壞掉：週期退回 60 秒、起點只對到 60 秒內也會失敗', () => {
  const t = truth('cam.truth.json'), r = perfect(t);
  // 退回 60 秒週期時，分析器回報的起點只在 60 秒內；以它自己的週期 wrap 會通過，以真值的週期不會。
  Object.assign(r, { mod: 60, startLabel: t.start % 60 });
  const f = fails(r, t);
  assert.ok(f.some(x => x.includes('週期')), f.join('\n'));
  assert.ok(f.some(x => x.includes('起點')), f.join('\n'));
});

test('音高排除數不為 0 時失敗', () => {
  const t = truth('aac.truth.json');
  assert.ok(fails({ ...perfect(t), pitchRejected: 2 }, t).some(x => x.includes('音高排除')));
});

test('建立時間的 r 偏離真值超過 0.02 秒時失敗', () => {
  const t = truth('cam.truth.json');
  assert.equal(t.clock_r, -0.265);
  assert.deepEqual(fails({ ...perfect(t), clockR: t.clock_r + 0.019 }, t), []);
  assert.ok(fails({ ...perfect(t), clockR: t.clock_r + 0.025 }, t).some(x => x.includes('設備時鐘差 r')));
  assert.ok(fails({ ...perfect(t), clockR: -0.25 }, t).length === 0, '±0.02 內的舊算法值（以 15 秒算）仍在容許內');
  assert.ok(fails({ ...perfect(t), clockR: null }, t).some(x => x.includes('設備時鐘差 r')));
});

test('預估誤差超過上限時失敗', () => {
  const t = truth('picture.truth.json');
  assert.ok(fails({ ...perfect(t), uncPpm: t.max_unc_ppm * 1.01 }, t).some(x => x.includes('速度比例估計誤差')));
  assert.ok(fails({ ...perfect(t), worstMs: t.max_worst_ms * 1.01 }, t).some(x => x.includes('預估誤差')));
});

test('瀏覽器時區與真值不同時明確報錯', () => {
  const t = truth('cam.truth.json');
  assert.equal(tzOffsetMin('+08:00'), -480);
  assert.equal(tzOffsetMin('-05:30'), 330);
  const run = off => { const c = new Checker(); checkTimezone(c, { tzOffsetMin: off }, [t, truth('wave.truth.json')]); return c.fails; };
  assert.deepEqual(run(-480), []);
  const f = run(0);
  assert.equal(f.length, 1);
  assert.match(f[0], /TZ=Asia\/Taipei/);
  assert.equal(run(undefined).length, 1);
});

test('快照正規化：硬體解碼失敗那一行拿掉，數字與解碼方式遮掉', () => {
  const a = '  畫面解碼          : 實際解碼 1.2 秒，硬體解碼（WebCodecs）\n  模式              : 頭尾\n';
  const b = '  畫面解碼          : 實際解碼 3.4 秒，軟體解碼\n  ⚠ 硬體解碼失敗    : 已改用軟體解碼：EncodingError 12\n  模式              : 頭尾\n';
  assert.equal(normalize(a), normalize(b));
  assert.equal(normalize(a), '  畫面解碼          : 實際解碼 # 秒，〈解碼〉\n  模式              : 頭尾\n');
  assert.equal(normalize('  ⚠ 硬體解碼失敗    : 已改用瀏覽器預設的解碼方式：x\n'), '\n');
  assert.equal(normalize('cam.mp4：+12.5 ms'), 'cam.mp4：# ms\n');
});
