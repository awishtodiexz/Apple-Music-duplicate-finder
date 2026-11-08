import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const read = async path => readFile(path, 'utf8');
const pkg = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
const manifest = JSON.parse(await read('public/manifest.json'));
const version = pkg.version;

assert.equal(manifest.version, version, 'public/manifest.json version must match package.json');
assert.equal(lock.version, version, 'package-lock.json version must match package.json');
assert.equal(lock.packages[''].version, version, 'package-lock.json package entry version must match package.json');

const readme = await read('README.md');
assert.ok(readme.includes(`Download v${version}`), 'README must advertise the current download');
const downloadLinks = readme.split(`/releases/download/v${version}/`).length - 1;
assert.ok(downloadLinks >= 2, 'README download links must point at the current release');
assert.doesNotMatch(readme, /five-minute/i, 'README still contains the old five-minute deadline');
assert.match(readme, /ten-minute/i, 'README must state the ten-minute deadline');

for (const [path, needle] of [
  ['INSTALL.txt', `v${version}`],
  ['docs/RELEASING.md', `For v${version}`],
  ['.github/SECURITY.md', `currently ${version}`],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', `placeholder: ${version}`],
  ['CHANGELOG.md', `## [${version}]`],
]) {
  assert.match(await read(path), new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `${path} must reference version ${version}`);
}

const development = await read('docs/DEVELOPMENT.md');
assert.match(development, /fail at high severity and above/i, 'development docs must match npm audit --audit-level=high');
assert.doesNotMatch(development, /fail on any reported vulnerability/i, 'development docs still claim the old audit threshold');

await access(`docs/releases/v${version}.md`);
console.log(`PASS: docs, manifest, lockfile and release references agree on v${version}`);
