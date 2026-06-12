import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const result = await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/storefront.ts')],
  bundle: true,
  format: 'iife',
  globalName: '_CartcrftSDK', // won't be accessed; exports via window.* assignments inside
  outfile: path.join(__dirname, 'dist/storefront.js'),
  platform: 'browser',
  target: ['es2020', 'chrome80', 'firefox78', 'safari13'],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  metafile: true,
  banner: {
    js: '/* Cartcrft Storefront SDK — https://cartcrft.dev */',
  },
});

const outSize = Object.values(result.metafile.outputs).reduce(
  (sum, o) => sum + o.bytes,
  0
);
console.log(`Bundle size: ${(outSize / 1024).toFixed(1)} KB`);
