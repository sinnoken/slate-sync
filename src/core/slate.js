// slate.js — 場記板的編碼：波形碼（docs/waveform-code.md）、LTC 輸出（docs/ltc.md）、畫面碼 tag（docs/visual-code.md）。
// 場記板頁面、分析核心、測試與測試產生器共用這一份；這裡只有計算，播放與畫面由呼叫端負責。

// Position in the 9-minute cycle shared by the waveform carrier and the visual tag: k = seconds since local
// midnight mod 540 for the whole second containing `ms`. Both derive from this one function, so a second's
// tag ID and its carrier pitch always encode the same k. See docs/waveform-code.md and docs/visual-code.md.
export function cycleK(ms) {
  var d = new Date(Math.floor(ms / 1000) * 1000);
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) % 540;
}

// ---- Waveform code: readable by eye in an editor's waveform view ----
// Each second: tall sync burst whose leading edge is the whole second, then two groups of short
// pulses counting the tens and units of the second. At :00 the sync burst is long and the pulses
// give the minute instead. Each second also uses its own carrier pitch (one of eleven pentatonic notes, never
// the same twice in a row): invisible in a waveform view, but it stops audio auto-sync from locking one second off.
export var WAVE_HI = 0.9, WAVE_LO = 0.45;
// Eleven pentatonic pitches (D5–D7); with the second, the pitch gives back k. Neighbouring seconds never share one.
export var WAVE_PITCHES = [587.33, 659.26, 783.99, 880.00, 987.77, 1174.66, 1318.51, 1567.98, 1760.00, 1975.53, 2349.32];
export function waveHz(k) { return WAVE_PITCHES[(Math.floor(k / 60) + 4 * (k % 60)) % 11]; }
// Burst list for one second: [start s, end s, amplitude]. See docs/waveform-code.md.
export function waveBursts(val, isMin) {
  var out = [[0, isMin ? 0.25 : 0.04, WAVE_HI]];
  function digit(t, v) { // returns the end time of the group
    if (v === 0) { out.push([t, t + 0.1, WAVE_LO]); return t + 0.1; }
    for (var k = 0; k < v; k++) out.push([t + k * 0.04, t + k * 0.04 + 0.02, WAVE_LO]);
    return t + v * 0.04 - 0.02;
  }
  var end = digit(isMin ? 0.3 : 0.1, Math.floor(val / 10));
  digit(end + 0.1, val % 10);
  return out;
}

