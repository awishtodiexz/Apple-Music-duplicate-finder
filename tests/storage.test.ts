import assert from 'node:assert/strict';
import test from 'node:test';
import { clearCachedScan, loadCachedScan, saveCachedScan, type CachedScan } from '../src/storage';
import type { DuplicateGroup } from '../src/types';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage,
});

const group: DuplicateGroup = {
  identity: 'catalog:1', name: 'Numb', artist: 'Linkin Park',
  positions: [1, 101, 245], copies: 3, extraCopies: 2,
};
const scan: CachedScan = {
  version: 1, playlistId: 'p.fixture', playlistName: 'Fixture', scannedAt: 1_760_000_000_000,
  groups: [group], unidentified: 0, totalTracks: 245,
  countVerified: true, modificationChecked: true, notes: 'Markers matched.',
};

test('a cached scan round-trips only for the same playlist', () => {
  clearCachedScan();
  assert.equal(saveCachedScan(scan), true);
  assert.deepEqual(loadCachedScan('p.fixture'), scan);
  assert.equal(loadCachedScan('p.other'), null);
});

test('corrupt or invalid cached data is ignored', () => {
  values.set('amdf:last-scan:v1', '{not json');
  assert.equal(loadCachedScan('p.fixture'), null);
  values.set('amdf:last-scan:v1', JSON.stringify({ ...scan, groups: [{ ...group, positions: ['1'] }] }));
  assert.equal(loadCachedScan('p.fixture'), null);
});

test('oversized results are refused and do not leave stale data behind', () => {
  clearCachedScan();
  assert.equal(saveCachedScan({ ...scan, groups: [{ ...group, name: 'x'.repeat(2_000_000) }] }), false);
  assert.equal(loadCachedScan('p.fixture'), null);
});

test('clearing removes the cached scan', () => {
  assert.equal(saveCachedScan(scan), true);
  clearCachedScan();
  assert.equal(loadCachedScan('p.fixture'), null);
});
