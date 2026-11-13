"""
slate_js.py — 測試用：從 web/sync-slate.html 取出指定的函式與變數，以 node 執行，回傳 JSON 結果。
這樣測試比對的是場記板實際用的程式，而不是另抄一份。

需求：node（在 PATH 中）
"""
import json
import os
import re
import subprocess

SLATE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "sync-slate.html")


def _block(src, start):
    """src[start:] 起第一個 { 到對應 } 的結尾位置（這些函式的字串裡沒有大括號）。"""
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if not depth:
                return j + 1
    raise ValueError("大括號不成對")


def extract(names):
    """場記板中名為 names 的 function 宣告或 var 宣告（var 取到該行的分號）的原始碼。"""
    html = open(SLATE, encoding="utf-8").read()
    out = []
    for name in names:
        m = re.search(r"\bfunction " + re.escape(name) + r"\(", html)
        if m:
            out.append(html[m.start():_block(html, m.start())])
            continue
        m = re.search(r"\bvar " + re.escape(name) + r"\s*=", html)
        if not m:
            raise KeyError(f"場記板找不到 {name}")
        out.append(html[m.start():html.index(";", m.start()) + 1])
    return "\n".join(out)


def run(names, body, tz="UTC"):
    """以 node 執行場記板的 names 加上 body（body 以 console.log(JSON.stringify(...)) 輸出），回傳解析後的 JSON。"""
    src = extract(names) + "\n" + body
    env = dict(os.environ, TZ=tz)
    # The script goes in on stdin: a long one would exceed the Windows command-line limit (32 KB).
    p = subprocess.run(["node", "-"], input=src, capture_output=True, text=True, encoding="utf-8", env=env)
    if p.returncode:
        raise RuntimeError("node 執行失敗：" + p.stderr.strip()[-500:])
    return json.loads(p.stdout)
