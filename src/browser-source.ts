import { ScanError } from './errors';
import { cancelMusicKitRead, musicKitBridge } from './musickit-bridge';
import type { PlaylistSource } from './playlist-reader';
import { bridgeErrorCodes, type BridgeReply, type BridgeRequest, type PlaylistInfo, type PlaylistRef, type TrackPage } from './types';

/**
 * A wedged renderer, a discarded tab or a navigation can leave executeScript
 * unsettled forever. The page-side timeout cannot help there because it only
 * starts after the injected function begins running.
 */
const injectionTimeoutMs = 30_000;

/** Cross-context replies are untrusted; arrays with custom properties are not records. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createBrowserSource(tabId: number, playlist: PlaylistRef): PlaylistSource {
  /**
   * Chrome localizes injection errors, so prefer tab state over matching English
   * text. The message fallback is only used when the tabs API is unavailable.
   */
  async function tabState(): Promise<'missing' | 'other' | 'ok' | 'unknown'> {
    if (typeof chrome.tabs?.get !== 'function') return 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return 'missing';
      if (typeof tab.url !== 'string' || !tab.url) return 'unknown';
      return tab.url.startsWith('https://music.apple.com/') ? 'ok' : 'other';
    } catch {
      return 'missing';
    }
  }
  async function call(request: BridgeRequest, signal?: AbortSignal): Promise<PlaylistInfo | TrackPage> {
    if (signal?.aborted) throw new ScanError('CANCELLED');
    const requestId = crypto.randomUUID();
    let abort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelInPage = (): void => {
      // Best effort: navigation/permission loss may prevent this injection.
      // A synchronous throw here must not escape an abort or timeout handler.
      try {
        const pending = chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
          func: cancelMusicKitRead, args: [requestId] });
        void Promise.resolve(pending).catch(() => {});
      } catch { /* best effort */ }
    };
    try {
      // Keep the call inside the try: argument validation or an unavailable
      // scripting API can throw synchronously instead of rejecting.
      const pending = chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: musicKitBridge,
        args: [{ ...request, requestId }],
      });
      const frames = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          abort = () => { reject(new ScanError('CANCELLED')); cancelInPage(); };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new ScanError('TIMEOUT')); cancelInPage(); }, injectionTimeoutMs);
        }),
      ]);
      if (signal?.aborted) throw new ScanError('CANCELLED');
      const reply: BridgeReply | undefined = frames[0]?.result;
      if (!reply) throw new ScanError('PAGE_CHANGED');
      if (!plainRecord(reply) || typeof reply.ok !== 'boolean') throw new ScanError('FORMAT');
      if (!reply.ok) {
        if (!bridgeErrorCodes.includes(reply.code)) throw new ScanError('FORMAT');
        const retryAfter = reply.retryAfterMs;
        throw new ScanError(reply.code, typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter >= 0 ?
          { retryAfterMs: Math.min(retryAfter, 600_000) } : undefined);
      }
      // The page is an untrusted boundary; TypeScript alone cannot validate it.
      const data: unknown = reply.data;
      const count = (value: unknown): boolean => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
      if (!plainRecord(data) || !count(data.total)) throw new ScanError('FORMAT');
      if (request.action === 'metadata') {
        const info = data as unknown as PlaylistInfo;
        if (typeof info.name !== 'string' || info.name.length > 2000 ||
          !(info.modified === null || typeof info.modified === 'string' && info.modified.length <= 2000) ||
          !(info.revision == null || typeof info.revision === 'string' && info.revision.length <= 2000)) throw new ScanError('FORMAT');
      } else {
        const page = data as unknown as TrackPage;
        if (!Array.isArray(page.tracks) || page.tracks.length > 100 || !count(page.nextOffset) || page.tracks.some(track =>
          !plainRecord(track) || !Number.isSafeInteger(track.position) || track.position <= 0 ||
          typeof track.name !== 'string' || track.name.length > 2000 || typeof track.artist !== 'string' || track.artist.length > 2000 ||
          !(track.catalogId === null || typeof track.catalogId === 'string' && /^\d{1,128}$/.test(track.catalogId)) ||
          !(track.libraryId === null || typeof track.libraryId === 'string' && track.libraryId.length <= 128 && /^i\.[A-Za-z0-9-]+$/.test(track.libraryId)))) {
          throw new ScanError('FORMAT');
        }
      }
      return data as unknown as PlaylistInfo | TrackPage;
    } catch (error) {
      if (error instanceof ScanError) throw error;
      // A closed or replaced tab is a playlist change, not a permission problem.
      const message = String((error as { message?: unknown })?.message ?? '');
      if (/No tab with id|The tab was closed|Invalid tab ID|frame.*(?:removed|not found)|No frame/i.test(message)) {
        throw new ScanError('PAGE_CHANGED');
      }
      if (await tabState() === 'missing') throw new ScanError('PAGE_CHANGED');
      // Any other executeScript rejection is an access problem. Chrome localizes
      // the message, so do not depend on English text here.
      throw new ScanError('TAB_ACCESS');
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  return {
    metadata: async signal => await call({ action: 'metadata', playlist }, signal) as PlaylistInfo,
    page: async (offset, signal) => await call({ action: 'tracks', playlist, offset }, signal) as TrackPage,
  };
}
