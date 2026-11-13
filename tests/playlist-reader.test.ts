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
  // The same boundary is reachable when Apple supplies no total and the last
  // page is followed by an empty probe.
  const unknown = await readPlaylist(sourceFor(scanLimits.maxTracks, null).source);
  assert.equal(unknown.tracks.length, 50_000);
  assert.equal(unknown.countVerified, false);
  const { source, offsets } = sourceFor(1, 50_001);
  await assert.rejects(readPlaylist(source), { code: 'LIMIT' });
  assert.deepEqual(offsets, []);
});
test('page totals and the cumulative metadata budget are bounded on later pages', async () => {
  const overTotal = sourceFor(1, null).source;
  overTotal.page = async () => ({ tracks: entries(1), total: scanLimits.maxTracks + 1, nextOffset: null });
  await assert.rejects(readPlaylist(overTotal), { code: 'LIMIT' });

  const all: Track[] = Array.from({ length: 20 }, (_, index) => ({
    position: index + 1, name: 'x'.repeat(10), artist: 'y'.repeat(10), catalogId: '1', libraryId: null,
  }));
  const offsets: number[] = [];
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total: null }),
    page: async offset => {
      offsets.push(offset);
      return { tracks: all.slice(offset, offset + 10), total: null, nextOffset: offset === 0 ? 10 : null };
    },
  };
  // 210 characters per page: one page is accepted, the second exceeds 300.
  await assert.rejects(readPlaylist(source, undefined, { maxMetadataChars: 300 }), { code: 'LIMIT' });
  assert.deepEqual(offsets, [0, 10]);
});

test('unknown totals, page exhaustion and metadata budgets cannot return truncated success', async () => {
  await assert.rejects(readPlaylist(sourceFor(201, null).source, undefined, { maxTracks: 200 }), { code: 'LIMIT' });
  await assert.rejects(readPlaylist(sourceFor(5, null, 1).source, undefined, { maxPages: 3 }), { code: 'LIMIT' });
  await assert.rejects(readPlaylist(sourceFor(1).source, undefined, { maxMetadataChars: 1 }), { code: 'LIMIT' });
  await assert.rejects(readPlaylist(sourceFor(1).source, undefined, { maxTracks: 1_000_000 }), { code: 'LIMIT' });
});

test('metadata fetched while connecting is reused as the scan baseline', async () => {
  let metadataCalls = 0;
  const { source } = sourceFor(245, 245);
  const counted: PlaylistSource = {
    ...source,
    metadata: async () => { metadataCalls++; return { ...info, total: 245 }; },
  };
  const result = await readPlaylist(counted, undefined, { info: { ...info, total: 245 } });
  assert.equal(result.tracks.length, 245);
  // Only the final validation round trip remains.
  assert.equal(metadataCalls, 1);
});

test('a progress handler that throws does not discard a valid scan', async (t) => {
  t.mock.method(console, 'error', () => {});
  const result = await readPlaylist(sourceFor(245).source, () => { throw new Error('render failed'); });
  assert.equal(result.tracks.length, 245);
});

test('a modification marker appearing mid-scan invalidates the result', async () => {
  let calls = 0;
  const { source } = sourceFor(245, 245);
  const changing: PlaylistSource = {
    ...source,
    metadata: async () => {
      calls++;
      return calls === 1 ? { ...info, total: 245, modified: null } : { ...info, total: 245, modified: '2026-02-02' };
    },
  };
  await assert.rejects(readPlaylist(changing), { code: 'INCOMPLETE' });
});

test('a scan that cannot finish in time stops early instead of burning the deadline', async () => {
  const total = 5_000;
  let pages = 0;
  const all = entries(total);
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total }),
    page: async offset => {
      pages++;
      await new Promise(resolve => setTimeout(resolve, 150));
      return { tracks: all.slice(offset, offset + 100), total, nextOffset: null };
    },
  };
  const startedAt = Date.now();
  await assert.rejects(readPlaylist(source, () => {}, { deadlineMs: 2_500 }), { code: 'DEADLINE' });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1_800, `aborted after ${elapsed}ms`);
  assert.ok(pages < 15, `fetched ${pages} pages`);
});

