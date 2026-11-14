import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSource } from '../src/browser-source';
import { errorMessage } from '../src/errors';
import { musicKitBridge } from '../src/musickit-bridge';
import { toCsv } from '../src/results';
import { loadCachedScan, saveCachedScan, type CachedScan } from '../src/storage';
import type { BridgeRequest, DuplicateGroup, PlaylistRef } from '../src/types';

const cacheKey = 'amdf:last-scan:v1';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage,
});

const group = (name: string, artist = 'Artist', positions = [1, 2]): DuplicateGroup => ({
  identity: `catalog:${name}`, name, artist, positions,
  copies: positions.length, extraCopies: positions.length - 1,
});
const scan = (overrides: Partial<CachedScan> = {}): CachedScan => ({
  version: 1,
  playlistId: 'p.fixture',
  playlistName: 'Fixture',
  scannedAt: 1_760_000_000_000,
  groups: [group('Numb')],
  unidentified: 0,
  totalTracks: 2,
  countVerified: true,
  modificationChecked: true,
  notes: 'Markers matched.',
  ...overrides,
});
function stored(value: unknown): void {
  values.clear();
  values.set(cacheKey, typeof value === 'string' ? value : JSON.stringify(value));
}

// Spreadsheet programs ignore leading whitespace, control and format characters
// when deciding whether a cell is a formula, so checking only byte zero is not enough.
test('CSV neutralizes formula triggers hidden behind leading whitespace, controls and invisible Unicode', () => {
  const dangerous = [
    ' =1+1', '\t=1+1', '\r=1+1', '\n=1+1', '\v=1+1', '\f=1+1', '\0=1+1',
    '\u001f=1+1', '\u007f=1+1', '\u009f=1+1',
    '\u00a0=1+1', '\u1680=1+1', '\u2000=1+1', '\u2003=1+1', '\u200b=1+1',
    '\u200e=1+1', '\u2028=1+1', '\u2029=1+1', '\u202e=1+1', '\u202f=1+1',
    '\u205f=1+1', '\u2060=1+1', '\u3000=1+1', '\ufeff=1+1',
    '\uff1d1+1', '\uff0b1+1', '\uff0d1+1', '\uff20SUM(1)', '\u22121+1',
  ];
  for (const value of dangerous) {
    const csv = toCsv([group(value)]);
    assert.ok(csv.includes(`'${value}`), `formula trigger was not neutralized: ${JSON.stringify(value)}`);
  }
  for (const value of ['=1+1', '+1+1', '-1+1', '@SUM(1)']) {
    assert.ok(toCsv([group(value)]).includes(`'${value}`), value);
  }
});

test('CSV leaves ordinary song names untouched', () => {
  const csv = toCsv([group('Numb'), group('Song — Live')]);
  assert.match(csv, /Numb,Artist,2,1,1 2/);
  assert.match(csv, /Song — Live,Artist,2,1,1 2/);
});

