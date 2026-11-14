// clock-format.test.mjs — 回歸測試：起點時鐘的顯示先四捨五入到毫秒再拆成時分秒，秒數不會出現 60.000。
// 檢查網頁與命令列共用的分析核心 fmtClock()（src/core/report.js），涵蓋 60、540、3600、10800、86400 秒五種週期，
// 期望值是固定的字串（含 9 分鐘與 3 小時週期的繁中註記）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/root.mjs';

const { createReport } = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'report.js')));
const { translator } = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'i18n.js')));
const { fmtClock } = createReport(translator('zh-Hant'));

// [秒, 週期, 期望的完整字串]
const CASES = [
  [59.9996, 60, '??:??:00.000'],
  [31.833, 60, '??:??:31.833'],
  [539.9996, 540, '??:??:00.000（9 分鐘週期第 0 分）'],
  [59.9996, 540, '??:??:00.000（9 分鐘週期第 1 分）'],
  [4 * 60 + 31.8334, 540, '??:??:31.833（9 分鐘週期第 4 分）'],
  [12 * 60 + 59.9995, 3600, '??:13:00.000'],
  [2 * 3600 + 59 * 60 + 59.9996, 10800, '??:00:00.000（3 小時週期第 0 時）'],
  [3599.9996, 10800, '??:00:00.000（3 小時週期第 1 時）'],
  [3600 + 12 * 60 + 31.833, 10800, '??:12:31.833（3 小時週期第 1 時）'],
  [21 * 3600 + 37 * 60 + 59.9996, 86400, '21:38:00.000'],
  [23 * 3600 + 59 * 60 + 59.9999, 86400, '00:00:00.000'],
  [21 * 3600 + 37 * 60 + 31.8334, 86400, '21:37:31.833'],
];

for (const [sec, m, want] of CASES)
  test(`${sec} 秒（週期 ${m}）→ ${want}`, () => assert.equal(fmtClock(sec, m), want));