test('a single retry does not abort a scan that can still finish', async () => {
  const total = 5_000;
  const all = entries(total);
  let calls = 0;
  let retried = false;
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total }),
    page: async offset => {
      calls++;
      if (offset === 100 && !retried) {
        retried = true;
        throw new ScanError('RATE_LIMIT', { retryAfterMs: 400 });
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      return { tracks: all.slice(offset, offset + 100), total, nextOffset: null };
    },
  };
  // Five seconds keeps this deterministic on a loaded CI machine; the test is
  // about retry not triggering the projected-deadline abort, not about speed.
  const result = await readPlaylist(source, () => {}, { deadlineMs: 5_000 });
  assert.equal(result.tracks.length, 5_000);
  assert.equal(calls, 51);
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
test('transient transport failures are retried and the scan still completes in order', async () => {
  const { source } = sourceFor(245);
  const page = source.page;
  let failures = 0;
  source.page = async offset => {
    if (offset === 100 && failures < 2) { failures++; throw new ScanError('SERVER'); }
    return page(offset);
  };
  const result = await readPlaylist(source);
  assert.equal(failures, 2);
  assert.equal(result.tracks.length, 245);
  assert.equal(result.tracks[244]?.position, 245);
});
test('a retry reports its attempt and the songs retrieved so far before it waits', async () => {
  const { source } = sourceFor(245);
  const page = source.page;
  let failures = 0;
  source.page = async offset => {
    if (offset === 100 && failures < 2) { failures++; throw new ScanError('SERVER'); }
    return page(offset);
  };
  const events: string[] = [];
  await readPlaylist(source, p => {
    if (p.phase === 'retrying') events.push(`retrying ${p.attempt}/${p.attempts} at ${p.retrieved} of ${p.total}`);
    else events.push(`${p.phase} ${p.retrieved}`);
  });
  assert.deepEqual(events, [
    'reading 0', 'reading 100',
    'retrying 1/2 at 100 of 245', 'retrying 2/2 at 100 of 245',
    'reading 200', 'reading 245', 'validating 245',
  ]);
});
test('a retry before the first page reports zero songs and no total yet', async () => {
  let calls = 0;
  const source: PlaylistSource = {
    metadata: async () => {
      calls++;
      if (calls === 1) throw new ScanError('NETWORK');
      return { ...info, total: 1 };
    },
    page: async () => ({ tracks: entries(1), total: 1, nextOffset: null }),
  };
  const first: unknown[] = [];
  await readPlaylist(source, p => { if (p.phase === 'retrying') first.push([p.attempt, p.retrieved, p.total]); });
  assert.deepEqual(first, [[1, 0, null]]);
});
test('server retry-after guidance replaces the short fallback delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total: 1 }),
    page: async () => {
      calls++;
      if (calls === 1) throw new ScanError('RATE_LIMIT', { retryAfterMs: 10_000 });
      return { tracks: entries(1), total: 1, nextOffset: null };
    },
  };
  const pending = readPlaylist(source);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(9_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).tracks.length, 1);
  assert.equal(calls, 2);
});
test('permanent and internal failures are never retried', async () => {
  for (const code of ['AUTH', 'INTERNAL', 'FORMAT'] as const) {
    let calls = 0;
    const source: PlaylistSource = {
      metadata: async () => { calls++; throw new ScanError(code); },
      page: async () => { throw new Error('unreachable'); },
    };
    await assert.rejects(readPlaylist(source), { code });
    assert.equal(calls, 1);
  }
});
test('an empty page after a promised continuation is truncation, not exhaustion', async () => {
  for (const pageSize of [100, 40]) {
    // Lowering the total to the retrieved count must not legitimize the empty
    // reply either; the previous page promised data that did not arrive.
    for (const emptyTotal of [null, pageSize]) {
      const all = entries(200);
      const offsets: number[] = [];
      const source: PlaylistSource = {
        metadata: async () => ({ ...info, total: null }),
        page: async offset => {
          offsets.push(offset);
          if (offset === 0) return { tracks: all.slice(0, pageSize), total: null, nextOffset: pageSize };
          if (offset === pageSize) return { tracks: [], total: emptyTotal, nextOffset: null };
          throw new Error(`unexpected offset ${offset}`);
        },
      };
      await assert.rejects(readPlaylist(source), { code: 'INCOMPLETE' });
      assert.deepEqual(offsets, [0, pageSize]);
    }
  }
});
test('an empty probe after a page without a continuation still marks exhaustion', async () => {
  for (const length of [0, 40, 100]) {
    const all = entries(length);
    const offsets: number[] = [];
    const source: PlaylistSource = {
      metadata: async () => ({ ...info, total: null }),
      page: async offset => {
        offsets.push(offset);
        return { tracks: all.slice(offset, offset + 100), total: null, nextOffset: null };
      },
    };
    const result = await readPlaylist(source);
    assert.equal(result.tracks.length, length);
    assert.equal(result.countVerified, false);
    assert.deepEqual(offsets, length === 0 ? [0] : [0, length]);
  }
  // An empty probe may also supply the total, which then verifies the count.
  const all = entries(40);
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total: null }),
    page: async offset => ({ tracks: all.slice(offset, offset + 100), total: offset === 40 ? 40 : null, nextOffset: null }),
  };
  const result = await readPlaylist(source);
  assert.equal(result.tracks.length, 40);
  assert.equal(result.countVerified, true);
});
test('a page can introduce a total the initial metadata omitted', async () => {
  const all = entries(245);
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total: null }),
    page: async offset => ({
      tracks: all.slice(offset, offset + 100), total: offset >= 100 ? 245 : null, nextOffset: null,
    }),
  };
  const result = await readPlaylist(source);
  assert.equal(result.tracks.length, 245);
  assert.equal(result.countVerified, true);
});
test('final metadata can establish the count when no earlier total was available', async () => {
  const all = entries(30);
  const run = async (finalTotal: number | null) => {
    let calls = 0;
    const source: PlaylistSource = {
      metadata: async () => { calls++; return { ...info, total: calls === 1 ? null : finalTotal }; },
      page: async offset => ({ tracks: all.slice(offset, offset + 100), total: null, nextOffset: null }),
    };
    return readPlaylist(source);
  };
  const result = await run(30);
  assert.equal(result.tracks.length, 30);
  assert.equal(result.countVerified, true);
  await assert.rejects(run(31), { code: 'INCOMPLETE' });
  assert.equal((await run(null)).countVerified, false);
});
test('losing or gaining a revision hash or modification marker invalidates the scan', async () => {
  for (const stage of ['revisionLost', 'revisionAppears', 'modifiedLost', 'modifiedAppears']) {
    const { source } = sourceFor(10);
    let calls = 0;
    source.metadata = async () => {
      calls++;
      const first = calls === 1;
      return {
        ...info, total: 10,
        modified: stage === 'modifiedAppears' ? (first ? null : '2026-01-02') :
          stage === 'modifiedLost' ? (first ? '2026-01-02' : null) : '2026-01-01',
        revision: stage === 'revisionAppears' ? (first ? undefined : 'v2') :
          stage === 'revisionLost' ? (first ? 'v1' : undefined) : undefined,
      };
    };
    await assert.rejects(readPlaylist(source), { code: 'INCOMPLETE' });
  }
});
test('marker availability is reported only when a marker was actually compared', async () => {
  const markers = async (modified: string | null, revision?: string) => {
    const { source } = sourceFor(5);
    source.metadata = async () => ({ ...info, total: 5, modified, ...(revision ? { revision } : {}) });
    return (await readPlaylist(source)).modificationChecked;
  };
  assert.equal(await markers(null), false);
  assert.equal(await markers('2026-01-01'), true);
  assert.equal(await markers(null, 'v1'), true);
});
test('cancellation outranks a permanent transport failure settling in the same turn', async () => {
  const controller = new AbortController();
  let fail!: (error: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const source: PlaylistSource = {
    metadata: async () => ({ ...info, total: 1 }),
    page: () => new Promise((_resolve, reject) => { fail = reject; entered(); }),
  };
  const pending = readPlaylist(source, undefined, { signal: controller.signal });
  await started;
  fail(new ScanError('AUTH'));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});
test('cancellation and the deadline interrupt retry backoff instead of honoring retry-after', async t => {
  for (const mode of ['cancel', 'deadline'] as const) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const controller = new AbortController();
    let calls = 0;
    const source: PlaylistSource = {
      metadata: async () => ({ ...info, total: 1 }),
      page: async () => { calls++; throw new ScanError('RATE_LIMIT', { retryAfterMs: 60_000 }); },
    };
    const pending = readPlaylist(source, undefined, { ...(mode === 'cancel' ? { signal: controller.signal } : {}),
      deadlineMs: 100 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    if (mode === 'cancel') controller.abort(); else t.mock.timers.tick(100);
    await assert.rejects(pending, { code: mode === 'cancel' ? 'CANCELLED' : 'DEADLINE' });
    t.mock.timers.reset();
  }
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

test('cancellation during final metadata validation is immediate', async () => {
  const controller = new AbortController();
  let calls = 0;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const source: PlaylistSource = {
    metadata: async () => {
      calls++;
      if (calls === 1) return { ...info, total: 1 };
      entered();
      return new Promise(() => {});
    },
    page: async () => ({ tracks: entries(1), total: 1, nextOffset: null }),
  };
  const pending = readPlaylist(source, undefined, { signal: controller.signal });
  await waiting;
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.ok(Date.now() - started < 5_000, 'cancellation should not wait for the validation request');
});
