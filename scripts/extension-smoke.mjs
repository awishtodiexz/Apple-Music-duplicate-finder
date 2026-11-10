import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { auditAccessibility } from './a11y-audit.mjs';
import { fixture } from './fixtures/player.mjs';

// Full bundled Chromium supports headless unpacked extensions and CDP action invocation.
// No chrome.* APIs, activeTab grants, or script injection are mocked in this suite.
await mkdir('.cache', { recursive: true });
const profile = await mkdtemp(resolve('.cache/extension-profile-'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const timeoutMs = Number(process.env.AMDF_TEST_TIMEOUT_MS ?? 30_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('AMDF_TEST_TIMEOUT_MS must be at least 1000');
let context;
async function until(operation, description) {
  const deadline = Date.now() + timeoutMs;
  let lastTransient;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      // Polling a native popup can briefly race a destroyed execution context.
      // Other errors still fail immediately instead of hiding a real defect.
      if (!/Cannot find (?:default execution )?context|Execution context was destroyed|Inspected target navigated|Target closed|Session closed|No session with given id/.test(error.message)) throw error;
      lastTransient = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + description + (lastTransient ? ` (last transient error: ${lastTransient.message})` : ''));
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--disable-component-update', '--disable-background-networking'],
  });
  context.setDefaultTimeout(timeoutMs);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://music.apple.com') return route.fulfill({ contentType: 'text/html', body: fixture });
    if (url.origin === 'https://blocked.test') return route.fulfill({ contentType: 'text/html', body: '<title>Different origin</title>' });
    if (url.protocol === 'chrome-extension:') return route.continue();
    return route.abort();
  });
  const apple = context.pages()[0] ?? await context.newPage();
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve('dist') });
  assert.match(id, /^[a-p]{32}$/);
  await apple.goto('https://music.apple.com/us/library/playlist/p.fixture');
  const diagnostic = await context.newPage();
  await diagnostic.goto(`chrome-extension://${id}/popup.html`);
  const denied = await diagnostic.evaluate(async () => {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id === undefined || tab.url?.startsWith('chrome-extension:')) continue;
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true }); }
      catch { return true; }
    }
    return false;
  });
  assert.equal(denied, true);
  await diagnostic.close();
  console.log('PASS: production extension installed; injection denied before action invocation');

  // Toolbar popups are CDP "other" targets, not Playwright Page objects. Attach
  // directly so the test drives the actual popup rather than an ordinary tab.
  let sequence = 0;
  async function attach(targetId) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
    async function send(method, params = {}) {
      const messageId = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Popup CDP command timed out: ' + method)); }, timeoutMs);
        const receive = event => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== messageId) return;
          cleanup();
          if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
        };
        const cleanup = () => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); };
        cdp.on('Target.receivedMessageFromTarget', receive);
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: messageId, method, params }) })
          .catch(error => { cleanup(); reject(error); });
      });
    }
    await send('Runtime.runIfWaitingForDebugger');
    return {
      async evaluate(fn) {
        const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})()`, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error('Popup evaluation failed');
        return result.result.value;
      },
      reload: () => send('Page.reload'),
      close: () => cdp.send('Target.closeTarget', { targetId }),
    };
  }
  let activePopup;
  async function open(scenario, mode = 'v3') {
    if (!activePopup) await apple.bringToFront();
    if (activePopup) await activePopup.evaluate(() => localStorage.clear());
    await apple.evaluate(({ scenario, mode }) => {
      window.scenario = scenario; window.apiMode = mode; window.requests = []; window.fixtureDelay = 25;
      history.replaceState({}, '', '/us/library/playlist/p.fixture');
    }, { scenario, mode });
    let previousDocument;
    if (activePopup) {
      // Target.closeTarget acknowledges before Windows has necessarily destroyed
      // its native popup widget. Reopening immediately can toggle that old widget
      // instead of creating a new target. Reload this real toolbar popup between
      // fixtures, and require a new document before accepting initialization.
      previousDocument = await activePopup.evaluate(() => performance.timeOrigin);
      await activePopup.reload();
    } else {
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      const tab = targetInfos.find(target => target.url === apple.url());
      assert.ok(tab);
      await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
      const isToolbarPopup = target => {
        if (target.type !== 'other' && target.type !== 'page') return false;
        if (!target.url) return false;
        try {
          const url = new URL(target.url);
          return url.protocol === 'chrome-extension:' && url.host === id &&
            url.pathname === '/popup.html' && !url.searchParams.has('tab');
        } catch {
          return false;
        }
      };
      let target;
      try {
        target = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(isToolbarPopup),
          'actual toolbar popup target');
      } catch (error) {
        const { targetInfos: diagnosticTargets } = await cdp.send('Target.getTargets');
        throw new Error(`${error.message}; open targets: ` +
          diagnosticTargets.map(target => `${target.type}:${target.url || '(blank)'}`).join(', '));
      }
      activePopup = await attach(target.targetId);
    }
    await until(async () => {
      let state;
      try {
        state = await activePopup.evaluate(() => ({ document: performance.timeOrigin,
          title: document.querySelector('#status-title')?.textContent }));
      } catch (error) {
        if (/Cannot find (?:default execution )?context|Execution context was destroyed|Inspected target navigated|No session with given id|Session closed|Target closed/.test(error.message)) return false;
        throw error;
      }
      return state.document !== previousDocument && ['Ready to scan', 'Could not connect'].includes(state.title);
    }, 'fresh popup initialization for ' + scenario);
    assert.equal(await activePopup.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 0);
    return activePopup;
  }
  async function scan(popup) {
    assert.equal(await popup.evaluate(() => document.querySelector('#status-title').textContent), 'Ready to scan');
    await popup.evaluate(() => document.querySelector('#scan').click());
    await until(() => popup.evaluate(() => !document.querySelector('#scan').disabled), 'scan completion');
  }
  for (const mode of ['legacy', 'v3']) {
    const popup = await open('duplicates', mode);
    await scan(popup);
    assert.equal(await popup.evaluate(() => document.querySelector('#status-title').textContent), 'Scan complete');
    assert.equal(await popup.evaluate(() => document.querySelector('#version').textContent), `v${version}`);
    assert.equal(await popup.evaluate(() => document.querySelector('.positions').textContent), 'Playlist positions: 1, 101, 245');
    assert.equal(await popup.evaluate(() => document.querySelector('.counts').textContent), 'This song appears 3 times');
    assert.equal(await popup.evaluate(() => document.querySelectorAll('img').length), 0);
    // Connect metadata (reused as the scan baseline) + 3 track pages + validation metadata.
    assert.equal((await apple.evaluate(() => window.requests)).length, 5);
    assert.deepEqual(await popup.evaluate(() => chrome.runtime.getManifest().permissions), ['activeTab', 'scripting']);
    assert.equal(await popup.evaluate(() => chrome.runtime.getManifest().version), version);
    const audit = await popup.evaluate(auditAccessibility);
    assert.deepEqual(audit.findings, [], `${mode} installed popup accessibility findings:\n${audit.findings.join('\n')}`);
    assert.ok(audit.checkedControls > 0, 'installed popup must expose controls');
    console.log(`PASS (${mode}): toolbar popup, real activeTab grant, MAIN injection, pagination, safe rendering and accessibility`);
  }
  for (const [scenario, title, message] of [
    ['unavailable', 'Could not connect', /MusicKit instance is unavailable/],
    ['auth', 'Could not connect', /Sign in/], ['expired', 'Scan failed', /Sign in/],
    ['malformed', 'Scan failed', /unexpected response/], ['resolvedError', 'Scan failed', /Sign in/],
  ]) {
    const popup = await open(scenario);
    if (title === 'Scan failed') await scan(popup);
    assert.equal(await popup.evaluate(() => document.querySelector('#status-title').textContent), title);
    assert.match(await popup.evaluate(() => document.querySelector('#status-detail').textContent), message);
    assert.equal(await popup.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 0);
  }
  console.log('PASS: unavailable MusicKit, unauthorised/expired session, changed response format, no partial results');
  const popup = await open('duplicates');
  // A long in-page delay proves the popup does not wait for the request to finish.
  await apple.evaluate(() => { window.fixtureDelay = 3000; });
  await popup.evaluate(() => document.querySelector('#scan').click());
  await apple.waitForFunction(() => window.requests.some(path => path.includes('/tracks?')), null, { timeout: timeoutMs });
  const cancelStarted = Date.now();
  await popup.evaluate(() => document.querySelector('#cancel').click());
  await until(() => popup.evaluate(() => document.querySelector('#status-title').textContent === 'Scan cancelled'), 'cancellation');
  const cancelMs = Date.now() - cancelStarted;
  assert.ok(cancelMs < 2000, `Cancellation took ${cancelMs}ms; it should not wait for the 3000ms request`);
  assert.equal(await popup.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 0);
  assert.ok(await apple.evaluate(() => (window.abortedRequests || 0) > 0), 'v3 cancellation should abort the page request');
  await apple.evaluate(() => { window.fixtureDelay = 25; });
  await popup.evaluate(() => document.querySelector('#scan').click());
  await until(() => popup.evaluate(() => !document.querySelector('#scan').disabled), 'rescan');
  assert.equal(await popup.evaluate(() => document.querySelector('#status-title').textContent), 'Scan complete');
  console.log(`PASS: real extension cancellation settled in ${cancelMs}ms and a successful independent rescan followed`);

  // A failed rescan in the real extension keeps the completed result and badge.
  const resilient = await open('duplicates');
  await scan(resilient);
  assert.equal(await resilient.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 1);
  await until(() => resilient.evaluate(() => chrome.action.getBadgeText({})).then(text => text === '1'), 'badge after completed scan');
  await apple.evaluate(() => { window.scenario = 'malformed'; });
  await resilient.evaluate(() => document.querySelector('#scan').click());
  await until(() => resilient.evaluate(() => !document.querySelector('#scan').disabled), 'failed rescan');
  assert.equal(await resilient.evaluate(() => document.querySelector('#status-title').textContent), 'Scan failed');
  assert.match(await resilient.evaluate(() => document.querySelector('#status-detail').textContent), /Showing the last completed scan from/);
  assert.equal(await resilient.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 1);
  assert.equal(await resilient.evaluate(() => document.querySelector('.positions').textContent), 'Playlist positions: 1, 101, 245');
  await until(() => resilient.evaluate(() => chrome.action.getBadgeText({})).then(text => text === '1'), 'badge after failed rescan');
  await apple.evaluate(() => { window.scenario = 'duplicates'; });
  await resilient.evaluate(() => document.querySelector('#scan').click());
  await until(() => resilient.evaluate(() => !document.querySelector('#scan').disabled), 'recovered rescan');
  assert.equal(await resilient.evaluate(() => document.querySelector('#status-title').textContent), 'Scan complete');
  console.log('PASS: failed rescan preserves the last completed result, badge and Clear action');

  // Reloading the real popup restores the completed scan from extension storage.
  await resilient.reload();
  await until(async () => {
    try {
      return await resilient.evaluate(() => document.querySelector('#status-title')?.textContent === 'Showing last scan');
    } catch {
      return false;
    }
  }, 'cached last scan after popup reload');
  assert.equal(await resilient.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 1);
  await until(() => resilient.evaluate(() => chrome.action.getBadgeText({})).then(text => text === '1'), 'badge after cached restore');
  console.log('PASS: real popup reload restores the cached completed scan and badge');

  // Pop-out: reload the existing toolbar popup instead of closing and reopening
  // the native Windows popup widget, which can race and leave no target behind.
  await apple.goto('https://music.apple.com/us/library/playlist/p.fixture');
  const popper = await open('duplicates');
  assert.equal(await popper.evaluate(() => document.querySelector('#pop-out').hidden), false);
  await popper.evaluate(() => document.querySelector('#pop-out').click());
  const popTarget = await until(async () => (await cdp.send('Target.getTargets')).targetInfos
    .find(target => target.url.includes('/popup.html?tab=')), 'pop-out window target');
  const popped = await attach(popTarget.targetId);
  await until(async () => {
    try {
      return (await popped.evaluate(() => document.querySelector('#playlist-name').textContent)).includes('My playlist');
    } catch {
      return false;
    }
  }, 'pop-out window connection');
  assert.equal(await popped.evaluate(() => document.querySelector('#pop-out').hidden), true);
  await popped.close();
  console.log('PASS: pop-out window opens from the real toolbar popup and connects to the same tab');

  const blocked = await open('duplicates');
  await apple.goto('https://blocked.test/');
  await blocked.evaluate(() => document.querySelector('#scan').click());
  await until(() => blocked.evaluate(() => !document.querySelector('#scan').disabled), 'revoked injection failure');
  assert.equal(await blocked.evaluate(() => document.querySelector('#status-title').textContent), 'Scan failed');
  assert.match(await blocked.evaluate(() => document.querySelector('#status-detail').textContent), /could not access this tab/);
  assert.equal(await blocked.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 0);
  console.log('PASS: cross-origin navigation revokes activeTab; blocked injection shows an error without results');

  console.log('UNVERIFIED: live Apple Music, account/region variants, branded Chrome/Edge toolbar behavior');
} finally {
  await context?.close();
  // profile is the unique directory created above, inside this worktree.
  assert.ok(profile.startsWith(resolve('.cache') + sep), 'Refuse cleanup outside the test cache');
  await rm(profile, { recursive: true, force: true });
}
