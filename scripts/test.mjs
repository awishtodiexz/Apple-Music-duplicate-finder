import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

// Explicit paths work on Windows and Node 22. Default process isolation also keeps
// the page-world mocks in bridge tests out of other test files.
const files = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).sort();
if (!files.length) throw new Error('No unit tests found');
console.log(`Unit test runtime: Node ${process.version}`);
await build({ entryPoints: files.map(name => `tests/${name}`), outdir: '.cache/tests',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: 'inline' });
const result = spawnSync(process.execPath, ['--test', ...files.map(name => `.cache/tests/${name.replace(/\.ts$/, '.js')}`)], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
