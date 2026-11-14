import assert from 'node:assert/strict';
import test from 'node:test';
import { connectFailure, errorCode, errorMessage, errorRecovery, recoveryLabel, ScanError } from '../src/errors';
import type { ErrorCode } from '../src/types';

// Typed as a full record so adding an ErrorCode without a row fails the type check.
const everyCode: Record<ErrorCode, true> = {
  CANCELLED: true, DEADLINE: true, LIMIT: true, NOT_PLAYLIST: true, PAGE_CHANGED: true,
  MUSICKIT_UNAVAILABLE: true, AUTH: true, RATE_LIMIT: true, NETWORK: true, TIMEOUT: true,
  NOT_FOUND: true, API: true, SERVER: true, FORMAT: true, INCOMPLETE: true, INTERNAL: true,
  TAB_ACCESS: true, TAB_CLOSED: true,
};
const codes = Object.keys(everyCode) as ErrorCode[];
const labels = Object.values(recoveryLabel).filter((label): label is string => label !== null);

test('every error code returns an actionable sentence', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const code of codes) {
    assert.ok(errorMessage(new ScanError(code)).length > 20, code);
  }
  assert.match(errorMessage(new ScanError('DEADLINE')), /ten-minute limit/);
  assert.match(errorMessage(new ScanError('LIMIT')), /larger than the extension can scan/);
  assert.match(errorMessage(new ScanError('SERVER')), /temporarily unavailable/);
  assert.match(errorMessage(new ScanError('TAB_ACCESS')), /could not access this tab/);
  assert.match(errorMessage(new ScanError('TAB_CLOSED')), /Apple Music tab was closed.*open the extension from that tab/);
});

test('each message names only the control its recovery shows', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const code of codes) {
    // A cancel is not a failure, so its message names no control and the popup offers the ordinary scan button.
    if (code === 'CANCELLED') continue;
    const error = new ScanError(code);
    const expected = recoveryLabel[errorRecovery(error)];
    for (const label of labels) {
      if (label === expected) assert.ok(errorMessage(error).includes(label), `${code} should name ${label}`);
      else assert.ok(!errorMessage(error).includes(label), `${code} should not name ${label}`);
    }
  }
});

test('a cancelled scan names no button and keeps no results', () => {
  const message = errorMessage(new ScanError('CANCELLED'));
  for (const label of labels) assert.ok(!message.includes(label), label);
  assert.match(message, /No partial results were kept/);
});

test('failures before a connection exists are retried by reconnecting', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const code of codes.filter(code => code !== 'CANCELLED' && errorRecovery(new ScanError(code)) === 'rescan')) {
    const failure = connectFailure(new ScanError(code));
    assert.equal(failure.recovery, 'reconnect', code);
    assert.ok(!failure.message.includes(recoveryLabel.rescan!), `${code} should not name Retry scan`);
    assert.ok(failure.message.includes(recoveryLabel.reconnect!), `${code} should name Retry connection`);
    // Nothing has been scanned yet, so a message about a scan's partial results or its time limit is wrong.
    assert.doesNotMatch(failure.message, /partial results|ten-minute|scan would not|incomplete/i, `${code} describes a scan that never started`);
  }
  assert.deepEqual(connectFailure(new ScanError('NOT_PLAYLIST')),
    { message: errorMessage(new ScanError('NOT_PLAYLIST')), recovery: 'navigate' });
  // Over the limit is known at connect, where nothing was scanned; mid-scan it keeps the partial-results sentence.
  assert.deepEqual(connectFailure(new ScanError('LIMIT')),
    { message: 'This playlist is larger than the extension can scan.', recovery: 'none' });
  assert.match(errorMessage(new ScanError('LIMIT')), /No partial results were kept./);
  assert.deepEqual(connectFailure(new ScanError('AUTH')),
    { message: errorMessage(new ScanError('AUTH')), recovery: 'reconnect' });
});

test('each error code maps to the recovery the popup offers', (t) => {
  t.mock.method(console, 'error', () => {});
  const recovery = (code: ErrorCode) => errorRecovery(new ScanError(code));
  assert.equal(recovery('NOT_PLAYLIST'), 'navigate');
  assert.equal(recovery('LIMIT'), 'none');
  assert.equal(recovery('TAB_CLOSED'), 'navigate');
  for (const code of ['PAGE_CHANGED', 'MUSICKIT_UNAVAILABLE', 'AUTH', 'NOT_FOUND', 'TAB_ACCESS'] as const) {
    assert.equal(recovery(code), 'reconnect', code);
  }
  for (const code of ['CANCELLED', 'DEADLINE', 'RATE_LIMIT', 'INCOMPLETE', 'INTERNAL'] as const) {
    assert.equal(recovery(code), 'rescan', code);
  }
});

test('unexpected failures retry the scan, or reconnect when the tab is blocked', (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(errorRecovery(new TypeError('boom')), 'rescan');
  assert.equal(errorRecovery(new Error('Cannot access contents of the page.')), 'reconnect');
});

test('messages keep jargon, banned verbs and repeated titles out of the popup', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const code of codes.filter(code => code !== 'INTERNAL')) {
    assert.doesNotMatch(errorMessage(new ScanError(code)), /MusicKit|API|Please|reopen the extension|Reload the popup/, code);
  }
  // INTERNAL is the one message allowed to tell the user to reopen; keep that guidance covered.
  assert.match(errorMessage(new ScanError('INTERNAL')), /close and reopen the extension/);
  assert.doesNotMatch(errorMessage(new ScanError('CANCELLED')), /^Scan cancelled/);
});

test('diagnostic codes stay stable and never include provider text', () => {
  assert.equal(errorCode(new ScanError('INTERNAL')), 'INTERNAL');
  assert.equal(errorCode(new TypeError('private')), 'UNEXPECTED');
});

test('permission denials keep the tab-access guidance and code', (t) => {
  t.mock.method(console, 'error', () => {});
  const denial = new Error('Cannot access contents of the page. Extension manifest must request permission.');
  assert.match(errorMessage(denial), /could not access this tab/);
  assert.equal(errorCode(denial), 'TAB_ACCESS');
});

test('unexpected failures are logged and never blamed on the tab', (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args[0]); });
  assert.match(errorMessage(new TypeError('boom')), /Something went wrong in the extension/);
  assert.equal(logged.length, 1);
});
