import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
verifyChecksum(archive, checksum);
const entries = unzipSync(archive);
assert.deepEqual(Object.keys(entries).sort(), [...extensionFiles, 'LICENSE', 'INSTALL.txt'].sort());
for (const [name, bytes] of Object.entries(entries)) {
  const original = await readFile(extensionFiles.includes(name) ? 'dist/' + name : name);
  assert.deepEqual(Buffer.from(bytes), original, name + ' differs from tested source/build');
}
const tampered = Buffer.from(archive);
tampered[0] ^= 1;
assert.throws(() => verifyChecksum(tampered, checksum), /SHA-256 mismatch/);
assert.throws(() => verifyChecksum(archive, checksum.replace(/^[a-f0-9]/, 'X')), /SHA-256 mismatch/);
const result = spawnSync(process.execPath, ['scripts/package.mjs'], { stdio: 'inherit' });
if (result.error) throw result.error;
assert.equal(result.status, 0);
assert.deepEqual(await readFile(path), archive, 'Packaging the same build must be byte-for-byte deterministic');
assert.equal(await readFile(path + '.sha256', 'utf8'), checksum);
console.log('PASS: exact ZIP allowlist, content equality, deterministic packaging, SHA-256 verification and tamper detection');
