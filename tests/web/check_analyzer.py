#!/usr/bin/env python3
"""
check_analyzer.py — 回歸測試：以 headless 瀏覽器跑網頁分析器，對 tests/fixtures/ 的測試檔檢查結果。

1. 與真值（<名稱>.truth.json）比對：速度比例、起點、校正後長度、聲畫偏移的誤差須在報告自己的預估誤差內；
   模式（頭尾／僅開頭）須與預期相同。
2. 跨檔案：cam.mp4 與 picture.mp4 的起點差（兩者都有畫面碼，9 分鐘一輪）須為 2 分鐘。
3. 與 Python 命令列版（python/slate_sync.py --json --av）交叉比對；沒有 ffmpeg 時略過。
4. 文字報告快照（tests/web/snapshots/）：數字與解碼方式遮掉後逐字比對，報告文字一改就看得出來。
   報告措辭是刻意修改時，以 --update 更新快照並一起 commit。

用法：
  python tests/web/check_analyzer.py              # 瀏覽器見 run_analyzer.py（環境變數 BROWSER 可指定）
  python tests/web/check_analyzer.py --update     # 重寫快照
需求：Chrome 或 Edge；交叉比對另需 numpy、ffmpeg／ffprobe、pupil-apriltags
"""
import argparse
import difflib
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
SNAPSHOT = os.path.join(HERE, "snapshots", "report.zh-Hant.txt")
sys.path.insert(0, HERE)
import run_analyzer  # noqa: E402

ORDER = ["wave.wav", "aac.m4a", "cam.mp4", "picture.mp4", "ltc.wav"]
PAIR = ("cam.mp4", "picture.mp4")          # 起點相差 2 分鐘、都有畫面碼的一組

# 真值的容許值 = 報告自己的預估誤差，另加產生器本身的量化：產生器把每秒的波形碼放在整數取樣點（四捨五入），
# 真值因此有 ±半個取樣（48 kHz 時 0.0104 ms）的誤差，分析器再準也只能貼近這個值。
GEN_Q_MS = 0.5 / 48000 * 1000

# 網頁版與 Python 版的容許值。兩者用同一套演算法，差異只來自解碼器（瀏覽器的 AAC／H.264 解碼器 vs ffmpeg）
# 與浮點運算順序；docs/testing.md 記錄的 16 個檔案交叉比對最大為 0.02 ppm、起點 0.0005 ms、長度 0.005 ms。
# 這裡各放寬約 2 倍，留給不同平台的解碼器差異，仍遠小於任何一項的預估誤差。
CLI_TOL = {
    "ppm": 0.05,          # ppm
    "start_ms": 0.001,    # ms，起點（模數取兩者較小者）
    "length_ms": 0.01,    # ms，校正後長度
    # 聲畫偏移：畫面碼的偵測器不同（網頁內嵌的 JS 版 vs pupil-apriltags），每個邊緣的次格估計可略有出入；
    # 0.05 ms 仍不到 29.97 fps 一格（33 ms）的千分之二。
    "av_ms": 0.05,
}

# 已知、尚待決定的差異：列在這裡的檢查失敗時只警告；若已通過，會提示把它移除。
KNOWN = {
}


class Checker:
    def __init__(self):
        self.fails, self.warns, self.passed, self.lines = [], [], 0, []

    def check(self, name, what, ok, detail):
        key = (name, what)
        line = f"{name} {what}：{detail}"
        self.lines.append(("通過" if ok else "未過") + "：" + line)
        if ok:
            self.passed += 1
            if key in KNOWN:
                self.warns.append(f"{line}（已通過，請把它從 KNOWN 移除）")
        elif key in KNOWN:
            self.warns.append(f"{line}（已知差異：{KNOWN[key]}）")
        else:
            self.fails.append(line)


def wrap(x, m):
    """把 x 換到 [−m/2, m/2)。"""
    return (x + m / 2) % m - m / 2


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def prepare(tmp):
    """解壓 .gz、核對 sha256（測試檔與真值須是同一次產生的），回傳 [(路徑, 真值)]。"""
    out = []
    for name in ORDER:
        with open(os.path.join(FIXTURES, os.path.splitext(name)[0] + ".truth.json"), encoding="utf-8") as f:
            truth = json.load(f)
        src = os.path.join(FIXTURES, name)
        if not os.path.exists(src):
            dst = os.path.join(tmp, name)
            with gzip.open(src + ".gz", "rb") as g, open(dst, "wb") as o:
                shutil.copyfileobj(g, o)
            src = dst
        if sha256(src) != truth["sha256"]:
            raise SystemExit(f"{name} 與它的真值不是同一次產生的（sha256 不符）；請重跑 tests/fixtures/make_fixtures.py")
        out.append((src, truth))
    return out


