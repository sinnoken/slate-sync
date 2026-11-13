#!/usr/bin/env python3
"""
make_fixtures.py — 產生網頁分析器自動測試用的短測試檔（tests/fixtures/），並寫出各檔的真值（<名稱>.truth.json）。

測試檔由 tests/make_test_media.py 以固定參數產生，可重現；影片用 CPU 的 libx264（CI 沒有 NVENC）、
640×360。產生後的檔案一併放進版控，CI 不必重新產生。

頭尾兩端要相隔 60 秒以上，分析器才分開計算兩端（模式「頭尾」）；更短的檔案兩端會合併成單端。
因此 WAV 長 80 秒、只在頭尾各 8 秒放波形碼，只留波形碼聲道並以 gzip 存檔（中段是靜音，壓縮後約 0.3 MB，
未壓縮 7.7 MB）；測試時解壓到暫存資料夾。只有畫面的 picture.mp4 同樣 80 秒（關鍵格間隔 8 秒；畫面有雜訊，每個關鍵格約 50 KB）。
其他檔案 15–20 秒，全部合計約 3 MB。

用法：
  python tests/fixtures/make_fixtures.py                          # 用 tests/make_test_media.py
  python tests/fixtures/make_fixtures.py --generator 其他版本.py   # 指定產生器（例如尚未 commit 的新版）
需求：numpy、pillow、ffmpeg（PATH 中）
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

FPS = {"25": 25.0, "29.97": 30000 / 1001}

# 每個測試檔：產生器參數與檢查項目。start 是聲音軌（沒有聲音軌時為畫面）第 0 秒的真實時間。
# cam.mp4 與 picture.mp4 起點相差 2 分鐘：兩者都有畫面碼（9 分鐘一輪），用來檢查跨檔案的起點差。
# mod 是預期的週期（波形碼音高 540、另有一致的分鐘標記時 10800、LTC 86400）；max_unc_ppm／max_worst_ms 是預估誤差的
# 上限，取產生時實測值的 2 倍。cam.mp4 的建立時間固定以 UTC+8 寫入（tz），測試時瀏覽器的時區須相同。
FIXTURES = [
    {"name": "wave.wav", "seconds": 80, "ppm": 833, "start": "12:34:56.789", "plug": 8, "mono": True, "gzip": True,
     "mode": "both", "mod": 10800, "max_unc_ppm": 0.15, "max_worst_ms": 0.0081,
     "note": "WAV，頭尾各 8 秒有波形碼，兩端分開計算；只留波形碼聲道，以 gzip 存檔"},
    {"name": "aac.m4a", "seconds": 20, "ppm": -694, "start": "12:35:00.039", "plug": 7,
     "mode": "head", "mod": 540, "max_unc_ppm": 0.86, "max_worst_ms": 0.0104,
     "note": "AAC（M4A），只有頭尾各 7 秒有波形碼"},
    {"name": "cam.mp4", "seconds": 15, "ppm": 200, "start": "12:40:10.250", "plug": 6, "visual": True,
     "fps": "29.97", "av_offset_ms": 25.0, "mode": "head", "created": "end", "tz": "+08:00",
     "mod": 540, "max_unc_ppm": 1.35, "max_worst_ms": 0.0122,
     "note": "H.264＋AAC，畫面碼（AprilTag）與波形碼，畫面比聲音晚 25 ms；建立時間為錄影結束時間"},
    {"name": "picture.mp4", "seconds": 80, "ppm": -1200, "start": "12:42:10.250", "plug": 8, "visual": True,
     "fps": "25", "audio": "none", "gop": 8, "mode": "both", "mod": 540, "max_unc_ppm": 1090, "max_worst_ms": 43.7,
     "note": "H.264，只有畫面碼、沒有聲音軌，頭尾各 8 秒；起點比 cam.mp4 晚 2 分鐘"},
    {"name": "ltc.wav", "seconds": 20, "ppm": 300, "start": "13:20:05.400", "ltc": "25", "mono": True, "gzip": True,
     "mode": "head", "mod": 86400, "max_unc_ppm": 0.16, "max_worst_ms": 0.0019,
     "note": "WAV，25 fps LTC；只留 LTC 聲道，以 gzip 存檔"},
]


def parse_clock(s):
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + float(sec)


def gen_args(fx, out):
    a = [out, "--minutes", repr(fx["seconds"] / 60), "--ppm", str(fx["ppm"]), "--start", fx["start"]]
    if fx.get("plug"):
        a += ["--plug", str(fx["plug"])]
    if fx.get("created"):
        a += ["--created", fx["created"]]
    if fx.get("tz"):
        a += ["--tz", fx["tz"]]
    if fx.get("ltc"):
        a += ["--ltc", fx["ltc"]]
    if fx.get("visual"):
        a += ["--visual", "--fps", fx["fps"], "--size", "640x360", "--encoder", "cpu",
              "--av-offset", str(fx.get("av_offset_ms", 0.0)), "--audio", fx.get("audio", "code"),
              "--gop", str(fx.get("gop", 1))]
    return a


def keep_code_channel(path):
    """立體聲 WAV 只留右聲道（波形碼）：逐取樣複製，不重新取樣。"""
    with wave.open(path, "rb") as w:
        sr, n, raw = w.getframerate(), w.getnframes(), w.readframes(w.getnframes())
    right = bytearray(len(raw) // 2)
    right[0::2], right[1::2] = raw[2::4], raw[3::4]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(right)
    return n


def truth_of(fx):
    """與產生器相同的公式（固定 ppm）：檔案時間 = (真實時間 − 起點) × 速率。"""
    rate = 1 + fx["ppm"] * 1e-6
    t = {"file": fx["name"], "note": fx["note"], "mode": fx["mode"], "ppm": fx["ppm"], "rate": rate,
         "start": parse_clock(fx["start"]), "start_text": fx["start"],
         "has_audio": fx.get("audio", "code") != "none", "has_video": bool(fx.get("visual")),
         "clock_type": fx.get("created"), "ltc": fx.get("ltc"), "tz": fx.get("tz"),
         "mod": fx["mod"], "pitch_rejected": 0, "max_unc_ppm": fx["max_unc_ppm"], "max_worst_ms": fx["max_worst_ms"]}
    dur = fx["seconds"]
    if fx.get("visual"):
        fps = FPS[fx["fps"]]
        nfr = int(round(dur * fps))
        t.update(fps=fps, frames=nfr, av_offset_ms=fx.get("av_offset_ms", 0.0) if t["has_audio"] else None)
        t["media_length"] = nfr / fps                    # 有畫面軌時，分析器以畫面軌的長度與起點為準
    else:
        t["media_length"] = dur
    t["corrected_length"] = t["media_length"] / rate
    if fx.get("created"):
        # 設備時鐘差 r（建立時間為整數秒，與產生器相同）：結束型以媒體長度（有畫面軌時為 nfr / fps）換算回開始時間。
        end = fx["created"] == "end"
        C = math.floor(t["start"] + (dur if end else 0.0))
        t["clock_r"] = round(C - (t["media_length"] if end else 0.0) - t["start"], 6)
    return t


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    ap = argparse.ArgumentParser(description="產生網頁分析器的短測試檔與真值")
    ap.add_argument("--generator", default=os.path.join(ROOT, "tests", "make_test_media.py"), help="測試檔產生器")
    ap.add_argument("--out", default=HERE, help="輸出資料夾，預設本資料夾")
    args = ap.parse_args()
    total = 0
    for fx in FIXTURES:
        out = os.path.join(args.out, fx["name"])
        subprocess.run([sys.executable, args.generator] + gen_args(fx, out), check=True)
        if fx.get("mono"):
            keep_code_channel(out)
        t = truth_of(fx)
        t["generator_args"] = gen_args(fx, fx["name"])
        t["sha256"] = sha256(out)
        if fx.get("gzip"):  # mtime=0：同樣內容得到同樣的 .gz
            with open(out, "rb") as src, open(out + ".gz", "wb") as raw, \
                    gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
                shutil.copyfileobj(src, gz)
            os.remove(out)
            out += ".gz"
        with open(os.path.join(args.out, os.path.splitext(fx["name"])[0] + ".truth.json"), "w",
                  encoding="utf-8", newline="\n") as f:
            json.dump(t, f, ensure_ascii=False, indent=2)
            f.write("\n")
        size = os.path.getsize(out)
        total += size
        print(f"{fx['name']}: {size / 1e6:.2f} MB")
    print(f"合計 {total / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
