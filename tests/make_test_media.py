#!/usr/bin/env python3
"""
make_test_media.py — 產生已知漂移量與起點的波形碼測試檔，用來驗證分析器。

輸出立體聲：左聲道為模擬現場收音，右聲道為波形碼（格式見 docs/waveform-code.md）。
檔案時間 = (真實時間 − 起點) × 速率，速率 = 1 + ppm × 10⁻⁶。

加 --visual 時改為模擬攝影機拍攝場記板螢幕：畫面上是畫面碼（AprilTag，格式見 docs/visual-code.md），
聲音軌照舊是波形碼。攝影機時鐘（--ppm）同時影響畫面與聲音軌；--av-offset 讓畫面相對聲音晚（正值）或早。
每格的曝光區間以該格的時間為中心、長 --shutter 格，跨過整秒時新舊 tag 依時間比例混合。

用法：
  python make_test_media.py out.wav --minutes 4 --ppm 833 --start 12:34:56.789
  python make_test_media.py out.wav --plug 70                # 只有頭尾各 70 秒有波形碼
  python make_test_media.py out.mp4 --minutes 4 --ppm -694   # 另以 ffmpeg 加上 59.94 fps 測試畫面
  python make_test_media.py warm.wav --minutes 20 --ppm 800 --ppm-end 900   # 速率隨時間線性改變（模擬機身變熱）
  python make_test_media.py cam.mp4 --visual --fps 29.97 --av-offset 12   # 畫面碼影片，畫面比聲音晚 12 ms
  python make_test_media.py cam.mp4 --visual --audio none --size 3840x2160 --codec h265 --plug 75
需求：numpy；輸出 .mp4／.mov／.m4a 時另需 ffmpeg；--visual 另需 pillow
"""
import argparse
import math
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 48000

