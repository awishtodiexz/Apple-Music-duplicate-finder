import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { fixture } from './fixtures/player.mjs';

// Full bundled Chromium supports headless unpacked extensions and CDP action invocation.
// No chrome.* APIs, activeTab grants, or script injection are mocked in this suite.
await mkdir('.cache', { recursive: true });
const profile = await mkdtemp(resolve('.cache/extension-profile-'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
let context;
async function until(operation, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + description);
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--disable-component-update', '--disable-background-networking'],
  });
  context.setDefaultTimeout(15_000);
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
        const timer = setTimeout(() => { cleanup(); reject(new Error('Popup CDP command timed out: ' + method)); }, 15_000);
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
      close: () => cdp.send('Target.closeTarget', { targetId }),
    };
  }
  async function open(scenario, mode = 'v3') {
    await apple.bringToFront();
    await apple.evaluate(({ scenario, mode }) => {
      window.scenario = scenario; window.apiMode = mode; window.requests = []; window.fixtureDelay = 25;
      history.replaceState({}, '', '/us/library/playlist/p.fixture');
    }, { scenario, mode });
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const tab = targetInfos.find(target => target.url === apple.url());
    assert.ok(tab);
    await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
    const target = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target =>
      target.type === 'other' && (!target.url || target.url.startsWith(`chrome-extension://${id}/popup.html`))), 'actual toolbar popup target');
    const popup = await attach(target.targetId);
    await until(() => popup.evaluate(() => {
      const title = document.querySelector('#status-title')?.textContent;
      return Boolean(title && title !== 'Connecting to Apple Music…');
    }), 'popup initialization');
    return popup;
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
    assert.equal(await popup.evaluate(() => document.querySelector('.positions').textContent), 'Playlist positions: 1, 101, 245');
    assert.equal(await popup.evaluate(() => document.querySelector('.counts').textContent), 'This song appears 3 times');
    assert.equal(await popup.evaluate(() => document.querySelectorAll('img').length), 0);
    assert.equal((await apple.evaluate(() => window.requests)).length, 6);
    assert.deepEqual(await popup.evaluate(() => chrome.runtime.getManifest().permissions), ['activeTab', 'scripting']);
    assert.equal(await popup.evaluate(() => chrome.runtime.getManifest().version), version);
    await popup.close();
    console.log(`PASS (${mode}): toolbar popup, real activeTab grant, MAIN injection, pagination and safe rendering`);
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
    await popup.close();
  }
  console.log('PASS: unavailable MusicKit, unauthorised/expired session, changed response format, no partial results');
  const popup = await open('duplicates');
  await apple.evaluate(() => { window.fixtureDelay = 1000; });
  await popup.evaluate(() => document.querySelector('#scan').click());
  await popup.evaluate(() => document.querySelector('#cancel').click());
  await until(() => popup.evaluate(() => document.querySelector('#status-title').textContent === 'Scan cancelled'), 'cancellation');
  assert.equal(await popup.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 0);
  await apple.evaluate(() => { window.fixtureDelay = 25; });
  await popup.evaluate(() => document.querySelector('#scan').click());
  await until(() => popup.evaluate(() => !document.querySelector('#scan').disabled), 'rescan');
  assert.equal(await popup.evaluate(() => document.querySelector('#status-title').textContent), 'Scan complete');
  await popup.close();
  console.log('PASS: real extension cancellation and successful independent rescan');
  const blocked = await open('duplicates');
  await apple.goto('https://blocked.test/');
  await blocked.evaluate(() => document.querySelector('#scan').click());
  await until(() => blocked.evaluate(() => !document.querySelector('#scan').disabled), 'revoked injection failure');
  assert.equal(await blocked.evaluate(() => document.querySelector('#status-title').textContent), 'Scan failed');
  assert.match(await blocked.evaluate(() => document.querySelector('#status-detail').textContent), /could not access this tab/);
  assert.equal(await blocked.evaluate(() => document.querySelectorAll('#duplicate-list li').length), 0);
  await blocked.close();
  console.log('PASS: cross-origin navigation revokes activeTab; blocked injection shows an error without results');
  console.log('UNVERIFIED: live Apple Music, account/region variants, branded Chrome/Edge toolbar behavior');
} finally {
  await context?.close();
  // profile is the unique directory created above, inside this worktree.
  assert.ok(profile.startsWith(resolve('.cache') + sep), 'Refuse cleanup outside the test cache');
  await rm(profile, { recursive: true, force: true });
}
