import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { validateBuild } from './validate-build.mjs';

await validateBuild();
// Report paths and line numbers only; never echo matched credential values.
const files = [];
const ignored = new Set(['.git', '.cache', 'node_modules', 'dist', 'artifacts', 'coverage',
  'playwright-report', 'test-results', 'browser-profile']);
async function collect(directory = '.') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !ignored.has(entry.name)) await collect(path);
    else if (entry.isFile()) files.push(path);
    // Never follow symlinks outside the source tree. No Git checkout is required.
  }
}
await collect();
const credential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{30,255}\b|\bsk_live_[A-Za-z0-9]{20,255}\b/;
const findings = [];
for (const path of files) {
  if (!/\.(?:ts|mjs|json|md|txt|html|css|ya?ml)$|\/\.env(?:\.[^/]*)?$/.test(path)) continue;
  const lines = (await readFile(path, 'utf8')).split('\n');
  lines.forEach((line, index) => { if (credential.test(line)) findings.push(`${path}:${index + 1}: credential pattern detected`); });
}
assert.deepEqual(findings, [], findings.join('\n'));
console.log('PASS: production security invariants and targeted current-file credential-pattern scan (not a full history scan)');
