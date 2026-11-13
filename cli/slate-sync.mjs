#!/usr/bin/env node
// slate-sync.mjs — 命令列分析器：讀取「同步場記板」的波形碼、LTC 或畫面碼，算出每個錄音／錄影檔的起點真實時間與
// 校正後長度。分析與報告用網頁共用的核心（src/core/），這裡只負責選項、以 ffmpeg 讀檔（media.mjs）與輸出。
//
// 需求：Node 20 以上、ffmpeg／ffprobe（在 PATH 中）
// 用法：
//   node cli/slate-sync.mjs 檔案1.mp4 檔案2.wav ...
//   node cli/slate-sync.mjs *.MP4 --ref A001.MP4                    # 以 A001 為基準，列出其他檔案的位置與播放速度
//   node cli/slate-sync.mjs *.MP4 --ref A001.MP4 --at B002.MP4=125.5  # B002 的 125.5 秒對應 A001 的哪一秒
//   node cli/slate-sync.mjs rec.wav --channel 1                     # 指定波形碼所在聲道（0 起算）
//   node cli/slate-sync.mjs cam.mp4 --only head                     # 只錄了開頭
//   node cli/slate-sync.mjs long.mp4 --full                         # 整段都有波形碼：抽查中段，必要時分段
//   node cli/slate-sync.mjs A.MP4 B.MP4 --av --distance 0.5         # 聲畫同步檢查（手機距麥克風 0.5 m）
//   node cli/slate-sync.mjs a.wav --json --lang en                  # JSON 輸出；報告語言 zh-Hant、en、ja、ko
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from '../src/core/analyze.js';
import { LANGS, translator } from '../src/core/i18n.js';
import { avRefDiff, convertT, createReport, pairCycle, relRows } from '../src/core/report.js';
import { openMedia } from './media.mjs';

const HELP = `用法：node cli/slate-sync.mjs 檔案 ... [選項]

讀取同步場記板的波形碼（或 LTC、畫面碼），計算起點真實時間與校正後長度。

選項：
  --channel N       波形碼所在聲道（0 起算），預設自動判斷
  --fps F           影格率，預設讀取檔案資訊
  --ref 檔名        作為相對位置基準的檔名
  --at 檔名=秒      把某檔案的某一刻換算到其他檔案的時間，例如 --at B002.MP4=125.5（可重複）
  --only head|tail  只錄了開頭（head）或結尾（tail）：略過另一端的搜尋
  --full            整段都有波形碼：抽查中段 3 處，偏離直線時改為分段調速
  --probe N         中段抽查處數（隱含 --full）
  --target MS       目標精度：檔案任何位置的預估誤差（ms），預設 1
  --search MIN      每端最多往內找幾分鐘，預設 30
  --max-read S      找到後每端最多再讀幾秒，預設 120
  --minute          讀到波形碼後再多讀約 1 分鐘尋找分鐘標記，以顯示完整的時分秒（較慢）
  --av              聲畫同步檢查：另解畫面碼，與波形碼逐秒配對
  --distance M      手機到麥克風的距離（公尺），以 343 m/s 扣除聲音傳播時間
  --av-ref 檔名     聲畫基準檔：其他檔案另列相對它的偏移差
  --no-hwaccel      畫面碼改用軟體解碼（預設依序試 cuda、d3d11va 硬體解碼，失敗時自動改用軟體）
  --json            以 JSON 輸出
  --lang L          報告語言：zh-Hant（預設）、en、ja、ko
  -h, --help        顯示這段說明

結束代碼：0 全部檔案都分析成功；1 有檔案分析失敗（其餘檔案照樣輸出）；2 選項錯誤`;

// A broken pipe (e.g. piped into head) ends the program quietly instead of with an error.
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); else throw e; });

