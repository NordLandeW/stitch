import type { Pathy } from '@bscotch/pathy';
import { GmlLexer } from './lexer.js';
import type {
  YyExtension,
  YyRoom,
  YyRoomInstance,
  YyRoomInstanceLayer,
} from '@bscotch/yy';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { Asset } from './project.asset.js';
import { Diagnostic } from './project.diagnostics.js';
import { pathExists } from './project.edits.js';

export interface ExtensionBinding {
  readonly sourceName: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly signatureKey: string;
}
export function extensionDefinitionNames(text: string): ReadonlySet<string> {
  const tokens = GmlLexer.tokenize(text).tokens;
  return new Set(
    tokens.flatMap((token, index) =>
      token.tokenType.name === 'Define' &&
      tokens[index + 1]?.tokenType.name === 'Identifier'
        ? [tokens[index + 1].image]
        : [],
    ),
  );
}
export function extensionBindings(
  asset: Asset,
  filename: string,
): readonly ExtensionBinding[] {
  if (asset.assetKind !== 'extensions') return [];
  const file = (asset.yy as YyExtension).files.find(
    (file) => file.filename === filename,
  );
  return (file?.functions || []).map((func) => ({
    sourceName: func.externalName || func.name,
    name: func.name,
    hidden: func.hidden,
    signatureKey: `resource:extensions:${asset.name}:extension:Function.${func.name}`,
  }));
}

export interface GmlSourceContext {
  readonly kind:
    | 'script'
    | 'object-event'
    | 'room-creation'
    | 'instance-creation'
    | 'timeline'
    | 'extension'
    | 'other';
  readonly selfOwner?: string;
  readonly objectName?: string;
  readonly instanceName?: string;
  readonly moment?: number;
  readonly extensionFunctions?: readonly ExtensionBinding[];
}
export interface ResourceSource {
  readonly path: Pathy<string>;
  readonly context: GmlSourceContext;
}

/** Room layer groups can recursively contain instance layers. */
export function roomInstanceLayers(
  layers: readonly unknown[],
): YyRoomInstanceLayer[] {
  const found: YyRoomInstanceLayer[] = [];
  const pending = [...layers];
  for (let index = 0; index < pending.length; index++) {
    const layer = pending[index];
    if (!layer || typeof layer !== 'object') continue;
    const entry = layer as { layers?: unknown; instances?: unknown };
    if (Array.isArray(entry.layers)) pending.push(...entry.layers);
    if (Array.isArray(entry.instances))
      found.push(layer as YyRoomInstanceLayer);
  }
  return found;
}
export function roomInstances(layers: readonly unknown[]): YyRoomInstance[] {
  return roomInstanceLayers(layers).flatMap((layer) => layer.instances);
}

