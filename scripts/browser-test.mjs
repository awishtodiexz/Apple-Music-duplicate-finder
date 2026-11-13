import { fixture } from './fixtures/player.mjs';
import { auditAccessibility } from './a11y-audit.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Position lists glue each separator to the position before it with a no-break space.
const plain = text => text.replace(/\u00a0/g, ' ');
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
        setBadgeText: async ({ text, tabId }) => { window.__badge = text; window.__badgeTabId = tabId; },
        setBadgeBackgroundColor: async ({ tabId }) => { window.__badgeColorTabId = tabId; },
      },
      windows: { create: async options => { window.__createdWindow = options; return {}; } },
      tabs: {
        query: async () => [{ id: 1, url: await window.readPlayerUrl() }],
        get: async id => ({ id, url: await window.readPlayerUrl() }),
        onUpdated: { addListener: listener => (window.__tabUpdated ??= []).push(listener) },
        onRemoved: { addListener: listener => (window.__tabRemoved ??= []).push(listener) },
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
  // The toolbar popup is always 380px wide. Only the pop-out window can be narrower, and
  // popup.ts marks it with data-window. Narrow viewports here stand in for that window.
  const resizePopup = async (page, viewport) => {
    await page.setViewportSize(viewport);
    await page.evaluate(narrow => {
      if (narrow) document.documentElement.dataset.window = 'pop-out';
      else if (!new URLSearchParams(location.search).has('tab')) delete document.documentElement.dataset.window;
    }, viewport.width < 380);
  };
  // Records what a screen reader is told (the announcer) and every status detail with the bar beside it.
  const recordStatus = page => page.evaluate(() => {
    window.__announced = [];
    window.__details = [];
    const bar = document.querySelector('#scan-progress');
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) window.__announced.push(node.textContent);
    }).observe(document.querySelector('#status-announcer'), { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => window.__details.push({
      text: document.querySelector('#status-detail').textContent,
      value: bar.hasAttribute('value') ? bar.value : null, max: bar.max,
    })).observe(document.querySelector('#status-detail'), { childList: true, characterData: true, subtree: true });
  });
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
      await popup.getByRole('button', { name: 'Scan for duplicates', exact: true }).waitFor({ state: 'visible' });
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
      assert.equal(await popup.locator('#version').textContent(), `v${manifest.version}`);
      if (scenario === 'duplicates') await assertAccessible(popup, `${apiMode} ready state`);
      assert.equal(await popup.locator('#status-code').isVisible(), false);
      assert.equal(await popup.locator('#playlist-name').textContent(), '<img src=x onerror=alert(1)> My playlist');
      assert.equal(await popup.locator('img').count(), 0);
      await recordStatus(popup);
      await popup.locator('#scan').click();
      await popup.getByRole('heading', { name: 'Scanning playlist…', exact: true }).waitFor();
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
      assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
      // The start is announced even though "Ready to scan" was announced moments before; each
      // phase is announced once, and the per-page progress in between is not.
      const announced = await popup.evaluate(() => window.__announced);
      assert.deepEqual(announced.map(text => /^(Scanning playlist|Checking playlist|Scan complete)/.exec(text)?.[1]),
        ['Scanning playlist', 'Checking playlist', 'Scan complete']);
      assert.match(announced[0], /Connecting to Apple Music…/);
      assert.match(await popup.locator('#status-detail').textContent(), /245 songs checked · 1 repeated song · 2 extra copies/);
      // Progress is visual; only phase changes reach the dedicated announcer.
      assert.equal(await popup.locator('#status').getAttribute('aria-live'), null);
      await popup.waitForFunction(() => /Scan complete/.test(document.querySelector('#status-announcer').textContent));
      assert.equal(await popup.locator('#duplicate-list li').count(), 1);
      assert.equal(plain(await popup.locator('.positions').textContent()), 'Playlist positions: #1 keep · #101 · #245');
      assert.equal(await popup.locator('.song').textContent(), 'Numb');
      assert.equal(await popup.locator('.artist').textContent(), 'Linkin Park');
      assert.equal(await popup.locator('.counts').textContent(), '3 copies · 2 extra');
      assert.equal(plain(await popup.locator('.keep').textContent()), '#1 keep ·');
      assert.equal(plain(await popup.locator('.extras').textContent()), ' #101 · #245');
      // The matching rule is always on screen next to the results heading, and no row is flagged.
      assert.match(await popup.locator('#results-note').textContent(), /Apple Music ID.*not title.*first position/);
      assert.equal(await popup.locator('#results-note').isVisible(), true);
      assert.equal(await popup.locator('.lookalike').count(), 0);
      // The document scrolls; the list area is neither a tab stop nor a region.
      assert.equal(await popup.locator('#results-scroll').getAttribute('tabindex'), null);
      assert.equal(await popup.locator('#results-scroll').getAttribute('role'), null);
      assert.deepEqual(await popup.evaluate(() => ['body > header', 'body > main', 'body > footer']
        .map(selector => document.querySelectorAll(selector).length)), [1, 1, 1], 'header, main and footer are sibling landmarks');
      assert.equal(await popup.getByRole('banner').count(), 1);
      assert.equal(await popup.getByRole('contentinfo').count(), 1);
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
    assert.equal(plain(await popup.locator('.positions').textContent()), 'Playlist positions: #1 keep · #101 · #245');
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
    // Minimum-copies filter hides smaller groups, including the count wording in the title.
    await popup.locator('#results-min').selectOption('4');
    assert.equal(await popup.locator('#results-title').textContent(), 'Repeated songs · 0 of 1 matching');
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
    assert.equal(await popup.locator('#copy-results').textContent(), 'Copy all 1');
    assert.equal(await popup.locator('#download-results').textContent(), 'CSV (1)');
    await popup.getByRole('button', { name: 'Copy all 1 repeated song', exact: true }).click();
    await popup.waitForFunction(() => Boolean(window.__copiedResults));
    const copied = await popup.evaluate(() => window.__copiedResults);
    assert.match(copied, /Numb — Linkin Park — 3 copies — positions 1, 101, 245/);
    assert.equal(await popup.locator('#results-feedback').textContent(), 'Copied all 1 song.');

    // Per-group copy carries only that song's positions.
    await popup.evaluate(() => { window.__copiedResults = null; });
    await popup.getByRole('button', { name: 'Copy Numb by Linkin Park' }).click();
    await popup.waitForFunction(() => Boolean(window.__copiedResults));
    const copiedGroup = await popup.evaluate(() => window.__copiedResults);
    assert.equal(copiedGroup, 'Numb — Linkin Park\n3 copies · positions 1, 101, 245');
    // The confirmation is on the row's own button, announced, and never written above the list.
    const rowCopy = popup.locator('.copy-group');
    assert.equal(await rowCopy.textContent(), 'Copied');
    assert.equal(await rowCopy.getAttribute('aria-label'), 'Copied Numb by Linkin Park');
    assert.equal(await popup.locator('#results-announcer').textContent(), 'Copied Numb by Linkin Park.');
    assert.equal(await popup.locator('#results-feedback').textContent(), 'Copied all 1 song.', 'a row copy leaves the list feedback alone');
    await popup.waitForFunction(() => document.querySelector('.copy-group').textContent === 'Copy', null, { timeout: 5_000 });
    assert.equal(await rowCopy.getAttribute('aria-label'), 'Copy Numb by Linkin Park');

    const downloadPromise = popup.waitForEvent('download');
    await popup.getByRole('button', { name: 'Download CSV (1) of all repeated songs', exact: true }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^apple-music-duplicates-.*\.csv$/);
    const downloadPath = await download.path();
    assert.ok(downloadPath);
    const csv = await readFile(downloadPath, 'utf8');
    assert.match(csv, /Song,Artist,Copies,Extra copies,Positions\r\nNumb,Linkin Park,3,2,1 101 245/);
    assert.equal(csv.charCodeAt(0), 0xFEFF); // Excel-friendly UTF-8 BOM
    assert.equal(await popup.locator('#results-feedback').textContent(), 'Downloaded all 1 song as CSV.');
    // Changing the filters retires feedback about a list that is gone.
    await popup.locator('#results-sort').selectOption('copies');
    assert.equal(await popup.locator('#results-feedback').textContent(), '');
    await popup.getByRole('button', { name: 'Copy all 1 repeated song', exact: true }).click();
    await popup.waitForFunction(() => document.querySelector('#results-feedback').textContent !== '');
    await popup.locator('#results-min').selectOption('4');
    assert.equal(await popup.locator('#results-feedback').textContent(), '');
    await popup.locator('#results-min').selectOption('2');
    await popup.locator('#results-sort').selectOption('playlist');

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
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'results-search');
    await popup.keyboard.press('Escape');
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'results-title', 'a second Escape must not drop focus onto the body');
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
    await popup.waitForFunction(() => /Scan again to refresh/.test(document.querySelector('#status-detail').textContent));
    assert.match(await popup.locator('#status-detail').textContent(), /Scanned .*Scan again to refresh/);

    // A changed modification marker marks the cached scan as stale.
    await apple.evaluate(() => { window.scenario = 'edited'; });
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => /changed since this scan/.test(document.querySelector('#status-detail').textContent));
    assert.match(await popup.locator('#status-detail').textContent(), /Scanned .*The playlist changed since this scan\. Scan again to refresh\./);

    // Without a marker on either side, freshness is unknown and says so instead of claiming it is current.
    await apple.evaluate(() => { window.scenario = 'noMarker'; });
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => /Could not check whether the playlist changed since then\./.test(document.querySelector('#status-detail').textContent));
    assert.doesNotMatch(await popup.locator('#status-detail').textContent(), /Scan again to refresh/);
    assert.equal(await popup.locator('#scan').textContent(), 'Scan again');

    // Cached results stay visible when MusicKit is unavailable.
    await apple.evaluate(() => { window.scenario = 'unavailable'; });
    await popup.goto(popupUrl);
    await popup.getByRole('heading', { name: 'Showing last scan' }).waitFor();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    await popup.waitForFunction(() => document.querySelector('#status-code').textContent === 'Error code: MUSICKIT_UNAVAILABLE');
    // The cached summary keeps its place; the failure sits in its own error element and names the button.
    assert.equal(await popup.locator('#status-title').textContent(), 'Showing last scan');
    assert.equal(await popup.locator('#status').getAttribute('data-error'), 'false');
    assert.match(await popup.locator('#status-detail').textContent(), /Scanned /);
    assert.doesNotMatch(await popup.locator('#status-detail').textContent(), /finished loading/);
    assert.equal(await popup.locator('#status-problem').isVisible(), true);
    assert.equal(await popup.locator('#status-problem').getAttribute('data-error'), 'true');
    assert.match(await popup.locator('#status-problem').textContent(), /hasn't finished loading.*Retry connection/);
    assert.equal(await popup.locator('#status-code').textContent(), 'Error code: MUSICKIT_UNAVAILABLE');
    assert.equal(await popup.locator('#scan').textContent(), 'Retry connection');
    await assertAccessible(popup, `${apiMode} last scan with a connection error`);
    // Reconnecting after the player recovers keeps the cache and enables a rescan.
    await apple.evaluate(() => { window.scenario = 'duplicates'; });
    await popup.locator('#scan').click();
    await popup.waitForFunction(() => document.querySelector('#scan').textContent === 'Scan again');
    assert.match(await popup.locator('#status-detail').textContent(), /Scan again to refresh/);
    assert.equal(await popup.locator('#status-problem').isVisible(), false);

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
    assert.equal(await popup.locator('#scan').textContent(), 'Scan for duplicates');
    assert.equal(await popup.evaluate(() => localStorage.getItem('amdf:last-scan:v1')), null);
    console.log(`PASS (${apiMode}): copy (all and per song), CSV with BOM, minimum-copies filter, keyboard search, filter reset, toolbar badge, scan-again label, stale-cache notice, cached last scan, and explicit clear`);

    // A failed rescan must not replace the last successful result: keep the
    // completed result, badge and Clear action, and label them as previous results.
    await open('duplicates');
    await scan();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    await recordStatus(popup);
    await apple.evaluate(() => { window.scenario = 'network'; });
    await scan();
    // A slow request says so before it waits, with the songs already retrieved, and the bar agrees with the text.
    const details = await popup.evaluate(() => window.__details);
    for (const attempt of [1, 2]) {
      assert.ok(details.some(({ text }) => text.startsWith(`Apple Music is slow to respond. Retrying (${attempt} of 2)…\n100 of 245 songs retrieved`)),
        `retry ${attempt} was shown with its progress`);
    }
    const countLine = /^(?:Apple Music is slow to respond\. Retrying \(\d of 2\)…\n)?([\d,]+) of ([\d,]+) songs retrieved/;
    for (const { text, value, max } of details) {
      const counted = countLine.exec(text);
      if (counted) assert.deepEqual([value, max], [Number(counted[1].replace(/,/g, '')), Number(counted[2].replace(/,/g, ''))], text);
    }
    assert.ok((await popup.evaluate(() => window.__announced)).some(text => text.includes('Retrying (1 of 2)')), 'a retry is announced');
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
    assert.match(await popup.locator('#status-detail').textContent(), /could not be reached/);
    assert.match(await popup.locator('#status-detail').textContent(), /Showing your last scan from/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(plain(await popup.locator('.positions').textContent()), 'Playlist positions: #1 keep · #101 · #245');
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
    assert.match(await popup.locator('#status-detail').textContent(), /Showing your last scan from/);
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
    await popup.getByRole('button', { name: 'Copy all 1 repeated song', exact: true }).click();
    await popup.waitForFunction(() => Boolean(window.__copiedResults));
    assert.match(await popup.evaluate(() => window.__copiedResults),
      /^Apple Music Duplicate Finder — <img src=x onerror=alert\(1\)> My playlist/);
    const cachedDownloadPromise = popup.waitForEvent('download');
    await popup.getByRole('button', { name: 'Download CSV (1) of all repeated songs', exact: true }).click();
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
    await popup.waitForFunction(() => document.querySelector('#scan').textContent === 'Scan for duplicates');
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
    await popup.waitForFunction(() => /Scan again to refresh/.test(document.querySelector('#status-detail').textContent));
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

    // The badge belongs to the scanned tab, not to every tab in the browser.
    await open('duplicates');
    await scan();
    assert.equal(await popup.evaluate(() => window.__badge), '1');
    assert.equal(await popup.evaluate(() => window.__badgeTabId), 1);
    assert.equal(await popup.evaluate(() => window.__badgeColorTabId), 1);

    // A long-open window must not use connect-time metadata as the scan baseline:
    // an edit made before Scan is not a change during the scan.
    await open('duplicates');
    await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    await apple.evaluate(() => { window.scenario = 'edited'; window.requests = []; });
    await popup.evaluate(() => { const real = Date.now; Date.now = () => real() + 120_000; });
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
    // Fresh baseline metadata + 3 track pages + validation metadata.
    assert.equal((await apple.evaluate(() => window.requests)).length, 5);
    await apple.evaluate(() => { window.scenario = 'duplicates'; });

    // A rescan keeps the previous results, search and sort visible until it
    // completes, and keyboard focus moves Scan -> Cancel -> Scan.
    await open('duplicates');
    await scan();
    await popup.locator('#results-search').fill('numb');
    await popup.locator('#results-sort').selectOption('copies');
    await apple.evaluate(() => { window.requests = []; window.fixtureDelay = 600; });
    await popup.locator('#scan').focus();
    await popup.keyboard.press('Enter');
    await popup.waitForFunction(() => !document.querySelector('#cancel').hidden);
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'cancel');
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.locator('#results').getAttribute('aria-busy'), 'true');
    assert.equal(await popup.locator('#clear-results').isDisabled(), true);
    await apple.evaluate(() => { window.fixtureDelay = 25; });
    await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'scan');
    assert.equal(await popup.locator('#results-search').inputValue(), 'numb');
    assert.equal(await popup.locator('#results-sort').inputValue(), 'copies');
    assert.equal(await popup.locator('#results').getAttribute('aria-busy'), null);
    assert.equal(await popup.locator('#clear-results').isDisabled(), false);
    // Cancelling from the keyboard returns focus to Scan instead of the body.
    await apple.evaluate(() => { window.requests = []; window.fixtureDelay = 600; });
    await popup.locator('#scan').focus();
    await popup.keyboard.press('Enter');
    await popup.waitForFunction(() => document.activeElement?.id === 'cancel');
    await apple.waitForFunction(() => window.requests.some(path => path.includes('/tracks?')));
    await popup.keyboard.press('Enter');
    await popup.getByRole('heading', { name: 'Scan cancelled', exact: true }).waitFor();
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'scan');
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.equal(await popup.locator('#results-search').inputValue(), 'numb');
    await apple.evaluate(() => { window.fixtureDelay = 25; });
    console.log(`PASS (${apiMode}): per-tab badge, fresh scan baseline after a long-open window, previous results and filters kept during rescan, Scan/Cancel focus handoff`);

    for (const [scenario, title, detail] of [
      ['empty', 'This playlist is empty', /^There are no songs to check\.\nScanned /],
      ['distinct', 'No repeated songs', /^245 songs checked · no repeats found\nScanned /],
    ]) {
      await open(scenario);
      await scan();
      assert.equal(await popup.locator('#status-title').textContent(), title);
      assert.match(await popup.locator('#status-detail').textContent(), detail);
      assert.equal(await popup.locator('#status').getAttribute('data-error'), 'false');
      assert.equal(await popup.locator('#results').isVisible(), false);
      assert.equal(await popup.locator('#scan').textContent(), 'Scan again');
      // An empty playlist has nothing to clear; a checked one keeps its saved scan.
      assert.equal(await popup.locator('#clear-results').isVisible(), scenario !== 'empty');
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
      ['internal', /Something went wrong in the extension/, 'INTERNAL'],
      ['malformed', /unexpected response/, 'FORMAT'], ['incomplete', /response changed or did not add up/, 'INCOMPLETE'],
      ['truncated', /response changed or did not add up/, 'INCOMPLETE'],
      ['navigate', /playlist or tab changed/, 'PAGE_CHANGED'],
      ['expired', /Sign in/, 'AUTH'], ['resolvedError', /Sign in/, 'AUTH'],
    ]) {
      await open(scenario);
      await scan();
      assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
      assert.match(await popup.locator('#status-detail').textContent(), message);
      assert.equal(await popup.locator('#status-code').textContent(), `Error code: ${code}`);
      const sourceRetained = ['rate', 'network', 'internal', 'malformed', 'incomplete', 'truncated'].includes(scenario);
      const retryLabel = sourceRetained ? 'Retry scan' : 'Retry connection';
      assert.equal(await popup.locator('#scan').textContent(), retryLabel);
      // The message names the button the popup actually offers.
      assert.ok((await popup.locator('#status-detail').textContent()).includes(retryLabel), `${scenario} message names ${retryLabel}`);
      assert.equal(await popup.locator('#results').isVisible(), false);
      assert.equal(await popup.locator('#duplicate-list li').count(), 0);
      if (scenario === 'network') await assertAccessible(popup, `${apiMode} error state`);
    }
    console.log(`PASS (${apiMode}): rate limit, expired session, later network failure, malformed page, truncated continuation, incomplete scan, navigation rejection`);

    for (const [scenario, message, code] of [
      ['auth', /Sign in/, 'AUTH'],
      ['unavailable', /hasn't finished loading/, 'MUSICKIT_UNAVAILABLE'],
    ]) {
      await open(scenario);
      await popup.getByRole('heading', { name: 'Could not connect' }).waitFor();
      assert.match(await popup.locator('#status-detail').textContent(), message);
      assert.equal(await popup.locator('#status').getAttribute('data-error'), 'true');
      assert.equal(await popup.locator('#status-code').textContent(), `Error code: ${code}`);
      assert.equal(await popup.locator('#scan').isDisabled(), false);
      assert.equal(await popup.locator('#scan').textContent(), 'Retry connection');
      assert.match(await popup.locator('#status-detail').textContent(), /Retry connection/);
      assert.equal(await popup.locator('#playlist-name').textContent(), 'Playlist unavailable');
    }

    // Not being on a playlist is not a failure: a neutral state with nothing to retry.
    await open('duplicates', '/us/browse');
    await popup.getByRole('heading', { name: 'Open a playlist', exact: true }).waitFor();
    assert.match(await popup.locator('#status-detail').textContent(), /^Open a playlist on music\.apple\.com, then open the extension again\.$/);
    assert.equal(await popup.locator('#status').getAttribute('data-error'), 'false');
    assert.equal(await popup.locator('#status-code').textContent(), 'Error code: NOT_PLAYLIST');
    assert.equal(await popup.locator('#scan').isVisible(), false);
    assert.equal(await popup.locator('#playlist-name').textContent(), 'No playlist open');
    assert.equal(await popup.getByRole('button', { name: /Retry|Scan/ }).count(), 0);
    await assertAccessible(popup, `${apiMode} non-playlist state`);
    console.log(`PASS (${apiMode}): sign-in, unavailable MusicKit, and non-playlist states`);

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
    assert.equal(plain(await popup.locator('.positions').textContent()), 'Playlist positions: #1 keep · #101 · #245');

    await open('unknown');
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Nothing could be checked');
    // The summary line already says the songs were skipped; no second note repeats it.
    assert.match(await popup.locator('#status-detail').textContent(), /^245 songs had no Apple Music ID, so repeats could not be checked\.\nScanned [^\n]+\.$/);
    assert.equal(await popup.locator('#scan').textContent(), 'Scan again');

    await open('noMarker');
    await scan();
    assert.match(await popup.locator('#scan-notes').textContent(), /edits that keep the song count the same cannot be detected/);

    // Over the limit is known when the popup connects, so it never offers a scan that cannot work.
    await open('huge');
    await popup.getByRole('heading', { name: 'Playlist too large to scan', exact: true }).waitFor();
    assert.match(await popup.locator('#status-detail').textContent(), /larger than the extension can scan/);
    assert.equal(await popup.locator('#status').getAttribute('data-error'), 'false');
    assert.equal(await popup.locator('#status-code').textContent(), 'Error code: LIMIT');
    assert.equal(await popup.locator('#scan').isVisible(), false);
    assert.equal(await popup.locator('#playlist-name').textContent(), '<img src=x onerror=alert(1)> My playlist');
    assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    assert.equal((await apple.evaluate(() => window.requests)).filter(path => path.includes('/tracks?')).length, 0);
    await assertAccessible(popup, `${apiMode} over-limit state`);

    // A limit hit during a scan (no total known up front) is a real failure, and retrying cannot help.
    await open('coverage');
    await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    await apple.evaluate(() => { window.scenario = 'huge'; });
    await scan();
    assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
    assert.equal(await popup.locator('#status').getAttribute('data-error'), 'true');
    assert.match(await popup.locator('#status-detail').textContent(), /larger than the extension can scan/);
    assert.equal(await popup.locator('#status-code').textContent(), 'Error code: LIMIT');
    assert.equal(await popup.locator('#scan').isVisible(), false);
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'status-title');

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
    assert.equal(plain(await popup.locator('.positions').textContent()), 'Playlist positions: #1 keep · #101 · #245');
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
    await resizePopup(popup, { width: 320, height: 480 });
    assert.match(await popup.locator('#scan-notes').textContent(), /1 song had no Apple Music ID and was skipped\./);
    assert.match(await popup.locator('#scan-notes').textContent(), /Apple Music gave no song total/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 1);
    assert.ok(await popup.locator('#results-scroll').evaluate(el => el.clientHeight > 100));
    // A clamped playlist name is a toggle for keyboard and touch, not only a mouse tooltip.
    const nameBox = popup.locator('#playlist-name');
    assert.equal(await nameBox.getAttribute('role'), 'button');
    assert.equal(await nameBox.getAttribute('aria-expanded'), 'false');
    const clamped = await nameBox.evaluate(el => el.scrollHeight > el.clientHeight + 1);
    assert.equal(clamped, true, 'the long name is cut off before it is expanded');
    await nameBox.focus();
    await popup.keyboard.press('Enter');
    assert.equal(await nameBox.getAttribute('aria-expanded'), 'true');
    assert.equal(await nameBox.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'the whole name is visible');
    await popup.keyboard.press(' ');
    assert.equal(await nameBox.getAttribute('aria-expanded'), 'false');
    await resizePopup(popup, { width: 380, height: 640 });
    assert.equal(await popup.locator('#playlist-name').getAttribute('role'), 'button', 'a clamped name stays a toggle at 380px');

    await open('many');
    await scan();
    assert.match(await popup.locator('#status-detail').textContent(), /1,200 repeated songs/);
    assert.equal(await popup.locator('#duplicate-list li').count(), 50);
    assert.equal(await popup.locator('.counts').first().textContent(), '2 copies · 1 extra');
    assert.equal(await popup.locator('#show-more').textContent(), 'Show 50 more songs');
    assert.equal(await popup.locator('#show-all').textContent(), 'Show all 1,200');
    assert.equal(await popup.locator('#show-all').getAttribute('aria-label'), 'Show all 1,200 repeated songs');
    // Copy and CSV export every match, so their labels carry the filtered total, not the 50 drawn rows.
    assert.equal(await popup.locator('#copy-results').textContent(), 'Copy all 1,200');
    assert.equal(await popup.locator('#copy-results').getAttribute('aria-label'), 'Copy all 1,200 repeated songs');
    assert.equal(await popup.locator('#download-results').textContent(), 'CSV (1,200)');
    assert.equal(await popup.locator('#download-results').getAttribute('aria-label'), 'Download CSV (1,200) of all repeated songs');
    // Compact results: the list starts near the top, three rows fit, and a one-line row is short.
    const compact = await popup.evaluate(() => {
      window.scrollTo(0, 0);
      const rows = [...document.querySelectorAll('#duplicate-list li')];
      return { firstRowTop: rows[0].getBoundingClientRect().top, oneLineRow: rows[1].getBoundingClientRect().height,
        complete: rows.filter(row => row.getBoundingClientRect().bottom <= innerHeight).length,
        oneLine: rows[1].querySelector('.song').getBoundingClientRect().height < 24 };
    });
    assert.ok(compact.firstRowTop <= 300, `first row starts at ${compact.firstRowTop}px`);
    assert.ok(compact.oneLine && compact.oneLineRow <= 64, `a one-line row is ${compact.oneLineRow}px tall`);
    assert.ok(compact.complete >= 3, `${compact.complete} complete rows fit in the viewport`);
    await assertAccessible(popup, `${apiMode} many results`);
    assert.match(await popup.locator('#status-detail').textContent(), /1,200 extra copies/);
    assert.equal(await popup.locator('#status-detail').textContent(), '2,400 songs checked · 1,200 repeated songs · 1,200 extra copies');
    // Different songs that share a title and artist say so, and show the Apple Music ID that tells them apart.
    await popup.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async text => { window.__copiedResults = text; } },
      });
    });
    await popup.locator('#results-search').fill('Numb');
    assert.equal(await popup.locator('#duplicate-list li').count(), 3);
    assert.deepEqual(await popup.locator('.lookalike').allTextContents(), [
      'Different Apple Music song, same title · Apple Music ID 1000',
      'Different Apple Music song, same title · Apple Music ID 1100',
      'Different Apple Music song, same title · Apple Music ID 1244',
    ]);
    assert.match(await popup.locator('#results-title').textContent(), /3 of 1,200 matching/);
    assert.equal(await popup.locator('#copy-results').textContent(), 'Copy all 3');
    assert.equal(await popup.locator('#copy-results').getAttribute('aria-label'), 'Copy all 3 matching repeated songs');
    assert.equal(await popup.locator('#download-results').getAttribute('aria-label'), 'Download CSV (3) of matching repeated songs');
    await popup.locator('#copy-results').click();
    await popup.waitForFunction(() => document.querySelector('#results-feedback').textContent === 'Copied 3 matching songs.');
    assert.equal((await popup.evaluate(() => window.__copiedResults)).trim().split('\n').filter(line => /^Numb — /.test(line)).length, 3);
    // Feedback about this filtered list must not outlive it, or "Copied 3 songs" would sit above an empty or full list.
    await popup.locator('#results-search').fill('no such song');
    assert.equal(await popup.locator('#results-feedback').textContent(), '');
    await popup.locator('#results-search').fill('Numb');
    // The result title carries counts; in the narrowest pop-out window it must
    // wrap instead of clipping the matching total behind an ellipsis.
    await resizePopup(popup, { width: 240, height: 480 });
    const titleFit = await popup.locator('#results-title').evaluate(el => ({
      client: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight,
      text: el.textContent,
    }));
    assert.match(titleFit.text, /3 of 1,200 matching/);
    assert.ok(titleFit.scroll <= titleFit.client + 1, 'title must not be horizontally clipped');
    assert.ok(titleFit.height > 20, 'title should wrap to more than one line at 240px');
    await resizePopup(popup, { width: 380, height: 640 });
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
        await resizePopup(popup, viewport);
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
    await resizePopup(popup, { width: 380, height: 640 });
    await popup.emulateMedia({ colorScheme: 'light' });
    // Render the remaining batches inside the page so the measurement covers DOM
    // work rather than Playwright round trips. The generous bound only catches a
    // pathological regression; the exact rendered count is the real assertion.
    // One activation of "Show all" reaches the last group; the click includes the forced layout of
    // scrollIntoView, so the number covers real DOM and layout work.
    const showAllMs = await popup.evaluate(() => {
      const button = document.querySelector('#show-all');
      const started = performance.now();
      button.click();
      return performance.now() - started;
    });
    assert.equal(await popup.locator('#duplicate-list li').count(), 1200);
    assert.equal(plain(await popup.locator('.positions').last().textContent()), 'Playlist positions: #1,200 keep · #2,400');
    assert.equal(await popup.locator('#show-all').isVisible(), false);
    assert.equal(await popup.locator('#show-more').isVisible(), false);
    assert.equal(await popup.evaluate(() => [...document.querySelectorAll('#duplicate-list li')].indexOf(document.activeElement)), 100,
      'focus moves to the first newly shown row');
    assert.equal(await popup.locator('#results-feedback').textContent(), 'Showing 1,200 of 1,200.');
    assert.ok(showAllMs < 150, `Showing all 1,200 groups took ${showAllMs.toFixed(0)}ms`);
    console.log(`Render timing (${apiMode}): Show all drew 1,100 additional groups in one activation in ${showAllMs.toFixed(0)}ms`);
    // The controls stay reachable from the end of the list: they stick to the top of the viewport.
    await popup.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.equal(await popup.locator('#results-controls').evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.top < 24 && rect.bottom <= innerHeight;
    }), true, 'search, sort, Copy and CSV remain in view at the end of 1,200 rows');
    assert.equal(await popup.locator('#clear-results').evaluate(el => el.getBoundingClientRect().top < 300), true,
      'Clear results sits beside the scan button, not below the list');
    await popup.evaluate(() => window.scrollTo(0, 0));

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
    assert.match(await popup.locator('#status-detail').textContent(), /6,000 songs checked · 1 repeated song · 5,999 extra copies/);
    assert.match(plain(await popup.locator('.positions').textContent()), /· \+5,950 more$/);
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
    assert.ok(expandMs < 150, `Expanding 6,000 positions took ${expandMs.toFixed(0)}ms`);
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
    assert.match(plain(await popup.locator('.positions').textContent()), /· \+5,950 more$/);
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
  assert.equal(await popup.locator('#show-all').textContent(), 'Show next 2,000');
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
    notes: 'Cached fixture data.',
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
  // The result title wraps rather than clipping when the pop-out is narrow.
  await resizePopup(popup, { width: 240, height: 640 });
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
  await resizePopup(popup, { width: 380, height: 640 });
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
      extras: text('.extras'),
      keep: text('.keep'),
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
    for (const key of ['muted', 'placeholder', 'positions', 'extras', 'keep', 'count', 'copy', 'button']) {
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
  assert.equal(await popup.evaluate(() => document.documentElement.dataset.window), 'pop-out');
  assert.equal(await popup.locator('#scan').textContent(), 'Scan for duplicates');
  console.log('PASS: pop-out opens the popup in its own window pinned to the originating tab');

  // A resized or zoomed pop-out has a real narrow viewport. It must reflow, not scroll sideways.
  await popup.locator('#scan').click();
  await popup.waitForFunction(() => !document.querySelector('#scan').disabled && document.querySelector('#duplicate-list li'));
  for (const width of [400, 300, 240]) {
    await popup.setViewportSize({ width, height: 700 });
    const fit = await popup.evaluate(() => ({ body: document.body.getBoundingClientRect().width,
      client: document.scrollingElement.clientWidth, scroll: document.scrollingElement.scrollWidth }));
    assert.ok(fit.scroll <= fit.client, `pop-out at ${width}px must not scroll horizontally`);
    assert.ok(fit.body <= Math.min(380, width), `pop-out body at ${width}px fits its window and the 380px design`);
    assert.ok(fit.body >= Math.min(380, width - 20), `pop-out body at ${width}px uses the window width`);
    await popup.screenshot({ path: `artifacts/ui-popout-${width}.png` });
  }
  await popup.setViewportSize({ width: 380, height: 640 });
  console.log('PASS: pop-out reflows down to 240px without horizontal scroll');

  // An idle pop-out outlives page changes, which would have closed a toolbar popup. It follows
  // its tab through tabs.onUpdated (no extra permission): the same playlist changes nothing,
  // anything else is reported at once.
  const tabEvent = (change, tabId = 1) => popup.evaluate(
    ({ change, tabId }) => window.__tabUpdated.forEach(listener => listener(tabId, change)), { change, tabId });
  await tabEvent({ status: 'complete' });
  await popup.waitForTimeout(150);
  assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
  assert.equal(await popup.locator('#duplicate-list li').count(), 1);
  await apple.evaluate(() => history.replaceState({}, '', '/us/browse'));
  await tabEvent({ title: 'Browse' });
  await tabEvent({ status: 'complete' }, 2);
  await popup.waitForTimeout(150);
  assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete', 'title changes and other tabs are ignored');
  await tabEvent({ status: 'complete' });
  await popup.getByRole('heading', { name: 'Open a playlist', exact: true }).waitFor();
  assert.equal(await popup.locator('#status').getAttribute('data-error'), 'false');
  assert.equal(await popup.locator('#scan').isVisible(), false);
  assert.equal(await popup.locator('#duplicate-list li').count(), 0);
  assert.equal(await popup.locator('#playlist-name').textContent(), 'No playlist open');
  await tabEvent({ status: 'complete' });
  await popup.waitForTimeout(150);
  assert.equal(await popup.locator('#status-title').textContent(), 'Open a playlist', 'an unchanged non-playlist page is not reconnected');
  await apple.evaluate(() => history.replaceState({}, '', '/us/library/playlist/p.other'));
  await tabEvent({ url: 'https://music.apple.com/us/library/playlist/p.other' });
  await popup.getByRole('heading', { name: 'Ready to scan', exact: true }).waitFor();
  assert.equal(await popup.locator('#scan').textContent(), 'Scan for duplicates');
  assert.equal(await popup.locator('#duplicate-list li').count(), 0);
  await apple.evaluate(() => history.replaceState({}, '', '/us/library/playlist/p.fixture'));
  console.log('PASS: an idle pop-out notices when its tab leaves the playlist and recovers when it returns');

  assert.deepEqual([...requestOrigins].sort(), ['https://duplicate-finder.test', 'https://music.apple.com'],
    'the popup and fixtures must not contact any other origin');
  assert.deepEqual(pageErrors, []);
  console.log(`PASS: ${scenarioCount} UI fixture scenarios across both API versions; no popup runtime exceptions`);
  console.log('UNVERIFIED by fixtures: installation/activeTab (covered separately by test:extension), live Apple Music, branded Chrome/Edge');
} finally {
  await browser?.close();
}