function fatal(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

const OPTIONS = {
  channel: { type: 'string' }, fps: { type: 'string' }, ref: { type: 'string' }, at: { type: 'string', multiple: true },
  only: { type: 'string' }, full: { type: 'boolean' }, probe: { type: 'string' }, target: { type: 'string' },
  search: { type: 'string' }, 'max-read': { type: 'string' }, minute: { type: 'boolean' }, av: { type: 'boolean' },
  distance: { type: 'string' }, 'av-ref': { type: 'string' }, 'no-hwaccel': { type: 'boolean' }, json: { type: 'boolean' },
  lang: { type: 'string' }, help: { type: 'boolean', short: 'h' } };

// parseArgs refuses a value that starts with a dash ("--fps -30"), so a negative number is joined to its option
// ("--fps=-30") and then rejected by the range check with a clear message.
const joinNegatives = argv => argv.reduce((out, s) => {
  const prev = out[out.length - 1], o = prev && /^--[\w-]+$/.test(prev) ? OPTIONS[prev.slice(2)] : null;
  if (o && o.type === 'string' && /^-\.?\d/.test(s)) out[out.length - 1] = `${prev}=${s}`;
  else out.push(s);
  return out;
}, []);

function parse() {
  let a;
  try { a = parseArgs({ args: joinNegatives(process.argv.slice(2)), allowPositionals: true, options: OPTIONS }); }
  catch (e) { fatal(`${e.message}\n\n${HELP}`); }
  const o = a.values;
  if (o.help) { process.stdout.write(HELP + '\n'); process.exit(0); }
  if (!a.positionals.length) fatal(HELP);
  // min: the smallest value allowed; open: the value must be above it.
  const number = (name, { int = false, min = -Infinity, open = false } = {}) => {
    if (o[name] === undefined) return undefined;
    const v = o[name].trim() === '' ? NaN : Number(o[name]);
    if (!Number.isFinite(v) || (int && !Number.isInteger(v))) fatal(`--${name}：${o[name]} 不是${int ? '整數' : '數字'}`);
    if (open ? v <= min : v < min) fatal(`--${name}：${o[name]} 必須${open ? '大於' : '大於或等於'} ${min}`);
    return v;
  };
  if (o.only !== undefined && !['head', 'tail'].includes(o.only)) fatal('--only 只能是 head 或 tail');
  const lang = o.lang ?? 'zh-Hant';
  if (!LANGS.includes(lang)) fatal(`--lang 只能是 ${LANGS.join('、')}`);
  for (const spec of o.at ?? []) {
    const i = spec.lastIndexOf('='), sec = spec.slice(i + 1).trim();
    if (i <= 0 || sec === '' || !Number.isFinite(Number(sec))) fatal(`--at ${spec}：格式須為「檔名=秒」，例如 --at B002.MP4=125.5`);
  }
  const probe = number('probe', { int: true, min: 0 });
  return {
    files: a.positionals, ref: o.ref ?? null, at: o.at ?? [], json: !!o.json, lang, avRef: o['av-ref'] ?? null,
    fps: number('fps', { min: 0, open: true }) ?? null, hwaccel: !o['no-hwaccel'],
    opts: { only: o.only ?? null, probe: probe ?? (o.full ? 3 : 0), minute: !!o.minute, av: !!o.av,
      distance: number('distance', { min: 0 }) ?? 0, target: number('target', { min: 0, open: true }) ?? 1.0,
      search: number('search', { min: 0, open: true }) ?? 30, maxRead: number('max-read', { min: 0, open: true }) ?? 120,
      channel: number('channel', { int: true, min: 0 }) ?? null },
  };
}

// The result whose file has the same base name as name (--ref, --at, --av-ref accept a path or just the name).
const byName = (results, name) => name === null ? null : results.find(r => path.basename(r.file) === path.basename(name)) || null;

// --json: the field names of the earlier Python command line (snake_case). Its text values (kind, mode, hint_src,
// error, av_error) are in the report language; zh-Hant gives the same text as before.
const snake = k => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()).replace(/(\d+)/g, '_$1');
function toJson(r, t, R) {
  if (r.error) return { file: r.file, error: R.errText(r.error) };
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'hwFallbackKey' || v === undefined) continue;
    let x = v;
    if (k === 'kind') x = t('kind.' + v);
    else if (k === 'mode') x = t('mode.' + v);
    else if (k === 'hintSrc') x = v && t('hint.' + v);
    else if (k === 'avError') x = R.errText(v);
    else if (k === 'segments' && v) x = v.map(g => ({ file_from: g.fileFrom, file_to: g.fileTo, speed: g.speed }));
    else if (k === 'ltc' && v) x = { label: v.label, tc_scale: v.tcScale, rate_guess: v.rateGuess };
    out[snake(k)] = x;
  }
  return out;
}

