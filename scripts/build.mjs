#!/usr/bin/env node
// build.mjs — 建置網頁到 dist/：web/ 的檔案原樣複製（首頁、PWA 檔案）；場記板與分析器各由 src/web/ 的程式打包後
// 內嵌進範本（單一 HTML 檔，存到本機直接開也能用）：slate.js → sync-slate.html、main.js → sync-analyzer.html。
//
// 用法：
//   node scripts/build.mjs            # 建置一次
//   node scripts/build.mjs --serve    # 開發：改 src/ 或 web/ 後自動重建，並在 http://localhost:8000/ 提供 dist/
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'web');
// Each page: its entry script, the template the bundle is inlined into, and the tag in the template it replaces.
const PAGES = [['slate', 'sync-slate.html'], ['main', 'sync-analyzer.html']].map(([name, html]) => ({
  name, entry: path.join(ROOT, 'src', 'web', name + '.js'), template: path.join(ROOT, 'src', 'web', html),
  out: path.join(DIST, html), slot: `<script src="${name}.js"></script>`,
}));

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(...(e.isDirectory() ? await filesUnder(p) : [p]));
  }
  return out;
}

// The templates and web/ are not imported by the bundles, so they are added to what --serve watches.
const watchExtras = {
  name: 'watch-extras',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]web[\\/](main|slate)\.js$/ }, async args => ({
      contents: await readFile(args.path, 'utf8'), loader: 'js', watchFiles: [...PAGES.map(p => p.template), ...await filesUnder(WEB)],
    }));
  },
};

// Writes a file through a temporary name, so the server never hands out half a file.
async function put(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + '.tmp', data);
  await rename(file + '.tmp', file);
}

// After every bundle: copy web/ as is and write each page with its bundle inlined. The esbuild server rebuilds
// on requests too, so dist/ is written only when the output differs from the last write: changed files are replaced
// in place and only the ones no longer in web/ are removed (dist/ is never emptied while it is being served).
let written = new Map();          // dist path -> sha256 of what was last written
const sha = data => createHash('sha256').update(data).digest('hex');
const writePages = {
  name: 'write-pages',
  setup(build) {
    build.onEnd(async result => {
      if (result.errors.length) return;
      const files = new Map();       // dist path -> contents
      for (const f of await filesUnder(WEB)) files.set(path.join(DIST, path.relative(WEB, f)), await readFile(f));
      for (const pg of PAGES) {
        const js = result.outputFiles.find(f => path.basename(f.path) === pg.name + '.js').text;
        if (/<\/script/i.test(js)) throw new Error(`${pg.name}.js 的打包結果含有 </script，無法內嵌`);
        const html = await readFile(pg.template, 'utf8');
        if (html.split(pg.slot).length !== 2) throw new Error(`${path.relative(ROOT, pg.template)} 必須正好有一個 ${pg.slot}`);
        // A replacer function, so "$&" and the like in the bundle are not read as replacement patterns.
        files.set(pg.out, Buffer.from(html.replace(pg.slot, () => `<script>\n${js}</script>`)));
      }
      const next = new Map([...files].map(([f, d]) => [f, sha(d)]));
      if (next.size === written.size && [...next].every(([f, h]) => written.get(f) === h)) return;
      if (!written.size) await rm(DIST, { recursive: true, force: true });   // the first write: clear what an earlier run left
      for (const [f, d] of files) if (written.get(f) !== next.get(f)) await put(f, d);
      for (const f of written.keys()) if (!next.has(f)) await rm(f, { force: true });
      written = next;
      console.log(`已建置 ${path.relative(ROOT, DIST)}${path.sep}（${new Date().toLocaleTimeString()}）`);
    });
  },
};

const options = {
  entryPoints: PAGES.map(p => p.entry),
  bundle: true,
  format: 'iife',
  // Keeps the third-party license headers (/*! ... */) where they are in the inlined script.
  legalComments: 'inline',
  charset: 'utf8',
  write: false,
  outdir: DIST,
  logLevel: 'warning',
  plugins: [watchExtras, writePages],
};

if (process.argv.includes('--serve')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: DIST, port: 8000, host: '127.0.0.1' });
  console.log(`開發伺服器：http://localhost:${port}/（Ctrl+C 結束）`);
} else {
  await esbuild.build(options);
}
