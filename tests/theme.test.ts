import assert from 'node:assert/strict';
import test from 'node:test';
import { isThemePreference, nextTheme, themeLabel } from '../src/theme';

test('the theme control cycles auto, light and dark in order', () => {
  assert.equal(nextTheme('auto'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'auto');
});

test('only known theme values are accepted', () => {
  for (const value of ['auto', 'light', 'dark']) {
    assert.equal(isThemePreference(value), true);
  }
  for (const value of ['Auto', 'system', '', null, undefined, 0]) {
    assert.equal(isThemePreference(value), false);
  }
});

test('theme labels stay short enough for the header control', () => {
  assert.equal(themeLabel('auto'), 'Auto');
  assert.equal(themeLabel('light'), 'Light');
  assert.equal(themeLabel('dark'), 'Dark');
});
