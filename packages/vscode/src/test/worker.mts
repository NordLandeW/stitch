import { Yy } from '@bscotch/yy';
import { pathy } from '@bscotch/pathy';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { WorkerLanguageService } from '../language/client.mjs';
import type {
  DiagnosticSnapshot,
  Initialization,
} from '../language/protocol.mjs';

const packageRoot = existsSync(
  path.join(process.cwd(), 'src/language-worker.mts'),
)
  ? process.cwd()
  : path.join(process.cwd(), 'packages/vscode');
const localRequire = createRequire(path.join(packageRoot, 'package.json'));
export const parserRoot = path.resolve(packageRoot, '../parser');

/** Build the production entry with the production bundler options. Native spec
 * inputs are explicit so the test does not discover runtimes or access feeds. */
export async function buildTestWorker(directory: string): Promise<string> {
  const esbuild = localRequire('esbuild') as typeof import('esbuild');
  const output = path.join(directory, 'language-worker.cjs');
  await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/language-worker.mts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    keepNames: true,
    loader: { '.xml': 'text', '.html': 'text', '.node': 'file' },
    inject: ['scripts/injection.js'],
    define: { 'import.meta.url': 'import_meta_url' },
    logLevel: 'silent',
  });
  return output;
}

export async function workerFixture(sources: Record<string, string>) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'stitch-language-worker-'),
  );
  try {
    const yyp = await Yy.read(
      path.join(parserRoot, 'samples/project/project.yyp'),
      'project',
    );
    yyp.resources = [];
    yyp.RoomOrderNodes = [];
    yyp.configs = {
      name: 'Default',
      children: [{ name: 'Test', children: [] }],
    };
    const yypPath = pathy(path.join(directory, 'project.yyp')).absolute;
    const files: Record<string, string> = {};
    const script = await Yy.read(
      path.join(parserRoot, 'samples/project/scripts/Script1/Script1.yy'),
      'scripts',
    );
    for (const [name, text] of Object.entries(sources)) {
      const relative = `scripts/${name}/${name}.yy`;
      yyp.resources.push({ id: { name, path: relative } });
      await mkdir(path.join(directory, 'scripts', name), { recursive: true });
      await writeFile(
        path.join(directory, relative),
        Yy.stringify({ ...script, name, '%Name': name }),
      );
      const file = path.join(directory, 'scripts', name, `${name}.gml`);
      await writeFile(file, text);
      files[name] = pathy(file).absolute;
    }
    await writeFile(yypPath, Yy.stringify(yyp));
    const workerPath = await buildTestWorker(directory);
    const diagnostics = new Map<string, DiagnosticSnapshot>();
    const errors: Error[] = [];
    const input: Initialization = {
      yypPath,
      configuration: 'Default',
      nativeSpecFiles: [path.join(parserRoot, 'assets/GmlSpec.xml')],
    };
    let worker!: Worker;
    const service = new WorkerLanguageService(input, workerPath, {
      delay: () => 50,
      createWorker: () => (worker = new Worker(workerPath)),
      onCommit: (snapshots) => {
        for (const snapshot of snapshots)
          diagnostics.set(snapshot.path, snapshot);
      },
      onError: (error) => errors.push(error),
    });
    let version = 0;
    return {
      directory,
      yyp,
      yypPath,
      files,
      workerPath,
      service,
      diagnostics,
      errors,
      input,
      get worker() {
        return worker;
      },
      async edit(name: string, text: string, generation = 1) {
        service.update(
          {
            kind: 'document',
            path: files[name],
            text,
            version: ++version,
            generation,
          },
          true,
        );
        await service.flush();
      },
      async write(name: string, text: string) {
        await writeFile(files[name], text);
      },
      async dispose() {
        service.dispose();
        await worker.terminate();
        await rm(directory, { recursive: true, force: true });
      },
      async diskText(name: string) {
        return readFile(files[name], 'utf8');
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
