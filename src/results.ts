import type { DuplicateGroup } from './types';

export type SortMode = 'playlist' | 'copies' | 'song' | 'artist';

export interface ResultSummary {
  scanned: number;
  groups: number;
  extraCopies: number;
  unidentified: number;
}

export function summarize(scanned: number, groups: readonly DuplicateGroup[], unidentified: number): ResultSummary {
  return {
    scanned,
    groups: groups.length,
    extraCopies: groups.reduce((sum, group) => sum + group.extraCopies, 0),
    unidentified,
  };
}

export function filterGroups(groups: readonly DuplicateGroup[], query: string): DuplicateGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...groups];
  return groups.filter(group =>
    group.name.toLocaleLowerCase().includes(needle) || group.artist.toLocaleLowerCase().includes(needle));
}

export function sortGroups(groups: readonly DuplicateGroup[], mode: SortMode): DuplicateGroup[] {
  const sorted = [...groups];
  switch (mode) {
    case 'copies':
      sorted.sort((a, b) => b.copies - a.copies || a.positions[0]! - b.positions[0]!);
      break;
    case 'song':
      sorted.sort((a, b) => a.name.localeCompare(b.name) || a.artist.localeCompare(b.artist));
      break;
    case 'artist':
      sorted.sort((a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name));
      break;
    case 'playlist':
      break;
  }
  return sorted;
}

export function visibleGroups(groups: readonly DuplicateGroup[], query: string, mode: SortMode): DuplicateGroup[] {
  return sortGroups(filterGroups(groups, query), mode);
}

export function summaryLine(summary: ResultSummary): string {
  const songs = `${summary.groups.toLocaleString()} ${summary.groups === 1 ? 'song appears' : 'songs appear'} more than once`;
  const extras = `${summary.extraCopies.toLocaleString()} ${summary.extraCopies === 1 ? 'extra copy' : 'extra copies'}`;
  return `${summary.scanned.toLocaleString()} songs scanned\n${songs} · ${extras}`;
}

export function formatResultsText(playlistName: string, groups: readonly DuplicateGroup[],
  summary: ResultSummary, notes: string): string {
  const lines = [
    `Apple Music Duplicate Finder — ${playlistName}`,
    summaryLine(summary),
  ];
  if (notes.trim()) lines.push('', notes.trim());
  lines.push('');
  for (const group of groups) {
    lines.push(`${group.name} — ${group.artist} — ${group.copies.toLocaleString()} ${group.copies === 1 ? 'copy' : 'copies'} ` +
      `— positions ${group.positions.join(', ')}`);
  }
  return lines.join('\n');
}

function csvField(value: string): string {
  // Prevent spreadsheet formula execution when a song or artist name begins
  // with a formula trigger. The apostrophe is visible text, not a secret.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(groups: readonly DuplicateGroup[]): string {
  const rows = [['Song', 'Artist', 'Copies', 'Extra copies', 'Positions']];
  for (const group of groups) {
    rows.push([group.name, group.artist, String(group.copies), String(group.extraCopies), group.positions.join(' ')]);
  }
  return rows.map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export function csvFilename(playlistName: string, scannedAt: Date = new Date()): string {
  const base = playlistName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'playlist';
  const date = scannedAt.toISOString().slice(0, 10);
  return `apple-music-duplicates-${base}-${date}.csv`;
}
