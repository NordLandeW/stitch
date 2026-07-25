import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'stitch-vscode-tests-'),
);
const output = path.join(tempDirectory, 'gameMakerProtocol.test.cjs');

try {
  await esbuild.build({
    entryPoints: ['src/debug/gameMakerProtocol.test.mts'],
    bundle: true,
    format: 'cjs',
    outfile: output,
    platform: 'node',
    sourcemap: 'inline',
    target: 'node22',
  });
  execFileSync(process.execPath, ['--test', output], { stdio: 'inherit' });
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
