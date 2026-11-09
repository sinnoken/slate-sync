#!/usr/bin/env python3
"""
make_test_media.py — 產生已知漂移量與起點的波形碼測試檔，用來驗證分析器。

輸出立體聲：左聲道為模擬現場收音，右聲道為波形碼（格式見 docs/waveform-code.md）。
檔案時間 = (真實時間 − 起點) × 速率，速率 = 1 + ppm × 10⁻⁶。

用法：
  python make_test_media.py out.wav --minutes 4 --ppm 833 --start 12:34:56.789
  python make_test_media.py out.wav --plug 70                # 只有頭尾各 70 秒有波形碼
  python make_test_media.py out.mp4 --minutes 4 --ppm -694   # 另以 ffmpeg 加上 59.94 fps 測試畫面
  python make_test_media.py warm.wav --minutes 20 --ppm 800 --ppm-end 900   # 速率隨時間線性改變（模擬機身變熱）
需求：numpy；輸出 .mp4／.mov／.m4a 時另需 ffmpeg
"""
import argparse
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 48000


def wave_hz(minute, sec):
    return 600 + (((minute * 60 + sec) * 7919) % 19) * 80


def second(val, is_min, hz):
    """One second of waveform code (float array, 0.95 s long)."""
    n = int(SR * 0.95)
    d = np.zeros(n)

    def burst(t0, t1, amp):
        a, z = int(round(t0 * SR)), min(n, int(round(t1 * SR)))
        d[a:z] = amp * np.sin(2 * np.pi * hz * np.arange(z - a) / SR)

    def digit(t, v):
        if v == 0:
            burst(t, t + 0.1, 0.45)
            return t + 0.1
        for k in range(v):
            burst(t + k * 0.04, t + k * 0.04 + 0.02, 0.45)
        return t + v * 0.04 - 0.02

    burst(0, 0.25 if is_min else 0.04, 0.9)
    end = digit(0.3 if is_min else 0.1, val // 10)
    digit(end + 0.1, val % 10)
    return d


def parse_clock(s):
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + float(sec)


def main():
    ap = argparse.ArgumentParser(description="產生已知漂移量的波形碼測試檔")
    ap.add_argument("out")
    ap.add_argument("--minutes", type=float, default=4.0, help="檔案長度（分鐘），預設 4")
    ap.add_argument("--ppm", type=float, default=833.0, help="時鐘偏差（ppm），正值代表檔案比真實時間長")
    ap.add_argument("--start", default="12:34:56.789", help="檔案第 0 秒對應的真實時間")
    ap.add_argument("--plug", type=float, default=0, help="只在頭尾各這麼多秒放波形碼（0＝全程）")
    ap.add_argument("--ppm-end", type=float, default=None, help="結尾時的時鐘偏差；與 --ppm 之間線性變化（預設同 --ppm）")
    args = ap.parse_args()

    rate = 1 + args.ppm * 1e-6
    p0 = args.ppm * 1e-6
    p1 = (args.ppm_end if args.ppm_end is not None else args.ppm) * 1e-6
    r0 = parse_clock(args.start)
    dur = args.minutes * 60
    n = int(dur * SR)
    real_span = dur / (1 + (p0 + p1) / 2)                 # real seconds covered by the file

    def file_time(d):                                      # file seconds after d real seconds (clock ratio ramps p0 -> p1)
        return d + (p0 * d + (p1 - p0) * d * d / (2 * real_span))
    rng = np.random.default_rng(1)
    code = np.zeros(n)
    R = int(np.ceil(r0))
    while True:
        ft = file_time(R - r0)
        if (ft + 1) * SR >= n:
            break
        if not args.plug or ft < args.plug - 1 or ft > dur - args.plug:
            m, s = (R % 3600) // 60, R % 60
            b = second(m if s == 0 else s, s == 0, wave_hz(m, s))
            i = int(round(ft * SR))
            code[i:i + len(b)] += b
        R += 1
    scene = rng.normal(0, 0.1, n) * np.repeat(rng.uniform(0, 1, n // 2400 + 1) ** 2, 2400)[:n]
    pcm = (np.stack([scene, 0.5 * code], 1).clip(-1, 1) * 32767).astype("<i2")

    ext = os.path.splitext(args.out)[1].lower()
    wav_path = args.out if ext == ".wav" else tempfile.mktemp(suffix=".wav")
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    if ext != ".wav":
        cmd = ["ffmpeg", "-v", "error", "-y"]
        if ext in (".mp4", ".mov"):
            cmd += ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60000/1001", "-i", wav_path,
                    "-map", "0:v", "-map", "1:a", "-t", f"{dur}", "-c:v", "libx264", "-preset", "ultrafast"]
        else:
            cmd += ["-i", wav_path]
        cmd += ["-c:a", "aac", "-b:a", "192k", args.out]
        subprocess.run(cmd, check=True)
        os.remove(wav_path)
    if p0 == p1:
        print(f"{args.out}: 起點 {args.start}，時鐘偏差 {args.ppm:+.3f} ppm，"
              f"速度比例 {rate * 100:.6f} %，真實長度 {dur / rate:.6f} 秒")
    else:
        print(f"{args.out}: 起點 {args.start}，時鐘偏差由 {p0 * 1e6:+.1f} 變到 {p1 * 1e6:+.1f} ppm，真實長度 {real_span:.6f} 秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
