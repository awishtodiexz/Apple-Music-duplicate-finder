import type { BridgeReply, BridgeRequest, ErrorCode, PlaylistInfo, Track, TrackPage } from './types';

/**
 * Serialized by chrome.scripting into MAIN. MUST have no runtime closure dependencies.
 * Only allowlisted metadata leaves the page; raw responses and errors never do.
 */
export async function musicKitBridge(request: BridgeRequest): Promise<BridgeReply> {
  type Obj = Record<string, unknown>;
  const obj = (value: unknown): Obj | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
  const fail = (code: ErrorCode): never => { throw { safeCode: code }; };
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.slice(0, 2000) : fallback;
  const numericId = (value: unknown): string | null =>
    typeof value === 'string' && /^\d+$/.test(value) ? value : null;
  const totalOf = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0) return fail('FORMAT');
    return value as number;
  };
  const checkPage = (): void => {
    if (window.location.origin !== 'https://music.apple.com' ||
      window.location.pathname !== request.playlist.pathname) fail('PAGE_CHANGED');
  };
  const statusCode = (value: unknown): ErrorCode => {
    const e = obj(value) ?? (Array.isArray(value) ? obj(value[0]) : null);
    const data = obj(e?.data);
    const response = obj(e?.response);
    const errors = Array.isArray(e?.errors) ? e.errors : Array.isArray(data?.errors) ? data.errors : [];
    // MKError.responseError retains the Response under .data, not .response.
    // Ignore sentinel statuses such as 0 so they cannot hide a nested HTTP error.
    const status = [e?.status, e?.statusCode, response?.status, data?.status, obj(errors[0])?.status]
      .map(Number).find(status => Number.isInteger(status) && status >= 400 && status <= 599);
    if (status === 401 || status === 403) return 'AUTH';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMIT';
    if (status !== undefined) return 'API';
    switch (e?.reason ?? e?.errorCode) {
      case 'AUTHORIZATION_ERROR':
      case 'UNAUTHORIZED_ERROR':
      case 'ACCESS_DENIED':
      case 'TOKEN_EXPIRED': return 'AUTH';
      case 'QUOTA_EXCEEDED': return 'RATE_LIMIT';
      case 'NOT_FOUND': return 'NOT_FOUND';
      case 'CONFIGURATION_ERROR': return 'MUSICKIT_UNAVAILABLE';
      case 'PARSE_ERROR': return 'FORMAT';
      case 'SERVER_ERROR':
      case 'SERVICE_UNAVAILABLE':
      case 'REQUEST_ERROR': return 'API';
      default: return 'NETWORK';
    }
  };
  try {
    checkPage();
    const musicKit = (window as unknown as { MusicKit?: { getInstance?: () => unknown } }).MusicKit;
    if (typeof musicKit?.getInstance !== 'function') return { ok: false, code: 'MUSICKIT_UNAVAILABLE' };
    let instance: Obj | null;
    try { instance = obj(musicKit.getInstance()); } catch { return { ok: false, code: 'MUSICKIT_UNAVAILABLE' }; }
    const api = obj(instance?.api);
    const useMusic = typeof api?.music === 'function';
    const read = useMusic ? api!.music : api?.get;
    if (!instance || typeof read !== 'function') return { ok: false, code: 'MUSICKIT_UNAVAILABLE' };
    if (instance.isAuthorized === false) return { ok: false, code: 'AUTH' };

    const playlist = request.playlist;
    if (!/^(p|pl)\.[A-Za-z0-9-]+$/.test(playlist.id)) fail('NOT_PLAYLIST');
    const storefront = typeof instance.storefrontId === 'string' && /^[a-z]{2}$/.test(instance.storefrontId)
      ? instance.storefrontId : playlist.storefront;
    if (playlist.kind === 'catalog' && (!storefront || !/^[a-z]{2}$/.test(storefront))) fail('NOT_PLAYLIST');
    const base = playlist.kind === 'library' ? '/v1/me/library/playlists/' + playlist.id :
      '/v1/catalog/' + storefront + '/playlists/' + playlist.id;
    if (request.action === 'tracks' && (!Number.isSafeInteger(request.offset) || request.offset < 0)) fail('FORMAT');
    const path = request.action === 'metadata' ? base :
      base + '/tracks?limit=100&offset=' + request.offset + (playlist.kind === 'library' ? '&include=catalog' : '');

    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: unknown;
    type Read = (path: string, query?: Record<string, never>, options?: { fetchOptions: { method: 'GET' } }) => Promise<unknown>;
    try {
      response = await Promise.race([
        // v3 uses the music passthrough; older player instances expose get.
        // Bind the receiver and never retry through a second API after failure.
        useMusic ? (read as Read).call(api, path, {}, { fetchOptions: { method: 'GET' } }) :
          (read as Read).call(api, path),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject({ safeCode: 'TIMEOUT' }), 25_000);
        }),
      ]);
    } finally { clearTimeout(timer); }
    checkPage();

    const root = obj(response);
    if (!root) fail('FORMAT');
    // Observed MusicKit generations expose {data: []}, {data: {data: []}}, or {json: {data: []}}.
    const body = Array.isArray(root!.data) ? root! : obj(root!.json) ?? obj(root!.data) ?? root!;
    // A resolved v3 wrapper can carry HTTP failure on its Response or body.
    // Never treat its data: [] as a successful empty page.
    const status = [root!.status, obj(root!.response)?.status, body.status].map(Number)
      .find(value => Number.isInteger(value) && value >= 400 && value <= 599);
    if (status !== undefined) fail(statusCode({ status }));
    if (Array.isArray(body.errors) && body.errors.length) fail(statusCode(body));
    if (!Array.isArray(body.data)) fail('FORMAT');
    const data = body.data as unknown[];

    if (request.action === 'metadata') {
      const item = obj(data[0]);
      const attrs = obj(item?.attributes);
      const expectedType = playlist.kind === 'library' ? 'library-playlists' : 'playlists';
      if (data.length !== 1 || item?.id !== playlist.id || item.type !== expectedType ||
        typeof attrs?.name !== 'string' || !attrs.name.trim()) fail('FORMAT');
      const tracks = obj(obj(item!.relationships)?.tracks);
      const attrTotal = totalOf(attrs!.trackCount);
      const relationshipTotal = totalOf(obj(tracks?.meta)?.total);
      if (attrTotal !== null && relationshipTotal !== null && attrTotal !== relationshipTotal) fail('INCOMPLETE');
      const info: PlaylistInfo = {
        name: text(attrs!.name, 'Untitled playlist'),
        total: attrTotal ?? relationshipTotal,
        modified: typeof attrs!.lastModifiedDate === 'string' ? attrs!.lastModifiedDate : null,
      };
      return { ok: true, data: info };
    }

    if (data.length > 100) fail('FORMAT');
    const tracks: Track[] = data.map((raw, index) => {
      const item = obj(raw);
      if (!item || typeof item.type !== 'string') return fail('FORMAT');
      const attrs = obj(item.attributes);
      const play = obj(attrs?.playParams);
      const ids = new Set<string>();
      // Only song resources participate. A playlist-entry ID or music-video ID is not a song ID.
      const song = item.type === 'songs' || item.type === 'library-songs';
      if (song) {
        const playId = numericId(play?.catalogId);
        if (playId) ids.add(playId);
        if (item.type === 'songs') {
          const id = numericId(item.id);
          if (id) ids.add(id);
        }
        const catalog = obj(obj(item.relationships)?.catalog);
        if (Array.isArray(catalog?.data)) {
          for (const candidate of catalog.data) {
            const resource = obj(candidate);
            const id = numericId(resource?.id);
            if (resource?.type === 'songs' && id) ids.add(id);
          }
        }
      }
      // Conflicting catalog identifiers are ambiguous: do not guess or fall back.
      const catalogId = ids.size === 1 ? [...ids][0]! : null;
      const libraryId = ids.size <= 1 && item.type === 'library-songs' &&
        typeof item.id === 'string' && /^i\.[A-Za-z0-9-]+$/.test(item.id) ? item.id : null;
      return {
        position: request.offset + index + 1,
        name: text(attrs?.name, 'Unknown song'),
        artist: text(attrs?.artistName, 'Unknown artist'),
        catalogId, libraryId,
      };
    });
    const total = totalOf(obj(body.meta)?.total);
    let nextOffset: number | null = null;
    if (body.next !== undefined && body.next !== null && body.next !== '') {
      if (typeof body.next !== 'string') fail('FORMAT');
      let next: URL;
      try { next = new URL(body.next as string, 'https://api.music.apple.com'); } catch { return fail('FORMAT'); }
      if (!['https://api.music.apple.com', 'https://amp-api.music.apple.com'].includes(next.origin) ||
        next.pathname !== base + '/tracks') fail('INCOMPLETE');
      const offset = next.searchParams.get('offset');
      if (!offset || !/^\d+$/.test(offset)) fail('FORMAT');
      nextOffset = Number(offset);
      if (!Number.isSafeInteger(nextOffset) || !tracks.length ||
        nextOffset !== request.offset + tracks.length) fail('INCOMPLETE');
    }
    const page: TrackPage = { tracks, total, nextOffset };
    return { ok: true, data: page };
  } catch (error) {
    const safe = obj(error)?.safeCode;
    // Only our fixed codes, never Apple exception text, headers, or tokens.
    const codes: ErrorCode[] = ['NOT_PLAYLIST', 'PAGE_CHANGED', 'MUSICKIT_UNAVAILABLE', 'AUTH',
      'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'NOT_FOUND', 'API', 'FORMAT', 'INCOMPLETE'];
    return { ok: false, code: codes.includes(safe as ErrorCode) ? safe as ErrorCode : statusCode(error) };
  }
}
