// main.js — 網頁分析器的介面：選檔、進度、結果卡片、對齊表與時間換算；分析本身在 src/core/，讀檔在 media.js、video.js。
import { analyze } from '../core/analyze.js';
import { LANGS, translator } from '../core/i18n.js';
import { avRefDiff, convertT, createReport, driftBad, endClock, fitKey, isSingle, offText, relRows, sgn } from '../core/report.js';
import { SOUND, VIS_MOD } from '../core/visual.js';
import { openMedia, readWindow } from './media.js';
import { VideoReader } from './video.js';

const $ = id => document.getElementById(id);

// ---- i18n: every page uses the same detection; the choice is shared through localStorage ----
function pickLang() {
  try { var s = localStorage.getItem('slate-lang'); if (LANGS.indexOf(s) >= 0) return s; } catch (e) {}
  var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  for (var i = 0; i < list.length; i++) {
    var l = String(list[i]).toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh-Hant';
    if (l.indexOf('ja') === 0) return 'ja';
    if (l.indexOf('ko') === 0) return 'ko';
    if (l.indexOf('en') === 0) return 'en';
  }
  return 'en';
}
let lang = pickLang(), tr = translator(lang);
const t = (key, vars) => tr(key, vars);
const { fmtClock, errText, kindOf, chanText, hintNote, floorNote, visText, avOffText, avRefText, textReport } = createReport(t);
function applyI18n() {
  document.documentElement.lang = lang;
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-attr]'))
    for (const pair of el.dataset.i18nAttr.split(';')) { const [attr, key] = pair.split(':'); el.setAttribute(attr.trim(), t(key.trim())); }
}
function initLangMenu() {
  const sel = $('lang');
  let saved = null;
  try { saved = localStorage.getItem('slate-lang'); } catch (e) {}
  sel.value = LANGS.indexOf(saved) >= 0 ? saved : '';
  sel.addEventListener('change', () => {
    try { if (sel.value) localStorage.setItem('slate-lang', sel.value); else localStorage.removeItem('slate-lang'); } catch (e) {}
    lang = sel.value || pickLang();
    tr = translator(lang);
    applyI18n();
    rerender();
  });
}


// =========================================================== UI
let results = [];
window.__results = results;

function avRows(r) {
  const rows = [];
  if (r.visualReadS !== undefined) rows.push([t('card.vis'), visText(r)]);
  if (r.avError) rows.push([t('card.avErr'), '✗ ' + esc(errText(r.avError))]);
  if (!r.avOffsetMs) return rows;
  rows.push([t('card.avOff'), t('card.avOffV', { parts: avOffText(r) })]);
  if (r.avJitterMs !== null) rows.push([t('card.avJit'), t('card.avJitV', { ms: r.avJitterMs.toFixed(3) })]);
  if (r.avDriftPpm !== null) {
    const v = t('card.avDriftV', { ppm: sgn(r.avDriftPpm, 1), unc: r.avDriftUncPpm.toFixed(1) });
    rows.push([t('card.avDrift'), driftBad(r) ? `<span class="bad">⚠ ${v}</span>` : v]);
  }
  rows.push([t('card.avEdges'), t('card.avEdgesV', { v: r.visualEdges, a: r.audioEdges })]);
  if (r.avDistance) rows.push([t('card.avDist'), t('card.avDistV', { ms: (r.avDistance / SOUND * 1000).toFixed(3), m: r.avDistance })]);
  const d = avRefDiff(r, results, $('avRefSel').value);
  if (d) rows.push([t('card.avRef'), esc(avRefText(d))]);
  return rows;
}