// ---- LTC timecode output (SMPTE 12M biphase-mark, 80 bits per frame) ----
export var LTC_AMP = 0.5;
export var LTC_SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
export var LTC_DF_DAY = 2589408;                      // frames in a day at 29.97 DF
// LTC format for the slate's frame rate: real frame rate, frames counted per second, drop frame (29.97 family only).
export function ltcParams(fps, df) {
  if (fps === 23.976) return { rate: 24000 / 1001, nominal: 24, df: false };
  if (fps === 24 || fps === 48) return { rate: 24, nominal: 24, df: false };
  if (fps === 25 || fps === 50 || fps === 100) return { rate: 25, nominal: 25, df: false };
  if (fps === 29.97 || fps === 59.94 || fps === 119.88) return { rate: 30000 / 1001, nominal: 30, df: !!df };
  return { rate: 30, nominal: 30, df: false };
}
export function countToTC(n, p) {
  var day = p.df ? LTC_DF_DAY : p.nominal * 86400;
  n = ((n % day) + day) % day;
  if (p.df) { var D = Math.floor(n / 17982), M = n % 17982; n += 18 * D + (M > 1 ? 2 * Math.floor((M - 2) / 1798) : 0); }
  var nb = p.nominal;
  return { h: Math.floor(n / (nb * 3600)) % 24, m: Math.floor(n / (nb * 60)) % 60, s: Math.floor(n / nb) % 60, f: n % nb };
}
export function ltcBits(n, p) {
  var t = countToTC(n, p), bits = [], i;
  for (i = 0; i < 80; i++) bits.push(0);
  function put(v, at, len) { for (var j = 0; j < len; j++) bits[at + j] = (v >> j) & 1; }
  put(t.f % 10, 0, 4); put(Math.floor(t.f / 10), 8, 2); bits[10] = p.df ? 1 : 0;
  put(t.s % 10, 16, 4); put(Math.floor(t.s / 10), 24, 3);
  put(t.m % 10, 32, 4); put(Math.floor(t.m / 10), 40, 3);
  put(t.h % 10, 48, 4); put(Math.floor(t.h / 10), 56, 2);
  for (i = 0; i < 16; i++) bits[64 + i] = LTC_SYNC[i];
  var ones = 0; for (i = 0; i < 80; i++) ones += bits[i];
  bits[p.nominal === 25 ? 59 : 27] = ones % 2; // polarity bit: keep an even count of ones
  return bits;
}
// Queues the next nFrames of LTC on AudioContext `ac`. `ltc` is the running output state (p, sr, T0, startCount,
// frame, sample, level, adj, err, sources); want(g0) gives the context time at which half-bit g0 should leave the
// jack, or null when the browser has no output timestamp (then the drift lock stays out).
export function ltcChunk(ltc, ac, nFrames, want) {
  var p = ltc.p, sr = ltc.sr, spb = sr / (p.rate * 80);
  var g0 = ltc.frame * 80, s0 = ltc.sample;
  // Drift lock: the audio clock and the wall clock run on different crystals. Measure the error each chunk
  // (smoothed) and nudge the waveform by one sample when it exceeds 2 ms, so LTC never wanders from the display.
  var w = want ? want(g0) : null;
  if (w !== null) {
    ltc.err += ((ltc.T0 + s0 / sr - w) * 1000 - ltc.err) * 0.05;
    if (ltc.err > 2) { ltc.adj -= 1; ltc.err -= 1000 / sr; }
    else if (ltc.err < -2) { ltc.adj += 1; ltc.err += 1000 / sr; }
  }
  var adj = ltc.adj;
  function pos(x) { return Math.round(x * spb) + adj - s0; }
  var s1 = pos(g0 + nFrames * 80) + s0;
  var buf = ac.createBuffer(1, s1 - s0, sr), dat = buf.getChannelData(0), lvl = ltc.level;
  for (var fi = 0; fi < nFrames; fi++) {
    var bits = ltcBits(ltc.startCount + ltc.frame + fi, p);
    for (var b = 0; b < 80; b++) {
      var g = g0 + fi * 80 + b, i;
      var a = (fi === 0 && b === 0) ? 0 : pos(g), mid = pos(g + 0.5), e = pos(g + 1);
      lvl = -lvl;
      for (i = a; i < mid; i++) dat[i] = lvl * LTC_AMP;
      if (bits[b]) lvl = -lvl;
      for (i = mid; i < e; i++) dat[i] = lvl * LTC_AMP;
    }
  }
  ltc.level = lvl;
  var src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
  src.onended = function () { var k = ltc.sources.indexOf(src); if (k >= 0) ltc.sources.splice(k, 1); };
  src.start(ltc.T0 + s0 / sr);
  ltc.sources.push(src);
  ltc.frame += nFrames; ltc.sample = s1;
}

