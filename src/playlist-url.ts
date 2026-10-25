import { ScanError } from './errors';
import type { PlaylistRef } from './types';

/** Only the visible route is authoritative. Never search by name or use playback state. */
export function detectPlaylist(rawUrl: string): PlaylistRef {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ScanError('NOT_PLAYLIST'); }
  if (url.origin !== 'https://music.apple.com') throw new ScanError('NOT_PLAYLIST');
  const match = url.pathname.match(/^\/(?:(?<store>[a-z]{2})\/)?(?<library>library\/)?playlist\/(?:[^/]+\/)?(?<id>p\.[A-Za-z0-9-]+|pl\.[A-Za-z0-9-]+)\/?$/);
  const id = match?.groups?.id;
  if (!id || (match.groups?.library && !id.startsWith('p.'))) throw new ScanError('NOT_PLAYLIST');
  const kind = id.startsWith('p.') ? 'library' : 'catalog';
  return { id, kind, storefront: match.groups?.store ?? null, pathname: url.pathname };
}