function cardHtml(r) {
  if (r.error) return `<h2 class="name">${esc(r.file)}</h2><p class="err">✗ ${esc(errText(r.error))}</p>`;
  const kind = kindOf(r), video = r.source === 'video';
  const rows = [
    ...(r.source ? [[t('card.source'), t('src.' + r.source)]] : []),
    [t('card.start', { kind }), fmtClock(r.startClock, r.clockMod) + hintNote(r)],
    ...(r.fps ? [[t('card.fps'), `${r.fps.toFixed(6)} → ${(r.fps * r.rate).toFixed(6)} fps`]] : []),
    [t('card.mode'), t('mode.' + r.mode)],
    [t('card.drift'), t('card.driftV', { ppm: sgn(r.ppm, 3), unc: r.uncPpm.toFixed(3) })],
    [t('card.err'), t('card.errV', { ms: r.worstMs.toFixed(3), seg: r.segments ? t('card.afterSeg') : '' }) + floorNote(r)],
    ...(r.segments ? r.segments.map((g, i) => [t('card.seg', { i: i + 1 }),
      t('card.segV', { a: g.fileFrom.toFixed(3), b: g.fileTo.toFixed(3), v: (g.speed * 100).toFixed(6) })]) : []),
    ...(!r.segments && r.midDevMs !== null ? [[t('card.mid'), t('card.midV', { ms: r.midDevMs.toFixed(3) })]] : []),
    [t('card.end', { kind }), fmtClock(endClock(r), r.clockMod)],
    [t('card.fit'), t(fitKey(r) ? 'card.fit' + fitKey(r) : 'card.fitV', { n: r.edgesUsed, ms: r.fitRmsMs.toFixed(3) }) + (r.edgesRejected ? t('card.rejected', { n: r.edgesRejected }) : '') +
      (r.pitchRejected ? t('card.pitchRej', { n: r.pitchRejected }) : '')],
    ...(video ? [] : r.ltc ? [[t('card.ltc'), t('card.ltcV', { fps: r.ltc.label, ch: chanText(r) })]] : [[t('card.chan'), chanText(r)]]),
    [t('card.offs'), t('card.offsA', { a: sgn(r.aOff, 6) }) + (r.vOff !== null ? t('card.offsV', { v: sgn(r.vOff, 6) }) : '')],
    ...avRows(r),
  ];
  const warns = [], notes = [];
  if (r.hwFallback) warns.push(t('warn.hwFallback', { why: esc(r.hwFallback) }));
  if (r.avOffsetMs && r.avDriftPpm !== null && driftBad(r)) warns.push(t('warn.avDrift', { ppm: sgn(r.avDriftPpm, 1), unc: r.avDriftUncPpm.toFixed(1) }));
  if (r.mod === VIS_MOD) notes.push(t(video ? 'note.vis540' : 'note.pitch540'));
  if (r.avOffsetMs) notes.push(t('av.note'));

  if (r.segments) warns.push(t('warn.seg', { ms: r.midDevMs.toFixed(1) }));
  if (isSingle(r)) warns.push(t('warn.single'));
  if (r.ambiguous) warns.push(t('warn.amb'));
  if (r.ltc && r.ltc.rateGuess) warns.push(t('warn.ltcRate'));
  return `<h2 class="name">${esc(r.file)}</h2>
    <div class="headline">
      <div><div class="k">${t('card.rate')}</div><div class="v num">${(r.rate * 100).toFixed(6)} %</div>
        <div class="meta">${t('card.rateNote')}</div></div>
      <div><div class="k">${t('card.len')}</div><div class="v num">${t('sec', { v: r.correctedLength.toFixed(6) })}</div>
        <div class="meta">${t('card.orig', { kind, len: r.length.toFixed(6), frames: r.frames ? t('card.frames', { n: r.frames }) : '' })}</div></div>
    </div>
    <dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>
    ${warns.map(w => `<p class="warn">⚠ ${w}</p>`).join('')}${notes.map(n => `<p class="note">${n}</p>`).join('')}`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


const refName = () => $('refSel').value;
function renderRel() {
  const rel = relRows(results, refName());
  $('relSec').hidden = !rel;
  if (rel) {
    $('relTable').innerHTML = `<tr><th>${t('th.file')}</th><th style="text-align:right">${t('th.start')}</th><th style="text-align:right">${t('th.speed')}</th><th style="text-align:right">${t('th.len')}</th></tr>` +
      rel.rows.map(x => `<tr><td>${esc(x.file)}${x.r === rel.ref ? t('refMark') : ''}</td><td class="n num">${offText(x.offset)}</td><td class="n num">${(x.speed * 100).toFixed(6)} %</td><td class="n num">${x.length.toFixed(6)}</td></tr>`).join('');
    $('relNote').textContent = (!isFinite(rel.M) || rel.M % 3600 === 0 ? '' : t({ [VIS_MOD]: 'rel.note540', 180: 'rel.note180' }[rel.M] || 'rel.note60')) +
      (rel.unmatched ? t('rel.noteLtc') : '');
    const cur = $('convSrc').value;
    $('convSrc').innerHTML = rel.ok.map(r => `<option${r.file === cur ? ' selected' : ''}>${esc(r.file)}</option>`).join('');
    renderConv();
  }
  $('txtSec').hidden = !results.length;
  $('report').value = textReport(results, { ref: refName(), avRef: $('avRefSel').value });
}
function renderConv() {
  const rel = relRows(results, refName());
  if (!rel) return;
  const src = rel.ok.find(r => r.file === $('convSrc').value) || rel.ok[0], v = parseFloat($('convT').value);
  if (!isFinite(v)) { $('convTable').innerHTML = `<tr><td class="err">${t('conv.need')}</td></tr>`; return; }
  $('convTable').innerHTML = `<tr><th>${t('th.file')}</th><th style="text-align:right">${t('th.same')}</th></tr>` +
    rel.ok.filter(r => r !== src).map(r => `<tr><td>${esc(r.file)}${r === rel.ref ? t('refMark') : ''}</td><td class="n num">${(d => d === null ? '—' : d.toFixed(6))(convertT(src, v, r))}</td></tr>`).join('');
}
$('convSrc').addEventListener('change', renderConv);
$('convT').addEventListener('input', renderConv);

function renderRefSel() {
  const ok = results.filter(r => !r.error), cur = $('refSel').value;
  $('refSel').innerHTML = ok.map(r => `<option${r.file === cur ? ' selected' : ''}>${esc(r.file)}</option>`).join('');
  renderAvRefSel();
}
$('refSel').addEventListener('change', renderRel);
// A/V reference menu: files with a measured A/V offset; the first entry compares nothing.
function renderAvRefSel() {
  const av = results.filter(r => !r.error && r.avOffsetMs), cur = $('avRefSel').value;
  $('avRefRow').hidden = !av.length;
  $('avRefSel').innerHTML = `<option value="">${t('opt.avRefNone')}</option>` +
    av.map(r => `<option value="${esc(r.file)}"${r.file === cur ? ' selected' : ''}>${esc(r.file)}</option>`).join('');
}
$('avRefSel').addEventListener('change', rerender);

// Re-render everything built from results in the current language (the aria-live text is left alone so a
// language switch is not announced as a new analysis).
function rerender() {
  for (const card of $('results').children) {
    if (card.result) card.innerHTML = cardHtml(card.result);
    else { const p = card.querySelector('.progress'); if (p) p.textContent = progressText(card.steps); }
  }
  if (results.length) { renderAvRefSel(); renderRel(); }
}
const progressText = n => n ? t('prog.n', { n }) : t('prog.start');

let busy = Promise.resolve();
function addFiles(list) {
  const files = Array.from(list);
  if (!files.length) return;
  if (typeof AudioDecoder === 'undefined' && files.some(f => !/\.wav$/i.test(f.name)))
    alert(t('alert.webcodecs'));
  busy = busy.then(async () => {
    let bad = 0;
    $('live').textContent = t('live.start', { n: files.length });
    const dist = parseFloat($('optDist').value);
    const opts = { only: $('optOnly').value || null, probe: $('optFull').checked ? 3 : 0, minute: $('optMinute').checked,
      av: $('optAv').checked, distance: isFinite(dist) && dist > 0 ? dist : 0 };
    for (const f of files) {
      const card = document.createElement('div');
      card.className = 'card';
      card.steps = 0;
      card.innerHTML = `<h2 class="name">${esc(f.name)}</h2><p class="progress">${progressText(0)}</p>`;
      $('results').appendChild(card);
      const tick = () => { card.querySelector('.progress') && (card.querySelector('.progress').textContent = progressText(++card.steps)); };
      let r;
      try {
        const m = await openMedia(f);
        Object.assign(m, { name: f.name, modified: f.lastModified, readWindow: (a, b) => readWindow(m, a, b), openVideo: () => VideoReader.open(m) });
        r = await analyze(m, opts, tick);
      }
      catch (e) { r = { file: f.name, error: (e && e.i18n) || { raw: (e && e.message) || String(e) } }; }
      results.push(r);
      if (r.error) bad++;
      card.result = r;
      card.innerHTML = cardHtml(r);
      renderRefSel(); renderRel();
    }
    $('live').textContent = t('live.done', { n: files.length }) + (bad ? t('live.bad', { n: bad }) : '');
    window.__done = (window.__done || 0) + files.length;
  });
}

initLangMenu();
applyI18n();
$('pickBtn').addEventListener('click', () => $('pick').click());
$('pick').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
