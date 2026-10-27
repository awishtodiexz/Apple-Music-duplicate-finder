import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const extensionFiles = ['manifest.json', 'popup.html', 'popup.css', 'popup.js',
  'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'].sort();

export async function validateBuild() {
  assert.deepEqual((await readdir('dist')).sort(), extensionFiles, 'Unexpected extension files');
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  for (const key of ['host_permissions', 'optional_host_permissions', 'optional_permissions', 'content_scripts',
    'background', 'externally_connectable', 'web_accessible_resources', 'side_panel']) assert.equal(manifest[key], undefined, key);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'");
  const html = await readFile('dist/popup.html', 'utf8');
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.match(html, /<script type="module" src="popup\.js"><\/script>/);
  const js = await readFile('dist/popup.js', 'utf8');
  // Guard privacy and code-execution invariants in the production bundle.
  assert.doesNotMatch(js, /\b(?:eval|fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(|\bnew\s+Function\b|\.innerHTML\s*=|\.outerHTML\s*=|chrome\.(?:cookies|storage|webRequest|sidePanel)\b/);
  for (const size of [16, 32, 48, 128]) {
    const file = `icon-${size}.png`;
    assert.equal(manifest.icons[size], file);
    assert.equal(manifest.action.default_icon[size], file);
    const png = await readFile('dist/' + file);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validateBuild();
  console.log('PASS: build files, versions, icons, minimal permissions, CSP and static privacy/security checks');
}