async function main() {
  const args = parse();
  const t = translator(args.lang), R = createReport(t);
  const results = [];
  for (const f of args.files) {
    let r;
    try {
      const m = await openMedia(f, { fps: args.fps, hwaccel: args.hwaccel }), ch = args.opts.channel;
      if (ch !== null && m.hasAudio && ch >= m.channels)
        throw new Error(`--channel ${ch} 超出聲道數：這個檔案有 ${m.channels} 個聲道（0 起算，可用 0～${m.channels - 1}）`);
      r = await analyze(m, args.opts);
    }
    catch (e) { r = { file: f, error: (e && e.i18n) || { raw: (e && e.message) || String(e) } }; }   // keep going with the other files
    results.push(r);
  }
  const ok = results.filter(r => !r.error);
  if (ok.length < results.length) process.exitCode = 1;   // set, not exit: the report is still written in full
  const ref = byName(ok, args.ref), refFile = ref ? ref.file : null;
  let avRef = null;
  if (args.avRef !== null) {
    const a = byName(ok, args.avRef);
    if (!a || !a.avOffsetMs || !(a.avOffsetMs.head || a.avOffsetMs.tail)) process.stderr.write(`⚠ 找不到聲畫基準檔 ${args.avRef} 的聲畫偏移\n`);
    else avRef = a.file;
  }
  if (args.json) {
    const rel = relRows(results, refFile);
    const out = results.map(r => {
      const j = toJson(r, t, R);
      const d = !r.error && avRef ? avRefDiff(r, results, avRef) : null;
      if (d) { j.av_ref = path.basename(d.ref); j.av_ref_diff_ms = { head: d.head, tail: d.tail }; }
      const row = rel && rel.rows.find(x => x.r === r);
      if (row) {
        const pc = pairCycle(r, rel.ref);
        Object.assign(j, { align_to: path.basename(rel.ref.file), align_offset: row.offset, align_speed: row.speed,
          align_length: row.length, align_mod: pc ? pc[0] : null });
        // The creation-time clocks put the start outside the cycles' range: the difference within the cycle (report.js clockCheck).
        if (row.alt !== null) j.align_offset_cycle = row.alt;
      }
      return j;
    });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const L = [R.textReport(results, { ref: refFile, avRef })];
  if (args.at.length) {
    const base = relRows(results, refFile);
    if (base) L.push('='.repeat(64));
    for (const spec of args.at) {
      const i = spec.lastIndexOf('='), name = spec.slice(0, i), sec = Number(spec.slice(i + 1));
      const src = i > 0 && Number.isFinite(sec) ? byName(ok, name) : null;
      if (!src) { L.push(t('rep.atMissing', { spec, name: i > 0 ? name : spec })); continue; }
      L.push(t('rep.atHead', { file: src.file, t: sec.toFixed(6) }));
      for (const dst of ok) {
        if (dst === src) continue;
        const v = convertT(src, sec, dst);
        L.push(t('rep.atRow', { file: dst.file, v: v === null ? '—' : v.toFixed(6) }));
      }
    }
  }
  process.stdout.write(L.join('\n') + '\n');
}

main().catch(e => fatal((e && e.stack) || String(e)));
