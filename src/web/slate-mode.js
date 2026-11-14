// slate-mode.js — 場記板的模式規則（docs/slate-ui.md「模式」）：存下的設定怎麼讀回、每種模式的畫面與聲音、
// 進行中哪些模式按鈕鎖住。只有計算，不碰 DOM，單元測試直接 import。

// Main-screen modes in button order. Clock, count-up and countdown are the digit modes (for people to see and hear);
// Tag and LTC are for the analyzer and always follow the phone clock.
export var MODES = ['clock', 'up', 'cd', 'tag', 'ltc'];
export var FPS_LIST = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
export var DURS = [10, 30, 60, 180, 300, 600];
var PALETTES = ['default', 'white', 'red', 'light'];

export function defaultState() {
  return { fps: 59.94, mode: 'clock', sound: 'beep', muted: false, dur: 60, custom: 7200, df: true, dispOfs: 0, audOfs: 0,
    flashStyle: 'square', palette: 'default' };
}

// Settings saved by any earlier version: every value that is not recognised falls back to the default, nothing is
// converted (e.g. 1.1.0's flashStyle 'tag' or its beep / wave / ltc flags).
export function readState(saved) {
  var s = defaultState();
  if (!saved || typeof saved !== 'object') return s;
  if (FPS_LIST.indexOf(saved.fps) >= 0) s.fps = saved.fps;
  if (MODES.indexOf(saved.mode) >= 0) s.mode = saved.mode;
  if (saved.sound === 'beep' || saved.sound === 'wave') s.sound = saved.sound;
  if (typeof saved.muted === 'boolean') s.muted = saved.muted;
  if (saved.custom >= 1 && saved.custom <= 35999) s.custom = Math.floor(saved.custom);
  if (typeof saved.df === 'boolean') s.df = saved.df;
  if (saved.flashStyle === 'square' || saved.flashStyle === 'flash') s.flashStyle = saved.flashStyle;
  if (PALETTES.indexOf(saved.palette) >= 0) s.palette = saved.palette;
  if (typeof saved.dispOfs === 'number' && Math.abs(saved.dispOfs) <= 500) s.dispOfs = saved.dispOfs;
  if (typeof saved.audOfs === 'number' && Math.abs(saved.audOfs) <= 500) s.audOfs = saved.audOfs;
  if (DURS.indexOf(saved.dur) >= 0 || (s.custom && saved.dur === s.custom)) s.dur = saved.dur;
  return s;
}

export var isCount = function (mode) { return mode === 'up' || mode === 'cd'; };
export var isCode = function (mode) { return mode === 'tag' || mode === 'ltc'; };

// What the jack plays: 'beep', 'wave', 'ltc' or 'off'. The mode decides; the mute button silences every mode.
export function audioKind(s) {
  if (s.muted) return 'off';
  if (s.mode === 'tag') return 'wave';
  if (s.mode === 'ltc') return 'ltc';
  return s.sound;
}

// What the screen shows. sync: 'square' (black-and-white square wave), 'flash' (short white flash) or 'band' (the
// AprilTag's frame band); digits: what the big digits count ('clock', 'elapsed', 'remaining', or null when hidden);
// line: the one small line under them in Tag / LTC ('ltc' for the LTC time code, or null).
export function screenOf(s) {
  if (s.mode === 'tag') return { tag: true, sync: 'band', digits: 'clock', line: null };
  if (s.mode === 'ltc') return { tag: true, sync: 'band', digits: null, line: 'ltc' };
  return { tag: false, sync: s.flashStyle, digits: s.mode === 'up' ? 'elapsed' : s.mode === 'cd' ? 'remaining' : 'clock', line: null };
}

// Second control row: countdown has lengths, custom, schedule and start / stop; count-up schedule and start / stop.
export function secondRow(mode) { return mode === 'cd' ? 'cd' : mode === 'up' ? 'up' : null; }

// While a count runs or waits for its scheduled start, only its own mode button stays enabled (as in 1.1.0).
export function modeLocked(mode, current, busy) { return busy && mode !== current; }

export function hintKey(mode) { return 'hint' + { clock: 'Clock', up: 'Up', cd: 'Cd', tag: 'Tag', ltc: 'Ltc' }[mode]; }

// Settings → LTC: DF / NDF can only be chosen for the 29.97 family (LTC at 30000/1001 frames a second).
export function dfSelectable(fps) { return fps === 29.97 || fps === 59.94 || fps === 119.88; }

// Settings: each card's description speaks only of the chosen option (docs/slate-ui.md, rule 4). The i18n key per card.
export function descKeys(s, langPref) {
  return {
    sound: s.sound === 'wave' ? 'sndDWave' : 'sndDBeep',
    sync: s.flashStyle === 'flash' ? 'syncDFlash' : 'syncDSquare',
    df: !dfSelectable(s.fps) ? 'dfNa' : s.df ? 'dfD' : 'ndfD',
    palette: { default: 'palDDefault', white: 'palDWhite', red: 'palDRed', light: 'palDLight' }[s.palette],
    lang: langPref === 'auto' ? 'langDAuto' : 'langDFixed',
  };
}
