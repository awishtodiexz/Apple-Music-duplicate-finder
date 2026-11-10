import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This benchmark measures the extension's own CPU/pagination overhead. It does
// not claim to reproduce Apple API latency; the reader's deadline remains the
// authority for network-bound scans. Timings are informational: only
// deterministic counts and generous cancellation bounds are asserted so a busy
// CI machine cannot turn a performance sample into a flaky failure.
const iterations = Number(process.env.BENCHMARK_ITERATIONS ?? 5);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) {
  throw new Error('BENCHMARK_ITERATIONS must be an integer from 1 to 20');
}
const gc = global.gc;
const formatMs = value => `${value.toFixed(value < 10 ? 2 : 1)}ms`;
const formatBytes = bytes => {
  const sign = bytes < 0 ? '-' : '';
  const value = Math.abs(bytes);
  return value >= 1024 * 1024 ? `${sign}${(value / 1024 / 1024).toFixed(2)} MiB` :
    value >= 1024 ? `${sign}${(value / 1024).toFixed(1)} KiB` : `${sign}${value} B`;
};
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const stats = values => ({ min: Math.min(...values), median: median(values), max: Math.max(...values) });
const report = samples => {
  const values = stats(samples);
  return `${formatMs(values.median)} median (${formatMs(values.min)}-${formatMs(values.max)})`;
};

async function timeAsync(operation, runs = iterations) {
  const samples = [];
  let value;
  for (let index = 0; index < runs; index++) {
    gc?.();
    const started = performance.now();
    value = await operation();
    samples.push(performance.now() - started);
  }
  return { value, samples };
}
function timeSync(operation, runs = iterations) {
  const samples = [];
  let value;
  for (let index = 0; index < runs; index++) {
    gc?.();
    const started = performance.now();
    value = operation();
    samples.push(performance.now() - started);
  }
  return { value, samples };
}

await rm('.cache/bench', { recursive: true, force: true });
await build({
  entryPoints: ['src/playlist-reader.ts', 'src/duplicates.ts', 'src/results.ts'],
  outdir: '.cache/bench',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'silent',
});
const reader = await import(pathToFileURL(resolve('.cache/bench/playlist-reader.js')).href);
const duplicates = await import(pathToFileURL(resolve('.cache/bench/duplicates.js')).href);
const results = await import(pathToFileURL(resolve('.cache/bench/results.js')).href);

const entries = (length) => Array.from({ length }, (_, index) => ({
  position: index + 1,
  name: `Song ${index}`,
  artist: 'Artist',
  catalogId: String(index % Math.max(1, Math.floor(length / 2))),
  libraryId: null,
}));

console.log(`Node ${process.version}; ${iterations} sample(s) per operation; ` +
  `explicit GC ${gc ? 'enabled' : 'unavailable (run with --expose-gc for heap deltas)'}`);
console.log('CPU/pagination only: fixture pages resolve synchronously; this is not Apple network latency.');

