// cli-encoding.test.mjs — 回歸測試：主控台編碼不是 UTF-8 時（如繁體中文 Windows 的 cp950），命令列報告必須完整印出。
//
// 報告含「▶」等 cp950 沒有的字元；若輸出時未處理，報告會在中途結束。以 tests/fixtures/wave.wav（波形碼）執行
// Node 命令列版（cli/slate-sync.mjs）：Windows 上先把主控台字碼頁切到 950（chcp），其他系統以 LANG=C、LC_ALL=C 執行；
// 必須以 0 結束，且以 UTF-8 印出速度比例與校正後長度兩行。
// （輸出導向管線，未在真的 cp950 主控台視窗中驗證；node 寫入主控台時一律用 UTF-16 API，寫入管線時一律用 UTF-8。）
// 需要 ffmpeg／ffprobe（PATH 中）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './lib/slate.mjs';
import { fixture, tempDir } from './lib/tools.mjs';

test('非 UTF-8 主控台：報告完整印出', t => {
  const wav = fixture('wave.wav', tempDir(t));
  const cli = path.join(ROOT, 'cli', 'slate-sync.mjs');
  const p = process.platform === 'win32'
    ? spawnSync(`chcp 950 >nul & "${process.execPath}" "${cli}" "${wav}"`, { shell: true })
    : spawnSync(process.execPath, [cli, wav], { env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
  const out = p.stdout.toString('utf8');
  assert.equal(p.status, 0, `結束碼 ${p.status}：${p.stderr.toString('utf8').slice(-800)}`);
  assert.match(out, /速度比例/);
  assert.match(out, /校正後長度/);
  assert.match(out, /▶/);
});
