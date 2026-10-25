import assert from 'node:assert/strict';
import test from 'node:test';
import { ScanError } from '../src/errors';
import { readPlaylist, type PlaylistSource } from '../src/playlist-reader';
import type { PlaylistInfo, Track } from '../src/types';

const info: PlaylistInfo = { name: 'Test playlist', total: null, modified: '2026-01-01' };
const entries = (length: number): Track[] => Array.from({ length }, (_, i) => ({
  position: i + 1, name: `Song ${i}`, artist: 'Artist', catalogId: String(i), libraryId: null,
}));
function sourceFor(length: number, total: number | null = length, pageSize = 100) {
  const all = entries(length);
  const offsets: number[] = [];
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total }),
    page: async (offset) => {
      offsets.push(offset);
      return { tracks: all.slice(offset, offset + pageSize), total, nextOffset: null };
    },
  };
  return { source, offsets };
}
test('pagination retrieves more than 100 tracks in order and reports progress', async () => {
  const { source, offsets } = sourceFor(245);
  const progress: number[] = [];
  const result = await readPlaylist(source, p => progress.push(p.retrieved));
  assert.equal(result.tracks.length, 245);
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.deepEqual(progress, [0, 100, 200, 245]);
  assert.equal(result.tracks[244]?.position, 245);
  assert.equal(result.countVerified, true);
});
test('exact page boundary with no total probes the empty next page', async () => {
  const { source, offsets } = sourceFor(200, null);
  const result = await readPlaylist(source);
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(result.tracks.length, 200);
  assert.equal(result.countVerified, false);
});
test('known total at an exact boundary finishes at that total', async () => {
  const { source, offsets } = sourceFor(200);
  assert.equal((await readPlaylist(source)).tracks.length, 200);
  assert.deepEqual(offsets, [0, 100]);
});
test('short pages are not assumed terminal; next links and actual lengths are honored', async () => {
  const { source, offsets } = sourceFor(125, null, 40);
  const page = source.page;
  source.page = async offset => ({ ...await page(offset), nextOffset: offset < 120 ? offset + 40 : null });
  assert.equal((await readPlaylist(source)).tracks.length, 125);
  assert.deepEqual(offsets, [0, 40, 80, 120, 125]);
});
test('empty playlist succeeds only with a well-formed empty page', async () => {
  assert.equal((await readPlaylist(sourceFor(0).source)).tracks.length, 0);
});
test('incomplete scans with fewer entries than total fail', async () => {
  await assert.rejects(readPlaylist(sourceFor(150, 200).source), { code: 'INCOMPLETE' });
});
test('changing totals, too many entries, skipped offsets and malformed positions fail', async () => {
  const a = sourceFor(150).source;
  a.page = async () => ({ tracks: entries(100), total: 149, nextOffset: null });
  await assert.rejects(readPlaylist(a), { code: 'INCOMPLETE' });
  const b = sourceFor(50, 49).source;
  await assert.rejects(readPlaylist(b), { code: 'INCOMPLETE' });
  const c = sourceFor(150).source;
  c.page = async () => ({ tracks: entries(100), total: 150, nextOffset: 200 });
  await assert.rejects(readPlaylist(c), { code: 'INCOMPLETE' });
  const d = sourceFor(10).source;
  d.page = async () => ({ tracks: entries(10).reverse(), total: 10, nextOffset: null });
  await assert.rejects(readPlaylist(d), { code: 'INCOMPLETE' });
});
test('empty page with next link is incomplete', async () => {
  const source = sourceFor(0).source;
  source.page = async () => ({ tracks: [], total: null, nextOffset: 100 });
  await assert.rejects(readPlaylist(source), { code: 'INCOMPLETE' });
});
test('network failure on a later page does not produce partial results', async () => {
  const { source } = sourceFor(250);
  const page = source.page;
  source.page = async offset => {
    if (offset > 0) throw new ScanError('NETWORK');
    return page(offset);
  };
  await assert.rejects(readPlaylist(source), { code: 'NETWORK' });
});
test('final metadata failure and playlist changes invalidate all results', async () => {
  for (const change of ['failure', 'total', 'modified', 'name']) {
    const source = sourceFor(10).source;
    let calls = 0;
    source.metadata = async () => {
      calls++;
      if (calls === 1) return { ...info, total: 10 };
      if (change === 'failure') throw new ScanError('AUTH');
      return { ...info, total: change === 'total' ? 11 : 10,
        modified: change === 'modified' ? 'new date' : info.modified,
        name: change === 'name' ? 'New name' : info.name };
    };
    await assert.rejects(readPlaylist(source), { code: change === 'failure' ? 'AUTH' : 'INCOMPLETE' });
  }
});
