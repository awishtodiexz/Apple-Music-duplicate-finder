import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { extensionFiles } from './validate-build.mjs';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const name = `apple-music-duplicate-finder-v${version}.zip`;
const path = 'artifacts/' + name;
const archive = await readFile(path);
const checksum = await readFile(path + '.sha256', 'utf8');
function verifyChecksum(bytes, digest) {
  assert.equal(digest, `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`, 'SHA-256 mismatch');
}
function run(script, stdio = 'inherit') {
  const result = spawnSync(process.execPath, [script], { stdio });
  if (result.error) throw result.error;
  return result;
}
assert.match(checksum, /^[a-f0-9]{64}  apple-music-duplicate-finder-v\d+\.\d+\.\d+\.zip\n$/,
  'checksum sidecar must be a single SHA-256 line naming the archive');
verifyChecksum(archive, checksum);
const entries = unzipSync(archive);
assert.deepEqual(Object.keys(entries).sort(), [...extensionFiles, 'LICENSE', 'INSTALL.txt'].sort());
for (const entry of Object.keys(entries)) {
  // A release archive must contain only relative, forward-slash file names.
  assert.ok(!entry.startsWith('/') && !entry.includes('\\') && !entry.split('/').includes('..'),
    `unsafe ZIP entry: ${entry}`);
}
for (const [entry, bytes] of Object.entries(entries)) {
  const original = await readFile(extensionFiles.includes(entry) ? 'dist/' + entry : entry);
  assert.deepEqual(Buffer.from(bytes), original, entry + ' differs from tested source/build');
}
const tampered = Buffer.from(archive);
tampered[0] ^= 1;
assert.throws(() => verifyChecksum(tampered, checksum), /SHA-256 mismatch/);
assert.throws(() => verifyChecksum(archive, checksum.replace(/^[a-f0-9]/, 'X')), /SHA-256 mismatch/);

// Repackaging the same build must be byte-for-byte deterministic.
const result = run('scripts/package.mjs');
assert.equal(result.status, 0);
assert.deepEqual(await readFile(path), archive, 'Packaging the same build must be byte-for-byte deterministic');
assert.equal(await readFile(path + '.sha256', 'utf8'), checksum);

// A clean rebuild must produce the same archive too. This covers build output
// determinism, not just the ZIP writer, without relying on wall-clock timing.
assert.equal(run('scripts/build.mjs').status, 0);
assert.equal(run('scripts/package.mjs').status, 0);
assert.deepEqual(await readFile(path), archive, 'A clean rebuild must produce a byte-identical archive');
assert.equal(await readFile(path + '.sha256', 'utf8'), checksum);

// Packaging must refuse an unexpected build file instead of silently shipping it.
await writeFile('dist/unexpected.txt', 'not part of the extension\n');
try {
  const rejected = run('scripts/package.mjs', 'pipe');
  assert.notEqual(rejected.status, 0, 'packaging must reject an unexpected dist/ file');
  assert.match(`${rejected.stdout}${rejected.stderr}`, /Unexpected extension files/);
} finally {
  await rm('dist/unexpected.txt', { force: true });
}

console.log('PASS: exact ZIP allowlist, safe entry names, content equality, clean-build reproducibility, ' +
  'deterministic packaging, SHA-256 verification, tamper detection and unexpected-file rejection');
