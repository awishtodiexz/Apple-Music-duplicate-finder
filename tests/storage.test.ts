import assert from 'node:assert/strict';
import test from 'node:test';
import { clearCachedScan, loadCachedScan, loadThemePreference, saveCachedScan, saveThemePreference, type CachedScan } from '../src/storage';
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
  assert.equal(saveCachedScan({ ...scan, groups: [{ ...group, name: 'x'.repeat(5_000_000) }] }), false);
  assert.equal(loadCachedScan('p.fixture'), null);
});

test('a full 50,000-track result set fits the cache', () => {
  values.clear();
  const groups = Array.from({ length: 25_000 }, (_, index) => ({
    identity: `catalog:${index}`,
    name: `Song ${index}`,
    artist: 'Artist',
    positions: [index * 2 + 1, index * 2 + 2],
    copies: 2,
    extraCopies: 1,
  }));
  assert.equal(saveCachedScan({ ...scan, groups, totalTracks: 50_000 }), true);
  assert.equal(loadCachedScan('p.fixture')?.groups.length, 25_000);
});

test('clearing removes the cached scan', () => {
  assert.equal(saveCachedScan(scan), true);
  clearCachedScan();
  assert.equal(loadCachedScan('p.fixture'), null);
});

test('the theme preference defaults to auto and survives a round-trip', () => {
  values.delete('amdf:theme:v1');
  assert.equal(loadThemePreference(), 'auto');
  saveThemePreference('dark');
  assert.equal(loadThemePreference(), 'dark');
});

test('an unknown or corrupt theme preference falls back to auto', () => {
  values.set('amdf:theme:v1', 'purple');
  assert.equal(loadThemePreference(), 'auto');
  values.set('amdf:theme:v1', '');
  assert.equal(loadThemePreference(), 'auto');
});
