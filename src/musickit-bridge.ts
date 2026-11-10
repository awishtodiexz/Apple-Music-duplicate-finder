import type { BridgeErrorCode, BridgeReply, BridgeRequest, PlaylistInfo, Track, TrackPage } from './types';

/**
 * Serialized by chrome.scripting into MAIN. MUST have no runtime closure dependencies.
 * Only allowlisted metadata leaves the page; raw responses and errors never do.
 */
export async function musicKitBridge(request: BridgeRequest): Promise<BridgeReply> {
  type Obj = Record<string, unknown>;
  // Page-provided values are an untrusted boundary: a proxy, revoked proxy or
  // throwing getter must become a fixed error, never an exception that escapes.
  const obj = (value: unknown): Obj | null => {
    try {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
    } catch { return null; }
  };
  const firstObj = (value: unknown): Obj | null => {
    try { return Array.isArray(value) ? obj(value[0]) : null; } catch { return null; }
  };
  const numeric = (value: unknown): number => {
    try {
      if (typeof value === 'number') return value;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    } catch { return Number.NaN; }
  };
  const fail = (code: BridgeErrorCode, metadata: { retryAfterMs?: number } = {}): never => {
    throw { safeCode: code, ...metadata };
  };
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.slice(0, 2000) : fallback;
  const numericId = (value: unknown): string | null => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    return typeof value === 'string' && value.length <= 128 && /^\d+$/.test(value) ? value : null;
  };
  const totalOf = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(numeric) || (numeric as number) < 0) return fail('FORMAT');
    return numeric as number;
  };
  // Match the playlist ID rather than the exact path: Apple adds and drops
  // cosmetic segments (storefront, name, trailing slashes) around it. The ID
  // must be in the playlist's own route, and a catalog route's storefront is
  // part of the identity because regional track lists can differ.
  const checkPage = (expectedStorefront?: string | null): void => {
    const segments = window.location.pathname.split('/').filter(Boolean);
    if (window.location.origin !== 'https://music.apple.com') fail('PAGE_CHANGED');
    const marker = segments.findIndex(segment => /^playlists?$/i.test(segment));
    if (marker < 0 || !segments.slice(marker + 1).includes(request.playlist.id)) fail('PAGE_CHANGED');
    if (request.playlist.kind !== 'catalog') return;
    const expected = typeof expectedStorefront === 'string' ? expectedStorefront.toLowerCase() : null;
    if (!expected || !/^[a-z]{2}$/.test(expected)) return;
    const prefix = segments.slice(0, marker).map(segment => segment.toLowerCase());
    const routeStorefront = prefix.find(segment => /^[a-z]{2}$/.test(segment));
    if (routeStorefront && routeStorefront !== expected) fail('PAGE_CHANGED');
  };
  const statusCode = (value: unknown): BridgeErrorCode => {
    try {
      const e = obj(value) ?? firstObj(value);
      if (!e) return 'INTERNAL';
      const data = obj(e.data) ?? firstObj(e.data);
      const response = obj(e.response) ?? firstObj(e.response);
      const error = obj(e.error);
      const dataResponse = obj(data?.response);
      const responseData = obj(response?.data);
      let errors: unknown[] = [];
      try {
        if (Array.isArray(e.errors)) errors = e.errors as unknown[];
        else if (Array.isArray(data?.errors)) errors = data!.errors as unknown[];
        else if (Array.isArray(response?.errors)) errors = response!.errors as unknown[];
      } catch { errors = []; }
      const firstError = firstObj(errors);
      // MKError.responseError retains the Response under .data, not .response.
      // Ignore sentinel statuses such as 0 so they cannot hide a nested HTTP error.
      const status = [e.status, e.statusCode, error?.status, error?.statusCode,
        response?.status, response?.statusCode, responseData?.status, responseData?.statusCode,
        data?.status, data?.statusCode, dataResponse?.status, dataResponse?.statusCode,
        firstError?.status, firstError?.statusCode]
        .map(numeric).find(candidate => Number.isInteger(candidate) && candidate >= 400 && candidate <= 599);
      if (status === 401 || status === 403) return 'AUTH';
      if (status === 404) return 'NOT_FOUND';
      if (status === 408) return 'TIMEOUT';
      if (status === 429) return 'RATE_LIMIT';
      // 5xx is transient and retried by the reader; 4xx is a permanent rejection.
      if (status !== undefined) return status >= 500 ? 'SERVER' : 'API';
      const detail = String(e.message ?? e.description ?? '');
      if (/failed to fetch|network ?error|ERR_NETWORK|ERR_CONNECTION|load failed/i.test(detail)) return 'NETWORK';
      switch (e.reason ?? e.errorCode) {
        case 'AUTHORIZATION_ERROR':
        case 'UNAUTHORIZED_ERROR':
        case 'ACCESS_DENIED':
        case 'TOKEN_EXPIRED': return 'AUTH';
        case 'QUOTA_EXCEEDED': return 'RATE_LIMIT';
        case 'NETWORK_ERROR': return 'NETWORK';
        case 'NOT_FOUND': return 'NOT_FOUND';
        case 'CONFIGURATION_ERROR': return 'MUSICKIT_UNAVAILABLE';
        case 'PARSE_ERROR': return 'FORMAT';
        case 'SERVER_ERROR':
        case 'SERVICE_UNAVAILABLE': return 'SERVER';
        case 'REQUEST_ERROR': return 'API';
        // An unrecognised page-side failure is a bug, not a network condition.
        default: return 'INTERNAL';
      }
    } catch { return 'INTERNAL'; }
  };
  // A resolved wrapper can nest its HTTP result one or two levels deep. Check
  // every plausible envelope so a failed fetch never looks like an empty page.
  const httpStatus = (value: unknown): number | undefined => {
    try {
      const e = obj(value) ?? firstObj(value);
      if (!e) return undefined;
      const data = obj(e.data) ?? firstObj(e.data);
      const response = obj(e.response) ?? firstObj(e.response);
      const dataResponse = obj(data?.response);
      const responseData = obj(response?.data);
      return [e.status, e.statusCode, response?.status, response?.statusCode,
        responseData?.status, responseData?.statusCode, data?.status, data?.statusCode,
        dataResponse?.status, dataResponse?.statusCode]
        .map(numeric).find(candidate => Number.isInteger(candidate) && candidate >= 400 && candidate <= 599);
    } catch { return undefined; }
  };
  const headerValue = (headers: unknown, name: string): string | null => {
    try {
      if (headers === null || headers === undefined) return null;
      const get = (headers as { get?: unknown }).get;
      if (typeof get === 'function') {
        try {
          const value = (get as (name: string) => unknown).call(headers, name);
          if (typeof value === 'string') return value;
          if (typeof value === 'number' && Number.isFinite(value)) return String(value);
          return null;
        } catch { return null; }
      }
      if (Array.isArray(headers)) {
        for (const entry of headers) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          if (String(entry[0]).toLowerCase() === name) return String(entry[1]);
        }
        return null;
      }
      const record = obj(headers);
      if (!record) return null;
      for (const [key, value] of Object.entries(record)) {
        if (key.toLowerCase() === name && (typeof value === 'string' || typeof value === 'number')) return String(value);
      }
      return null;
    } catch { return null; }
  };
  const retryAfterMs = (value: unknown): number | undefined => {
    try {
      const e = obj(value) ?? firstObj(value);
      if (!e) return undefined;
      const data = obj(e.data) ?? firstObj(e.data);
      const response = obj(e.response) ?? firstObj(e.response);
      const headers = response?.headers ?? data?.headers ?? e.headers ??
        obj(data?.response)?.headers ?? obj(response?.data)?.headers;
      const raw = headerValue(headers, 'retry-after');
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isSafeInteger(seconds) ? Math.min(seconds * 1000, 600_000) : undefined;
      }
      const timestamp = Date.parse(trimmed);
      if (!Number.isFinite(timestamp)) return undefined;
      return Math.min(Math.max(0, timestamp - Date.now()), 600_000);
    } catch { return undefined; }
  };
  const checkHttp = (value: unknown, secondary: unknown): void => {
    const status = httpStatus(value);
    if (status === undefined) return;
    const delay = retryAfterMs(value) ?? retryAfterMs(secondary);
    fail(statusCode({ status }), delay === undefined ? {} : { retryAfterMs: delay });
  };
  // The web player can expose MusicKit before configure() has produced a
  // usable instance. Poll briefly rather than making the user reopen the popup.
  const readyDelayMs = 100;
  const readyAttempts = 20;
  type Read = (path: string, query?: Record<string, never>, options?: { fetchOptions: { method: 'GET'; signal?: AbortSignal } }) => Promise<unknown>;
  type Surface = { instance: Obj; api: Obj; read: Read; useMusic: boolean };
  const surface = (): Surface | null => {
    try {
      const musicKit = (window as unknown as { MusicKit?: { getInstance?: () => unknown } }).MusicKit;
      if (typeof musicKit?.getInstance !== 'function') return null;
      const instance = obj(musicKit.getInstance());
      if (!instance) return null;
      const api = obj(instance.api);
      if (!api) return null;
      const useMusic = typeof api.music === 'function';
      const read = useMusic ? api.music : api.get;
      return typeof read === 'function' ? { instance, api, read: read as Read, useMusic } : null;
    } catch { return null; }
  };
  const namespacePresent = (): boolean => {
    try {
      const musicKit = (window as unknown as { MusicKit?: unknown }).MusicKit;
      return musicKit !== undefined && musicKit !== null;
    } catch { return false; }
  };
  try {
    // Validate the request before using any of its fields. A malformed request
    // must fail closed with a fixed code and must never reach the API.
    const playlist = request.playlist;
    if (!playlist || typeof playlist.id !== 'string' ||
      !/^(?:p|pl)\.[A-Za-z0-9-]{1,126}$/.test(playlist.id) ||
      (playlist.kind !== 'library' && playlist.kind !== 'catalog')) fail('NOT_PLAYLIST');
    if (request.action !== 'metadata' && request.action !== 'tracks') fail('FORMAT');
    checkPage(playlist.storefront);
    let ready = surface();
    // Only wait when MusicKit has started loading. A page with no MusicKit at
    // all is a persistent incompatibility, not an initialization race.
    if (!ready && namespacePresent()) {
      for (let attempt = 0; !ready && attempt < readyAttempts; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, readyDelayMs));
        checkPage(playlist.storefront);
        ready = surface();
      }
    }
    if (!ready) return { ok: false, code: 'MUSICKIT_UNAVAILABLE' };
    const { instance, api, read, useMusic } = ready;
    if (instance.isAuthorized === false) return { ok: false, code: 'AUTH' };

    // The visible route is authoritative. Only fall back to the player's
    // storefront when the route does not carry one.
    const storefront = [playlist.storefront, instance.storefrontId]
      .map(value => typeof value === 'string' ? value.toLowerCase() : value)
      .find((value): value is string => typeof value === 'string' && /^[a-z]{2}$/.test(value)) ?? null;
    if (playlist.kind === 'catalog' && !storefront) fail('NOT_PLAYLIST');
    checkPage(storefront);
    const base = playlist.kind === 'library' ? '/v1/me/library/playlists/' + playlist.id :
      '/v1/catalog/' + storefront + '/playlists/' + playlist.id;
    if (request.action === 'tracks' && (!Number.isSafeInteger(request.offset) || request.offset < 0)) fail('FORMAT');
    const path = request.action === 'metadata' ? base :
      base + '/tracks?limit=100&offset=' + request.offset + (playlist.kind === 'library' ? '&include=catalog' : '');

    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: unknown;
    const controller = new AbortController();
    const eventName = request.requestId && /^[a-f0-9-]{36}$/.test(request.requestId) ? 'amdf:cancel:' + request.requestId : null;
    let cancel: (() => void) | undefined;
    let guardFailure: BridgeErrorCode | null = null;
    const operationTimeoutMs = 25_000;
    // The cancellation and timeout guards stay armed through body consumption,
    // not just the fetch itself. A raw Response body is a second asynchronous
    // operation and must not escape the read's route/abort/timeout checks.
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => {
        guardFailure = 'CANCELLED';
        controller.abort();
        reject({ safeCode: 'CANCELLED' });
      };
      if (eventName) window.addEventListener(eventName, cancel, { once: true });
    });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        guardFailure = 'TIMEOUT';
        controller.abort();
        reject({ safeCode: 'TIMEOUT' });
      }, operationTimeoutMs);
    });
    const assertActive = (): void => {
      if (guardFailure) fail(guardFailure);
      checkPage(storefront);
    };
    try {
      response = await Promise.race([
        cancelled,
        // v3 uses the music passthrough; older player instances expose get.
        // Bind the receiver and never retry through a second API after failure.
        useMusic ? (read as Read).call(api, path, {}, { fetchOptions: { method: 'GET', signal: controller.signal } }) :
          (read as Read).call(api, path),
        timedOut,
      ]);
      assertActive();

      const root = obj(response);
      if (!root) fail('FORMAT');
    // Observed MusicKit generations expose {data: []}, {data: {data: []}}, or {json: {data: []}}.
    let body: Obj = Array.isArray(root!.data) ? root! : obj(root!.json) ?? obj(root!.data) ?? root!;
    // A resolved v3 wrapper can carry HTTP failure on its Response or body.
    // Never treat its data: [] as a successful empty page.
    checkHttp(root, body);
    // Some generations resolve with the raw Response instead of its JSON body.
    if (typeof body.json === 'function' && typeof body.status === 'number') {
      checkHttp(body, root);
      try {
        const parsed = await Promise.race([
          cancelled,
          (body.json as () => Promise<unknown>).call(body),
          timedOut,
        ]);
        body = obj(parsed) ?? fail('FORMAT');
      } catch (error) {
        // The body can reject synchronously when abort() fires, before the
        // cancellation/timeout promise settles. The guard is the authoritative
        // reason in that race; a generic abort rejection must not become FORMAT.
        if (guardFailure) fail(guardFailure);
        const safe = obj(error)?.safeCode;
        if (safe === 'CANCELLED' || safe === 'TIMEOUT') throw error;
        fail('FORMAT');
      }
      assertActive();
    }
    checkHttp(body, root);
    // Error envelopes can sit on the wrapper or on the selected body. Never let
    // a root-level error hide beside nested success data, and never ignore a
    // malformed error object in favour of a successful-looking data array.
    const envelopes = root === body ? [body] : [root!, body];
    for (const envelope of envelopes) {
      const errors = envelope.errors;
      if (errors === undefined || errors === null) continue;
      if (!Array.isArray(errors)) fail('FORMAT');
      const errorList = errors as unknown[];
      if (errorList.length) {
        const code = statusCode(envelope);
        const delay = retryAfterMs(envelope);
        fail(code, delay === undefined ? {} : { retryAfterMs: delay });
      }
    }
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
        modified: typeof attrs!.lastModifiedDate === 'string' && attrs!.lastModifiedDate.trim() ? attrs!.lastModifiedDate.slice(0, 2000) : null,
      };
      // Observed on some Apple playlist resources; not a guaranteed snapshot token.
      const revision = obj(attrs!.playParams)?.versionHash;
      if (typeof revision === 'string' && revision.trim()) info.revision = revision.slice(0, 2000);
      assertActive();
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
        typeof item.id === 'string' && item.id.length <= 128 && /^i\.[A-Za-z0-9-]+$/.test(item.id) ? item.id : null;
      return {
        position: request.offset + index + 1,
        name: text(attrs?.name, 'Unknown song'),
        artist: text(attrs?.artistName, 'Unknown artist'),
        catalogId, libraryId,
      };
    });
    // Some wrappers nest only data, leaving meta/next beside it on the envelope.
    // When both envelopes provide pagination evidence it must agree: a lower
    // body total or an explicit body null must not hide a wrapper total or a
    // continuation link that says more entries exist.
    const bodyTotal = totalOf(obj(body.meta)?.total);
    const rootTotal = root === body ? null : totalOf(obj(root!.meta)?.total);
    if (bodyTotal !== null && rootTotal !== null && bodyTotal !== rootTotal) fail('INCOMPLETE');
    const total = bodyTotal ?? rootTotal;
    const bodyNext = body.next;
    const rootNext = root === body ? undefined : root!.next;
    const bodyHasNext = bodyNext !== undefined && bodyNext !== null && bodyNext !== '';
    const rootHasNext = rootNext !== undefined && rootNext !== null && rootNext !== '';
    if (bodyNext !== undefined && rootNext !== undefined) {
      if (bodyHasNext !== rootHasNext) fail('INCOMPLETE');
      if (bodyHasNext && bodyNext !== rootNext) fail('INCOMPLETE');
    }
    const nextValue = bodyHasNext ? bodyNext : rootNext;
    let nextOffset: number | null = null;
    if (nextValue !== undefined && nextValue !== null && nextValue !== '') {
      if (typeof nextValue !== 'string') fail('FORMAT');
      const rawNext = nextValue as string;
      let next: URL;
      try { next = new URL(rawNext, 'https://api.music.apple.com'); } catch { return fail('FORMAT'); }
      if (!['https://api.music.apple.com', 'https://amp-api.music.apple.com'].includes(next.origin) ||
        next.pathname !== base + '/tracks') fail('INCOMPLETE');
      const offset = next.searchParams.get('offset');
      if (!offset || !/^\d+$/.test(offset)) fail('FORMAT');
      nextOffset = Number(offset);
      if (!Number.isSafeInteger(nextOffset) || !tracks.length ||
        nextOffset !== request.offset + tracks.length) fail('INCOMPLETE');
    }
    const page: TrackPage = { tracks, total, nextOffset };
    assertActive();
    return { ok: true, data: page };
    } finally {
      clearTimeout(timer);
      if (eventName && cancel) window.removeEventListener(eventName, cancel);
    }
  } catch (error) {
    // Only our fixed codes, never Apple exception text, headers, or tokens.
    // This list mirrors bridgeErrorCodes in types.ts and must stay self-contained:
    // the function is serialized into the page and loses its module scope.
    const codes = ['NOT_PLAYLIST', 'PAGE_CHANGED', 'MUSICKIT_UNAVAILABLE', 'AUTH',
      'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'NOT_FOUND', 'API', 'SERVER', 'FORMAT', 'INCOMPLETE',
      'INTERNAL', 'CANCELLED'] as const satisfies readonly BridgeErrorCode[];
    let code: BridgeErrorCode = 'INTERNAL';
    try {
      const safe = obj(error)?.safeCode;
      code = typeof safe === 'string' && (codes as readonly string[]).includes(safe) ?
        safe as BridgeErrorCode : statusCode(error);
    } catch { code = 'INTERNAL'; }
    let delay: number | undefined;
    try {
      const directDelay = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
      delay = typeof directDelay === 'number' && Number.isSafeInteger(directDelay) && directDelay >= 0 ?
        Math.min(directDelay, 600_000) : retryAfterMs(error);
    } catch { delay = undefined; }
    return { ok: false, code, ...(delay === undefined ? {} : { retryAfterMs: delay }) };
  }
}

/** Serialized separately so cancellation never needs host permissions or stored credentials. */
export function cancelMusicKitRead(requestId: string): void {
  if (/^[a-f0-9-]{36}$/.test(requestId)) window.dispatchEvent(new Event('amdf:cancel:' + requestId));
}
