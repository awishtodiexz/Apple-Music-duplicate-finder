import { fixture } from './fixtures/player.mjs';
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
  context.setDefaultTimeout(15_000);
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
  await popup.addInitScript(() => {
    window.chrome = {
      tabs: { query: async () => [{ id: 1, url: await window.readPlayerUrl() }] },
      scripting: { executeScript: async ({ target, world, func, args }) => {
        if (world !== 'MAIN' || target.tabId !== 1 || target.frameIds[0] !== 0) throw new Error('Unexpected injection');
        return [{ frameId: 0, result: await window.executeInPlayer({ functionSource: func.toString(), request: args[0] }) }];
      } },
    };
  });
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
        history.replaceState({}, '', path);
      }, { scenario, path, apiMode });
      await popup.goto(popupUrl);
    }
    async function scan() {
      await popup.locator('#scan').click();
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    }
    for (const scenario of ['duplicates', 'mixed']) {
      await open(scenario);
      await popup.getByRole('button', { name: 'Scan for Duplicates' }).waitFor({ state: 'visible' });
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
      assert.equal(await popup.locator('#playlist-name').textContent(), '<img src=x onerror=alert(1)> My playlist');
      assert.equal(await popup.locator('img').count(), 0);
      await popup.locator('#scan').click();
      await popup.getByRole('heading', { name: 'Scanning playlist…', exact: true }).waitFor();
      await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
      assert.equal(await popup.locator('#status-title').textContent(), 'Scan complete');
      assert.match(await popup.locator('#status-detail').textContent(), /245 songs scanned\n1 song appears more than once/);
      assert.equal(await popup.locator('#duplicate-list li').count(), 1);
      assert.equal(await popup.locator('.positions').textContent(), 'Playlist positions: 1, 101, 245');
      assert.equal(await popup.locator('.song').textContent(), 'Numb');
      assert.equal(await popup.locator('.artist').textContent(), 'Linkin Park');
      assert.equal(await popup.locator('.counts').textContent(), 'This song appears 3 times');
      const paths = await apple.evaluate(() => window.requests);
      assert.equal(paths.length, 6); // initial metadata + before + 3 track pages + after
      assert.ok(paths.every(path => /^\/v1\/me\/library\/playlists\/p\.fixture(?:\/tracks\?|$)/.test(path)));
      await mkdir('artifacts', { recursive: true });
      await popup.screenshot({ path: 'artifacts/popup-results.png', fullPage: true });
    }
    console.log(`PASS (${apiMode}): bundled UI and serialized MAIN function through Chrome-API adapter, 245-track pagination, mixed identifiers, progress, results, safe text rendering`);

    for (const scenario of ['empty', 'distinct']) {
      await open(scenario);
      await scan();
      assert.equal(await popup.locator('#status-title').textContent(), 'No exact duplicates found');
      assert.equal(await popup.locator('#results').isVisible(), false);
    }
    console.log(`PASS (${apiMode}): empty and no-duplicates popup states`);

    for (const [scenario, message] of [
      ['rate', /limiting requests/], ['network', /could not be reached/],
      ['malformed', /unexpected response/], ['incomplete', /incomplete or changed/], ['navigate', /playlist changed/],
      ['expired', /Sign in/], ['resolvedError', /Sign in/],
    ]) {
      await open(scenario);
      await scan();
      assert.equal(await popup.locator('#status-title').textContent(), 'Scan failed');
      assert.match(await popup.locator('#status-detail').textContent(), message);
      assert.equal(await popup.locator('#results').isVisible(), false);
      assert.equal(await popup.locator('#duplicate-list li').count(), 0);
    }
    console.log(`PASS (${apiMode}): rate limit, expired session, later network failure, malformed page, incomplete scan, navigation rejection`);

    for (const [scenario, path, message] of [
      ['auth', '/us/library/playlist/p.fixture', /Sign in/],
      ['unavailable', '/us/library/playlist/p.fixture', /MusicKit instance is unavailable/],
      ['duplicates', '/us/browse', /Open a playlist/],
    ]) {
      await open(scenario, path);
      await popup.getByRole('heading', { name: 'Could not connect' }).waitFor();
      assert.match(await popup.locator('#status-detail').textContent(), message);
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
    await apple.evaluate(() => { window.fixtureDelay = 200; });
    await popup.locator('#scan').click();
    await popup.waitForFunction(() => document.querySelector('#scan-progress').value === 100);
    assert.equal(await popup.locator('#scan').isDisabled(), true);
    assert.equal(await popup.locator('#scan-progress').getAttribute('max'), '245');
    await popup.waitForFunction(() => !document.querySelector('#scan').disabled);
    assert.equal(await popup.locator('#scan-progress').isVisible(), false);

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
    assert.doesNotMatch(await popup.locator('#status-detail').textContent(), /copies|extra|groups/);
    await popup.locator('#show-more').click();
    assert.equal(await popup.locator('#duplicate-list li').count(), 100);
    assert.equal(await popup.locator('#results-scroll').evaluate(el => el.contains(document.activeElement)), true);
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
    // All groups remain accessible in order; the final batch removes the button.
    while (await popup.locator('#show-more').isVisible()) await popup.locator('#show-more').click();
    assert.equal(await popup.locator('#duplicate-list li').count(), 1200);
    assert.equal(await popup.locator('.positions').last().textContent(), 'Playlist positions: 1,200, 2,400');
    assert.equal(await popup.locator('#results-scroll').evaluate(el => el === document.activeElement), true);
    console.log(`PASS (${apiMode}): reconnect, failed-scan recovery, unknown identity coverage, numeric progress, 2,400 tracks / 1,200 groups in batches, keyboard focus, document scrolling with real wheel input at three sizes (including 300px high) and both color schemes`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`PASS: ${scenarioCount} UI fixture scenarios across both API versions; no popup runtime exceptions`);
  console.log('UNVERIFIED by fixtures: installation/activeTab (covered separately by test:extension), live Apple Music, branded Chrome/Edge');
} finally {
  await browser?.close();
}
