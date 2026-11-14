// slate-mode.test.mjs — 場記板的五種模式（docs/slate-ui.md「模式」「主畫面控制列」）：src/web/slate-mode.js 的規則
// 對照規格表的固定期望值；另檢查頁面範本的按鈕順序、頂列順序，以及每種模式的提示文字都有定義。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as m from '../src/web/slate-mode.js';
import { ROOT } from './lib/root.mjs';

const HTML = fs.readFileSync(path.join(ROOT, 'src', 'web', 'sync-slate.html'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'slate.js'), 'utf8');
const st = over => ({ ...m.defaultState(), ...over });

test('模式的順序：時鐘、正數、倒數、Tag、LTC（程式與頁面按鈕相同）', () => {
  assert.deepEqual(m.MODES, ['clock', 'up', 'cd', 'tag', 'ltc']);
  const ids = [...HTML.matchAll(/<button id="m(Clock|Up|Cd|Tag|Ltc)"/g)].map(x => x[1]);
  assert.deepEqual(ids, ['Clock', 'Up', 'Cd', 'Tag', 'Ltc']);
  assert.ok(!/id="fpsBtn"|id="audSeg"/.test(HTML), '主畫面不放影格率與音訊切換');
});

test('頂列：SCENE 欄位、靜音、設定；靜音鈕有 aria-pressed，樣式與設定鈕相同', () => {
  const top = HTML.slice(HTML.indexOf('<header class="top">'), HTML.indexOf('</header>'));
  const order = ['id="tag"', 'id="muteBtn"', 'id="settingsBtn"'].map(s => top.indexOf(s));
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], `順序 ${order}`);
  assert.match(top, /<button class="icon-btn mute" id="muteBtn" aria-pressed="false"/);
});

test('聲音：數字模式依設定，Tag 為波形碼，LTC 為 LTC；靜音對五種模式都有效', () => {
  const want = { clock: ['beep', 'wave'], up: ['beep', 'wave'], cd: ['beep', 'wave'], tag: ['wave', 'wave'], ltc: ['ltc', 'ltc'] };
  for (const mode of m.MODES) {
    assert.equal(m.audioKind(st({ mode, sound: 'beep' })), want[mode][0], mode + ' 嗶聲');
    assert.equal(m.audioKind(st({ mode, sound: 'wave' })), want[mode][1], mode + ' 波形碼');
    for (const sound of ['beep', 'wave']) assert.equal(m.audioKind(st({ mode, sound, muted: true })), 'off', mode + ' 靜音');
  }
});

test('畫面：數字模式的大字與同步訊號；Tag 與 LTC 是 AprilTag 加外框帶，跟著手機時鐘', () => {
  for (const flashStyle of ['square', 'flash']) {
    assert.deepEqual(m.screenOf(st({ mode: 'clock', flashStyle })), { tag: false, sync: flashStyle, digits: 'clock', line: null });
    assert.deepEqual(m.screenOf(st({ mode: 'up', flashStyle })), { tag: false, sync: flashStyle, digits: 'elapsed', line: null });
    assert.deepEqual(m.screenOf(st({ mode: 'cd', flashStyle })), { tag: false, sync: flashStyle, digits: 'remaining', line: null });
    assert.deepEqual(m.screenOf(st({ mode: 'tag', flashStyle })), { tag: true, sync: 'band', digits: 'clock', line: null });
    assert.deepEqual(m.screenOf(st({ mode: 'ltc', flashStyle })), { tag: true, sync: 'band', digits: null, line: 'ltc' });
  }
  // 靜音只關聲音，畫面不變。
  for (const mode of m.MODES) assert.deepEqual(m.screenOf(st({ mode, muted: true })), m.screenOf(st({ mode })), mode);
});

test('第二列：倒數有長度與排程，正數有排程，時鐘、Tag、LTC 沒有', () => {
  assert.deepEqual(m.MODES.map(m.secondRow), [null, 'up', 'cd', null, null]);
  assert.deepEqual(m.MODES.map(m.isCount), [false, true, true, false, false]);
  assert.deepEqual(m.MODES.map(m.isCode), [false, false, false, true, true]);
});

test('進行中（計時或等待排程）只有目前的模式可按，其他四個鎖住', () => {
  for (const cur of ['up', 'cd'])
    assert.deepEqual(m.MODES.map(x => m.modeLocked(x, cur, true)), m.MODES.map(x => x !== cur), cur);
  for (const cur of m.MODES) assert.ok(m.MODES.every(x => !m.modeLocked(x, cur, false)), cur + ' 閒置時都可按');
});

test('提示：每種模式一句，四種語言都有（key 一致由 check_web.js 檢查）', () => {
  const zh = JS.slice(JS.indexOf("'zh-Hant': {"), JS.indexOf('\n  en: {'));
  for (const mode of m.MODES) assert.match(zh, new RegExp(`\\b${m.hintKey(mode)}: '`), mode);
  assert.equal(m.hintKey('tag'), 'hintTag');
});

test('讀回存下的設定：不認得的值退回預設，不轉換舊格式', () => {
  assert.deepEqual(m.readState(null), m.defaultState());
  assert.deepEqual(m.readState('x'), m.defaultState());
  assert.deepEqual(m.readState({}), m.defaultState());
  // 1.1.0 存下的值：beep／wave／ltc 旗標與 flashStyle 'tag' 都不認得，其餘照用。
  const old = { fps: 29.97, beep: false, mode: 'cd', dur: 300, custom: 90, ltc: true, df: false, dispOfs: 12, audOfs: -8,
    wave: true, flashStyle: 'tag', palette: 'red' };
  assert.deepEqual(m.readState(old), { ...m.defaultState(), fps: 29.97, mode: 'cd', dur: 300, custom: 90, df: false, dispOfs: 12,
    audOfs: -8, palette: 'red' });
  const bad = { fps: 31, mode: 'atag', sound: 'ltc', muted: 'yes', flashStyle: 'tag', palette: 'blue', dispOfs: 900, dur: 7 };
  assert.deepEqual(m.readState(bad), m.defaultState());
  for (const mode of m.MODES) assert.equal(m.readState({ mode }).mode, mode);
  assert.deepEqual(m.readState({ sound: 'wave', muted: true, flashStyle: 'flash' }), { ...m.defaultState(), sound: 'wave', muted: true, flashStyle: 'flash' });
  assert.equal(m.readState({ custom: 90, dur: 90 }).dur, 90, '自訂長度');
});
