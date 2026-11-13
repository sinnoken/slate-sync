// report.js — 結果的文字呈現與跨檔案比對：起點時鐘、文字報告的組字、對齊到基準檔與時間換算（網頁與命令列共用）。
import { gcd, mod, wrap } from './util.js';
import { SOUND, VIS_MOD } from './visual.js';

export const sgn = (v, d) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
export const isSingle = r => r.mode === 'head' || r.mode === 'tail';
// 23.976 / 29.97 NDF LTC: the clock is time code, which runs 0.1 % slower than real time.
export const endClock = r => r.startClock + r.correctedLength * (r.ltc ? r.ltc.tcScale : 1);
export const fitKey = r => ({ video: 'Vis', ltc: 'Ltc' }[r.source] || '');
export const driftBad = r => Math.abs(r.avDriftPpm) > 3 * r.avDriftUncPpm;
// Offset relative to the A/V reference file chosen in the menu. Only ends measured in both files are compared (the
// head of one file is never set against the tail of another); null when there is no such end.
export function avRefDiff(r, results, avRef) {
  const ref = results.find(x => !x.error && x.avOffsetMs && x.file === avRef);
  if (!ref || ref === r || !r.avOffsetMs) return null;
  const o = r.avOffsetMs, ro = ref.avOffsetMs, d = { ref: ref.file };
  for (const k of ['head', 'tail']) d[k] = o[k] && ro[k] ? o[k].mean - ro[k].mean : null;
  return d.head === null && d.tail === null ? null : d;
}
// [[M, start label mod M]]: the cycles a file's start is known in (docs/start-time.md). The visual code read by the
// A/V sync check adds the 9-minute cycle to a waveform result that only knows the seconds or the minute marker.
// A start clock set from the file's own clock (and allowed for matching, clockMatch) is known over the whole day: two
// such files are simply subtracted.
// LTC time code that is not real time (23.976, 29.97 NDF) is matched only with the same kind ([M, label, kind]).
// The creation-time clock is marked ([86400, clock, undefined, true]): it can be off by whole cycles (clockCheck).
export const cycles = r => r.ltc && r.ltc.tcScale !== 1 ? [[86400, r.startLabel, r.ltc.label]] :
  [[r.mod, r.startLabel]].concat(r.label540 !== undefined && r.mod % VIS_MOD ? [[VIS_MOD, r.label540]] : [],
    r.clockType && r.clockMatch ? [[86400, r.startClock, undefined, true]] : []);
// [M, label of a, label of b, from a creation-time clock]: the longest cycle both files know, the gcd of their cycle
// lengths; null when none. clock = false leaves out the creation-time clocks.
export function pairCycle(a, b, clock = true) {
  let best = null;
  for (const [ma, la, ka, ca] of cycles(a)) for (const [mb, lb, kb, cb] of cycles(b)) {
    if (!clock && (ca || cb)) continue;
    const g = gcd(ma, mb);
    if (ka === kb && (!best || g > best[0])) best = [g, la, lb, !!(ca || cb)];
  }
  return best;
}
// The creation time is checked only within the file's cycle M, so a device clock or time zone off by a whole number of
// cycles (3, 6, 9 or 12 hours with M = 540) still passes. When the difference from the clocks lies outside what the
// cycles alone can match (|d| > M/2, M the gcd of the two files' cycles), the difference within the cycle is given too:
// { alt: real seconds from b's start to a's start, wrapped to ±M/2, M }; null otherwise.
export function clockCheck(a, b) {
  const pc = pairCycle(a, b), pc0 = pc && pc[3] ? pairCycle(a, b, false) : null;
  if (!pc0 || Math.abs(wrap(pc[1] - pc[2], pc[0])) <= pc0[0] / 2) return null;
  return { alt: wrap(pc0[1] - pc0[2], pc0[0]), M: pc0[0] };
}
// Real seconds from b's start to a's start, matched modulo the cycle both know (null when they cannot be matched).
export const startDiff = (a, b) => {
  const pc = pairCycle(a, b);
  return pc ? wrap(pc[1] - pc[2], pc[0]) / (a.ltc ? a.ltc.tcScale : 1) : null;
};
// Every file on the reference file's own timeline: real(t) = start + t / rate;  t_ref = (real - start_ref) * rate_ref.
// Each file is matched to the reference modulo the gcd of their cycle lengths: 10800 s (minute marker + pitch),
// 3600 s (minute markers), 540 s (pitch or visual code), 180 s (both kinds mixed) or 60 s. M: the shortest of them.
export function relRows(results, refName) {
  const ok = results.filter(r => !r.error);
  if (ok.length < 2) return null;
  const ref = ok.find(r => r.file === refName) || ok[0];
  const pcs = ok.filter(r => r !== ref).map(r => pairCycle(r, ref)), M = Math.min(...pcs.filter(Boolean).map(p => p[0]));
  return { ref, M, ok, unmatched: pcs.some(p => !p), rows: ok.map(r => { const d = startDiff(r, ref), ck = r === ref ? null : clockCheck(r, ref);
    return { file: r.file, r, offset: d === null ? null : d * ref.rate, alt: ck ? ck.alt * ref.rate : null,
      speed: r.rate / ref.rate, length: r.length * ref.rate / r.rate }; }) };
}
// Time t (s, from src's first frame) -> the same moment on dst's own timeline; null when they cannot be matched.
export function convertT(src, t, dst) { const d = startDiff(src, dst); return d === null ? null : (d + t / src.rate) * dst.rate; }
export const offText = v => v === null ? '—' : sgn(v, 6);
// The note on how far apart the files may start, for the cycle M the alignment used (docs/start-time.md); none for
// 3600 (±30 minutes, the minute markers alone) or when nothing could be matched.
export const relNoteKey = M => ({ 60: 'rel.note60', 180: 'rel.note180', [VIS_MOD]: 'rel.note540', 10800: 'rel.note10800', 86400: 'rel.note86400' }[M] || null);

