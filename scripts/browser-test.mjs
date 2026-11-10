import { fixture } from './fixtures/player.mjs';
import { auditAccessibility } from './a11y-audit.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.background, undefined);
for (const size of [16, 32, 48, 128]) {
  const path = `icon-${size}.png`;
  assert.equal(manifest.icons[size], path);
  assert.equal(manifest.action.default_icon[size], path);
  const png = await readFile('dist/' + path);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}
console.log('PASS: extension and toolbar icons exist as correctly sized PNGs');

let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 380, height: 640 } });
  // Generous default: CI can run browser suites alongside other jobs. Assertions
  // still require the exact state; only the wait for that state is relaxed.
  context.setDefaultTimeout(45_000);
  // Every http(s) origin contacted by the fixture page or popup is recorded. The
  // popup has no backend, so only the two controlled fixture origins are allowed.
  const requestOrigins = new Set();
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/i.test(url)) requestOrigins.add(new URL(url).origin);
  });
  async function assertAccessible(page, state) {
    const audit = await page.evaluate(auditAccessibility);
    assert.deepEqual(audit.findings, [], `${state} accessibility findings:\n${audit.findings.join('\n')}`);
    assert.ok(audit.checkedControls > 0, `${state} must expose at least one control`);
    return audit;
  }
  // All Apple traffic is local fixture content. Nothing authenticates or reaches Apple.
  await context.route('https://music.apple.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const assets = new Map(await Promise.all(['popup.html', 'popup.css', 'popup.js'].map(async name =>
    [name, await readFile('dist/' + name, 'utf8')])));
  await context.route('https://duplicate-finder.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const contentTypes = { 'popup.html': 'text/html', 'popup.css': 'text/css', 'popup.js': 'text/javascript' };
    return route.fulfill({ status: assets.has(name) ? 200 : 404, body: assets.get(name) || '',
      contentType: contentTypes[name] || 'text/plain',
      headers: { 'Content-Security-Policy': manifest.content_security_policy.extension_pages } });
  });
  const apple = await context.newPage();
  await apple.goto('https://music.apple.com/us/library/playlist/p.fixture');
  const popup = await context.newPage();
  // Explicit Chrome-API adapter: this tests the bundled UI and serialized function in
  // the player's MAIN world. It does NOT test installing the extension or activeTab.
  await popup.exposeBinding('readPlayerUrl', () => apple.url());
  await popup.exposeBinding('executeInPlayer', async (_source, payload) => apple.evaluate(
    ({ functionSource, request }) => (0, eval)('(' + functionSource + ')')(request), payload,
  ));
  await popup.addInitScript(version => {
    if (location.search.includes('reset')) localStorage.clear();
    window.chrome = {
      runtime: { getManifest: () => ({ version }), getURL: path => 'https://duplicate-finder.test/' + path },
      action: {
        setBadgeText: async ({ text }) => { window.__badge = text; },
        setBadgeBackgroundColor: async () => {},
      },
      windows: { create: async options => { window.__createdWindow = options; return {}; } },
      tabs: {
        query: async () => [{ id: 1, url: await window.readPlayerUrl() }],
        get: async id => ({ id, url: await window.readPlayerUrl() }),
      },
      scripting: { executeScript: async ({ target, world, func, args }) => {
        if (world !== 'MAIN' || target.tabId !== 1 || target.frameIds[0] !== 0) throw new Error('Unexpected injection');
        return [{ frameId: 0, result: await window.executeInPlayer({ functionSource: func.toString(), request: args[0] }) }];
      } },
    };
  }, manifest.version);
  const pageErrors = [];
  popup.on('pageerror', error => pageErrors.push(error.message));
  const popupUrl = 'https://duplicate-finder.test/popup.html';
  let scenarioCount = 0;
  for (const apiMode of ['legacy', 'v3']) {
    async function open(scenario, path = '/us/library/playlist/p.fixture') {
      scenarioCount++;
      await apple.evaluate(({ scenario, path, apiMode }) => {
        window.scenario = scenario;
        window.apiMode = apiMode;
        window.requests = [];
        window.fixtureDelay = 25;
        window.revision = 'rev-1';
        history.replaceState({}, '', path);
      }, { scenario, path, apiMode });
      await popup.goto(popupUrl + '?reset=1');
    }
    async function scan() {
      await popup.locator('#scan').click();
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    }
    for (const scenario of ['duplicates', 'mixed']) {
      await open(scenario);
      await popup.getByRole('button', { name: 'Scan for Duplicates' }).waitFor({ state: 'visible' });
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
      assert.equal(await popup.locator('#version').textContent(), `v${manifest.version}`);
      if (scenario === 'duplicates') await assertAccessible(popup, `${apiMode} ready state`);
      assert.equal(await popup.locator('#status-code').isVisible(), false);
      assert.equal(await popup.locator('#playlist-name').textContent(), '<img src=x onerror=alert(1)> My playlist');
      assert.equal(await popup.locator('img').count(), 0);
      await popup.locator('#scan').click();
      await popup.getByRole('heading', { name: 'Scanning playlist…', exact: true }).waitFor();
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
      assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
      assert.match(await popup.locator('#status-detail').textContent(), /245 songs scanned\n1 song appears more than once/);
      // Progress is visual; only phase changes reach the dedicated announcer.
      assert.equal(await popup.locator('#status').getAttribute('aria-live'), null);
      await popup.waitForFunction(() => /Scan complete/.test(document.querySelector('#status-announcer').textContent));
      assert.equal(await popup.locator('#duplicate-list li').count(), 1);
      assert.equal(await popup.locator('.positions').textContent(), 'Playlist positions: 1, 101, 245');
      assert.equal(await popup.locator('.song').textContent(), 'Numb');
      assert.equal(await popup.locator('.artist').textContent(), 'Linkin Park');
      assert.equal(await popup.locator('.counts').textContent(), 'This song appears 3 times');
      assert.equal(await popup.locator('#results-title').textContent(), 'Repeated songs · 1');
      assert.equal(await popup.locator('#scan').textContent(), 'Scan again');
      assert.equal(await popup.evaluate(() => window.__badge), '1');
      const paths = await apple.evaluate(() => window.requests);
      // Connect metadata (reused as the baseline) + 3 track pages + validation metadata.
      assert.equal(paths.length, 5);
      assert.ok(paths.every(path => /^\/v1\/me\/library\/playlists\/p\.fixture(?:\/tracks\?|$)/.test(path)));
      await mkdir('artifacts', { recursive: true });
      await popup.screenshot({ path: 'artifacts/popup-results.png', fullPage: true });
      const audit = await assertAccessible(popup, `${apiMode} results state`);
      assert.ok(audit.checkedContrast >= 10, 'results state should exercise text contrast checks');
    }
    console.log(`PASS (${apiMode}): bundled UI and serialized MAIN function through Chrome-API adapter, 245-track pagination, mixed identifiers, progress, results, safe text rendering`);

    // Catalog playlists use the catalog endpoint. A same-ID route change to a
    // different storefront is a different visible playlist and must be rejected.
    await open('duplicates', '/us/playlist/fixture/pl.fixture');
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
    assert.equal(await popup.locator('.positions').textContent(), 'Playlist positions: 1, 101, 245');
    const catalogPaths = await apple.evaluate(() => window.requests);
    assert.equal(catalogPaths.length, 5);
    assert.ok(catalogPaths.every(path => /^\/v1\/catalog\/us\/playlists\/pl\.fixture(?:\/tracks\?|$)/.test(path)));
    await open('navigateStorefront', '/us/playlist/fixture/pl.fixture');
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
    assert.match(await popup.locator('#status-detail').textContent(), /playlist or tab changed/);
    assert.equal(await popup.locator('#status-code').textContent(), 'Error code: PAGE_CHANGED');
    assert.equal(await popup.locator('#results').isVisible(), false);
    console.log(`PASS (${apiMode}): catalog playlist endpoint and same-ID regional route change rejection`);

    await open('duplicates');
    await scan();
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    // Minimum-copies filter hides smaller groups and restores them.
    await popup.locator('#results-min').selectOption('4');
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    assert.equal(await popup.locator('#results-empty').isVisible(), true);
    await popup.locator('#results-min').selectOption('2');
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    // Copy is stubbed here so the assertion does not depend on headless clipboard policy.
    await popup.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => { window.__copiedResults = text; } },
      });
    });
    assert.equal(await popup.getByLabel('Search repeated songs').isVisible(), true);
    assert.equal(await popup.getByLabel('Sort repeated songs').isVisible(), true);
    await popup.getByRole('button', { name: 'Copy visible results' }).click();
    await popup.waitForFunction(() => Boolean(window.__copiedResults));
    const copied = await popup.evaluate(() => window.__copiedResults);
    assert.match(copied, /Numb — Linkin Park — 3 copies — positions 1, 101, 245/);
    assert.match(await popup.locator('#results-feedback').textContent(), /Copied 1 song/);

    // Per-group copy carries only that song's positions.
    await popup.evaluate(() => { window.__copiedResults = null; });
    await popup.getByRole('button', { name: 'Copy Numb by Linkin Park' }).click();
    await popup.waitForFunction(() => Boolean(window.__copiedResults));
    const copiedGroup = await popup.evaluate(() => window.__copiedResults);
    assert.equal(copiedGroup, 'Numb — Linkin Park\n3 copies · positions 1, 101, 245');
    assert.match(await popup.locator('#results-feedback').textContent(), /Copied Numb\./);

    const downloadPromise = popup.waitForEvent('download');
    await popup.getByRole('button', { name: 'Download visible results as CSV' }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^apple-music-duplicates-.*\.csv$/);
    const downloadPath = await download.path();
    assert.ok(downloadPath);
    const csv = await readFile(downloadPath, 'utf8');
    assert.match(csv, /Song,Artist,Copies,Extra copies,Positions\r\nNumb,Linkin Park,3,2,1 101 245/);
    assert.equal(csv.charCodeAt(0), 0xFEFF); // Excel-friendly UTF-8 BOM
    assert.match(await popup.locator('#results-feedback').textContent(), /Downloaded 1 song as CSV/);

    // "/" focuses search, Escape clears it, and the empty state can reset filters.
    await popup.keyboard.press('/');
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'results-search');
    const focusRing = await popup.evaluate(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return { visible: active.matches(':focus-visible'), width: style.outlineWidth, style: style.outlineStyle };
    });
    assert.equal(focusRing.visible, true);
    assert.equal(focusRing.style, 'solid');
    assert.ok(parseFloat(focusRing.width) >= 2);
    await popup.keyboard.type('numb');
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    await popup.keyboard.press('Escape');
    assert.equal(await popup.locator('#results-search').inputValue(), '');
    await popup.locator('#results-search').fill('zzz');
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    await popup.waitForFunction(() => /0 of 1 songs match/.test(document.querySelector('#results-announcer').textContent));
    assert.equal(await popup.locator('#results-title').getAttribute('aria-live'), null);
    await popup.getByRole('button', { name: 'Clear search and filters' }).click();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.locator('#results-search').inputValue(), '');
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'results-search');

    // A completed scan survives closing and reopening the popup.
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    await popup.waitForFunction(() => /Rescan to refresh/.test(document.querySelector('#status-detail').textContent));
    assert.match(await popup.locator('#status-detail').textContent(), /Cached .*Rescan to refresh/);

    // A changed modification marker marks the cached scan as stale.
    await apple.evaluate(() => { window.scenario = 'edited'; });
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => /changed since this scan/.test(document.querySelector('#status-detail').textContent));
    assert.match(await popup.locator('#status-detail').textContent(), /Cached .*changed since this scan/);

    // Cached results stay visible when MusicKit is unavailable.
    await apple.evaluate(() => { window.scenario = 'unavailable'; });
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    await popup.waitForFunction(() => document.querySelector('#status-code').textContent === 'Error code: MUSICKIT_UNAVAILABLE');
    assert.match(await popup.locator('#status-detail').textContent(), /Cached .*MusicKit instance is unavailable/);
    assert.equal(await popup.locator('#status-code').textContent(), 'Error code: MUSICKIT_UNAVAILABLE');
    assert.equal(await popup.locator('#scan').textContent(), 'Retry connection');
    // Reconnecting after the player recovers keeps the cache and enables a rescan.
    await apple.evaluate(() => { window.scenario = 'duplicates'; });
    await popup.locator('#scan').click();
    await popup.waitForFunction(() => document.querySelector('#scan').textContent === 'Scan again');
    assert.match(await popup.locator('#status-detail').textContent(), /Rescan to refresh/);

    // Opening the popup on a different playlist clears the previous badge.
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    await apple.evaluate(() => history.replaceState({}, '', '/us/library/playlist/p.other'));
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Ready to scan' }).waitFor();
    assert.equal(await popup.evaluate(() => window.__badge), '');
    await apple.evaluate(() => history.replaceState({}, '', '/us/library/playlist/p.fixture'));
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
    // The cached paint is immediate; wait for the reconnect to finish before clearing.
    await popup.waitForFunction(() => document.querySelector('#scan').textContent === 'Scan again');

    await popup.locator('#results-sort').selectOption('copies');
    await popup.getByRole('button', { name: 'Clear results' }).click();
    assert.equal(await popup.locator('#status-title').textContent(), 'Results cleared');
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'scan');
    assert.equal(await popup.locator('#results-sort').inputValue(), 'playlist');
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    assert.equal(await popup.evaluate(() => window.__badge), '');
    assert.equal(await popup.locator('#scan').textContent(), 'Scan for Duplicates');
    assert.equal(await popup.evaluate(() => localStorage.getItem('amdf:last-scan:v1')), null);
    console.log(`PASS (${apiMode}): copy (all and per song), CSV with BOM, minimum-copies filter, keyboard search, filter reset, toolbar badge, scan-again label, stale-cache notice, cached last scan, and explicit clear`);

    // A failed rescan must not replace the last successful result: keep the
    // completed result, badge and Clear action, and label them as previous results.
    await open('duplicates');
    await scan();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    await apple.evaluate(() => { window.scenario = 'network'; });
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
    assert.match(await popup.locator('#status-detail').textContent(), /could not be reached/);
    assert.match(await popup.locator('#status-detail').textContent(), /Showing the last completed scan from/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.locator('.positions').textContent(), 'Playlist positions: 1, 101, 245');
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    assert.equal(await popup.locator('#clear-results').isVisible(), true);
    assert.equal(await popup.locator('#scan').textContent(), 'Retry scan');
    const retainedCache = await popup.evaluate(() => JSON.parse(localStorage.getItem('amdf:last-scan:v1')));
    assert.equal(retainedCache.groups.length, 1);
    await apple.evaluate(() => { window.scenario = 'duplicates'; });
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');

    // Cancelling a rescan keeps the same last successful result and badge.
    await apple.evaluate(() => { window.requests = []; window.fixtureDelay = 600; });
    await popup.locator('#scan').click();
    await popup.waitForFunction(() => !document.querySelector('#cancel').hidden);
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    await apple.waitForFunction(() => window.requests.some(path => path.includes('/tracks?')));
    await popup.getByRole('button', { name: 'Cancel scan', exact: true }).click();
    await popup.getByRole('heading', { name: 'Scan cancelled', exact: true }).waitFor();
    assert.match(await popup.locator('#status-detail').textContent(), /Showing the last completed scan from/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    assert.equal(await popup.locator('#scan').textContent(), 'Scan again');
    await apple.evaluate(() => { window.fixtureDelay = 25; });

    // Closing the popup mid-scan discards the in-progress scan; the cached
    // completed scan and badge are restored on reopen.
    await apple.evaluate(() => { window.requests = []; window.fixtureDelay = 600; });
    await popup.locator('#scan').click();
    await apple.waitForFunction(() => window.requests.some(path => path.includes('/tracks?')));
    await apple.evaluate(() => { window.fixtureDelay = 25; });
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    await popup.waitForFunction(() => document.querySelector('#scan').textContent === 'Scan again');

    // Copy and CSV keep the cached playlist name when the player is unavailable.
    await apple.evaluate(() => { window.scenario = 'unavailable'; });
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.querySelector('#status-code').textContent === 'Error code: MUSICKIT_UNAVAILABLE');
    await popup.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => { window.__copiedResults = text; } },
      });
    });
    await popup.getByRole('button', { name: 'Copy visible results' }).click();
    await popup.waitForFunction(() => Boolean(window.__copiedResults));
    assert.match(await popup.evaluate(() => window.__copiedResults),
      /^Apple Music Duplicate Finder — <img src=x onerror=alert\(1\)> My playlist/);
    const cachedDownloadPromise = popup.waitForEvent('download');
    await popup.getByRole('button', { name: 'Download visible results as CSV' }).click();
    const cachedDownload = await cachedDownloadPromise;
    assert.match(cachedDownload.suggestedFilename(),
      /^apple-music-duplicates-img-src-x-onerror-alert-1-My-playlist-\d{4}-\d{2}-\d{2}\.csv$/);

    // Clearing while the player is still connecting must not let the in-flight
    // metadata response resurrect a cached-scan status.
    await apple.evaluate(() => { window.scenario = 'duplicates'; window.fixtureDelay = 2_000; });
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
    await popup.getByRole('button', { name: 'Clear results' }).click();
    assert.equal(await popup.locator('#status-title').textContent(), 'Results cleared');
    await popup.waitForFunction(() => document.querySelector('#scan').textContent === 'Scan for Duplicates');
    assert.equal(await popup.locator('#status-title').textContent(), 'Ready to scan');
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    await popup.waitForFunction(() => window.__badge === '');
    assert.equal(await popup.evaluate(() => localStorage.getItem('amdf:last-scan:v1')), null);
    await apple.evaluate(() => { window.fixtureDelay = 25; });

    // A matching revision hash is current; the same modification date with a
    // different revision hash is stale even though the date still matches.
    await open('revision');
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => /Rescan to refresh/.test(document.querySelector('#status-detail').textContent));
    assert.doesNotMatch(await popup.locator('#status-detail').textContent(), /changed since this scan/);
    await apple.evaluate(() => { window.revision = 'rev-2'; });
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => /changed since this scan/.test(document.querySelector('#status-detail').textContent));
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);

    // Schema-inconsistent cache data is discarded instead of rendered as current.
    await open('duplicates');
    await popup.evaluate(() => localStorage.setItem('amdf:last-scan:v1', JSON.stringify({
      version: 1, playlistId: 'p.fixture', playlistName: 'Fixture', scannedAt: Date.now(),
      unidentified: 0, totalTracks: 245, countVerified: true, modificationChecked: true, notes: '',
      groups: [{ identity: 'catalog:1', name: 'Numb', artist: 'Linkin Park', positions: [1, 101], copies: 3, extraCopies: 2 }],
    })));
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Ready to scan', exact: true }).waitFor();
    await popup.waitForFunction(() => window.__badge === '');
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    assert.equal(await popup.locator('#clear-results').isVisible(), false);

    // After navigating to another playlist, reconnecting must not keep showing
    // the previous playlist's last completed results.
    await open('duplicates');
    await scan();
    await apple.evaluate(() => { window.scenario = 'navigate'; });
    await scan();
    assert.equal(await popup.locator('#status-code').textContent(), 'Error code: PAGE_CHANGED');
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.locator('#scan').textContent(), 'Retry connection');
    await apple.evaluate(() => { window.scenario = 'duplicates'; });
    await popup.getByRole('button', { name: 'Retry connection' }).click();
    await popup.getByRole('heading', { name: 'Ready to scan', exact: true }).waitFor();
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    assert.equal(await popup.locator('#results').isVisible(), false);
    await popup.waitForFunction(() => window.__badge === '');
    console.log(`PASS (${apiMode}): failed/cancelled/mid-scan-close rescans preserve the last completed result and badge; cached copy/CSV naming; revision-based staleness; corrupt cache rejection; playlist switch recovery`);

    for (const scenario of ['empty', 'distinct']) {
      await open(scenario);
      await scan();
      assert.equal(await popup.locator('#status-title').textContent(), 'No exact duplicates found');
      assert.match(await popup.locator('#status-detail').textContent(), /No duplicate songs found\./);
      assert.equal(await popup.locator('#results').isVisible(), false);
    }
    console.log(`PASS (${apiMode}): empty and no-duplicates popup states`);

    await open('distinct');
    await scan();
    assert.equal(await popup.locator('#results').isVisible(), false);
    assert.equal(await popup.locator('#clear-results').isVisible(), true);
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
    // The cached paint is immediate; let the reconnect finish before clearing so
    // this assertion checks Clear itself, not an in-flight connection update.
    await popup.waitForFunction(() => document.querySelector('#scan').textContent === 'Scan again');
    assert.equal(await popup.locator('#clear-results').isVisible(), true);
    await popup.getByRole('button', { name: 'Clear results' }).click();
    await popup.getByRole('heading', { name: 'Results cleared' }).waitFor();
    assert.equal(await popup.locator('#status-title').textContent(), 'Results cleared');

    for (const [scenario, message, code] of [
      ['rate', /limiting requests/, 'RATE_LIMIT'], ['network', /could not be reached/, 'NETWORK'],
      ['internal', /internal error/, 'INTERNAL'],
      ['malformed', /unexpected response/, 'FORMAT'], ['incomplete', /incomplete or changed/, 'INCOMPLETE'],
      ['truncated', /incomplete or changed/, 'INCOMPLETE'],
      ['navigate', /playlist or tab changed/, 'PAGE_CHANGED'],
      ['expired', /Sign in/, 'AUTH'], ['resolvedError', /Sign in/, 'AUTH'],
    ]) {
      await open(scenario);
      await scan();
      assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
      assert.match(await popup.locator('#status-detail').textContent(), message);
      assert.equal(await popup.locator('#status-code').textContent(), `Error code: ${code}`);
      const sourceRetained = ['rate', 'network', 'internal', 'malformed', 'incomplete', 'truncated'].includes(scenario);
      assert.equal(await popup.locator('#scan').textContent(), sourceRetained ? 'Retry scan' : 'Retry connection');
      assert.equal(await popup.locator('#results').isVisible(), false);
      assert.equal(await popup.locator('#duplicate-list li').count(), 0);
      if (scenario === 'network') await assertAccessible(popup, `${apiMode} error state`);
    }
    console.log(`PASS (${apiMode}): rate limit, expired session, later network failure, malformed page, truncated continuation, incomplete scan, navigation rejection`);

    for (const [scenario, path, message, code] of [
      ['auth', '/us/library/playlist/p.fixture', /Sign in/, 'AUTH'],
      ['unavailable', '/us/library/playlist/p.fixture', /MusicKit instance is unavailable/, 'MUSICKIT_UNAVAILABLE'],
      ['duplicates', '/us/browse', /Open a playlist/, 'NOT_PLAYLIST'],
    ]) {
      await open(scenario, path);
      await popup.getByRole('heading', { name: 'Could not connect' }).waitFor();
      assert.match(await popup.locator('#status-detail').textContent(), message);
      assert.equal(await popup.locator('#status-code').textContent(), `Error code: ${code}`);
      assert.equal(await popup.locator('#scan').isDisabled(), false);
      assert.equal(await popup.locator('#scan').textContent(), 'Retry connection');
    }
    console.log(`PASS (${apiMode}): sign-in, unavailable MusicKit, and non-playlist errors`);

    await open('unavailable');
    await popup.getByRole('heading', { name: 'Could not connect' }).waitFor();
    await apple.evaluate(() => { window.scenario = 'duplicates'; });
    await popup.getByRole('button', { name: 'Retry connection' }).click();
    await popup.getByRole('heading', { name: 'Ready to scan' }).waitFor();
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');

    await open('network');
    await scan();
    await apple.evaluate(() => { window.scenario = 'duplicates'; });
    await scan();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.locator('.positions').textContent(), 'Playlist positions: 1, 101, 245');

    await open('unknown');
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'No duplicates among identified songs');
    assert.match(await popup.locator('#status-detail').textContent(), /245 entries had no reliable song ID/);

    await open('noMarker');
    await scan();
    assert.match(await popup.locator('#scan-notes').textContent(), /Same-count edits or reordering cannot be detected/);

    await open('huge');
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
    assert.match(await popup.locator('#status-detail').textContent(), /resource limit/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);

    await open('lateFailure');
    await popup.getByRole('heading', { name: 'Ready to scan', exact: true }).waitFor();
    await apple.evaluate(() => { window.fixtureDelay = 700; });
    await popup.locator('#scan').click();
    // Cancel after a track request has started, not just the initial metadata.
    await apple.waitForFunction(() => window.requests.some(path => path.includes('/tracks?')));
    const startedCancel = Date.now();
    await popup.getByRole('button', { name: 'Cancel scan', exact: true }).click();
    await popup.getByRole('heading', { name: 'Scan cancelled', exact: true }).waitFor();
    assert.ok(Date.now() - startedCancel < 1000, 'Cancellation should not wait for the API timeout');
    assert.equal(await popup.locator('#cancel').isVisible(), false);
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    await apple.evaluate(() => { window.scenario = 'duplicates'; window.fixtureDelay = 25; });
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
    // Wait for the deliberately non-abortable legacy request to reject. Its late
    // rejection must not overwrite the new scan or cause an unhandled exception.
    await apple.waitForFunction(() => window.lateFailures > 0);
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
    assert.equal(await popup.locator('.positions').textContent(), 'Playlist positions: 1, 101, 245');
    if (apiMode === 'v3') assert.ok(await apple.evaluate(() => window.abortedRequests > 0));
    console.log(`PASS (${apiMode}): consistency warning, huge playlist refusal, prompt cancellation, late failure isolation and successful rescan`);

    await open('duplicates');
    await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    await apple.evaluate(() => { window.fixtureDelay = 200; });
    assert.equal(await popup.locator('#pop-out').isVisible(), true);
    await popup.locator('#scan').click();
    // Popping out during the scan would close this popup and abort the scan.
    await popup.waitForFunction(() => !document.querySelector('#cancel').hidden);
    assert.equal(await popup.locator('#pop-out').isVisible(), false);
    await popup.waitForFunction(() => document.querySelector('#scan-progress').value === 100);
    assert.equal(await popup.locator('#scan').isDisabled(), true);
    assert.equal(await popup.locator('#scan-progress').getAttribute('max'), '245');
    await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    assert.equal(await popup.locator('#scan-progress').isVisible(), false);
    assert.equal(await popup.locator('#pop-out').isVisible(), true);

    await open('coverage');
    await scan();
    await popup.setViewportSize({ width: 320, height: 480 });
    assert.match(await popup.locator('#scan-notes').textContent(), /1 entry had no reliable song ID/);
    assert.match(await popup.locator('#scan-notes').textContent(), /Apple supplied no total/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.ok(await popup.locator('#results-scroll').evaluate(el => el.clientHeight > 100));
    await popup.setViewportSize({ width: 380, height: 640 });

    await open('many');
    await scan();
    assert.match(await popup.locator('#status-detail').textContent(), /1,200 songs appear more than once/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 50);
    assert.equal(await popup.locator('.counts').first().textContent(), 'This song appears twice');
    assert.equal(await popup.locator('#show-more').textContent(), 'Show 50 more songs');
    await assertAccessible(popup, `${apiMode} many results`);
    assert.match(await popup.locator('#status-detail').textContent(), /1,200 extra copies/);
    await popup.locator('#results-search').fill('Numb');
    assert.equal(await popup.locator('#duplicate-list li').count(), 3);
    assert.match(await popup.locator('#results-title').textContent(), /3 of 1,200 matching/);
    // The result title carries counts; at the narrowest supported popup it must
    // wrap instead of clipping the matching total behind an ellipsis.
    await popup.setViewportSize({ width: 300, height: 480 });
    const titleFit = await popup.locator('#results-title').evaluate(el => ({
      client: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight,
      text: el.textContent,
    }));
    assert.match(titleFit.text, /3 of 1,200 matching/);
    assert.ok(titleFit.scroll <= titleFit.client + 1, 'title must not be horizontally clipped');
    assert.ok(titleFit.height > 20, 'title should wrap to more than one line at 300px');
    await popup.setViewportSize({ width: 380, height: 640 });
    await popup.locator('#results-search').fill('no such song');
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    assert.equal(await popup.locator('#results-empty').isVisible(), true);
    await popup.locator('#results-search').fill('');
    assert.equal(await popup.locator('#duplicate-list li').count(), 50);
    await popup.locator('#results-sort').selectOption('artist');
    assert.equal(await popup.locator('.song').first().textContent(), 'Song 1');
    await popup.locator('#results-sort').selectOption('playlist');
    assert.equal(await popup.locator('.song').first().textContent(), 'Numb');
    await popup.locator('#show-more').click();
    assert.equal(await popup.locator('#duplicate-list li').count(), 100);
    assert.equal(await popup.locator('#results-scroll').evaluate(el => el.contains(document.activeElement)), true);
    // The dark palette must keep names, references and text contrast valid too.
    await popup.emulateMedia({ colorScheme: 'dark' });
    await assertAccessible(popup, `${apiMode} dark results`);
    await popup.emulateMedia({ colorScheme: 'light' });
    // Same popup structure at constrained sizes, in both native color schemes.
    for (const colorScheme of ['light', 'dark']) {
      await popup.emulateMedia({ colorScheme });
      for (const viewport of [{ width: 380, height: 600 }, { width: 320, height: 480 }, { width: 300, height: 300 }]) {
        await popup.setViewportSize(viewport);
        await popup.evaluate(() => window.scrollTo(0, 0));
        const layout = await popup.evaluate(() => {
          const root = document.scrollingElement;
          const area = document.querySelector('#results-scroll');
          return { documentScrolls: root.scrollHeight > root.clientHeight,
            horizontalOverflow: root.scrollWidth > root.clientWidth,
            innerOverflow: getComputedStyle(area).overflowY,
            resultsHeight: area.clientHeight };
        });
        assert.equal(layout.documentScrolls, true);
        assert.equal(layout.horizontalOverflow, false);
        assert.equal(layout.innerOverflow, 'visible');
        assert.ok(layout.resultsHeight > 100);
        // Real wheel input must reach the document, including a 300px-high popup.
        await popup.mouse.move(viewport.width / 2, viewport.height / 2);
        await popup.mouse.wheel(0, 400);
        await popup.waitForFunction(() => window.scrollY > 0);
        await popup.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        assert.equal(await popup.locator('.positions').last().evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        }), true);
        assert.equal(await popup.locator('footer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true);
        await popup.screenshot({ path: `artifacts/popup-${colorScheme}-${viewport.width}.png` });
      }
    }
    await popup.setViewportSize({ width: 380, height: 640 });
    await popup.emulateMedia({ colorScheme: 'light' });
    // Render the remaining batches inside the page so the measurement covers DOM
    // work rather than Playwright round trips. The generous bound only catches a
    // pathological regression; the exact rendered count is the real assertion.
    const batchRenderMs = await popup.evaluate(() => {
      const button = document.querySelector('#show-more');
      const started = performance.now();
      while (button && !button.hidden) button.click();
      return performance.now() - started;
    });
    assert.equal(await popup.locator('#duplicate-list li').count(), 1200);
    assert.equal(await popup.locator('.positions').last().textContent(), 'Playlist positions: 1,200, 2,400');
    assert.equal(await popup.locator('#results-scroll').evaluate(el => el.contains(document.activeElement)), true);
    assert.ok(batchRenderMs < 10_000, `Rendering 1,100 additional groups took ${batchRenderMs.toFixed(0)}ms`);
    console.log(`Render timing (${apiMode}): 1,100 additional groups in 22 batches took ${batchRenderMs.toFixed(0)}ms`);

    await open('fiftyOne');
    await scan();
    assert.equal(await popup.locator('#duplicate-list li').count(), 50);
    assert.equal(await popup.locator('#show-more').textContent(), 'Show 1 more song');
    await popup.locator('#show-more').click();
    assert.equal(await popup.locator('#duplicate-list li').count(), 51);
    assert.equal(await popup.locator('#show-more').isVisible(), false);

    await open('oneGroup');
    await scan();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.match(await popup.locator('#status-detail').textContent(), /6,000 songs scanned\n1 song appears more than once · 5,999 extra copies/);
    assert.match(await popup.locator('.positions').textContent(), /…and 5,950 more/);
    assert.equal(await popup.getByRole('button', { name: 'Show all 6,000 positions' }).isVisible(), true);
    const heights = await popup.evaluate(() => document.scrollingElement.scrollHeight);
    assert.equal(await popup.locator('.more-positions').getAttribute('aria-expanded'), 'false');
    const expandMs = await popup.evaluate(() => {
      const button = document.querySelector('.more-positions');
      button.focus();
      const started = performance.now();
      button.click();
      return performance.now() - started;
    });
    assert.ok(expandMs < 5_000, `Expanding 6,000 positions took ${expandMs.toFixed(0)}ms`);
    console.log(`Render timing (${apiMode}): expanding 6,000 positions took ${expandMs.toFixed(0)}ms`);
    // A huge group expands into a bounded, focusable region and keeps the toggle
    // focused, so a 6,000-position list cannot grow the document by thousands of
    // pixels or drop keyboard focus onto the body when the button is replaced.
    assert.equal(await popup.getByRole('button', { name: 'Show fewer positions' }).getAttribute('aria-expanded'), 'true');
    assert.equal(await popup.evaluate(() => document.activeElement?.classList.contains('more-positions')), true);
    assert.equal(await popup.locator('.positions').getAttribute('role'), 'group');
    assert.match(await popup.locator('.positions').getAttribute('aria-label'), /^All playlist positions for /);
    const expandedBox = await popup.locator('.positions').evaluate(el => ({
      client: el.clientHeight, scroll: el.scrollHeight, tabIndex: el.tabIndex,
    }));
    assert.equal(expandedBox.tabIndex, 0);
    assert.ok(expandedBox.client > 0 && expandedBox.client < 200, 'position list stays compact');
    assert.ok(expandedBox.scroll > expandedBox.client, 'full position list is scrollable');
    assert.doesNotMatch(await popup.locator('.positions').textContent(), /more/);
    assert.match(await popup.locator('.positions').textContent(), /6,000$/);
    const expandedHeight = await popup.evaluate(() => document.scrollingElement.scrollHeight);
    assert.ok(expandedHeight - heights < 100, 'expanded group must not add thousands of pixels');
    await popup.screenshot({ path: 'artifacts/ui-one-group-expanded.png' });
    await popup.locator('.positions').focus();
    await popup.keyboard.press('PageDown');
    await popup.waitForFunction(() => document.querySelector('.positions').scrollTop > 0);
    assert.ok(await popup.locator('.positions').evaluate(el => el.scrollTop) > 0, 'position list scrolls from the keyboard');
    await popup.getByRole('button', { name: 'Show fewer positions' }).click();
    assert.equal(await popup.locator('.more-positions').getAttribute('aria-expanded'), 'false');
    assert.equal(await popup.locator('.positions').getAttribute('tabindex'), null);
    assert.match(await popup.locator('.positions').textContent(), /…and 5,950 more/);
    assert.equal(await popup.getByRole('button', { name: 'Show all 6,000 positions' }).isVisible(), true);

    console.log(`PASS (${apiMode}): reconnect, failed-scan recovery, unknown identity coverage, numeric progress, 2,400 tracks / 1,200 groups in batches, singular remaining batch, keyboard focus, document scrolling with real wheel input at three sizes (including 300px high) and both color schemes`);
  }

  // Theme control: system default, explicit choice beats the OS, and the choice persists.
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.goto(popupUrl);
  await popup.waitForSelector('#theme-toggle');
  const themeState = () => popup.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    label: document.querySelector('#theme-toggle').textContent,
    stored: localStorage.getItem('amdf:theme:v1'),
  }));
  let theme = await themeState();
  assert.equal(theme.attr, 'auto');
  assert.equal(theme.label, 'Theme: Auto');
  assert.equal(theme.bg, '#fbfbfd');
  await popup.locator('#theme-toggle').click();
  theme = await themeState();
  assert.equal(theme.attr, 'light');
  assert.equal(theme.stored, 'light');
  assert.equal(theme.bg, '#fbfbfd');
  await popup.locator('#theme-toggle').click();
  theme = await themeState();
  assert.equal(theme.attr, 'dark');
  assert.equal(theme.stored, 'dark');
  assert.equal(theme.bg, '#19191d');
  assert.equal(await popup.locator('#theme-toggle').getAttribute('aria-label'), 'Theme: Dark. Switch to Auto.');
  // Explicit dark survives a reload and still wins on a light operating system.
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.goto(popupUrl);
  await popup.waitForSelector('#theme-toggle');
  assert.equal((await themeState()).bg, '#19191d');
  // Back to Auto, which then follows the system live in both directions.
  await popup.locator('#theme-toggle').click();
  theme = await themeState();
  assert.equal(theme.attr, 'auto');
  assert.equal(theme.stored, 'auto');
  assert.equal(theme.bg, '#fbfbfd');
  await popup.emulateMedia({ colorScheme: 'dark' });
  assert.equal((await themeState()).bg, '#19191d');
  await popup.emulateMedia({ colorScheme: 'light' });
  assert.equal((await themeState()).bg, '#fbfbfd');
  console.log('PASS: theme control defaults to Auto, explicit Light/Dark overrides the system, persists across reloads, and Auto follows the system live');

  // Large cached-scan restore: a 50,000-track / 25,000-group result set is the
  // maximum the extension can retain. Measure the first paint only; rendering
  // every batch is already covered above.
  scenarioCount++;
  const cachedGroups = Array.from({ length: 25_000 }, (_, index) => ({
    identity: `catalog:${index}`,
    name: `Cached song ${index}`,
    artist: 'Cached artist',
    positions: [index * 2 + 1, index * 2 + 2],
    copies: 2,
    extraCopies: 1,
  }));
  const cachedScan = {
    version: 1, playlistId: 'p.fixture', playlistName: 'Cached 50k playlist',
    scannedAt: Date.now(), groups: cachedGroups, unidentified: 0, totalTracks: 50_000,
    countVerified: true, modificationChecked: true, notes: 'Cached fixture data.',
    modified: '2026-10-23T00:00:00Z', revision: null,
  };
  await popup.evaluate(scan => localStorage.setItem('amdf:last-scan:v1', JSON.stringify(scan)), cachedScan);
  const restoreStarted = Date.now();
  await popup.goto(popupUrl);
  await popup.waitForFunction(() => document.querySelectorAll('#duplicate-list li').length === 50, null, { timeout: 45_000 });
  const restoreMs = Date.now() - restoreStarted;
  assert.match(await popup.locator('#results-title').textContent(), /50 of 25,000 shown/);
  assert.equal(await popup.locator('#show-more').isVisible(), true);
  assert.ok(restoreMs < 10_000, `Restoring a 25,000-group cache took ${restoreMs}ms`);
  console.log(`Render timing: restoring a 25,000-group cached scan and painting the first 50 took ${restoreMs}ms`);
  await popup.evaluate(() => localStorage.clear());
  await popup.goto(popupUrl + '?reset=1');
  await popup.waitForFunction(() => !document.querySelector('#scan').disabled);


  // Long, mixed-script, empty-artist and 6,000-position metadata renders as
  // text without horizontal overflow, keeps each name's own direction, and
  // gives the one repeated position list a bounded, keyboard-reachable view.
  await apple.evaluate(() => {
    window.scenario = 'duplicates';
    window.apiMode = 'legacy';
    window.fixtureDelay = 25;
    history.replaceState({}, '', '/us/library/playlist/p.fixture');
  });
  await popup.goto(popupUrl + '?reset=1');
  const longScan = {
    version: 1,
    playlistId: 'p.fixture',
    playlistName: 'Road trip — 日本語, العربية, e\u0301moji 🎧 and a very long playlist name that keeps going',
    scannedAt: Date.now(),
    groups: [
      { identity: 'a', name: 'Numb', artist: 'Linkin Park', positions: [1, 2, 3], copies: 3, extraCopies: 2 },
      { identity: 'b', name: '超長い曲名 '.repeat(14).trim(), artist: 'アーティスト名 '.repeat(8).trim(),
        positions: Array.from({ length: 6000 }, (_, index) => index + 4), copies: 6000, extraCopies: 5999 },
      { identity: 'c', name: 'עברית עם מילים ארוכות מאוד ושם שאפשר לקרוא', artist: 'אמן', positions: [6004, 6005], copies: 2, extraCopies: 1 },
      { identity: 'd', name: 'Zero\u200bWidth\u200bName\u200bWith\u200bMarks\u200bAnd\u200bA\u200bReally\u200bLong\u200bUnbroken\u200bToken',
        artist: '𝕬𝖗𝖙𝖎𝖘𝖙 𝖂𝖎𝖙𝖍 𝕱𝖆𝖓𝖈𝖞 𝖀𝖓𝖎𝖈𝖔𝖉𝖊', positions: [6006, 6007], copies: 2, extraCopies: 1 },
      { identity: 'e', name: 'A'.repeat(300), artist: '', positions: [6008, 6009], copies: 2, extraCopies: 1 },
    ],
    unidentified: 0,
    totalTracks: 12000,
    countVerified: true,
    modificationChecked: true,
    notes: 'Modification markers matched, but Apple provides no atomic snapshot. Avoid editing the playlist during a scan.',
    modified: '2026-10-23T00:00:00Z',
  };
  await popup.evaluate(cache => localStorage.setItem('amdf:last-scan:v1', JSON.stringify(cache)), longScan);
  await popup.goto(popupUrl);
  await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
  await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
  assert.equal(await popup.locator('#duplicate-list li').count(), 5);
  const unusual = await popup.evaluate(() => ({
    dirs: [...document.querySelectorAll('.song')].map(el => el.getAttribute('dir')),
    directions: [...document.querySelectorAll('.song')].map(el => getComputedStyle(el).direction),
    artistCounts: [...document.querySelectorAll('#duplicate-list li')].map(li => li.querySelectorAll('.artist').length),
    copyLabels: [...document.querySelectorAll('.copy-group')].map(el => el.getAttribute('aria-label')),
    scrollWidth: document.scrollingElement.scrollWidth,
    clientWidth: document.scrollingElement.clientWidth,
    unsafeElements: document.querySelectorAll('#duplicate-list img, #duplicate-list script').length,
  }));
  assert.deepEqual(unusual.dirs, ['auto', 'auto', 'auto', 'auto', 'auto']);
  assert.equal(unusual.directions[1], 'ltr');
  assert.equal(unusual.directions[2], 'rtl');
  assert.deepEqual(unusual.artistCounts, [1, 1, 1, 1, 0]);
  assert.match(unusual.copyLabels[4], /^Copy A+$/);
  assert.ok(unusual.copyLabels.every(label => !/ by $/.test(label)));
  assert.equal(unusual.scrollWidth, unusual.clientWidth);
  assert.equal(unusual.unsafeElements, 0);
  // The result title wraps rather than clipping when the popup is narrow.
  await popup.setViewportSize({ width: 300, height: 640 });
  await popup.locator('#results-search').fill('numb');
  const longTitle = await popup.locator('#results-title').evaluate(el => ({
    client: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight, text: el.textContent,
  }));
  assert.match(longTitle.text, /1 of 5 matching/);
  assert.ok(longTitle.scroll <= longTitle.client + 1);
  assert.ok(longTitle.height > 20);
  await popup.locator('#results-search').fill('');
  await popup.evaluate(() => window.scrollTo(0, 0));
  await popup.screenshot({ path: 'artifacts/ui-long-300.png', fullPage: true });
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.evaluate(() => window.scrollTo(0, 0));
  await popup.locator('#theme-toggle').click();
  assert.equal(await popup.evaluate(() => document.documentElement.dataset.theme), 'light');
  await popup.screenshot({ path: 'artifacts/ui-long-light.png', fullPage: true });
  await popup.locator('#theme-toggle').click();
  assert.equal(await popup.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await popup.screenshot({ path: 'artifacts/ui-long-dark.png', fullPage: true });
  await popup.locator('#theme-toggle').click();
  assert.equal(await popup.evaluate(() => document.documentElement.dataset.theme), 'auto');

  // Text, control borders and the focus ring keep >= 4.5:1 / 3:1 contrast in
  // both themes, including the themed placeholder that native inputs otherwise
  // leave at a fixed gray that is too dim on the dark surface.
  const setTheme = async expected => {
    for (let step = 0; step < 3; step++) {
      if (await popup.evaluate(() => document.documentElement.dataset.theme) === expected) return;
      await popup.locator('#theme-toggle').click();
    }
    assert.equal(await popup.evaluate(() => document.documentElement.dataset.theme), expected);
  };
  const contrast = () => popup.evaluate(() => {
    const parse = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const channel = value => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    const luminance = rgb => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    const ratio = (first, second) =>
      (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);
    const background = node => {
      for (let current = node; current; current = current.parentElement) {
        const value = getComputedStyle(current).backgroundColor;
        if (!/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(value)) return parse(value);
      }
      return [255, 255, 255];
    };
    const text = (selector, pseudo = null) => {
      const node = document.querySelector(selector);
      return ratio(parse(getComputedStyle(node, pseudo).color), background(node));
    };
    const page = background(document.body);
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const accent = parse(getComputedStyle(probe).color);
    probe.remove();
    return {
      muted: text('#status-detail'),
      placeholder: text('#results-search', '::placeholder'),
      positions: text('.positions'),
      count: text('.counts'),
      copy: text('.copy-group'),
      button: ratio(parse(getComputedStyle(document.querySelector('#scan')).color),
        parse(getComputedStyle(document.querySelector('#scan')).backgroundColor)),
      controlBorder: ratio(parse(getComputedStyle(document.querySelector('#results-search')).borderTopColor), page),
      focusRing: ratio(accent, page),
    };
  });
  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    const values = await contrast();
    for (const key of ['muted', 'placeholder', 'positions', 'count', 'copy', 'button']) {
      assert.ok(values[key] >= 4.5, `${theme} ${key} contrast ${values[key].toFixed(2)}:1`);
    }
    assert.ok(values.controlBorder >= 3, `${theme} control border contrast ${values.controlBorder.toFixed(2)}:1`);
    assert.ok(values.focusRing >= 3, `${theme} focus ring contrast ${values.focusRing.toFixed(2)}:1`);
  }
  await setTheme('auto');
  // Forced-colors strips the filled action background; the block buttons keep a
  // visible system border so the primary action stays recognizable.
  await popup.emulateMedia({ forcedColors: 'active' });
  const highContrast = await popup.evaluate(() => {
    const border = selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { width: style.borderTopWidth, style: style.borderTopStyle };
    };
    return { scan: border('#scan'), clear: border('#clear-results') };
  });
  for (const action of [highContrast.scan, highContrast.clear]) {
    assert.equal(action.style, 'solid');
    assert.ok(parseFloat(action.width) >= 1);
  }
  await popup.screenshot({ path: 'artifacts/ui-forced-colors.png', fullPage: true });
  await popup.emulateMedia({ forcedColors: 'none' });
  console.log('PASS: long/mixed-script names wrap without overflow or unsafe markup, RTL names keep direction, empty artists are skipped, and text/placeholder/controls/focus contrast passes in both themes with a forced-colors boundary');

  // Pop-out window: a fresh page targets the originating tab and hides the button.
  await apple.evaluate(() => {
    window.scenario = 'duplicates';
    history.replaceState({}, '', '/us/library/playlist/p.fixture');
  });
  await popup.goto(popupUrl + '?reset=1');
  await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
  assert.equal(await popup.locator('#pop-out').isVisible(), true);
  assert.equal(await popup.locator('#popout-separator').isVisible(), true);
  await popup.locator('#pop-out').click();
  const created = await popup.evaluate(() => window.__createdWindow);
  assert.ok(created, 'pop-out should create a window');
  assert.match(created.url, /popup\.html\?tab=1$/);
  assert.equal(created.width, 400);
  await popup.goto(created.url);
  await popup.waitForFunction(() => document.querySelector('#playlist-name').textContent.includes('My playlist'));
  assert.equal(await popup.locator('#pop-out').isVisible(), false);
  assert.equal(await popup.locator('#popout-separator').isVisible(), false);
  assert.equal(await popup.locator('#scan').textContent(), 'Scan for Duplicates');
  console.log('PASS: pop-out opens the popup in its own window pinned to the originating tab');

  assert.deepEqual([...requestOrigins].sort(), ['https://duplicate-finder.test', 'https://music.apple.com'],
    'the popup and fixtures must not contact any other origin');
  assert.deepEqual(pageErrors, []);
  console.log(`PASS: ${scenarioCount} UI fixture scenarios across both API versions; no popup runtime exceptions`);
  console.log('UNVERIFIED by fixtures: installation/activeTab (covered separately by test:extension), live Apple Music, branded Chrome/Edge');
} finally {
  await browser?.close();
}