// A corrupted or tampered cache is not a trusted store: it must stay within the
// same bounds as a scanned result, and be discarded rather than repaired in place.
test('cached scans reject inconsistent or oversized groups and remove the bad entry', () => {
  const badGroup = (overrides: Partial<DuplicateGroup>): DuplicateGroup => ({
    ...group('Numb'), ...overrides,
  });
  const invalid: Array<[string, unknown]> = [
    ['positions do not match copies', scan({ groups: [badGroup({ copies: 3, extraCopies: 2 })] })],
    ['extra copies do not match copies', scan({ groups: [badGroup({ extraCopies: 4 })] })],
    ['zero position', scan({ groups: [badGroup({ positions: [0, 2] })] })],
    ['position beyond the scan limit', scan({ groups: [badGroup({ positions: [1, 50_001] })] })],
    ['oversized group name', scan({ groups: [badGroup({ name: 'x'.repeat(2001), identity: 'catalog:1' })] })],
    ['oversized artist', scan({ groups: [badGroup({ artist: 'x'.repeat(2001) })] })],
    ['oversized identity', scan({ groups: [badGroup({ identity: `catalog:${'1'.repeat(260)}` })] })],
    ['too many groups', scan({
      groups: Array.from({ length: 25_001 }, (_, index) =>
        ({ ...group('Numb'), identity: `catalog:${index}`, positions: [index + 1, index + 2] })),
      totalTracks: 50_000,
    })],
    ['invalid playlist id', scan({ playlistId: '../p.fixture' })],
    ['too many tracks', scan({ totalTracks: 50_001 })],
    ['more unidentified entries than tracks', scan({ unidentified: 3 })],
    ['copies exceed the track count', scan({ unidentified: 1 })],
    ['oversized notes', scan({ notes: 'x'.repeat(20_001) })],
    ['invalid timestamp', scan({ scannedAt: 9_000_000_000_000_000 })],
    ['wrong cache version', { ...scan(), version: 2 }],
  ];
  for (const [label, value] of invalid) {
    stored(value);
    assert.equal(loadCachedScan('p.fixture'), null, label);
    assert.equal(values.has(cacheKey), false, label);
  }
});

test('corrupt or oversized raw cache entries are discarded instead of being re-parsed forever', () => {
  for (const raw of ['{not json', 'x'.repeat(4_500_001)]) {
    stored(raw);
    assert.equal(loadCachedScan('p.fixture'), null);
    assert.equal(values.has(cacheKey), false);
  }
});

test('a valid cache for a different playlist is preserved, not deleted', () => {
  stored(scan());
  assert.equal(loadCachedScan('p.other'), null);
  assert.equal(values.has(cacheKey), true);
});

test('saving an invalid cache is refused and does not leave stale data behind', () => {
  stored(scan());
  assert.equal(saveCachedScan(scan({ groups: [{ ...group('Numb'), copies: 3, extraCopies: 1 }] })), false);
  assert.equal(values.has(cacheKey), false);
});

// A successful page reply can still be shaped like an array with injected
// properties; the transport must not treat that as a valid record.
const playlist: PlaylistRef = { id: 'p.test', kind: 'library', storefront: 'us' };
interface Injection { func: unknown; world: string; args: unknown[]; }
function setupChrome(executeScript: (request: Injection) => unknown): void {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { scripting: { executeScript } },
  });
}

test('cross-context replies must be plain records, not arrays with properties', async () => {
  setupChrome(async () => [{ result: {
    ok: true, data: Object.assign([], { name: 'P', total: 0, modified: null }),
  } }]);
  await assert.rejects(createBrowserSource(1, playlist).metadata(), { code: 'FORMAT' });

  setupChrome(async () => [{ result: {
    ok: true, data: Object.assign([], { tracks: [], total: 0, nextOffset: null }),
  } }]);
  await assert.rejects(createBrowserSource(1, playlist).page(0), { code: 'FORMAT' });
});

test('the cross-context reply envelope itself must be a plain record', async () => {
  setupChrome(async () => [{ result: Object.assign([], {
    ok: true, data: { name: 'P', total: 0, modified: null },
  }) }]);
  await assert.rejects(createBrowserSource(1, playlist).metadata(), { code: 'FORMAT' });
});

test('cross-context track entries must be plain records too', async () => {
  setupChrome(async () => [{ result: { ok: true, data: {
    total: 1,
    nextOffset: null,
    tracks: [Object.assign([], { position: 1, name: 'N', artist: 'A', catalogId: null, libraryId: null })],
  } } }]);
  await assert.rejects(createBrowserSource(1, playlist).page(0), { code: 'FORMAT' });
});

test('a well-formed cross-context reply still passes', async () => {
  setupChrome(async () => [{ result: { ok: true, data: { name: 'P', total: 0, modified: null } } }]);
  const info = await createBrowserSource(1, playlist).metadata();
  assert.equal(info.name, 'P');
});

