import { pathy } from '@bscotch/pathy';
import { expect } from 'chai';
import { path7z } from '7z-bin';
import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { createServer, type RequestListener } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { rejects } from 'node:assert/strict';
import { download, extractIdeInstaller, listInstalledIdes } from './utility.js';

function run(command: string, args: string[], options?: { cwd?: string }) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { ...options, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function withServer<T>(
  listener: RequestListener,
  callback: (url: string) => Promise<T>,
) {
  const server = createServer((request, response) => {
    // These synthetic bytes are not an installer download. Avoid triggering
    // download-manager integration in the developer's desktop session.
    response.setHeader('Content-Type', 'text/plain');
    listener(request, response);
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // Keep local fixtures out of proxies inherited from the package manager.
  const previousNoProxy = process.env.npm_config_no_proxy;
  process.env.npm_config_no_proxy = '127.0.0.1';
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine test server address');
    }
    return await callback(`http://127.0.0.1:${address.port}/fixture`);
  } finally {
    if (previousNoProxy === undefined) delete process.env.npm_config_no_proxy;
    else process.env.npm_config_no_proxy = previousNoProxy;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('launcher downloads and IDE extraction', function () {
  let testDirectory: string;

  beforeEach(async function () {
    testDirectory = await mkdtemp(path.join(tmpdir(), 'stitch-launcher-test-'));
  });

  afterEach(async function () {
    await rm(testDirectory, { recursive: true, force: true });
  });

  it('downloads through a partial file and atomically replaces the target', async function () {
    const destination = pathy(path.join(testDirectory, 'installer.exe'));
    await writeFile(destination.absolute, 'old installer');
    const body = Buffer.from('complete new installer');

    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'Content-Length': body.length });
        response.end(body);
      },
      async (url) => {
        expect(await download(url, destination)).to.equal(false);
        expect(await readFile(destination.absolute, 'utf8')).to.equal(
          'old installer',
        );

        expect(await download(url, destination, { force: true })).to.equal(
          true,
        );
      },
    );

    expect(await readFile(destination.absolute)).to.deep.equal(body);
    expect(await readdir(testDirectory)).to.deep.equal(['installer.exe']);
  });

  it('preserves the existing target and removes partial files after a short download', async function () {
    const destination = pathy(path.join(testDirectory, 'installer.exe'));
    await writeFile(destination.absolute, 'known good installer');

    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'Content-Length': 100 });
        response.write('incomplete');
        response.destroy();
      },
      (url) => rejects(download(url, destination, { force: true })),
    );

    expect(await readFile(destination.absolute, 'utf8')).to.equal(
      'known good installer',
    );
    expect(await readdir(testDirectory)).to.deep.equal(['installer.exe']);
  });

  it('requests unencoded artifact bytes from servers that support HTTP compression', async function () {
    const destination = pathy(path.join(testDirectory, 'installer.exe'));
    const body = Buffer.from('uncompressed installer bytes');
    let acceptEncoding: string | undefined;
    await withServer(
      (request, response) => {
        acceptEncoding = request.headers['accept-encoding'];
        const compressed = acceptEncoding !== 'identity';
        const payload = compressed ? gzipSync(body) : body;
        response.writeHead(200, {
          'Content-Length': payload.length,
          ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
        });
        response.end(payload);
      },
      (url) => download(url, destination),
    );
    expect(acceptEncoding).to.equal('identity');
    expect(await readFile(destination.absolute)).to.deep.equal(body);
  });

  it('rejects unexpected content encoding without replacing the cached artifact', async function () {
    const destination = pathy(path.join(testDirectory, 'installer.exe'));
    await writeFile(destination.absolute, 'known good installer');
    const body = gzipSync(Buffer.from('encoded installer'));
    await withServer(
      (_request, response) => {
        response.writeHead(200, {
          'Content-Length': body.length,
          'Content-Encoding': 'gzip',
        });
        response.end(body);
      },
      (url) =>
        rejects(
          download(url, destination, { force: true }),
          /Unexpected Content-Encoding/,
        ),
    );
    expect(await readFile(destination.absolute, 'utf8')).to.equal(
      'known good installer',
    );
    expect(await readdir(testDirectory)).to.deep.equal(['installer.exe']);
  });

  it('does not discover unpublished IDE caches but can validate a staging directory explicitly', async function () {
    const stable = path.join(testDirectory, 'gamemaker-2026.0.0.1');
    const staging = `${stable}.extracting-00000000-0000-4000-8000-000000000000`;
    const backup = `${stable}.replaced-00000000-0000-4000-8000-000000000000`;
    for (const directory of [stable, staging, backup]) {
      await mkdir(directory);
      await writeFile(path.join(directory, 'GameMaker.exe'), 'fixture');
    }
    expect(
      (await listInstalledIdes(testDirectory)).map((file) => file.absolute),
    ).to.deep.equal([pathy(path.join(stable, 'GameMaker.exe')).absolute]);
    expect(
      (await listInstalledIdes(staging)).map((file) => file.absolute),
    ).to.deep.equal([pathy(path.join(staging, 'GameMaker.exe')).absolute]);
  });

  it('extracts archives while excluding NSIS installer-only payloads', async function () {
    if (process.platform !== 'win32') {
      this.skip();
    }
    const source = path.join(testDirectory, 'source');
    const output = pathy(path.join(testDirectory, 'output'));
    const archive = pathy(path.join(testDirectory, 'installer.zip'));
    await mkdir(path.join(source, '$PLUGINSDIR'), { recursive: true });
    await mkdir(path.join(source, '$TEMP'), { recursive: true });
    await writeFile(path.join(source, 'GameMaker.exe'), 'portable IDE');
    await writeFile(path.join(source, '$PLUGINSDIR', 'plugin.dll'), 'plugin');
    await writeFile(path.join(source, '$TEMP', 'redist.exe'), 'redist');
    await run(
      path7z,
      ['a', archive.absolute, 'GameMaker.exe', '$PLUGINSDIR', '$TEMP', '-bb0'],
      { cwd: source },
    );

    await extractIdeInstaller(archive, output);

    expect(await output.join('GameMaker.exe').read<string>()).to.equal(
      'portable IDE',
    );
    expect(await output.join('$PLUGINSDIR').exists()).to.equal(false);
    expect(await output.join('$TEMP').exists()).to.equal(false);
  });
});
