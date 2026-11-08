import assert from 'node:assert/strict';
import test from 'node:test';
import { errorCode, errorMessage, ScanError } from '../src/errors';
import { bridgeErrorCodes } from '../src/types';

test('every error code returns an actionable sentence', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const code of bridgeErrorCodes) {
    assert.ok(errorMessage(new ScanError(code)).length > 20, code);
  }
  assert.match(errorMessage(new ScanError('DEADLINE')), /ten-minute time limit/);
  assert.match(errorMessage(new ScanError('LIMIT')), /resource limit/);
  assert.match(errorMessage(new ScanError('SERVER')), /temporarily unavailable/);
  assert.match(errorMessage(new ScanError('TAB_ACCESS')), /could not access this tab/);
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
  assert.match(errorMessage(new TypeError('boom')), /unexpected error/);
  assert.equal(logged.length, 1);
});
