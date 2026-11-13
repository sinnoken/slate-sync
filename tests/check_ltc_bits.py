#!/usr/bin/env python3
"""
check_ltc_bits.py — 測試產生器的 LTC 與場記板相同（docs/ltc.md「場記板輸出」）。

- 以 node 執行場記板的 countToTC()／ltcBits()，與產生器的 count_to_tc()／ltc_bits() 逐格比對：24、25、29.97 DF、
  29.97 NDF、30（23.976 的位元與 24 相同，也一併比對），含午夜前後、DF 的丟格分鐘與每 10 分鐘、全天抽查。
- 以 node 執行場記板的 ltcChunk()（模擬 AudioContext，漂移鎖定不介入），連續 4 個區塊跨過午夜，與產生器的
  ltc_levels() 逐個取樣比對：位元、極性、振幅 0.5、格起點的取樣位置與跨區塊的連續性。
- DF 的丟格規則抽查：每分鐘跳過 ;00、;01，每 10 分鐘不跳。

需求：numpy、node（在 PATH 中）
用法：python tests/check_ltc_bits.py
"""
import json
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_test_media as gen  # noqa: E402
import slate_js  # noqa: E402

CASES = [("24", False), ("25", False), ("29.97", True), ("29.97", False), ("30", False), ("23.976", False)]
CHUNKS = 4                                          # ltcChunk(8) calls


def frames(p):
    """要比對的格數：午夜前後、DF 每分鐘與每 10 分鐘的邊界、全天隨機抽查。"""
    day = 2589408 if p["df"] else p["nominal"] * 86400
    ns = set(range(0, 200)) | set(range(day - 200, day + 200))
    for k in range(0, 300):                         # minute boundaries in the first 5 hours (DF: 17982 per 10 min)
        b = (k // 10) * 17982 + (k % 10) * 1798 + (2 if k % 10 else 0) if p["df"] else k * 60 * p["nominal"]
        ns |= set(range(max(0, b - 3), b + 3))
    rnd = random.Random(7)
    ns |= {rnd.randrange(day) for _ in range(3000)}
    return sorted(ns)


def label(fps, df):
    return fps + (" DF" if df else (" NDF" if fps == "29.97" else ""))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    fail = []
    amp = slate_js.run(["LTC_AMP", "LTC_SYNC"], "console.log(JSON.stringify([LTC_AMP, LTC_SYNC]));")
    if amp != [gen.LTC_AMP, gen.LTC_SYNC]:
        fail.append(f"振幅或同步字不同：場記板 {amp}")
    for fps, df in CASES:
        p = gen.ltc_params(fps, df)
        jp = json.dumps({"rate": p["rate"], "nominal": p["nominal"], "df": p["df"]})
        ns = frames(p)
        body = (f"var p = {jp}, ns = {json.dumps(ns)};"
                "console.log(JSON.stringify(ns.map(function (n) { var t = countToTC(n, p);"
                " return [[t.h, t.m, t.s, t.f], ltcBits(n, p)]; })));")
        js = slate_js.run(["countToTC", "LTC_SYNC", "ltcBits"], body)
        bad = [n for n, (tc, bits) in zip(ns, js) if tuple(tc) != gen.count_to_tc(n, p) or bits != gen.ltc_bits(n, p)]
        # ltcChunk() on a fake AudioContext, starting 12 frames before midnight so the chunks cross it.
        day = 2589408 if p["df"] else p["nominal"] * 86400
        sc = day - 12
        body = (f"var P = {jp}, bufs = [];"
                "var ctx = {getOutputTimestamp: null, destination: {},"
                " createBuffer: function (c, n, sr) { var d = new Float32Array(n); bufs.push(d);"
                " return {getChannelData: function () { return d; }}; },"
                " createBufferSource: function () { return {connect: function () {}, start: function () {}}; }};"
                "var state = {audOfs: 0};"
                f"var ltc = {{p: P, sr: 48000, T0: 0, startCount: {sc}, frame: 0, sample: 0, level: 1, adj: 0,"
                " err: 0, sources: []};"
                f"for (var i = 0; i < {CHUNKS}; i++) ltcChunk(8);"
                "var out = []; bufs.forEach(function (d) { for (var i = 0; i < d.length; i++) out.push(d[i]); });"
                "console.log(JSON.stringify(out));")
        js_pcm = np.array(slate_js.run(["countToTC", "LTC_SYNC", "ltcBits", "LTC_AMP", "ltcChunk"], body))
        py_pcm = gen.phone_samples(*gen.ltc_levels(p, sc, 8 * CHUNKS))
        pcm_ok = len(js_pcm) == len(py_pcm) and np.array_equal(js_pcm, py_pcm)
        name = label(fps, df)
        if bad:
            fail.append(f"{name}：{len(bad)}／{len(ns)} 格的時間碼或位元不同，例如第 {bad[0]} 格")
        if not pcm_ok:
            k = int(np.argmax(js_pcm[:len(py_pcm)] != py_pcm[:len(js_pcm)])) if len(js_pcm) and len(py_pcm) else 0
            fail.append(f"{name}：ltcChunk() 的取樣不同（長度 {len(js_pcm)}／{len(py_pcm)}，第一個不同在 {k}）")
        if not bad and pcm_ok:
            print(f"✓ {name}：{len(ns)} 格的時間碼與位元相同；ltcChunk() {CHUNKS} 個區塊（跨午夜）"
                  f"{len(py_pcm)} 個取樣相同")
    p = gen.ltc_params("29.97", True)
    expect = {1799: (0, 0, 59, 29), 1800: (0, 1, 0, 2), 17981: (0, 9, 59, 29), 17982: (0, 10, 0, 0),
              17982 + 1800: (0, 11, 0, 2), 2589407: (23, 59, 59, 29), 2589408: (0, 0, 0, 0)}
    wrong = {n: gen.count_to_tc(n, p) for n, tc in expect.items() if gen.count_to_tc(n, p) != tc}
    if wrong:
        fail.append(f"DF 丟格規則不符：{wrong}")
    else:
        print("✓ 29.97 DF：每分鐘跳過 ;00、;01，每 10 分鐘不跳，一天 2589408 格")
    for f in fail:
        print("✗ " + f)
    print("結果：" + ("全部通過" if not fail else f"{len(fail)} 項不符"))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
