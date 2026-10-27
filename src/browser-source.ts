import { ScanError } from './errors';
import { cancelMusicKitRead, musicKitBridge } from './musickit-bridge';
import type { PlaylistSource } from './playlist-reader';
import type { BridgeReply, BridgeRequest, PlaylistInfo, PlaylistRef, TrackPage } from './types';

export function createBrowserSource(tabId: number, playlist: PlaylistRef): PlaylistSource {
  async function call(request: BridgeRequest, signal?: AbortSignal): Promise<PlaylistInfo | TrackPage> {
    if (signal?.aborted) throw new ScanError('CANCELLED');
    const requestId = crypto.randomUUID();
    let abort: (() => void) | undefined;
    const pending = chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: musicKitBridge,
      args: [{ ...request, requestId }],
    });
    try {
      const frames = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          abort = () => {
            reject(new ScanError('CANCELLED'));
            // Best effort: navigation/permission loss may prevent this injection.
            void chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
              func: cancelMusicKitRead, args: [requestId] }).catch(() => {});
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
      if (signal?.aborted) throw new ScanError('CANCELLED');
      const reply: BridgeReply | undefined = frames[0]?.result;
      if (!reply) throw new ScanError('PAGE_CHANGED');
      if (typeof reply.ok !== 'boolean') throw new ScanError('FORMAT');
      if (!reply.ok) {
        const codes = ['NOT_PLAYLIST', 'PAGE_CHANGED', 'MUSICKIT_UNAVAILABLE', 'AUTH', 'RATE_LIMIT', 'NETWORK',
          'TIMEOUT', 'NOT_FOUND', 'API', 'FORMAT', 'INCOMPLETE', 'CANCELLED'];
        if (!codes.includes(reply.code)) throw new ScanError('FORMAT');
        throw new ScanError(reply.code);
      }
      // The page is an untrusted boundary; TypeScript alone cannot validate it.
      const data = reply.data;
      const count = (value: unknown): boolean => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
      if (!data || !count(data.total)) throw new ScanError('FORMAT');
      if (request.action === 'metadata') {
        const info = data as PlaylistInfo;
        if (typeof info.name !== 'string' || info.name.length > 2000 ||
          !(info.modified === null || typeof info.modified === 'string' && info.modified.length <= 2000) ||
          !(info.revision == null || typeof info.revision === 'string' && info.revision.length <= 2000)) throw new ScanError('FORMAT');
      } else {
        const page = data as TrackPage;
        if (!Array.isArray(page.tracks) || page.tracks.length > 100 || !count(page.nextOffset) || page.tracks.some(track =>
          !track || !Number.isSafeInteger(track.position) || track.position <= 0 ||
          typeof track.name !== 'string' || track.name.length > 2000 || typeof track.artist !== 'string' || track.artist.length > 2000 ||
          !(track.catalogId === null || typeof track.catalogId === 'string' && /^\d{1,128}$/.test(track.catalogId)) ||
          !(track.libraryId === null || typeof track.libraryId === 'string' && track.libraryId.length <= 128 && /^i\.[A-Za-z0-9-]+$/.test(track.libraryId)))) {
          throw new ScanError('FORMAT');
        }
      }
      return data;
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  return {
    metadata: async signal => await call({ action: 'metadata', playlist }, signal) as PlaylistInfo,
    page: async (offset, signal) => await call({ action: 'tracks', playlist, offset }, signal) as TrackPage,
  };
}
