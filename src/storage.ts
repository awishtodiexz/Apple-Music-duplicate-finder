import { isThemePreference, type ThemePreference } from './theme';
import type { DuplicateGroup, PlaylistInfo } from './types';

const cacheKey = 'amdf:last-scan:v1';
const themeKey = 'amdf:theme:v1';
// Chromium allows 5,000,000 characters per origin; a full 50,000-track scan with
// 25,000 groups measures 2.97 MB, so this leaves headroom without risking quota errors.
const maxCacheChars = 4_500_000;
// The cache is untrusted persisted data. Keep it within the same bounds the
// scanner enforces so a corrupt or tampered entry cannot render an inconsistent
// or unbounded result set.
const maxTracks = 50_000;
const maxGroups = Math.floor(maxTracks / 2);
const maxText = 2_000;
const maxIdentity = 256;
const maxNotes = 20_000;
// ECMAScript's maximum valid Date value; larger timestamps render as "Invalid Date".
const maxTimestamp = 8_640_000_000_000_000;
const playlistIdPattern = /^(?:p|pl)\.[A-Za-z0-9-]{1,126}$/;

export interface CachedScan {
  version: 1;
  playlistId: string;
  storefront?: string | null;
  playlistName: string;
  scannedAt: number;
  groups: DuplicateGroup[];
  unidentified: number;
  totalTracks: number;
  countVerified: boolean;
  modificationChecked: boolean;
  notes: string;
  /** Metadata markers captured at scan time; absent in caches written before v1.2.1. */
  modified?: string | null;
  revision?: string | null;
}

export type CacheFreshness = 'current' | 'changed' | 'unknown';

/**
 * A scan is stale when a known marker or the known track total differs. Every
 * marker available on both sides must agree: a matching modification date must
 * not hide a changed revision hash. Missing markers prove nothing.
 */
export function cacheFreshness(scan: CachedScan, info: PlaylistInfo): CacheFreshness {
  if (typeof info.total === 'number' && scan.totalTracks !== info.total) return 'changed';
  const comparable: Array<[string | null | undefined, string | null | undefined]> = [
    [scan.modified, info.modified],
    [scan.revision, info.revision],
  ];
  let matched = false;
  for (const [cached, current] of comparable) {
    if (!cached || !current) continue;
    if (cached !== current) return 'changed';
    matched = true;
  }
  return matched ? 'current' : 'unknown';
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPosition(value: unknown): value is number {
  return isCount(value) && value >= 1 && value <= maxTracks;
}

/**
 * A cached group must satisfy the same invariants the detector and reader
 * guarantee: one ascending, unique, one-based position per copy. A parsed JSON
 * cache is untrusted input, not a trusted typed value.
 */
function isGroup(value: unknown): value is DuplicateGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const group = value as Partial<DuplicateGroup>;
  if (typeof group.identity !== 'string' || group.identity.length === 0 ||
    group.identity.length > maxIdentity) return false;
  if (typeof group.name !== 'string' || group.name.length > maxText ||
    typeof group.artist !== 'string' || group.artist.length > maxText) return false;
  if (!isCount(group.copies) || group.copies <= 1 || !isCount(group.extraCopies) ||
    group.extraCopies !== group.copies - 1) return false;
  if (!Array.isArray(group.positions) || group.positions.length !== group.copies ||
    group.positions.length > maxTracks) return false;
  let previous = 0;
  for (const position of group.positions) {
    if (!isPosition(position) || position <= previous) return false;
    previous = position;
  }
  return true;
}

function optionalText(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= maxText);
}

function isCachedScan(value: unknown): value is CachedScan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scan = value as Partial<CachedScan>;
  const { version, playlistId, playlistName, scannedAt, groups, unidentified, totalTracks } = scan;
  if (version !== 1 || typeof playlistId !== 'string' || !playlistIdPattern.test(playlistId) ||
    typeof playlistName !== 'string' || playlistName.length > maxText ||
    !isCount(scannedAt) || scannedAt <= 0 || scannedAt > maxTimestamp ||
    !Array.isArray(groups) || groups.length > maxGroups ||
    !isCount(unidentified) || unidentified > maxTracks ||
    !isCount(totalTracks) || totalTracks > maxTracks || unidentified > totalTracks ||
    typeof scan.countVerified !== 'boolean' || typeof scan.modificationChecked !== 'boolean' ||
    typeof scan.notes !== 'string' || scan.notes.length > maxNotes ||
    !optionalText(scan.modified) || !optionalText(scan.revision) ||
    !(scan.storefront == null || /^[a-z]{2}$/.test(scan.storefront))) return false;
  // Every track is either unidentified or belongs to exactly one retained group,
  // so these totals bound the whole cache and catch inconsistent copies/counts.
  const identities = new Set<string>();
  const usedPositions = new Set<number>();
  let copies = 0;
  for (const group of groups) {
    if (!isGroup(group) || identities.has(group.identity)) return false;
    identities.add(group.identity);
    copies += group.copies;
    if (copies + unidentified > totalTracks) return false;
    for (const position of group.positions) {
      if (position > totalTracks || usedPositions.has(position)) return false;
      usedPositions.add(position);
    }
  }
  return true;
}

function discardCached(store: Storage): void {
  try { store.removeItem(cacheKey); } catch { /* ignore */ }
}

/** The last completed scan is cached locally so closing the popup does not lose it. */
export function loadCachedScan(playlistId: string, storefront: string | null = null): CachedScan | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(cacheKey);
    if (!raw) return null;
    if (raw.length > maxCacheChars) { discardCached(store); return null; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { discardCached(store); return null; }
    if (!isCachedScan(value)) { discardCached(store); return null; }
    return value.playlistId === playlistId &&
      (!playlistId.startsWith('pl.') || (storefront !== null && value.storefront === storefront)) ? value : null;
  } catch {
    return null;
  }
}

/** Returns false when the result is too large or storage is unavailable; never throws. */
export function saveCachedScan(scan: CachedScan): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (!isCachedScan(scan)) { discardCached(store); return false; }
    const raw = JSON.stringify(scan);
    if (raw.length > maxCacheChars) {
      // The new completed scan supersedes any older cache. Keeping the old data
      // would present a superseded scan as "the last scan" after a reopen.
      discardCached(store);
      return false;
    }
    store.setItem(cacheKey, raw);
    return true;
  } catch {
    // Never leave a superseded cache behind when the replacement failed.
    discardCached(store);
    return false;
  }
}

export function clearCachedScan(): void {
  const store = storage();
  if (!store) return;
  try { store.removeItem(cacheKey); } catch { /* ignore */ }
}

/** Missing, unreadable, or unknown values fall back to the system theme. */
export function loadThemePreference(): ThemePreference {
  const store = storage();
  if (!store) return 'auto';
  try {
    const value = store.getItem(themeKey);
    return isThemePreference(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  const store = storage();
  if (!store) return;
  try { store.setItem(themeKey, preference); } catch { /* ignore */ }
}

/** Scans use a persistent window unless the user explicitly chooses the popup. */
export function loadScanWindowPreference(): boolean {
  try { return storage()?.getItem('amdf:scan-window:v1') !== 'false'; } catch { return true; }
}

export function saveScanWindowPreference(enabled: boolean): void {
  try { storage()?.setItem('amdf:scan-window:v1', String(enabled)); } catch { /* ignore */ }
}
