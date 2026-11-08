import { isThemePreference, type ThemePreference } from './theme';
import type { DuplicateGroup } from './types';

const cacheKey = 'amdf:last-scan:v1';
const themeKey = 'amdf:theme:v1';
const maxCacheChars = 2_000_000;

export interface CachedScan {
  version: 1;
  playlistId: string;
  playlistName: string;
  scannedAt: number;
  groups: DuplicateGroup[];
  unidentified: number;
  totalTracks: number;
  countVerified: boolean;
  modificationChecked: boolean;
  notes: string;
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

function isGroup(value: unknown): value is DuplicateGroup {
  if (!value || typeof value !== 'object') return false;
  const group = value as Partial<DuplicateGroup>;
  return typeof group.identity === 'string' && typeof group.name === 'string' &&
    typeof group.artist === 'string' && Array.isArray(group.positions) &&
    group.positions.length > 0 && group.positions.every(isCount) &&
    isCount(group.copies) && group.copies > 1 && isCount(group.extraCopies) &&
    group.extraCopies === group.copies - 1;
}

function isCachedScan(value: unknown): value is CachedScan {
  if (!value || typeof value !== 'object') return false;
  const scan = value as Partial<CachedScan>;
  return scan.version === 1 && typeof scan.playlistId === 'string' &&
    typeof scan.playlistName === 'string' && isCount(scan.scannedAt) &&
    Array.isArray(scan.groups) && scan.groups.every(isGroup) &&
    isCount(scan.unidentified) && isCount(scan.totalTracks) &&
    typeof scan.countVerified === 'boolean' && typeof scan.modificationChecked === 'boolean' &&
    typeof scan.notes === 'string';
}

/** The last completed scan is cached locally so closing the popup does not lose it. */
export function loadCachedScan(playlistId: string): CachedScan | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(cacheKey);
    if (!raw || raw.length > maxCacheChars) return null;
    const value: unknown = JSON.parse(raw);
    if (!isCachedScan(value) || value.playlistId !== playlistId) return null;
    return value;
  } catch {
    return null;
  }
}

/** Returns false when the result is too large or storage is unavailable; never throws. */
export function saveCachedScan(scan: CachedScan): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const raw = JSON.stringify(scan);
    if (raw.length > maxCacheChars) {
      store.removeItem(cacheKey);
      return false;
    }
    store.setItem(cacheKey, raw);
    return true;
  } catch {
    try { store.removeItem(cacheKey); } catch { /* ignore */ }
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
