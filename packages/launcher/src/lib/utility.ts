import { Pathy } from '@bscotch/pathy';
import { ok } from 'assert';
import { default as axios } from 'axios';
import { path7z } from '7z-bin';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { rename } from 'fs/promises';
import os from 'os';
import { pipeline } from 'stream/promises';
import {
  GameMakerDefaultMacros,
  GameMakerInstalledVersion,
  GameMakerLogOptions,
} from './GameMakerLauncher.types.js';
import { StitchSupportedBuilder } from './GameMakerRuntime.types.js';

import { assert, Debugger, Trace, useTracer } from '@bscotch/utility/browser';
import { z } from 'zod';

const libName = '@bscotch/stitch-launcher';

export const debug: Debugger = useTracer(libName);

export const trace = Trace(libName);

export type RuntimeFeedsFile = z.infer<typeof runtimeFeedsFileSchema>;
export const runtimeFeedsFileSchema = z.array(
  z.object({
    Key: z.string().describe('The name of the feed'),
    Value: z.string().describe('The URL of the feed'),
  }),
);

export function createStaticTracer(className: string, methodName: string) {
  return useTracer(`${libName}:${className}:${methodName}`);
}

export const bootstrapRuntimeVersion = '2022.300.0.476';

export const stitchConfigDir = new Pathy(`${os.homedir()}/.stitch`);

export const currentOs =
  os.platform() === 'win32'
    ? 'windows'
    : os.platform() === 'darwin'
      ? 'osx'
      : os.platform() === 'linux'
        ? 'linux'
        : undefined;

export const currentArchitecture = os.arch();

export function artifactExtensionForPlatform(platform: StitchSupportedBuilder) {
  const extensions: {
    [P in StitchSupportedBuilder]: string;
  } = {
    android: 'aab',
    ios: 'iap',
    linux: 'zip',
    mac: 'zip',
    switch: 'nsp',
    windows: 'zip',
    winuwp: 'appxbundle',
    xboxone: 'xboxone-pkg',
    xboxseriesxs: 'xboxseriesxs-pkg',
  };
  const extension = extensions[platform];
  ok(extension, `Unsupported platform, no extension defined: ${platform}`);
  return extension;
}

/**
 * Given a .yyp filepath, or a directory that should
 * contain one, return the containing directory only.
 */
export function projectFolder(projectPath: string | Pathy): Pathy {
  const path = Pathy.asInstance(projectPath);
  if (path.basename.endsWith('.yyp')) {
    return path.up();
  }
  return path;
}

export async function projectLogDirectory(
  project?: string | Pathy,
  options?: GameMakerLogOptions,
) {
  const logDir = new Pathy(
    options?.logDir ||
      (project && projectFolder(project).join('logs')) ||
      stitchConfigDir.join('logs'),
  );
  await logDir.ensureDirectory();
  return logDir;
}

/**
 * Sorts *in place*, descending (most recent date first).
 */
export function sortByDateField<
  F extends string,
  T extends Record<F, Date | undefined>,
>(entries: T[], dateField: F): T[] {
  // Sort the combined feed by date, ascending
  entries.sort((a, b) => {
    if (a[dateField] === undefined && b[dateField] === undefined) {
      return 0;
    }
    if (a[dateField] === undefined) {
      return 1;
    }
    if (b[dateField] === undefined) {
      return -1;
    }
    return b[dateField]!.getTime() - a[dateField]!.getTime();
  });
  return entries;
}

export async function downloadIfCacheExpired<T>(
  url: string,
  filePath: Pathy<T>,
  maxAgeInSeconds: number,
  logger?: Logger,
) {
  if (await cachedFileIsExpired(filePath, maxAgeInSeconds)) {
    logger?.log('Cache expired. Refreshing...');
    let data!: T;
    try {
      data = (await axios(url)).data as T;
      await filePath.write(data);
    } catch (err) {
      const fileExists = filePath.existsSync();
      if (fileExists) {
        (logger?.warn || console.warn)('Download error for', url);
        // Fail gracefully, since the caller can fall back on the cached file.
        return;
      }
      throw err;
    }
  }
}

export async function cachedFileIsExpired(
  filePath: Pathy,
  maxAgeInSeconds: number,
): Promise<boolean> {
  const isOutdated =
    !(await filePath.exists()) ||
    (await filePath.stat()).mtimeMs < Date.now() - 1000 * maxAgeInSeconds;
  return !!isOutdated;
}

/**
 * Given a version string, ensure it has the correct
 * format for use by this package (4 dot-separated
 * numbers, without a leading 'v').
 */
