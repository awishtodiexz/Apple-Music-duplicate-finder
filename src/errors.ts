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

export type Recovery = 'rescan' | 'reconnect' | 'navigate' | 'none';

/** The one control each error offers. Messages name only that control. */
export const recoveryLabel: Record<Recovery, string | null> =
  { rescan: 'Retry scan', reconnect: 'Retry connection', navigate: null, none: null };

const internalFailure = 'Something went wrong in the extension. Press Retry scan. If it keeps happening, close and reopen the extension.';

const policies: Record<ErrorCode, { message: string; recovery: Recovery }> = {
  CANCELLED: { message: 'No partial results were kept.', recovery: 'rescan' },
  DEADLINE: { message: 'The scan would not finish within the ten-minute limit. No partial results were kept. Press Retry scan on a faster connection, or scan a smaller playlist.', recovery: 'rescan' },
  LIMIT: { message: 'This playlist is larger than the extension can scan. No partial results were kept.', recovery: 'none' },
  NOT_PLAYLIST: { message: 'Open a playlist on music.apple.com, then open the extension again.', recovery: 'navigate' },
  PAGE_CHANGED: { message: 'The open playlist or tab changed. Press Retry connection to use it.', recovery: 'reconnect' },
  MUSICKIT_UNAVAILABLE: { message: "The Apple Music player hasn't finished loading. Wait a moment, then press Retry connection.", recovery: 'reconnect' },
  AUTH: { message: 'Sign in to Apple Music in this tab, then press Retry connection.', recovery: 'reconnect' },
  RATE_LIMIT: { message: 'Apple Music is limiting requests. Wait a minute, then press Retry scan.', recovery: 'rescan' },
  NETWORK: { message: 'Apple Music could not be reached. Check your connection, then press Retry scan.', recovery: 'rescan' },
  TIMEOUT: { message: 'Apple Music took too long to respond. Check the player, then press Retry scan.', recovery: 'rescan' },
  NOT_FOUND: { message: 'Apple Music could not retrieve this playlist. It may be unavailable, empty, or not accessible to this account. Press Retry connection to check again.', recovery: 'reconnect' },
  API: { message: 'Apple Music rejected the request. Reload the Apple Music page, then press Retry scan.', recovery: 'rescan' },
  SERVER: { message: 'Apple Music is temporarily unavailable. Wait a moment, then press Retry scan.', recovery: 'rescan' },
  FORMAT: { message: 'Apple Music returned an unexpected response. A complete scan could not be verified. Press Retry scan.', recovery: 'rescan' },
  INCOMPLETE: { message: "Apple Music's response changed or did not add up, so the scan is incomplete. No partial results were kept. Press Retry scan.", recovery: 'rescan' },
  INTERNAL: { message: internalFailure, recovery: 'rescan' },
  TAB_ACCESS: { message: 'The extension could not access this tab. Reload the Apple Music page, then press Retry connection.', recovery: 'reconnect' },
  TAB_CLOSED: { message: 'The Apple Music tab was closed. Open a playlist on music.apple.com, then open the extension from that tab.', recovery: 'navigate' },
};

// Where a rescan-only message would be wrong before anything has been scanned.
const connectMessages: Partial<Record<ErrorCode, string>> = {
  LIMIT: 'This playlist is larger than the extension can scan.',
  DEADLINE: 'Apple Music took too long to respond. Check your connection, then press Retry connection.',
  FORMAT: 'Apple Music returned an unexpected response. Press Retry connection.',
  INCOMPLETE: "Apple Music's response changed or did not add up. Press Retry connection.",
};

// Chrome's injection rejections carry no stable code, only localized-free prefixes.
const tabAccessPattern = /Cannot access contents|must request permission|The extensions gallery/i;

function detailOf(error: unknown): string {
  try {
    const message = (error as { message?: unknown })?.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

/** Log a stable label only; provider text and thrown values can contain private data. */
function safeErrorLabel(error: unknown): string {
  try {
    if (error instanceof Error) return error.name || 'Error';
    if (error !== null && typeof error === 'object') {
      const name = (error as { name?: unknown }).name;
      if (typeof name === 'string') return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : 'UnknownError';
    }
    return typeof error;
  } catch {
    return 'UnknownError';
  }
}

/** Unexpected failures are a bug, not a user mistake: log them instead of blaming the tab. */
export function errorMessage(error: unknown): string {
  if (error instanceof ScanError) {
    if (error.code === 'INTERNAL') console.error('[amdf] internal failure');
    return policies[error.code].message;
  }
  console.error('[amdf] unexpected failure', safeErrorLabel(error));
  return tabAccessPattern.test(detailOf(error)) ? policies.TAB_ACCESS.message : internalFailure;
}

export function errorRecovery(error: unknown): Recovery {
  if (error instanceof ScanError) return policies[error.code].recovery;
  return tabAccessPattern.test(detailOf(error)) ? 'reconnect' : 'rescan';
}

/**
 * With no connection yet there is nothing to rescan, so a retryable failure is retried
 * by reconnecting and the message names that control instead. Messages about a scan
 * that never started (partial results, ten-minute limit) get connect-time wording.
 */
export function connectFailure(error: unknown): { message: string; recovery: Recovery } {
  const recovery = errorRecovery(error);
  const message = (error instanceof ScanError && connectMessages[error.code]) || errorMessage(error);
  if (recovery !== 'rescan') return { message, recovery };
  return { message: message.replace(recoveryLabel.rescan!, recoveryLabel.reconnect!), recovery: 'reconnect' };
}

/** Stable label used by the popup diagnostics line; never contains provider text. */
export function errorCode(error: unknown): string {
  if (error instanceof ScanError) return error.code;
  return tabAccessPattern.test(detailOf(error)) ? 'TAB_ACCESS' : 'UNEXPECTED';
}
