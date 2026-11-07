/**
 * Every code the page-world bridge can return. The transport, the bridge and the
 * popup all validate against this one list; the page-side copy is enforced by
 * tests/bridge-isolation.test.ts because a serialized function cannot import it.
 */
export const bridgeErrorCodes = ['NOT_PLAYLIST', 'PAGE_CHANGED', 'MUSICKIT_UNAVAILABLE', 'AUTH',
  'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'NOT_FOUND', 'API', 'SERVER', 'FORMAT', 'INCOMPLETE',
  'CANCELLED'] as const;

export type BridgeErrorCode = typeof bridgeErrorCodes[number];

/** Reader-only failures add two codes that can never cross the page boundary. */
export type ErrorCode = BridgeErrorCode | 'DEADLINE' | 'LIMIT';

// Compile-time guards: a code added to or removed from the union must be listed
// above, and nothing reader-only may leak into the bridge list.
export type _BridgeErrorCodesAreComplete =
  Exclude<ErrorCode, 'DEADLINE' | 'LIMIT'> extends BridgeErrorCode ? true : never;
export type _BridgeErrorCodesAddNothing =
  BridgeErrorCode extends Exclude<ErrorCode, 'DEADLINE' | 'LIMIT'> ? true : never;

export interface PlaylistRef {
  id: string;
  kind: 'library' | 'catalog';
  storefront: string | null;
  /** Always trailing-slash free so it compares equal to the live location. */
  pathname: string;
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
  { ok: false; code: BridgeErrorCode };

export interface DuplicateGroup {
  identity: string;
  name: string;
  artist: string;
  positions: number[];
  copies: number;
  extraCopies: number;
}