export function cleanVersionString(version: string): string {
  version = version.replace(/^v/, '');
  ok(
    version.match(/^\d+\.\d+\.\d+\.\d+$/),
    `Invalid version string: ${version}`,
  );
  return version;
}

export async function download(
  url: string,
  to: Pathy,
  options?: { force: boolean },
) {
  if ((await to.exists()) && !options?.force) {
    console.log(
      `Download target path already exists, skipping download: "${to}"`,
    );
    return false;
  }
  await to.up().ensureDirectory();
  console.log(`Downloading ${url} to ${to.absolute}`);
  const partialPath = new Pathy(`${to.absolute}.${randomUUID()}.partial`);
  const backupPath = new Pathy(`${to.absolute}.${randomUUID()}.replaced`);
  try {
    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      // Request the artifact itself so byte counts match Content-Length.
      headers: { 'Accept-Encoding': 'identity' },
      decompress: false,
    });
    const encoding = response.headers['content-encoding'];
    if (encoding && String(encoding).toLowerCase() !== 'identity') {
      response.data.destroy();
      throw new Error(
        `Unexpected Content-Encoding ${encoding} downloading ${url}`,
      );
    }
    await pipeline(
      response.data,
      createWriteStream(partialPath.absolute, { flags: 'wx' }),
    );

    const downloadedSize = (await partialPath.stat()).size;
    const expectedSize = Number(response.headers['content-length']);
    ok(downloadedSize > 0, `Downloaded an empty file from ${url}`);
    ok(
      !Number.isFinite(expectedSize) || downloadedSize === expectedSize,
      `Incomplete download from ${url}: expected ${expectedSize} bytes, received ${downloadedSize}`,
    );

    const hadExistingTarget = await to.exists();
    if (hadExistingTarget) {
      await rename(to.absolute, backupPath.absolute);
    }
    try {
      await rename(partialPath.absolute, to.absolute);
    } catch (error) {
      if (hadExistingTarget && (await backupPath.exists())) {
        await rename(backupPath.absolute, to.absolute);
      }
      throw error;
    }
    if (hadExistingTarget) {
      try {
        await backupPath.delete();
      } catch (error) {
        console.warn(
          `Downloaded ${to.absolute}, but could not remove the replaced file ${backupPath.absolute}: ${String(error)}`,
        );
      }
    }
    return true;
  } catch (error) {
    if (await partialPath.exists()) {
      await partialPath.delete();
    }
    throw error;
  }
}

/**
 * Extract a GameMaker NSIS installer without executing it. Installer-only
 * payloads are excluded so the resulting directory contains only the
 * portable IDE files Stitch needs.
 */
