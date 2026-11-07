import { ScanError } from './errors';
import type { ErrorCode, PlaylistInfo, Track, TrackPage } from './types';

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
export const scanLimits = { deadlineMs: 600_000, maxTracks: 50_000, maxPages: 2_000, maxMetadataChars: 16_000_000 } as const;

/**
 * Every request is an idempotent GET and each page is re-validated for contiguous
 * positions, totals and continuation offsets before it is accepted, so retrying
 * the same offset cannot smuggle in partial or reordered data.
 */
const retryableErrors: ReadonlySet<ErrorCode> = new Set(['NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'SERVER']);
const retryDelaysMs: readonly number[] = [500, 1_500];

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
  // Wall clock can jump backwards; the deadline must never extend because of it.
  let lastTimestamp = started;
  const now = (): number => {
    lastTimestamp = Math.max(lastTimestamp, Date.now());
    return lastTimestamp;
  };
  const timer = setTimeout(() => controller.abort(new ScanError('DEADLINE')), deadlineMs);
  const check = (): void => {
    if (!controller.signal.aborted && now() - started >= deadlineMs) controller.abort(new ScanError('DEADLINE'));
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
  const sleep = (ms: number): Promise<void> => new Promise((resolve, reject) => {
    if (controller.signal.aborted) { reject(controller.signal.reason); return; }
    const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(controller.signal.reason); };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  // A single transient failure must not discard a long scan; only retryable
  // transport failures are repeated, and the overall deadline still applies.
  async function readWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read(operation);
      } catch (error) {
        if (!(error instanceof ScanError) || !retryableErrors.has(error.code) ||
          attempt >= retryDelaysMs.length) throw error;
        await sleep(retryDelaysMs[attempt]!);
        check();
      }
    }
  }
  try {
    const info = await readWithRetry(() => source.metadata(controller.signal));
    let total = info.total;
    const tracks: Track[] = [];
    let metadataChars = 0;
    const progress = (phase: ScanProgress['phase']): void => {
      check();
      onProgress({ retrieved: tracks.length, total, elapsedMs: now() - started, phase });
      check();
    };
    if (total !== null && total > maxTracks) throw new ScanError('LIMIT');
    progress('reading');
    let finished = false;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const offset = tracks.length;
      const page = await readWithRetry(() => source.page(offset, controller.signal));
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
    const after = await readWithRetry(() => source.metadata(controller.signal));
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
