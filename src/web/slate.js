// slate.js — 同步場記板的頁面程式：介面、聲音排程與畫面。編碼（波形碼、LTC、tag）在 src/core/slate.js，
// 建置時由 scripts/build.mjs 打包後內嵌進 src/web/sync-slate.html。
import { countToTC, cycleK, drawTag, ltcChunk, ltcParams, waveBursts, waveHz } from '../core/slate.js';
import { DURS, FPS_LIST, MODES, audioKind, defaultState, descKeys, dfSelectable, hardStop, hintKey, isCode, isCount, modeLocked, readState, screenOf, secondRow } from './slate-mode.js';

// Monotonic wall clock: anchored to Date.now() once, then driven by performance.now() so OS clock steps can't jump the display.
var WALL0 = Date.now() - performance.now();
function wallNow() { return WALL0 + performance.now(); }
var $ = function (id) { return document.getElementById(id); };
var clockEl = $('clock'), statusEl = $('status'), wave = $('wave'), tag = $('tag');
var FLASH_MS = 120;
var SEP = '<span class="sep">:</span>';

// ---- i18n: every page uses the same detection; the choice is shared through localStorage ----
var LANGS = ['zh-Hant', 'en', 'ja', 'ko'];
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
// 所有語言的 key 必須相同；字串裡的 {name} 由 t() 代入。
var I18N = {
  'zh-Hant': {
    grpDigit: '數字模式',
    grpLtc: 'LTC',
    grpOther: '其他',
    sndDBeep: '每秒一聲嗶，整分鐘較長，錄音機靠近就收得到。',
    sndDWave: '波形碼：剪輯軟體的波形上看得出秒數，分析器可自動對時。',
    syncDSquare: '畫面每秒黑白各半，黑變白是整秒，遠處也清楚。',
    syncDFlash: '每個整秒短閃一下白，較省電、不刺眼。',
    fpsHigh: '60Hz 的手機螢幕會跳過部分影格號碼。',
    dfK: 'DF／NDF',
    dfD: 'DF：時間碼依規則跳號，與實際時間一致。',
    ndfD: 'NDF：時間碼不跳號，每小時比實際時間慢約 3.6 秒。',
    dfNa: '只在 29.97、59.94、119.88 fps 可選；目前的影格率不需要。',
    customD: '點主畫面的「自訂」即以這個長度開始倒數。',
    calVideoD: '螢幕更新延遲已自動補償；實拍比對仍有誤差再微調，正值代表提前。每支手機做一次。',
    calAudioD: '聲音輸出延遲；實拍比對仍有誤差再微調，正值代表提前。每支手機做一次。',
    palDDefault: '時分藍色、秒白色、格黃色。',
    palDWhite: '數字全白，最好辨識。',
    palDRed: '紅色調，暗場不刺眼。',
    palDLight: '控制區與設定頁改淺底；數字區仍是黑底。',
    langDAuto: '跟隨手機的語言設定。',
    langDFixed: '固定使用這個語言，不跟隨手機設定。',
    analyzerK: '同步分析器',
    resetK: '重設',
    modeTag: 'Tag', modeLtc: 'LTC', muteAria: '靜音',
    hintClock: '手機時鐘（free run），給人看與聽。畫面黑變白是整秒，點數字可隱藏按鈕。',
    hintUp: '從 0 正數，可排程開始。畫面黑變白是整秒，點數字可隱藏按鈕。',
    hintCd: '點選長度即開始倒數，可排程開始。畫面黑變白是整秒，點數字可隱藏按鈕。',
    hintTag: '給只拍到畫面的攝影機用：頭尾各拍 5–10 秒，分析器自動對時。',
    hintLtc: '把 LTC 接到錄音機或攝影機的音訊輸入，畫面同時拍進攝影機，分析器自動對時。接 MIC 輸入時需衰減。',
    soundK: '聲音',
    sBeep: '嗶聲',
    sWave: '波形碼',
    ltcMuted: 'LTC 已靜音',
    appTitle: '同步場記板', scenePh: '例：12A', sceneAria: '場次', settings: '設定', done: '完成',
    stageAria: '點一下隱藏或顯示按鈕', clockAria: '時間', modeAria: '模式', modeClock: '時鐘', modeCd: '倒數', modeUp: '正數',
    cdLen: '倒數長度', schedTitle: '排程開始時間', schedLbl: '排程',
    goCd: '開始倒數', goUp: '開始正數', goStop: '停止', goCancelSched: '取消排程', hintNoWake: '提醒：請在手機設定中暫時關閉自動鎖定，避免螢幕變暗。',
    hintWakeFail: '提醒：無法自動保持螢幕常亮，請在手機設定中暫時關閉自動鎖定。',
    fpsK: '影格率', fpsD: '{fps} fps，和攝影機相同；時鐘的「格」與 LTC 依此計算，LTC 為 {label}。',
    syncK: '畫面同步訊號', fsSquare: '黑白方波', fsFlash: '短閃白',
    grpLook: '外觀', paletteK: '配色', pDefault: '預設', pWhite: '全白', pRed: '紅光', pLight: '淺色',
    langK: '語言', langAuto: '自動',
    grpCd: '倒數', customK: '自訂長度', edit: '修改',
    ltc23976: '23.976（24 格時間碼）', ltcWait: 'LTC 準備中',
    grpCal: '校準', ofsVideo: '畫面延遲', ofsAudio: '聲音延遲',
    toolsD: '拍完後在電腦上分析素材：速度比例、校正後長度、對齊到基準檔。檔案不會上傳。', openAnalyzer: '開啟同步分析器（電腦用）',
    resetD: '恢復所有預設值並清除場次。設定平時會自動記住，需再按一次確認才會執行。',
    resetAll: '重設所有設定', resetConfirm: '再按一次重設', resetDone: '已重設',
    schedP: '會在指定時間自動開始，開始前畫面顯示負的時間。倒數請在下方選擇長度；正數從 0 起算。',
    schedAt: '或指定時間', startTime: '開始時間', cancel: '取消', schedOk: '確定排程', quick: '{n} 分鐘後',
    customTitle: '自訂倒數', customP: '儲存後會記住。之後點「自訂」即開始倒數；要修改請到設定頁。',
    minutesAria: '分鐘', secondsAria: '秒', minUnit: '分', secUnit: '秒', cErr: '請輸入 1 秒以上的時間。', cSave: '儲存並使用',
    customChip: '自訂 {d}', customAdd: '＋ 自訂',
    gateP: '對準每台攝影機拍 3～5 秒，開頭和結尾各一次。錄音機請靠近收嗶聲。', gateWarn: '注意：本工具會全螢幕黑白閃爍（每秒一次）。', gateGo: '開始使用',
    durH: '{n} 小時', durM: '{n} 分', durS: '{n} 秒', durSep: ' ', whenToday: '{t}', whenTomorrow: '明天 {t}',
    stUpWait: '將於 {when} 開始正數', stUpRun: '正數中，{t} 起算', stStopped: '已停止', stUpIdle: '按「開始正數」從 0 起算',
    stCdWait: '將於 {when} 開始，長度 {dur}', stCdRun: '倒數中', stCdDone: '時間到', stCdIdle: '點選長度即開始倒數，再點一次重新開始',
    errNoTime: '請輸入開始時間。', errBadTime: '時間格式不正確。', errTooSoon: '時間太接近現在，請選 10 秒以後的時間，或直接點選倒數長度。',
    pvToday: '將於今天 {t} 開始（還有 {left}）', pvTomorrow: '將於明天 {t} 開始（還有 {left}）', pvUp: '從 0 開始正數', pvCd: '結束於 {when}，倒數長度 {dur}'
  },
  en: {
    grpDigit: 'Digit modes',
    grpLtc: 'LTC',
    grpOther: 'Other',
    sndDBeep: 'A beep every second, longer on the minute; keep the recorder close enough to pick it up.',
    sndDWave: 'Waveform code: the seconds can be read in an editor’s waveform view, and the analyzer syncs it automatically.',
    syncDSquare: 'Half of each second white, half black; black to white is the top of the second, easy to read from a distance.',
    syncDFlash: 'A short white flash at the top of each second; saves battery and is easier on the eyes.',
    fpsHigh: ' A 60Hz phone screen skips some frame numbers.',
    dfK: 'DF / NDF',
    dfD: 'DF: frame numbers are skipped by rule so the time code stays on real time.',
    ndfD: 'NDF: no frame numbers are skipped; the time code falls about 3.6 s per hour behind real time.',
    dfNa: 'Only for 29.97, 59.94 and 119.88 fps; the current frame rate doesn’t need it.',
    customD: 'Tap “Custom” on the main screen to start a countdown of this length.',
    calVideoD: 'Screen refresh delay is compensated automatically. Fine-tune only if test footage still shows an offset; positive values shift it earlier. Once per phone.',
    calAudioD: 'Audio output delay. Fine-tune only if test footage still shows an offset; positive values shift it earlier. Once per phone.',
    palDDefault: 'Hours and minutes blue, seconds white, frames yellow.',
    palDWhite: 'All digits white, the most legible.',
    palDRed: 'Red tones, easy on the eyes on a dark set.',
    palDLight: 'Light background for the controls and settings; the digits stay on black.',
    langDAuto: 'Follows your phone’s language.',
    langDFixed: 'Always uses this language, whatever the phone is set to.',
    analyzerK: 'Sync Analyzer',
    resetK: 'Reset',
    modeTag: 'Tag', modeLtc: 'LTC', muteAria: 'Mute',
    hintClock: 'Phone clock (free run) for people to see and hear. Black to white is the top of each second; tap the digits to hide the buttons.',
    hintUp: 'Counts up from 0 and can be scheduled. Black to white is the top of each second; tap the digits to hide the buttons.',
    hintCd: 'Tap a length to start the countdown; it can also be scheduled. Black to white is the top of each second; tap the digits to hide the buttons.',
    hintTag: 'For cameras that only see the screen: shoot 5–10 s at the head and tail, and the analyzer syncs them automatically.',
    hintLtc: 'Feed the LTC into a recorder or camera audio input and let the camera see the screen; the analyzer syncs automatically. Attenuate it for a MIC input.',
    soundK: 'Sound',
    sBeep: 'Beep',
    sWave: 'Waveform code',
    ltcMuted: 'LTC muted',
    appTitle: 'Sync Slate', scenePh: 'e.g. 12A', sceneAria: 'Scene', settings: 'Settings', done: 'Done',
    stageAria: 'Tap to hide or show the controls', clockAria: 'Time', modeAria: 'Mode', modeClock: 'Clock', modeCd: 'Countdown', modeUp: 'Count up',
    cdLen: 'Countdown length', schedTitle: 'Schedule start', schedLbl: 'Schedule',
    goCd: 'Start countdown', goUp: 'Start count-up', goStop: 'Stop', goCancelSched: 'Cancel schedule', hintNoWake: 'Note: turn off auto-lock in your phone settings while shooting so the screen stays on.',
    hintWakeFail: 'Note: the screen can’t be kept on automatically. Turn off auto-lock in your phone settings for now.',
    fpsK: 'Frame rate', fpsD: '{fps} fps, matching the camera; the clock’s frame digits and LTC follow it. LTC: {label}.',
    syncK: 'Visual sync signal', fsSquare: 'Square wave', fsFlash: 'Short flash',
    grpLook: 'Appearance', paletteK: 'Colors', pDefault: 'Default', pWhite: 'White', pRed: 'Red', pLight: 'Light',
    langK: 'Language', langAuto: 'Auto',
    grpCd: 'Countdown', customK: 'Custom length', edit: 'Edit',
    ltc23976: '23.976 (24-frame timecode)', ltcWait: 'LTC starting…',
    grpCal: 'Calibration', ofsVideo: 'Video delay', ofsAudio: 'Audio delay',
    toolsD: 'After the shoot, analyze footage on a computer: speed ratio, corrected length, alignment to a reference file. Files are never uploaded.', openAnalyzer: 'Open Sync Analyzer (for computers)',
    resetD: 'Restores all defaults and clears the scene. Settings are saved automatically; tap again to confirm the reset.',
    resetAll: 'Reset all settings', resetConfirm: 'Tap again to reset', resetDone: 'Reset done',
    schedP: 'Starts automatically at the set time; until then the display shows negative time. For a countdown, pick the length below; a count-up starts from 0.',
    schedAt: 'Or set a time', startTime: 'Start time', cancel: 'Cancel', schedOk: 'Schedule', quick: 'In {n} min',
    customTitle: 'Custom countdown', customP: 'Saved for next time. Tap “Custom” to start the countdown; change it in Settings.',
    minutesAria: 'Minutes', secondsAria: 'Seconds', minUnit: 'min', secUnit: 'sec', cErr: 'Enter at least 1 second.', cSave: 'Save and use',
    customChip: 'Custom {d}', customAdd: '+ Custom',
    gateP: 'Hold it up to each camera for 3–5 seconds, once at the head and once at the tail. Keep the recorder close enough to pick up the beep.', gateWarn: 'Warning: this tool flashes the whole screen black and white (once per second).', gateGo: 'Start',
    durH: '{n} h', durM: '{n} min', durS: '{n} s', durSep: ' ', whenToday: 'at {t}', whenTomorrow: 'tomorrow at {t}',
    stUpWait: 'Count-up starts {when}', stUpRun: 'Counting up from {t}', stStopped: 'Stopped', stUpIdle: 'Tap “Start count-up” to count from 0',
    stCdWait: 'Starts {when}, length {dur}', stCdRun: 'Counting down', stCdDone: 'Time’s up', stCdIdle: 'Tap a length to start; tap again to restart',
    errNoTime: 'Enter a start time.', errBadTime: 'Invalid time.', errTooSoon: 'Too close to now. Pick a time at least 10 seconds ahead, or just tap a countdown length.',
    pvToday: 'Starts today at {t} (in {left})', pvTomorrow: 'Starts tomorrow at {t} (in {left})', pvUp: 'Counts up from 0', pvCd: 'Ends {when}, countdown length {dur}'
  },
  ja: {
    grpDigit: '数字モード',
    grpLtc: 'LTC',
    grpOther: 'その他',
    sndDBeep: '毎秒ビープ、分の頭は長め。レコーダーは音が録れるよう近くに置いてください。',
    sndDWave: '波形コード：編集ソフトの波形で秒数が読め、アナライザーで自動同期できます。',
    syncDSquare: '毎秒半分が白、半分が黒。黒から白が秒の頭で、離れていても見やすい。',
    syncDFlash: '秒の頭に短く白く光ります。省電力でまぶしくない。',
    fpsHigh: '60Hz の画面では一部のフレーム番号が表示されません。',
    dfK: 'DF／NDF',
    dfD: 'DF：規則に従ってフレーム番号を飛ばし、実時間に合わせます。',
    ndfD: 'NDF：フレーム番号を飛ばさず、1 時間で実時間より約 3.6 秒遅れます。',
    dfNa: '29.97・59.94・119.88 fps のときだけ選べます。現在のフレームレートでは不要です。',
    customD: 'メイン画面の「カスタム」をタップすると、この長さでカウントダウンを始めます。',
    calVideoD: '画面の表示遅延は自動で補正しています。テスト撮影でずれが残る場合だけ微調整してください。プラスは早める方向です。端末ごとに 1 回。',
    calAudioD: '音声出力の遅延です。テスト撮影でずれが残る場合だけ微調整してください。プラスは早める方向です。端末ごとに 1 回。',
    palDDefault: '時分は青、秒は白、フレームは黄。',
    palDWhite: '数字をすべて白に。最も読みやすい。',
    palDRed: '赤系の色で、暗い現場でもまぶしくない。',
    palDLight: '操作部と設定画面を明るい背景に。数字は黒背景のままです。',
    langDAuto: '端末の言語設定に合わせます。',
    langDFixed: '端末の設定に関係なく、この言語を使います。',
    analyzerK: '同期アナライザー',
    resetK: 'リセット',
    modeTag: 'Tag', modeLtc: 'LTC', muteAria: 'ミュート',
    hintClock: '端末の時計（フリーラン）を人が見て聞くためのモード。黒→白が秒の頭です。数字をタップするとボタンが消えます。',
    hintUp: '0 からカウントアップ。開始の予約もできます。黒→白が秒の頭です。数字をタップするとボタンが消えます。',
    hintCd: '長さをタップするとカウントダウン開始。開始の予約もできます。黒→白が秒の頭です。数字をタップするとボタンが消えます。',
    hintTag: '画面だけを撮るカメラ用：頭と終わりに 5〜10 秒ずつ撮ると、アナライザーが自動で同期します。',
    hintLtc: 'LTC をレコーダーやカメラの音声入力へ送り、画面もカメラに映すと、アナライザーが自動で同期します。MIC 入力では減衰させてください。',
    soundK: '音',
    sBeep: 'ビープ',
    sWave: '波形コード',
    ltcMuted: 'LTC ミュート中',
    appTitle: '同期カチンコ', scenePh: '例：12A', sceneAria: 'シーン', settings: '設定', done: '完了',
    stageAria: 'タップでボタンを表示／非表示', clockAria: '時刻', modeAria: 'モード', modeClock: '時計', modeCd: 'ダウン', modeUp: 'アップ',
    cdLen: 'カウントダウン時間', schedTitle: '開始時刻の予約', schedLbl: '予約',
    goCd: 'カウントダウン開始', goUp: 'カウントアップ開始', goStop: '停止', goCancelSched: '予約取消', hintNoWake: '注意：画面が暗くならないよう、端末の設定で自動ロックを一時的にオフにしてください。',
    hintWakeFail: '注意：画面を点灯したままにできませんでした。端末の設定で自動ロックを一時的にオフにしてください。',
    fpsK: 'フレームレート', fpsD: '{fps} fps：カメラと同じ値にします。時計のフレーム数字と LTC はこれに従います。LTC：{label}。',
    syncK: '画面の同期信号', fsSquare: '矩形波', fsFlash: 'フラッシュ',
    grpLook: '表示', paletteK: '配色', pDefault: '標準', pWhite: '白', pRed: '赤', pLight: '淡色',
    langK: '言語', langAuto: '自動',
    grpCd: 'カウントダウン', customK: 'カスタム時間', edit: '変更',
    ltc23976: '23.976（24 フレームのタイムコード）', ltcWait: 'LTC 準備中',
    grpCal: 'キャリブレーション', ofsVideo: '映像の遅延', ofsAudio: '音声の遅延',
    toolsD: '撮影後にパソコンで素材を解析：速度比、補正後の長さ、基準ファイルへの位置合わせ。ファイルはアップロードされません。', openAnalyzer: '同期アナライザーを開く（PC 用）',
    resetD: 'すべて初期値に戻し、シーンも消去します。設定は自動で保存されます。2 回押すと実行します。',
    resetAll: 'すべての設定をリセット', resetConfirm: 'もう一度押してリセット', resetDone: 'リセットしました',
    schedP: '指定した時刻に自動で開始し、それまではマイナスの時間を表示します。カウントダウンは下で長さを選んでください。カウントアップは 0 から始まります。',
    schedAt: 'または時刻を指定', startTime: '開始時刻', cancel: 'キャンセル', schedOk: '予約する', quick: '{n}分後',
    customTitle: 'カスタムカウントダウン', customP: '保存した長さは記憶されます。以降は「カスタム」をタップするとカウントダウンが始まります。変更は設定画面で行います。',
    minutesAria: '分', secondsAria: '秒', minUnit: '分', secUnit: '秒', cErr: '1 秒以上の時間を入力してください。', cSave: '保存して使う',
    customChip: 'カスタム {d}', customAdd: '＋ カスタム',
    gateP: '各カメラに 3〜5 秒ずつ映します。撮影の頭と終わりに 1 回ずつ。レコーダーはビープ音が録れるよう近くに置いてください。', gateWarn: '注意：このツールは画面全体が白黒に点滅します（毎秒 1 回）。', gateGo: 'はじめる',
    durH: '{n}時間', durM: '{n}分', durS: '{n}秒', durSep: '', whenToday: '{t}', whenTomorrow: '明日 {t}',
    stUpWait: '{when} にカウントアップ開始', stUpRun: 'カウントアップ中（{t} から）', stStopped: '停止しました', stUpIdle: '「カウントアップ開始」で 0 から数えます',
    stCdWait: '{when} に開始、長さ {dur}', stCdRun: 'カウントダウン中', stCdDone: 'タイムアップ', stCdIdle: '長さをタップで開始、再タップでやり直し',
    errNoTime: '開始時刻を入力してください。', errBadTime: '時刻の形式が正しくありません。', errTooSoon: '現在時刻に近すぎます。10 秒以上先の時刻を選ぶか、カウントダウンの長さを直接タップしてください。',
    pvToday: '今日 {t} に開始（あと {left}）', pvTomorrow: '明日 {t} に開始（あと {left}）', pvUp: '0 からカウントアップ', pvCd: '{when} に終了、長さ {dur}'
  },
  ko: {
    grpDigit: '숫자 모드',
    grpLtc: 'LTC',
    grpOther: '기타',
    sndDBeep: '매초 비프, 정분에는 길게 울립니다. 녹음기를 가까이 두세요.',
    sndDWave: '파형 코드: 편집 프로그램의 파형에서 초를 읽을 수 있고 분석기가 자동으로 싱크합니다.',
    syncDSquare: '매초 절반은 흰색, 절반은 검정입니다. 검정에서 흰색이 매초 시작이며 멀리서도 잘 보입니다.',
    syncDFlash: '매초 시작에 짧게 흰색으로 깜박입니다. 배터리를 아끼고 덜 눈부십니다.',
    fpsHigh: ' 60Hz 휴대폰 화면에서는 일부 프레임 번호를 건너뜁니다.',
    dfK: 'DF/NDF',
    dfD: 'DF: 규칙에 따라 프레임 번호를 건너뛰어 실제 시간과 맞춥니다.',
    ndfD: 'NDF: 프레임 번호를 건너뛰지 않으며, 한 시간에 실제 시간보다 약 3.6초 늦어집니다.',
    dfNa: '29.97·59.94·119.88 fps에서만 선택할 수 있습니다. 현재 프레임 레이트에는 필요 없습니다.',
    customD: '메인 화면에서 ‘맞춤’을 누르면 이 길이로 카운트다운을 시작합니다.',
    calVideoD: '화면 갱신 지연은 자동으로 보정됩니다. 테스트 촬영 후에도 오차가 있을 때만 미세 조정하세요. 양수 값은 더 이르게 맞춥니다. 휴대폰마다 한 번.',
    calAudioD: '오디오 출력 지연입니다. 테스트 촬영 후에도 오차가 있을 때만 미세 조정하세요. 양수 값은 더 이르게 맞춥니다. 휴대폰마다 한 번.',
    palDDefault: '시·분은 파랑, 초는 흰색, 프레임은 노랑.',
    palDWhite: '숫자를 모두 흰색으로. 가장 잘 보입니다.',
    palDRed: '붉은 색조로 어두운 현장에서 눈부시지 않습니다.',
    palDLight: '조작부와 설정 화면을 밝은 배경으로 바꿉니다. 숫자는 검은 배경 그대로입니다.',
    langDAuto: '휴대폰의 언어 설정을 따릅니다.',
    langDFixed: '휴대폰 설정과 관계없이 이 언어를 사용합니다.',
    analyzerK: '싱크 분석기',
    resetK: '초기화',
    modeTag: 'Tag', modeLtc: 'LTC', muteAria: '음소거',
    hintClock: '휴대폰 시계(프리런)를 보고 듣는 모드입니다. 검정→흰색이 매초 시작입니다. 숫자를 탭하면 버튼이 숨겨집니다.',
    hintUp: '0부터 카운트업하며 시작을 예약할 수 있습니다. 검정→흰색이 매초 시작입니다. 숫자를 탭하면 버튼이 숨겨집니다.',
    hintCd: '길이를 누르면 카운트다운이 시작되며 예약도 할 수 있습니다. 검정→흰색이 매초 시작입니다. 숫자를 탭하면 버튼이 숨겨집니다.',
    hintTag: '화면만 찍는 카메라용: 처음과 끝에 5–10초씩 찍으면 분석기가 자동으로 싱크를 맞춥니다.',
    hintLtc: 'LTC를 녹음기나 카메라의 오디오 입력에 연결하고 화면도 카메라에 담으면 분석기가 자동으로 싱크합니다. MIC 입력에는 감쇠가 필요합니다.',
    soundK: '소리',
    sBeep: '비프',
    sWave: '파형 코드',
    ltcMuted: 'LTC 음소거됨',
    appTitle: '싱크 슬레이트', scenePh: '예: 12A', sceneAria: '씬', settings: '설정', done: '완료',
    stageAria: '탭하여 버튼 숨기기/표시', clockAria: '시간', modeAria: '모드', modeClock: '시계', modeCd: '카운트다운', modeUp: '카운트업',
    cdLen: '카운트다운 길이', schedTitle: '시작 시간 예약', schedLbl: '예약',
    goCd: '카운트다운 시작', goUp: '카운트업 시작', goStop: '정지', goCancelSched: '예약 취소', hintNoWake: '참고: 화면이 어두워지지 않도록 휴대폰 설정에서 자동 잠금을 잠시 꺼 주세요.',
    hintWakeFail: '참고: 화면 켜짐을 자동으로 유지할 수 없습니다. 휴대폰 설정에서 자동 잠금을 잠시 꺼 주세요.',
    fpsK: '프레임 레이트', fpsD: '{fps} fps: 카메라와 같게 맞추세요. 시계의 프레임 숫자와 LTC가 이를 따릅니다. LTC: {label}.',
    syncK: '화면 싱크 신호', fsSquare: '흑백 사각파', fsFlash: '짧은 플래시',
    grpLook: '화면', paletteK: '색상', pDefault: '기본', pWhite: '화이트', pRed: '레드', pLight: '라이트',
    langK: '언어', langAuto: '자동',
    grpCd: '카운트다운', customK: '맞춤 길이', edit: '변경',
    ltc23976: '23.976 (24프레임 타임코드)', ltcWait: 'LTC 준비 중',
    grpCal: '보정', ofsVideo: '영상 지연', ofsAudio: '오디오 지연',
    toolsD: '촬영 후 컴퓨터에서 소스를 분석합니다: 속도 비율, 보정 후 길이, 기준 파일에 맞추기. 파일은 업로드되지 않습니다.', openAnalyzer: '싱크 분석기 열기 (PC용)',
    resetD: '모든 설정을 기본값으로 되돌리고 씬을 지웁니다. 설정은 자동으로 저장되며, 두 번 눌러야 실행됩니다.',
    resetAll: '모든 설정 초기화', resetConfirm: '한 번 더 누르면 초기화', resetDone: '초기화됨',
    schedP: '지정한 시간에 자동으로 시작되며, 시작 전에는 음수 시간이 표시됩니다. 카운트다운은 아래에서 길이를 선택하세요. 카운트업은 0부터 시작합니다.',
    schedAt: '또는 시간 지정', startTime: '시작 시간', cancel: '취소', schedOk: '예약하기', quick: '{n}분 후',
    customTitle: '맞춤 카운트다운', customP: '저장하면 기억됩니다. 이후 ‘맞춤’을 누르면 카운트다운이 시작되며, 변경은 설정 화면에서 할 수 있습니다.',
    minutesAria: '분', secondsAria: '초', minUnit: '분', secUnit: '초', cErr: '1초 이상의 시간을 입력하세요.', cSave: '저장 후 사용',
    customChip: '맞춤 {d}', customAdd: '＋ 맞춤',
    gateP: '각 카메라에 3~5초씩 비추세요. 촬영 시작과 끝에 한 번씩 찍으세요. 녹음기는 비프음이 잘 녹음되도록 가까이 두세요.', gateWarn: '주의: 이 도구는 화면 전체가 흑백으로 깜박입니다(초당 한 번).', gateGo: '시작하기',
    durH: '{n}시간', durM: '{n}분', durS: '{n}초', durSep: ' ', whenToday: '{t}', whenTomorrow: '내일 {t}',
    stUpWait: '{when}에 카운트업 시작', stUpRun: '{t}부터 카운트업 중', stStopped: '정지됨', stUpIdle: '‘카운트업 시작’을 누르면 0부터 셉니다',
    stCdWait: '{when}에 시작, 길이 {dur}', stCdRun: '카운트다운 중', stCdDone: '시간 종료', stCdIdle: '길이를 누르면 시작, 다시 누르면 처음부터',
    errNoTime: '시작 시간을 입력하세요.', errBadTime: '시간 형식이 올바르지 않습니다.', errTooSoon: '현재 시간과 너무 가깝습니다. 10초 이후의 시간을 선택하거나 카운트다운 길이를 바로 누르세요.',
    pvToday: '오늘 {t}에 시작 (남은 시간 {left})', pvTomorrow: '내일 {t}에 시작 (남은 시간 {left})', pvUp: '0부터 카운트업', pvCd: '{when}에 종료, 카운트다운 길이 {dur}'
  }
};
var lang = pickLang();
function t(key, vars) {
  var s = I18N[lang][key];
  if (s === undefined) s = I18N.en[key];
  if (s === undefined) s = I18N['zh-Hant'][key];
  if (s === undefined) return key;
  return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? vars[k] : m; }) : s;
}
// Text that changes at run time (hint, reset button) is swapped by key, so a language switch re-renders it too.
function setKey(el, key) { el.setAttribute('data-i18n', key); el.textContent = t(key); }

