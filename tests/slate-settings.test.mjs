// slate-settings.test.mjs — 場記板設定頁（docs/slate-ui.md「設定頁」）：範本的分組與卡片、選項數與控制項形式、
// 選取樣式只有一種，以及「說明只講目前選中的選項」與 DF／NDF 只在 29.97 系列可選（src/web/slate-mode.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as m from '../src/web/slate-mode.js';
import { ROOT } from './lib/root.mjs';

const HTML = fs.readFileSync(path.join(ROOT, 'src', 'web', 'sync-slate.html'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'slate.js'), 'utf8');
const PAGE = HTML.slice(HTML.indexOf('<div class="page-body">'), HTML.indexOf('<div class="sheet-wrap" id="schedWrap"'));
const sections = PAGE.split('<section class="grp">').slice(1).map(s => s.slice(0, s.indexOf('</section>')));
const ZH = JS.slice(JS.indexOf("'zh-Hant': {"), JS.indexOf('\n  en: {'));

test('分組與順序：數字模式、LTC、倒數、校準、外觀、其他；每組的卡片', () => {
  const groups = sections.map(s => s.match(/<h3 data-i18n="(\w+)">/)[1]);
  assert.deepEqual(groups, ['grpDigit', 'grpLtc', 'grpCd', 'grpCal', 'grpLook', 'grpOther']);
  const cards = sections.map(s => [...s.matchAll(/<div class="item-k" data-i18n="(\w+)">/g)].map(x => x[1]));
  assert.deepEqual(cards, [['soundK', 'syncK'], ['fpsK', 'dfK'], ['customK'], ['ofsVideo', 'ofsAudio'], ['paletteK', 'langK'],
    ['analyzerK', 'resetK']]);
});

test('排版規則 1：每個設定是一張卡片（標題、一行說明、控制項），區段標題下不放說明', () => {
  for (const s of sections) {
    const body = s.slice(s.indexOf('</h3>') + 5).trim();
    assert.ok(body.startsWith('<div class="item">'), '區段標題後直接是卡片：' + body.slice(0, 60));
    for (const card of body.split('<div class="item">').slice(1)) {
      assert.match(card, /^\s*<div class="item-k"/, '卡片先放標題');
      assert.equal((card.match(/<p class="item-d"[^>]*>/g) || []).filter(p => !p.includes(' num')).length, 1, '一行說明');
    }
  }
});

test('排版規則 2：選取只有白底黑字一種樣式，黃色不用於選取（主畫面的倒數長度與靜音鈕除外）', () => {
  assert.match(HTML, /\.seg button\[aria-pressed="true"\] \{ background: var\(--ink\); color: var\(--ground\); \}/);
  assert.match(HTML, /button\[aria-pressed="true"\]\.sel \{ background: var\(--ink\); border-color: var\(--ink\); color: var\(--ground\); \}/);
  // 去掉註解與 @media 的外層再逐條解析（否則 @media 裡的第一條規則會連同 @media 一起被當成選擇器）。
  const css = HTML.slice(HTML.indexOf('<style>') + 7, HTML.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media[^{]*\{/g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => [sel.trim(), body]);
  // 設定頁與排程對話框的選擇器：選取狀態與排程的指定時間。
  const SETTINGS = /\.page|\.seg|\.sel|\.lang-grid|\.fps-grid|\.time-field/;
  const chosen = rules.filter(([sel]) => sel.split(',').some(s => SETTINGS.test(s) && /\[aria-pressed="true"\]|\.on\b/.test(s)));
  assert.ok(chosen.length >= 3, `只找到 ${chosen.length} 條選取規則`);
  for (const [sel, body] of chosen) assert.ok(!body.includes('--mark'), `${sel} 用了 --mark`);
  assert.ok(chosen.some(([sel]) => sel.includes('.time-field input.on')), '有檢查到排程的指定時間');
});

test('排版規則 3：4 個以內用分段按鈕，超過 4 個用格狀（「自動」在同一個格子裡）', () => {
  const segs = [...PAGE.matchAll(/<div class="seg"[^>]*id="(\w+)"[^>]*>([\s\S]*?)<\/div>/g)];
  assert.ok(segs.length >= 4);
  for (const [, id, inner] of segs) assert.ok((inner.match(/<button/g) || []).length <= 4, id);
  const lang = PAGE.match(/<div class="lang-grid"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.equal((lang.match(/<button/g) || []).length, 5);
  assert.ok(!/lang-grid button:first-child/.test(HTML), '「自動」不另占一行');
  assert.match(PAGE, /<div class="fps-grid" id="fpsGrid"/);
  assert.equal(m.FPS_LIST.length, 12);
});

test('排版規則 4：說明只講目前選中的選項，每個 key 都有定義', () => {
  const pick = (over, pref = 'auto') => m.descKeys({ ...m.defaultState(), ...over }, pref);
  assert.deepEqual(pick({}), { sound: 'sndDBeep', sync: 'syncDSquare', df: 'dfD', palette: 'palDDefault', lang: 'langDAuto' });
  assert.deepEqual(pick({ sound: 'wave', flashStyle: 'flash', df: false, palette: 'red' }, 'ja'),
    { sound: 'sndDWave', sync: 'syncDFlash', df: 'ndfD', palette: 'palDRed', lang: 'langDFixed' });
  assert.equal(pick({ palette: 'white' }).palette, 'palDWhite');
  assert.equal(pick({ palette: 'light' }).palette, 'palDLight');
  const keys = new Set();
  for (const sound of ['beep', 'wave']) for (const flashStyle of ['square', 'flash']) for (const fps of m.FPS_LIST)
    for (const df of [true, false]) for (const palette of ['default', 'white', 'red', 'light']) for (const pref of ['auto', 'en'])
      Object.values(pick({ sound, flashStyle, fps, df, palette }, pref)).forEach(k => keys.add(k));
  for (const k of keys) assert.match(ZH, new RegExp(`\\b${k}: '`), k);
  assert.equal(keys.size, 13);
  // 每個依選項改寫的說明（id 以 D 結尾的 <p>）都由頁面程式更新：用 descKeys() 或在 renderLtc() 直接寫入。
  const ids = [...PAGE.matchAll(/<p class="item-d" id="(\w+D)"/g)].map(x => x[1]);
  assert.deepEqual(ids.sort(), ['dfD', 'fpsD', 'langD', 'paletteD', 'soundD', 'syncD']);
  for (const id of ids)
    assert.match(JS, new RegExp(`setKey\\(\\$\\('${id}'\\), descKeys\\(|\\$\\('${id}'\\)\\.textContent = `), `${id} 沒有被更新`);
});

test('DF／NDF 只在 29.97 系列可選', () => {
  assert.deepEqual(m.FPS_LIST.filter(m.dfSelectable), [29.97, 59.94, 119.88]);
  for (const fps of m.FPS_LIST) if (!m.dfSelectable(fps)) assert.equal(m.descKeys({ ...m.defaultState(), fps }).df, 'dfNa', String(fps));
});
