import { ScanError } from './errors';
import type { PlaylistInfo, Track, TrackPage } from './types';

export interface PlaylistSource {
  metadata(signal?: AbortSignal): Promise<PlaylistInfo>;
  page(offset: number, signal?: AbortSignal): Promise<TrackPage>;
}
export interface ScanProgress {
  retrieved: number;
  total: number | null;
  elapsedMs: number;
  phase: 'reading' | 'validating';
}
export interface PlaylistScan {
  info: PlaylistInfo;
  tracks: Track[];
  countVerified: boolean;
  modificationChecked: boolean;
}
export const scanLimits = { deadlineMs: 300_000, maxTracks: 50_000, maxPages: 2_000, maxMetadataChars: 16_000_000 } as const;
export interface ScanOptions {
  signal?: AbortSignal;
  // Callers may tighten, but cannot bypass the production safety bounds.
  deadlineMs?: number;
  maxTracks?: number;
  maxPages?: number;
  maxMetadataChars?: number;
}

/** Preserve every occurrence. Failures, deadlines and cancellation never return partial results. */
export async function readPlaylist(
  source: PlaylistSource,
  onProgress: (progress: ScanProgress) => void = () => {},
  options: ScanOptions = {},
): Promise<PlaylistScan> {
  const limit = (key: keyof typeof scanLimits): number => {
    const value = options[key] ?? scanLimits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > scanLimits[key]) throw new ScanError('LIMIT');
    return value;
  };
  const deadlineMs = limit('deadlineMs');
  const maxTracks = limit('maxTracks');
  const maxPages = limit('maxPages');
  const maxMetadataChars = limit('maxMetadataChars');
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new ScanError('CANCELLED'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(new ScanError('DEADLINE')), deadlineMs);
  const check = (): void => {
    if (!controller.signal.aborted && Date.now() - started >= deadlineMs) controller.abort(new ScanError('DEADLINE'));
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  // Also handles sources that cannot abort: late replies cannot advance this scan.
  async function read<T>(operation: () => Promise<T>): Promise<T> {
    check();
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
        }),
        Promise.resolve().then(() => { check(); return operation(); }),
      ]).then(value => { check(); return value; });
    } finally {
      if (abort) controller.signal.removeEventListener('abort', abort);
    }
  }
  try {
    const info = await read(() => source.metadata(controller.signal));
    let total = info.total;
    const tracks: Track[] = [];
    let metadataChars = 0;
    const progress = (phase: ScanProgress['phase']): void => {
      check();
      onProgress({ retrieved: tracks.length, total, elapsedMs: Date.now() - started, phase });
      check();
    };
    if (total !== null && total > maxTracks) throw new ScanError('LIMIT');
    progress('reading');
    let finished = false;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const offset = tracks.length;
      const page = await read(() => source.page(offset, controller.signal));
      if (page.total !== null) {
        if (total !== null && total !== page.total) throw new ScanError('INCOMPLETE');
        total = page.total;
      }
      if ((total !== null && total > maxTracks) || offset + page.tracks.length > maxTracks) throw new ScanError('LIMIT');
      if (page.tracks.length > 100 || page.tracks.some((track, index) => track.position !== offset + index + 1)) {
        throw new ScanError('INCOMPLETE');
      }
      for (const track of page.tracks) {
        metadataChars += track.name.length + track.artist.length + (track.catalogId?.length ?? 0) + (track.libraryId?.length ?? 0);
      }
      if (metadataChars > maxMetadataChars) throw new ScanError('LIMIT');
      tracks.push(...page.tracks);
      if (total !== null && tracks.length > total) throw new ScanError('INCOMPLETE');
      progress('reading');
      if (page.nextOffset !== null) {
        if (!page.tracks.length || page.nextOffset !== tracks.length || total === tracks.length) throw new ScanError('INCOMPLETE');
        continue;
      }
      if (total !== null && tracks.length === total) { finished = true; break; }
      if (page.tracks.length === 0) {
        if (total !== null && total !== tracks.length) throw new ScanError('INCOMPLETE');
        finished = true;
        break;
      }
      // Probe after short/full pages with no continuation or known terminal total.
    }
    if (!finished) throw new ScanError('LIMIT');
    progress('validating');
    const after = await read(() => source.metadata(controller.signal));
    if ((after.total !== null && after.total !== tracks.length) ||
      (info.modified !== null && after.modified !== info.modified) ||
      (info.revision != null && after.revision !== info.revision) || after.name !== info.name) {
      throw new ScanError('INCOMPLETE');
    }
    return {
      info: after, tracks, countVerified: total !== null || after.total !== null,
      modificationChecked: info.modified !== null || info.revision != null,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