// The parts that need words, for the translator t of one language (i18n.js translator()).
export function createReport(t) {
  const fmtClock = (sec, m) => {
    sec = mod(Math.round(sec * 1000) / 1000, m);   // round first, so 59.9996 s shows as the next minute, not :60.000
    const h = Math.floor(sec / 3600), mi = Math.floor(sec % 3600 / 60), s = sec % 60;
    const p2 = v => String(v).padStart(2, '0'), ss = s.toFixed(3).padStart(6, '0');
    if (m === 60) return `??:??:${ss}`;
    if (m === 3600) return `??:${p2(mi)}:${ss}`;
    if (m === VIS_MOD) return `??:??:${ss}` + t('clock.vis', { m: mi });
    if (m === 10800) return `??:${p2(mi)}:${ss}` + t('clock.c3h', { h });
    return `${p2(h)}:${p2(mi)}:${ss}`;
  };
  const errText = e => e.key ? t(e.key, e.vars && e.vars.why ? { ...e.vars, why: t(e.vars.why, e.vars) } : e.vars) : e.raw;
  const kindOf = r => t('kind.' + r.kind);
  const chanText = r => r.channel[0] === r.channel[1] ? t('card.chan1', { n: r.channel[0] + 1 }) : t('card.chan2', { a: r.channel[0] + 1, b: r.channel[1] + 1 });
  // After the start clock: where its hour came from, or why the file's creation time was not used.
  function hintNote(r) {
    if (r.ltc && r.ltc.tcScale !== 1) return t('clock.ltcTc');
    // start / end, and whether C was read as local time written as UTC (createdClock)
    const typeText = (type, local) => t('ctype.' + type) + (local ? t('czone.local') : '');
    if (r.clockSrc && r.clockType)
      return t('clockNote', { src: t('hint.' + r.clockSrc), type: typeText(r.clockType, r.clockZone === 'local' && r.clockSrc === 'created'), r: sgn(r.clockR, 3) }) +
        (r.clockMatch ? '' : t('clockShowOnly'));
    const bad = r.clockBad ? t(r.clockBadWhy === 'ambiguous' ? 'clockAmbig' : 'clockBad', { src: t('hint.' + r.clockSrc),
      rs: Object.keys(r.clockBad).map(k => t('clockR', { type: typeText(k.replace('Local', ''), k.endsWith('Local')), r: sgn(r.clockBad[k], 3) })).join(t('av.sep')) }) : '';
    return bad + (r.hintSrc ? t('hintNote', { src: t('hint.' + r.hintSrc) }) : '');
  }

  // ---- visual code / A/V sync check parts of a result (present only when the video track was decoded)
  const floorNote = r => r.visFloorMs ? t('card.floor', { ms: r.visFloorMs.toFixed(3) }) : '';
  // 'hardware' / 'software' (the page), or the name of ffmpeg's hardware decoder (the command line: cuda, d3d11va).
  const decText = r => (r.videoDecoder || '').split('+').filter(Boolean)
    .map(d => d === 'hardware' || d === 'software' ? t('dec.' + d) : t('dec.hwName', { name: d })).join(t('dec.sep'));
  const visText = r => t('card.visV', { s: r.visualReadS.toFixed(1), mb: r.visualReadMb.toFixed(1), n: r.visualEdges, dec: decText(r) });
  const avOffText = r => ['head', 'tail'].filter(k => r.avOffsetMs[k]).map(k => { const o = r.avOffsetMs[k];
    return t('av.part', { end: t('av.' + k), ms: sgn(o.mean, 3), half: o.half.toFixed(3), n: o.pairs }); }).join(t('av.sep'));
  const avRefText = d => t('card.avRefV', { ref: d.ref,
    parts: ['head', 'tail'].filter(k => d[k] !== null).map(k => t('avRef.part', { end: t('av.' + k), ms: sgn(d[k], 3) })).join(t('av.sep')) });
  // The rep.* strings are whole lines: each language pads its own labels so the colons line up in a monospace font.
  function textReport(results, { ref = null, avRef = null } = {}) {
    const L = [];
    for (const r of results) {
      L.push('='.repeat(64), r.file);
      if (r.error) { L.push(`  ✗ ${errText(r.error)}`); continue; }
      const kind = kindOf(r);
      L.push(t('rep.rate', { v: (r.rate * 100).toFixed(6) }));
      L.push(t('rep.len', { v: r.correctedLength.toFixed(6), kind, len: r.length.toFixed(6), frames: r.frames ? t('rep.frames', { n: r.frames }) : '' }));
      L.push(t('rep.start', { kind, clock: fmtClock(r.startClock, r.clockMod), hint: hintNote(r) }));
      L.push(t('rep.end', { kind, clock: fmtClock(endClock(r), r.clockMod) }));
      if (r.fps) L.push(t('rep.fps', { a: r.fps.toFixed(6), b: (r.fps * r.rate).toFixed(6) }));
      L.push(t('rep.drift', { ppm: sgn(r.ppm, 3), unc: r.uncPpm.toFixed(3) }));
      L.push(t('rep.fit' + fitKey(r), { n: r.edgesUsed, ms: r.fitRmsMs.toFixed(3) }) +
        (r.pitchRejected ? t('card.pitchRej', { n: r.pitchRejected }) : ''));
      L.push(t('rep.offs', { a: sgn(r.aOff, 6), vid: r.vOff !== null ? t('card.offsV', { v: sgn(r.vOff, 6) }) : '' }));
      L.push(t('rep.mode', { mode: t('mode.' + r.mode) }));
      if (r.source) L.push(t('rep.source', { v: t('src.' + r.source) }));
      if (r.ltc) L.push(t('rep.ltc', { fps: r.ltc.label, ch: chanText(r) }));
      L.push(t('rep.err', { ms: r.worstMs.toFixed(3), seg: r.segments ? t('card.afterSeg') : '' }) + floorNote(r));
      if (r.segments) r.segments.forEach((g, i) => L.push(t('rep.seg', { i: i + 1, a: g.fileFrom.toFixed(3), b: g.fileTo.toFixed(3), v: (g.speed * 100).toFixed(6) })));
      else if (r.midDevMs !== null) L.push(t('rep.mid', { ms: r.midDevMs.toFixed(3) }));
      if (isSingle(r)) L.push(t('rep.single'));
      if (r.ltc && r.ltc.rateGuess) L.push(t('rep.ltcRate'));
      if (r.mod === VIS_MOD) L.push(t(r.source === 'video' ? 'rep.vis540' : 'rep.pitch540'));
      reportAv(L, r, results, avRef);
    }
    if (results.some(r => !r.error && r.avOffsetMs)) L.push('='.repeat(64), t('rep.avNoteHead') + t('av.note'));
    const rel = relRows(results, ref);
    if (rel) {
      L.push('='.repeat(64), t('rep.relHead', { file: rel.ref.file }));
      for (const x of rel.rows) L.push(t('rep.relRow', { file: x.file, ref: x.r === rel.ref ? t('refMark') : '',
        off: offText(x.offset), v: (x.speed * 100).toFixed(6), len: x.length.toFixed(6) }));
      for (const x of rel.rows) if (x.alt !== null) L.push('  ⚠ ' + t('rel.clockWarn', { file: x.file, x: offText(x.offset), y: offText(x.alt) }));
      if (relNoteKey(rel.M)) L.push('  ' + t(relNoteKey(rel.M)));
      if (rel.unmatched) L.push('  ' + t('rel.noteLtc'));
    }
    return L.join('\n');
  }

  // The A/V sync check part of one file's text report.
  function reportAv(L, r, results, avRef) {
    if (r.visualReadS !== undefined) {
      L.push(t('rep.vis', { v: visText(r) }));
      if (r.hwFallback) L.push(t(r.hwFallbackKey || 'rep.hwFallback', { why: r.hwFallback }));
    }
    if (r.avError) L.push(t('rep.avErr', { v: errText(r.avError) }));
    if (!r.avOffsetMs) return;
    L.push(t('rep.avOff', { v: t('card.avOffV', { parts: avOffText(r) }) }));
    if (r.avJitterMs !== null) L.push(t('rep.avJit', { ms: r.avJitterMs.toFixed(3) }));
    if (r.avDriftPpm !== null)
      L.push(t(driftBad(r) ? 'rep.avDriftWarn' : 'rep.avDrift', { ppm: sgn(r.avDriftPpm, 1), unc: r.avDriftUncPpm.toFixed(1) }));
    L.push(t('rep.avEdges', { v: r.visualEdges, a: r.audioEdges }));
    if (r.avDistance) L.push(t('rep.avDist', { ms: (r.avDistance / SOUND * 1000).toFixed(3), m: r.avDistance }));
    const d = avRefDiff(r, results, avRef);
    if (d) L.push(t('rep.avRef', { v: avRefText(d) }));
  }
  return { fmtClock, errText, kindOf, chanText, hintNote, floorNote, decText, visText, avOffText, avRefText, textReport };
}
