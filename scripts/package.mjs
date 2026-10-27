import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { extensionFiles, validateBuild } from './validate-build.mjs';

const files = {};
await validateBuild();
const { version } = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
if (version !== packageInfo.version) throw new Error('Manifest and package versions must match');
for (const name of extensionFiles) {
  files[name] = [new Uint8Array(await readFile('dist/' + name)), { mtime: new Date(2000, 0, 1) }];
}
files['LICENSE'] = [new Uint8Array(await readFile('LICENSE')), { mtime: new Date(2000, 0, 1) }];
files['INSTALL.txt'] = [new Uint8Array(await readFile('INSTALL.txt')), { mtime: new Date(2000, 0, 1) }];
await mkdir('artifacts', { recursive: true });
const destination = `artifacts/apple-music-duplicate-finder-v${version}.zip`;
const archive = zipSync(files);
await writeFile(destination, archive);
await writeFile(destination + '.sha256', `${createHash('sha256').update(archive).digest('hex')}  apple-music-duplicate-finder-v${version}.zip\n`);
console.log('Created ' + destination);
