// analyzer.test.mjs — 回歸測試：以 headless 瀏覽器跑網頁分析器（run-analyzer.mjs），對 tests/fixtures/ 的測試檔檢查結果。
//
// 1. 執行環境：沒有錯誤、有 WebCodecs；瀏覽器的時區與真值記錄的時區相同（cam.mp4 的建立時間依 UTC+8 寫入）。
// 2. 與真值（<名稱>.truth.json）比對：週期、音高排除數、模式為固定的期望值；速度比例、起點（以真值的週期換算）、
//    校正後長度、聲畫偏移的誤差須在報告自己的預估誤差內，預估誤差本身不超過真值的上限；建立時間的 r 與真值相差 ≤ 0.02 秒。
// 3. 跨檔案：cam.mp4 與 picture.mp4 的起點差（兩者都有畫面碼，9 分鐘一輪）須為 2 分鐘。
// 4. 與 Node 命令列版（cli/slate-sync.mjs --json --av）交叉比對；沒有 ffmpeg 時略過。
// 5. 文字報告快照（tests/web/snapshots/）：數字與解碼方式遮掉後逐字比對，報告文字一改就看得出來。
//    報告措辭是刻意修改時，以 `node tests/web/analyzer.test.mjs --update` 更新快照並一起 commit。
// 檢查邏輯在 checks.mjs。需要 Chrome 或 Edge（環境變數 BROWSER 可指定）；交叉比對另需 ffmpeg／ffprobe。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/slate.mjs';
import { FIXTURES, fixture, hasFfmpeg, tempDir } from '../lib/tools.mjs';
import { run } from './run-analyzer.mjs';
import { Checker, checkCli, checkPair, checkTimezone, checkTruth, normalize } from './checks.mjs';

const ORDER = ['wave.wav', 'aac.m4a', 'cam.mp4', 'picture.mp4', 'ltc.wav'];
const PAIR = ['cam.mp4', 'picture.mp4'];          // 起點相差 2 分鐘、都有畫面碼的一組
const SNAPSHOT = path.join(ROOT, 'tests', 'web', 'snapshots', 'report.zh-Hant.txt');
const UPDATE = process.argv.includes('--update');

// 每組檢查一個子測試：全部檢查都跑完，失敗的一次列出。
function verdict(c) {
  if (c.warns.length) console.log(c.warns.map(w => '警告：' + w).join('\n'));
  assert.deepEqual(c.fails, [], c.fails.join('\n'));
}

test('網頁分析器（headless 瀏覽器）', { timeout: 10 * 60 * 1000 }, async t => {
  const tmp = tempDir(t, 'slate-fixtures-');
  const truths = {}, paths = [];
  for (const name of ORDER) {
    const truth = JSON.parse(fs.readFileSync(path.join(FIXTURES, name.replace(/\.\w+$/, '.truth.json')), 'utf8'));
    const p = fixture(name, tmp);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    assert.equal(sha, truth.sha256, `${name} 與它的真值不是同一次產生的（sha256 不符）；請重新產生 tests/fixtures/`);
    truths[name] = truth;
    paths.push(p);
  }
  const res = await run(paths, { av: true, lang: 'zh-Hant', timeout: 180 });
  t.diagnostic(`網頁版：${res.userAgent}，${res.wallS.toFixed(1)} 秒`);
  const byName = Object.fromEntries((res.results || []).map(r => [r.file, r]));

  await t.test('執行環境', () => {
    const c = new Checker();
    for (const e of res.errors || []) c.check('網頁', '執行', false, e);
    c.check('網頁', '完成', !!res.ok, res.ok ? '是' : '否');
    c.check('網頁', 'WebCodecs', Object.values(res.webcodecs || {}).every(Boolean) && !!res.webcodecs, JSON.stringify(res.webcodecs));
    checkTimezone(c, res, Object.values(truths));
    verdict(c);
  });
  for (const name of ORDER) await t.test(`真值：${name}`, () => {
    const c = new Checker();
    if (byName[name]) checkTruth(c, byName[name], truths[name]); else c.check(name, '分析', false, '沒有結果');
    verdict(c);
  });
  await t.test('跨檔案', () => { const c = new Checker(); checkPair(c, byName, truths, PAIR); verdict(c); });
  await t.test('文字報告快照', () => {
    const text = normalize(res.report);
    if (UPDATE) { fs.writeFileSync(SNAPSHOT, text); t.diagnostic('已更新快照 ' + path.relative(ROOT, SNAPSHOT)); return; }
    assert.ok(fs.existsSync(SNAPSHOT), `沒有 ${path.relative(ROOT, SNAPSHOT)}；以 --update 建立`);
    assert.equal(text, fs.readFileSync(SNAPSHOT, 'utf8'), '與快照不同（刻意修改時以 --update 更新）');
  });
  await t.test('與命令列版交叉比對', { skip: !hasFfmpeg() && '找不到 ffmpeg／ffprobe' }, () => {
    const p = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'slate-sync.mjs'), ...paths, '--av', '--json'],
      { maxBuffer: 1 << 26 });
    assert.equal(p.status, 0, '命令列版執行失敗：\n' + String(p.stderr).slice(-2000));
    const cli = Object.fromEntries(JSON.parse(p.stdout.toString('utf8')).map(r => [path.basename(r.file), r]));
    const c = new Checker();
    for (const name of ORDER) if (byName[name]) checkCli(c, byName[name], cli[name]);
    verdict(c);
  });
});
