import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { validateBuild } from './validate-build.mjs';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });

// The manifest version is derived from package.json so a release only has one
// place to bump; validate-build still asserts the packaged values agree.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version.replace(/\.0$/, '');
const manifestPath = 'dist/manifest.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.version !== version) {
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await build({
  entryPoints: ['src/popup.ts'],
  outfile: 'dist/popup.js',
  bundle: true,
  format: 'esm',
  target: 'chrome111',
  // Keep the injected function self-contained; no runtime helpers or remote code.
  // Minified so the payload re-injected for every page stays small.
  minify: true,
  legalComments: 'none',
});
// Validate the built extension here too, so `npm run build` fails on an
// unexpected file, manifest drift, or a broken CSP before packaging or tests.
await validateBuild();
console.log('Built unpacked extension in dist/');
