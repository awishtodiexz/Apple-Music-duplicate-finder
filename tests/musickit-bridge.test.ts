import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelMusicKitRead, musicKitBridge } from '../src/musickit-bridge';
import type { BridgeRequest, PlaylistInfo, TrackPage } from '../src/types';

const playlist = { id: 'p.test', kind: 'library' as const, storefront: 'us', pathname: '/us/library/playlist/p.test' };
const request: BridgeRequest = { action: 'tracks', playlist, offset: 0 };
const song = (extra = {}) => ({ type: 'library-songs', id: 'i.same',
  attributes: { name: 'Numb', artistName: 'Linkin Park', playParams: { catalogId: '123' } }, ...extra });
function setup(get: (path: string) => unknown, instanceExtra = {}) {
  const calls: string[] = [];
  const win = { location: { origin: 'https://music.apple.com', pathname: playlist.pathname },
    MusicKit: { getInstance: () => Object.defineProperties(
      { isAuthorized: true, api: { get(path: string) { calls.push(path); return get(path); } } },
      Object.getOwnPropertyDescriptors(instanceExtra),
    ) } };
  Object.defineProperty(globalThis, 'window', { value: win, writable: true, configurable: true });
  return { calls, win };
}
async function page(): Promise<TrackPage> {
  const result = await musicKitBridge(request);
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.data as TrackPage;
}
test('accepts the three MusicKit response envelopes without exposing tokens', async () => {
  const body = { data: [song()], meta: { total: 1 }, secret: 'must not leave page' };
  for (const response of [body, { json: body }, { data: body }]) {
    const { calls } = setup(() => response);
    const result = await page();
    assert.deepEqual(result.tracks[0], { position: 1, name: 'Numb', artist: 'Linkin Park', catalogId: '123', libraryId: 'i.same' });
    assert.equal(result.total, 1);
    assert.equal(JSON.stringify(result).includes('must not leave page'), false);
    assert.deepEqual(calls, ['/v1/me/library/playlists/p.test/tracks?limit=100&offset=0&include=catalog']);
  }
});

test('v3 cancellation aborts fetchOptions and removes its page event listener', async () => {
  const target = new EventTarget();
  let removed = 0;
  let signal: AbortSignal | undefined;
  const { win } = setup(() => ({}), { api: { music: async (_path: string, _query: unknown,
    options: { fetchOptions: { signal: AbortSignal } }) => {
    signal = options.fetchOptions.signal;
    return new Promise(() => {});
  } } });
  Object.assign(win, { addEventListener: target.addEventListener.bind(target),
    removeEventListener: (...args: Parameters<EventTarget['removeEventListener']>) => { removed++; target.removeEventListener(...args); },
    dispatchEvent: target.dispatchEvent.bind(target) });
  const requestId = '12345678-1234-1234-1234-123456789abc';
  const pending = musicKitBridge({ ...request, requestId });
  cancelMusicKitRead(requestId);
  assert.deepEqual(await pending, { ok: false, code: 'CANCELLED' });
  assert.equal(signal?.aborted, true);
  assert.equal(removed, 1);
});

test('timeout aborts v3 where supported and legacy late rejections are handled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  setup(() => ({}), { api: { music: async (_path: string, _query: unknown,
    options: { fetchOptions: { signal: AbortSignal } }) => {
    signal = options.fetchOptions.signal;
    return new Promise(() => {});
  } } });
  const pending = musicKitBridge(request);
  t.mock.timers.tick(25_000);
  assert.deepEqual(await pending, { ok: false, code: 'TIMEOUT' });
  assert.equal(signal?.aborted, true);
  let rejectLate!: (error: Error) => void;
  setup(() => new Promise((_, reject) => { rejectLate = reject; }));
  const legacy = musicKitBridge(request);
  t.mock.timers.tick(25_000);
  assert.deepEqual(await legacy, { ok: false, code: 'TIMEOUT' });
  rejectLate(new Error('Late private failure'));
  await Promise.resolve();
});

