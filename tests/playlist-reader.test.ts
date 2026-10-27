import assert from 'node:assert/strict';
import test from 'node:test';
import { ScanError } from '../src/errors';
import { readPlaylist, scanLimits, type PlaylistSource } from '../src/playlist-reader';
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
  assert.deepEqual(progress, [0, 100, 200, 245, 245]); // final metadata validation
  assert.equal(result.tracks[244]?.position, 245);
  assert.equal(result.countVerified, true);
});

test('50,000 entries retain order at the practical limit; huge reported totals fail before any track request', async () => {
  const result = await readPlaylist(sourceFor(scanLimits.maxTracks).source);
  assert.equal(result.tracks.length, 50_000);
  assert.equal(result.tracks.at(-1)?.position, 50_000);
  const { source, offsets } = sourceFor(1, 50_001);
  await assert.rejects(readPlaylist(source), { code: 'LIMIT' });
  assert.deepEqual(offsets, []);
});

test('unknown totals, page exhaustion and metadata budgets cannot return truncated success', async () => {
  await assert.rejects(readPlaylist(sourceFor(201, null).source, undefined, { maxTracks: 200 }), { code: 'LIMIT' });
  await assert.rejects(readPlaylist(sourceFor(5, null, 1).source, undefined, { maxPages: 3 }), { code: 'LIMIT' });
  await assert.rejects(readPlaylist(sourceFor(1).source, undefined, { maxMetadataChars: 1 }), { code: 'LIMIT' });
  await assert.rejects(readPlaylist(sourceFor(1).source, undefined, { maxTracks: 1_000_000 }), { code: 'LIMIT' });
});

test('a pre-cancelled scan never calls its source', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const source: PlaylistSource = { metadata: async () => { calls++; return info; }, page: async () => { throw new Error(); } };
  await assert.rejects(readPlaylist(source, undefined, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
});

test('cancellation during a hung request is immediate, propagates a signal and ignores late results', async () => {
  const controller = new AbortController();
  let finish!: (page: Awaited<ReturnType<PlaylistSource['page']>>) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const source: PlaylistSource = {
    metadata: async () => info,
    page: async (_offset, requestSignal) => { signal = requestSignal; entered(); return new Promise(resolve => { finish = resolve; }); },
  };
  const progress: number[] = [];
  const pending = readPlaylist(source, p => progress.push(p.retrieved), { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(signal?.aborted, true);
  const next = await readPlaylist(sourceFor(2).source);
  finish({ tracks: entries(100), total: 100, nextOffset: null });
  await Promise.resolve();
  assert.deepEqual(progress, [0]);
  assert.equal(next.tracks.length, 2);
});

test('deadline interrupts hung initial metadata, later pages and final validation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const stage of ['initial', 'page', 'final']) {
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const hang = (): Promise<never> => { entered(); return new Promise(() => {}); };
    let metadataCalls = 0;
    const source: PlaylistSource = {
      metadata: async () => { metadataCalls++; return stage === 'initial' || stage === 'final' && metadataCalls === 2 ? hang() : { ...info, total: 0 }; },
      page: async () => stage === 'page' ? hang() : { tracks: [], total: 0, nextOffset: null },
    };
    const pending = readPlaylist(source, undefined, { deadlineMs: 100 });
    await waiting;
    t.mock.timers.tick(100);
    await assert.rejects(pending, { code: 'DEADLINE' });
  }
});

test('cancellation from progress stops before fetching the next page', async () => {
  const { source, offsets } = sourceFor(250);
  const controller = new AbortController();
  await assert.rejects(readPlaylist(source, p => { if (p.retrieved === 100) controller.abort(); },
    { signal: controller.signal }), { code: 'CANCELLED' });
  assert.deepEqual(offsets, [0]);
});

test('slow but individually successful pages still obey the overall deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { source, offsets } = sourceFor(400);
  const page = source.page;
  source.page = async offset => {
    t.mock.timers.tick(10_000);
    return page(offset);
  };
  await assert.rejects(readPlaylist(source, undefined, { deadlineMs: 25_000 }), { code: 'DEADLINE' });
  assert.deepEqual(offsets, [0, 100, 200]);
});

test('independent concurrent scans cannot cancel or change each other', async () => {
  const controller = new AbortController();
  const a = readPlaylist(sourceFor(250).source, p => { if (p.retrieved === 100) controller.abort(); }, { signal: controller.signal });
  const b = readPlaylist(sourceFor(245).source);
  await assert.rejects(a, { code: 'CANCELLED' });
  assert.equal((await b).tracks.length, 245);
});

test('rename, addition, removal and same-count replacement/reordering with changed markers invalidate scans', async () => {
  for (const change of ['rename', 'add', 'remove', 'replace', 'reorder', 'revision', 'lostMarker']) {
    const { source } = sourceFor(245);
    let calls = 0;
    source.metadata = async () => {
      calls++;
      const initial = { ...info, total: 245, revision: 'v1' };
      if (calls === 1) return initial;
      return { ...initial, name: change === 'rename' ? 'Renamed' : info.name,
        total: change === 'add' ? 246 : change === 'remove' ? 244 : 245,
        modified: ['replace', 'reorder'].includes(change) ? 'new marker' : change === 'lostMarker' ? null : info.modified,
        revision: change === 'revision' ? 'v2' : 'v1' };
    };
    await assert.rejects(readPlaylist(source), { code: 'INCOMPLETE' });
  }
});

test('same-count edits without a marker are explicitly unverified even when count matches', async () => {
  for (const edit of ['replace', 'reorder']) {
    const { source } = sourceFor(245);
    source.metadata = async () => ({ ...info, total: 245, modified: null });
    const page = source.page;
    source.page = async offset => {
      const result = await page(offset);
      if (offset === 100) result.tracks = result.tracks.map((track, i) => ({ ...track,
        catalogId: edit === 'replace' ? 'replacement' : String(199 - i) }));
      return result;
    };
    const result = await readPlaylist(source);
    assert.equal(result.countVerified, true);
    assert.equal(result.modificationChecked, false);
  }
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