var state = defaultState();
var running = false, endMs = 0, finished = false, waiting = false, startMs = 0, stoppedEl = 0;
var ctx = null, lastKey = '', planSched = false;
var MODE_BTNS = MODES.map(function (m) { return $('m' + { clock: 'Clock', up: 'Up', cd: 'Cd', tag: 'Tag', ltc: 'Ltc' }[m]); });

try {
  state = readState(JSON.parse(localStorage.getItem('slate-state') || '{}'));
  tag.value = localStorage.getItem('slate-tag') || '';
} catch (e) {}
// Restore a running or scheduled countdown after a reload.
try {
  var plan = JSON.parse(localStorage.getItem('slate-cd') || 'null'), nowR = wallNow();
  if (plan && plan.mode === 'up' && plan.start > nowR - 7 * 86400000) {
    startMs = plan.start; endMs = 0; state.mode = 'up';
    if (nowR < startMs) { waiting = true; planSched = true; } else running = true;
  } else if (plan && plan.end > nowR && plan.end - plan.start >= 1000 && plan.end - plan.start <= 35999000) {
    startMs = plan.start; endMs = plan.end; state.dur = Math.round((plan.end - plan.start) / 1000); state.mode = 'cd';
    if (nowR < startMs) { waiting = true; planSched = true; } else running = true;
  } else localStorage.removeItem('slate-cd');
} catch (e) {}
function save() { try { localStorage.setItem('slate-state', JSON.stringify(state)); } catch (e) {} }
tag.addEventListener('input', function () { try { localStorage.setItem('slate-tag', tag.value); } catch (e) {} });
tag.addEventListener('keydown', function (e) { if (e.key === 'Enter') tag.blur(); });

