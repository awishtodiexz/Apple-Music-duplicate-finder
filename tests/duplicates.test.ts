import assert from 'node:assert/strict';
import test from 'node:test';
import { findDuplicates } from '../src/duplicates';
import type { Track } from '../src/types';

function tracks(ids: (string | null)[]): Track[] {
  return ids.map((id, index) => ({ position: index + 1, name: 'Same title', artist: 'Artist', catalogId: id, libraryId: null }));
}

test('empty playlist and distinct IDs have no duplicates', () => {
  assert.deepEqual(findDuplicates([]), { groups: [], extraCopies: 0, unidentified: 0 });
  assert.equal(findDuplicates(tracks(['1', '2', '3'])).groups.length, 0);
});
test('two identical IDs produce one extra copy', () => {
  const result = findDuplicates(tracks(['1', '1']));
  assert.equal(result.extraCopies, 1);
  assert.deepEqual(result.groups[0]?.positions, [1, 2]);
});
test('three occurrences retain original positions and counts', () => {
  const result = findDuplicates(tracks(['1', '2', '1', '1']));
  assert.deepEqual(result.groups[0], {
    identity: 'catalog:1', name: 'Same title', artist: 'Artist',
    positions: [1, 3, 4], copies: 3, extraCopies: 2,
  });
});
test('missing IDs are excluded even when titles match', () => {
  assert.deepEqual(findDuplicates(tracks([null, null])), { groups: [], extraCopies: 0, unidentified: 2 });
});
test('different songs with the same title never merge', () => {
  assert.equal(findDuplicates(tracks(['1', '2'])).groups.length, 0);
});
test('groups follow first appearance, not the order duplicates are discovered', () => {
  const result = findDuplicates(tracks(['3', '2', '2', '3', '1', '1']));
  assert.deepEqual(result.groups.map(group => group.identity), ['catalog:3', 'catalog:2', 'catalog:1']);
});
test('matching is independent of names and artists and does not mutate input', () => {
  const input = tracks(['1', '1']);
  input[1]!.name = 'Edited library title';
  input[1]!.artist = 'Edited artist';
  const before = structuredClone(input);
  assert.equal(findDuplicates(input).groups.length, 1);
  assert.deepEqual(input, before);
});
test('catalog ID wins over library IDs; repeated library-only IDs can match', () => {
  const input = tracks(['1', '1', null, null]);
  input[0]!.libraryId = 'i.a';
  input[1]!.libraryId = 'i.b';
  input[2]!.libraryId = 'i.c';
  input[3]!.libraryId = 'i.c';
  assert.deepEqual(findDuplicates(input).groups.map(group => group.identity), ['catalog:1', 'library:i.c']);
});
test('library and catalog namespaces cannot collide', () => {
  const input = tracks(['1', null]);
  input[1]!.libraryId = '1';
  assert.equal(findDuplicates(input).groups.length, 0);
});
test('thousands of occurrences are preserved', () => {
  const result = findDuplicates(tracks(Array.from({ length: 10_000 }, () => '1')));
  assert.equal(result.groups[0]?.copies, 10_000);
  assert.equal(result.groups[0]?.positions.at(-1), 10_000);
});

