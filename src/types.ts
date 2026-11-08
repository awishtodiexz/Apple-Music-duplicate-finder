/**
 * Every code the page-world bridge can return. The transport, the bridge and the
 * popup all validate against this one list; the page-side copy is enforced by
 * tests/bridge-isolation.test.ts because a serialized function cannot import it.
 */
export const bridgeErrorCodes = ['NOT_PLAYLIST', 'PAGE_CHANGED', 'MUSICKIT_UNAVAILABLE', 'AUTH',
  'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'NOT_FOUND', 'API', 'SERVER', 'FORMAT', 'INCOMPLETE',
  'INTERNAL', 'CANCELLED'] as const;

export type BridgeErrorCode = typeof bridgeErrorCodes[number];

/** Failures that are raised by the popup transport/reader and never cross the page boundary. */
export type LocalErrorCode = 'DEADLINE' | 'LIMIT' | 'TAB_ACCESS';
export type ErrorCode = BridgeErrorCode | LocalErrorCode;

// A local-only code must never be accepted from the page-world bridge.
export type _NoLocalCodesInBridge =
  Extract<BridgeErrorCode, LocalErrorCode> extends never ? true : never;

export interface PlaylistRef {
  id: string;
  kind: 'library' | 'catalog';
  storefront: string | null;
}

export interface Track {
  position: number;
  name: string;
  artist: string;
  catalogId: string | null;
  libraryId: string | null;
}

export interface PlaylistInfo {
  name: string;
  total: number | null;
  modified: string | null;
  revision?: string | null;
}

export interface TrackPage {
  tracks: Track[];
  total: number | null;
  nextOffset: number | null;
}

export type BridgeRequest = { playlist: PlaylistRef; requestId?: string } & (
  { action: 'metadata' } | { action: 'tracks'; offset: number }
);
export type BridgeReply = { ok: true; data: PlaylistInfo | TrackPage } |
  { ok: false; code: BridgeErrorCode; retryAfterMs?: number };

export interface DuplicateGroup {
  identity: string;
  name: string;
  artist: string;
  positions: number[];
  copies: number;
  extraCopies: number;
}
