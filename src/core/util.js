// util.js — 共用的數值工具：模數、百分位、直線擬合（分析核心，無 DOM、無檔案存取）。
export function percentile(arr, q) {
  const s = Float64Array.from(arr).sort();
  const pos = (s.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const mod = (v, m) => ((v % m) + m) % m;
export const gcd = (a, b) => b ? gcd(b, a % b) : a;
export const wrap = (v, m) => mod(v + m / 2, m) - m / 2;

export function polyfit1(X, Y) {
  const n = X.length; let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += X[i]; my += Y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; }
  const slope = sxy / sxx;
  return [slope, my - slope * mx, sxx];
}

export const NTSC = [24000 / 1001, 30000 / 1001, 60000 / 1001, 120000 / 1001];

// Fit file_t = c + rate * R to points [file_t, R], refitting without the points farther than tol from the line.
export function fitKeep(P, tol, iters) {
  let keep = P.map(() => true), rate, c;
  for (let it = 0; it < iters; it++) {
    const Q = P.filter((_, i) => keep[i]);
    [rate, c] = polyfit1(Q.map(p => p[1]), Q.map(p => p[0]));
    const nk = P.map(p => Math.abs(p[0] - (c + rate * p[1])) < tol);
    if (nk.filter(Boolean).length < 2 || nk.every((v, i) => v === keep[i])) break;
    keep = nk;
  }
  const Q = P.filter((_, i) => keep[i]);
  [rate, c] = polyfit1(Q.map(p => p[1]), Q.map(p => p[0]));
  return { keep, rate, c };
}