/** Select current YY-owned code. Unlisted files are not implicitly resurrected. */
export async function resourceSources(asset: Asset): Promise<{
  sources: ResourceSource[];
  diagnostics: Diagnostic[];
  paths: Pathy[];
}> {
  const sources: ResourceSource[] = [];
  const paths: Pathy[] = [];
  const diagnostics: Diagnostic[] = [];
  const location = {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
  const report = (message: string, optional = false) =>
    diagnostics.push(
      new Diagnostic(message, location, optional ? 'warning' : 'error'),
    );
  const selected = new Map<string, ResourceSource>();
  const conflicting = new Set<string>();
  const directories = new Map<string, Promise<Dirent[]>>();
  function children(directory: string): Promise<Dirent[]> {
    let pending = directories.get(directory);
    if (!pending) {
      pending = readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (['ENOENT', 'ENOTDIR'].includes(error.code || '')) return [];
          throw error;
        },
      );
      directories.set(directory, pending);
    }
    return pending;
  }
  async function select(
    path: Pathy,
    context: GmlSourceContext,
    optional = false,
  ): Promise<boolean> {
    const inside = relative(asset.project.dir.absolute, path.absolute);
    if (
      isAbsolute(inside) ||
      inside === '..' ||
      inside.startsWith('../') ||
      inside.startsWith('..\\')
    ) {
      report(`GML source is outside the project: ${path.absolute}`);
      return false;
    }
    paths.push(path);
    const matches = (await children(path.up().absolute)).filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.toLocaleLowerCase() === path.basename.toLocaleLowerCase(),
    );
    if (matches.length !== 1) {
      report(
        optional
          ? `Optional creation code is unavailable or ambiguous; the metadata may describe an empty or removed body: ${path.relativeFrom(asset.project.dir)}`
          : `Listed GML file is ${matches.length ? 'ambiguous' : 'missing'}: ${path.relativeFrom(asset.project.dir)}`,
        optional,
      );
      return false;
    }
    const actual = path.up().join(matches[0].name);
    const key = actual.absolute.toLocaleLowerCase();
    if (conflicting.has(key)) return false;
    const prior = selected.get(key);
    if (prior && JSON.stringify(prior.context) !== JSON.stringify(context)) {
      selected.delete(key);
      sources.splice(sources.indexOf(prior), 1);
      conflicting.add(key);
      report(
        `One GML file has multiple execution contexts; analysis requires an unambiguous context: ${actual.relativeFrom(asset.project.dir)}`,
        true,
      );
      return false;
    }
    if (!prior) {
      const source = { path: actual as Pathy<string>, context };
      selected.set(key, source);
      sources.push(source);
    }
    return true;
  }
  if (asset.isScript) {
    await select(asset.dir.join(`${asset.name}.gml`), { kind: 'script' });
  } else if (asset.isObject) {
    const prefixes = [
      'Create',
      'Destroy',
      'Alarm',
      'Step',
      'Collision',
      'Keyboard',
      'Mouse',
      'Other',
      'Draw',
      'KeyPress',
      'KeyRelease',
      'Trigger',
      'CleanUp',
      'Gesture',
      'PreCreate',
    ];
    for (const event of (
      asset.yy as {
        eventList: {
          eventType: number;
          eventNum: number;
          collisionObjectId?: { name: string } | null;
        }[];
      }
    ).eventList) {
      const suffix =
        event.eventType === 4 ? event.collisionObjectId?.name : event.eventNum;
      if (suffix !== undefined && prefixes[event.eventType])
        await select(
          asset.dir.join(`${prefixes[event.eventType]}_${suffix}.gml`),
          { kind: 'object-event', selfOwner: `object:${asset.name}:self` },
        );
    }
  } else if (asset.isRoom) {
    const room = asset.yy as YyRoom;
    if (room.creationCodeFile && !room.isDnd && !room.inheritCode) {
      const reference = room.creationCodeFile.replace(
        /^\$\{project_dir\}[/\\]?/,
        '',
      );
      const declared = asset.project.dir.join(reference);
      paths.push(declared);
      const local = asset.dir.join('RoomCreationCode.gml');
      const context: GmlSourceContext = {
        kind: 'room-creation',
        selfOwner: `room:${asset.name}:creation`,
      };
      if (
        !(await pathExists(declared.absolute)) &&
        (await pathExists(local.absolute))
      ) {
        report(
          'The declared room creation path is unavailable; analyzing the resource-local RoomCreationCode.gml. The target compiler path has not been verified.',
          true,
        );
        await select(local, context, true);
      } else await select(declared, context, true);
    }
    for (const instance of roomInstances(room.layers)) {
      if (
        !instance.hasCreationCode ||
        instance.ignore ||
        instance.isDnd ||
        instance.inheritCode
      )
        continue;
      await select(
        asset.dir.join(`InstanceCreationCode_${instance.name}.gml`),
        {
          kind: 'instance-creation',
          selfOwner: `room:${asset.name}:instance:${instance.name}`,
          instanceName: instance.name,
          objectName: instance.objectId?.name,
        },
        true,
      );
    }
  } else if (asset.assetKind === 'timelines') {
    const moments =
      (
        asset.yy as {
          momentList?: { moment: number; evnt?: { isDnD?: boolean } }[];
        }
      ).momentList || [];
    for (const entry of moments) {
      if (entry.evnt?.isDnD) continue;
      await select(asset.dir.join(`moment_${entry.moment}.gml`), {
        kind: 'timeline',
        selfOwner: `timeline:${asset.name}:caller-self`,
        moment: entry.moment,
      });
    }
  } else if (asset.assetKind === 'extensions') {
    for (const file of (asset.yy as YyExtension).files) {
      if (
        file.kind !== 2 ||
        typeof file.filename !== 'string' ||
        !file.filename.toLowerCase().endsWith('.gml')
      )
        continue;
      await select(asset.dir.join(file.filename), {
        kind: 'extension',
        extensionFunctions: extensionBindings(asset, file.filename),
      });
    }
  }
  return { sources, diagnostics, paths };
}