export async function extractIdeInstaller(idePath: Pathy, target: Pathy) {
  ok(process.platform === 'win32', 'Only Windows is supported');
  console.log('Extracting installer', idePath.basename, '...');
  await target.ensureDirectory();
  const args = [
    'x',
    idePath.absolute,
    `-o${target.absolute}`,
    '-y',
    '-bb0',
    '-bso0',
    '-bsp0',
    '-xr!$PLUGINSDIR',
    '-xr!$TEMP',
  ];
  debug(`Running command: ${path7z} ${args.join(' ')}`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      path7z,
      args,
      { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          error.message = `${error.message}${stderr ? `\n${stderr.trim()}` : ''}`;
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Find the paths to all installed runtime versions.
 * Uses discovery plus some basic heuristics and smoke
 * tests to return paths that are likely to correspond
 * with valid runtime installations.
 *
 * These are stored in `$PROGRAMDATA/GameMakerStudio2(-(Beta|LTS))?/Cache/runtimes/*`
 */
export async function listInstalledRuntimes(options?: {
  logger?: Logger;
}): Promise<
  Omit<GameMakerInstalledVersion, 'channel' | 'publishedAt' | 'feedUrl'>[]
> {
  const runtimeDirs = await listGameMakerRuntimeDirs(options);
  const runtimes: Omit<
    GameMakerInstalledVersion,
    'channel' | 'publishedAt' | 'feedUrl'
  >[] = [];
  for (const runtimeDir of runtimeDirs) {
    const version = runtimeDir.basename.replace(/^runtime-/, '');
    if (!version.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      console.warn(
        `Skipping invalid runtime version string ${version} parsed from ${runtimeDir.absolute}`,
      );
      continue;
    }
    // Empty runtime folders can be left behind when
    // GameMaker cleans up, so check for that and purge those
    if (await runtimeDir.isEmptyDirectory()) {
      await runtimeDir.delete({ recursive: true });
      continue;
    }

    const executablePaths = [
      runtimeDir.join('bin/Igor.exe'),
      runtimeDir.join('bin/igor/windows/x64/Igor.exe'),
    ];
    let executablePath: Pathy | undefined;
    for (const path of executablePaths) {
      if (await path.exists()) {
        executablePath = path;
        break;
      }
    }
    if (!executablePath) {
      continue;
    }
    const dataDirectory = runtimeDir.up().up().up();
    runtimes.push({
      version,
      directory: runtimeDir,
      executablePath,
      usersDirectory: new Pathy(process.env.APPDATA).join(
        dataDirectory.basename,
      ),
    });
  }
  options?.logger?.log('Found', runtimes.length, 'runtimes');
  return runtimes;
}

async function listGameMakerRuntimeDirs(options?: {
  logger?: Logger;
}): Promise<Pathy[]> {
  options?.logger?.log('Finding local GameMaker data directories...');
  const channelFolders = await listGameMakerDataDirs();
  options?.logger?.log('Found', channelFolders.length, 'data directories');
  const runtimesDirs: Pathy[] = [];
  for (const channelFolder of channelFolders) {
    const cacheDir = channelFolder.join('Cache/runtimes');
    if (!(await cacheDir.exists())) {
      continue;
    }
    runtimesDirs.push(
      ...(await cacheDir.listChildren()).filter((p) =>
        p.basename.match(/^runtime-/),
      ),
    );
  }
  options?.logger?.log('Found', runtimesDirs.length, 'runtime directories');
  return runtimesDirs;
}

/**
 * Set the active runtime by updating GameMaker's
 * program data files. This sets the active runtime
 * for *all* installed IDEs!
 */
export async function setActiveRuntime(runtime: {
  version: string;
  directory: Pathy;
}) {
  for (const dataDir of await listGameMakerDataDirs()) {
    const runtimeConfigFile = dataDir.join('runtime.json');
    const currentConfig: Record<string, string> =
      (await runtimeConfigFile.exists()) ? await runtimeConfigFile.read() : {};
    currentConfig.active = runtime.version;
    currentConfig[runtime.version] = runtime.directory.toString({
      format: 'win32',
    });
    await runtimeConfigFile.write(JSON.stringify(currentConfig));
  }
}

/**
 * Note that these paths are not populated by
 * default, so they may point to non-existent files.
 */
export async function listDefaultMacrosPaths(): Promise<
  Pathy<GameMakerDefaultMacros>[]
> {
  const paths = await listGameMakerDataDirs();
  return paths.map((p) => p.join('default_macros.json'));
}

export async function listRuntimeFeedsConfigPaths(): Promise<
  Pathy<RuntimeFeedsFile>[]
> {
  const paths = await listGameMakerDataDirs();
  return paths.map((p) =>
    p.join('runtime_feeds.json').withValidator(runtimeFeedsFileSchema),
  );
}

/**
 * Find GameMaker's program data caches. These store
 * installed Runtimes, current IDE configuration info,
 * and other data.
 *
 * These currently correspond with
 * `$PROGRAMDATA/GameMakerStudio2(-(Beta|LTS))?/`
 */
export async function listGameMakerDataDirs(): Promise<Pathy[]> {
  // Currently the caches are stored in
  // $PROGRAMDATA/GameMakerStudio2(-(Beta|LTS))?/Cache
  // With the rename, this could change to just GameMaker,
  // so we'll use some simple discovery heuristics.
  const potentialDataDirs = (
    await new Pathy(process.env.PROGRAMDATA).listChildren()
  ).filter((p) => p.basename.match(/^GameMaker/));
  const dataDirs: Pathy[] = [];
  for (const potentialDataDir of potentialDataDirs) {
    const cacheDir = potentialDataDir.join('Cache/runtimes');
    if (await cacheDir.exists()) {
      dataDirs.push(potentialDataDir);
    }
  }
  return dataDirs;
}

export async function listInstalledIdes(
  parentDir: string | Pathy = process.env.PROGRAMFILES!,
) {
  assert(parentDir, 'No program files directory provided');

  const root = new Pathy(parentDir);
  const ideExecutables = await root.listChildrenRecursively({
    maxDepth: 1,
    includePatterns: [/^GameMaker(Studio2?)?(-(Beta|LTS))?\.exe$/],
  });

  // Staging and rollback directories are not published installations. Still
  // allow an explicit staging root so installation can validate it before
  // publishing it into the cache.
  return ideExecutables.filter((executable) => {
    const directory = executable.up();
    return (
      directory.absolute === root.absolute ||
      !/^gamemaker-\d+\.\d+\.\d+\.\d+\.(extracting|replaced)-[0-9a-f-]+$/i.test(
        directory.basename,
      )
    );
  });
}

export type Logger = {
  warn: (...args: any[]) => void;
  log: (...args: any[]) => void;
};