test('same library song matches when only one occurrence has a catalog ID', () => {
  for (const ids of [['123', null], [null, '123']]) {
    const input = tracks(ids);
    input.forEach(track => { track.libraryId = 'i.same'; });
    const before = structuredClone(input);
    const result = findDuplicates(input);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0]?.identity, 'catalog:123');
    assert.deepEqual(result.groups[0]?.positions, [1, 2]);
    assert.equal(result.extraCopies, 1);
    assert.equal(result.unidentified, 0);
    assert.deepEqual(input, before);
  }
});
test('unambiguous catalog mappings join library-only and catalog-only occurrences', () => {
  const input = tracks([null, '456', '123', '123', '123', '456']);
  input[0]!.libraryId = 'i.same';
  input[2]!.libraryId = 'i.same';
  input[3]!.libraryId = 'i.other';
  input[0]!.name = 'First title';
  const result = findDuplicates(input);
  assert.deepEqual(result.groups.map(group => group.identity), ['catalog:123', 'catalog:456']);
  assert.deepEqual(result.groups[0]?.positions, [1, 3, 4, 5]);
  assert.equal(result.groups[0]?.name, 'First title');
  assert.equal(result.extraCopies, 4);
});
test('conflicting catalog mappings never merge different songs through a library ID', () => {
  const input = tracks(['123', null, '456', null, '123', '123']);
  input.slice(0, 5).forEach(track => { track.libraryId = 'i.conflicting'; });
  const result = findDuplicates(input);
  assert.deepEqual(result.groups.map(group => group.identity), ['catalog:123']);
  assert.deepEqual(result.groups[0]?.positions, [1, 5, 6]);
  assert.equal(result.unidentified, 2);
  assert.equal(result.extraCopies, 2);
});
test('distinct library resources that map to one catalog song join its catalog occurrences', () => {
  // Both library entries carry their own unambiguous catalog ID, so the shared
  // recording is matched through the catalog namespace rather than the library.
  const input = tracks([null, null, '900', '900']);
  input[0]!.libraryId = 'i.a';
  input[1]!.libraryId = 'i.b';
  input[2]!.libraryId = 'i.a';
  input[3]!.libraryId = 'i.b';
  const result = findDuplicates(input);
  assert.deepEqual(result.groups.map(group => group.identity), ['catalog:900']);
  assert.deepEqual(result.groups[0]?.positions, [1, 2, 3, 4]);
  assert.equal(result.groups[0]?.copies, 4);
  assert.equal(result.extraCopies, 3);
  assert.equal(result.unidentified, 0);
});
test('late unambiguous mappings keep playlist order and the first appearance metadata', () => {
  const input = tracks(['2', null, '1', '2', null, '1']);
  input[1]!.libraryId = 'i.a';
  input[2]!.libraryId = 'i.a';
  input[4]!.libraryId = 'i.b';
  input[5]!.libraryId = 'i.b';
  input[1]!.name = 'Mapped first';
  input[1]!.artist = 'Mapped artist';
  const result = findDuplicates(input);
  // catalog:2 appears first even though catalog:1 resolves a mapping earlier.
  assert.deepEqual(result.groups.map(group => group.identity), ['catalog:2', 'catalog:1']);
  assert.deepEqual(result.groups.map(group => group.positions), [[1, 4], [2, 3, 5, 6]]);
  assert.equal(result.groups[1]?.name, 'Mapped first');
  assert.equal(result.groups[1]?.artist, 'Mapped artist');
  assert.equal(result.extraCopies, 4);
  assert.equal(result.unidentified, 0);
});
test('mapping conflicts are detected regardless of observation order', () => {
  for (const catalogIds of [['111', '222'], ['222', '111']]) {
    const input = tracks([null, ...catalogIds, null]);
    for (const track of input) track.libraryId = 'i.same';
    // The two library-only occurrences share their library ID, but the
    // contradictory catalog mappings leave both unidentified.
    const result = findDuplicates(input);
    assert.deepEqual(result.groups, []);
    assert.equal(result.unidentified, 2);
    assert.equal(result.extraCopies, 0);
  }
});

test('the 50,000-track limit keeps every position and group count', () => {
  const input: Track[] = Array.from({ length: 50_000 }, (_, index) => ({
    position: index + 1, name: 'Song', artist: 'Artist',
    catalogId: String(index % 25_000), libraryId: null,
  }));
  const result = findDuplicates(input);
  assert.equal(result.groups.length, 25_000);
  assert.equal(result.extraCopies, 25_000);
  assert.equal(result.unidentified, 0);
  assert.deepEqual(result.groups[0]?.positions, [1, 25_001]);
  assert.deepEqual(result.groups.at(-1)?.positions, [25_000, 50_000]);
});
