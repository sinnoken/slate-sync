#!/usr/bin/env python3
"""
check_clock_format.py — 回歸測試：起點時鐘的顯示先四捨五入到毫秒再拆成時分秒，秒數不會出現 60.000。

檢查網頁與命令列共用的分析核心 fmtClock()（以 node 執行 src/core/report.js）。
用法：python tests/check_clock_format.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

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
    """分析核心（src/core/report.js）的 fmtClock()，以 node 執行。"""
    url = "file:///" + os.path.join(ROOT, "src", "core", "report.js").replace(os.sep, "/").lstrip("/")
    js = (f"import {{ createReport }} from {json.dumps(url)};\nconst {{ fmtClock }} = createReport(() => '');\n"
          "process.stdout.write(JSON.stringify(" + json.dumps(cases) + ".map(([v, m]) => fmtClock(v, m))));")
    out = subprocess.run(["node", "--input-type=module", "-"], input=js.encode("utf-8"), capture_output=True,
                         check=True).stdout
    return json.loads(out)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    web = web_fmt([[v, m] for v, m, _ in CASES])
    bad = 0
    for (v, m, want), w in zip(CASES, web):
        if not w.startswith(want):
            bad += 1
            print(f"✗ {v} mod {m} → {w}（應為 {want}）")
    print("結果：全部通過" if not bad else f"結果：{bad} 項不符")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
