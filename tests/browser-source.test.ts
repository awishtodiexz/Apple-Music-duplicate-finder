import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSource } from '../src/browser-source';
import { cancelMusicKitRead } from '../src/musickit-bridge';
import type { BridgeRequest } from '../src/types';

const playlist = { id: 'p.test', kind: 'library' as const, storefront: 'us', pathname: '/us/library/playlist/p.test' };
interface Injection { func: unknown; world: string; args: unknown[]; }
function setup(executeScript: (request: Injection) => unknown): void {
  Object.defineProperty(globalThis, 'chrome', { value: { scripting: { executeScript } }, configurable: true });
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