# tag36h11 碼表與位元位置，取自 AprilRobotics/apriltag 的 tag36h11.c
# （commit b7c0ebe9aa20f82ec7a828579004f9e706bfecd9，BSD-2-Clause，版權聲明見 THIRD_PARTY_NOTICES.md）。
# 場記板與分析器內嵌同一份；tests/check_visual_code.py 比對三處是否一致。
TAG36H11_CODES = [
    0xd7e00984b, 0xdda664ca7, 0xdc4a1c821, 0xe17b470e9, 0xef91d01b1, 0xf429cdd73, 0x05da29225,
    0x1106cba43, 0x223bed79d, 0x21f51213c, 0x33eb19ca6, 0x3f76eb0f8, 0x469a97414, 0x45dcfe0b0,
    0x4a6465f72, 0x51801db96, 0x5eb946b4e, 0x68a7cc2ec, 0x6f0ba2652, 0x78765559d, 0x87b83d129,
    0x86cc4a5c5, 0x8b64df90f, 0x9c577b611, 0xa3810f2f5, 0xaf4d75b83, 0xb59a03fef, 0xbb1096f85,
    0xd1b92fc76, 0xd0dd509d2, 0xe2cfda160, 0x2ff497c63, 0x47240671b, 0x5047a2e55, 0x635ca87c7,
    0x691254166, 0x68f43d94a, 0x6ef24bdb6, 0x8cdd8f886, 0x9de96b718, 0xaff6e5a8a, 0xbae46f029,
    0xd225b6d59, 0xdf8ba8c01, 0xe3744a22f, 0xfbb59375d, 0x18a916828, 0x22f29c1ba, 0x286887d58,
    0x41392322e, 0x75d18ecd1, 0x87c302743, 0x8c6317ba9, 0x9e40f36d7, 0xc0e5a806a, 0xcc78cb87c,
    0x12d2f2d01, 0x379f36a21, 0x6973f59ac, 0x7789ea9f4, 0x8f1c73e84, 0x8dd287a20, 0x94a4eee4c,
    0xa455379b5, 0xa9e92987d, 0xbd25cb40b, 0xbe98d3582, 0xd3d5972b2, 0x14c53d7c7, 0x4f1796936,
    0x4e71fed1a, 0x66d46fae0, 0xa55abb933, 0xebee1acca, 0x1ad4ba6a4, 0x305b17571, 0x553611351,
    0x59ca62775, 0x7819cb6a1, 0xedb7bc9eb, 0x5b2694212, 0x72e12d185, 0xed6152e2c, 0x5bcdadbf3,
    0x78e0aa0c6, 0xc60a0b909, 0xef9a34b0d, 0x398a6621a, 0xa8a27c944, 0x4b564304e, 0x52902b4e2,
    0x857280b56, 0xa91b2c84b, 0xe91df939b, 0x1fa405f28, 0x23793ab86, 0x68c17729f, 0x9fbf3b840,
    0x36922413c, 0x4eb5f946e, 0x533fe2404, 0x63de7d35e, 0x925eddc72, 0x99b8b3896, 0xaace4c708,
    0xc22994af0, 0x8f1eae41b, 0xd95fb486c, 0x13fb77857, 0x4fe0983a3, 0xd559bf8a9, 0xe1855d78d,
    0xfec8daaad, 0x71ecb6d95, 0xdc9e50e4c, 0xca3a4c259, 0x740d12bbf, 0xaeedd18e0, 0xb509b9c8e,
    0x5232fea1c, 0x19282d18b, 0x76c22d67b, 0x936beb34b, 0x08a5ea8dd, 0x679eadc28, 0xa08e119c5,
    0x20a6e3e24, 0x7eab9c239, 0x96632c32e, 0x470d06e44, 0x8a70212fb, 0x0a7e4251b, 0x9ec762cc0,
    0xd8a3a1f48, 0xdb680f346, 0x4a1e93a9d, 0x638ddc04f, 0x4c2fcc993, 0x01ef28c95, 0xbf0d9792d,
    0x6d27557c3, 0x623f977f4, 0x35b43be57, 0xbb0c428d5, 0xa6f01474d, 0x5a70c9749, 0x20ddabc3b,
    0x2eabd78cf, 0x90aa18f88, 0xa9ea89350, 0x3cdb39b22, 0x839a08f34, 0x169bb814e, 0x1a575ab08,
    0xa04d3d5a2, 0xbf7902f2b, 0x095a5e65c, 0x92e8fce94, 0x67ef48d12, 0x6400dbcac, 0xb12d8fb9f,
    0x0347f45d3, 0xb35826f56, 0xc546ac6e4, 0x81cc35b66, 0x41d14bd57, 0x0c052b168, 0x7d6ce5018,
    0xab4ed5ede, 0x5af817119, 0xd1454b182, 0x2badb090b, 0x03fcb4c0c, 0x2f1c28fd8, 0x93608c6f7,
    0x4c93ba2b5, 0x07d950a5d, 0xe54b3d3fc, 0x15560cf9d, 0x189e4958a, 0x62140e9d2, 0x723bc1cdb,
    0x2063f26fa, 0xfa08ab19f, 0x7955641db, 0x646b01daa, 0x71cd427cc, 0x09a42f7d4, 0x717edc643,
    0x15eb94367, 0x8392e6bb2, 0x832408542, 0x2b9b874be, 0xb21f4730d, 0xb5d8f24c9, 0x7dbaf6931,
    0x1b4e33629, 0x13452e710, 0xe974af612, 0x1df61d29a, 0x99f2532ad, 0xe50ec71b4, 0x5df0a36e8,
    0x4934e4cea, 0xe34a0b4bd, 0xb7b26b588, 0x0f255118d, 0xd0c8fa31e, 0x06a50c94f, 0xf28aa9f06,
    0x131d194d8, 0x622e3da79, 0xac7478303, 0xc8f2521d7, 0x6c9c881f5, 0x49e38b60a, 0x513d8df65,
    0xd7c2b0785, 0x9f6f9d75a, 0x9f6966020, 0x1e1a54e33, 0xc04d63419, 0x946e04cd7, 0x1bdac5902,
    0x56469b830, 0xffad59569, 0x86970e7d8, 0x8a4b41e12, 0xad4688e3b, 0x85f8f5df4, 0xd833a0893,
    0x2a36fdd7c, 0xd6a857cf2, 0x8829bc35c, 0x5e50d79bc, 0xfbb8035e4, 0xc1a95bebf, 0x036b0baf8,
    0xe0da964ea, 0xb6483689b, 0x7c8e2f4c1, 0x5b856a23b, 0x2fc183995, 0xe914b6d70, 0xb31041969,
    0x1bb478493, 0x063e2b456, 0xf2a082b9c, 0x8e5e646ea, 0x08172f8f6, 0x0dacd923e, 0xe5dcf0e2e,
    0xbf9446bae, 0x4822d50d1, 0x26e710bf5, 0xb90ba2a24, 0xf3b25aa73, 0x809ad589b, 0x94cc1e254,
    0x5334a3adb, 0x592886b2f, 0xbf64704aa, 0x566dbf24c, 0x72203e692, 0x64e61e809, 0xd7259aad6,
    0x7b924aedc, 0x2df2184e8, 0x353d1eca7, 0xfce30d7ce, 0xf7b0f436e, 0x57e8d8f68, 0x8c79e60db,
    0x9c8362b2b, 0x63a5804f2, 0x9298353dc, 0x6f98a71c8, 0xa5731f693, 0x21ca5c870, 0x1c2107fd3,
    0x6181f6c39, 0x19e574304, 0x329937606, 0x043d5c70d, 0x9b18ff162, 0x8e2ccfebf, 0x72b7b9b54,
    0x9b71f4f3c, 0x935d7393e, 0x65938881a, 0x6a5bd6f2d, 0xa19783306, 0xe6472f4d7, 0x81163df5a,
    0xa838e1cbd, 0x982748477, 0x050c54feb, 0x0d82fbb58, 0x2c4c72799, 0x97d259ad6, 0x22d9a43ed,
    0xfdb162a9f, 0x0cb4a727d, 0x4fae2e371, 0x535b5be8b, 0x48795908a, 0xce7c18962, 0x4ea154d80,
    0x50c064889, 0x8d97fc75d, 0xc8bd9ec61, 0x83ee8e8bb, 0xc8431419a, 0x1aa78079d, 0x8111aa4a5,
    0xdfa3a69fe, 0x51630d83f, 0x2d930fb3f, 0x2133116e5, 0xae5395522, 0xbc07a4e8a, 0x57bf08ba0,
    0x6cb18036a, 0xf0e2e4b75, 0x3eb692b6f, 0xd8178a3fa, 0x238cce6a6, 0xe97d5cdd7, 0xfe10d8d5e,
    0xb39584a1d, 0xca03536fd, 0xaa61f3998, 0x72ff23ec2, 0x15aa7d770, 0x57a3a1282, 0xd1f3902dc,
    0x6554c9388, 0xfd01283c7, 0xe8baa42c5, 0x72cee6adf, 0xf6614b3fa, 0x95c3778a2, 0x7da4cea7a,
    0xd18a5912c, 0xd116426e5, 0x27c17bc1c, 0xb95b53bc1, 0xc8f937a05, 0xed220c9bd, 0x0c97d72ab,
    0x8fb1217ae, 0x25ca8a5a1, 0xb261b871b, 0x1bef0a056, 0x806a51179, 0xeed249145, 0x3f82aeceb,
    0xcc56e9acf, 0x2e78d01eb, 0x102cee17f, 0x37caad3d5, 0x16ac5b1ee, 0x2af164ece, 0xd4cd81dc9,
    0x12263a7e7, 0x57ac7d117, 0x9391d9740, 0x7aedaa77f, 0x9675a3c72, 0x277f25191, 0xebb6e64b9,
    0x7ad3ef747, 0x12759b181, 0x948257d4d, 0xb63a850f6, 0x3a52a8f75, 0x4a019532c, 0xa021a7529,
    0xcc661876d, 0x4085afd05, 0xe7048e089, 0x3f979cdc6, 0xd9da9071b, 0xed2fc5b68, 0x79d64c3a1,
    0xfd44e2361, 0x8eea46a74, 0x42233b9c2, 0xae4d1765d, 0x7303a094c, 0x2d7033abe, 0x3dcc2b0b4,
    0x0f0967d09, 0x06f0cd7de, 0x09807aca0, 0x3a295cad3, 0x2b106b202, 0x3f38a828e, 0x78af46596,
    0xbda2dc713, 0x9a8c8c9d9, 0x6a0f2ddce, 0xa76af6fe2, 0x086f66fa4, 0xd52d63f8d, 0x89f7a6e73,
    0xcc6b23362, 0xb4ebf3c39, 0x564f300fa, 0xe8de3a706, 0x79a033b61, 0x765e160c5, 0xa266a4f85,
    0xa68c38c24, 0xdca0711fb, 0x85fba85ba, 0x37a207b46, 0x158fcc4d0, 0x0569d79b3, 0x7b1a25555,
    0xa8ae22468, 0x7c592bdfd, 0x0c59a5f66, 0xb1115daa3, 0xf17c87177, 0x6769d766b, 0x2b637356d,
    0x13d8685ac, 0xf24cb6ec0, 0x0bd0b56d1, 0x42ff0e26d, 0xb41609267, 0x96f9518af, 0xc56f96636,
    0x4a8e10349, 0x863512171, 0xea455d86c, 0xbd0e25279, 0xe65e3f761, 0x36c84a922, 0x85fd1b38f,
    0x657c91539, 0x15033fe04, 0x09051c921, 0xab27d80d8, 0xf92f7d0a1, 0x8eb6bb737, 0x10b5b0f63,
    0x6c9c7ad63, 0xf66fe70ae, 0xca579bd92, 0x956198e4d, 0x29e4405e5, 0xe44eb885c, 0x41612456c,
    0xea45e0abf, 0xd326529bd, 0x7b2c33cef, 0x80bc9b558, 0x7169b9740, 0xc37f99209, 0x31ff6dab9,
    0xc795190ed, 0xa7636e95f, 0x9df075841, 0x55a083932, 0xa7cbdf630, 0x409ea4ef0, 0x92a1991b6,
    0x4b078dee9, 0xae18ce9e4, 0x5a6e1ef35, 0x1a403bd59, 0x31ea70a83, 0x2bc3c4f3a, 0x5c921b3cb,
    0x042da05c5, 0x1f667d16b, 0x416a368cf, 0xfbc0a7a3b, 0x9419f0c7c, 0x81be2fa03, 0x34e2c172f,
    0x28648d8ae, 0xc7acbb885, 0x45f31eb6a, 0xd1cfc0a7b, 0x42c4d260d, 0xcf6584097, 0x94b132b14,
    0x3c5c5df75, 0x8ae596fef, 0xaea8054eb, 0x0ae9cc573, 0x496fb731b, 0xebf105662, 0xaf9c83a37,
    0xc0d64cd6b, 0x7b608159a, 0xe74431642, 0xd6fb9d900, 0x291e99de0, 0x10500ba9a, 0x5cd05d037,
    0xa87254fb2, 0x9d7824a37, 0x8b2c7b47c, 0x30c788145, 0x2f4e5a8be, 0xbadb884da, 0x026e0d5c9,
    0x6fdbaa32e, 0x34758eb31, 0x565cd1b4f, 0x2bfd90fb0, 0x093052a6b, 0xd3c13c4b9, 0x2daea43bf,
    0xa279762bc, 0xf1bd9f22c, 0x4b7fec94f, 0x545761d5a, 0x7327df411, 0x1b52a442e, 0x49b0ce108,
    0x24c764bc8, 0x374563045, 0xa3e8f91c6, 0x0e6bd2241, 0xe0e52ee3c, 0x07e8e3caa, 0x96c2b7372,
    0x33acbdfda, 0xb15d91e54, 0x464759ac1, 0x6886a1998, 0x57f5d3958, 0x5a1f5c1f5, 0x0b58158ad,
    0xe712053fb, 0x5352ddb25, 0x414b98ea0, 0x74f89f546, 0x38a56b3c3, 0x38db0dc17, 0xaa016a755,
    0xdc72366f5, 0x0cee93d75, 0xb2fe7a56b, 0xa847ed390, 0x8713ef88c, 0xa217cc861, 0x8bca25d7b,
    0x455526818, 0xea3a7a180, 0xa9536e5e0, 0x9b64a1975, 0x5bfc756bc, 0x046aa169b, 0x53a17f76f,
    0x4d6815274, 0xcca9cf3f6, 0x4013fcb8b, 0x3d26cdfa5, 0x5786231f7, 0x7d4ab09ab, 0x960b5ffbc,
    0x8914df0d4, 0x2fc6f2213, 0xac235637e, 0x151b28ed3, 0x46f79b6db, 0x1382e0c9f, 0x53abf983a,
    0x383c47ade, 0x3fcf88978, 0xeb9079df7, 0x09af0714d, 0xda19d1bb7, 0x9a02749f8, 0x1c62dab9b,
    0x1a137e44b, 0x2867718c7, 0x35815525b, 0x7cd35c550, 0x2164f73a0, 0xe8b772fe0,
]
TAG36H11_BIT_X = [1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4, 1, 1, 1, 1, 1, 2, 2, 2, 3]
TAG36H11_BIT_Y = [1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4]
VIS_MOD = 540                  # ID = 午夜起秒數 mod 540（9 分鐘一輪，一天剛好 160 輪）
FPS = {"23.976": (24000, 1001), "24": (24, 1), "25": (25, 1), "29.97": (30000, 1001),
       "30": (30, 1), "50": (50, 1), "59.94": (60000, 1001), "60": (60, 1)}


