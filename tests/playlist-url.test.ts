import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlaylist } from '../src/playlist-url';

test('library playlist routes use exactly the visible ID', () => {
  for (const path of ['/us/library/playlist/p.abc123', '/library/playlist/p.abc123', '/gb/playlist/my-mix/p.abc123/']) {
    const result = detectPlaylist(`https://music.apple.com${path}?l=en-US`);
    assert.equal(result.kind, 'library');
    assert.equal(result.id, 'p.abc123');
  }
});

test('catalog playlist route is separate from the library', () => {
  assert.deepEqual(detectPlaylist('https://music.apple.com/us/playlist/mix/pl.abc-123'), {
    id: 'pl.abc-123', kind: 'catalog', storefront: 'us',
  });
});

test('cosmetic route changes do not break detection', () => {
  const expected = { id: 'p.abc123', kind: 'library' as const, storefront: 'us' };
  for (const path of [
    '/us/library/playlist/p.abc123/',
    '/us/library/playlists/p.abc123',
    '/us/library/playlist/p.abc123/tracks',
    '/us/library/playlist/some/extra/name/p.abc123',
    '/US/library/playlist/p.abc123',
  ]) {
    assert.deepEqual(detectPlaylist(`https://music.apple.com${path}`), expected, path);
  }
});

test('non-playlists, other hosts and ambiguous routes fail', () => {
  for (const url of ['invalid', 'https://example.com/us/playlist/p.1', 'http://music.apple.com/us/playlist/p.1',
    'https://music.apple.com/us/browse', 'https://music.apple.com/us/album/x/123',
    'https://music.apple.com/us/library/playlist/pl.1', 'https://music.apple.com/us/playlist/name/123',
    'https://music.apple.com/us/playlist/p.1/p.2',
    'https://music.apple.com/us/playlist/p.']) {
    assert.throws(() => detectPlaylist(url), { code: 'NOT_PLAYLIST' }, url);
  }
});
