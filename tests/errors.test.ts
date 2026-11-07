import assert from 'node:assert/strict';
import test from 'node:test';
import { errorMessage, ScanError } from '../src/errors';
import { bridgeErrorCodes } from '../src/types';

test('every error code returns an actionable sentence', () => {
  for (const code of bridgeErrorCodes) {
    assert.ok(errorMessage(new ScanError(code)).length > 20, code);
  }
  assert.match(errorMessage(new ScanError('DEADLINE')), /ten-minute time limit/);
  assert.match(errorMessage(new ScanError('LIMIT')), /resource limit/);
  assert.match(errorMessage(new ScanError('SERVER')), /temporarily unavailable/);
});

test('permission denials keep the tab-access guidance', (t) => {
  t.mock.method(console, 'error', () => {});
  assert.match(errorMessage(new Error('Cannot access contents of the page. Extension manifest must request permission.')), /could not access this tab/);
});

test('unexpected failures are logged and never blamed on the tab', (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args[0]); });
  assert.match(errorMessage(new TypeError('boom')), /unexpected error/);
  assert.equal(logged.length, 1);
});
