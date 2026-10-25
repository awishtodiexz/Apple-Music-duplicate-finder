import { ScanError } from './errors';
import type { PlaylistInfo, Track, TrackPage } from './types';

export interface PlaylistSource {
  metadata(): Promise<PlaylistInfo>;
  page(offset: number): Promise<TrackPage>;
}
export interface ScanProgress { retrieved: number; total: number | null; }
export interface PlaylistScan { info: PlaylistInfo; tracks: Track[]; countVerified: boolean; }

/** Preserve every occurrence. Nothing is returned on failure, including a failed final validation. */
export async function readPlaylist(
  source: PlaylistSource,
  onProgress: (progress: ScanProgress) => void = () => {},
): Promise<PlaylistScan> {
  const info = await source.metadata();
  let total = info.total;
  const tracks: Track[] = [];
  onProgress({ retrieved: 0, total });
  let finished = false;
  // A safety bound is an error, never a truncated success (up to one million entries).
  for (let pageNumber = 0; pageNumber < 10_001; pageNumber++) {
    const offset = tracks.length;
    const page = await source.page(offset);
    if (page.total !== null) {
      if (total !== null && total !== page.total) throw new ScanError('INCOMPLETE');
      total = page.total;
    }
    if (page.tracks.length > 100 || page.tracks.some((track, index) => track.position !== offset + index + 1)) {
      throw new ScanError('INCOMPLETE');
    }
    tracks.push(...page.tracks);
    if (total !== null && tracks.length > total) throw new ScanError('INCOMPLETE');
    onProgress({ retrieved: tracks.length, total });
    if (page.nextOffset !== null) {
      if (!page.tracks.length || page.nextOffset !== tracks.length || total === tracks.length) {
        throw new ScanError('INCOMPLETE');
      }
      continue;
    }
    if (total !== null && tracks.length === total) { finished = true; break; }
    if (page.tracks.length === 0) {
      if (total !== null && total !== tracks.length) throw new ScanError('INCOMPLETE');
      finished = true;
      break;
    }
    // Without a next link, probe the following offset, even after a short page.
    // This also verifies exact page boundaries rather than assuming a full page was last.
  }
  if (!finished) throw new ScanError('INCOMPLETE');
  const after = await source.metadata();
  if ((after.total !== null && after.total !== tracks.length) ||
    (info.modified !== null && after.modified !== info.modified) || after.name !== info.name) {
    throw new ScanError('INCOMPLETE');
  }
  return { info: after, tracks, countVerified: total !== null || after.total !== null };
}
