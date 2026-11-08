import { ScanError } from './errors';
import type { PlaylistRef } from './types';

const playlistId = /^(?:p\.[A-Za-z0-9-]{1,126}|pl\.[A-Za-z0-9-]{1,126})$/;
const routeMarker = /^playlists?$/i;

/**
 * Only the visible route is authoritative. Never search by name or use playback state.
 * The route is parsed by segments rather than one anchored regex so cosmetic changes
 * Apple makes around the ID (extra name segments, a trailing view segment, a plural
 * `playlists` prefix) do not break detection, while two IDs stay ambiguous and fail.
 */
export function detectPlaylist(rawUrl: string): PlaylistRef {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ScanError('NOT_PLAYLIST'); }
  if (url.origin !== 'https://music.apple.com') throw new ScanError('NOT_PLAYLIST');
  const segments = url.pathname.split('/').filter(Boolean);
  const marker = segments.findIndex(segment => routeMarker.test(segment));
  if (marker < 0) throw new ScanError('NOT_PLAYLIST');
  const ids = segments.slice(marker + 1).filter(segment => playlistId.test(segment));
  if (ids.length !== 1) throw new ScanError('NOT_PLAYLIST');
  const id = ids[0]!;
  const prefix = segments.slice(0, marker).map(segment => segment.toLowerCase());
  if (prefix.includes('library') && !id.startsWith('p.')) throw new ScanError('NOT_PLAYLIST');
  const storefront = prefix.find(segment => /^[a-z]{2}$/.test(segment)) ?? null;
  return { id, kind: id.startsWith('p.') ? 'library' : 'catalog', storefront };
}
