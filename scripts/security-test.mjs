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

const textFile = /\.(?:ts|mjs|json|md|txt|html|css|ya?ml)$|\/\.env(?:\.[^/]*)?$/;
const contents = new Map();
for (const path of files) {
  if (textFile.test(path)) contents.set(path, (await readFile(path, 'utf8')).replace(/\r\n?/g, '\n'));
}

const findings = [];
const lineAt = (content, offset) => content.slice(0, offset).split('\n').length;
const report = (path, content, offset, message) => findings.push(`${path}:${lineAt(content, offset)}: ${message}`);

// 1. Current-file credential patterns. This is not a full Git history scan.
const credential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{30,255}\b|\bsk_live_[A-Za-z0-9]{20,255}\b/;
for (const [path, content] of contents) {
  content.split('\n').forEach((line, index) => {
    if (credential.test(line)) findings.push(`${path}:${index + 1}: credential pattern detected`);
  });
}

// 2. Production source may only use the reviewed DOM and browser surfaces.
const production = [...contents].filter(([path]) => /^\.\/(?:src|public)\//.test(path));
const forbidden = [
  [/\.innerHTML\s*=/, 'unsafe innerHTML assignment'],
  [/\.outerHTML\s*=/, 'unsafe outerHTML assignment'],
  [/\binsertAdjacentHTML\s*\(/, 'unsafe insertAdjacentHTML call'],
  [/\bdocument\.write(?:ln)?\s*\(/, 'unsafe document.write call'],
  [/\bDOMParser\b/, 'unexpected HTML parsing'],
  [/\bcreateContextualFragment\b/, 'unexpected contextual fragment parsing'],
  [/\bsrcdoc\b/, 'unexpected srcdoc use'],
  [/\beval\s*\(/, 'eval call'],
  [/\bnew\s+Function\b/, 'dynamic Function constructor'],
  [/\bfetch\s*\(/, 'network fetch call'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest use'],
  [/\bWebSocket\b/, 'WebSocket use'],
  [/\bsendBeacon\b/, 'sendBeacon use'],
  [/\bpostMessage\b/, 'cross-context postMessage use'],
  [/\bimportScripts\b/, 'importScripts use'],
  [/\bnew\s+Worker\b/, 'Worker creation'],
  [/\bserviceWorker\b/, 'service worker use'],
  [/\bwindow\.open\s*\(/, 'unexpected window.open call'],
  [/\bdocument\.cookie\b/, 'cookie access'],
  [/\bnavigator\.credentials\b/, 'credential API access'],
  [/\bnavigator\.clipboard\.read(?:Text)?\b/, 'clipboard read access'],
  [/\bclipboard\.read(?:Text)?\b/, 'clipboard read access'],
  [/\bchrome\.(?:cookies|identity|webRequest|history|downloads|management|debugger|proxy|privacy|bookmarks|declarativeNetRequest|storage)\b/, 'unnecessary Chrome API access'],
  [/\bjavascript:/i, 'javascript: URL'],
  [/\bdata:text\/html/i, 'HTML data URL'],
  [/\b(?:analytics|telemetry|sentry|mixpanel|amplitude|posthog|google-analytics)\b/i, 'analytics/telemetry reference'],
];
// Keep the scanner's own negative cases honest if a pattern is edited away.
for (const probe of ['el.innerHTML = x', 'fetch("https://evil.example")', 'document.cookie',
  'chrome.cookies', 'javascript:alert(1)']) {
  assert.ok(forbidden.some(([pattern]) => pattern.test(probe)), `security scanner missed probe: ${probe}`);
}
for (const [path, content] of production) {
  for (const [pattern, message] of forbidden) {
    const match = pattern.exec(content);
    if (match) report(path, content, match.index, message);
  }
}

// 3. Production source may only name the Apple Music endpoints it already uses.
const allowedOrigins = new Set(['https://music.apple.com', 'https://api.music.apple.com', 'https://amp-api.music.apple.com']);
const urlPattern = /https?:\/\/[^\s"'`)<>\]]+/g;
for (const [path, content] of production) {
  for (const match of content.matchAll(urlPattern)) {
    let url;
    try { url = new URL(match[0]); } catch { report(path, content, match.index, 'unparseable URL'); continue; }
    if (!allowedOrigins.has(url.origin) || url.username || url.password) {
      report(path, content, match.index, `unexpected remote destination ${url.origin}`);
    }
  }
}

// 4. Extension HTML keeps a single local module script and no inline handlers or embeds.
// Count tags as strings rather than extracting script bodies with a regex. The
// exact required tag also proves the single script has no inline content.
const expectedScript = '<script type="module" src="popup.js"></script>';
for (const [path, content] of production.filter(([path]) => path.endsWith('.html'))) {
  const openingScripts = content.split('<script').length - 1;
  const closingScripts = content.split('</script').length - 1;
  if (openingScripts !== 1 || closingScripts !== 1 || !content.includes(expectedScript)) {
    findings.push(`${path}: expected exactly one local popup.js module script`);
  }
  const handler = /\son[a-z]+\s*=/i.exec(content);
  if (handler) report(path, content, handler.index, 'inline event handler');
  const dangerousTag = /<(?:iframe|object|embed|base|form)\b/i.exec(content);
  if (dangerousTag) report(path, content, dangerousTag.index, 'embedded or navigable content');
  const refresh = /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.exec(content);
  if (refresh) report(path, content, refresh.index, 'automatic navigation');
  for (const match of content.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(match[1])) {
      report(path, content, match.index, 'external resource');
    }
  }
}

// 5. The shipped manifest source keeps the reviewed permission and CSP boundary.
const manifestPath = './public/manifest.json';
const manifestSource = contents.get(manifestPath);
if (!manifestSource) {
  findings.push(`${manifestPath}: manifest source is missing`);
} else {
  const manifest = JSON.parse(manifestSource);
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['activeTab', 'scripting'])) {
    findings.push(`${manifestPath}: permissions must be exactly activeTab and scripting`);
  }
  for (const key of ['host_permissions', 'optional_permissions', 'optional_host_permissions', 'content_scripts',
    'background', 'externally_connectable', 'web_accessible_resources', 'side_panel', 'update_url',
    'chrome_url_overrides', 'sandbox', 'oauth2', 'requirements']) {
    if (manifest[key] !== undefined) findings.push(`${manifestPath}: unexpected manifest key ${key}`);
  }
  const csp = manifest.content_security_policy?.extension_pages;
  if (csp !== "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'") {
    findings.push(`${manifestPath}: Content Security Policy differs from the reviewed policy`);
  }
  if (manifest.content_security_policy?.sandbox !== undefined) {
    findings.push(`${manifestPath}: sandbox Content Security Policy is not allowed`);
  }
}

assert.deepEqual(findings, [], findings.join('\n'));
console.log('PASS: build permissions/CSP, source DOM/network/cookie/telemetry invariants, and targeted current-file credential-pattern scan (not a full history scan)');
