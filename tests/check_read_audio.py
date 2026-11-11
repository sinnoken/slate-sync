#!/usr/bin/env python3
"""
check_read_audio.py — 回歸測試：read_audio() 從任何位置讀取，第一個取樣都必須正好落在要求的時間。

以 ffmpeg 產生 12 秒掃頻音訊（AAC 的 .m4a、.mp4 與 WAV），在多個位置（0、1 秒內、AAC 封包邊界附近、檔尾附近）
以 read_audio() 讀取，與整段解碼後的對應取樣比對：以互相關找出錯位，必須為 0 個取樣。
（AAC 以輸入端 -ss 讀取時，ffmpeg 會從下一個封包邊界開始輸出，最多晚 1024 個取樣。）

需求：numpy、ffmpeg／ffprobe（在 PATH 中）
用法：python tests/check_read_audio.py
"""
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python"))
import slate_sync as s  # noqa: E402

SR = s.SR
DUR = 12.0
STARTS = [0.0, 0.001, 0.01, 0.0213, 0.03, 0.1, 0.5, 1.0, 1.05, 1.1, 2.0, 2.7, 1024 * 5 / SR, 1024 * 5 / SR + 0.001,
          5.333, DUR - 1.2]
LEN = 0.5
MAX_LAG = 2048


def full(path, info):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-map", "0:a:0", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, check=True)
    x = np.frombuffer(p.stdout, np.float32)
    return x[: len(x) // info["channels"] * info["channels"]].reshape(-1, info["channels"])[:, 0]


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
            info = s.probe(f)
            ref = full(f, info)
            bad = []
            for st in STARTS:
                x, t0 = s.read_audio(f, st, LEN, info)
                k = lag(ref, int(round(t0 * SR)), x[:, 0])
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
