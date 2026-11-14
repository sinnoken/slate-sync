// tools.mjs — 測試共用的小工具：外部程式（ffmpeg）、暫存資料夾、測試檔解壓。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './root.mjs';

export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

// ffmpeg 與 ffprobe 是否在 PATH 中。
export const hasFfmpeg = () => ['ffmpeg', 'ffprobe'].every(c => !spawnSync(c, ['-version'], { stdio: 'ignore' }).error);

// 執行外部程式，失敗時丟出含 stderr 結尾的錯誤；回傳 stdout（Buffer）。
export function run(cmd, args, opts = {}) {
  const p = spawnSync(cmd, args, { maxBuffer: 1 << 30, ...opts });
  if (p.error) throw new Error(`${cmd} 無法執行：${p.error.message}`);
  if (p.status) throw new Error(`${cmd} 結束碼 ${p.status}：${String(p.stderr).slice(-1500)}`);
  return p.stdout;
}

// 建立暫存資料夾；測試結束時以 t.after() 刪除。
export function tempDir(t, prefix = 'slate-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// tests/fixtures/ 的測試檔路徑；以 .gz 存放的先解壓到 dir。
export function fixture(name, dir) {
  const src = path.join(FIXTURES, name);
  if (fs.existsSync(src)) return src;
  const dst = path.join(dir, name);
  fs.writeFileSync(dst, zlib.gunzipSync(fs.readFileSync(src + '.gz')));
  return dst;
}
