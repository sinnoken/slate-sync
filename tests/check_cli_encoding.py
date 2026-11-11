#!/usr/bin/env python3
"""
check_cli_encoding.py — 回歸測試：主控台編碼不是 UTF-8 時（如繁體中文 Windows 的 cp950），命令列報告必須完整印出。

報告含「▶」等 cp950 沒有的字元；若輸出時未處理，報告會在中途以 UnicodeEncodeError 結束。
以測試產生器做一段 2 分鐘的波形碼 WAV，在 PYTHONIOENCODING=cp950 下執行 slate_sync.py，
必須以 0 結束，且印出速度比例與校正後長度兩行。

需求：numpy、ffmpeg／ffprobe（在 PATH 中）
用法：python tests/check_cli_encoding.py
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "enc.wav")
        subprocess.run([sys.executable, os.path.join(HERE, "make_test_media.py"), wav, "--minutes", "2", "--ppm", "500"],
                       check=True, capture_output=True)
        env = dict(os.environ, PYTHONIOENCODING="cp950")
        p = subprocess.run([sys.executable, os.path.join(ROOT, "python", "slate_sync.py"), wav],
                           capture_output=True, env=env)
        out = p.stdout.decode("cp950", errors="replace")
        ok = p.returncode == 0 and "速度比例" in out and "校正後長度" in out
        print("通過" if ok else "失敗")
        if not ok:
            print("結束碼", p.returncode)
            print(p.stderr.decode("cp950", errors="replace")[-800:])
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