function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
function durLabel(s) {
  var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60, out = [];
  if (h) out.push(t('durH', { n: h })); if (m) out.push(t('durM', { n: m })); if (r || !out.length) out.push(t('durS', { n: r }));
  return out.join(t('durSep'));
}
function shortDur(s) {
  var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

// ---- Controls ----
function renderControls() {
  var row = secondRow(state.mode), busy = running || waiting;
  MODE_BTNS.forEach(function (b, i) {
    b.setAttribute('aria-pressed', state.mode === MODES[i]);
    b.disabled = modeLocked(MODES[i], state.mode, busy);
  });
  $('cdRow').hidden = !row;
  $('chips').hidden = row !== 'cd';
  if (typeof chipsFade === 'function') requestAnimationFrame(chipsFade);
  setKey($('hint'), hintKey(state.mode));
  $('muteBtn').setAttribute('aria-pressed', state.muted);
  var chips = $('chips').children;
  for (var i = 0; i < chips.length; i++) if (chips[i].dataset.dur) {
    chips[i].setAttribute('aria-pressed', +chips[i].dataset.dur === state.dur);
    chips[i].textContent = durLabel(+chips[i].dataset.dur);
  }
  customChip.textContent = state.custom ? t('customChip', { d: shortDur(state.custom) }) : t('customAdd');
  $('customVal').textContent = shortDur(state.custom || 7200);
  customChip.setAttribute('aria-pressed', !!state.custom && state.dur === state.custom);
  var g = $('go2'); g.textContent = running ? t('goStop') : waiting ? t('goCancelSched') : t(state.mode === 'up' ? 'goUp' : 'goCd');
  g.classList.toggle('stop', busy);
  g.hidden = state.mode === 'cd' && !busy;
  $('schedBtn').hidden = busy;
  lastKey = '';
}
DURS.forEach(function (s) {
  var c = document.createElement('button');
  c.className = 'chip'; c.dataset.dur = s;
  c.addEventListener('click', function () { state.dur = s; save(); startNow(); });
  $('chips').appendChild(c);
});

// Custom countdown: tap to use it, tap again (while selected) to edit.
var customChip = document.createElement('button');
customChip.className = 'chip';
customChip.addEventListener('click', function () {
  if (!state.custom) { openCustom(); return; }
  state.dur = state.custom; save(); startNow();
});
// Start on the next whole second so the flashes stay valid sync points; restarts if already running.
function startNow() { startPlan(Math.ceil(wallNow() / 1000) * 1000, false); }
$('chips').insertBefore(customChip, $('chips').firstChild);   // most-used, so first
function chipsFade() { var c = $('chips'); c.classList.toggle('more', c.scrollLeft + c.clientWidth < c.scrollWidth - 2); }
$('chips').addEventListener('scroll', chipsFade, { passive: true });
window.addEventListener('resize', chipsFade);
function openCustom() {
  var s = state.custom || 7200;
  $('cMin').value = Math.floor(s / 60); $('cSec').value = s % 60;
  $('cErr').hidden = true; $('customWrap').hidden = false;
}
$('cSave').addEventListener('click', function () {
  var m = parseInt($('cMin').value, 10) || 0, s = parseInt($('cSec').value, 10) || 0;
  var t = Math.min(35999, Math.max(0, m * 60 + s));
  if (t < 1) { $('cErr').hidden = false; return; }
  state.custom = t; state.dur = t; finished = false; save(); renderControls();
  $('customWrap').hidden = true;
});
$('cCancel').addEventListener('click', function () { $('customWrap').hidden = true; });
$('customWrap').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
['cMin', 'cSec'].forEach(function (id) {
  $(id).addEventListener('focus', function () { this.select(); });
  $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') $('cSave').click(); });
});
FPS_LIST.forEach(function (f) {
  var b = document.createElement('button');
  b.textContent = f; b.className = 'sel';
  b.addEventListener('click', function () { state.fps = f; save(); renderControls(); renderFpsGrid(); renderLtc(); if (ltc.on) ltcStart(); });
  $('fpsGrid').appendChild(b);
});
function renderFpsGrid() {
  var bs = $('fpsGrid').children;
  for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', FPS_LIST[i] === state.fps);
}
var resetTimer2 = null;
$('resetBtn2').addEventListener('click', function () {
  var b = this;
  clearTimeout(resetTimer2);
  if (!b.classList.contains('armed')) {
    b.classList.add('armed'); setKey(b, 'resetConfirm');
    resetTimer2 = setTimeout(function () { b.classList.remove('armed'); setKey(b, 'resetAll'); }, 3000);
    return;
  }
  doReset();
  b.classList.remove('armed'); setKey(b, 'resetDone');
  resetTimer2 = setTimeout(function () { setKey(b, 'resetAll'); }, 1500);
});
function doReset() {
  try { ['slate-state', 'slate-tag', 'slate-fps', 'slate-beep', 'slate-cd', 'slate-lang'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
  state = defaultState();
  renderPalette(); renderOfs(); renderSound(); renderVisual(); renderLtc();
  running = false; waiting = false; finished = false; tag.value = '';
  lang = pickLang(); applyI18n();
  renderControls(); renderFpsGrid(); applyAudio();
}
function openSettings() { renderFpsGrid(); renderLtc(); renderOfs(); renderSound(); renderVisual(); renderControls(); $('sheetWrap').hidden = false; $('sheetWrap').scrollTop = 0; }
$('settingsBtn').addEventListener('click', openSettings);
$('customEdit').addEventListener('click', openCustom);
$('sheetClose').addEventListener('click', function () { $('sheetWrap').hidden = true; });

// Modes (docs/slate-ui.md): the mode sets the screen and the sound. Leaving for a mode without a count ends the
// stopped count; while a count runs or waits, the other mode buttons are disabled.
MODE_BTNS.forEach(function (b, i) {
  b.addEventListener('click', function () {
    if (!isCount(MODES[i])) running = false;
    state.mode = MODES[i]; finished = false; save();
    renderControls(); renderVisual(); applyAudio();
  });
});
// Mute: silences every mode, the screen carries on.
$('muteBtn').addEventListener('click', function () { state.muted = !state.muted; save(); renderControls(); applyAudio(); });
// Start or stop LTC to match the mode and mute, then queue beeps / waveform code again from now. Sounds already
// playing are cut only when the kind of sound changed (lastKind is what was playing before).
var lastKind = 'off';
function applyAudio() {
  var kind = audioKind(state), hard = hardStop(lastKind, kind);
  lastKind = kind;
  if (kind !== 'off' && ctx && ctx.state === 'suspended') ctx.resume();
  if (kind === 'ltc' && !ltc.on) ltcStart();
  else if (kind !== 'ltc' && ltc.on) ltcStop();
  resetAudio(hard);
}
function startPlan(start, scheduled) {
  startMs = start; endMs = state.mode === 'up' ? 0 : start + state.dur * 1000; finished = false;
  waiting = !!scheduled; running = !scheduled; planSched = !!scheduled;
  savePlan(); renderControls(); resetAudio();
}
function cancelPlan() {
  // Stopping a running count-up freezes the elapsed time on screen.
  if (running && state.mode === 'up') { stoppedEl = wallNow() - startMs; running = false; waiting = false; finished = true; savePlan(); renderControls(); resetAudio(); return; }
  running = false; waiting = false; finished = false; savePlan(); renderControls(); resetAudio();
}
function savePlan() {
  try {
    if (running || waiting) localStorage.setItem('slate-cd', JSON.stringify({ start: startMs, end: endMs, mode: state.mode }));
    else localStorage.removeItem('slate-cd');
  } catch (e) {}
}
$('go2').addEventListener('click', function () {
  if (running || waiting) cancelPlan();
  // Align the countdown to real whole seconds so flashes stay valid sync points.
  else startPlan(Math.ceil(wallNow() / 1000) * 1000, false);
});

// ---- Scheduled start ----
function clockText(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function whenLabel(ms) { return t(new Date(ms).toDateString() === new Date().toDateString() ? 'whenToday' : 'whenTomorrow', { t: clockText(ms) }); }
var QUICK = [1, 5, 10, 30], schedSel = { type: 'rel', min: 5 }, schedTimer = null;
QUICK.forEach(function (n) {
  var q = document.createElement('button');
  q.className = 'sel'; q.textContent = t('quick', { n: n });
  q.addEventListener('click', function () { schedSel = { type: 'rel', min: n }; renderSched(); });
  $('schedQuick').appendChild(q);
});
function schedTarget() {
  var now = wallNow();
  if (schedSel.type === 'rel') return { t: Math.ceil(now / 1000) * 1000 + schedSel.min * 60000 };
  var v = $('schedTime').value;
  if (!v) return { err: t('errNoTime') };
  var p = v.split(':').map(Number), d = new Date(now);
  if (p.length < 2 || p.some(isNaN)) return { err: t('errBadTime') };
  d.setHours(p[0], p[1], p[2] || 0, 0);
  var at = d.getTime(), tomorrow = false;
  if (at <= now) { d.setDate(d.getDate() + 1); at = d.getTime(); tomorrow = true; }
  if (at - now < 10000) return { err: t('errTooSoon') };
  return { t: at, tomorrow: tomorrow };
}
function renderSchedDur() {
  var box = $('schedDur'), list = DURS.slice();
  if (state.custom && list.indexOf(state.custom) < 0) list.unshift(state.custom);
  box.hidden = $('schedDurK').hidden = state.mode !== 'cd';
  box.innerHTML = '';
  list.forEach(function (d) {
    var b = document.createElement('button');
    b.className = 'sel'; b.textContent = d === state.custom ? t('customChip', { d: shortDur(d) }) : durLabel(d);
    b.setAttribute('aria-pressed', d === state.dur);
    b.addEventListener('click', function () { state.dur = d; save(); renderSchedDur(); renderSched(); renderControls(); });
    box.appendChild(b);
  });
}
function renderSched() {
  var qs = $('schedQuick').children;
  for (var i = 0; i < qs.length; i++) {
    qs[i].setAttribute('aria-pressed', schedSel.type === 'rel' && schedSel.min === QUICK[i]);
    qs[i].textContent = t('quick', { n: QUICK[i] });
  }
  $('schedTime').classList.toggle('on', schedSel.type === 'abs');
  var r = schedTarget(), pv = $('schedPreview'), er = $('schedErr');
  $('schedOk').disabled = !!r.err;
  er.hidden = !r.err; er.textContent = r.err || '';
  if (r.err) { pv.textContent = ''; return; }
  var left = Math.ceil((r.t - wallNow()) / 1000);
  pv.textContent = t(r.tomorrow ? 'pvTomorrow' : 'pvToday', { t: clockText(r.t), left: durLabel(left) }) + '\n' +
    (state.mode === 'up' ? t('pvUp') : t('pvCd', { when: whenLabel(r.t + state.dur * 1000), dur: durLabel(state.dur) }));
  pv.classList.toggle('warn', !!r.tomorrow);
}
$('schedBtn').addEventListener('click', function () {
  var d = new Date(wallNow() + 5 * 60000); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  $('schedTime').value = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
  schedSel = { type: 'rel', min: 5 };
  renderSchedDur(); renderSched(); $('schedWrap').hidden = false;
  clearInterval(schedTimer); schedTimer = setInterval(renderSched, 250);
});
function closeSched() { $('schedWrap').hidden = true; clearInterval(schedTimer); }
$('schedCancel').addEventListener('click', closeSched);
$('schedWrap').addEventListener('click', function (e) { if (e.target === this) closeSched(); });
$('schedTime').addEventListener('input', function () { schedSel = { type: 'abs' }; renderSched(); });
$('schedTime').addEventListener('focus', function () { schedSel = { type: 'abs' }; renderSched(); });
$('schedOk').addEventListener('click', function () {
  var r = schedTarget();
  if (r.err) { renderSched(); return; }
  startPlan(r.t, true); closeSched();
});

$('stage').addEventListener('click', function () {
  if (document.activeElement === tag) { tag.blur(); return; }
  document.body.classList.toggle('clean');
  // The stage resizes now; don't wait for ResizeObserver, which is not always delivered promptly (seen in iframes).
  relayout();
});

// ---- Audio ----
var TONES = { tick: [1000, 0.08], minute: [2000, 0.4], warn: [1500, 0.12], end: [2000, 0.7] };
// ---- Audio scheduler: runs on its own timer (not the render loop), so a stalled or throttled frame
// can't drop a second; sounds are queued up to 0.7 s ahead on the audio clock and can be cancelled.
var schedUntil = 0, pendingNodes = [];
function audioTick() {
  if (!ctx) return;
  var rn = wallNow();
  var S = Math.max(schedUntil + 1000, Math.ceil((rn + 60) / 1000) * 1000);
  for (; S - rn <= 700; S += 1000) {
    scheduleWave(S);
    var k = beepKind(S);
    if (k) scheduleBeep(S, k);
    schedUntil = S;
  }
  if (pendingNodes.length > 64) pendingNodes = pendingNodes.filter(function (n) { return n.end > ctx.currentTime; });
}
// What (if anything) to beep at whole second S, from the plan's fixed times rather than live flags.
function beepKind(S) {
  if (state.mode === 'clock') return new Date(S).getSeconds() === 0 ? 'minute' : 'tick';
  if (!(running || waiting)) return null;
  if (S < startMs) { var r2 = startMs - S; return r2 <= 5000 ? 'warn' : 'tick'; }
  if (S === startMs && planSched) return 'minute';
  if (state.mode === 'up') return ((S - startMs) / 1000) % 60 === 0 ? 'minute' : 'tick';
  var r = endMs - S;
  if (r === 0) return 'end';
  return r > 0 ? (r <= 5000 ? 'warn' : 'tick') : null;
}
// Drop everything queued for the future (state changed) and queue again from now. hard: also stop what is playing
// (mute, or another kind of sound), fading it out over 5 ms so the cut does not click.
function resetAudio(hard) {
  if (ctx) {
    var t = ctx.currentTime;
    pendingNodes.forEach(function (n) {
      try {
        if (n.start > t) n.node.stop();
        else if (hard && n.end > t) {
          n.gain.gain.cancelScheduledValues(t); n.gain.gain.setValueAtTime(n.gain.gain.value, t);
          n.gain.gain.linearRampToValueAtTime(0, t + 0.005); n.node.stop(t + 0.006);
        }
      } catch (e) {}
    });
  }
  pendingNodes = []; schedUntil = 0;
  audioTick();
}
function track(node, gain, start, end) { pendingNodes.push({ node: node, gain: gain, start: start, end: end }); }

function scheduleBeep(targetMs, kind) {
  if (!ctx || audioKind(state) !== 'beep') return;
  var when = ctxTimeForWall(targetMs) - state.audOfs / 1000;
  if (when < ctx.currentTime) return;
  var t = TONES[kind], osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = 'square'; osc.frequency.value = t[0];
  g.gain.setValueAtTime(0.0001, when - 0.001);
  g.gain.setValueAtTime(0.5, when);
  g.gain.setValueAtTime(0.5, when + t[1]);
  g.gain.exponentialRampToValueAtTime(0.0001, when + t[1] + 0.01);
  osc.connect(g).connect(ctx.destination);
  osc.start(when - 0.002); osc.stop(when + t[1] + 0.03);
  track(osc, g, when - 0.002, when + t[1] + 0.03);
}

// ---- LTC timecode output (SMPTE 12M, bits and samples in src/core/slate.js) ----
var ltc = { on: false, p: null, T0: 0, sr: 48000, startCount: 0, frame: 0, sample: 0, level: 1, timer: null, sources: [] };
function audioLat() { return ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0; }
// Map a wall-clock time to the AudioContext time whose sample leaves the jack at that moment.
function ctxTimeForWall(wallMs) {
  var ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime > 0) return ts.contextTime + (wallMs - (WALL0 + ts.performanceTime)) / 1000;
  return ctx.currentTime + (wallMs - wallNow()) / 1000 - audioLat();
}
function ltcStopSources() { ltc.sources.forEach(function (s) { try { s.stop(); } catch (e) {} }); ltc.sources = []; }
function ltcStop() { ltc.on = false; clearInterval(ltc.timer); ltcStopSources(); }
function ltcStart() {
  if (!ctx) return;
  ltcStopSources();
  var p = ltcParams(state.fps, state.df), sr = ctx.sampleRate, lat = audioLat();
  var nowWall = wallNow();
  var d = new Date(nowWall), midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // First frame boundary at least 400 ms ahead, aligned to the wall clock when it leaves the jack.
  var F0 = Math.ceil((nowWall + 400 + lat * 1000 + Math.max(0, state.audOfs) - midnight) * p.rate / 1000);
  var bWall = midnight + F0 * 1000 / p.rate;
  var T0 = ctxTimeForWall(bWall) - state.audOfs / 1000;
  ltc.p = p; ltc.sr = sr; ltc.T0 = Math.round(T0 * sr) / sr; ltc.bWall = bWall; ltc.adj = 0; ltc.err = 0;
  ltc.startCount = (p.df || p.rate === p.nominal) ? F0 : Math.round(F0 / p.rate * p.nominal);
  ltc.frame = 0; ltc.sample = 0; ltc.level = 1; ltc.on = true;
  ltcPump();
  clearInterval(ltc.timer); ltc.timer = setInterval(ltcPump, 200);
}
function ltcPump() {
  if (!ltc.on || !ctx) return;
  if (ltc.T0 + ltc.sample / ltc.sr < ctx.currentTime + 0.05) { ltcStart(); return; } // fell behind: re-anchor
  while (ltc.T0 + ltc.sample / ltc.sr < ctx.currentTime + 1.2) ltcChunk(ltc, ctx, 8, ltcWant);
}
// Drift lock target for ltcChunk(): when half-bit g0 should leave the jack, in context time.
function ltcWant(g0) {
  var ots = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  if (!(ots && ots.performanceTime > 0)) return null;
  return ctxTimeForWall(ltc.bWall + g0 * 1000 / (ltc.p.rate * 80)) - state.audOfs / 1000;
}
function ltcLabel(p) {
  if (p.nominal === 24 && p.rate !== 24) return t('ltc23976');
  if (p.rate === 30000 / 1001) return p.df ? '29.97 DF' : '29.97 NDF';
  return String(p.nominal);
}
function ltcNowText(W) {
  if (state.mode === 'ltc' && state.muted) return t('ltcMuted');
  if (!ltc.on || !ctx) return '';
  var k = Math.floor((W - ltc.bWall) * ltc.p.rate / 1000);
  if (k < 0) return t('ltcWait');
  var tc = countToTC(ltc.startCount + k, ltc.p);
  return 'LTC ' + pad(tc.h) + ':' + pad(tc.m) + ':' + pad(tc.s) + (ltc.p.df ? ';' : ':') + pad(tc.f);
}
// Settings → LTC: the frame rate card says what the chosen rate does; DF / NDF can only be chosen for the 29.97 family.
function renderLtc() {
  var p = ltcParams(state.fps, state.df), df29 = dfSelectable(state.fps);
  $('fpsD').textContent = t('fpsD', { fps: state.fps, label: ltcLabel(p) }) + (state.fps > 30 ? t('fpsHigh') : '');
  $('dfBtn').disabled = $('ndfBtn').disabled = !df29;
  $('dfBtn').setAttribute('aria-pressed', df29 && state.df); $('ndfBtn').setAttribute('aria-pressed', df29 && !state.df);
  setKey($('dfD'), descKeys(state).df);
}
function setDf(v) { state.df = v; save(); renderLtc(); if (ltc.on) ltcStart(); }
$('dfBtn').addEventListener('click', function () { setDf(true); });
$('ndfBtn').addEventListener('click', function () { setDf(false); });
// ---- Waveform code (bursts and pitch in src/core/slate.js) ----
// One oscillator gated by sample-accurate gain steps. The oscillator starts at phase 0 exactly when the
// sync burst begins, so the leading edge is identical to a computed buffer; digit pulses are read by length only.
function wavePlay(ac, dest, when, val, isMin, hz) {
  var osc = ac.createOscillator(), g = ac.createGain();
  osc.frequency.value = hz;
  g.gain.setValueAtTime(0, Math.max(0, when - 0.005));
  waveBursts(val, isMin).forEach(function (b) { g.gain.setValueAtTime(b[2], when + b[0]); g.gain.setValueAtTime(0, when + b[1]); });
  osc.connect(g).connect(dest);
  osc.start(when); osc.stop(when + 0.96);
  return { osc: osc, gain: g };
}
function scheduleWave(targetMs) {
  if (!ctx || audioKind(state) !== 'wave') return;
  var when = ctxTimeForWall(targetMs) - state.audOfs / 1000;
  if (when < ctx.currentTime) return;
  var d = new Date(targetMs), sec = d.getSeconds(), isMin = sec === 0;
  var w = wavePlay(ctx, ctx.destination, when, isMin ? d.getMinutes() : sec, isMin, waveHz(cycleK(targetMs)));
  track(w.osc, w.gain, when, when + 0.96);
}
// Digit-mode sound (settings): beep or waveform code.
function renderSound() {
  $('sndBeep').setAttribute('aria-pressed', state.sound === 'beep'); $('sndWave').setAttribute('aria-pressed', state.sound === 'wave');
  setKey($('soundD'), descKeys(state).sound);
}
$('sndBeep').addEventListener('click', function () { state.sound = 'beep'; save(); renderSound(); applyAudio(); });
$('sndWave').addEventListener('click', function () { state.sound = 'wave'; save(); renderSound(); applyAudio(); });
// Screen: the digit modes use the sync signal setting; Tag and LTC show the AprilTag (body.atag), LTC with its time
// code line instead of the digits (body.ltcm).
function renderVisual() {
  var sc = screenOf(state);
  $('fsSquare').setAttribute('aria-pressed', state.flashStyle === 'square'); $('fsFlash').setAttribute('aria-pressed', state.flashStyle === 'flash');
  setKey($('syncD'), descKeys(state).sync);
  var cl = document.body.classList, changed = sc.tag !== cl.contains('atag') || sc.ltcLine !== cl.contains('ltcm');
  cl.toggle('sq', sc.sync === 'square');
  cl.toggle('ltcm', sc.ltcLine);
  cl.toggle('atag', sc.tag);
  // The digits' size depends on both: the Tag clock line is measured again after LTC mode hid it.
  if (changed) relayout();
}
$('fsSquare').addEventListener('click', function () { state.flashStyle = 'square'; save(); renderVisual(); });
$('fsFlash').addEventListener('click', function () { state.flashStyle = 'flash'; save(); renderVisual(); });

// ---- Visual code (AprilTag), see docs/visual-code.md; code table and bit layout in src/core/slate.js ----
var vtBand = $('vtBand'), vtTag = $('vtTag'), vtCtx = vtTag.getContext('2d', { alpha: false }), tagId = -1, bandOn = null;
function showTag(id) { drawTag(vtCtx, vtTag.width / 12, id); tagId = id; }
// The tag (12 cells) takes the digit area's short side, in whole device pixels per cell so no cell edge is resampled
// into grey, centred and snapped to the device pixel grid. Along the long side, each end gets a band strip at least
// 12 px wide if the leftover space allows, and the one-line digits go between the tag and the far strip.
function layoutTag() {
  if (!isCode(state.mode)) return;
  var W = stageEl.clientWidth, H = stageEl.clientHeight, dpr = window.devicePixelRatio || 1;
  var up = W <= H, shortS = up ? W : H, longS = up ? H : W;
  var cell = Math.max(1, Math.floor(shortS * dpr / 12)), side = cell * 12 / dpr;
  // Snap the tag's absolute position, not just its offset inside the stage, to the device pixel grid: the stage itself
  // can start mid-pixel (e.g. a 58 px header at DPR 2.625 is 152.25 device pixels).
  var sr = stageEl.getBoundingClientRect();
  function snap(origin, x) { var v = Math.round((origin + x) * dpr) / dpr - origin; return v < 0 ? v + 1 / dpr : v; }
  var off = snap(up ? sr.top : sr.left, (longS - side) / 2), cross = snap(up ? sr.left : sr.top, (shortS - side) / 2);
  var bw = Math.min(Math.floor(off), Math.max(12, Math.round(shortS * 0.06))), band = bw >= 12;
  var gap = Math.max(4, Math.round(Math.max(bw, 12) / 3));
  var t0 = off + side + gap, tl = longS - (band ? bw : 0) - gap - t0;
  function box(el, a, b, along, across) {   // a/along on the long axis, b/across on the short axis
    el.style.left = (up ? b : a) + 'px'; el.style.top = (up ? a : b) + 'px';
    el.style.width = (up ? across : along) + 'px'; el.style.height = (up ? along : across) + 'px';
  }
  box(vtTag, off, cross, side, side);
  var strips = vtBand.children;
  box(strips[0], 0, 0, bw, shortS); box(strips[1], longS - bw, 0, bw, shortS);
  strips[0].style.display = strips[1].style.display = band ? '' : 'none';
  var tx = $('stageText').style;
  tx.setProperty('--vt-tx', (up ? 0 : t0) + 'px'); tx.setProperty('--vt-ty', (up ? t0 : 0) + 'px');
  tx.setProperty('--vt-tw', (up ? W : Math.max(0, tl)) + 'px'); tx.setProperty('--vt-th', (up ? Math.max(0, tl) : H) + 'px');
  // In a thinner box the digit line would shrink below about 8 px and can't be read, so it is left out;
  // the tag itself still carries the time.
  tx.setProperty('--vt-tv', tl >= (up ? 24 : 64) ? 'visible' : 'hidden');
  // Check both sides: a fresh canvas is 300 x 150, so a 300 px tag would otherwise keep a height of 150.
  if (vtTag.width !== cell * 12 || vtTag.height !== cell * 12) { vtTag.width = vtTag.height = cell * 12; if (tagId >= 0) showTag(tagId); }
}
function renderPalette() {
  if (state.palette === 'default') document.documentElement.removeAttribute('data-palette');
  else document.documentElement.setAttribute('data-palette', state.palette);
  Array.prototype.forEach.call($('paletteSeg').children, function (b) {
    b.setAttribute('aria-pressed', b.getAttribute('data-p') === state.palette);
  });
  setKey($('paletteD'), descKeys(state).palette);
}
Array.prototype.forEach.call($('paletteSeg').children, function (b) {
  b.addEventListener('click', function () { state.palette = b.getAttribute('data-p'); save(); renderPalette(); });
});
// ---- Language: applied in place, never by reloading, which would stop the audio and bring back the start screen ----
function applyI18n() {
  document.documentElement.lang = lang;
  document.title = t('appTitle');
  Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-attr]'), function (el) {
    el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
      var kv = pair.split(':'); el.setAttribute(kv[0], t(kv[1]));
    });
  });
  renderLang(); renderControls(); renderLtc();
  if (!$('schedWrap').hidden) { renderSchedDur(); renderSched(); }
  statusKey = '';   // the main loop only rewrites the status line when this key changes
}
function langPref() {
  try { var s = localStorage.getItem('slate-lang'); return LANGS.indexOf(s) >= 0 ? s : 'auto'; } catch (e) { return 'auto'; }
}
function renderLang() {
  var pref = langPref();
  Array.prototype.forEach.call($('langSeg').children, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-l') === pref); });
  setKey($('langD'), descKeys(state, pref).lang);
}
Array.prototype.forEach.call($('langSeg').children, function (b) {
  b.addEventListener('click', function () {
    var v = b.getAttribute('data-l');
    try { if (v === 'auto') localStorage.removeItem('slate-lang'); else localStorage.setItem('slate-lang', v); } catch (e) {}
    lang = v === 'auto' ? pickLang() : v; applyI18n();
  });
});
// The analyzer page shares the choice: follow it when it changes in another tab.
window.addEventListener('storage', function (e) {
  if (e.key === 'slate-lang' || e.key === null) { lang = pickLang(); applyI18n(); }
});
function renderOfs() {
  function fmt(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' ms'; }
  $('dispOfsV').textContent = fmt(state.dispOfs); $('audOfsV').textContent = fmt(state.audOfs);
}
Array.prototype.forEach.call(document.querySelectorAll('.ofs-row button'), function (btn) {
  btn.addEventListener('click', function () {
    var k = btn.getAttribute('data-k');
    state[k] = Math.max(-500, Math.min(500, state[k] + Number(btn.getAttribute('data-d'))));
    save(); renderOfs();
    if (k === 'audOfs' && ltc.on) ltcStart();
    if (k === 'audOfs') resetAudio();
  });
});

// ---- Fit digits to width whatever font actually loads ----
var lastFw = 0, lastNeg = false;
function fit() {
  clockEl.style.setProperty('--k', '1');
  var oneLine = document.body.classList.contains('atag');   // AprilTag: both rows sit on one line, so widths add up
  var avail = (oneLine ? $('stageText') : $('stage')).clientWidth * 0.94, w = 0;
  var rows = clockEl.children;
  for (var i = 0; i < rows.length; i++) { var rw = rows[i].getBoundingClientRect().width; w = oneLine ? w + rw : Math.max(w, rw); }
  clockEl.style.setProperty('--k', w > avail ? (avail / w).toFixed(3) : '1');
}
// The digits are fitted after the tag, because with AprilTag their box is the space the tag leaves.
function relayout() { layoutTag(); fit(); }
window.addEventListener('resize', relayout);
if (window.ResizeObserver) new ResizeObserver(relayout).observe($('stage'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

// ---- Main loop ----
// Each frame is drawn for the instant it reaches the screen: vsync time + one refresh interval + user offset.
// DOM is written only where a value actually changed; flash and square wave are compositor-only.
var ltcShownAt = -1e9;
var frameInt = 1000 / 60, lastTs = 0, cache = {}, flashOn = null, waveOn = null, statusKey = '';
var elH = $('cH'), elM = $('cM'), elS = $('cS'), elF = $('cF'), elNeg = $('cNeg'), elLtc = $('ltcNow');
var flashEl = $('flash'), stageEl = $('stage'), headerEl = document.querySelector('header.top');
function setText(el, k, v) { if (cache[k] !== v) { cache[k] = v; el.textContent = v; } }
function statusFor() {
  if (!isCount(state.mode)) return ['', false];
  if (state.mode === 'up') {
    if (waiting) return [t('stUpWait', { when: whenLabel(startMs) }), false];
    if (running) return [t('stUpRun', { t: clockText(startMs) }), false];
    if (finished) return [t('stStopped'), false];
    return [t('stUpIdle'), false];
  }
  if (waiting) return [t('stCdWait', { when: whenLabel(startMs), dur: durLabel(state.dur) }), false];
  if (running) return [t('stCdRun'), false];
  if (finished) return [t('stCdDone'), true];
  return [t('stCdIdle'), false];
}
function frame(ts) {
  if (lastTs) { var dt = ts - lastTs; if (dt > 4 && dt < 50) frameInt += (dt - frameInt) * 0.05; }
  lastTs = ts;
  var now = WALL0 + ts + frameInt + state.dispOfs;
  var fps = state.fps, fw = fps >= 100 ? 3 : 2, maxF = Math.ceil(fps) - 1;
  var h, m, s, f, active, neg = false, ms;

  if (!isCount(state.mode)) {     // clock, Tag and LTC: the phone clock
    var sec = Math.floor(now / 1000), d = new Date(sec * 1000);
    h = d.getHours(); m = d.getMinutes(); s = d.getSeconds(); ms = now - sec * 1000;
    active = true;
  } else {
    if (waiting && now >= startMs) { waiting = false; running = true; setTimeout(renderControls, 0); }
    var t;
    if (state.mode === 'up') {
      if (waiting) t = startMs - now;
      else if (running) t = Math.max(0, now - startMs);
      else t = finished ? stoppedEl : 0;
      active = running || waiting;
    } else {
      if (waiting) t = startMs - now;
      else if (running) {
        t = endMs - now;
        if (t <= 0) { running = false; finished = true; t = 0; setTimeout(function () { savePlan(); renderControls(); }, 0); }
      } else t = finished ? 0 : state.dur * 1000;
      if (!waiting) t = Math.min(t, state.dur * 1000);
      active = running || waiting || (finished && now - endMs < 1000);
    }
    neg = waiting;
    var tsec = Math.floor(t / 1000);
    h = Math.floor(tsec / 3600); m = Math.floor(tsec % 3600 / 60); s = tsec % 60; ms = t - tsec * 1000;
  }
  f = Math.min(maxF, Math.floor(ms * fps / 1000));

  setText(elH, 'h', pad(h)); setText(elM, 'm', pad(m)); setText(elS, 's', pad(s)); setText(elF, 'f', pad(f, fw));
  if (fw !== lastFw || neg !== lastNeg) {
    lastFw = fw; lastNeg = neg;
    clockEl.classList.toggle('wide', fw === 3); elNeg.hidden = !neg; fit();
  }
  var sk = [state.mode, running, waiting, finished, startMs, state.dur].join('|');
  if (sk !== statusKey) { statusKey = sk; var st = statusFor(); statusEl.textContent = st[0]; statusEl.classList.toggle('done', st[1]); }
  if (ltc.on || (state.mode === 'ltc' && state.muted) ? ts - ltcShownAt >= 100 : cache.ltc) { ltcShownAt = ts; setText(elLtc, 'ltc', ltcNowText(now)); }

  var realPart = ((now % 1000) + 1000) % 1000;
  var wOn = active && realPart < 500, sync = screenOf(state).sync, vt = sync === 'band';
  var fOn = sync === 'square' ? wOn : sync === 'flash' && active && realPart < FLASH_MS;
  if (fOn !== flashOn) {
    flashOn = fOn; flashEl.style.opacity = fOn ? '1' : '0';
    stageEl.classList.toggle('inv', fOn); headerEl.classList.toggle('inv', fOn);
  }
  if (wOn !== waveOn) { waveOn = wOn; wave.style.transform = wOn ? 'scaleX(1)' : 'scaleX(0)'; }
  // AprilTag: the band's black-to-white and the new tag ID come from this same `now`, so they are one event with
  // the square wave and the waveform code. Both follow the real clock in every mode, idle and waiting included.
  if (vt) {
    var bOn = realPart < 500;
    if (bOn !== bandOn) { bandOn = bOn; vtBand.style.opacity = bOn ? '1' : '0'; }
    var id = cycleK(now);
    if (id !== tagId) showTag(id);
  }

  requestAnimationFrame(frame);
}

// ---- Overlays (start screen and dialogs): focus moves in, the rest of the page is inert, Esc closes,
// and focus returns to the control that opened it. Watches each overlay's "hidden" attribute, so every
// existing open/close path is covered without touching it. Overlays can stack (custom over settings).
var layers = [];
var CLOSERS = { gate: null, sheetWrap: 'sheetClose', schedWrap: 'schedCancel', customWrap: 'cCancel' };
function applyInert() {
  var top = layers.length ? layers[layers.length - 1].el : null;
  Array.prototype.forEach.call(document.body.children, function (c) {
    if (c.tagName !== 'SCRIPT') c.inert = !!top && c !== top;
  });
}
Object.keys(CLOSERS).forEach(function (id) {
  var el = $(id);
  function sync() {
    var idx = -1;
    for (var i = 0; i < layers.length; i++) if (layers[i].el === el) idx = i;
    if (!el.hidden && idx < 0) {
      layers.push({ el: el, opener: document.activeElement });
      applyInert();
      var f = id === 'gate' ? $('go') : el.querySelector('button:not([hidden]), input, select, textarea, a[href]');
      if (f) f.focus();
    } else if (el.hidden && idx >= 0) {
      var l = layers.splice(idx, 1)[0];
      applyInert();
      if (l.opener && l.opener !== document.body && document.contains(l.opener) && l.opener.focus) l.opener.focus();
    }
  }
  new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  sync();
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || !layers.length) return;
  var btn = CLOSERS[layers[layers.length - 1].el.id];
  if (btn) { e.preventDefault(); $(btn).click(); }
});

// ---- Start / keep awake ----
function keepAwake() {
  var w = $('wakeHint');
  if (!('wakeLock' in navigator)) { setKey(w, 'hintNoWake'); w.hidden = false; return; }
  navigator.wakeLock.request('screen').then(function () { w.hidden = true; }, function () {
    setKey(w, 'hintWakeFail'); w.hidden = false;
  });
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') WALL0 = Date.now() - performance.now(); // re-anchor after sleep
  if (document.visibilityState === 'visible' && ctx) {
    keepAwake();
    if (audioKind(state) === 'ltc') { if (ctx.state !== 'running') ctx.resume(); ltcStart(); }
    resetAudio();
  }
});
$('go').addEventListener('click', function () {
  try {
    var el = document.documentElement, rf = el.requestFullscreen || el.webkitRequestFullscreen;
    if (rf) { var p = rf.call(el); if (p && p.catch) p.catch(function () {}); }
  } catch (e) {}
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    var resumed = ctx.state === 'suspended' ? ctx.resume() : null;
    Promise.resolve(resumed).then(applyAudio);
    setInterval(audioTick, 100);
  } catch (e) { ctx = null; }
  keepAwake();
  $('gate').hidden = true;
});

applyI18n();
renderControls(); renderLtc(); renderOfs(); renderSound(); renderVisual(); renderPalette();
// Installable app: offline cache (only where a service worker can run: https or localhost).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}
requestAnimationFrame(frame);
