import type { DuplicateGroup, Track } from './types';

export interface DuplicateResult {
  groups: DuplicateGroup[];
  extraCopies: number;
  unidentified: number;
}

/** O(n), exact identifiers only. Map insertion order preserves first appearance. */
export function findDuplicates(tracks: readonly Track[]): DuplicateResult {
  // Resolve partial metadata across the full scan before grouping. null marks a
  // conflicting mapping, which must never connect different catalog recordings.
  const libraryToCatalog = new Map<string, string | null>();
  for (const track of tracks) {
    if (!track.libraryId || !track.catalogId) continue;
    if (!libraryToCatalog.has(track.libraryId)) {
      libraryToCatalog.set(track.libraryId, track.catalogId);
    } else if (libraryToCatalog.get(track.libraryId) !== track.catalogId) {
      libraryToCatalog.set(track.libraryId, null);
    }
  }
  const byIdentity = new Map<string, DuplicateGroup>();
  let unidentified = 0;
  for (const track of tracks) {
    const mapping = track.libraryId ? libraryToCatalog.get(track.libraryId) : undefined;
    const catalogId = track.catalogId || mapping;
    const identity = catalogId ? `catalog:${catalogId}` :
      track.libraryId && mapping !== null ? `library:${track.libraryId}` : null;
    if (!identity) { unidentified++; continue; }
    const group = byIdentity.get(identity);
    if (group) {
      group.positions.push(track.position);
      group.copies++;
      group.extraCopies++;
    } else {
      byIdentity.set(identity, {
        identity, name: track.name, artist: track.artist,
        positions: [track.position], copies: 1, extraCopies: 0,
      });
    }
  }
  const groups = [...byIdentity.values()].filter(group => group.copies > 1);
  return { groups, extraCopies: groups.reduce((sum, group) => sum + group.extraCopies, 0), unidentified };
}
