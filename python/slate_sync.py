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
畫面碼（AprilTag，docs/visual-code.md）：音訊讀不到波形碼（只拍到畫面的攝影機）或加 --av 時才解畫面，
流程與音訊相同；--av 另以秒號配對聲音與畫面邊緣，檢查聲畫同步。

需求：ffmpeg / ffprobe（在 PATH 中）、Python 3.8+、numpy；畫面碼另需 pupil-apriltags（選用）
用法：
  python slate_sync.py 檔案1.mp4 檔案2.wav ...
  python slate_sync.py *.MP4 --ref A001.MP4          # 以 A001 為基準，列出其他檔案的位置與播放速度
  python slate_sync.py *.MP4 --ref A001.MP4 --at B002.MP4=125.5   # B002 的 125.5 秒對應 A001 的哪一秒
  python slate_sync.py rec.wav --channel 1           # 指定波形碼所在聲道（0 起算）
  python slate_sync.py cam.mp4 --only head          # 只錄了開頭（偷懶時）
  python slate_sync.py long.mp4 --full               # 整段都有波形碼：抽查中段，必要時分段
  python slate_sync.py A.MP4 B.MP4 --av --distance 0.5   # 聲畫同步檢查（手機距麥克風 0.5 m）
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

import numpy as np

SR = 48000            # analysis sample rate
CHUNK = 8.0           # seconds decoded per read
STEP = 7.0            # advance per read (1 s overlap so no second is cut in half)
MINUTE_LOOK = 62.0    # extra seconds read after the first hit to also catch a :00 minute marker
NTSC = (24000 / 1001, 30000 / 1001, 60000 / 1001, 120000 / 1001)
VIS_MOD = 540         # visual code ID = seconds since local midnight mod 540 (9 minutes)
VIS_SHORT = 360       # frames are scaled to about this short side before detection
VCHUNK = 2.5          # minimum seconds per video read; reads end on a keyframe so the next one needs no pre-roll
VCHUNK_KEY = 4.0      # how far past VCHUNK to look for that keyframe
VIS_PLATEAU = 5.0     # stop when the estimated error has not dropped for this many seconds of video
SOUND = 343.0         # m/s, for --distance
INSTALL_HINT = "pip install pupil-apriltags"


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
         "stream=codec_type,avg_frame_rate,r_frame_rate,channels,sample_rate,nb_frames,duration,start_time",
         "-of", "json", path], capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr.strip() or "ffprobe failed")
    j = json.loads(out.stdout)
    fmt = j["format"]
    f_start = _f(fmt.get("start_time")) or 0.0
    info = {"duration": float(fmt["duration"]), "created": fmt.get("tags", {}).get("creation_time"),
            "fps": None, "vfr": False, "v_frames": None, "v_dur": None, "v_off": None, "f_start": f_start,
            "channels": 1, "a_dur": None, "a_off": 0.0, "has_audio": False}
    for s in j.get("streams", []):
        st = _f(s.get("start_time"))
        if s.get("codec_type") == "video" and info["v_off"] is None:
            num, den = (s.get("avg_frame_rate") or "0/1").split("/")
            if float(den) and float(num):
                info["fps"] = float(num) / float(den)
            rn, rd = (s.get("r_frame_rate") or "0/1").split("/")
            if info["fps"] and float(rd) and float(rn):
                # Average and nominal rates disagree: variable frame rate (phones). The frame grid is irregular.
                info["vfr"] = abs(float(rn) / float(rd) - info["fps"]) > 1e-3 * info["fps"]
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


# ---------------------------------------------------------------- visual code (AprilTag, docs/visual-code.md)
_DETECTOR = None


def detector():
    """pupil-apriltags detector, or None when it is not installed or cannot load (e.g. its DLL fails):
    the visual code is then disabled and visual_hint() says why."""
    global _DETECTOR, _DETECTOR_WHY
    if _DETECTOR is None:
        try:
            from pupil_apriltags import Detector
            # Frames are already small (short side ~360 px): detect quads at full resolution.
            # The library allows up to 2 bit errors for tag36h11 and tries all four rotations.
            _DETECTOR = Detector(families="tag36h11", nthreads=min(4, os.cpu_count() or 1), quad_decimate=1.0)
        except ImportError:
            _DETECTOR, _DETECTOR_WHY = False, "未安裝 pupil-apriltags"
        except Exception as e:                       # installed but unusable: keep the audio results going
            _DETECTOR, _DETECTOR_WHY = False, f"pupil-apriltags 無法載入（{type(e).__name__}: {e}）"
    return _DETECTOR or None


_DETECTOR_WHY = ""


def visual_hint():
    return f"{_DETECTOR_WHY or '未安裝 pupil-apriltags'}；安裝或重新安裝：{INSTALL_HINT}"


def video_packets(path, a, b, info):
    """Video packets (file time, bytes, is_keyframe) from the keyframe at or before a up to b.
    Demuxing only, no decoding: used to start each read on a keyframe and to count what is read."""
    fs = info["f_start"]
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals",
                          f"{a + fs:.6f}%{b + fs:.6f}", "-show_entries", "packet=pts_time,size,flags",
                          "-of", "csv=p=0", path], capture_output=True, text=True)
    pk = []
    for line in out.stdout.splitlines():
        p = line.split(",")
        t = _f(p[0]) if len(p) >= 3 else None
        if t is not None:
            pk.append((t - fs, int(p[1]), "K" in p[2]))
    return pk


SHOWINFO = re.compile(rb"pts_time:\s*(\S+).*?\bs:(\d+)x(\d+)")


