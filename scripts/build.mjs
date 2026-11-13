#!/usr/bin/env node
// build.mjs — 建置網頁到 dist/：web/ 的檔案原樣複製（首頁、場記板、PWA 檔案），分析器由 src/web/main.js 打包後
// 內嵌進 src/web/sync-analyzer.html（單一 HTML 檔，存到本機直接開也能用）。
//
// 用法：
//   node scripts/build.mjs            # 建置一次
//   node scripts/build.mjs --serve    # 開發：改 src/ 或 web/ 後自動重建，並在 http://localhost:8000/ 提供 dist/
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'web');
const ENTRY = path.join(ROOT, 'src', 'web', 'main.js');
const TEMPLATE = path.join(ROOT, 'src', 'web', 'sync-analyzer.html');
const SLOT = '<script src="main.js"></script>';

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(...(e.isDirectory() ? await filesUnder(p) : [p]));
  }
  return out;
}

// The template and web/ are not imported by the bundle, so they are added to what --serve watches.
const watchExtras = {
  name: 'watch-extras',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]web[\\/]main\.js$/ }, async args => ({
      contents: await readFile(args.path, 'utf8'), loader: 'js', watchFiles: [TEMPLATE, ...await filesUnder(WEB)],
    }));
  },
};

// After every bundle: copy web/ as is and write the analyzer page with the bundle inlined.
const writePages = {
  name: 'write-pages',
  setup(build) {
    build.onEnd(async result => {
      if (result.errors.length) return;
      const js = result.outputFiles.find(f => f.path.endsWith('.js')).text;
      if (/<\/script/i.test(js)) throw new Error('打包結果含有 </script，無法內嵌');
      const html = await readFile(TEMPLATE, 'utf8');
      if (html.split(SLOT).length !== 2) throw new Error(`${path.relative(ROOT, TEMPLATE)} 必須正好有一個 ${SLOT}`);
      await rm(DIST, { recursive: true, force: true });
      await mkdir(DIST, { recursive: true });
      await cp(WEB, DIST, { recursive: true });
      // A replacer function, so "$&" and the like in the bundle are not read as replacement patterns.
      await writeFile(path.join(DIST, 'sync-analyzer.html'), html.replace(SLOT, () => `<script>\n${js}</script>`));
      console.log(`已建置 ${path.relative(ROOT, DIST)}${path.sep}（${new Date().toLocaleTimeString()}）`);
    });
  },
};

const options = {
  entryPoints: [ENTRY],
  bundle: true,
  format: 'iife',
  // Keeps the third-party license headers (/*! ... */) where they are in the inlined script.
  legalComments: 'inline',
  charset: 'utf8',
  write: false,
  outfile: path.join(DIST, 'sync-analyzer.js'),
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
