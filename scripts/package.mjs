import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const files = {};
const { version } = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
if (version !== packageInfo.version) throw new Error('Manifest and package versions must match');
for (const name of (await readdir('dist')).sort()) {
  files[name] = new Uint8Array(await readFile('dist/' + name));
}
files['LICENSE'] = new Uint8Array(await readFile('LICENSE'));
files['INSTALL.txt'] = new Uint8Array(await readFile('INSTALL.txt'));
await mkdir('artifacts', { recursive: true });
const destination = `artifacts/apple-music-duplicate-finder-v${version}.zip`;
await writeFile(destination, zipSync(files));
console.log('Created ' + destination);
