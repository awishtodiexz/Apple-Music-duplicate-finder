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
assert.equal(lock.packages[''].name, pkg.name, 'package-lock.json package name must match package.json');

const readme = await read('README.md');
assert.ok(readme.includes(`Download v${version}`), 'README must advertise the current download');
const downloadLinks = readme.split(`/releases/download/v${version}/`).length - 1;
assert.ok(downloadLinks >= 2, 'README download links must point at the current release');
assert.ok(readme.includes(`apple-music-duplicate-finder-v${version}.zip`), 'README must name the current ZIP');
assert.ok(readme.includes('.zip.sha256'), 'README must mention the checksum sidecar');
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

// The top numeric changelog entry and the release notes must be the version
// being prepared, not a historical release that merely mentions the number.
const changelog = await read('CHANGELOG.md');
const latestChangelogVersion = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
assert.equal(latestChangelogVersion, version, 'CHANGELOG top version must be the current version');
const releaseNotes = await read(`docs/releases/v${version}.md`);
const releaseTitle = `# Apple Music Duplicate Finder v${version}`;
assert.ok(releaseNotes.split('\n').some(line => line.replace(/\r$/, '') === releaseTitle),
  'release notes title must name the current version');
assert.ok(releaseNotes.includes(`apple-music-duplicate-finder-v${version}.zip`),
  'release notes must name the current ZIP');
const releasing = await read('docs/RELEASING.md');
assert.ok(releasing.includes(`apple-music-duplicate-finder-v${version}.zip`),
  'release checklist must name the current ZIP');
assert.ok(releasing.includes(`apple-music-duplicate-finder-v${version}.zip.sha256`),
  'release checklist must name the current checksum');

const development = await read('docs/DEVELOPMENT.md');
assert.match(development, /fail at high severity and above/i, 'development docs must match npm audit --audit-level=high');
assert.doesNotMatch(development, /fail on any reported vulnerability/i, 'development docs still claim the old audit threshold');

await access(`docs/releases/v${version}.md`);
console.log(`PASS: docs, manifest, lockfile and release references agree on v${version}`);
