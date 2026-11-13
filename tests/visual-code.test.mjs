// visual-code.test.mjs — 畫面碼（AprilTag，規格見 docs/visual-code.md）的碼表、繪製與 ID 公式。
//
// 比對對象是官方 tag36h11.c（tests/data/tag36h11.json，取自 AprilRobotics/apriltag，BSD-2-Clause）：
// 1. 碼表：場記板（web/sync-slate.html）與分析核心（src/core/visual.js）的 TAG36H11_CODES／BIT_X／BIT_Y 與官方相同；
//    官方碼表本身的最小漢明距離（含四種旋轉）為 11，抄錯一個位元就會被發現。
// 2. 繪製：以 vm 執行場記板的 drawTag()（模擬 canvas），每格取樣成位元，外框（靜區、白圈、黑圈）正確、每格顏色均勻；
//    畫面依四種角度旋轉後解碼，只有轉回正確方向時與官方的同一個 ID 完全相符，其餘方向與所有碼都相差 11 位元以上。
//    測試產生器（tests/make_test_media.mjs）畫的 tag 與場記板逐格相同。
// 3. ID 公式：場記板的 cycleK() 與測試產生器的 tagId()（ID = 本地時間午夜起秒數 mod 540）對照固定的期望值，
//    兩天內逐秒連續且兩者相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadSlate } from './lib/slate.mjs';
import * as gen from './make_test_media.mjs';

const OFFICIAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'data', 'tag36h11.json'), 'utf8'));
const CODES = OFFICIAL.codes.map(Number);          // 36 位元，在 2^53 內可以精確表示
const VIS_MOD = 540;
const NAMES = ['TAG36H11_CODES', 'TAG36H11_BIT_X', 'TAG36H11_BIT_Y'];
const official = { TAG36H11_CODES: CODES, TAG36H11_BIT_X: OFFICIAL.bitX, TAG36H11_BIT_Y: OFFICIAL.bitY };

// 36 位元整數的漢明距離（位元運算子只有 32 位元，高 4 位元另外算）。
const pop32 = v => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const hamming = (a, b) => pop32((a >>> 0) ^ (b >>> 0)) + pop32(Math.floor(a / 2 ** 32) ^ Math.floor(b / 2 ** 32));

// 12 × 12 格（1 = 白）：外圈靜區、白圈、黑圈，資料位元 i 在第 bitY[i] + 2 列、第 bitX[i] + 2 行，code 的第 35 − i 位元為 1 時白。
// 這是官方 apriltag_to_image() 的版面加一格靜區，與場記板畫的相同。
function wordOf(grid) {
  let w = 0;
  for (let i = 0; i < 36; i++) if (grid[OFFICIAL.bitY[i] + 2][OFFICIAL.bitX[i] + 2]) w += 2 ** (35 - i);
  return w;
}
function gridOf(code) {
  const g = Array.from({ length: 12 }, (_, y) => Array.from({ length: 12 }, (_, x) => (x < 2 || x > 9 || y < 2 || y > 9) ? 1 : 0));
  for (let i = 0; i < 36; i++) if (Math.floor(code / 2 ** (35 - i)) % 2) g[OFFICIAL.bitY[i] + 2][OFFICIAL.bitX[i] + 2] = 1;
  return g;
}
const rot90 = g => g.map((row, y) => row.map((_, x) => g[11 - x][y]));      // 順時針轉 90°
const rotate = (g, k) => { for (let i = 0; i < k; i++) g = rot90(g); return g; };

// 最接近的官方碼：{ id, d }。
function nearest(word) {
  let best = { id: -1, d: 99 };
  CODES.forEach((c, id) => { const d = hamming(word, c); if (d < best.d) best = { id, d }; });
  return best;
}

test('碼表：場記板與分析核心與官方 tag36h11.c 相同', async () => {
  assert.equal(CODES.length, 587);
  assert.equal(OFFICIAL.bitX.length, 36);
  const slate = loadSlate(NAMES);
  const core = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'visual.js')));
  for (const [where, tab] of [['場記板', slate], ['分析核心', core]])
    for (const n of NAMES) assert.deepEqual(Array.from(tab[n]), official[n], `${where}的 ${n} 與官方不同`);
});

test('官方碼表：任兩個碼（含旋轉後）至少相差 11 位元', () => {
  const rotated = CODES.map(c => [1, 2, 3].map(k => wordOf(rotate(gridOf(c), k))));
  let min = 99, at = null;
  for (let i = 0; i < CODES.length; i++) {
    for (const w of rotated[i]) for (let j = 0; j < CODES.length; j++) {
      const d = hamming(w, CODES[j]);
      if (d < min) { min = d; at = [i, j, 'rot']; }
    }
    for (let j = i + 1; j < CODES.length; j++) {
      const d = hamming(CODES[i], CODES[j]);
      if (d < min) { min = d; at = [i, j]; }
    }
  }
  assert.ok(min >= OFFICIAL.minHamming, `最小漢明距離 ${min}（${JSON.stringify(at)}），應至少 ${OFFICIAL.minHamming}`);
});