// The bridge is the only page-world surface. Malformed requests and envelopes
// must fail closed with fixed codes and never look like successful empty data.
const bridgePlaylist: PlaylistRef = { id: 'p.test', kind: 'library', storefront: 'us' };
const bridgeRequest: BridgeRequest = { action: 'tracks', playlist: bridgePlaylist, offset: 0 };
const song = { type: 'library-songs', id: 'i.same',
  attributes: { name: 'Numb', artistName: 'Linkin Park', playParams: { catalogId: '123' } } };
function setupBridge(get: (path: string) => unknown, pathname = '/us/library/playlist/p.test'): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: { origin: 'https://music.apple.com', pathname },
      MusicKit: { getInstance: () => ({ isAuthorized: true, storefrontId: 'us', api: { get } }) },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    },
  });
}

test('malformed error envelopes are rejected instead of becoming successful pages', async () => {
  for (const errors of [{ status: 401 }, 'oops', 1, true]) {
    setupBridge(() => ({ data: [song], errors }));
    assert.deepEqual(await musicKitBridge(bridgeRequest), { ok: false, code: 'FORMAT' });
  }
  setupBridge(() => ({ data: [song], errors: null }));
  assert.equal((await musicKitBridge(bridgeRequest)).ok, true);
  setupBridge(() => ({ data: [song], errors: [] }));
  assert.equal((await musicKitBridge(bridgeRequest)).ok, true);
});

test('root-level error envelopes cannot hide beside nested success data', async () => {
  setupBridge(() => ({ data: { data: [song], meta: { total: 1 } }, errors: [{ status: 401 }] }));
  assert.deepEqual(await musicKitBridge(bridgeRequest), { ok: false, code: 'AUTH' });
  setupBridge(() => ({ data: { data: [song] }, errors: { status: 401 } }));
  assert.deepEqual(await musicKitBridge(bridgeRequest), { ok: false, code: 'FORMAT' });
});

test('the bridge rejects unknown actions, invalid kinds and overlong playlist IDs', async () => {
  setupBridge(() => ({ data: [] }));
  assert.deepEqual(await musicKitBridge({
    action: 'delete', playlist: bridgePlaylist, offset: 0,
  } as unknown as BridgeRequest), { ok: false, code: 'FORMAT' });

  const invalidKind = { ...bridgePlaylist, kind: 'other' } as unknown as PlaylistRef;
  assert.deepEqual(await musicKitBridge({ action: 'tracks', playlist: invalidKind, offset: 0 }),
    { ok: false, code: 'NOT_PLAYLIST' });

  const longId = `p.${'a'.repeat(127)}`;
  setupBridge(() => ({ data: [] }), `/us/library/playlist/${longId}`);
  assert.deepEqual(await musicKitBridge({
    action: 'tracks', playlist: { ...bridgePlaylist, id: longId }, offset: 0,
  }), { ok: false, code: 'NOT_PLAYLIST' });
});

// Logging an unexpected object must not echo provider text, cookies or tokens
// into the extension console, and a hostile getter must not break error handling.
test('unexpected errors are logged without their message or credentials', (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  assert.match(errorMessage(new TypeError('AUTH_TOKEN=secret; Cookie: session=secret')), /Something went wrong in the extension/);
  const rendered = logged.flat().map(value =>
    value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(' ');
  assert.match(rendered, /TypeError/);
  assert.doesNotMatch(rendered, /AUTH_TOKEN|secret|Cookie/);
});

test('hostile error objects cannot break or leak through diagnostics', (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const hostile = {
    get message(): string { throw new Error('AUTH_TOKEN=secret'); },
    get name(): string { throw new Error('AUTH_TOKEN=secret'); },
  };
  assert.match(errorMessage(hostile), /Something went wrong in the extension/);
  assert.doesNotMatch(JSON.stringify(logged), /AUTH_TOKEN|secret/);
});
