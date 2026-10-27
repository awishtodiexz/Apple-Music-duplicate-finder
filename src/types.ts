export type ErrorCode = 'NOT_PLAYLIST' | 'PAGE_CHANGED' | 'MUSICKIT_UNAVAILABLE' |
  'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'NOT_FOUND' | 'API' | 'FORMAT' | 'INCOMPLETE' |
  'CANCELLED' | 'DEADLINE' | 'LIMIT';

export interface PlaylistRef {
  id: string;
  kind: 'library' | 'catalog';
  storefront: string | null;
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
  { ok: false; code: ErrorCode };

export interface DuplicateGroup {
  identity: string;
  name: string;
  artist: string;
  positions: number[];
  copies: number;
  extraCopies: number;
}
