import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This benchmark measures the extension's own CPU/pagination overhead. It does
// not claim to reproduce Apple API latency; the reader's deadline remains the
// authority for network-bound scans.
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
  const scanStarted = performance.now();
  const scan = await reader.readPlaylist(source);
  const scanMs = performance.now() - scanStarted;
  const dedupeStarted = performance.now();
  const found = duplicates.findDuplicates(scan.tracks);
  const dedupeMs = performance.now() - dedupeStarted;
  const csvStarted = performance.now();
  const csv = results.toCsv(found.groups);
  const csvMs = performance.now() - csvStarted;
  console.log(`${count.toLocaleString()} tracks: ${requests} page calls, ` +
    `read ${scanMs.toFixed(0)}ms, match ${dedupeMs.toFixed(0)}ms, ` +
    `CSV ${csvMs.toFixed(0)}ms (${(csv.length / 1024).toFixed(0)} KiB), ` +
    `${found.groups.length.toLocaleString()} groups`);
}
