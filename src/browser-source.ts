import { ScanError } from './errors';
import { musicKitBridge } from './musickit-bridge';
import type { PlaylistSource } from './playlist-reader';
import type { BridgeReply, BridgeRequest, PlaylistInfo, PlaylistRef, TrackPage } from './types';

export function createBrowserSource(tabId: number, playlist: PlaylistRef): PlaylistSource {
  async function call(request: BridgeRequest): Promise<PlaylistInfo | TrackPage> {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: musicKitBridge,
      args: [request],
    });
    const reply: BridgeReply | undefined = frames[0]?.result;
    if (!reply) throw new ScanError('PAGE_CHANGED');
    if (!reply.ok) throw new ScanError(reply.code);
    return reply.data;
  }
  return {
    metadata: async () => await call({ action: 'metadata', playlist }) as PlaylistInfo,
    page: async (offset) => await call({ action: 'tracks', playlist, offset }) as TrackPage,
  };
}
