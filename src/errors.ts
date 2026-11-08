import type { ErrorCode } from './types';

export class ScanError extends Error {
  public readonly code: ErrorCode;
  /** Suggested wait before retrying a transient failure, when the server supplies one. */
  public readonly retryAfterMs?: number;
  constructor(code: ErrorCode, options: { retryAfterMs?: number } = {}) {
    super(code);
    this.code = code;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    this.name = 'ScanError';
  }
}

const messages: Record<ErrorCode, string> = {
  CANCELLED: 'Scan cancelled. No partial results were accepted. You can start a new scan.',
  DEADLINE: 'The scan exceeded the ten-minute time limit. No partial results were accepted. Try again with a smaller playlist or a faster connection.',
  LIMIT: 'This playlist exceeded a scan resource limit (50,000 entries, 2,000 pages, or 16 million metadata characters). No partial results were accepted. Scan a smaller playlist.',
  NOT_PLAYLIST: 'Open a playlist on music.apple.com, then open this extension again.',
  PAGE_CHANGED: 'The open playlist or tab changed. Reopen this extension on the playlist you want to scan.',
  MUSICKIT_UNAVAILABLE: 'Apple Music’s MusicKit instance is unavailable. Let the player finish loading, then retry. If it persists, this player version may not expose MusicKit.',
  AUTH: 'Sign in to Apple Music in this tab, then reopen the extension. Your session may have expired.',
  RATE_LIMIT: 'Apple Music is limiting requests. Wait a minute, then try scanning again.',
  NETWORK: 'Apple Music could not be reached. Check your connection and try again.',
  TIMEOUT: 'Apple Music took too long to respond. Check the player and try again.',
  NOT_FOUND: 'Apple Music could not retrieve this playlist. It may be unavailable, empty, or not accessible to this account.',
  API: 'Apple Music rejected the request. Reload the player and try again.',
  SERVER: 'Apple Music is temporarily unavailable. Wait a moment, then try scanning again.',
  FORMAT: 'Apple Music returned an unexpected response. A complete scan could not be verified.',
  INCOMPLETE: 'The playlist response was incomplete or changed during scanning. No results were accepted. Please retry without editing the playlist.',
  INTERNAL: 'The extension hit an internal error. Reload the popup and try again.',
  TAB_ACCESS: 'The extension could not access this tab. Open an Apple Music playlist, reload the page, and retry.',
};

/** Unexpected failures are a bug, not a user mistake: log them instead of blaming the tab. */
const unexpected = 'The extension hit an unexpected error. Reload the popup and try again.';
const offline = 'The extension could not access this tab. Open an Apple Music playlist, reload the page, and retry.';
// Chrome's injection rejections carry no stable code, only localized-free prefixes.
const tabAccessPattern = /Cannot access contents|must request permission|The extensions gallery/i;

function detailOf(error: unknown): string {
  return typeof (error as { message?: unknown })?.message === 'string' ?
    (error as { message: string }).message : '';
}

export function errorMessage(error: unknown): string {
  if (error instanceof ScanError) {
    if (error.code === 'INTERNAL') console.error('[amdf] internal failure');
    return messages[error.code];
  }
  console.error('[amdf] unexpected failure', error);
  return tabAccessPattern.test(detailOf(error)) ? offline : unexpected;
}

/** Stable label used by the popup diagnostics line; never contains provider text. */
export function errorCode(error: unknown): string {
  if (error instanceof ScanError) return error.code;
  return tabAccessPattern.test(detailOf(error)) ? 'TAB_ACCESS' : 'UNEXPECTED';
}
