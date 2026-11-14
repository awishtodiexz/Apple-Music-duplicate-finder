// Fails if the version number is out of sync anywhere it is written down.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(path, 'utf8');
const { name, version: packageVersion } = JSON.parse(await read('package.json'));
const version = packageVersion.replace(/\.0$/, '');
const lock = JSON.parse(await read('package-lock.json'));
const manifest = JSON.parse(await read('public/manifest.json'));

assert.equal(manifest.version, version, 'public/manifest.json');
assert.equal(lock.version, packageVersion, 'package-lock.json');
assert.equal(lock.packages[''].version, packageVersion, 'package-lock.json (root package)');
assert.equal(lock.packages[''].name, name, 'package-lock.json name');

const zip = `apple-music-playlist-duplicate-finder-v${version}.zip`;
const mentions = {
  'README.md': `/releases/download/v${version}/${zip}`,
  'docs/DEVELOPMENT.md': zip,
  'assets/INSTALL.txt': `v${version}`,
  '.github/SECURITY.md': `currently ${version}`,
  '.github/ISSUE_TEMPLATE/bug_report.yml': `placeholder: ${version}`,
};
for (const [path, text] of Object.entries(mentions)) {
  assert.ok((await read(path)).includes(text), `${path} should mention "${text}"`);
}

const latest = (await read('CHANGELOG.md')).match(/^## \[(\d+\.\d+(?:\.\d+)?)\]/m)?.[1];
assert.equal(latest, version, 'CHANGELOG.md should start with the current version');

console.log(`PASS: version ${version} is consistent across files`);