test('metadata extracts optional version hashes, and blank modification markers remain unknown', async () => {
  setup(() => ({ data: [{ id: playlist.id, type: 'library-playlists',
    attributes: { name: 'Versioned', lastModifiedDate: '', playParams: { versionHash: 'v1' } } }] }));
  assert.deepEqual(await musicKitBridge({ action: 'metadata', playlist }), {
    ok: true, data: { name: 'Versioned', modified: null, total: null, revision: 'v1' },
  });
});
test('catalog relationship, typed catalog resource and library fallback identities', async () => {
  setup(() => ({ data: [
    song({ attributes: {}, relationships: { catalog: { data: [{ type: 'songs', id: '456' }] } } }),
    { type: 'songs', id: '789', attributes: {} },
    song({ attributes: {} }),
    { type: 'playlist-entry', id: '123', attributes: { playParams: { catalogId: '123' } } },
    { type: 'library-songs', id: 'entry-123', attributes: {} },
    { type: 'music-videos', id: '123', attributes: { playParams: { catalogId: '123' } } },
  ] }));
  const result = await page();
  assert.deepEqual(result.tracks.map(t => [t.catalogId, t.libraryId]), [
    ['456', 'i.same'], ['789', null], [null, 'i.same'], [null, null], [null, null], [null, null],
  ]);
  assert.equal(result.tracks[0]?.name, 'Unknown song');
});
test('conflicting catalog identities are excluded rather than guessed', async () => {
  setup(() => ({ data: [song({ relationships: { catalog: { data: [{ type: 'songs', id: '456' }] } } })] }));
  assert.deepEqual((await page()).tracks.map(t => [t.catalogId, t.libraryId]), [[null, null]]);
});
test('preserves multiple occurrences sharing the same library ID', async () => {
  setup(() => ({ data: [song(), song(), song()] }));
  assert.deepEqual((await page()).tracks.map(t => t.position), [1, 2, 3]);
});
test('metadata verifies the exact requested playlist ID and resource type', async () => {
  setup(() => ({ data: [{ type: 'library-playlists', id: 'p.test', attributes: { name: 'My mix', trackCount: 42 } }] }));
  const result = await musicKitBridge({ action: 'metadata', playlist });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal((result.data as PlaylistInfo).total, 42);
  setup(() => ({ data: [{ type: 'library-playlists', id: 'p.other', attributes: { name: 'Different' } }] }));
  assert.deepEqual(await musicKitBridge({ action: 'metadata', playlist }), { ok: false, code: 'FORMAT' });
});
test('valid short-page next link is retained', async () => {
  setup(() => ({ data: [song()], next: '/v1/me/library/playlists/p.test/tracks?offset=1&limit=100', meta: { total: 2 } }));
  assert.equal((await page()).nextOffset, 1);
});
test('unsafe, unrelated, repeated, skipped or empty-page next links fail', async () => {
  for (const next of ['https://evil.example/v1/me/library/playlists/p.test/tracks?offset=1',
    '/v1/me/library/playlists/p.other/tracks?offset=1', '/v1/me/library/playlists/p.test/tracks?offset=0',
    '/v1/me/library/playlists/p.test/tracks?offset=2']) {
    setup(() => ({ data: [song()], next }));
    assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'INCOMPLETE' });
  }
  setup(() => ({ data: [], next: '/v1/me/library/playlists/p.test/tracks?offset=1' }));
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'INCOMPLETE' });
});
test('malformed response formats, tracks and counts fail, never become empty pages', async () => {
  for (const response of [null, [], {}, { data: {} }, { data: null }, { json: { surprise: [] } },
    { data: [null] }, { data: [{}] }, { data: [], meta: { total: '200' } }, { data: [], meta: { total: -1 } }]) {
    setup(() => response);
    assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'FORMAT' });
  }
});
test('authentication, rate limits, API status and network failures return fixed safe errors', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [404, 'NOT_FOUND'], [429, 'RATE_LIMIT'], [503, 'API']] as const) {
    setup(() => { throw { status, message: 'secret', headers: { Authorization: 'secret' } }; });
    assert.deepEqual(await musicKitBridge(request), { ok: false, code });
    setup(() => ({ errors: [{ status: String(status), detail: 'secret' }] }));
    assert.deepEqual(await musicKitBridge(request), { ok: false, code });
  }
  setup(() => { throw new TypeError('Failed to fetch secret'); });
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'NETWORK' });
  setup(() => ({}), { isAuthorized: false });
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'AUTH' });
});
test('MusicKit unavailable or unconfigured is an explicit blocker', async () => {
  const { win } = setup(() => ({}));
  Object.assign(win, { MusicKit: undefined });
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'MUSICKIT_UNAVAILABLE' });
  setup(() => ({}), { api: {} });
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'MUSICKIT_UNAVAILABLE' });
});
test('navigation before and during a request invalidates it', async () => {
  let { win, calls } = setup(() => ({ data: [] }));
  win.location.pathname = '/us/browse';
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'PAGE_CHANGED' });
  assert.equal(calls.length, 0);
  ({ win } = setup(() => { win.location.pathname = '/us/playlist/p.other'; return { data: [] }; }));
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'PAGE_CHANGED' });
});
test('catalog routes use the same MusicKit integration, never a library-name search', async () => {
  const { win, calls } = setup(() => ({ data: [] }), { storefrontId: 'gb' });
  const catalog = { ...playlist, id: 'pl.abc', kind: 'catalog' as const, pathname: '/gb/playlist/mix/pl.abc' };
  win.location.pathname = catalog.pathname;
  assert.equal((await musicKitBridge({ action: 'tracks', playlist: catalog, offset: 0 })).ok, true);
  assert.equal(calls[0], '/v1/catalog/gb/playlists/pl.abc/tracks?limit=100&offset=0');
});
test('a hung API request times out without returning partial data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setup(() => new Promise(() => {}));
  const pending = musicKitBridge(request);
  t.mock.timers.tick(25_000);
  assert.deepEqual(await pending, { ok: false, code: 'TIMEOUT' });
});

