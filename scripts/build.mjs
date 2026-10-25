import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({
  entryPoints: ['src/popup.ts'],
  outfile: 'dist/popup.js',
  bundle: true,
  format: 'esm',
  target: 'chrome111',
  // Keep the injected function self-contained; no runtime helpers or remote code.
  minify: false,
  legalComments: 'none',
});
console.log('Built unpacked extension in dist/');