def check_truth(c, r, t):
    name = t["file"]
    if r.get("error"):
        c.check(name, "分析", False, f"失敗：{r['error']}")
        return
    c.check(name, "模式", r["mode"] == t["mode"], f"{r['mode']}（預期 {t['mode']}）")
    d = r["ppm"] - t["ppm"]
    c.check(name, "速度比例", abs(d) <= r["uncPpm"], f"{r['ppm']:+.3f} ppm，誤差 {d:+.3f}（預估 ±{r['uncPpm']:.3f}）")
    d = wrap(r["startLabel"] - t["start"], r["mod"]) * 1000
    tol = r["worstMs"] + GEN_Q_MS
    c.check(name, "起點", abs(d) <= tol, f"誤差 {d:+.4f} ms（容許 ±{tol:.4f}）")
    d = (r["correctedLength"] - t["corrected_length"]) * 1000
    tol = 2 * r["worstMs"] + GEN_Q_MS          # 頭尾兩端各有 worstMs
    c.check(name, "校正後長度", abs(d) <= tol, f"{r['correctedLength']:.6f} 秒，誤差 {d:+.4f} ms（容許 ±{tol:.4f}）")
    if t.get("clock_type") or t.get("ltc"):   # 完整時鐘：建立時間推定（clockType）或 LTC 本身就是真實時間
        if t.get("ltc"):
            c.check(name, "時間來源", r.get("source") == "ltc", f"{r.get('source')}（預期 ltc）")
        else:
            c.check(name, "建立時間類型", r.get("clockType") == t["clock_type"], f"{r.get('clockType')}（預期 {t['clock_type']}）")
        d = wrap(r["startClock"] - t["start"], 86400) * 1000
        tol = r["worstMs"] + GEN_Q_MS
        c.check(name, "完整起點時鐘", r.get("clockMod") == 86400 and abs(d) <= tol,
                f"週期 {r.get('clockMod')}，誤差 {d:+.4f} ms（容許 ±{tol:.4f}）")
    if t.get("av_offset_ms") is not None:
        offs = r.get("avOffsetMs") or {}
        ends = [k for k in ("head", "tail") if offs.get(k)]
        c.check(name, "聲畫偏移", bool(ends), "有量到" if ends else "沒有量到")
        for k in ends:
            o = offs[k]
            d = o["mean"] - t["av_offset_ms"]
            c.check(name, f"聲畫偏移（{k}）", abs(d) <= o["half"],
                    f"{o['mean']:+.3f} ms，誤差 {d:+.3f}（預估 ±{o['half']:.3f}）")


def label_for(r, m):
    """與分析器的 startLabelFor() 相同：模數 m 下可用的起點，否則 None。"""
    if r["mod"] % m == 0:
        return r["startLabel"]
    if r.get("label540") is not None and 540 % m == 0:
        return r["label540"]
    return None


def check_pair(c, by_name, truths):
    a, b = (by_name.get(n) for n in PAIR)
    if not a or not b or a.get("error") or b.get("error"):
        c.check("跨檔案", "起點差", False, "其中一個檔案沒有結果")
        return
    m = next((m for m in (3600, 540, 180, 60) if label_for(a, m) is not None and label_for(b, m) is not None), None)
    c.check("跨檔案", "模數", m is not None and m >= 540, f"{m} 秒（2 分鐘的差須在 540 秒以上的週期才分得出來）")
    if not m:
        return
    got = wrap(label_for(b, m) - label_for(a, m), m) * a["rate"]          # 以 a 的時間軸計，同分析器的對齊表
    want = (truths[PAIR[1]]["start"] - truths[PAIR[0]]["start"]) * truths[PAIR[0]]["rate"]
    d = (got - want) * 1000
    tol = a["worstMs"] + b["worstMs"] + 2 * GEN_Q_MS
    c.check("跨檔案", f"{PAIR[1]} 相對 {PAIR[0]} 的起點", abs(d) <= tol,
            f"{got:+.6f} 秒（真值 {want:+.6f}），誤差 {d:+.4f} ms（容許 ±{tol:.4f}）")


