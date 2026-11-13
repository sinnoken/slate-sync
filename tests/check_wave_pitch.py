#!/usr/bin/env python3
"""
check_wave_pitch.py — 波形碼載波（docs/waveform-code.md「載波」）：場記板、測試產生器、分析器三處一致。

- 以 node 執行場記板的 cycleK()／waveHz()，連續兩天逐秒（含跨午夜，UTC 與 UTC+8 兩種時區，另抽查整秒內的毫秒），
  與產生器的 wave_hz()、tag_id() 及分析器的 pitch_index() 比對。
- 三處的 11 個音高相同；分析器的 cycle_k() 由秒數與音高解回 k；相鄰兩秒的音高都不同。

需求：numpy、node（在 PATH 中）
用法：python tests/check_wave_pitch.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))
import make_test_media as gen  # noqa: E402
import slate_js  # noqa: E402
import slate_sync as s  # noqa: E402

DAYS = 2
ZONES = (("UTC", 0), ("Asia/Taipei", 8 * 3600))   # (TZ, 與 UTC 的差，秒；兩者都沒有日光節約時間)
BASE_UTC = 1794441600                              # 2026-11-12T00:00:00Z


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    fail = []
    pitches = slate_js.run(["WAVE_PITCHES"], "console.log(JSON.stringify(WAVE_PITCHES));")
    if not (pitches == gen.WAVE_PITCHES == [float(f) for f in s.WAVE_HZ]):
        fail.append(f"音高表不同：場記板 {pitches}，產生器 {gen.WAVE_PITCHES}，分析器 {list(s.WAVE_HZ)}")
    n = DAYS * 86400
    for tz, utc_off in ZONES:
        base_ms = (BASE_UTC - utc_off) * 1000          # local midnight in that zone
        body = (f"var b = {base_ms}, n = {n}, k = [], hz = [], sub = [];"
                "for (var i = 0; i < n; i++) { var c = cycleK(b + i * 1000); k.push(c); hz.push(waveHz(c));"
                " if (i % 997 === 0) sub.push(cycleK(b + i * 1000 + 999)); }"
                "console.log(JSON.stringify({k: k, hz: hz, sub: sub}));")
        r = slate_js.run(["cycleK", "WAVE_PITCHES", "waveHz"], body, tz)
        bad = [i for i in range(n) if r["k"][i] != gen.tag_id(i) or r["hz"][i] != gen.wave_hz(i)
               or r["hz"][i] != float(s.WAVE_HZ[s.pitch_index(r["k"][i])])]
        bad += [i for j, i in enumerate(range(0, n, 997)) if r["sub"][j] != r["k"][i]]
        same = [i for i in range(n - 1) if r["hz"][i] == r["hz"][i + 1]]
        if bad:
            fail.append(f"{tz}：{len(bad)} 秒不一致，例如第 {bad[0]} 秒")
        if same:
            fail.append(f"{tz}：{len(same)} 處相鄰兩秒同音，例如第 {same[0]} 秒")
        if not bad and not same:
            print(f"✓ {tz}：{n} 秒的 k 與音高三處一致，相鄰兩秒都不同音")
    inv = [k for k in range(s.VIS_MOD) if s.cycle_k(k % 60, s.pitch_index(k)) != k]
    wrong = [(sec, pt) for sec in range(60) for pt in range(11)
             if s.cycle_k(sec, pt) is not None and s.pitch_index(s.cycle_k(sec, pt)) != pt]
    if inv or wrong:
        fail.append(f"cycle_k() 解不回 k：{inv[:5]} {wrong[:5]}")
    else:
        print("✓ 分析器的 cycle_k() 由秒數與音高解回 540 個 k；其餘 120 種組合判為讀錯")
    for f in fail:
        print("✗ " + f)
    print("結果：" + ("全部通過" if not fail else f"{len(fail)} 項不符"))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
