import assert from 'node:assert/strict';
import test from 'node:test';
import { csvFilename, filterGroups, formatGroupText, formatResultsText, sortGroups, summarize, summaryLine, toCsv, visibleGroups } from '../src/results';
import type { DuplicateGroup } from '../src/types';

const group = (name: string, artist: string, positions: number[]): DuplicateGroup => ({
  identity: `catalog:${name}`,
  name,
  artist,
  positions,
  copies: positions.length,
  extraCopies: positions.length - 1,
});
const groups = [
  group('Zebra', 'Artist B', [1, 9]),
  group('Alpha', 'Artist C', [2, 3, 4]),
  group('Middle, Song', 'Artist A', [5, 6]),
];

test('filter matches song and artist case-insensitively and trims the query', () => {
  assert.deepEqual(filterGroups(groups, '  alpha ').map(g => g.name), ['Alpha']);
  assert.deepEqual(filterGroups(groups, 'artist a').map(g => g.name), ['Middle, Song']);
  assert.equal(filterGroups(groups, '').length, 3);
  assert.equal(filterGroups(groups, 'missing').length, 0);
});

test('sorting supports playlist order, copy count, song, and artist modes', () => {
  assert.deepEqual(sortGroups(groups, 'playlist').map(g => g.name), ['Zebra', 'Alpha', 'Middle, Song']);
  assert.deepEqual(sortGroups(groups, 'copies').map(g => g.name), ['Alpha', 'Zebra', 'Middle, Song']);
  assert.deepEqual(sortGroups(groups, 'song').map(g => g.name), ['Alpha', 'Middle, Song', 'Zebra']);
  assert.deepEqual(sortGroups(groups, 'artist').map(g => g.name), ['Middle, Song', 'Zebra', 'Alpha']);
  assert.deepEqual(visibleGroups(groups, 'artist', 'song').map(g => g.name), ['Alpha', 'Middle, Song', 'Zebra']);
});

test('the minimum-copies filter drops smaller groups and keeps the rest', () => {
  assert.equal(visibleGroups(groups, '', 'playlist', 2).length, 3);
  assert.deepEqual(visibleGroups(groups, '', 'playlist', 3).map(g => g.name), ['Alpha']);
  assert.equal(visibleGroups(groups, '', 'playlist', 9).length, 0);
  // Nonsense thresholds fall back to "every duplicate".
  assert.equal(visibleGroups(groups, '', 'playlist', Number.NaN).length, 3);
});

test('single-group copy text carries the song, copy count and positions', () => {
  assert.equal(formatGroupText(groups[1]!), 'Alpha — Artist C\n3 copies · positions 2, 3, 4');
});

test('summary counts groups, extra copies, and unidentified entries', () => {
  const summary = summarize(10, groups, 2);
  assert.deepEqual(summary, { scanned: 10, groups: 3, extraCopies: 4, unidentified: 2 });
  assert.match(summaryLine(summary), /10 songs scanned\n3 songs appear more than once · 4 extra copies/);
  assert.match(summaryLine(summarize(1, [group('One', 'A', [1, 2])], 0)), /1 song appears more than once · 1 extra copy/);
});

test('copy text includes all positions and scan notes', () => {
  const text = formatResultsText('My playlist', groups, summarize(10, groups, 0), 'No modification marker.');
  assert.match(text, /Apple Music Duplicate Finder — My playlist/);
  assert.match(text, /Zebra — Artist B — 2 copies — positions 1, 9/);
  assert.match(text, /No modification marker\./);
});

test('CSV escapes commas, quotes, newlines, and formula triggers', () => {
  const csv = toCsv([group('A, "B"', 'Line\nBreak', [1, 2]), group('=HYPERLINK("x")', '@artist', [3, 4])]);
  assert.equal(csv, 'Song,Artist,Copies,Extra copies,Positions\r\n' +
    '"A, ""B""","Line\nBreak",2,1,1 2\r\n' +
    '"\'=HYPERLINK(""x"")",\'@artist,2,1,3 4\r\n');
});

test('CSV filenames are stable and filesystem-safe', () => {
  assert.equal(csvFilename('My / playlist: 2026', new Date('2026-11-08T00:00:00Z')),
    'apple-music-duplicates-My-playlist-2026-2026-11-08.csv');
  assert.equal(csvFilename('', new Date('2026-11-08T00:00:00Z')),
    'apple-music-duplicates-playlist-2026-11-08.csv');
});
