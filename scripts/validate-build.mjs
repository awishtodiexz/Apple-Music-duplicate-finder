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
  assert.match(manifest.version, /^\d+\.\d+(?:\.\d+)?$/, 'manifest version must have two or three numeric components');
  assert.equal(manifest.version, pkg.version.replace(/\.0$/, ''));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.name, 'Apple Music Playlist Duplicate Finder');
  assert.ok(manifest.name.length <= 75, 'manifest name exceeds the Chrome limit');
  assert.ok(manifest.description.length <= 132, 'manifest description exceeds the Chrome limit');
  assert.equal(manifest.minimum_chrome_version, '111');
  assert.equal(manifest.action.default_title, 'Apple Music Playlist Duplicate Finder');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  for (const key of ['host_permissions', 'optional_host_permissions', 'optional_permissions', 'content_scripts',
    'background', 'externally_connectable', 'web_accessible_resources', 'side_panel', 'update_url', 'key',
    'commands', 'chrome_url_overrides', 'options_ui', 'devtools_page', 'declarative_net_request',
    'sandbox', 'oauth2', 'requirements']) {
    assert.equal(manifest[key], undefined, key);
  }
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(Object.keys(manifest.icons).sort(), ['128', '16', '32', '48']);
  assert.deepEqual(Object.keys(manifest.action.default_icon).sort(), ['128', '16', '32', '48']);
  assert.equal(manifest.content_security_policy.extension_pages,
    "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'");
  assert.equal(manifest.content_security_policy.sandbox, undefined, 'sandbox CSP');
  const html = await readFile('dist/popup.html', 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="UTF-8">/);
  assert.match(html, /<meta name="viewport"/);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal((html.match(/<link\b/g) || []).length, 1);
  assert.match(html, /<link rel="stylesheet" href="popup\.css">/);
  assert.match(html, /<script type="module" src="popup\.js"><\/script>/);
  // The popup must not load remote content, inline scripts, or inline handlers.
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<base\b/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  const css = await readFile('dist/popup.css', 'utf8');
  assert.doesNotMatch(css, /@import\b|url\(\s*['"]?https?:/i, 'CSS must not load remote content');
  const js = await readFile('dist/popup.js', 'utf8');
  // Guard privacy and code-execution invariants in the production bundle.
  assert.doesNotMatch(js, /\b(?:eval|fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(|\bnew\s+Function\b|\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(|\bDOMParser\b|\bpostMessage\b|\bjavascript:|\bdata:text\/html|\bchrome\.(?:cookies|storage|webRequest|identity|sidePanel)\b/);
  assert.doesNotMatch(js, /sourceMappingURL|sourceURL/, 'production bundle must not ship source references');
  // The only remote origins allowed in the bundle are Apple Music's page/API.
  assert.doesNotMatch(js.replace(/https:\/\/(?:(?:amp-)?api\.)?music\.apple\.com/g, ''), /https?:\/\//,
    'production bundle must not reference other remote origins');
  const jsBytes = Buffer.byteLength(js);
  assert.ok(jsBytes < 128 * 1024, `popup.js is unexpectedly large (${jsBytes} bytes)`);
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