test('MusicKit v3 music-only instances support metadata and tracks as explicit GETs', async () => {
  const calls: string[] = [];
  const api = {
    async music(this: unknown, path: string, query: unknown, options: unknown) {
      assert.equal(this, api);
      assert.deepEqual(query, {});
      const fetchOptions = (options as { fetchOptions: { method: string; signal: AbortSignal } }).fetchOptions;
      assert.equal(fetchOptions.method, 'GET');
      assert.ok(fetchOptions.signal instanceof AbortSignal);
      calls.push(path);
      return { request: { private: 'do not expose' }, response: { status: 200 }, data: path.includes('/tracks?')
        ? { data: [song()], meta: { total: 1 } }
        : { data: [{ type: 'library-playlists', id: 'p.test', attributes: { name: 'V3 playlist', trackCount: 1 } }] } };
    },
  };
  setup(() => assert.fail('Legacy API should not be used'), { api });
  const metadata = await musicKitBridge({ action: 'metadata', playlist });
  assert.deepEqual(metadata, { ok: true, data: { name: 'V3 playlist', total: 1, modified: null } });
  const result = await page();
  assert.equal(result.tracks[0]?.catalogId, '123');
  assert.equal(result.total, 1);
  assert.equal(JSON.stringify(result).includes('do not expose'), false);
  assert.deepEqual(calls, ['/v1/me/library/playlists/p.test', '/v1/me/library/playlists/p.test/tracks?limit=100&offset=0&include=catalog']);
});
test('prefers MusicKit v3 when both read surfaces exist, with no retry through legacy on failure', async () => {
  let legacyCalls = 0;
  const api = { get() { legacyCalls++; throw new Error('Wrong API'); }, music: async () => ({ data: { data: [] } }) };
  setup(() => ({}), { api });
  assert.deepEqual(await page(), { tracks: [], total: null, nextOffset: null });
  api.music = async () => { throw { data: { status: 429 } }; };
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'RATE_LIMIT' });
  assert.equal(legacyCalls, 0);
});
test('legacy GET remains bound to its API object', async () => {
  const api = { get(this: unknown) { assert.equal(this, api); return { data: [] }; } };
  setup(() => ({}), { api });
  assert.equal((await musicKitBridge(request)).ok, true);
});
test('nested MusicKit HTTP errors and raw error arrays map to safe actionable codes', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [404, 'NOT_FOUND'], [429, 'RATE_LIMIT'], [503, 'API']] as const) {
    for (const error of [
      { data: new Response(null, { status }), reason: 'UNKNOWN_ERROR' },
      { status: 0, data: { status: String(status) }, message: 'private' },
      { response: { status } },
      [{ status: String(status), detail: 'private' }],
      { data: { errors: [{ status: String(status), detail: 'private' }] } },
    ]) {
      setup(() => { throw error; });
      assert.deepEqual(await musicKitBridge(request), { ok: false, code });
    }
  }
});
test('MusicKit error reasons work without HTTP status and do not expose exception data', async () => {
  for (const [reason, code] of [
    ['AUTHORIZATION_ERROR', 'AUTH'], ['UNAUTHORIZED_ERROR', 'AUTH'], ['ACCESS_DENIED', 'AUTH'],
    ['TOKEN_EXPIRED', 'AUTH'], ['QUOTA_EXCEEDED', 'RATE_LIMIT'], ['NOT_FOUND', 'NOT_FOUND'],
    ['CONFIGURATION_ERROR', 'MUSICKIT_UNAVAILABLE'], ['NETWORK_ERROR', 'NETWORK'],
    ['SERVER_ERROR', 'API'], ['SERVICE_UNAVAILABLE', 'API'], ['REQUEST_ERROR', 'API'],
    ['PARSE_ERROR', 'FORMAT'], ['unrecognized reason', 'NETWORK'], ['toString', 'NETWORK'],
  ] as const) {
    for (const error of [{ reason, description: 'private' }, { errorCode: reason, message: 'private' }]) {
      setup(() => { throw error; });
      assert.deepEqual(await musicKitBridge(request), { ok: false, code });
    }
  }
});
test('numeric HTTP status takes precedence over generic MusicKit reasons', async () => {
  setup(() => { throw { reason: 'NETWORK_ERROR', data: { status: 429 } }; });
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'RATE_LIMIT' });
});
test('resolved MusicKit wrappers with failed HTTP status never become successful empty pages', async () => {
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'API']] as const) {
    for (const response of [
      { response: { status }, data: { data: [] } },
      { response: new Response(null, { status }), json: { data: [] } },
      { data: { status, data: [] } },
      { response: { status }, data: { data: [], errors: [{ detail: 'private' }] } },
    ]) {
      setup(() => response);
      assert.deepEqual(await musicKitBridge(request), { ok: false, code });
    }
  }
  setup(() => ({ response: { status: 401 }, data: { data: [
    { id: 'p.test', type: 'library-playlists', attributes: { name: 'Private playlist', trackCount: 0 } },
  ] } }));
  assert.deepEqual(await musicKitBridge({ action: 'metadata', playlist }), { ok: false, code: 'AUTH' });
});
test('an unconfigured MusicKit API getter reports unavailable rather than a network failure', async () => {
  setup(() => ({}), { get api() { throw { reason: 'CONFIGURATION_ERROR' }; } });
  assert.deepEqual(await musicKitBridge(request), { ok: false, code: 'MUSICKIT_UNAVAILABLE' });
});