// 以模擬的 canvas 執行場記板的 drawTag()，回傳灰階像素（0／255）與邊長。
function slateDrawer(cell) {
  const side = 12 * cell, px = new Uint8Array(side * side);
  const vtCtx = {
    fillStyle: '#000000',
    fillRect(x, y, w, h) {
      const v = { '#ffffff': 255, '#000000': 0 }[this.fillStyle];
      assert.ok(v !== undefined, `未預期的顏色 ${this.fillStyle}`);
      assert.ok([x, y, w, h].every(Number.isInteger), `非整數像素 ${[x, y, w, h]}`);
      for (let j = y; j < y + h; j++) px.fill(v, j * side + x, j * side + x + w);
    },
  };
  const slate = loadSlate([...NAMES, 'drawTag'], { vtTag: { width: side, height: side }, vtCtx });
  return id => { px.fill(128); slate.drawTag(id); return { px, side }; };
}

// 像素依格子取樣成 12 × 12 的位元；每格必須是同一個顏色。
function sample({ px, side }, cell) {
  return Array.from({ length: 12 }, (_, cy) => Array.from({ length: 12 }, (_, cx) => {
    const v = px[cy * cell * side + cx * cell];
    for (let y = cy * cell; y < (cy + 1) * cell; y++)
      for (let x = cx * cell; x < (cx + 1) * cell; x++) assert.equal(px[y * side + x], v, `第 (${cx}, ${cy}) 格顏色不均勻`);
    assert.ok(v === 0 || v === 255, `第 (${cx}, ${cy}) 格沒有畫到`);
    return v ? 1 : 0;
  }));
}

test('繪製：場記板畫的 ID 0–539 以四種角度解碼都讀回同一個 ID', () => {
  for (const cell of [1, 4]) {
    const slateDraw = slateDrawer(cell), side = 12 * cell;
    for (let id = 0; id < VIS_MOD; id++) {
      const g = sample(slateDraw(id), cell);
      // 測試產生器畫的 tag（以 vm 執行同一個 drawTag()，再貼到手機畫面上）必須逐格相同。
      assert.deepEqual(sample({ px: gen.drawTag(id, cell), side }, cell), g, `ID ${id}：測試產生器畫的 tag 與場記板不同`);
      for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
        const ring = Math.min(x, y, 11 - x, 11 - y);
        if (ring < 3) assert.equal(g[y][x], ring < 2 ? 1 : 0, `ID ${id}：外框第 ${ring} 圈 (${x}, ${y}) 顏色錯`);
      }
      // 攝影機可能以任何方向拍到：畫面轉 k 個 90° 後，只有再轉回 (4 − k) 個 90° 時是官方的這個 ID。
      for (let k = 0; k < 4; k++) {
        const seen = rotate(g, k);
        for (let back = 0; back < 4; back++) {
          const hit = nearest(wordOf(rotate(seen, back)));
          if ((k + back) % 4 === 0) assert.deepEqual(hit, { id, d: 0 }, `ID ${id}（每格 ${cell} 像素，轉 ${k * 90}°）讀成 ${JSON.stringify(hit)}`);
          else assert.ok(hit.d >= OFFICIAL.minHamming, `ID ${id} 轉 ${k * 90}° 後再轉 ${back * 90}°：與 ID ${hit.id} 只差 ${hit.d} 位元`);
        }
      }
    }
  }
});

test('ID 公式：場記板的 cycleK() 為本地時間午夜起秒數 mod 540', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const slate = loadSlate(['cycleK']), day = Date.UTC(2026, 10, 12);
    const cases = [['10:24:37', 217], ['10:26:59', 359], ['10:27:00', 360], ['10:30:00', 0], ['10:59:59', 179], ['11:00:00', 180],
      ['23:59:59', 539], ['00:00:00', 0], ['00:08:59', 539], ['00:09:00', 0]];
    for (const [clock, want] of cases) {
      const [h, m, s] = clock.split(':').map(Number), ms = day + (h * 3600 + m * 60 + s) * 1000;
      assert.equal(slate.cycleK(ms), want, clock);
      assert.equal(slate.cycleK(ms + 999), want, clock + '.999');
      assert.equal(gen.tagId(h * 3600 + m * 60 + s + 0.999), want, `測試產生器 ${clock}.999`);
      assert.equal(gen.tagId(86400 + h * 3600 + m * 60 + s), want, `測試產生器 隔天 ${clock}`);
      assert.equal(want % 60, s, `${clock}：ID 的個位秒`);
      assert.equal(Math.floor(want / 60), (h * 60 + m) % 9, `${clock}：ID 的分鐘位置`);
    }
    let prev = slate.cycleK(day);
    for (let i = 1; i < 2 * 86400; i++) {                 // 兩天內逐秒連續，跨整點與午夜
      const k = slate.cycleK(day + i * 1000);
      if ((k - prev + VIS_MOD) % VIS_MOD !== 1) assert.fail(`第 ${i} 秒：${prev} → ${k} 不連續`);
      if (gen.tagId(i) !== k) assert.fail(`第 ${i} 秒：測試產生器 ${gen.tagId(i)}，場記板 ${k}`);
      prev = k;
    }
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