def wave_hz(minute, sec):
    return 600 + (((minute * 60 + sec) * 7919) % 19) * 80


def second(val, is_min, hz, rate=1.0):
    """One second of waveform code (float array, 0.95 s long): one oscillator gated on and off, like the slate."""
    # A recorder whose clock runs `rate` times fast stretches the WHOLE second (pitch and pulse spacing),
    # so build it on the phone's time line and sample it at file time: phone time = file time / rate.
    n = int(SR * 0.95 * rate)
    d = np.zeros(n)
    carrier = np.sin(2 * np.pi * hz * np.arange(n) / SR / rate)   # one oscillator, phase 0 at the sync start

    def burst(t0, t1, amp):                                   # gain steps on that oscillator (as the slate does)
        a, z = int(round(t0 * rate * SR)), min(n, int(round(t1 * rate * SR)))
        d[a:z] = amp * carrier[a:z]

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


def fmt_clock(t):
    t %= 86400
    return f"{int(t // 3600):02d}:{int(t % 3600 // 60):02d}:{t % 60:06.3f}"


# ---------------------------------------------------------------- visual code (AprilTag)
def tag_id(sec_of_day):
    """畫面碼 ID：手機本地時間自午夜起的整秒數 mod 540。"""
    return int(math.floor(sec_of_day)) % 86400 % VIS_MOD


