import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSource } from '../src/browser-source';
import { cancelMusicKitRead } from '../src/musickit-bridge';
import type { BridgeRequest } from '../src/types';

const playlist = { id: 'p.test', kind: 'library' as const, storefront: 'us', pathname: '/us/library/playlist/p.test' };
interface Injection { func: unknown; world: string; args: unknown[]; }
function setup(executeScript: (request: Injection) => unknown,
  getTab: ((tabId: number) => unknown) | null = null): void {
  Object.defineProperty(globalThis, 'chrome', {
    value: { scripting: { executeScript }, ...(getTab ? { tabs: { get: getTab } } : {}) },
    configurable: true,
  });
}
test('transport rejects missing/malformed page-world replies and unknown error codes', async () => {
  for (const reply of [null, {}, { ok: 'yes' }, { ok: false, code: 'private exception text' },
    { ok: true, data: {} }, { ok: true, data: { total: 0, name: 123, modified: null } }]) {
    setup(async () => [{ result: reply }]);
    await assert.rejects(createBrowserSource(1, playlist).metadata(), { code: reply === null ? 'PAGE_CHANGED' : 'FORMAT' });
  }
  for (const data of [{ total: null, tracks: {}, nextOffset: null },
    { total: null, tracks: [null], nextOffset: null },
    { total: null, tracks: [], nextOffset: -1 }]) {
    setup(async () => [{ result: { ok: true, data } }]);
    await assert.rejects(createBrowserSource(1, playlist).page(0), { code: 'FORMAT' });
  }
});
test('blocked injection rejects without exposing page errors to a successful scan', async () => {
  setup(async () => { throw new Error('Cannot access contents of this page'); });
  await assert.rejects(createBrowserSource(1, playlist).metadata());
});
test('transport cancellation is prompt and uses a separate uniquely scoped MAIN injection', async () => {
  const requests: Injection[] = [];
  let resolveLate!: (value: unknown) => void;
  setup((request) => {
    requests.push(request);
    return request.func === cancelMusicKitRead ? Promise.resolve([]) : new Promise(resolve => { resolveLate = resolve; });
  });
  const controller = new AbortController();
  const pending = createBrowserSource(1, playlist).page(0, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.world, 'MAIN');
  assert.equal(requests[1]!.args[0], (requests[0]!.args[0] as BridgeRequest).requestId);
  resolveLate([{ result: { ok: true, data: { tracks: [], total: 0, nextOffset: null } } }]);
  setup(async () => [{ result: { ok: true, data: { name: 'New scan', total: 0, modified: null } } }]);
  assert.equal((await createBrowserSource(1, playlist).metadata()).name, 'New scan');
});
test('a pre-cancelled transport does not inject', async () => {
  let calls = 0;
  setup(async () => { calls++; return []; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createBrowserSource(1, playlist).metadata(controller.signal), { code: 'CANCELLED' });
  assert.equal(calls, 0);
});

test('a wedged injection times out instead of hanging the popup forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: Injection[] = [];
  setup((request) => { requests.push(request); return new Promise(() => {}); });
  const pending = createBrowserSource(1, playlist).metadata();
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, { code: 'TIMEOUT' });
  // The read plus a separate page-side cancel so the page does not keep working.
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.func, cancelMusicKitRead);
});

test('a closed tab is reported as a playlist change, not a permission problem', async () => {
  setup(async () => { throw new Error('No tab with id: 7.'); });
  await assert.rejects(createBrowserSource(1, playlist).metadata(), { code: 'PAGE_CHANGED' });
});

test('localized injection errors use tab state instead of English message matching', async () => {
  setup(async () => { throw new Error('Zugriff auf diese Seite nicht möglich'); },
    async () => ({ id: 1, url: 'https://music.apple.com/us/library/playlist/p.test' }));
  await assert.rejects(createBrowserSource(1, playlist).metadata(), { code: 'TAB_ACCESS' });
  setup(async () => { throw new Error('localized message'); },
    async () => ({ id: 1, url: 'https://example.com/' }));
  await assert.rejects(createBrowserSource(1, playlist).metadata(), { code: 'TAB_ACCESS' });
  setup(async () => { throw new Error('localized message'); }, async () => { throw new Error('gone'); });
  await assert.rejects(createBrowserSource(1, playlist).metadata(), { code: 'PAGE_CHANGED' });
});

test('retry-after guidance crosses the transport without exposing provider data', async () => {
  setup(async () => [{ result: { ok: false, code: 'RATE_LIMIT', retryAfterMs: 5_000, detail: 'private' } }]);
  await assert.rejects(createBrowserSource(1, playlist).metadata(), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'RATE_LIMIT' &&
    'retryAfterMs' in error && error.retryAfterMs === 5_000);
  setup(async () => [{ result: { ok: false, code: 'RATE_LIMIT', retryAfterMs: 999_999 } }]);
  await assert.rejects(createBrowserSource(1, playlist).metadata(), (error: unknown) =>
    error instanceof Error && 'retryAfterMs' in error && error.retryAfterMs === 600_000);
});
