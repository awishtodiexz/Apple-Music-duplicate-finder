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
  // Plain toLowerCase keeps matching stable in locales that map I to a dotless ı.
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  return groups.filter(group =>
    group.name.toLowerCase().includes(needle) || group.artist.toLowerCase().includes(needle));
}

export function filterByCopies(groups: readonly DuplicateGroup[], minCopies: number): DuplicateGroup[] {
  if (!Number.isFinite(minCopies) || minCopies <= 2) return [...groups];
  return groups.filter(group => group.copies >= minCopies);
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

export function visibleGroups(groups: readonly DuplicateGroup[], query: string, mode: SortMode,
  minCopies = 2): DuplicateGroup[] {
  return sortGroups(filterByCopies(filterGroups(groups, query), minCopies), mode);
}

/**
 * The one rule for which copy stays: the first position is kept, every later
 * position is an extra copy. Rows, copy feedback and exports all read it here.
 */
export function splitPositions(group: Pick<DuplicateGroup, 'positions'>): { keep: number; extra: number[] } {
  const [keep = 0, ...extra] = group.positions;
  return { keep, extra };
}

export interface RemovalEntry {
  group: DuplicateGroup;
  position: number;
}

/** Global descending order keeps earlier snapshot positions valid during removal. */
export function removalChecklist(groups: readonly DuplicateGroup[]): RemovalEntry[] {
  return groups.flatMap(group => splitPositions(group).extra.map(position => ({ group, position })))
    .sort((a, b) => b.position - a.position);
}

export function compareScans(previous: readonly DuplicateGroup[], current: readonly DuplicateGroup[]) {
  const before = new Set(previous.map(group => group.identity));
  const after = new Set(current.map(group => group.identity));
  const extras = (rows: readonly DuplicateGroup[]) => rows.reduce((sum, group) => sum + group.extraCopies, 0);
  return {
    extraDelta: extras(current) - extras(previous),
    remaining: extras(current),
    resolved: previous.filter(group => !after.has(group.identity)),
    added: current.filter(group => !before.has(group.identity)),
  };
}

export function comparisonText(comparison: ReturnType<typeof compareScans>): string {
  const { extraDelta, remaining, resolved, added } = comparison;
  const change = extraDelta === 0 ? 'Extra-copy count unchanged' :
    `${Math.abs(extraDelta).toLocaleString()} ${extraDelta < 0 ? 'fewer' : 'more'} ${Math.abs(extraDelta) === 1 ? 'extra copy' : 'extra copies'}`;
  return `${change} · ${plural(remaining, 'extra copy', 'extra copies')} remaining.\n` +
    `${plural(resolved.length, 'song')} no longer repeated · ${plural(added.length, 'new repeated song')}.`;
}

// One formatter: toLocaleString builds a new one per call, which dominates drawing 1,200 rows.
const numberFormat = new Intl.NumberFormat();
const nbsp = '\u00A0';

/**
 * A row's positions as "#1 keep · #101 · #245". Each separator is glued to the position
 * before it with a no-break space, so a wrapped line can end with "·" but never start
 * with one. `limit` caps how many positions are written; the rest become a "+N more" token.
 */
export function positionParts(group: Pick<DuplicateGroup, 'positions'>, limit = Infinity): { keep: string; extras: string } {
  const { keep, extra } = splitPositions(group);
  const shown = extra.slice(0, Math.max(0, limit - 1));
  const hidden = extra.length - shown.length;
  const tokens = [`#${numberFormat.format(keep)}${nbsp}keep`, ...shown.map(position => `#${numberFormat.format(position)}`)];
  if (hidden > 0) tokens.push(`+${numberFormat.format(hidden)}${nbsp}more`);
  const joined = tokens.map((token, index) => index < tokens.length - 1 ? `${token}${nbsp}·` : token);
  return { keep: joined[0]!, extras: joined.length > 1 ? ` ${joined.slice(1).join(' ')}` : '' };
}

const groupKey = (group: DuplicateGroup): string => `${group.name.trim().toLowerCase()}\u0000${group.artist.trim().toLowerCase()}`;

/**
 * Identities of rows whose name and artist match another row. Groups are keyed by Apple Music
 * ID, so two such rows are different Apple Music songs (another version or release) that happen
 * to share a title; nothing else in the scan data tells them apart.
 */
export function lookalikeIdentities(groups: readonly DuplicateGroup[]): Set<string> {
  const byKey = new Map<string, DuplicateGroup[]>();
  for (const group of groups) {
    const key = groupKey(group);
    byKey.set(key, [...(byKey.get(key) ?? []), group]);
  }
  const lookalikes = new Set<string>();
  for (const sharing of byKey.values()) {
    if (sharing.length > 1) for (const group of sharing) lookalikes.add(group.identity);
  }
  return lookalikes;
}

/** The Apple Music ID a group was matched on, without the catalog/library prefix. */
export function appleMusicId(group: Pick<DuplicateGroup, 'identity'>): string {
  return group.identity.replace(/^(?:catalog|library):/, '');
}

export interface ExportLabels {
  copy: string;
  copyName: string;
  csv: string;
  csvName: string;
  copied: string;
  downloaded: string;
}

/**
 * What Copy and CSV export, with the count. They export every song matching the current
 * filters, which is more than the rows drawn so far, so the count is the filtered total.
 */
export function exportLabels(count: number, filtered: boolean): ExportLabels {
  const n = count.toLocaleString();
  const songs = count === 1 ? 'song' : 'songs';
  if (count === 0) {
    return { copy: 'Copy all', copyName: 'Copy all repeated songs', csv: 'CSV', csvName: 'Download repeated songs as CSV',
      copied: '', downloaded: '' };
  }
  return {
    copy: `Copy all ${n}`,
    copyName: `Copy all ${n} ${filtered ? 'matching ' : ''}repeated ${songs}`,
    csv: `CSV (${n})`,
    csvName: `Download CSV (${n}) of ${filtered ? 'matching' : 'all'} repeated songs`,
    copied: filtered ? `Copied ${n} matching ${songs}.` : `Copied all ${n} ${songs}.`,
    downloaded: filtered ? `Downloaded ${n} matching ${songs} as CSV.` : `Downloaded all ${n} ${songs} as CSV.`,
  };
}

export type ScanOutcome = 'empty' | 'unchecked' | 'clean' | 'duplicates';

export function scanOutcome(summary: ResultSummary): ScanOutcome {
  if (summary.scanned === 0) return 'empty';
  if (summary.groups > 0) return 'duplicates';
  // Without any Apple Music IDs, "no repeats" would claim a check that never ran.
  return summary.unidentified === summary.scanned ? 'unchecked' : 'clean';
}

export const outcomeTitle: Record<ScanOutcome, string> = {
  empty: 'This playlist is empty',
  unchecked: 'Nothing could be checked',
  clean: 'No repeated songs',
  duplicates: 'Scan complete',
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function summaryLine(summary: ResultSummary): string {
  switch (scanOutcome(summary)) {
    case 'empty':
      return 'There are no songs to check.';
    case 'unchecked':
      return `${plural(summary.scanned, 'song')} had no Apple Music ID, so repeats could not be checked.`;
    case 'clean': {
      const checked = `${plural(summary.scanned, 'song')} checked · no repeats found`;
      if (summary.unidentified === 0) return checked;
      return `${checked}\n${plural(summary.unidentified, 'song')} had no Apple Music ID and ` +
        `${summary.unidentified === 1 ? 'was' : 'were'} skipped.`;
    }
    case 'duplicates':
      return `${plural(summary.scanned, 'song')} checked · ${plural(summary.groups, 'repeated song')} · ` +
        plural(summary.extraCopies, 'extra copy', 'extra copies');
  }
}

export function formatResultsText(playlistName: string, groups: readonly DuplicateGroup[],
  summary: ResultSummary, notes: string): string {
  const lines = [
    `Apple Music Playlist Duplicate Finder — ${playlistName}`,
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

/** A single group, for the per-song copy button. */
export function formatGroupText(group: DuplicateGroup): string {
  const copies = `${group.copies.toLocaleString()} ${group.copies === 1 ? 'copy' : 'copies'}`;
  return `${group.name} — ${group.artist}\n${copies} · positions ${group.positions.join(', ')}`;
}

// Spreadsheet programs may trim or ignore leading whitespace, control and format
// characters before deciding whether a cell is a formula, so checking only byte
// zero is not enough. The apostrophe is visible text, not a secret.
const leadingInvisible = /^[\s\p{Cc}\p{Cf}]+/u;
const formulaTrigger = /^[=+\-@\t\r\n\u2212\uff0b\uff0d\uff1d\uff20]/;

function csvField(value: string): string {
  const firstVisible = value.replace(leadingInvisible, '');
  const safe = formulaTrigger.test(value) || formulaTrigger.test(firstVisible) ? `'${value}` : value;
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