def read_video(path, a, b, info):
    """Decode file time [a, b) to small grayscale frames. Returns [(file time, uint8 array)].

    ffmpeg seeks to the keyframe before a and drops earlier frames; -copyts keeps the file's own timestamps and
    showinfo prints each output frame's PTS (rawvideo itself carries none). passthrough keeps one output frame per
    decoded frame, so the showinfo lines and the frames line up one to one.
    Hardware decoding is used when hw_method() found one for this file (unless info["hwaccel"] is False): ffmpeg
    copies the decoded frames back to memory itself, so the same scale/gray filters follow. If ffmpeg fails or the
    output looks wrong (fewer frames than PTS lines), the read is repeated in software and the file stays on
    software. A read that simply has no frames (past the end) is not a failure. info["decoders"] collects what was actually used ("cuda", "d3d11va" or "software")."""
    hw = hw_method(path, info) if info.get("hwaccel", True) else None
    if hw:
        try:
            out, used = _read_video(path, a, b, info, hw)
            info.setdefault("decoders", set()).add(used)
            return out
        except RuntimeError as e:
            why = str(e)
        info["hwaccel"] = False
        info["hw_fallback"] = why[:200]
    out, used = _read_video(path, a, b, info, None)
    info.setdefault("decoders", set()).add(used)
    return out


HWACCELS = ("cuda", "d3d11va")


def hw_method(path, info):
    """First hardware decoder that decodes a short piece of this file cleanly (tried once per file), or None."""
    if "hw_method" not in info:
        info["hw_method"] = None
        for hw in HWACCELS:
            p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-v", "error", "-hwaccel", hw, "-t", "0.2",
                                "-i", path, "-map", "0:v:0", "-an", "-vf", "scale=w=-2:h=64,format=gray",
                                "-f", "rawvideo", "-"], capture_output=True)
            if p.returncode == 0 and p.stdout and not p.stderr.strip():
                info["hw_method"] = hw
                break
    return info["hw_method"]