def run_cli(paths):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        return None
    p = subprocess.run([sys.executable, os.path.join(ROOT, "python", "slate_sync.py"), *paths, "--av", "--json"],
                       capture_output=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if p.returncode:
        raise SystemExit("Python 版執行失敗：\n" + p.stderr.decode("utf-8", "replace")[-2000:])
    return {os.path.basename(r["file"]): r for r in json.loads(p.stdout.decode("utf-8"))}


def check_cli(c, web, cli):
    name = web["file"]
    if web.get("error") or "rate" not in cli:
        c.check(name, "CLI 有結果", not web.get("error") and "rate" in cli, "網頁版或 Python 版沒有結果")
        return
    d = web["ppm"] - cli["ppm"]
    c.check(name, "CLI 速度比例", abs(d) <= CLI_TOL["ppm"], f"差 {d:+.4f} ppm（容許 ±{CLI_TOL['ppm']}）")
    m = min(web["mod"], cli["mod"])
    d = wrap(web["startLabel"] - cli["start_label"], m) * 1000
    c.check(name, "CLI 起點", abs(d) <= CLI_TOL["start_ms"], f"差 {d:+.5f} ms（容許 ±{CLI_TOL['start_ms']}）")
    d = (web["correctedLength"] - cli["corrected_length"]) * 1000
    c.check(name, "CLI 校正後長度", abs(d) <= CLI_TOL["length_ms"], f"差 {d:+.4f} ms（容許 ±{CLI_TOL['length_ms']}）")
    wo, co = web.get("avOffsetMs") or {}, cli.get("av_offset_ms") or {}
    for k in ("head", "tail"):
        if bool(wo.get(k)) != bool(co.get(k)):
            c.check(name, f"CLI 聲畫偏移（{k}）", False, f"只有一邊量到（網頁 {bool(wo.get(k))}，Python {bool(co.get(k))}）")
        elif wo.get(k):
            d = wo[k]["mean"] - co[k]["mean"]
            c.check(name, f"CLI 聲畫偏移（{k}）", abs(d) <= CLI_TOL["av_ms"], f"差 {d:+.4f} ms（容許 ±{CLI_TOL['av_ms']}）")


# 解碼方式依機器而異（Windows 的 Edge 用硬體、CI 的 Chrome 可能是軟體），快照中一律換成同一個詞。
DECODERS = re.compile(r"(硬體解碼（WebCodecs）|軟體解碼)(＋(硬體解碼（WebCodecs）|軟體解碼))*")
NUMBER = re.compile(r"(?<![\w.])[+−-]?\d+(?:\.\d+)?")   # 不動檔名裡的數字（如 mp4）


def normalize(report):
    """快照只比文字：數字換成 #（數值另有上面的檢查），解碼方式換成〈解碼〉。"""
    return NUMBER.sub("#", DECODERS.sub("〈解碼〉", report)).rstrip() + "\n"


def check_snapshot(c, report, update):
    text = normalize(report or "")
    if update:
        os.makedirs(os.path.dirname(SNAPSHOT), exist_ok=True)
        with open(SNAPSHOT, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"已更新快照 {os.path.relpath(SNAPSHOT, ROOT)}")
        return
    try:
        with open(SNAPSHOT, encoding="utf-8") as f:
            old = f.read()
    except FileNotFoundError:
        c.check("文字報告", "快照", False, f"沒有 {os.path.relpath(SNAPSHOT, ROOT)}；以 --update 建立")
        return
    diff = list(difflib.unified_diff(old.splitlines(), text.splitlines(), "快照", "這次", lineterm="", n=1))
    c.check("文字報告", "快照", not diff, "一致" if not diff else "與快照不同（刻意修改時以 --update 更新）：\n" + "\n".join(diff))


def main():
    ap = argparse.ArgumentParser(description="網頁分析器的回歸測試")
    ap.add_argument("--update", action="store_true", help="重寫文字報告快照")
    ap.add_argument("--no-cli", action="store_true", help="不與 Python 版交叉比對")
    ap.add_argument("-v", "--verbose", action="store_true", help="列出每一項檢查的數值")
    ap.add_argument("--keep", help="把網頁版結果 JSON 存到這個路徑（除錯用）")
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):      # 主控台不是 UTF-8（如 cp950）時，印不出的字元以 ? 代替，不中斷
        stream.reconfigure(errors="replace")
    c = Checker()
    tmp = tempfile.mkdtemp(prefix="slate-fixtures-")
    try:
        items = prepare(tmp)
        paths = [p for p, _ in items]
        truths = {t["file"]: t for _, t in items}
        t0 = time.monotonic()
        res = run_analyzer.run(paths, av=True, lang="zh-Hant", timeout=180)
        t_web = time.monotonic() - t0
        if args.keep:
            with open(args.keep, "w", encoding="utf-8", newline="\n") as f:
                json.dump(res, f, ensure_ascii=False, indent=2)
        print(f"網頁版：{res.get('userAgent')}，{t_web:.1f} 秒")
        for e in res.get("errors") or []:
            c.check("網頁", "執行", False, e)
        c.check("網頁", "WebCodecs", all(res["webcodecs"].values()), str(res["webcodecs"]))
        by_name = {r["file"]: r for r in res.get("results") or []}
        for name in ORDER:
            if name in by_name:
                check_truth(c, by_name[name], truths[name])
            else:
                c.check(name, "分析", False, "沒有結果")
        check_pair(c, by_name, truths)
        check_snapshot(c, res.get("report"), args.update)
        cli = None if args.no_cli else run_cli(paths)
        if cli is None:
            print("略過與 Python 版的交叉比對" + ("" if args.no_cli else "（找不到 ffmpeg／ffprobe）"))
        else:
            print(f"Python 版：{time.monotonic() - t0 - t_web:.1f} 秒")
            for name in ORDER:
                if truths[name].get("ltc"):       # 命令列版尚未支援 LTC（ADR-0001 的 Node 版會支援）
                    continue
                if name in by_name and name in cli:
                    check_cli(c, by_name[name], cli[name])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if args.verbose:
        print("\n".join(c.lines))
    for w in c.warns:
        print("警告：" + w)
    for f in c.fails:
        print("失敗：" + f)
    print(f"{c.passed} 項通過，{len(c.fails)} 項失敗，{len(c.warns)} 項警告")
    return 1 if c.fails else 0


if __name__ == "__main__":
    sys.exit(main())
