import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { musicKitBridge } from '../src/musickit-bridge';
import { bridgeErrorCodes } from '../src/types';

const playlist = { id: 'p.x', kind: 'library' as const, storefront: 'us', pathname: '/us/library/playlist/p.x' };

/**
 * chrome.scripting ships only Function.prototype.toString(), so any module-level
 * binding referenced inside the bridge becomes a ReferenceError in the page.
 * Running the serialized source in a context without module scope proves it.
 */
test('the serialized bridge runs without its module scope', async () => {
  const window = {
    location: { origin: 'https://music.apple.com', pathname: playlist.pathname },
    MusicKit: {
      getInstance: () => ({
        isAuthorized: true, storefrontId: 'us',
        api: { get: async () => ({ data: [{ id: 'p.x', type: 'library-playlists', attributes: { name: 'P', trackCount: 0 } }] }) },
      }),
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  const context = vm.createContext({ window, setTimeout, clearTimeout, AbortController, URL, Promise });
  const source = '(' + musicKitBridge.toString() + ')';
  const reply = await vm.runInContext(source, context, { timeout: 5_000 })({ action: 'metadata', playlist });
  assert.equal(JSON.stringify(reply), JSON.stringify({ ok: true, data: { name: 'P', total: 0, modified: null } }));
});

test('the page-side error list stays in sync with the shared contract', () => {
  // The bridge cannot import bridgeErrorCodes without breaking serialization, so
  // this is the regression guard that keeps the two literal copies identical.
  // Compare the array itself rather than substring hits, which would also match
  // names like AUTHORIZATION_ERROR.
  const source = musicKitBridge.toString();
  const match = source.match(/codes\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'the bridge must keep a literal error-code list');
  const listed = [...match[1]!.matchAll(/["']([A-Z_]+)["']/g)].map(entry => entry[1]);
  assert.deepEqual(listed.sort(), [...bridgeErrorCodes].sort());
});
