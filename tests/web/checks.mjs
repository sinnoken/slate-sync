// checks.mjs — 網頁分析器回歸測試（analyzer.test.mjs）的檢查邏輯：結果與真值、跨檔案、命令列版的比對，文字報告的正規化。
// 這裡只做計算、不開瀏覽器，checks.test.mjs 以人工的結果驗證每項檢查真的會失敗。

// 真值的容許值 = 報告自己的預估誤差，另加產生器本身的量化：產生器把每秒的波形碼放在整數取樣點（四捨五入），
// 真值因此有 ±半個取樣（48 kHz 時 0.0104 ms）的誤差，分析器再準也只能貼近這個值。
export const GEN_Q_MS = 0.5 / 48000 * 1000;

// 建立時間推定的 r 與真值的容許差（秒）：真值以影片長 nfr / fps 計算，分析器把 r 四捨五入到 1 ms。
export const CLOCK_R_TOL = 0.02;

// 網頁版與命令列版的容許值。兩者用同一份分析核心（src/core/），差異只來自解碼器（瀏覽器的 AAC／H.264 解碼器
// vs ffmpeg）；docs/testing.md 記錄的 16 個檔案交叉比對最大為 0.02 ppm、起點 0.0005 ms、長度 0.005 ms。
// 這裡各放寬約 2 倍，留給不同平台的解碼器差異，仍遠小於任何一項的預估誤差。
export const CLI_TOL = {
  ppm: 0.05,          // ppm
  start_ms: 0.001,    // ms，起點（模數取兩者較小者）
  length_ms: 0.01,    // ms，校正後長度
  // 聲畫偏移：偵測器相同，但縮小影格的方式不同（瀏覽器的 canvas vs ffmpeg 的 scale），轉換格的判讀可略有出入；
  // 0.05 ms 仍不到 29.97 fps 一格（33 ms）的千分之二。
  av_ms: 0.05,
};

// 已知、尚待決定的差異：列在這裡的檢查（「檔名 項目」）失敗時只警告；若已通過，會提示把它移除。
export const KNOWN = {};

export class Checker {
  constructor() { this.fails = []; this.warns = []; this.lines = []; this.passed = 0; }
  check(name, what, ok, detail) {
    const key = `${name} ${what}`, line = `${name} ${what}：${detail}`;
    this.lines.push((ok ? '通過' : '未過') + '：' + line);
    if (ok) { this.passed++; if (key in KNOWN) this.warns.push(`${line}（已通過，請把它從 KNOWN 移除）`); }
    else if (key in KNOWN) this.warns.push(`${line}（已知差異：${KNOWN[key]}）`);
    else this.fails.push(line);
  }
}

// 把 x 換到 [−m/2, m/2)。
export const wrap = (x, m) => ((x + m / 2) % m + m) % m - m / 2;
const sgn = (v, d) => (v >= 0 ? '+' : '') + v.toFixed(d);