def _read_video(path, a, b, info, hw):
    vf = (f"scale=w='if(gt(iw,ih),-2,min({VIS_SHORT},iw))':h='if(gt(iw,ih),min({VIS_SHORT},ih),-2)':flags=area,"
          "format=gray,showinfo")
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-v", "info"]
    cmd += ["-hwaccel", hw] if hw else []
    cmd += ["-copyts", "-ss", f"{max(a, 0.0):.6f}", "-t", f"{b - a:.6f}", "-i", path, "-map", "0:v:0", "-an",
            "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode:
        raise RuntimeError("ffmpeg 解碼畫面失敗：" + p.stderr.decode(errors="replace").strip()[-300:])
    out, pos = [], 0
    for line in p.stderr.splitlines():
        if b"Parsed_showinfo" not in line:
            continue
        m = SHOWINFO.search(line)
        t = _f(m.group(1).decode()) if m else None
        if t is None:
            continue
        w, h = int(m.group(2)), int(m.group(3))
        if pos + w * h > len(p.stdout):
            raise RuntimeError("ffmpeg 輸出的影格數與時間戳記數不符")
        out.append((t - info["f_start"], np.frombuffer(p.stdout, np.uint8, w * h, pos).reshape(h, w)))
        pos += w * h
    return out, hw or "software"


def frame_edges(frames, fi):
    """Frame-level edges: a frame showing ID n whose nearest earlier decoded frame showed n - 1 (mod 540), with only
    undecodable transition frames between them. Edge at the midpoint, ±half the gap (±half a frame with no
    transition frame). frames: {file time: ID or None}; fi: frame interval (s)."""
    out, last, prev = [], None, None
    for t in sorted(frames):
        idx = frames[t]
        if prev is not None and t - prev > 1.5 * fi:
            last = None                                  # frames not contiguous (a gap between reads)
        prev = t
        if idx is None:
            continue
        if last and idx == (last[1] + 1) % VIS_MOD and t - last[0] <= 3.5 * fi:
            out.append({"t": (last[0] + t) / 2, "half": (t - last[0]) / 2, "val": idx, "is_min": False})
        last = (t, idx)
    return out


def label_visual(edges, fi):
    """Visual counterpart of label(): keep the edges that step up by one ID per second (about 1 s apart).
    The reference edge is the one most others agree with. Returns ([(file_t, ID), ...], 540)."""
    if not edges:
        return None
    edges = sorted(edges, key=lambda e: e["t"])

    def agree(ref):
        out = []
        for e in edges:
            dt = e["t"] - ref["t"]
            k = round(dt)
            if (ref["val"] + k) % VIS_MOD == e["val"] and abs(dt - k) <= 0.01 * abs(k) + 3 * fi:
                out.append((e["t"], (ref["val"] + k) % VIS_MOD))
        return out
    good = max((agree(r) for r in edges), key=len)
    if len(good) < max(1, len(edges) // 2):
        return None
    return good, VIS_MOD


class VEnd:
    """Video counterpart of End: reads one end of the file toward the other and detects the tag in every frame.
    Reads start and end on keyframes where possible, so nothing is decoded twice; every frame's result is kept and
    the edges are rebuilt from all of them, so an edge that straddles two reads is not lost."""

    def __init__(self, path, info, start, direction, limit, max_read, fi):
        self.path, self.info, self.dir, self.fi = path, info, direction, fi
        self.pos, self.origin, self.limit, self.max_read = start, start, limit, max_read
        self.frames, self.edges = {}, []
        self.started = self.done = False
        self.idle = 0
        self.read_since_found = 0.0
        self.roi, self.miss = None, 0
        self.decoded, self.bytes = 0.0, 0                 # seconds actually decoded (incl. pre-roll), bytes read

    def plan(self):
        D = self.info["duration"]
        if self.dir > 0:
            a = self.pos
            pk = video_packets(self.path, a, min(a + VCHUNK + VCHUNK_KEY, D), self.info)
            later = sorted(t for t, _, k in pk if k and t >= a + VCHUNK - 1e-6)
            b = min(later[0] if later else a + VCHUNK, D)
        else:
            b = self.pos
            pk = video_packets(self.path, max(b - VCHUNK, 0.0), b, self.info)
            keys = [t for t, _, k in pk if k and t <= b - VCHUNK + 1e-6]
            a = max(keys) if keys else max(b - VCHUNK, 0.0)
            a = max(a, 0.0)
        k0 = max([t for t, _, k in pk if k and t <= a + 1e-6], default=a)
        nbytes = sum(sz for t, sz, _ in pk if k0 - 1e-6 <= t < b)
        return a, b, k0, nbytes

    def detect(self, img, det):
        """Tag ID in this frame, or None. After a hit only the tag's area (grown by 25 %) is searched;
        three misses in a row go back to the whole frame. IDs 540-586 are not used by the slate."""
        h, w = img.shape
        x0 = y0 = 0
        sub = img
        if self.roi:
            x0, y0, x1, y1 = self.roi
            sub = np.ascontiguousarray(img[y0:y1, x0:x1])
        best = None
        for d in det.detect(sub):
            if d.tag_id >= VIS_MOD:
                continue
            c = d.corners
            area = 0.5 * abs(np.dot(c[:, 0], np.roll(c[:, 1], 1)) - np.dot(c[:, 1], np.roll(c[:, 0], 1)))
            if best is None or area > best[0]:
                best = (area, d)
        if best is None:
            if self.roi:
                self.miss += 1
                if self.miss >= 3:
                    self.roi, self.miss = None, 0
            return None
        c = best[1].corners + (x0, y0)
        lo, hi = c.min(axis=0), c.max(axis=0)
        m = (hi - lo) * 0.25
        self.roi = (int(max(0, lo[0] - m[0])), int(max(0, lo[1] - m[1])),
                    int(min(w, hi[0] + m[0] + 1)), int(min(h, hi[1] + m[1] + 1)))
        self.miss = 0
        return int(best[1].tag_id)

    def step(self, det):
        """Read one more stretch; returns its length in seconds (0 when finished)."""
        if self.done:
            return 0.0
        D = self.info["duration"]
        if (self.dir > 0 and D - self.pos < 0.2) or (self.dir < 0 and self.pos < 0.2):
            self.done = True
            return 0.0
        a, b, k0, nbytes = self.plan()
        if b - a < 0.05:
            self.done = True
            return 0.0
        frames = read_video(self.path, a, b, self.info)
        self.decoded += b - k0
        self.bytes += nbytes
        for t, img in frames:
            if a - 1e-3 <= t < b:
                self.frames[round(t, 6)] = self.detect(img, det)
        n0 = len(self.edges)
        self.edges = frame_edges(self.frames, self.fi)
        if len(self.edges) > n0:
            self.started, self.idle = True, 0
        elif self.started:
            self.idle += 1
            if self.idle >= 2:
                self.done = True
        if self.started:
            self.read_since_found += b - a
            if self.read_since_found >= self.max_read:
                self.done = True
        elif abs(self.pos - self.origin) >= self.limit:
            self.done = True
        self.pos = b if self.dir > 0 else a
        return b - a


def exact_fps(fps):
    for exact in NTSC:
        if fps and abs(fps - exact) < 0.005:
            return exact                                 # 59.94 -> 59.94005994...
    return fps


def vis_floor(fps, fit, ends, D, vfr=False):
    """Lower bounds for frame-level timing: (position error anywhere in the file in s, speed-ratio error).
    h = half a frame. Frame-level edges only average out their quantisation when successive seconds fall at
    different phases of the frame grid; per end the residual F is the largest of:
      - h when the frame rate divides one second (docs/visual-code.md), the frame grid is irregular (VFR) or the
        fit is unknown;
      - sweep: the phase moves by step = |frac(fps x rate)| frames per real second (29.97 fps on a clock 833 ppm
        fast barely moves); counting only the part of step the speed bound cannot explain,
        sure = max(0, step - fps x 2F / base), an end whose edges span S seconds sweeps k = sure x S frames and
        keeps h / max(1, k);
      - coverage: the phases the edges actually fell at (from the fit), phase = frac((edge - last old frame) / fi);
        the widest circular gap g between the n edges' phases leaves h x min(1, g + 1/n) (a step near 1/2 or 1/3
        only ever hits 2 or 3 phases; 1/n covers where the edges sit within the gaps).
    Each end's mean edge time is off by at most F. Speed bound: two ends can be off in opposite directions,
    2F / base with base = distance between the ends' mean edge times; one end alone: a least-squares slope through
    points each off by at most F over a span S is off by at most 3F / S. Position bound anywhere in the file:
    F + speed bound x reach, reach = largest distance from either end of the file to the nearer end's mean edge time.
    ends: the edges ({"t", "half"}) read at each end."""
    h = 0.5 / fps
    fi = 1 / fps
    ends = [sorted(es, key=lambda e: e["t"]) for es in ends if len(es)]
    if not ends:
        return h, float("inf")
    ts = [[e["t"] for e in es] for es in ends]
    span = min(t[-1] - t[0] for t in ts)
    base = max(float(np.mean(ts[-1]) - np.mean(ts[0])) if len(ts) > 1 else span, 1.0)
    F = h
    if fit and "rate" in fit and not vfr and abs(fps - round(fps)) >= 1e-3:
        rate, c = fit["rate"], fit["c"]
        step = fps * rate
        step = abs(step - round(step))
        for _ in range(5):
            sure = max(0.0, step - fps * 2 * F / base)
            F = h / max(1.0, sure * span)
        for es in ends:
            ph = sorted(((c + rate * round((e["t"] - c) / rate)) - (e["t"] - e["half"])) / fi % 1.0 for e in es)
            gaps = np.diff(ph + [ph[0] + 1.0])
            F = max(F, h * min(1.0, float(gaps.max()) + 1 / len(es)))
    rate_floor = 2 * F / base if len(ts) > 1 else 3 * F / max(span, 1.0)
    reach = max(float(np.mean(ts[0])), D - float(np.mean(ts[-1])), 0.0)
    return F + rate_floor * reach, rate_floor


def vis_worst(fit, D, fps, ends, vfr=False):
    w = max(fit["pred_se"]((0 - fit["c"]) / fit["rate"]), fit["pred_se"]((D - fit["c"]) / fit["rate"]))
    return max(w, vis_floor(fps, fit, ends, D, vfr)[0]) * 1000


def visual_scan(path, info, args, det):
    """Read the visual code from both ends inward, the same way as the audio.
    Returns {"ends", "fit", ...}; "fit" is None when no edge was found anywhere."""
    D = info["duration"]
    info["hwaccel"] = not args.no_hwaccel
    fps = exact_fps(args.fps or info["fps"]) or 30.0
    fi = 1 / fps
    vis = {"fi": fi}
    limit = args.search * 60
    head = VEnd(path, info, 0.0, +1, limit, args.max_read, fi)
    tail = VEnd(path, info, D, -1, limit, args.max_read, fi)
    if args.only == "head":
        tail.done = True
    if args.only == "tail":
        head.done = True
    while not ((head.started or head.done) and (tail.started or tail.done)):
        if not (head.started or head.done):
            head.step(det)
        if not (tail.started or tail.done):
            tail.step(det)
        if head.pos >= tail.pos:
            head.done = head.done or not head.started
            tail.done = tail.done or not tail.started
            break
    ends = (head, tail)
    if not head.edges and not tail.edges:
        return {"ends": ends, "fit": None, "decoders": info.get("decoders", set())}
    single_from = None
    if head.edges and tail.edges and min(e["t"] for e in tail.edges) - max(e["t"] for e in head.edges) < 60:
        head.frames.update(tail.frames)
        head.edges = frame_edges(head.frames, fi)
        tail.edges, tail.done = [], True
        single_from = "結尾" if head.edges[0]["t"] > D / 2 else None

    # Refine until the target is met, the error stops dropping for VIS_PLATEAU seconds, or the code ends.
    best, flat = float("inf"), 0.0
    while True:
        fit = solve(head.edges, tail.edges, [], vis)
        if "error" in fit:
            break
        worst = vis_worst(fit, D, fps, [x.edges for x in ends], info.get("vfr"))
        if worst <= args.target:
            break
        read = 0.0
        if worst < best - 1e-9:
            best, flat = worst, 0.0
        if flat >= VIS_PLATEAU:
            break
        for e in ends:
            if e.edges and not e.done:
                read = max(read, e.step(det))
        if not read:
            break
        flat += read

    probes = []
    if "error" not in fit and args.probe:
        lo = max((e["t"] for e in head.edges), default=0.0) + 30
        hi = min((e["t"] for e in tail.edges), default=D) - 30
        for k in range(args.probe):
            if hi - lo < 60:
                break
            p0 = lo + (hi - lo) * (k + 1) / (args.probe + 1)
            pe = VEnd(path, info, p0, +1, 6.0, 6.0, fi)
            for _ in range(3):
                pe.step(det)
            head.decoded += pe.decoded
            head.bytes += pe.bytes
            if pe.edges:
                probes.append(pe.edges)
        if probes:
            fit = solve(head.edges, tail.edges, probes, vis)
    return {"ends": ends, "fit": fit, "probes": probes, "single_from": single_from, "fps": fps, "vis": vis,
            "decoders": info.get("decoders", set()), "hw_fallback": info.get("hw_fallback")}


# ---------------------------------------------------------------- analysis
def fmt_clock(sec, mod):
    sec %= mod
    h, m, s = int(sec // 3600), int(sec % 3600 // 60), sec % 60
    if mod == 60:
        return f"??:??:{s:06.3f}"
    if mod == 3600:
        return f"??:{m:02d}:{s:06.3f}"
    if mod == VIS_MOD:
        return f"??:??:{s:06.3f}（9 分鐘週期第 {m} 分）"
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


def solve(head, tail, probes, vis=None):
    """Fit file_t = c + rate * R over every labelled second. R is real seconds since the first head second
    (or the first second read, in single-end mode). Returns a dict, or {"error": ...}.
    vis: {"fi": frame interval} when the seconds are visual-code edges (labels mod 540, frame-level timing);
    None for the waveform code."""
    if vis is None:
        lab_fn, step, tol, max_rms = label, 60, 0.002, 0.005
    else:
        fi = vis["fi"]
        lab_fn, step, tol, max_rms = (lambda s: label_visual(s, fi)), VIS_MOD, 2 * fi, fi
    lab_h = lab_fn(head) if head else None
    lab_t = lab_fn(tail) if tail else None
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
        rd = (r_t - r_h) % step
        real_diff = rd + step * round((pred - rd) / step)
        if real_diff <= 0:
            return {"error": "頭尾讀到的時間不合理"}
        ambiguous = (0.003 / span if span else 0.01) * pred > step / 4 or abs(pred - real_diff) > step / 4
        if mod_h == 3600 and mod_t == 3600 and (r_t - r_h - real_diff) % 3600 != 0:
            mod_h = mod_t = 60
        if mod_h == 3600:
            base, mod = r_h % 3600, 3600
        elif mod_t == 3600:
            base, mod = (r_t - real_diff) % 3600, 3600
        else:
            base, mod = r_h % step, step
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
        new = np.abs(T - (c + rate * R)) < tol
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
        new = np.abs(T - (c + rate * R)) < tol
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
        lab = lab_fn(secs)
        if not lab:
            continue
        (lp, _m) = lab
        tp0, rp0 = lp[0]
        r_pred = (tp0 - c) / rate                       # real seconds since R = 0, from the fit so far
        rd = (rp0 - base) % step
        R0 = rd + step * round((r_pred - rd) / step)
        add = [(refine(t, rate) if used_pulses else t, R0 + float(round(t - tp0))) for t, _ in lp]
        pts += add
        probe_clusters.append(("中段", [t for t, _ in add]))
    if probe_clusters:
        T = np.array([p[0] for p in pts])
        R = np.array([p[1] for p in pts], dtype=float)
        rate, c = np.polyfit(R, T, 1)
        keep = np.abs(T - (c + rate * R)) < max(0.05, tol)   # probes may sit off a straight line; only drop gross misreads
        rate, c = np.polyfit(R[keep], T[keep], 1)

    res = (T - (c + rate * R))[keep]
    n = int(keep.sum())
    rms = float(np.sqrt((res ** 2).mean()))
    if abs(rate - 1) > 0.01 or (not probe_clusters and rms > max_rms):
        return {"error": f"讀取結果不合理（速率偏差 {(rate - 1) * 100:+.3f}%，擬合殘差 {rms * 1000:.1f} ms），"
                         f"可能有秒數讀錯，請檢查訊號品質"}
    Rk = R[keep]
    sxx = float(((Rk - Rk.mean()) ** 2).sum())
    sigma = max(float(res.std(ddof=2)) if n > 2 else 0.0003, 1e-5)
    if vis is not None:
        # Each visual edge is only known to within ±half its gap: a uniform spread, sd = width / sqrt(12).
        # Take the larger of that and the scatter actually seen.
        half = {round(d["t"], 6): d["half"] for d in list(head) + list(tail) + [d for p in probes for d in p]}
        width = np.array([2 * half.get(round(float(t), 6), fi / 2) for t in T[keep]])
        sigma = max(float(res.std(ddof=2)) if n > 2 else 0.0, float(np.sqrt((width ** 2 / 12).mean())))
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
        if max_dev > (2.0 if vis is None else max(2.0, 1000 * vis["fi"])):
            segs = []
            for (n1, t1, r1), (n2, t2, r2) in zip(centers, centers[1:]):
                segs.append({"from": t1, "to": t2, "rate": (t2 - t1) / (r2 - r1)})
    return {"rate": float(rate), "c": float(c), "base": base, "mod": mod, "ambiguous": bool(ambiguous),
            "n": n, "rejected": len(pts) - n, "rms": rms, "unc_ppm": unc_ppm, "pred_se": pred_se,
            "segs": segs, "max_dev_ms": max_dev, "both": bool(lab_h and lab_t), "used_pulses": bool(used_pulses),
            "which": "頭尾" if (lab_h and lab_t) else ("開頭" if lab_h else "結尾")}


def analyze(path, args):
    info = probe(path)
    has_video = info["v_off"] is not None
    if not info["has_audio"]:
        if not has_video:
            raise RuntimeError("檔案沒有音訊軌")
        det = detector()
        if det is None:
            raise RuntimeError(f"檔案沒有音訊軌；只有畫面時需要 pupil-apriltags 才能讀畫面碼（{visual_hint()}）")
        return analyze_video(path, info, args, det)
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
        det = detector() if has_video else None
        if det is not None:                              # a camera that only saw the slate's screen
            return analyze_video(path, info, args, det)
        if has_video:
            return {"file": path, "error": "整個檔案都讀不到波形碼"
                                          f"（若攝影機只拍到畫面碼，需要 pupil-apriltags：{visual_hint()}）"}
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

    used = [e.used for e in (head, tail) if e.found]
    r = result(path, info, args, fit, probes, single_from, [used[0], used[-1]])
    if args.av:
        av_check(r, path, info, args)
    return r


def result(path, info, args, fit, probes, single_from, channel):
    """Turn a fit into the per-file result (same fields for the waveform code and the visual code)."""
    D = info["duration"]
    rate, c, base, mod = fit["rate"], fit["c"], fit["base"], fit["mod"]

    def real_at(t):
        return (base + (t - c) / rate) % mod

    v = info["v_off"] is not None
    fps = exact_fps(args.fps or info["fps"])
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
    return {"file": path, "kind": kind, "mode": mode, "channel": channel,
            "start_label": start_mod, "mod": mod, "start_clock": start_clock, "clock_mod": clock_mod,
            "hint_src": hint_src, "length": m_len, "corrected_length": corrected,
            "frames": info["v_frames"] if v else None, "fps": fps,
            "rate": rate, "ppm": (rate - 1) * 1e6, "unc_ppm": fit["unc_ppm"], "worst_ms": worst_ms,
            "edges_used": fit["n"], "edges_rejected": fit["rejected"], "fit_rms_ms": fit["rms"] * 1000,
            "segments": seg_out, "mid_dev_ms": fit["max_dev_ms"],
            "a_off": info["a_off"], "v_off": info["v_off"], "ambiguous": fit["ambiguous"]}


def read_stats(r, sc):
    ends = sc["ends"]
    r["visual_read_s"] = sum(e.decoded for e in ends)
    r["visual_read_mb"] = sum(e.bytes for e in ends) / 1e6
    r["video_decoder"] = "+".join(sorted(sc["decoders"])) or None
    if sc.get("hw_fallback"):
        r["hw_fallback"] = sc["hw_fallback"]


def visual_groups(sc):
    """Consistent visual edges per end: [(name, [(file_t, ID)], {file_t: half width})]."""
    out = []
    for name, e in zip(("head", "tail"), sc["ends"]):
        lab = label_visual(e.edges, sc["vis"]["fi"]) if e.edges else None
        if lab:
            if name == "head" and sc.get("single_from") == "結尾":
                name = "tail"                                 # only the tail was recorded (merged into head)
            out.append((name, lab[0], {round(x["t"], 6): x["half"] for x in e.edges}))
    return out


def analyze_video(path, info, args, det):
    """Time result from the visual code alone (no waveform code in the audio, or no audio track)."""
    sc = visual_scan(path, info, args, det)
    fit = sc["fit"]
    if fit is None:
        return {"file": path, "error": "整個檔案都讀不到波形碼，也讀不到畫面碼"}
    if "error" in fit:
        return {"file": path, **fit}
    r = result(path, info, args, fit, sc["probes"], sc["single_from"], [None, None])
    floor, rate_floor = vis_floor(sc["fps"], fit, [x.edges for x in sc["ends"]], info["duration"], info.get("vfr"))
    if floor:
        if not r["segments"]:
            r["worst_ms"] = max(r["worst_ms"], floor * 1000)
        r["unc_ppm"] = max(r["unc_ppm"], rate_floor * 1e6)
    r["source"] = "video"
    r["vis_floor_ms"] = floor * 1000
    r["visual_edges"] = sum(len(g[1]) for g in visual_groups(sc))
    read_stats(r, sc)
    r["_label540"] = r["start_label"]
    if args.av:
        r["av_error"] = "沒有聲音的波形碼可配對"
    return r


def av_check(r, path, info, args):
    """Audio/video sync check (docs/visual-code.md): pair audio and visual edges of the same second
    (less than 0.5 s apart). offset = visual edge - (audio edge - distance / 343 m/s)."""
    if info["v_off"] is None:
        r["av_error"] = "檔案沒有畫面軌"
        return
    det = detector()
    if det is None:
        r["av_error"] = f"需要 pupil-apriltags 才能讀畫面碼（{visual_hint()}）"
        return
    sc = visual_scan(path, info, args, det)
    r["source"] = "audio"
    read_stats(r, sc)
    groups = visual_groups(sc)
    r["visual_edges"] = sum(len(g[1]) for g in groups)
    if not groups:
        r["av_error"] = "讀不到畫面碼"
        return
    r["source"] = "both"
    # The picture also tells where in the 9-minute cycle the file starts: widens the cross-file start window.
    t_v, idx = groups[0][1][0]
    target = (idx - (t_v - info["v_off"]) / r["rate"]) % VIS_MOD
    base = r["start_label"] % 60
    r["_label540"] = (base + 60 * round((target - base) / 60)) % VIS_MOD

    lag = args.distance / SOUND
    pairs, n_audio = {}, 0
    for name, lab, half in groups:
        ts = [t for t, _ in lab]
        a0 = max(0.0, min(ts) - 0.5)
        x, t0 = read_audio(path, a0, max(ts) + 1.0 - a0, info)
        secs = []
        if len(x):
            cands = range(x.shape[1]) if args.channel is None else [args.channel]
            secs = max((decode(x[:, ch], t0) for ch in cands), key=len)
        n_audio += len(secs)
        out = []
        for t, i in lab:
            s = next((s for s in secs if (0 if s["is_min"] else s["val"]) == i % 60 and abs(t - s["t"]) < 0.5), None)
            if s:
                out.append((t, t - (s["t"] - lag), half[round(t, 6)]))
        if out:
            pairs[name] = out
    r["audio_edges"] = n_audio
    r["av_jitter_ms"] = r["av_drift_ppm"] = r["av_drift_unc_ppm"] = None
    if not pairs:
        r["av_offset_ms"] = None
        r["av_error"] = "聲音與畫面的秒號配對不起來"
        return
    r["av_offset_ms"] = {k: ({"mean": float(np.mean([p[1] for p in pairs[k]])) * 1000,
                              "half": float(np.mean([p[2] for p in pairs[k]])) * 1000,
                              "pairs": len(pairs[k])} if k in pairs else None) for k in ("head", "tail")}
    dev = [p[1] - r["av_offset_ms"][k]["mean"] / 1000 for k in pairs for p in pairs[k]]
    if len(dev) > 1:
        r["av_jitter_ms"] = float(np.std(dev, ddof=1)) * 1000
    if len(pairs) == 2:
        allp = pairs["head"] + pairs["tail"]
        t = np.array([p[0] for p in allp])
        y = np.array([p[1] for p in allp])
        slope, icpt = np.polyfit(t, y, 1)
        res = y - (icpt + slope * t)
        width = np.array([2 * p[2] for p in allp])
        sig = max(float(res.std(ddof=2)) if len(y) > 2 else 0.0, float(np.sqrt((width ** 2 / 12).mean())))
        unc = sig / np.sqrt(((t - t.mean()) ** 2).sum())
        # Each end's mean offset can carry the same frame quantisation (see vis_floor).
        vfit = sc["fit"] if sc["fit"] and "error" not in sc["fit"] else None
        unc = max(unc, vis_floor(sc["fps"], vfit, [x.edges for x in sc["ends"]], info["duration"],
                                 info.get("vfr"))[1])
        r["av_drift_ppm"], r["av_drift_unc_ppm"] = float(slope) * 1e6, float(unc) * 1e6


def av_reference(results, name):
    """--av-ref: each file's offset minus the reference file's, end by end."""
    ref = next((r for r in results if os.path.basename(r["file"]) == os.path.basename(name)), None)
    if ref is None or not any((ref.get("av_offset_ms") or {}).values()):
        return f"找不到聲畫基準檔 {name} 的聲畫偏移"
    ro = ref["av_offset_ms"]
    for r in results:
        o = r.get("av_offset_ms")
        if not o or r is ref:
            continue
        o = {k: o.get(k) for k in ("head", "tail")}
        # Only the same end is compared (offsets may drift between head and tail).
        diff = {k: (o[k]["mean"] - ro[k]["mean"] if o[k] and ro[k] else None) for k in ("head", "tail")}
        if all(v is None for v in diff.values()):
            continue
        r["av_ref"] = os.path.basename(ref["file"])
        r["av_ref_diff_ms"] = diff
    return None


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
        if r.get("source"):
            print("  時間來源          : " + {"video": "畫面碼（video）", "audio": "波形碼（audio）",
                                              "both": "波形碼；畫面碼另作聲畫同步檢查（both）"}[r["source"]])
        print(f"  ▶ 速度比例        : {r['rate'] * 100:.6f} %（以此速度播放即對齊真實時間）")
        print(f"  ▶ 校正後長度      : {r['corrected_length']:.6f} 秒（{k}原長 {r['length']:.6f} 秒{frames}）")
        print(f"    {k}起點真實時間  : {fmt_clock(r['start_clock'], r['clock_mod'])}"
              + (f"（「時」依{r['hint_src']}推定）" if r["clock_mod"] == 86400 else ""))
        print(f"    {k}結束真實時間  : {fmt_clock(r['start_clock'] + r['corrected_length'], r['clock_mod'])}")
        if r["fps"] and k == "畫面":
            print(f"  修正後影格率      : {r['fps']:.6f} → {r['fps'] * r['rate']:.6f} fps")
        print(f"  時鐘偏差          : {r['ppm']:+.3f} ppm（量測精度約 ±{r['unc_ppm']:.3f} ppm）")
        print(f"  預估誤差          : 檔案任何位置約 ±{r['worst_ms']:.3f} ms" + ("（分段後）" if r["segments"] else "")
              + (f"（含影格量化誤差下限 {r['vis_floor_ms']:.3f} ms：相位平均不掉的部分與速度誤差的外推）"
                 if r.get("vis_floor_ms") else ""))
        if r["segments"]:
            print(f"  ⚠ 非線性漂移：中段偏離直線最多 {r['mid_dev_ms']:.1f} ms，建議分段調速（抽查越多處、分段越細越準）：")
            for sg in r["segments"]:
                print(f"      {sg['file_from']:10.3f} ～ {sg['file_to']:10.3f} 秒：播放速度 {sg['speed'] * 100:.6f} %")
        elif r["mid_dev_ms"] is not None:
            print(f"  中段實測偏差      : 最多 {r['mid_dev_ms']:.3f} ms（線性，不需分段）")
        if r["mode"].startswith("僅"):
            print("  ⚠ 只讀到單端：速率只代表那一小段時間，未涵蓋整段，機身溫度變化可能造成偏差")
        video = r.get("source") == "video"
        print(f"  擬合              : 使用 {r['edges_used']} 個{'畫面碼邊緣' if video else '秒前緣'}，"
              f"殘差 {r['fit_rms_ms']:.3f} ms"
              + (f"，排除 {r['edges_rejected']} 個異常點" if r["edges_rejected"] else ""))
        ch, ct = r["channel"]
        if not video:
            print(f"  波形碼聲道        : 第 {ch + 1} 聲道" if ch == ct else
                  f"  波形碼聲道        : 開頭第 {ch + 1} 聲道，結尾第 {ct + 1} 聲道")
        if "visual_read_s" in r:
            print(f"  畫面解碼          : 實際解碼 {r['visual_read_s']:.1f} 秒（含關鍵格起的預解），"
                  f"讀取 {r['visual_read_mb']:.1f} MB，有效畫面碼邊緣 {r['visual_edges']} 個，"
                  + ("軟體解碼" if r.get("video_decoder") == "software" else f"硬體解碼（{r.get('video_decoder')}）"))
            if r.get("hw_fallback"):
                print(f"  ⚠ 硬體解碼失敗，已改用軟體解碼：{r['hw_fallback']}")
        offs = f"音訊軌 {r['a_off']:+.6f} 秒" + (f"，畫面軌 {r['v_off']:+.6f} 秒" if r["v_off"] is not None else "")
        print(f"  軌道起點偏移      : {offs}（相對於檔案起點）")
        if r["mod"] == 60:
            print("  （未讀分鐘標記：起點時間只顯示分秒，相對位置在 ±30 秒內有效）")
        if r["mod"] == VIS_MOD:
            print("  （畫面碼：起點時間只知道 9 分鐘週期內的位置，相對位置在 ±4.5 分鐘內有效）")
        if r["ambiguous"]:
            print("  ⚠ 頭尾之間的整分鐘數無法確定，請確認結果是否合理（可加 --minute 或 --full）")
        report_av(r, args)
    if any(any((r.get("av_offset_ms") or {}).values()) for r in results):
        print("=" * 72)
        print("聲畫偏移說明：單一檔案的偏移 = 場記板本身的聲畫偏移 + 攝影機本身的聲畫偏移；同一場記板拍多台攝影機時，"
              "彼此的差值才是攝影機之間的相對偏移；絕對值需要已知同步的基準設備。量得的場記板偏移可填入場記板「設定 → 校準」。")
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
        elif al["mod"] == VIS_MOD:
            print("  （起點位置以畫面碼判定，各檔案開始時間相差須在 ±4.5 分鐘內）")
        elif al["mod"] == 180:
            print("  （起點位置以畫面碼與分鐘標記判定，各檔案開始時間相差須在 ±1.5 分鐘內）")
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


def report_av(r, args):
    """The audio/video sync check part of one file's report."""
    if r.get("av_error"):
        print(f"  ✗ 聲畫同步檢查    : {r['av_error']}")
    o = r.get("av_offset_ms")
    if not o or not any(o.values()):
        return
    part = [f"{name} {o[k]['mean']:+.3f} ms（±{o[k]['half']:.3f} ms，{o[k]['pairs']} 對）"
            for k, name in (("head", "開頭"), ("tail", "結尾")) if o[k]]
    print("  聲畫偏移          : " + "；".join(part) + "（畫面 − 聲音，正值為畫面晚）")
    if r["av_jitter_ms"] is not None:
        print(f"  逐秒偏移標準差    : {r['av_jitter_ms']:.3f} ms")
    if r["av_drift_ppm"] is not None:
        d, u = r["av_drift_ppm"], r["av_drift_unc_ppm"]
        if abs(d) > 3 * u:
            print(f"  ⚠ 聲畫漂移        : {d:+.1f} ppm，超過估計誤差（±{u:.1f} ppm）3 倍：聲音與畫面的時鐘不一致")
        else:
            print(f"  聲畫漂移          : {d:+.1f} ppm（估計誤差 ±{u:.1f} ppm）")
    print(f"  有效邊緣          : 畫面 {r['visual_edges']} 個，聲音 {r['audio_edges']} 個")
    if args.distance:
        print(f"  （已扣除聲音傳播 {args.distance / SOUND * 1000:.3f} ms：距離 {args.distance:g} m）")
    if r.get("av_ref_diff_ms"):
        dd = r["av_ref_diff_ms"]
        part = [f"{name} {dd[k]:+.3f} ms" for k, name in (("head", "開頭"), ("tail", "結尾")) if dd[k] is not None]
        print("  相對基準檔偏移差  : " + "；".join(part) + f"（基準：{r['av_ref']}）")


def start_label(r, mod):
    """r's start label usable modulo `mod`, or None. Waveform code: seconds in the minute (or hour, with a minute
    marker); visual code: seconds in the 9-minute cycle, so files with it can be matched over ±4.5 minutes."""
    if r["mod"] % mod == 0:
        return r["start_label"]
    if "_label540" in r and VIS_MOD % mod == 0:
        return r["_label540"]
    return None


def align(ok, ref_name):
    """Express every file on the reference file's own timeline (seconds from its first frame/sample).
    real(t) = start + t / rate  for a file's time t;  t_ref = (real - start_ref) * rate_ref.
    Start positions are matched modulo the longest cycle every file knows: 3600 s (minute markers),
    540 s (visual code), 180 s (both kinds mixed) or 60 s."""
    ref = next((r for r in ok if ref_name and os.path.basename(r["file"]) == os.path.basename(ref_name)), ok[0])
    mod = next(m for m in (3600, VIS_MOD, 180, 60) if all(start_label(r, m) is not None for r in ok))
    rows = []
    for r in ok:
        off_real = wrap(start_label(r, mod) - start_label(ref, mod), mod)
        rows.append({"offset": off_real * ref["rate"], "speed": r["rate"] / ref["rate"],
                     "length": r["length"] * ref["rate"] / r["rate"], "off_real": off_real})
    return {"ref": ref, "mod": mod, "rows": rows, "files": ok}


def convert(al, src, t, dst):
    """Time t (s, from src's first frame) -> the same instant on dst's own timeline."""
    real = wrap(start_label(src, al["mod"]) - start_label(dst, al["mod"]), al["mod"]) + t / src["rate"]
    return real * dst["rate"]


def main():
    # A console whose encoding lacks a character (e.g. "▶" on a Traditional Chinese Windows console, cp950)
    # would abort the report half-way; print a replacement character instead.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
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
    ap.add_argument("--av", action="store_true", help="聲畫同步檢查：另解畫面碼，與波形碼逐秒配對（需 pupil-apriltags）")
    ap.add_argument("--distance", type=float, default=0.0, help="手機到麥克風的距離（公尺），以 343 m/s 扣除聲音傳播時間")
    ap.add_argument("--av-ref", metavar="檔名", help="聲畫基準檔：其他檔案另列相對它的偏移差")
    ap.add_argument("--no-hwaccel", action="store_true",
                    help="畫面碼改用軟體解碼（預設依序試 cuda、d3d11va 硬體解碼，失敗時自動改用軟體）")
    ap.add_argument("--json", action="store_true", help="以 JSON 輸出")
    ap.add_argument("--at", action="append", metavar="檔名=秒",
                    help="把某檔案的某一刻換算到其他檔案的時間，例如 --at B002.MP4=125.5（可重複）")
    args = ap.parse_args()
    args.probe = args.probe if args.probe is not None else (3 if args.full else 0)
    if args.av and detector() is None:
        print(f"⚠ 聲畫同步檢查停用：{visual_hint()}", file=sys.stderr)
    results = []
    for f in args.files:
        try:
            results.append(analyze(f, args))
        except Exception as e:  # keep going with the other files
            results.append({"file": f, "error": str(e)})
    if args.av_ref:
        msg = av_reference([r for r in results if "error" not in r], args.av_ref)
        if msg:
            print(f"⚠ {msg}", file=sys.stderr)
    if args.json:
        ok = [r for r in results if "error" not in r]
        if len(ok) > 1:
            al = align(ok, args.ref)
            for r, a in zip(ok, al["rows"]):
                r["align_to"] = os.path.basename(al["ref"]["file"])
                r["align_offset"], r["align_speed"], r["align_length"] = a["offset"], a["speed"], a["length"]
        results = [{k: v for k, v in r.items() if not k.startswith("_")} for r in results]   # drop internal fields
        print(json.dumps(results, ensure_ascii=False, indent=2, default=float))
    else:
        report(results, args)


if __name__ == "__main__":
    sys.exit(main())
