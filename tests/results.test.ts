import assert from 'node:assert/strict';
import test from 'node:test';
import { appleMusicId, compareScans, comparisonText, csvFilename, exportLabels, filterGroups, formatGroupText, formatResultsText, lookalikeIdentities, outcomeTitle, positionParts, removalChecklist, scanOutcome, sortGroups, splitPositions, summarize, summaryLine, toCsv, visibleGroups } from '../src/results';
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

test('removal checklist interleaves songs in descending position and excludes every kept copy', () => {
  const entries = removalChecklist(groups);
  assert.deepEqual(entries.map(entry => entry.position), [9, 6, 4, 3]);
  assert.deepEqual(entries.map(entry => entry.group.name), ['Zebra', 'Middle, Song', 'Alpha', 'Alpha']);
  assert.deepEqual(groups.map(group => group.positions), [[1, 9], [2, 3, 4], [5, 6]]);
  assert.deepEqual(removalChecklist([]), []);
});

test('rescan comparison tracks exact identities even when counts balance or positions and names change', () => {
  const before = [group('A', 'Artist', [1, 3, 8]), group('B', 'Artist', [2, 9])];
  const after = [{ ...group('Renamed A', 'Artist', [1, 4]), identity: 'catalog:A' }, group('C', 'Artist', [2, 5, 6])];
  const comparison = compareScans(before, after);
  assert.equal(comparison.extraDelta, 0);
  assert.equal(comparison.remaining, 3);
  assert.deepEqual(comparison.resolved.map(group => group.name), ['B']);
  assert.deepEqual(comparison.added.map(group => group.name), ['C']);
  assert.match(comparisonText(comparison), /count unchanged.*3 extra copies remaining/);
});

test('comparison describes partial cleanup, a clean playlist, and increasing duplicates', () => {
  const before = [group('A', 'Artist', [1, 3, 8])];
  const partial = compareScans(before, [group('A', 'Artist', [1, 3])]);
  assert.match(comparisonText(partial), /1 fewer extra copy · 1 extra copy remaining/);
  assert.equal(partial.resolved.length, 0);
  assert.match(comparisonText(compareScans(before, [])), /2 fewer extra copies · 0 extra copies remaining/);
  assert.match(comparisonText(compareScans([], before)), /2 more extra copies/);
});

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

test('the first position is the copy to keep and every later one is extra', () => {
  assert.deepEqual(splitPositions(group('Alpha', 'Artist C', [2, 3, 4])), { keep: 2, extra: [3, 4] });
  assert.deepEqual(splitPositions(group('Pair', 'A', [7, 9])), { keep: 7, extra: [9] });
  const split = splitPositions(groups[1]!);
  assert.equal(split.extra.length, groups[1]!.extraCopies);
});

test('positions read "#1 keep · #101 · #245" and never wrap a line onto a separator', () => {
  const parts = positionParts(group('Numb', 'Linkin Park', [1, 101, 245]));
  assert.equal(parts.keep + parts.extras, '#1\u00A0keep\u00A0· #101\u00A0· #245');
  // Every separator is glued to the position before it, so only a space can break a line.
  assert.doesNotMatch(parts.keep + parts.extras, / ·/);
  assert.equal(positionParts(group('Pair', 'A', [1, 2000])).extras, ' #2,000');
});

test('a long position list is capped and says how many it left out', () => {
  const many = group('Loop', 'A', Array.from({ length: 6000 }, (_, index) => index + 1));
  const parts = positionParts(many, 50);
  assert.equal(parts.keep, '#1\u00A0keep\u00A0·');
  assert.equal(parts.extras.split('#').length - 1, 49);
  assert.ok(parts.extras.endsWith('+5,950\u00A0more'));
  assert.ok(positionParts(many).extras.endsWith('#6,000'));
});

test('rows that share a name and artist are flagged, and only those', () => {
  const rows = [
    { ...group('Numb', 'Linkin Park', [1, 2]), identity: 'catalog:1000' },
    { ...group('Other', 'Linkin Park', [3, 4]), identity: 'catalog:1001' },
    { ...group(' numb ', 'LINKIN PARK', [5, 6]), identity: 'catalog:1100' },
  ];
  assert.deepEqual([...lookalikeIdentities(rows)], ['catalog:1000', 'catalog:1100']);
  assert.equal(lookalikeIdentities(groups).size, 0);
  assert.equal(appleMusicId(rows[2]!), '1100');
  assert.equal(appleMusicId({ identity: 'library:i.ABC' }), 'i.ABC');
});

