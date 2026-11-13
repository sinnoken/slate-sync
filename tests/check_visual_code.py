#!/usr/bin/env python3
"""
check_visual_code.py — 檢查畫面碼（AprilTag，規格見 docs/visual-code.md）的碼表、繪製與 ID 公式。

1. 碼表一致：場記板（web/sync-slate.html）、分析器（src/web/main.js）內嵌的 JS 常數
   TAG36H11_CODES／TAG36H11_BIT_X／TAG36H11_BIT_Y，與測試產生器（tests/make_test_media.py）的 Python 常數必須相同，
   並與 pupil-apriltags 內建的官方 tag36h11 族一致；加 --official 時另與官方 tag36h11.c 比對。
2. 繪製：以測試產生器的 draw_tag() 畫出 ID 0–539（含 1 格靜區，每格數像素），pupil-apriltags 必須全部讀對。
3. ID 公式：ID = (午夜起秒數) mod 540，抽查跨整點、跨日。

任何一項不符或某個檔案缺少常數時，以非 0 結束。

需求：numpy、pupil-apriltags
用法：
  python tests/check_visual_code.py
  python tests/check_visual_code.py --official path/to/tag36h11.c
"""
import argparse
import importlib.util
import os
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAMES = ("TAG36H11_CODES", "TAG36H11_BIT_X", "TAG36H11_BIT_Y")
SIZES = {"TAG36H11_CODES": 587, "TAG36H11_BIT_X": 36, "TAG36H11_BIT_Y": 36}


def load_generator():
    spec = importlib.util.spec_from_file_location("make_test_media", os.path.join(ROOT, "tests", "make_test_media.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def js_tables(path):
    """{name: [int, ...] 或 None（缺少）}，數字可為 16 進位或 10 進位。"""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    out = {}
    for name in NAMES:
        m = re.search(r"\bvar\s+" + name + r"\s*=\s*\[(.*?)\]", src, re.S)
        out[name] = [int(v, 0) for v in re.findall(r"0[xX][0-9a-fA-F]+|\d+", m.group(1))] if m else None
    return out


def official_c(path):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    body = src[src.index("codedata[587]"):]
    body = body[:body.index("};")]
    bx = dict(re.findall(r"bit_x\[(\d+)\]\s*=\s*(\d+);", src))
    by = dict(re.findall(r"bit_y\[(\d+)\]\s*=\s*(\d+);", src))
    return {"TAG36H11_CODES": [int(h, 16) for h in re.findall(r"0x([0-9a-fA-F]+)UL", body)],
            "TAG36H11_BIT_X": [int(bx[str(i)]) for i in range(36)],
            "TAG36H11_BIT_Y": [int(by[str(i)]) for i in range(36)]}


def library_tables(det):
    """pupil-apriltags 內建的 tag36h11 族（與官方 C 程式庫同一份）。讀取的是套件的內部結構，取不到時回傳 None。"""
    try:
        fam = det.tag_families["tag36h11"].contents
        return {"TAG36H11_CODES": [fam.codes[i] for i in range(fam.ncodes)],
                "TAG36H11_BIT_X": [fam.bit_x[i] for i in range(fam.nbits)],
                "TAG36H11_BIT_Y": [fam.bit_y[i] for i in range(fam.nbits)]}
    except Exception:
        return None


def main():
    if hasattr(sys.stdout, "reconfigure"):  # cp950 等主控台印不出 ✓ 時以替代字元輸出
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description="檢查畫面碼碼表、繪製與 ID 公式")
    ap.add_argument("--official", help="官方 tag36h11.c 的路徑（選用）")
    args = ap.parse_args()
    fail = 0
    gen = load_generator()
    sources = {"測試產生器 tests/make_test_media.py": {n: list(getattr(gen, n)) for n in NAMES}}
    for rel in ("web/sync-slate.html", "src/web/main.js"):
        sources[rel] = js_tables(os.path.join(ROOT, rel))
    try:
        from pupil_apriltags import Detector
    except ImportError:
        print("✗ 缺少 pupil-apriltags：pip install pupil-apriltags")
        return 1
    det = Detector(families="tag36h11", quad_decimate=1.0)
    lib = library_tables(det)
    ref_name, ref = ("pupil-apriltags 內建 tag36h11", lib) if lib else ("測試產生器", sources["測試產生器 tests/make_test_media.py"])
    if lib is None:
        print("! 無法讀取 pupil-apriltags 內建碼表，改以測試產生器為比對基準")
    if args.official:
        off = official_c(args.official)
        sources["官方 " + args.official] = off

    # 1) Tables
    print(f"碼表比對（基準：{ref_name}）")
    for name in NAMES:
        if len(ref[name]) != SIZES[name]:
            print(f"  ✗ 基準的 {name} 有 {len(ref[name])} 個，應為 {SIZES[name]}")
            fail += 1
    for src, tab in sources.items():
        for name in NAMES:
            v = tab[name]
            if v is None:
                print(f"  ✗ {src}：缺少 {name}")
                fail += 1
            elif v != ref[name]:
                diff = next((i for i, (a, b) in enumerate(zip(v, ref[name])) if a != b), min(len(v), len(ref[name])))
                print(f"  ✗ {src}：{name} 不同（{len(v)} 個，第 {diff} 個起不符）")
                fail += 1
            else:
                print(f"  ✓ {src}：{name}（{len(v)} 個）")

    # 2) Drawing: every ID 0-539 must come back from the official detector.
    bad = []
    for idx in range(gen.VIS_MOD):
        img = np.pad(gen.draw_tag(idx, 4), 12, constant_values=128)
        found = [d.tag_id for d in det.detect(img)]
        if found != [idx]:
            bad.append((idx, found))
    if bad:
        print(f"繪製：✗ {len(bad)} 個 ID 讀錯，例如 {bad[:5]}")
        fail += 1
    else:
        print(f"繪製：✓ ID 0–{gen.VIS_MOD - 1} 全部讀對（每格 4 像素、1 格靜區）")

    # 3) ID formula
    cases = [("10:24:37", 217), ("10:26:59", 359), ("10:27:00", 360), ("10:30:00", 0), ("10:59:59", 179), ("11:00:00", 180),
             ("23:59:59", 539), ("00:00:00", 0), ("00:08:59", 539), ("00:09:00", 0)]
    bad_id = 0
    for clock, want in cases:
        h, m, s = (int(v) for v in clock.split(":"))
        got = gen.tag_id(h * 3600 + m * 60 + s)
        if got != want or got % 60 != s or got // 60 != (h * 60 + m) % 9:
            print(f"ID 公式：✗ {clock} → {got}，應為 {want}")
            bad_id += 1
    seq = [gen.tag_id(t) for t in range(86400 * 2)]          # continuous across hours and midnight
    if any((b - a) % gen.VIS_MOD != 1 for a, b in zip(seq, seq[1:])):
        print("ID 公式：✗ 相鄰兩秒的 ID 不連續")
        bad_id += 1
    fail += bad_id
    if not bad_id:
        print(f"ID 公式：✓ 抽查 {len(cases)} 個時間（含 10:59:59→11:00:00、23:59:59→00:00:00），兩天內逐秒連續")
    print("結果：" + ("全部通過" if not fail else f"{fail} 項不符"))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