// ---- Visual code (AprilTag), see docs/visual-code.md ----
//! tag36h11 code table and bit layout: AprilRobotics/apriltag tag36h11.c @ b7c0ebe (BSD-2-Clause, see THIRD_PARTY_NOTICES.md)
export var TAG36H11_CODES = [0xd7e00984b, 0xdda664ca7, 0xdc4a1c821, 0xe17b470e9, 0xef91d01b1, 0xf429cdd73, 0x5da29225, 0x1106cba43, 0x223bed79d, 0x21f51213c, 0x33eb19ca6, 0x3f76eb0f8, 0x469a97414, 0x45dcfe0b0, 0x4a6465f72, 0x51801db96, 0x5eb946b4e, 0x68a7cc2ec, 0x6f0ba2652, 0x78765559d, 0x87b83d129, 0x86cc4a5c5, 0x8b64df90f, 0x9c577b611, 0xa3810f2f5, 0xaf4d75b83, 0xb59a03fef, 0xbb1096f85, 0xd1b92fc76, 0xd0dd509d2, 0xe2cfda160, 0x2ff497c63, 0x47240671b, 0x5047a2e55, 0x635ca87c7, 0x691254166, 0x68f43d94a, 0x6ef24bdb6, 0x8cdd8f886, 0x9de96b718, 0xaff6e5a8a, 0xbae46f029, 0xd225b6d59, 0xdf8ba8c01, 0xe3744a22f, 0xfbb59375d, 0x18a916828, 0x22f29c1ba, 0x286887d58, 0x41392322e, 0x75d18ecd1, 0x87c302743, 0x8c6317ba9, 0x9e40f36d7, 0xc0e5a806a, 0xcc78cb87c, 0x12d2f2d01, 0x379f36a21, 0x6973f59ac, 0x7789ea9f4, 0x8f1c73e84, 0x8dd287a20, 0x94a4eee4c, 0xa455379b5, 0xa9e92987d, 0xbd25cb40b, 0xbe98d3582, 0xd3d5972b2, 0x14c53d7c7, 0x4f1796936, 0x4e71fed1a, 0x66d46fae0, 0xa55abb933, 0xebee1acca, 0x1ad4ba6a4, 0x305b17571, 0x553611351, 0x59ca62775, 0x7819cb6a1, 0xedb7bc9eb, 0x5b2694212, 0x72e12d185, 0xed6152e2c, 0x5bcdadbf3, 0x78e0aa0c6, 0xc60a0b909, 0xef9a34b0d, 0x398a6621a, 0xa8a27c944, 0x4b564304e, 0x52902b4e2, 0x857280b56, 0xa91b2c84b, 0xe91df939b, 0x1fa405f28, 0x23793ab86, 0x68c17729f, 0x9fbf3b840, 0x36922413c, 0x4eb5f946e, 0x533fe2404, 0x63de7d35e, 0x925eddc72, 0x99b8b3896, 0xaace4c708, 0xc22994af0, 0x8f1eae41b, 0xd95fb486c, 0x13fb77857, 0x4fe0983a3, 0xd559bf8a9, 0xe1855d78d, 0xfec8daaad, 0x71ecb6d95, 0xdc9e50e4c, 0xca3a4c259, 0x740d12bbf, 0xaeedd18e0, 0xb509b9c8e, 0x5232fea1c, 0x19282d18b, 0x76c22d67b, 0x936beb34b, 0x8a5ea8dd, 0x679eadc28, 0xa08e119c5, 0x20a6e3e24, 0x7eab9c239, 0x96632c32e, 0x470d06e44, 0x8a70212fb, 0xa7e4251b, 0x9ec762cc0, 0xd8a3a1f48, 0xdb680f346, 0x4a1e93a9d, 0x638ddc04f, 0x4c2fcc993, 0x1ef28c95, 0xbf0d9792d, 0x6d27557c3, 0x623f977f4, 0x35b43be57, 0xbb0c428d5, 0xa6f01474d, 0x5a70c9749, 0x20ddabc3b, 0x2eabd78cf, 0x90aa18f88, 0xa9ea89350, 0x3cdb39b22, 0x839a08f34, 0x169bb814e, 0x1a575ab08, 0xa04d3d5a2, 0xbf7902f2b, 0x95a5e65c, 0x92e8fce94, 0x67ef48d12, 0x6400dbcac, 0xb12d8fb9f, 0x347f45d3, 0xb35826f56, 0xc546ac6e4, 0x81cc35b66, 0x41d14bd57, 0xc052b168, 0x7d6ce5018, 0xab4ed5ede, 0x5af817119, 0xd1454b182, 0x2badb090b, 0x3fcb4c0c, 0x2f1c28fd8, 0x93608c6f7, 0x4c93ba2b5, 0x7d950a5d, 0xe54b3d3fc, 0x15560cf9d, 0x189e4958a, 0x62140e9d2, 0x723bc1cdb, 0x2063f26fa, 0xfa08ab19f, 0x7955641db, 0x646b01daa, 0x71cd427cc, 0x9a42f7d4, 0x717edc643, 0x15eb94367, 0x8392e6bb2, 0x832408542, 0x2b9b874be, 0xb21f4730d, 0xb5d8f24c9, 0x7dbaf6931, 0x1b4e33629, 0x13452e710, 0xe974af612, 0x1df61d29a, 0x99f2532ad, 0xe50ec71b4, 0x5df0a36e8, 0x4934e4cea, 0xe34a0b4bd, 0xb7b26b588, 0xf255118d, 0xd0c8fa31e, 0x6a50c94f, 0xf28aa9f06, 0x131d194d8, 0x622e3da79, 0xac7478303, 0xc8f2521d7, 0x6c9c881f5, 0x49e38b60a, 0x513d8df65, 0xd7c2b0785, 0x9f6f9d75a, 0x9f6966020, 0x1e1a54e33, 0xc04d63419, 0x946e04cd7, 0x1bdac5902, 0x56469b830, 0xffad59569, 0x86970e7d8, 0x8a4b41e12, 0xad4688e3b, 0x85f8f5df4, 0xd833a0893, 0x2a36fdd7c, 0xd6a857cf2, 0x8829bc35c, 0x5e50d79bc, 0xfbb8035e4, 0xc1a95bebf, 0x36b0baf8, 0xe0da964ea, 0xb6483689b, 0x7c8e2f4c1, 0x5b856a23b, 0x2fc183995, 0xe914b6d70, 0xb31041969, 0x1bb478493, 0x63e2b456, 0xf2a082b9c, 0x8e5e646ea, 0x8172f8f6, 0xdacd923e, 0xe5dcf0e2e, 0xbf9446bae, 0x4822d50d1, 0x26e710bf5, 0xb90ba2a24, 0xf3b25aa73, 0x809ad589b, 0x94cc1e254, 0x5334a3adb, 0x592886b2f, 0xbf64704aa, 0x566dbf24c, 0x72203e692, 0x64e61e809, 0xd7259aad6, 0x7b924aedc, 0x2df2184e8, 0x353d1eca7, 0xfce30d7ce, 0xf7b0f436e, 0x57e8d8f68, 0x8c79e60db, 0x9c8362b2b, 0x63a5804f2, 0x9298353dc, 0x6f98a71c8, 0xa5731f693, 0x21ca5c870, 0x1c2107fd3, 0x6181f6c39, 0x19e574304, 0x329937606, 0x43d5c70d, 0x9b18ff162, 0x8e2ccfebf, 0x72b7b9b54, 0x9b71f4f3c, 0x935d7393e, 0x65938881a, 0x6a5bd6f2d, 0xa19783306, 0xe6472f4d7, 0x81163df5a, 0xa838e1cbd, 0x982748477, 0x50c54feb, 0xd82fbb58, 0x2c4c72799, 0x97d259ad6, 0x22d9a43ed, 0xfdb162a9f, 0xcb4a727d, 0x4fae2e371, 0x535b5be8b, 0x48795908a, 0xce7c18962, 0x4ea154d80, 0x50c064889, 0x8d97fc75d, 0xc8bd9ec61, 0x83ee8e8bb, 0xc8431419a, 0x1aa78079d, 0x8111aa4a5, 0xdfa3a69fe, 0x51630d83f, 0x2d930fb3f, 0x2133116e5, 0xae5395522, 0xbc07a4e8a, 0x57bf08ba0, 0x6cb18036a, 0xf0e2e4b75, 0x3eb692b6f, 0xd8178a3fa, 0x238cce6a6, 0xe97d5cdd7, 0xfe10d8d5e, 0xb39584a1d, 0xca03536fd, 0xaa61f3998, 0x72ff23ec2, 0x15aa7d770, 0x57a3a1282, 0xd1f3902dc, 0x6554c9388, 0xfd01283c7, 0xe8baa42c5, 0x72cee6adf, 0xf6614b3fa, 0x95c3778a2, 0x7da4cea7a, 0xd18a5912c, 0xd116426e5, 0x27c17bc1c, 0xb95b53bc1, 0xc8f937a05, 0xed220c9bd, 0xc97d72ab, 0x8fb1217ae, 0x25ca8a5a1, 0xb261b871b, 0x1bef0a056, 0x806a51179, 0xeed249145, 0x3f82aeceb, 0xcc56e9acf, 0x2e78d01eb, 0x102cee17f, 0x37caad3d5, 0x16ac5b1ee, 0x2af164ece, 0xd4cd81dc9, 0x12263a7e7, 0x57ac7d117, 0x9391d9740, 0x7aedaa77f, 0x9675a3c72, 0x277f25191, 0xebb6e64b9, 0x7ad3ef747, 0x12759b181, 0x948257d4d, 0xb63a850f6, 0x3a52a8f75, 0x4a019532c, 0xa021a7529, 0xcc661876d, 0x4085afd05, 0xe7048e089, 0x3f979cdc6, 0xd9da9071b, 0xed2fc5b68, 0x79d64c3a1, 0xfd44e2361, 0x8eea46a74, 0x42233b9c2, 0xae4d1765d, 0x7303a094c, 0x2d7033abe, 0x3dcc2b0b4, 0xf0967d09, 0x6f0cd7de, 0x9807aca0, 0x3a295cad3, 0x2b106b202, 0x3f38a828e, 0x78af46596, 0xbda2dc713, 0x9a8c8c9d9, 0x6a0f2ddce, 0xa76af6fe2, 0x86f66fa4, 0xd52d63f8d, 0x89f7a6e73, 0xcc6b23362, 0xb4ebf3c39, 0x564f300fa, 0xe8de3a706, 0x79a033b61, 0x765e160c5, 0xa266a4f85, 0xa68c38c24, 0xdca0711fb, 0x85fba85ba, 0x37a207b46, 0x158fcc4d0, 0x569d79b3, 0x7b1a25555, 0xa8ae22468, 0x7c592bdfd, 0xc59a5f66, 0xb1115daa3, 0xf17c87177, 0x6769d766b, 0x2b637356d, 0x13d8685ac, 0xf24cb6ec0, 0xbd0b56d1, 0x42ff0e26d, 0xb41609267, 0x96f9518af, 0xc56f96636, 0x4a8e10349, 0x863512171, 0xea455d86c, 0xbd0e25279, 0xe65e3f761, 0x36c84a922, 0x85fd1b38f, 0x657c91539, 0x15033fe04, 0x9051c921, 0xab27d80d8, 0xf92f7d0a1, 0x8eb6bb737, 0x10b5b0f63, 0x6c9c7ad63, 0xf66fe70ae, 0xca579bd92, 0x956198e4d, 0x29e4405e5, 0xe44eb885c, 0x41612456c, 0xea45e0abf, 0xd326529bd, 0x7b2c33cef, 0x80bc9b558, 0x7169b9740, 0xc37f99209, 0x31ff6dab9, 0xc795190ed, 0xa7636e95f, 0x9df075841, 0x55a083932, 0xa7cbdf630, 0x409ea4ef0, 0x92a1991b6, 0x4b078dee9, 0xae18ce9e4, 0x5a6e1ef35, 0x1a403bd59, 0x31ea70a83, 0x2bc3c4f3a, 0x5c921b3cb, 0x42da05c5, 0x1f667d16b, 0x416a368cf, 0xfbc0a7a3b, 0x9419f0c7c, 0x81be2fa03, 0x34e2c172f, 0x28648d8ae, 0xc7acbb885, 0x45f31eb6a, 0xd1cfc0a7b, 0x42c4d260d, 0xcf6584097, 0x94b132b14, 0x3c5c5df75, 0x8ae596fef, 0xaea8054eb, 0xae9cc573, 0x496fb731b, 0xebf105662, 0xaf9c83a37, 0xc0d64cd6b, 0x7b608159a, 0xe74431642, 0xd6fb9d900, 0x291e99de0, 0x10500ba9a, 0x5cd05d037, 0xa87254fb2, 0x9d7824a37, 0x8b2c7b47c, 0x30c788145, 0x2f4e5a8be, 0xbadb884da, 0x26e0d5c9, 0x6fdbaa32e, 0x34758eb31, 0x565cd1b4f, 0x2bfd90fb0, 0x93052a6b, 0xd3c13c4b9, 0x2daea43bf, 0xa279762bc, 0xf1bd9f22c, 0x4b7fec94f, 0x545761d5a, 0x7327df411, 0x1b52a442e, 0x49b0ce108, 0x24c764bc8, 0x374563045, 0xa3e8f91c6, 0xe6bd2241, 0xe0e52ee3c, 0x7e8e3caa, 0x96c2b7372, 0x33acbdfda, 0xb15d91e54, 0x464759ac1, 0x6886a1998, 0x57f5d3958, 0x5a1f5c1f5, 0xb58158ad, 0xe712053fb, 0x5352ddb25, 0x414b98ea0, 0x74f89f546, 0x38a56b3c3, 0x38db0dc17, 0xaa016a755, 0xdc72366f5, 0xcee93d75, 0xb2fe7a56b, 0xa847ed390, 0x8713ef88c, 0xa217cc861, 0x8bca25d7b, 0x455526818, 0xea3a7a180, 0xa9536e5e0, 0x9b64a1975, 0x5bfc756bc, 0x46aa169b, 0x53a17f76f, 0x4d6815274, 0xcca9cf3f6, 0x4013fcb8b, 0x3d26cdfa5, 0x5786231f7, 0x7d4ab09ab, 0x960b5ffbc, 0x8914df0d4, 0x2fc6f2213, 0xac235637e, 0x151b28ed3, 0x46f79b6db, 0x1382e0c9f, 0x53abf983a, 0x383c47ade, 0x3fcf88978, 0xeb9079df7, 0x9af0714d, 0xda19d1bb7, 0x9a02749f8, 0x1c62dab9b, 0x1a137e44b, 0x2867718c7, 0x35815525b, 0x7cd35c550, 0x2164f73a0, 0xe8b772fe0];
export var TAG36H11_BIT_X = [1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4, 1, 1, 1, 1, 1, 2, 2, 2, 3];
export var TAG36H11_BIT_Y = [1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4];
// 12 x 12 cells: one white quiet-zone cell around the official 10 x 10 layout (white ring, black ring, then data
// bit i at row bit_y[i] + 1, column bit_x[i] + 1, white when bit 35 - i of the code is set). Drawn on `g`, a 2D
// context (or anything with fillStyle and fillRect), n whole pixels per cell.
export function drawTag(g, n, id) {
  var code = TAG36H11_CODES[id];
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 12 * n, 12 * n);
  g.fillStyle = '#000000'; g.fillRect(2 * n, 2 * n, 8 * n, 8 * n);
  g.fillStyle = '#ffffff';
  for (var i = 0; i < 36; i++) {
    // Division instead of bit shifts: codes are 36 bits, wider than the 32-bit integer operators.
    if (Math.floor(code / Math.pow(2, 35 - i)) % 2) g.fillRect((TAG36H11_BIT_X[i] + 2) * n, (TAG36H11_BIT_Y[i] + 2) * n, n, n);
  }
}