let peakRss = process.memoryUsage().rss;
for (const count of [1_000, 10_000, 50_000]) {
  const all = entries(count);
  let requests = 0;
  const source = {
    metadata: async () => ({ name: 'Benchmark playlist', total: count, modified: null }),
    page: async offset => {
      requests++;
      return { tracks: all.slice(offset, offset + 100), total: count, nextOffset: null };
    },
  };

  // Warm the reader and matcher before sampling so the first workload is not
  // charged for JIT compilation. The warmed results are released immediately.
  const warmScan = await reader.readPlaylist(source);
  const warmGroups = duplicates.findDuplicates(warmScan.tracks).groups;
  results.toCsv(warmGroups);
  results.visibleGroups(warmGroups, 'Song 1', 'copies', 2);
  requests = 0;

  const scanTiming = await timeAsync(() => reader.readPlaylist(source));
  const scan = scanTiming.value;
  const dedupeTiming = timeSync(() => duplicates.findDuplicates(scan.tracks));
  const found = dedupeTiming.value;
  const csvTiming = timeSync(() => results.toCsv(found.groups));
  const csv = csvTiming.value;
  const filterSortTiming = timeSync(() => results.visibleGroups(found.groups, 'Song 1', 'copies', 2));
  const filtered = filterSortTiming.value;

  // Deterministic correctness assertions keep this a regression test as well as
  // a measurement. The fixture maps two consecutive entries onto one identity.
  const expectedGroups = Math.ceil(count / 2);
  const pagesPerSample = Math.ceil(count / 100);
  assert.equal(requests, pagesPerSample * iterations, 'one request per page and sample');
  assert.equal(scan.tracks.length, count);
  assert.equal(scan.tracks[0]?.position, 1);
  assert.equal(scan.tracks.at(-1)?.position, count);
  assert.equal(scan.countVerified, true);
  assert.equal(found.groups.length, expectedGroups);
  assert.equal(found.extraCopies, count - expectedGroups);
  assert.equal(found.unidentified, 0);
  assert.equal(csv.split('\r\n').length, expectedGroups + 2, 'header, one row per group, trailing newline');
  assert.ok(filtered.length > 0);

  // Retained heap for the scan result, duplicate groups, CSV text and a filtered
  // view. The source array is allocated before the baseline, so it is excluded.
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const retainedScan = await reader.readPlaylist(source);
  const retainedGroups = duplicates.findDuplicates(retainedScan.tracks).groups;
  const retainedCsv = results.toCsv(retainedGroups);
  const retainedFiltered = results.visibleGroups(retainedGroups, 'Song 1', 'copies', 2);
  gc?.();
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  // Keep the measured values alive until the numbers are printed.
  assert.ok(retainedScan.tracks.length === count && retainedGroups.length === expectedGroups &&
    retainedCsv.length > 0 && retainedFiltered.length > 0);

  console.log(`${count.toLocaleString()} tracks: ${pagesPerSample} page calls/sample, ` +
    `read ${report(scanTiming.samples)}, match ${report(dedupeTiming.samples)}, ` +
    `CSV ${report(csvTiming.samples)}, filter/sort ${report(filterSortTiming.samples)}; ` +
    `${found.groups.length.toLocaleString()} groups, CSV ${formatBytes(csv.length)}, ` +
    `retained heap +${formatBytes(heapDelta)}, RSS ${formatBytes(process.memoryUsage().rss)}`);
}

// Cancellation must stop the reader promptly even when the page source cannot
// abort its own request. This is the unit-level latency; the browser suites also
// exercise cancellation through the real extension transport.
const cancellationSamples = [];
for (let index = 0; index < iterations; index++) {
  const controller = new AbortController();
  let pageSignal;
  let entered;
  const startedPage = new Promise(resolve => { entered = resolve; });
  const source = {
    metadata: async () => ({ name: 'Cancellation', total: 1, modified: null }),
    page: async (_offset, signal) => {
      pageSignal = signal;
      entered();
      return new Promise(() => {});
    },
  };
  const pending = reader.readPlaylist(source, undefined, { signal: controller.signal });
  await startedPage;
  const started = performance.now();
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  cancellationSamples.push(performance.now() - started);
  assert.equal(pageSignal?.aborted, true, 'cancellation reaches the page source signal');
}
const cancellation = stats(cancellationSamples);
// Generous bound: this path normally settles in a few milliseconds; 2 seconds
// still proves cancellation does not wait for a stalled request or a timeout.
assert.ok(cancellation.max < 2_000, `cancellation took ${formatMs(cancellation.max)}`);
console.log(`Cancellation: ${report(cancellationSamples)} over ${iterations} run(s), bound 2000ms`);

console.log(`Peak RSS observed: ${formatBytes(peakRss)}. ` +
  'Memory and timings are machine-dependent samples, not release thresholds.');