test('export labels name the filtered count and what they export', () => {
  assert.deepEqual(exportLabels(1200, false), {
    copy: 'Copy all 1,200', copyName: 'Copy all 1,200 repeated songs',
    csv: 'CSV (1,200)', csvName: 'Download CSV (1,200) of all repeated songs',
    copied: 'Copied all 1,200 songs.', downloaded: 'Downloaded all 1,200 songs as CSV.',
  });
  const filtered = exportLabels(3, true);
  assert.equal(filtered.copy, 'Copy all 3');
  assert.equal(filtered.copyName, 'Copy all 3 matching repeated songs');
  assert.equal(filtered.csvName, 'Download CSV (3) of matching repeated songs');
  assert.equal(filtered.copied, 'Copied 3 matching songs.');
  assert.equal(exportLabels(1, true).downloaded, 'Downloaded 1 matching song as CSV.');
  // Each visible label stays inside its accessible name.
  for (const labels of [exportLabels(1200, false), filtered]) {
    assert.ok(labels.copyName.startsWith(labels.copy));
    assert.ok(labels.csvName.includes(labels.csv));
  }
});

test('single-group copy text carries the song, copy count and positions', () => {
  assert.equal(formatGroupText(groups[1]!), 'Alpha — Artist C\n3 copies · positions 2, 3, 4');
});

test('summary counts groups, extra copies, and unidentified songs', () => {
  const summary = summarize(10, groups, 2);
  assert.deepEqual(summary, { scanned: 10, groups: 3, extraCopies: 4, unidentified: 2 });
  assert.equal(summaryLine(summary), '10 songs checked · 3 repeated songs · 4 extra copies');
  assert.equal(summaryLine(summarize(1, [group('One', 'A', [1, 2])], 0)), '1 song checked · 1 repeated song · 1 extra copy');
});

test('a playlist with no songs says so instead of claiming a check', () => {
  const summary = summarize(0, [], 0);
  assert.equal(scanOutcome(summary), 'empty');
  assert.equal(outcomeTitle.empty, 'This playlist is empty');
  assert.equal(summaryLine(summary), 'There are no songs to check.');
});

test('songs without Apple Music IDs are not reported as repeat-free', () => {
  const one = summarize(1, [], 1);
  assert.equal(scanOutcome(one), 'unchecked');
  assert.equal(outcomeTitle.unchecked, 'Nothing could be checked');
  assert.equal(summaryLine(one), '1 song had no Apple Music ID, so repeats could not be checked.');
  const many = summarize(245, [], 245);
  assert.equal(scanOutcome(many), 'unchecked');
  assert.equal(summaryLine(many), '245 songs had no Apple Music ID, so repeats could not be checked.');
  assert.doesNotMatch(summaryLine(many), /no repeats|No duplicate/);
});

test('a clean scan reports the songs checked and how many lacked an ID', () => {
  const clean = summarize(245, [], 0);
  assert.equal(scanOutcome(clean), 'clean');
  assert.equal(outcomeTitle.clean, 'No repeated songs');
  assert.equal(summaryLine(clean), '245 songs checked · no repeats found');
  assert.equal(summaryLine(summarize(1, [], 0)), '1 song checked · no repeats found');
  assert.equal(summaryLine(summarize(245, [], 1)),
    '245 songs checked · no repeats found\n1 song had no Apple Music ID and was skipped.');
  assert.equal(summaryLine(summarize(245, [], 3)),
    '245 songs checked · no repeats found\n3 songs had no Apple Music ID and were skipped.');
});

test('a scan with repeats reports the title and plural counts', () => {
  const summary = summarize(245, groups, 0);
  assert.equal(scanOutcome(summary), 'duplicates');
  assert.equal(outcomeTitle.duplicates, 'Scan complete');
  assert.equal(summaryLine(summary), '245 songs checked · 3 repeated songs · 4 extra copies');
  assert.equal(summaryLine(summarize(1000, [group('One', 'A', [1, 2])], 0)),
    '1,000 songs checked · 1 repeated song · 1 extra copy');
});

test('copy text includes all positions and scan notes', () => {
  const text = formatResultsText('My playlist', groups, summarize(10, groups, 0), 'No modification marker.');
  assert.match(text, /Apple Music Playlist Duplicate Finder — My playlist/);
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

test('long playlist names are truncated before the date suffix', () => {
  assert.equal(csvFilename('A'.repeat(100), new Date('2026-11-08T00:00:00Z')),
    `apple-music-duplicates-${'A'.repeat(60)}-2026-11-08.csv`);
});
