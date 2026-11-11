#!/usr/bin/env python3
"""
slate_sync.py — 讀取「同步場記板」波形碼，算出每個錄音／錄影檔的起點真實時間與校正後長度。

目標：把每個檔案校正到正確的時長、放到正確的起點，讓每一格畫面與每一條軌道都同步。

流程：
  1. 從開頭與結尾同時往內找，各自找到就停；兩邊碰頭仍沒找到，表示那一端沒錄。
  2. 找到後依目標精度（預設檔案任何位置 ±1 ms）決定再讀多少。
  3. 預設讀到波形碼就停。加 --minute 時再多讀約 1 分鐘尋找分鐘標記，以顯示完整的時分秒。
  4. 頭尾讀到的所有秒前緣一起做直線擬合，得到速度比例與起點。
頭尾之間經過幾個整分鐘，由兩端各自量到的局部時鐘比例推算，不需要分鐘標記，錄多長都適用。
時鐘偏差超過 1% 視為讀取錯誤（實際設備遠小於此）。
模式自動判斷：頭尾、僅開頭、僅結尾；整段都有波形碼時加 --full 抽查中段，偏離直線即分段調速。
跨機對齊：以指定的基準檔為準，換算其他檔案的起點、播放速度與任一時刻（細部仍以畫面確認）。

需求：ffmpeg / ffprobe（在 PATH 中）、Python 3.8+、numpy
用法：
  python slate_sync.py 檔案1.mp4 檔案2.wav ...
  python slate_sync.py *.MP4 --ref A001.MP4          # 以 A001 為基準，列出其他檔案的位置與播放速度
  python slate_sync.py *.MP4 --ref A001.MP4 --at B002.MP4=125.5   # B002 的 125.5 秒對應 A001 的哪一秒
  python slate_sync.py rec.wav --channel 1           # 指定波形碼所在聲道（0 起算）
  python slate_sync.py cam.mp4 --only head          # 只錄了開頭（偷懶時）
  python slate_sync.py long.mp4 --full               # 整段都有波形碼：抽查中段，必要時分段
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys

import numpy as np

SR = 48000            # analysis sample rate
CHUNK = 8.0           # seconds decoded per read
STEP = 7.0            # advance per read (1 s overlap so no second is cut in half)
MINUTE_LOOK = 62.0    # extra seconds read after the first hit to also catch a :00 minute marker
NTSC = (24000 / 1001, 30000 / 1001, 60000 / 1001, 120000 / 1001)


# ---------------------------------------------------------------- ffmpeg helpers
def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration,start_time:format_tags=creation_time:"
         "stream=codec_type,avg_frame_rate,channels,sample_rate,nb_frames,duration,start_time",
         "-of", "json", path], capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr.strip() or "ffprobe failed")
    j = json.loads(out.stdout)
    fmt = j["format"]
    f_start = _f(fmt.get("start_time")) or 0.0
    info = {"duration": float(fmt["duration"]), "created": fmt.get("tags", {}).get("creation_time"),
            "fps": None, "v_frames": None, "v_dur": None, "v_off": None,
            "channels": 1, "a_dur": None, "a_off": 0.0, "has_audio": False}
    for s in j.get("streams", []):
        st = _f(s.get("start_time"))
        if s.get("codec_type") == "video" and info["v_off"] is None:
            num, den = (s.get("avg_frame_rate") or "0/1").split("/")
            if float(den) and float(num):
                info["fps"] = float(num) / float(den)
            try:
                info["v_frames"] = int(s.get("nb_frames")) or None
            except (TypeError, ValueError):
                pass
            info["v_dur"] = _f(s.get("duration"))
            info["v_off"] = (st - f_start) if st is not None else 0.0
        if s.get("codec_type") == "audio" and not info["has_audio"]:
            info["has_audio"] = True
            info["channels"] = int(s.get("channels") or 1)
            info["a_dur"] = _f(s.get("duration"))
            info["a_off"] = (st - f_start) if st is not None else 0.0
    if not info["has_audio"]:
        raise RuntimeError("檔案沒有音訊軌")
    return info


def read_audio(path, start, length, info):
    """Decode [start, start+length) of the file timeline (seconds from the file's start).
    Returns (samples (n, channels), file time of samples[0])."""
    start = max(0.0, start)
    # An input-side -ss on AAC makes ffmpeg start the output at the next packet boundary (up to 1024 samples,
    # 21 ms, late; a full packet late at 0). So seek the input to 1 s before the target and cut exactly on the
    # output side, which drops decoded samples by timestamp. Near the start, decode from the top and cut.
    pre = start - 1.0 if start >= 1.1 else 0.0
    cmd = ["ffmpeg", "-v", "error"] + (["-ss", f"{pre:.6f}"] if pre else []) + [
           "-i", path, "-ss", f"{start - pre:.6f}", "-t", f"{length:.6f}",
           "-vn", "-map", "0:a:0", "-ar", str(SR), "-f", "f32le", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode:
        raise RuntimeError("ffmpeg 解碼失敗：" + p.stderr.decode(errors="replace").strip())
    x = np.frombuffer(p.stdout, dtype=np.float32)
    ch = info["channels"]
    n = len(x) // ch
    # Raw PCM carries no timestamps: if the audio track starts after the requested point,
    # the first sample is the track's first sample, not `start`.
    return x[: n * ch].reshape(n, ch), max(start, info["a_off"])


# ---------------------------------------------------------------- decoding
def runs(mask, min_len=int(0.006 * SR), max_gap=int(0.006 * SR)):
    """Contiguous True runs; gaps shorter than max_gap are bridged and runs shorter than min_len dropped
    (envelope ripple on low carrier pitches can otherwise split one pulse in two)."""
    d = np.diff(mask.astype(np.int8), prepend=0, append=0)
    out = []
    for s, e in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
        if out and s - out[-1][1] < max_gap:
            out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return [(s, e) for s, e in out if e - s >= min_len]


WAVE_HZ = 600.0 + 80.0 * np.arange(19)          # the 19 legal carrier pitches


def edge_time(x, a, s, e, hz, phase):
    """Leading edge of a burst whose carrier is at `phase` (rad) when the gate opens. Finds the first sample
    above 40 % of the burst amplitude (high enough to ignore AAC/MP3 pre-echo), interpolates between samples,
    then steps back by the time the sine needs from `phase` to first reach |sin| = 0.4."""
    amp = np.percentile(a[s:e], 99)
    b = max(0, s - 200)
    th = 0.4 * amp
    i1 = b + int(np.argmax(a[b:e] > th))
    i0 = max(i1 - 1, 0)
    frac = (th - a[i0]) / max(a[i1] - a[i0], 1e-12) if i1 > i0 else 0.0
    ph = phase % np.pi                                   # |sin| repeats every pi
    lo, hi = np.arcsin(0.4), np.pi - np.arcsin(0.4)
    wait = 0.0 if lo <= ph <= hi else ((lo - ph) % np.pi)  # already loud enough, or wait for the next rise
    return (i0 + frac) / SR - wait / (2 * np.pi * hz)


def decode(x, t0):
    """Find every complete second in mono signal x (x[0] is at file time t0).
    Returns a list of {t: leading-edge file time, val, is_min}.

    Bursts are told apart by DURATION and POSITION only, never by loudness, so clipping, limiting and
    automatic gain control do not matter: sync 40 ms, minute sync 250 ms, digit pulse 20 ms, zero 100 ms."""
    if len(x) < SR:
        return []
    a = np.abs(x.astype(np.float64))
    k = 192  # 4 ms moving average: longer than two periods of the lowest carrier (600 Hz)
    c = np.cumsum(np.concatenate(([0.0], a)))
    env = np.empty_like(a)
    env[k - 1:] = (c[k:] - c[:-k]) / k
    env[:k - 1] = env[k - 1]
    # Local reference level: loudest 10 ms block within ±0.6 s, so the threshold follows gain changes.
    blk = 480
    nb = len(env) // blk
    if nb < 3:
        return []
    bm = env[:nb * blk].reshape(nb, blk).max(axis=1)
    w = 60
    padded = np.concatenate((np.zeros(w), bm, np.zeros(w)))
    roll = np.lib.stride_tricks.sliding_window_view(padded, 2 * w + 1).max(axis=1)
    ref = np.repeat(roll, blk)
    ref = np.concatenate((ref, np.full(len(env) - len(ref), roll[-1])))
    if ref.max() < 1e-4:
        return []
    ref = np.maximum(ref, ref.max() * 1e-3)               # don't amplify near-silence into noise
    on = runs(env > 0.25 * ref)
    bursts = [(s / SR, e / SR) for s, e in on]
    out = []
    for i, (s, e) in enumerate(on):
        dur = (e - s) / SR
        if 0.025 <= dur <= 0.07:
            is_min = False
        elif 0.2 <= dur <= 0.3:
            is_min = True
        else:
            continue
        # Carrier pitch from the sync burst, snapped to the nearest legal pitch (they are 80 Hz apart; a
        # recorder's clock error moves them by under 1 %). The oscillator starts at phase 0 with the sync.
        # Which of the 19 legal pitches the sync burst carries (matched directly, so noise does not bias it;
        # a recorder's clock moves pitch by under 1 %, far less than the 80 Hz spacing). The exact pitch
        # then drives the edge corrections.
        seg = x[s:e] * np.hanning(e - s)
        tt = np.arange(e - s) / SR
        hz = float(WAVE_HZ[np.argmax([abs(np.dot(seg, np.exp(-2j * np.pi * f * tt))) for f in WAVE_HZ])])
        onset = edge_time(x, a, s, e, hz, 0.0)
        if onset + 0.95 > len(x) / SR:
            continue  # second not complete inside this chunk
        # Everything between this sync burst and the next second belongs to the two digit groups.
        pulses = [q for q in bursts[i + 1:] if q[0] < onset + 0.97]
        groups, cur = [], []
        for p in pulses:
            if cur and p[0] - cur[-1][1] > 0.06:
                groups.append(cur)
                cur = []
            cur.append(p)
        if cur:
            groups.append(cur)
        if len(groups) != 2:
            continue
        digits, timed = [], [(onset, 0.0)]
        expect = onset + (0.3 if is_min else 0.1)          # where the tens group must begin
        nominal = 0.3 if is_min else 0.1                   # same, on the phone's own time line
        for g in groups:
            if abs(g[0][0] - expect) > 0.02:
                digits = None
                break
            lens = [q[1] - q[0] for q in g]
            if len(g) == 1 and 0.08 <= lens[0] <= 0.125:
                digits.append(0)
                gend = expect + 0.1
                offs = [nominal]
                nend = nominal + 0.1
            elif all(0.01 <= L <= 0.035 for L in lens) and all(
                    0.034 <= g[j + 1][0] - g[j][0] <= 0.046 for j in range(len(g) - 1)):
                digits.append(len(g))
                gend = expect + len(g) * 0.04 - 0.02
                offs = [nominal + j * 0.04 for j in range(len(g))]
                nend = nominal + len(g) * 0.04 - 0.02
            else:
                digits = None
                break
            # Every digit pulse is another timing point: its offset from the second's start is fixed by the
            # format, and the carrier phase at its gate is 2*pi*pitch*offset (one oscillator per second).
            for q, off in zip(g, offs):
                qs, qe = int(round(q[0] * SR)), int(round(q[1] * SR))
                timed.append((edge_time(x, a, qs, qe, hz, 2 * np.pi * hz * off), off))
            expect = gend + 0.1                              # units group starts 0.1 s after tens group
            nominal = nend + 0.1
        if not digits or digits[0] > 5 or digits[1] > 9:
            continue
        val = digits[0] * 10 + digits[1]
        if not is_min and val == 0:
            continue
        out.append({"t": t0 + onset, "val": val, "is_min": is_min,
                    "pulses": [(t0 + tp, off) for tp, off in timed]})
    return out


def label(seconds):
    """Give each consistent decoded second a real-time label.
    Returns ([(file_t, real_label), ...], modulus): seconds-in-hour if a minute marker was seen, else seconds-in-minute."""
    if not seconds:
        return None
    seconds = sorted(seconds, key=lambda s: s["t"])
    ref = seconds[0]
    r_ref = 0 if ref["is_min"] else ref["val"]
    def consistent(s):
        dt = s["t"] - ref["t"]
        k = round(dt)
        return ((r_ref + k) % 60) == (0 if s["is_min"] else s["val"]) and abs(dt - k) <= 0.01 * abs(k) + 0.005
    good = [s for s in seconds if consistent(s)]
    if len(good) < max(1, len(seconds) // 2):
        return None
    marker = next((s for s in good if s["is_min"]), None)
    if marker:
        base = marker["val"] * 60
        return [(s["t"], (base + round(s["t"] - marker["t"])) % 3600) for s in good], 3600
    return [(s["t"], (r_ref + round(s["t"] - ref["t"])) % 60) for s in good], 60


class End:
    """Reads chunks from one end of the file toward the other. Locating: until the code is found or the search
    limit is reached. Refining: one more chunk per call while the code continues, up to max_read seconds."""

    def __init__(self, path, info, chan, start, direction, limit, max_read):
        self.path, self.info, self.chan, self.dir = path, info, chan, direction
        self.pos, self.origin, self.limit, self.max_read = start, start, limit, max_read
        self.found, self.used = [], None
        self.started = self.done = False
        self.idle = 0
        self.read_since_found = 0.0

    def step(self):
        if self.done:
            return
        D = self.info["duration"]
        a, b = (self.pos, min(self.pos + CHUNK, D)) if self.dir > 0 else (max(self.pos - CHUNK, 0.0), self.pos)
        if b - a < 1.0:
            self.done = True
            return
        x, t0 = read_audio(self.path, a, b - a, self.info)
        if len(x) == 0:
            self.done = True
            return
        cands = range(x.shape[1]) if self.chan is None else [self.chan]
        ch, secs = max(((c, decode(x[:, c], t0)) for c in cands), key=lambda z: len(z[1]))
        new = [d for d in secs if all(abs(d["t"] - f["t"]) > 0.5 for f in self.found)]
        if new:
            self.found += new
            self.used = ch
            self.started, self.idle = True, 0
        elif self.started:
            self.idle += 1
            if self.idle >= 2:                       # the code region has ended
                self.done = True
        if self.started:
            self.read_since_found += STEP
            if self.read_since_found >= self.max_read:
                self.done = True
        elif abs(self.pos - self.origin) >= self.limit:
            self.done = True                         # nothing within the search limit: this end was not recorded
        self.pos += STEP * self.dir

    def has_minute(self):
        return any(d["is_min"] for d in self.found)


# ---------------------------------------------------------------- analysis
def fmt_clock(sec, mod):
    sec %= mod
    h, m, s = int(sec // 3600), int(sec % 3600 // 60), sec % 60
    if mod == 60:
        return f"??:??:{s:06.3f}"
    if mod == 3600:
        return f"??:{m:02d}:{s:06.3f}"
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def hour_hint(info, path):
    """(local seconds-of-day, source) from container creation time, else file mtime. Display only."""
    try:
        if info["created"]:
            t = dt.datetime.fromisoformat(info["created"].replace("Z", "+00:00")).astimezone()
            src = "檔案建立時間"
        else:
            t = dt.datetime.fromtimestamp(os.path.getmtime(path))
            src = "檔案修改時間（可能不準）"
        return t.hour * 3600 + t.minute * 60 + t.second, src
    except Exception:
        return None, None


def wrap(v, mod):
    return ((v + mod / 2) % mod) - mod / 2


def solve(head, tail, probes):
    """Fit file_t = c + rate * R over every labelled second. R is real seconds since the first head second
    (or the first second read, in single-end mode). Returns a dict, or {"error": ...}."""
    lab_h = label(head) if head else None
    lab_t = label(tail) if tail else None
    if not lab_h and not lab_t:
        return {"error": "讀到的秒數彼此不一致，無法判讀"}
    if lab_h and lab_t:
        (lh, mod_h), (lt, mod_t) = lab_h, lab_t
        t_h, r_h = lh[0]
        t_t, r_t = lt[-1]
        file_diff = t_t - t_h

        def local_ratio(lab):
            if len(lab) < 2:
                return None, 0.0
            T = np.array([t for t, _ in lab])
            R0 = np.array([round(t - lab[0][0]) for t, _ in lab], dtype=float)
            span = R0[-1] - R0[0]
            if span < 2:
                return None, 0.0
            k = np.polyfit(R0, T, 1)[0]
            return (k, span) if abs(k - 1) <= 0.01 else (None, 0.0)
        locs = [x for x in (local_ratio(lh), local_ratio(lt)) if x[0] is not None]
        rho = sum(k * w for k, w in locs) / sum(w for _, w in locs) if locs else 1.0
        span = max((w for _, w in locs), default=0.0)
        pred = file_diff / rho
        rd = (r_t - r_h) % 60
        real_diff = rd + 60 * round((pred - rd) / 60)
        if real_diff <= 0:
            return {"error": "頭尾讀到的時間不合理"}
        ambiguous = (0.003 / span if span else 0.01) * pred > 15 or abs(pred - real_diff) > 15
        if mod_h == 3600 and mod_t == 3600 and (r_t - r_h - real_diff) % 3600 != 0:
            mod_h = mod_t = 60
        if mod_h == 3600:
            base, mod = r_h % 3600, 3600
        elif mod_t == 3600:
            base, mod = (r_t - real_diff) % 3600, 3600
        else:
            base, mod = r_h % 60, 60
        pts = [(t, float(round(t - t_h))) for t, _ in lh] + [(t, real_diff - float(round(t_t - t))) for t, _ in lt]
        clusters = [("開頭", [p[0] for p in pts[:len(lh)]])]
        tail_cluster = ("結尾", [t for t, _ in lt])
    else:
        lab, mod = lab_h or lab_t
        t0, r0 = lab[0]
        base = r0 % mod
        ambiguous = False
        pts = [(t, float(round(t - t0))) for t, _ in lab]
        clusters, tail_cluster = [("開頭" if lab_h else "結尾", [t for t, _ in lab])], None

    T = np.array([p[0] for p in pts])
    R = np.array([p[1] for p in pts], dtype=float)
    keep = np.ones(len(T), bool)
    for _ in range(3):                                  # drop edges more than 2 ms off the line, refit
        rate, c = np.polyfit(R[keep], T[keep], 1)
        new = np.abs(T - (c + rate * R)) < 0.002
        if new.sum() < 2 or (new == keep).all():
            break
        keep = new
    rate, c = np.polyfit(R[keep], T[keep], 1)

    # Refine each second's start from ALL its pulses (sync + digits): pulse k at nominal offset o_k (phone
    # seconds) sits at t_k = start + o_k * rate in the file. Median-reject pulses > 1 ms off, average the rest.
    # One refined time per second keeps the statistics honest (pulses in a second share any per-second jitter).
    pulses = {round(d["t"], 6): d.get("pulses") for d in list(head) + list(tail) + [d for p in probes for d in p]}

    def refine(t, rate):
        pl = pulses.get(round(t, 6))
        if not pl or len(pl) < 2:
            return t
        est = np.array([tp - off * rate for tp, off in pl])
        good = est[np.abs(est - np.median(est)) < 0.001]
        return float(good.mean()) if len(good) else t
    def rms_of(T_, keep_, rate_, c_):
        r_ = (T_ - (c_ + rate_ * R))[keep_]
        return float(np.sqrt((r_ ** 2).mean())) if len(r_) else float("inf")
    sync_fit = (T.copy(), keep.copy(), rate, c)
    rms_sync = rms_of(T, keep, rate, c)
    T = np.array([refine(t, rate) for t in T])
    keep = np.ones(len(T), bool)
    for _ in range(3):
        rate, c = np.polyfit(R[keep], T[keep], 1)
        new = np.abs(T - (c + rate * R)) < 0.002
        if new.sum() < 2 or (new == keep).all():
            break
        keep = new
    rate, c = np.polyfit(R[keep], T[keep], 1)
    # Keep whichever timing scatters less from second to second: on clean signals the sync edge alone is
    # already near-perfect; under noise, averaging every pulse of the second wins.
    used_pulses = rms_of(T, keep, rate, c) < 0.9 * rms_sync
    if not used_pulses:
        T, keep, rate, c = sync_fit
    pts = [(float(t), r) for t, (_, r) in zip(T, pts)]
    if tail_cluster:                                   # rebuild the groups with the refined times
        nh = len(clusters[0][1])
        clusters = [("開頭", [p[0] for p in pts[:nh]])]
        tail_cluster = ("結尾", [p[0] for p in pts[nh:]])
    else:
        clusters = [(clusters[0][0], [p[0] for p in pts])]

    # Middle probes (full-recording mode): place each window's seconds with the current line, then add them.
    probe_clusters = []
    for secs in probes:
        lab = label(secs)
        if not lab:
            continue
        (lp, _m) = lab
        tp0, rp0 = lp[0]
        r_pred = (tp0 - c) / rate                       # real seconds since R = 0, from the fit so far
        rd = (rp0 - base) % 60
        R0 = rd + 60 * round((r_pred - rd) / 60)
        add = [(refine(t, rate) if used_pulses else t, R0 + float(round(t - tp0))) for t, _ in lp]
        pts += add
        probe_clusters.append(("中段", [t for t, _ in add]))
    if probe_clusters:
        T = np.array([p[0] for p in pts])
        R = np.array([p[1] for p in pts], dtype=float)
        rate, c = np.polyfit(R, T, 1)
        keep = np.abs(T - (c + rate * R)) < 0.05      # probes may sit off a straight line; only drop gross misreads
        rate, c = np.polyfit(R[keep], T[keep], 1)

    res = (T - (c + rate * R))[keep]
    n = int(keep.sum())
    rms = float(np.sqrt((res ** 2).mean()))
    if abs(rate - 1) > 0.01 or (not probe_clusters and rms > 0.005):
        return {"error": f"讀取結果不合理（速率偏差 {(rate - 1) * 100:+.3f}%，擬合殘差 {rms * 1000:.1f} ms），"
                         f"可能有秒數讀錯，請檢查訊號品質"}
    Rk = R[keep]
    sxx = float(((Rk - Rk.mean()) ** 2).sum())
    sigma = max(float(res.std(ddof=2)) if n > 2 else 0.0003, 1e-5)
    unc_ppm = sigma / np.sqrt(sxx) * 1e6 if sxx > 0 else float("nan")

    def pred_se(Rx):                                    # standard error of the fitted line at real time Rx (s)
        return sigma * np.sqrt(1 / n + (Rx - Rk.mean()) ** 2 / sxx) if sxx > 0 else float("inf")

    # Piecewise model when the middle sits off the line (full-recording mode only).
    cl = clusters + sorted(probe_clusters, key=lambda x: x[1][0]) + ([tail_cluster] if tail_cluster else [])
    segs, max_dev = None, None
    if probe_clusters and len(cl) >= 3:
        centers = []
        for name, ts in cl:
            idx = [i for i, p in enumerate(pts) if p[0] in ts]
            centers.append((name, float(np.mean([pts[i][0] for i in idx])), float(np.mean([pts[i][1] for i in idx]))))
        devs = [tc - (c + rate * rc) for _, tc, rc in centers]
        max_dev = max(abs(d) for d in devs) * 1000
        if max_dev > 2.0:
            segs = []
            for (n1, t1, r1), (n2, t2, r2) in zip(centers, centers[1:]):
                segs.append({"from": t1, "to": t2, "rate": (t2 - t1) / (r2 - r1)})
    return {"rate": float(rate), "c": float(c), "base": base, "mod": mod, "ambiguous": bool(ambiguous),
            "n": n, "rejected": len(pts) - n, "rms": rms, "unc_ppm": unc_ppm, "pred_se": pred_se,
            "segs": segs, "max_dev_ms": max_dev, "both": bool(lab_h and lab_t), "used_pulses": bool(used_pulses),
            "which": "頭尾" if (lab_h and lab_t) else ("開頭" if lab_h else "結尾")}


def analyze(path, args):
    info = probe(path)
    D = info["duration"]
    limit = args.search * 60
    head = End(path, info, args.channel, 0.0, +1, limit, args.max_read)
    tail = End(path, info, args.channel, D, -1, limit, args.max_read)
    if args.only == "head":
        tail.done = True
    if args.only == "tail":
        head.done = True

    # 1) Locate: search inward from both ends at once; stop when each end finds the code or the searches meet.
    while not ((head.started or head.done) and (tail.started or tail.done)):
        if not (head.started or head.done):
            head.step()
        if not (tail.started or tail.done):
            tail.step()
        if head.pos >= tail.pos:
            head.done = head.done or not head.started
            tail.done = tail.done or not tail.started
            break
    if not head.found and not tail.found:
        return {"file": path, "error": "整個檔案都讀不到波形碼"}
    # Both searches may have run into the same stretch of code (only one end was recorded): merge them.
    if head.found and tail.found and min(d["t"] for d in tail.found) - max(d["t"] for d in head.found) < 60:
        head.found = sorted(head.found + [d for d in tail.found if all(abs(d["t"] - f["t"]) > 0.5 for f in head.found)],
                            key=lambda d: d["t"])
        head.used = head.used if head.used is not None else tail.used
        tail.found, tail.done = [], True
        single_from = "結尾" if head.origin == 0.0 and head.found[0]["t"] > D / 2 else None
    else:
        single_from = None

    # 2) Refine: read on at the found ends until the target precision is met (or the code ends).
    fit = None
    while True:
        fit = solve(head.found, tail.found, [])
        if "error" in fit:
            break
        worst = max(fit["pred_se"]((0 - fit["c"]) / fit["rate"]), fit["pred_se"]((D - fit["c"]) / fit["rate"])) * 1000
        need_min = args.minute and not all(e.has_minute() for e in (head, tail) if e.found)
        if worst <= args.target and not need_min:
            break
        progressed = False
        for e in (head, tail):
            if e.found and not e.done:
                e.step()
                progressed = True
        if not progressed:
            break
    if "error" in fit:
        return {"file": path, **fit}

    # 3) Full-recording mode: probe the middle.
    probes = []
    if args.probe:
        lo = max((d["t"] for d in head.found), default=0.0) + 30
        hi = min((d["t"] for d in tail.found), default=D) - 30
        for k in range(args.probe):
            p0 = lo + (hi - lo) * (k + 1) / (args.probe + 1)
            if hi - lo < 60:
                break
            x, t0 = read_audio(path, p0, 3 * CHUNK, info)
            if len(x) == 0:
                continue
            cands = range(x.shape[1]) if args.channel is None else [args.channel]
            secs = max((decode(x[:, ch], t0) for ch in cands), key=len)
            if secs:
                probes.append(secs)
        if probes:
            fit = solve(head.found, tail.found, probes)
            if "error" in fit:
                return {"file": path, **fit}

    rate, c, base, mod = fit["rate"], fit["c"], fit["base"], fit["mod"]

    def real_at(t):
        return (base + (t - c) / rate) % mod

    v = info["v_off"] is not None
    fps = args.fps or info["fps"]
    for exact in NTSC:
        if fps and abs(fps - exact) < 0.005:
            fps = exact                                  # 59.94 -> 59.94005994...
    if v:
        m_off = info["v_off"]                            # media starts at the first picture frame
        m_len = info["v_frames"] / fps if (fps and info["v_frames"]) else (info["v_dur"] or (D - m_off))
        kind = "畫面"
    else:
        m_off = info["a_off"]
        m_len = info["a_dur"] or (D - m_off)
        kind = "音訊"

    # Corrected length: one speed, or the piecewise speeds when the middle bends away from a straight line.
    segs = fit["segs"]
    if segs:
        bounds = [m_off] + [sg["to"] for sg in segs[:-1]] + [m_off + m_len]
        rates = [sg["rate"] for sg in segs]
        corrected = sum((b2 - b1) / r for b1, b2, r in zip(bounds, bounds[1:], rates))
        seg_out = [{"file_from": b1 - m_off, "file_to": b2 - m_off, "speed": r} for b1, b2, r in zip(bounds, bounds[1:], rates)]
    else:
        corrected, seg_out = m_len / rate, None

    worst_ms = max(fit["pred_se"]((0 - c) / rate), fit["pred_se"]((D - c) / rate)) * 1000
    if seg_out:
        # Inside each segment the drift still bends: a chord over a span L with a speed change dr to its
        # neighbours sits about dr * L / 8 away at its middle (x1.3 margin for the longer end segments).
        sp = [g["speed"] for g in seg_out]
        worst_ms = 0.0
        for i, g in enumerate(seg_out):
            dr = max(abs(sp[i] - sp[j]) for j in (i - 1, i + 1) if 0 <= j < len(sp))
            worst_ms = max(worst_ms, 1.3 * dr * (g["file_to"] - g["file_from"]) / 8 * 1000)
    mode = "全段" if probes else ("頭尾" if fit["both"] else ("僅" + (single_from or fit["which"])))
    start_mod = real_at(m_off)
    start_clock, clock_mod, hint_src = start_mod, mod, None
    hint, src = hour_hint(info, path)
    if mod == 3600 and hint is not None:
        start_clock = round((hint - start_mod) / 3600) * 3600 + start_mod
        clock_mod, hint_src = 86400, src
    used = [e.used for e in (head, tail) if e.found]
    return {"file": path, "kind": kind, "mode": mode, "channel": [used[0], used[-1]],
            "start_label": start_mod, "mod": mod, "start_clock": start_clock, "clock_mod": clock_mod,
            "hint_src": hint_src, "length": m_len, "corrected_length": corrected,
            "frames": info["v_frames"] if v else None, "fps": fps,
            "rate": rate, "ppm": (rate - 1) * 1e6, "unc_ppm": fit["unc_ppm"], "worst_ms": worst_ms,
            "edges_used": fit["n"], "edges_rejected": fit["rejected"], "fit_rms_ms": fit["rms"] * 1000,
            "segments": seg_out, "mid_dev_ms": fit["max_dev_ms"],
            "a_off": info["a_off"], "v_off": info["v_off"], "ambiguous": fit["ambiguous"]}


def report(results, args):
    ok = [r for r in results if "error" not in r]
    for r in results:
        print("=" * 72)
        print(r["file"])
        if "error" in r:
            print(f"  ✗ {r['error']}")
            continue
        k = r["kind"]
        frames = f"（{r['frames']} 格）" if r["frames"] else ""
        print(f"  模式              : {r['mode']}")
        print(f"  ▶ 速度比例        : {r['rate'] * 100:.6f} %（以此速度播放即對齊真實時間）")
        print(f"  ▶ 校正後長度      : {r['corrected_length']:.6f} 秒（{k}原長 {r['length']:.6f} 秒{frames}）")
        print(f"    {k}起點真實時間  : {fmt_clock(r['start_clock'], r['clock_mod'])}"
              + (f"（「時」依{r['hint_src']}推定）" if r["clock_mod"] == 86400 else ""))
        print(f"    {k}結束真實時間  : {fmt_clock(r['start_clock'] + r['corrected_length'], r['clock_mod'])}")
        if r["fps"] and k == "畫面":
            print(f"  修正後影格率      : {r['fps']:.6f} → {r['fps'] * r['rate']:.6f} fps")
        print(f"  時鐘偏差          : {r['ppm']:+.3f} ppm（量測精度約 ±{r['unc_ppm']:.3f} ppm）")
        print(f"  預估誤差          : 檔案任何位置約 ±{r['worst_ms']:.3f} ms" + ("（分段後）" if r["segments"] else ""))
        if r["segments"]:
            print(f"  ⚠ 非線性漂移：中段偏離直線最多 {r['mid_dev_ms']:.1f} ms，建議分段調速（抽查越多處、分段越細越準）：")
            for sg in r["segments"]:
                print(f"      {sg['file_from']:10.3f} ～ {sg['file_to']:10.3f} 秒：播放速度 {sg['speed'] * 100:.6f} %")
        elif r["mid_dev_ms"] is not None:
            print(f"  中段實測偏差      : 最多 {r['mid_dev_ms']:.3f} ms（線性，不需分段）")
        if r["mode"].startswith("僅"):
            print("  ⚠ 只讀到單端：速率只代表那一小段時間，未涵蓋整段，機身溫度變化可能造成偏差")
        print(f"  擬合              : 使用 {r['edges_used']} 個秒前緣，殘差 {r['fit_rms_ms']:.3f} ms"
              + (f"，排除 {r['edges_rejected']} 個異常點" if r["edges_rejected"] else ""))
        ch, ct = r["channel"]
        print(f"  波形碼聲道        : 第 {ch + 1} 聲道" if ch == ct else
              f"  波形碼聲道        : 開頭第 {ch + 1} 聲道，結尾第 {ct + 1} 聲道")
        offs = f"音訊軌 {r['a_off']:+.6f} 秒" + (f"，畫面軌 {r['v_off']:+.6f} 秒" if r["v_off"] is not None else "")
        print(f"  軌道起點偏移      : {offs}（相對於檔案起點）")
        if r["mod"] == 60:
            print("  （未讀分鐘標記：起點時間只顯示分秒，相對位置在 ±30 秒內有效）")
        if r["ambiguous"]:
            print("  ⚠ 頭尾之間的整分鐘數無法確定，請確認結果是否合理（可加 --minute 或 --full）")
    if len(ok) > 1 or args.at:
        al = align(ok, args.ref)
        ref = al["ref"]
        print("=" * 72)
        print(f"對齊到基準檔：{ref['file']}（時間都以基準檔自己的時間軸計，從它的第一格起算）")
        for r, a in zip(ok, al["rows"]):
            tag = "（基準）" if r is ref else ""
            print(f"  {r['file']}{tag}")
            print(f"    起點位於基準檔   : {a['offset']:+.6f} 秒")
            print(f"    播放速度         : {a['speed'] * 100:.6f} %（以此速度播放即與基準檔時間軸一致）")
            print(f"    在基準時間軸長度 : {a['length']:.6f} 秒")
        if al["mod"] == 60:
            print("  （起點位置以秒數判定，各檔案開始時間相差須在 ±30 秒內；更大的差距請以畫面或 --minute 確認）")
        for spec in args.at or []:
            name, _, sec = spec.rpartition("=")
            r = next((x for x in ok if os.path.basename(x["file"]) == os.path.basename(name)), None)
            if r is None:
                print(f"  ✗ --at {spec}：找不到檔案 {name}")
                continue
            t = float(sec)
            print(f"  換算：{r['file']} 的 {t:.6f} 秒")
            for x, a in zip(ok, al["rows"]):
                if x is r:
                    continue
                print(f"    → {x['file']} 的 {convert(al, r, t, x):.6f} 秒")


def align(ok, ref_name):
    """Express every file on the reference file's own timeline (seconds from its first frame/sample).
    real(t) = start + t / rate  for a file's time t;  t_ref = (real - start_ref) * rate_ref."""
    ref = next((r for r in ok if ref_name and os.path.basename(r["file"]) == os.path.basename(ref_name)), ok[0])
    mod = 3600 if all(r["mod"] == 3600 for r in ok) else 60
    rows = []
    for r in ok:
        off_real = wrap(r["start_label"] - ref["start_label"], mod)
        rows.append({"offset": off_real * ref["rate"], "speed": r["rate"] / ref["rate"],
                     "length": r["length"] * ref["rate"] / r["rate"], "off_real": off_real})
    return {"ref": ref, "mod": mod, "rows": rows, "files": ok}


def convert(al, src, t, dst):
    """Time t (s, from src's first frame) -> the same instant on dst's own timeline."""
    real = wrap(src["start_label"] - dst["start_label"], al["mod"]) + t / src["rate"]
    return real * dst["rate"]


def main():
    ap = argparse.ArgumentParser(description="讀取同步場記板波形碼，計算起點真實時間與校正後長度")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--channel", type=int, help="波形碼所在聲道（0 起算），預設自動判斷")
    ap.add_argument("--fps", type=float, help="影格率，預設讀取檔案資訊")
    ap.add_argument("--ref", help="作為相對位置基準的檔名")
    ap.add_argument("--only", choices=["head", "tail"], help="只錄了開頭（head）或結尾（tail）：略過另一端的搜尋")
    ap.add_argument("--full", action="store_true", help="整段都有波形碼：抽查中段 3 處，偏離直線時改為分段調速")
    ap.add_argument("--probe", type=int, default=None, help="中段抽查處數（隱含 --full）")
    ap.add_argument("--target", type=float, default=1.0, help="目標精度：檔案任何位置的預估誤差（ms），預設 1")
    ap.add_argument("--search", type=float, default=30.0, help="每端最多往內找幾分鐘，預設 30")
    ap.add_argument("--max-read", type=float, default=120.0, help="找到後每端最多再讀幾秒，預設 120")
    ap.add_argument("--minute", action="store_true", help="讀到波形碼後再多讀約 1 分鐘尋找分鐘標記，以顯示完整的時分秒（較慢）")
    ap.add_argument("--json", action="store_true", help="以 JSON 輸出")
    ap.add_argument("--at", action="append", metavar="檔名=秒",
                    help="把某檔案的某一刻換算到其他檔案的時間，例如 --at B002.MP4=125.5（可重複）")
    args = ap.parse_args()
    args.probe = args.probe if args.probe is not None else (3 if args.full else 0)
    results = []
    for f in args.files:
        try:
            results.append(analyze(f, args))
        except Exception as e:  # keep going with the other files
            results.append({"file": f, "error": str(e)})
    if args.json:
        ok = [r for r in results if "error" not in r]
        if len(ok) > 1:
            al = align(ok, args.ref)
            for r, a in zip(ok, al["rows"]):
                r["align_to"] = os.path.basename(al["ref"]["file"])
                r["align_offset"], r["align_speed"], r["align_length"] = a["offset"], a["speed"], a["length"]
        print(json.dumps(results, ensure_ascii=False, indent=2, default=float))
    else:
        report(results, args)


if __name__ == "__main__":
    sys.exit(main())