def tag_cells(idx):
    """10 × 10 格（1 = 白），與官方 apriltag_to_image() 相同：最外圈白、第二圈黑、
    資料位元 i 在第 bit_y[i] + 1 列、第 bit_x[i] + 1 行，code 的第 35 − i 位元為 1 時白色。"""
    code = TAG36H11_CODES[idx]
    g = np.zeros((10, 10), np.uint8)
    g[0, :] = g[9, :] = g[:, 0] = g[:, 9] = 1
    for i in range(36):
        if code >> (35 - i) & 1:
            g[TAG36H11_BIT_Y[i] + 1, TAG36H11_BIT_X[i] + 1] = 1
    return g


def draw_tag(idx, cell, quiet=1):
    """畫出 tag（0／255 灰階），每格 cell 個整數像素，外加 quiet 格白色靜區；不做平滑處理。"""
    g = np.pad(tag_cells(idx), quiet, constant_values=1)
    return (np.kron(g, np.ones((cell, cell), np.uint8)) * 255).astype(np.uint8)


def homography(src, dst):
    """Solve the 3 × 3 projective map taking the four src points to the four dst points."""
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b += [u, v]
    h = np.linalg.solve(np.array(A, float), np.array(b, float))
    return np.append(h, 1.0).reshape(3, 3)


