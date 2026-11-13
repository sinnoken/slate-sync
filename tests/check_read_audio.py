#!/usr/bin/env python3
"""
check_read_audio.py — 回歸測試：命令列版（cli/media.mjs）的 readWindow() 從任何位置讀取，第一個取樣都必須正好落在
回傳的 t0（要求的時間移到取樣格點上）。

以 ffmpeg 產生 12 秒掃頻音訊（AAC 的 .m4a、.mp4 與 WAV），在多個位置（0、1 秒內、AAC 封包邊界附近、檔尾附近）
以 node 執行 readWindow() 讀取，與整段解碼後的對應取樣比對：以互相關找出錯位，必須為 0 個取樣。
（AAC 以輸入端 -ss 讀取時，ffmpeg 會從下一個封包邊界開始輸出，最多晚 1024 個取樣。）

需求：numpy、node、ffmpeg／ffprobe（在 PATH 中）
用法：python tests/check_read_audio.py
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 48000
DUR = 12.0
STARTS = [0.0, 0.001, 0.01, 0.0213, 0.03, 0.1, 0.5, 1.0, 1.05, 1.1, 2.0, 2.7, 1024 * 5 / SR, 1024 * 5 / SR + 0.001,
          5.333, DUR - 1.2]
LEN = 0.5
MAX_LAG = 2048


def full(path):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"],
                       capture_output=True, check=True)
    return np.frombuffer(p.stdout, np.float32)


def node_reads(path, starts, length):
    """[(t0, 第 0 聲道的取樣)]：以 node 執行 cli/media.mjs 的 openMedia(path).readWindow(start, start + length)。"""
    url = "file:///" + os.path.join(ROOT, "cli", "media.mjs").replace(os.sep, "/").lstrip("/")
    js = (f"import {{ openMedia }} from {json.dumps(url)};\n"
          f"const m = await openMedia({json.dumps(path)}), out = [];\n"
          f"for (const s of {json.dumps(starts)}) {{ const w = await m.readWindow(s, s + {length});"
          " out.push([w.t0, Array.from(w.chans[0].subarray(0, 8192))]); }\n"
          "process.stdout.write(JSON.stringify(out));")
    p = subprocess.run(["node", "--input-type=module", "-"], input=js.encode("utf-8"), capture_output=True, check=True)
    return [(t0, np.array(x, np.float32)) for t0, x in json.loads(p.stdout)]


def lag(ref, start_idx, seg):
    """Offset (samples) of seg against ref[start_idx:], found by cross-correlation within ±MAX_LAG."""
    n = min(len(seg), 8192)
    seg = seg[:n].astype(np.float64)
    lo = max(0, start_idx - MAX_LAG)
    win = ref[lo:start_idx + MAX_LAG + n].astype(np.float64)
    c = np.correlate(win, seg, mode="valid")
    return lo + int(np.argmax(c)) - start_idx


def main():
    if hasattr(sys.stdout, "reconfigure"):  # cp950 等主控台印不出 ✓ 時以替代字元輸出
        sys.stdout.reconfigure(errors="replace")
    fail = 0
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "chirp.wav")
        # Rising chirp: every sample position looks different, so a shifted read cannot match by accident.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        f"aevalsrc=0.5*sin(2*PI*(100*t+150*t*t)):s={SR}:d={DUR}", wav], check=True)
        files = {"WAV": wav}
        for ext in ("m4a", "mp4"):
            f = os.path.join(d, "chirp." + ext)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", "192k", f], check=True)
            files["AAC ." + ext] = f
        for name, f in files.items():
            ref = full(f)
            bad = []
            for st, (t0, x) in zip(STARTS, node_reads(f, STARTS, LEN)):
                k = lag(ref, int(round(t0 * SR)), x)
                if k:
                    bad.append(f"{st:g} 秒：{k:+d}")
            if bad:
                print(f"✗ {name}：{len(bad)}／{len(STARTS)} 個位置錯位（取樣）：" + "；".join(bad))
                fail += 1
            else:
                print(f"✓ {name}：{len(STARTS)} 個位置都是 0 取樣誤差")
    print("結果：" + ("全部通過" if not fail else f"{fail} 種格式不符"))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
