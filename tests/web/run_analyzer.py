#!/usr/bin/env python3
"""
run_analyzer.py — 以 headless 瀏覽器執行網頁分析器（web/sync-analyzer.html），取回結果 JSON 與文字報告。

啟動本機 http 伺服器（127.0.0.1、隨機埠）提供 repo 根目錄，以 headless 瀏覽器開啟 tests/web/harness.html；
外框頁在同源 iframe 載入分析器、把測試檔交給它，分析完成後把結果 POST 回伺服器。只用標準函式庫。

瀏覽器：環境變數 BROWSER，否則依序找 Chrome、Edge（Windows 與 Linux 常見路徑）。
不加 --disable-gpu（硬體解碼與實際使用相同）；不用 --virtual-time-budget（AAC 的 MP4 會卡住），改以逾時保護。

用法：
  python tests/web/run_analyzer.py tests/fixtures/a.wav tests/fixtures/b.m4a --av --lang zh-Hant --out result.json
  python tests/web/run_analyzer.py x.mp4 --report report.txt      # 另存文字報告
輸出 JSON：{"results": [...分析器的 window.__results...], "report": "文字報告", "errors": [...], "elapsedS": 秒, ...}
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Content-Type 不靠系統的 mimetypes（Windows 會讀登錄檔，結果因機器而異）。
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css",
         ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
         ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime"}

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_browser():
    env = os.environ.get("BROWSER")
    if env:
        return env
    for c in BROWSER_CANDIDATES:
        p = c if os.path.isabs(c) else shutil.which(c)
        if p and os.path.isfile(p):
            return p
    raise RuntimeError("找不到 Chrome 或 Edge；請以環境變數 BROWSER 指定瀏覽器執行檔")


class Handler(SimpleHTTPRequestHandler):
    """repo 根目錄照常提供；/__files/<序號>/<檔名> 對應命令列給的測試檔；POST /__result 收結果。"""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):  # 不印每個請求
        pass

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")

    def translate_path(self, path):
        parts = urllib.parse.unquote(urllib.parse.urlsplit(path).path).split("/")
        if len(parts) >= 4 and parts[1] == "__files" and parts[2].isdigit() and int(parts[2]) < len(self.server.files):
            return self.server.files[int(parts[2])]
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/__result":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(204)
        self.end_headers()
        self.server.result = json.loads(body.decode("utf-8"))
        self.server.got.set()


def browser_args(exe, profile, url):
    args = [exe, "--headless=new", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-background-networking", "--disable-component-update",
            "--disable-sync", "--mute-audio", "--autoplay-policy=no-user-gesture-required"]
    if sys.platform.startswith("linux"):
        # Ubuntu 24.04 的 AppArmor 限制非特權 user namespace，Chrome 的沙箱在 CI 上起不來；只開本機測試頁，不需要沙箱。
        args.append("--no-sandbox")
    return args + [url]


def stop(proc):
    """只停止自己啟動的瀏覽器（連同它的子程序，以 PID 指定）。"""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(5)


def run(files, av=False, lang="zh-Hant", full=False, minute=False, only=None, dist=0.0, timeout=300.0, browser=None):
    """分析 files（路徑清單，依序交給分析器），回傳外框頁 POST 回來的 dict。逾時或瀏覽器提前結束時丟出 RuntimeError。"""
    files = [os.path.abspath(f) for f in files]
    for f in files:
        if not os.path.isfile(f):
            raise FileNotFoundError(f)
    exe = browser or find_browser()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.files, srv.result, srv.got = files, None, threading.Event()
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    q = [("f", f"/__files/{i}/{urllib.parse.quote(os.path.basename(f))}") for i, f in enumerate(files)]
    q += [("lang", lang), ("av", "1" if av else "0"), ("full", "1" if full else "0"),
          ("minute", "1" if minute else "0"), ("only", only or ""), ("dist", str(dist)), ("timeout", str(timeout))]
    url = f"http://127.0.0.1:{srv.server_address[1]}/tests/web/harness.html?" + urllib.parse.urlencode(q)
    profile = tempfile.mkdtemp(prefix="slate-analyzer-")
    proc = subprocess.Popen(browser_args(exe, profile, url), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=os.name != "nt")
    t0 = time.monotonic()
    try:
        # 外框頁自己也有同樣的逾時；這裡多留 30 秒給瀏覽器啟動，再沒有結果就當作卡住。
        while not srv.got.wait(0.5):
            if proc.poll() is not None:
                raise RuntimeError(f"瀏覽器提前結束（結束碼 {proc.returncode}）：{exe}")
            if time.monotonic() - t0 > timeout + 30:
                raise RuntimeError(f"逾時 {timeout + 30:.0f} 秒沒有結果")
        res = srv.result
        res["browser"] = exe
        res["wallS"] = time.monotonic() - t0
        return res
    finally:
        stop(proc)
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(profile, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="以 headless 瀏覽器執行網頁分析器")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--av", action="store_true", help="聲畫同步檢查")
    ap.add_argument("--full", action="store_true", help="整段都有波形碼（抽查中段）")
    ap.add_argument("--minute", action="store_true", help="尋找分鐘標記")
    ap.add_argument("--only", choices=["head", "tail"], help="波形碼位置")
    ap.add_argument("--dist", type=float, default=0.0, help="手機到麥克風距離（公尺）")
    ap.add_argument("--lang", default="zh-Hant", help="介面語言：zh-Hant、en、ja、ko，預設 zh-Hant")
    ap.add_argument("--timeout", type=float, default=300.0, help="逾時（秒），預設 300")
    ap.add_argument("--out", help="結果 JSON 存檔路徑（預設印到標準輸出）")
    ap.add_argument("--report", help="文字報告存檔路徑")
    a = ap.parse_args()
    res = run(a.files, av=a.av, lang=a.lang, full=a.full, minute=a.minute, only=a.only, dist=a.dist, timeout=a.timeout)
    text = json.dumps(res, ensure_ascii=False, indent=2)
    if a.out:
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
    else:
        sys.stdout.buffer.write((text + "\n").encode("utf-8"))
    if a.report:
        with open(a.report, "w", encoding="utf-8", newline="\n") as f:
            f.write(res.get("report") or "")
    for e in res.get("errors") or []:
        print("錯誤：" + e, file=sys.stderr)
    print(f"{len(a.files)} 個檔案，分析 {res.get('elapsedS', 0):.1f} 秒（含瀏覽器啟動 {res['wallS']:.1f} 秒）",
          file=sys.stderr)
    return 0 if res.get("ok") and not res.get("errors") else 1


if __name__ == "__main__":
    sys.exit(main())