class SlateCamera:
    """攝影機拍到的場記板畫面：靜態背景上一支橫拿的手機，螢幕上是外框帶（方波）、白底面板與 tag。
    每種狀態（ID、外框黑白）只算一次透視投影與模糊，之後每格只做混合、曝光與雜訊。"""

    def __init__(self, W, H, tag_size, tilt, blur, exposure, seed=2):
        from PIL import Image
        self.Image, self.W, self.H = Image, W, H
        self.blur, self.exposure = blur, exposure
        rng = np.random.default_rng(seed)
        low = rng.uniform(60, 160, (H // 40 + 2, W // 40 + 2)).astype(np.uint8)
        self.bg = Image.fromarray(low).resize((W, H), Image.BICUBIC)
        panel_px = tag_size * min(W, H)                  # tag 含靜區（12 格）在畫面上的邊長
        self.cell = cell = max(2, int(math.ceil(panel_px * 1.3 / 12)))
        # Phone texture (held sideways): bezel, then the screen with the square-wave band around the digit area.
        hs = int(round(12 * cell / 0.62))
        ws = 2 * hs
        band = max(2, int(round(0.06 * hs)))
        bez = max(2, int(round(0.04 * hs)))
        self.tex_size = (ws + 2 * bez, hs + 2 * bez)
        self.bez, self.band, self.hs, self.ws = bez, band, hs, ws
        side = 12 * cell
        self.panel_xy = (bez + (ws - side) // 2, bez + int(round(0.45 * hs - side / 2)))
        tw, th = self.tex_size
        k = panel_px / side                              # texture px -> frame px at the phone's centre
        f = float(W)                                     # pinhole focal length in px (about 53° across)
        th_r, roll = math.radians(tilt), math.radians(1.5)
        cx, cy = W / 2, H / 2
        dst = []
        for x, y in ((0, 0), (tw, 0), (tw, th), (0, th)):
            X, Y = (x - tw / 2) * k, (y - th / 2) * k
            Xr, Zr = X * math.cos(th_r), X * math.sin(th_r)   # turn the phone about its vertical axis
            u, v = f * Xr / (f + Zr), f * Y / (f + Zr)
            dst.append((cx + u * math.cos(roll) - v * math.sin(roll), cy + u * math.sin(roll) + v * math.cos(roll)))
        Hm = homography([(0, 0), (tw, 0), (tw, th), (0, th)], dst)
        inv = np.linalg.inv(Hm)
        inv /= inv[2, 2]
        self.coeffs = tuple(inv.flatten()[:8])
        self.mask = Image.new("L", self.tex_size, 255).transform((W, H), Image.PERSPECTIVE, self.coeffs, Image.BILINEAR)
        self.cache = {}
        self.rng = rng

    def texture(self, idx, white):
        tw, th = self.tex_size
        t = np.full((th, tw), 25, np.uint8)                       # phone body
        b, bd = self.bez, self.band
        t[b:b + self.hs, b:b + self.ws] = 255 if white else 0      # square-wave band
        t[b + bd:b + self.hs - bd, b + bd:b + self.ws - bd] = 0    # slate background
        px, py = self.panel_xy
        tag = draw_tag(idx, self.cell)
        t[py:py + tag.shape[0], px:px + tag.shape[1]] = tag        # white panel = tag with its quiet zone
        return self.Image.fromarray(t)

    def state_image(self, state):
        """state = (ID, 外框是否為白) 或 None（手機不在畫面中）。"""
        if state in self.cache:
            return self.cache[state]
        from PIL import ImageFilter
        img = self.bg
        if state is not None:
            warped = self.texture(*state).transform((self.W, self.H), self.Image.PERSPECTIVE, self.coeffs,
                                                    self.Image.BILINEAR)
            img = self.Image.composite(warped, self.bg, self.mask)
        if self.blur > 0:
            img = img.filter(ImageFilter.GaussianBlur(self.blur))
        # Sensor noise is baked into each state (it changes every half second), which keeps 4K rendering fast.
        arr = np.asarray(img, dtype=np.float32) + self.rng.normal(0, 2.0, (self.H, self.W)).astype(np.float32)
        arr = np.clip(arr + 0.5, 0, 255).astype(np.uint8)
        if len(self.cache) > 8:
            self.cache.pop(next(iter(self.cache)))
        self.cache[state] = arr
        return arr

    def frame(self, weights, ft):
        """weights: [(state, 曝光時間比例)]；ft：該格的檔案時間（決定自動曝光的起伏）。"""
        if len(weights) == 1:
            img = self.state_image(weights[0][0])
        else:                                            # exposure spans a change: mix the states by time
            mix = sum(w * self.state_image(s).astype(np.float32) for s, w in weights)
            img = np.clip(mix + 0.5, 0, 255).astype(np.uint8)
        if self.exposure:
            gain = 1 + self.exposure * math.sin(2 * math.pi * ft / 5.3)
            lift = 25 * self.exposure * math.sin(2 * math.pi * ft / 3.1 + 1)
            img = np.clip(np.arange(256) * gain + lift + 0.5, 0, 255).astype(np.uint8)[img]
        return img


def pick_encoder(codec, choice, W, H):
    """cpu: libx264／libx265；nvenc: NVIDIA 硬體編碼；auto: 先以一小段測試 NVENC，能用就用，否則退回 CPU。"""
    cpu, gpu = ("libx264", "h264_nvenc") if codec == "h264" else ("libx265", "hevc_nvenc")
    if choice == "cpu":
        return cpu
    test = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=gray:s={W}x{H}:r=30:d=0.2",
                           "-c:v", gpu, "-f", "null", "-"], capture_output=True)
    if test.returncode == 0:
        return gpu
    if choice == "nvenc":
        raise RuntimeError(f"{gpu} 無法使用：" + test.stderr.decode(errors="replace").strip()[-300:])
    return cpu


def make_visual(args, wav_path, dur, r0, rate, p0, real_offset, visible):
    """Render the camera's picture and mux it with the (optional) audio into args.out."""
    num, den = FPS[args.fps]
    fps = num / den
    W, H = (int(v) for v in args.size.lower().split("x"))
    nfr = int(round(dur * fps))
    off = args.av_offset / 1000.0
    shutter = args.shutter / fps
    cam = SlateCamera(W, H, args.tag_size, args.tilt, args.blur, args.exposure)
    encoder = pick_encoder(args.codec, args.encoder, W, H)
    venc = {"libx264": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"],
            "libx265": ["-c:v", "libx265", "-preset", "ultrafast", "-crf", "20", "-x265-params", "log-level=error"],
            "h264_nvenc": ["-c:v", "h264_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "19", "-b:v", "0"],
            "hevc_nvenc": ["-c:v", "hevc_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "21", "-b:v", "0"]}[encoder]
    if args.codec == "h265":
        venc += ["-tag:v", "hvc1"]
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}",
           "-framerate", f"{num}/{den}", "-i", "-"]
    if wav_path:
        cmd += ["-i", wav_path, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k"]
    cmd += venc + ["-g", str(max(1, int(round(args.gop * fps)))), "-pix_fmt", "yuv420p", "-frames:v", str(nfr),
                   args.out]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def state(t):
        S = math.floor(t)
        if not visible(S):
            return None
        return (tag_id(S), (t - S) < 0.5)

    for k in range(nfr):
        ft = k / fps
        # Exposure window centred on the frame's time; the picture lags the sound by `off`.
        ra, rb = r0 + real_offset(ft - off - shutter / 2), r0 + real_offset(ft - off + shutter / 2)
        cuts = [ra] + [h / 2 for h in range(int(math.floor(ra * 2)) + 1, int(math.ceil(rb * 2)))] + [rb]
        weights = {}
        for a, b in zip(cuts, cuts[1:]):
            s = state((a + b) / 2)
            weights[s] = weights.get(s, 0.0) + (b - a) / (rb - ra)
        enc.stdin.write(cam.frame(list(weights.items()), ft).tobytes())
    enc.stdin.close()
    if enc.wait():
        raise RuntimeError("ffmpeg 編碼失敗")
    v_len = nfr / fps
    shown0 = r0 + real_offset(-off)
    real_len = real_offset(v_len - off) - real_offset(-off)
    print(f"{args.out}: {args.fps} fps {W}x{H} {encoder}（GOP {args.gop:g} 秒），{nfr} 格（畫面長 {v_len:.6f} 秒），"
          f"時鐘偏差 {p0 * 1e6:+.3f} ppm，速度比例 {rate * 100:.6f} %，真實長度 {real_len:.6f} 秒")
    print(f"    聲音軌第 0 秒＝{fmt_clock(r0)}；畫面第 0 格顯示 {fmt_clock(shown0)}"
          f"（ID {tag_id(shown0)}）；畫面相對聲音 {args.av_offset:+.3f} ms；"
          f"聲音軌：{ {'code': '波形碼', 'scene': '只有現場聲音', 'none': '無'}[args.audio] }")


def main():
    ap = argparse.ArgumentParser(description="產生已知漂移量的波形碼測試檔")
    ap.add_argument("out")
    ap.add_argument("--minutes", type=float, default=4.0, help="檔案長度（分鐘），預設 4")
    ap.add_argument("--ppm", type=float, default=833.0, help="時鐘偏差（ppm），正值代表檔案比真實時間長")
    ap.add_argument("--start", default="12:34:56.789", help="檔案第 0 秒對應的真實時間")
    ap.add_argument("--plug", type=float, default=0, help="只在頭尾各這麼多秒放波形碼（0＝全程）")
    ap.add_argument("--ppm-end", type=float, default=None, help="結尾時的時鐘偏差；與 --ppm 之間線性變化（預設同 --ppm）")
    g = ap.add_argument_group("畫面碼影片（--visual）")
    g.add_argument("--visual", action="store_true", help="畫面改為攝影機拍到的場記板畫面碼（輸出須為 .mp4／.mov）")
    g.add_argument("--fps", choices=list(FPS), default="59.94", help="影格率，預設 59.94")
    g.add_argument("--size", default="1280x720", help="解析度，預設 1280x720")
    g.add_argument("--codec", choices=["h264", "h265"], default="h264", help="視訊編碼，預設 h264")
    g.add_argument("--encoder", choices=["auto", "nvenc", "cpu"], default="auto",
                   help="視訊編碼器：auto＝先試 NVIDIA NVENC，不能用時改用 libx264／libx265（預設）；nvenc；cpu")
    g.add_argument("--gop", type=float, default=1.0, help="關鍵格間隔（秒），預設 1")
    g.add_argument("--tag-size", type=float, default=0.4, help="tag（含靜區）佔畫面短邊的比例，預設 0.4")
    g.add_argument("--blur", type=float, default=0.0, help="高斯模糊（像素），預設 0")
    g.add_argument("--exposure", type=float, default=0.0, help="亮度與自動曝光起伏幅度（0.3 = 增益 ±30%%），預設 0")
    g.add_argument("--tilt", type=float, default=0.0, help="手機繞垂直軸的傾斜角（度），預設 0")
    g.add_argument("--shutter", type=float, default=0.5, help="曝光時間（格），預設 0.5（180° 快門）")
    g.add_argument("--av-offset", type=float, default=0.0, help="畫面相對聲音的偏移（ms），正值為畫面晚")
    g.add_argument("--audio", choices=["code", "scene", "none"], default="code",
                   help="聲音軌：code＝波形碼（預設）、scene＝只有現場聲音、none＝沒有聲音軌")
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

    def real_offset(ft):                                   # inverse of file_time
        a = (p1 - p0) / (2 * real_span)
        if a == 0:
            return ft / (1 + p0)
        return (-(1 + p0) + math.sqrt((1 + p0) ** 2 + 4 * a * ft)) / (2 * a)

    def visible(R):                                        # is the slate shown / sounding during real second R
        ft = file_time(R - r0)
        return not args.plug or ft < args.plug - 1 or ft > dur - args.plug
    rng = np.random.default_rng(1)
    code = np.zeros(n)
    R = int(np.ceil(r0))
    while True:
        ft = file_time(R - r0)
        if (ft + 1) * SR >= n:
            break
        if visible(R):
            m, s = (R % 3600) // 60, R % 60
            local = 1 + p0 + (p1 - p0) * (R - r0) / real_span     # the recorder's clock ratio at this moment
            b = second(m if s == 0 else s, s == 0, wave_hz(m, s), local)
            i = int(round(ft * SR))
            code[i:i + len(b)] += b
        R += 1
    scene = rng.normal(0, 0.1, n) * np.repeat(rng.uniform(0, 1, n // 2400 + 1) ** 2, 2400)[:n]
    if args.visual and args.audio == "scene":
        code[:] = 0
    pcm = (np.stack([scene, 0.5 * code], 1).clip(-1, 1) * 32767).astype("<i2")

    ext = os.path.splitext(args.out)[1].lower()
    if args.visual and ext not in (".mp4", ".mov"):
        ap.error("--visual 的輸出須為 .mp4 或 .mov")
    tmp = None
    if ext == ".wav":
        wav_path = args.out
    else:  # mkstemp creates the file atomically (mktemp only returns a name another process could take first)
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        wav_path = tmp
    try:  # the temporary WAV is removed even when encoding fails
        if not (args.visual and args.audio == "none"):
            with wave.open(wav_path, "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(SR)
                w.writeframes(pcm.tobytes())
        if args.visual:
            make_visual(args, None if args.audio == "none" else wav_path, dur, r0, rate, p0, real_offset, visible)
            return 0
        if ext != ".wav":
            cmd = ["ffmpeg", "-v", "error", "-y"]
            if ext in (".mp4", ".mov"):
                cmd += ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60000/1001", "-i", wav_path,
                        "-map", "0:v", "-map", "1:a", "-t", f"{dur}", "-c:v", "libx264", "-preset", "ultrafast"]
            else:
                cmd += ["-i", wav_path]
            cmd += ["-c:a", "aac", "-b:a", "192k", args.out]
            subprocess.run(cmd, check=True)
    finally:
        if tmp:
            os.remove(tmp)
    if p0 == p1:
        print(f"{args.out}: 起點 {args.start}，時鐘偏差 {args.ppm:+.3f} ppm，"
              f"速度比例 {rate * 100:.6f} %，真實長度 {dur / rate:.6f} 秒")
    else:
        print(f"{args.out}: 起點 {args.start}，時鐘偏差由 {p0 * 1e6:+.1f} 變到 {p1 * 1e6:+.1f} ppm，真實長度 {real_span:.6f} 秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