// "+08:00" → getTimezoneOffset() 的值（分鐘，東邊為負）。
export function tzOffsetMin(tz) {
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(tz);
  if (!m) throw new Error(`時區格式錯誤：${tz}`);
  return -(m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

// 瀏覽器的時區須與真值記錄的時區相同（建立時間的推定依時區而定）。Windows 的 Edge 不理會 TZ 環境變數，用系統時區。
export function checkTimezone(c, res, truths) {
  for (const t of truths.filter(t => t.tz)) {
    const want = tzOffsetMin(t.tz), got = res.tzOffsetMin;
    c.check(t.file, '瀏覽器時區', got === want,
      got === want ? `UTC${t.tz}` : `瀏覽器的 getTimezoneOffset() 為 ${got}，真值的時區 ${t.tz} 應為 ${want}：` +
        '請以 TZ=Asia/Taipei 執行（Windows 的 Edge 不理會 TZ，需把系統時區設為 UTC+8）');
  }
}

export function checkTruth(c, r, t) {
  const name = t.file;
  if (r.error) { c.check(name, '分析', false, `失敗：${JSON.stringify(r.error)}`); return; }
  c.check(name, '模式', r.mode === t.mode, `${r.mode}（預期 ${t.mode}）`);
  // 週期與音高排除數是固定的期望值：音高循環壞掉時，分析器會退回較短的週期或排除秒數，不能靠它自己回報的週期過關。
  c.check(name, '週期', r.mod === t.mod, `${r.mod} 秒（預期 ${t.mod}）`);
  c.check(name, '音高排除', r.pitchRejected === t.pitch_rejected, `${r.pitchRejected} 秒（預期 ${t.pitch_rejected}）`);
  c.check(name, '速度比例估計誤差', r.uncPpm <= t.max_unc_ppm, `±${r.uncPpm.toFixed(3)} ppm（上限 ${t.max_unc_ppm}）`);
  c.check(name, '預估誤差', r.worstMs <= t.max_worst_ms, `±${r.worstMs.toFixed(4)} ms（上限 ${t.max_worst_ms}）`);
  let d = r.ppm - t.ppm;
  c.check(name, '速度比例', Math.abs(d) <= r.uncPpm, `${sgn(r.ppm, 3)} ppm，誤差 ${sgn(d, 3)}（預估 ±${r.uncPpm.toFixed(3)}）`);
  d = wrap(r.startLabel - t.start, t.mod) * 1000;
  let tol = r.worstMs + GEN_Q_MS;
  c.check(name, '起點', Math.abs(d) <= tol, `誤差 ${sgn(d, 4)} ms（容許 ±${tol.toFixed(4)}）`);
  d = (r.correctedLength - t.corrected_length) * 1000;
  tol = 2 * r.worstMs + GEN_Q_MS;                 // 頭尾兩端各有 worstMs
  c.check(name, '校正後長度', Math.abs(d) <= tol, `${r.correctedLength.toFixed(6)} 秒，誤差 ${sgn(d, 4)} ms（容許 ±${tol.toFixed(4)}）`);
  if (t.clock_type || t.ltc) {                    // 完整時鐘：建立時間推定（clockType）或 LTC 本身就是真實時間
    if (t.ltc) c.check(name, '時間來源', r.source === 'ltc', `${r.source}（預期 ltc）`);
    else {
      c.check(name, '建立時間類型', r.clockType === t.clock_type, `${r.clockType}（預期 ${t.clock_type}）`);
      const ok = typeof r.clockR === 'number' && Math.abs(r.clockR - t.clock_r) <= CLOCK_R_TOL;
      c.check(name, '設備時鐘差 r', ok, `${r.clockR} 秒（預期 ${t.clock_r}，容許 ±${CLOCK_R_TOL}）`);
    }
    d = wrap(r.startClock - t.start, 86400) * 1000;
    tol = r.worstMs + GEN_Q_MS;
    c.check(name, '完整起點時鐘', r.clockMod === 86400 && Math.abs(d) <= tol,
      `週期 ${r.clockMod}，誤差 ${sgn(d, 4)} ms（容許 ±${tol.toFixed(4)}）`);
  }
  if (t.av_offset_ms !== null && t.av_offset_ms !== undefined) {
    const offs = r.avOffsetMs || {}, ends = ['head', 'tail'].filter(k => offs[k]);
    c.check(name, '聲畫偏移', ends.length > 0, ends.length ? '有量到' : '沒有量到');
    for (const k of ends) {
      const o = offs[k], e = o.mean - t.av_offset_ms;
      c.check(name, `聲畫偏移（${k}）`, Math.abs(e) <= o.half, `${sgn(o.mean, 3)} ms，誤差 ${sgn(e, 3)}（預估 ±${o.half.toFixed(3)}）`);
    }
  }
}

// 與分析器的 startLabelFor() 相同：模數 m 下可用的起點，否則 null。
function labelFor(r, m) {
  if (r.mod % m === 0) return r.startLabel;
  if (r.label540 !== null && r.label540 !== undefined && 540 % m === 0) return r.label540;
  return null;
}

// 跨檔案：pair 兩個檔案的起點差（以第一個檔案的時間軸計，同分析器的對齊表）須符合真值。
export function checkPair(c, byName, truths, pair) {
  const [a, b] = pair.map(n => byName[n]);
  if (!a || !b || a.error || b.error) { c.check('跨檔案', '起點差', false, '其中一個檔案沒有結果'); return; }
  const m = [3600, 540, 180, 60].find(m => labelFor(a, m) !== null && labelFor(b, m) !== null);
  c.check('跨檔案', '模數', m !== undefined && m >= 540, `${m} 秒（2 分鐘的差須在 540 秒以上的週期才分得出來）`);
  if (!m) return;
  const got = wrap(labelFor(b, m) - labelFor(a, m), m) * a.rate;
  const want = (truths[pair[1]].start - truths[pair[0]].start) * truths[pair[0]].rate;
  const d = (got - want) * 1000, tol = a.worstMs + b.worstMs + 2 * GEN_Q_MS;
  c.check('跨檔案', `${pair[1]} 相對 ${pair[0]} 的起點`, Math.abs(d) <= tol,
    `${sgn(got, 6)} 秒（真值 ${sgn(want, 6)}），誤差 ${sgn(d, 4)} ms（容許 ±${tol.toFixed(4)}）`);
}

export function checkCli(c, web, cli) {
  const name = web.file;
  if (web.error || !cli || !('rate' in cli)) { c.check(name, 'CLI 有結果', false, '網頁版或命令列版沒有結果'); return; }
  let d = web.ppm - cli.ppm;
  c.check(name, 'CLI 速度比例', Math.abs(d) <= CLI_TOL.ppm, `差 ${sgn(d, 4)} ppm（容許 ±${CLI_TOL.ppm}）`);
  d = wrap(web.startLabel - cli.start_label, Math.min(web.mod, cli.mod)) * 1000;
  c.check(name, 'CLI 起點', Math.abs(d) <= CLI_TOL.start_ms, `差 ${sgn(d, 5)} ms（容許 ±${CLI_TOL.start_ms}）`);
  d = (web.correctedLength - cli.corrected_length) * 1000;
  c.check(name, 'CLI 校正後長度', Math.abs(d) <= CLI_TOL.length_ms, `差 ${sgn(d, 4)} ms（容許 ±${CLI_TOL.length_ms}）`);
  const wo = web.avOffsetMs || {}, co = cli.av_offset_ms || {};
  for (const k of ['head', 'tail']) {
    if (!!wo[k] !== !!co[k]) c.check(name, `CLI 聲畫偏移（${k}）`, false, `只有一邊量到（網頁 ${!!wo[k]}，命令列 ${!!co[k]}）`);
    else if (wo[k]) {
      d = wo[k].mean - co[k].mean;
      c.check(name, `CLI 聲畫偏移（${k}）`, Math.abs(d) <= CLI_TOL.av_ms, `差 ${sgn(d, 4)} ms（容許 ±${CLI_TOL.av_ms}）`);
    }
  }
}

// 快照只比文字：數字換成 #（數值另有上面的檢查），解碼方式換成〈解碼〉；「硬體解碼失敗、已改用…」那一行依機器而異，
// 整行拿掉（Windows 的 Edge 用硬體、CI 的 Chrome 可能沒有硬體解碼）。
const DECODERS = /(硬體解碼（WebCodecs）|軟體解碼)(＋(硬體解碼（WebCodecs）|軟體解碼))*/g;
const HW_FALLBACK = /^ *⚠ 硬體解碼失敗 .*(\n|$)/gm;
const NUMBER = /(?<![\p{L}\p{N}_.])[+−-]?\d+(?:\.\d+)?/gu;   // 不動檔名裡的數字（如 mp4）與緊接在文字後的數字
export const normalize = report =>
  (report || '').replace(HW_FALLBACK, '').replace(DECODERS, '〈解碼〉').replace(NUMBER, '#').trimEnd() + '\n';
