import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { glob } from 'glob';
import os from 'node:os';
import path from 'node:path';

const tempDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'stitch-vscode-tests-'),
);
const tests = await glob('src/**/*.test.mts');

try {
  await esbuild.build({
    entryPoints: tests,
    bundle: true,
    format: 'cjs',
    outdir: tempDirectory,
    outbase: 'src',
    entryNames: '[dir]/[name]',
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    sourcemap: 'inline',
    target: 'node22',
  });
  const outputs = tests.map((test) =>
    path.join(
      tempDirectory,
      path.relative('src', test).replace(/\.mts$/, '.cjs'),
    ),
  );
  execFileSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' });
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
