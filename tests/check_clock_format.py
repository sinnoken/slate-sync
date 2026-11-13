#!/usr/bin/env python3
"""
check_clock_format.py — 回歸測試：起點時鐘的顯示先四捨五入到毫秒再拆成時分秒，秒數不會出現 60.000。

同時檢查命令列版的 fmt_clock() 與網頁分析器的 fmtClock()（以 node 執行頁面中的函式）。
用法：python tests/check_clock_format.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import slate_sync as s  # noqa: E402

# (秒, 循環) → 期望的時:分:秒部分（註記文字不比對）
CASES = [
    (59.9996, 60, "??:??:00.000"),
    (21 * 3600 + 37 * 60 + 59.9996, 86400, "21:38:00.000"),
    (23 * 3600 + 59 * 60 + 59.9999, 86400, "00:00:00.000"),
    (12 * 60 + 59.9995, 3600, "??:13:00.000"),
    (31.833, 60, "??:??:31.833"),
    (21 * 3600 + 37 * 60 + 31.8334, 86400, "21:37:31.833"),
]


def web_fmt(cases):
    html = open(os.path.join(ROOT, "web", "sync-analyzer.html"), encoding="utf-8").read()
    a = html.index("const fmtClock = ")
    b = html.index("\n};", a) + 3
    js = ("const VIS_MOD = 540; const mod = (v, m) => ((v % m) + m) % m; const t = () => '';\n" + html[a:b] +
          "\nprocess.stdout.write(JSON.stringify(" + json.dumps(cases) + ".map(([v, m]) => fmtClock(v, m))));")
    out = subprocess.run(["node", "-"], input=js.encode("utf-8"), capture_output=True, check=True).stdout
    return json.loads(out)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    web = web_fmt([[v, m] for v, m, _ in CASES])
    bad = 0
    for (v, m, want), w in zip(CASES, web):
        py = s.fmt_clock(v, m)
        for name, got in (("命令列", py), ("網頁", w)):
            if not got.startswith(want):
                bad += 1
                print(f"✗ {name}：{v} mod {m} → {got}（應為 {want}）")
    print("結果：全部通過" if not bad else f"結果：{bad} 項不符")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
