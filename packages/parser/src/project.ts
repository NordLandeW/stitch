import { pathy, Pathy } from '@bscotch/pathy';
import { readFile, readdir } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import {
  applyDiskEdits,
  editedText,
  pathExists,
  renamedPath,
  validateRenames,
  ProjectEditError,
  type ProjectDocumentEdit,
  type ProjectEditBatch,
} from './project.edits.js';
import { planReferenceRename } from './project.location.js';
export {
  ProjectEditError,
  type ProjectDocumentEdit,
  type ProjectEditBatch,
  type ProjectTextEdit,
} from './project.edits.js';
import {
  getDefaultsForNewSound,
  isValidSoundName,
  isValidSpriteName,
  stitchConfigFilename,
  stitchConfigSchema,
  type StitchConfig,
} from '@bscotch/stitch-config';
import { sequential } from '@bscotch/utility';
import {
  SoundChannel,
  SpriteType,
  Yy,
  yyParentSchema,
  yypFolderSchema,
  yyRoomSchema,
  yySpriteSchema,
  YyObjectPropertyVarType,
  type YyObject,
  type YyObjectEvent,
  type Yyp,
  type YypConfig,
  type YypFolder,
  type YypResource,
  type YySchema,
  type YySound,
  type YySprite,
} from '@bscotch/yy';
import { EventEmitter } from 'events';
import { getProjectAnalysis } from './language/service.js';
import { LanguageProfile } from './language/version.js';
import { logger } from './logger.js';
import { importAssets } from './modules.js';
import { ImportModuleOptions } from './modules.types.js';
import { Asset, isAssetOfKind } from './project.asset.js';
import { Code } from './project.code.js';
import { Diagnostic } from './project.diagnostics.js';
import { Native } from './project.native.js';
import { fshDefault, vshDefault } from './shaderDefaults.js';
import { Signifier } from './signifiers.js';
import { StructType, Type } from './types.js';
import {
  assert,
  assertIsValidIdentifier,
  getPngSize,
  groupPathToPosix,
  ok,
  throwError,
} from './util.js';
export { setLogger, type Logger } from './logger.js';

type AssetName = string;

export interface SymbolInfo {
  native: boolean;
  symbol: Signifier | Type;
}

export interface DiagnosticsEventPayload {
  filePath: string;
  code?: Code;
  diagnostics: Diagnostic[];
}

export type OnDiagnostics = (diagnostics: DiagnosticsEventPayload) => void;

export interface ProjectOptions {
  /**
   * Register a callback to run when diagnostics are emitted.
   * If not provided, a callback can be registered after
   * initialization, but will not receive any diagnostics
   * from the initial parse.
   */
  onDiagnostics?: OnDiagnostics;
  /**
   * If registered, this callback will be used to report
   * when progress has been made towards loading the project.
   */
  onLoadProgress?: (increment: number, message?: string) => void;
  /** Current unsaved editor text, if a host owns this physical document. */
  documentText?: (absolutePath: string) => string | undefined;
  /**
   * Apply a fully preflighted host text/resource batch. False is allowed only
   * before application begins. Partial/application failures must throw with
   * affected paths; a host must not blindly roll back newer user edits.
   */
  applyEdits?: (batch: ProjectEditBatch) => Promise<boolean>;
  settings?: {
    /**
     * Symbols starting with these prefixes that are not declared
     * in the coded will be treated as global symbols. This is
     * useful for ensuring globals created by extensions will not
     * show up as being undeclared.
     */
    autoDeclareGlobalsPrefixes?: string[];
    /** Existing GameMaker build configuration used for macro selection. */
    analysisConfiguration?: string;
  };
  logger?: {
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}

export class Project {
  yyp!: Yyp;
  /** Until this resolves, assume that this.yyp is not yet read */
  yypWaiter?: Promise<any>;

  config!: StitchConfig;

  readonly assets = new Map<AssetName, Asset>();
  /**
   * Store the "native" functions, constants, and enums on
   * a per-project basis, but separately from the project-specific
   * symbols. The native symbols and types are loaded from the spec,
   * so they can vary between projects. */
  native!: Native;
  helpLinks!: { [method: string]: string };
  /**
   * When resolved, the GML spec has been loaded and the
   * `native` property has been populated.
   */
  nativeWaiter?: Promise<void>;
  /**
   * Bare-name presentation of native symbols and project globals.
   * `analysis.globalStorage` exposes the independent user global storage. */
  self!: StructType;
  /**
   * The `global` symbol, whose committed type is `analysis.globalStorage`. */
  symbol!: Signifier;
  /**
   * Non-native global types, which can be referenced in JSDocs
   * and in a symbol's types. */
  readonly types = new Map<string, Type>();

  languageProfile?: LanguageProfile;
  get analysis() {
    return getProjectAnalysis(this);
  }
  private disposed = false;
  get isDisposed(): boolean {
    return this.disposed;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.analysis.dispose();
    this.resourceDiagnostics.clear();
    this.resourceDiagnosticGroups.clear();
    this.dirtyFiles.clear();
    this.emitter.removeAllListeners();
  }

  private resourceBarrier: Promise<void> = Promise.resolve();
  private resourceUpdates = 0;
  private readonly resourceDiagnostics = new Map<
    string,
    DiagnosticsEventPayload
  >();
  private readonly resourceDiagnosticGroups = new Map<
    string,
    Map<string, readonly Diagnostic[]>
  >();
  get resourcesReady(): Promise<void> {
    return this.resourceBarrier;
  }
  get resourcesPending(): boolean {
    return this.resourceUpdates > 0;
  }

  withResourceUpdate<T>(action: () => Promise<T>): Promise<T> {
    if (this.disposed)
      return Promise.reject(new Error('Project has been disposed'));
    this.analysis.invalidate();
    this.resourceUpdates++;
    const operation = this.resourceBarrier
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error('Project has been disposed');
        const result = await action();
        await this.reconcileSourceOwnership();
        return result;
      });
    this.resourceBarrier = operation.then(
      () => {
        this.resourceUpdates--;
      },
      (error) => {
        this.resourceUpdates--;
        throw error;
      },
    );
    // The operation and readiness barrier share one failure; both are owned.
    void this.resourceBarrier.catch(() => {});
    return operation.then(
      async (result) => {
        if (this.disposed) return result;
        await this.analysis.analyze();
        const pending = [...this.resourceDiagnostics.values()];
        this.resourceDiagnostics.clear();
        for (const payload of pending)
          this.emitDiagnostics(
            payload.code || payload.filePath,
            payload.diagnostics,
          );
        return result;
      },
      async (error) => {
        // The service owns visible failure state even when no query follows the
        // failed watcher action. A newer queued barrier may supersede this one.
        if (!this.disposed) {
          try {
            await this.analysis.analyze();
          } catch {
            /* failure is published by analysis */
          }
          const pending = [...this.resourceDiagnostics.values()];
          this.resourceDiagnostics.clear();
          for (const payload of pending)
            this.emitDiagnostics(
              payload.code || payload.filePath,
              payload.diagnostics,
            );
        }
        throw error;
      },
    );
  }

  /** The configured build target, retaining Stitch's first-child fallback. */
  get defaultAnalysisConfiguration(): string {
    return (
      this.options?.settings?.analysisConfiguration ||
      this.yyp?.configs?.children?.[0]?.name ||
      this.yyp?.configs?.name ||
      'Default'
    );
  }

  private selectedAnalysisConfiguration?: string;
  async setAnalysisConfiguration(name: string): Promise<void> {
    if (!this.configs.includes(name))
      throw new Error(`Unknown analysis configuration: ${name}`);
    if (name !== this.selectedAnalysisConfiguration) {
      this.selectedAnalysisConfiguration = name;
      this.analysis.invalidate();
    }
    await this.analysis.analyze();
  }

  get analysisConfigurationLineage(): string[] {
    const selected =
      this.selectedAnalysisConfiguration || this.defaultAnalysisConfiguration;
    const root = this.yyp?.configs;
    if (!root) return ['Default'];
    const pending: { config: YypConfig; lineage: string[] }[] = [
      { config: root, lineage: [] },
    ];
    while (pending.length) {
      const { config, lineage } = pending.shift()!;
      const current = [...lineage, config.name];
      if (config.name === selected) return current;
      for (const child of config.children || [])
        pending.push({ config: child, lineage: current });
    }
    throw new Error(`Unknown analysis configuration: ${selected}`);
  }

  protected emitter = new EventEmitter();
  /** Code that needs to be reprocessed, for one reason or another. */
  protected dirtyFiles = new Set<Code>();

  protected constructor(
    readonly yypPath: Pathy<any>,
    readonly options?: ProjectOptions,
  ) {}

  /**
   * @internal For tracking changed code files that will need to be re-parsed.
   */
  queueDirtyFileUpdate(code: Code): void {
    this.dirtyFiles.add(code);
    this.analysis.invalidate(code);
  }

  /**
   * @internal Drain the queue of dirty files, updating their diagnostics
   */
  drainDirtyFileUpdateQueue() {
    this.dirtyFiles.clear();
    this.analysis.analyzeSync();
  }

  /**
   * Update the YYP file to list a specific GameMaker IDE version.
   * Note that the GameMaker IDE will overwrite this with whatever
   * its own version is -- this feature is useful for external tools
   * like Stitch that can manage multiple GameMaker IDE versions.
   */
  async setIdeVersion(version: string) {
    assert(version.match(/^\d+\.\d+\.\d+\.\d+$/), 'Invalid version string');
    this.yyp.MetaData.IDEVersion = version;
    await this.saveYyp();
  }

  /**
   * The current version of the GameMaker IDE listed in
   * this project's YYP file. This is the GameMaker version that
   * the project was last opened with.
   */
  get ideVersion(): string {
    return this.yyp.MetaData.IDEVersion;
  }

  /**
   * The directory in which the project lives.
   */
  get dir(): Pathy {
    return pathy(this.yypPath).up();
  }

  /**
   * Get the Stitch config for this project, which defines
   * various settings that may impact rule around adding
   * assets, parsing logs, etc.
   */
  get stitchConfig() {
    return this.dir
      .join(stitchConfigFilename)
      .withValidator(stitchConfigSchema);
  }

  /** List the names of the GameMaker configs defined by this project. */
  get configs(): string[] {
    const configs: string[] = [];
    let configTree: YypConfig[] = [this.yyp.configs];
    while (configTree.length) {
      const nextTree: YypConfig[] = [];
      for (const config of configTree) {
        configs.push(config.name);
        nextTree.push(...(config.children || []));
      }
      configTree = nextTree;
    }
    return configs;
  }

  /** List the project's "datafiles" (a.k.a. "Included Files"), in the same format as they appear in the YYP file. */
  get datafiles() {
    return this.yyp.IncludedFiles;
  }

  /** List the Folders in this project, normalized to regular POSIX paths
   * @example ['my/folder', 'my/other/folder']
   */
  get folders() {
    return this.yyp.Folders.map((f) => groupPathToPosix(f.folderPath));
  }

  /**
   * Run a callback when diagnostics are emitted. Returns an unsubscribe function. */
  onDiagnostics(callback: OnDiagnostics): () => void {
    this.emitter.on('diagnostics', callback);
    return () => this.emitter.off('diagnostics', callback);
  }

  /** @internal Method that can be called after some code has been parsed to report diagnostics to listeners. */
  emitDiagnostics(code: Code | string, diagnostics: Diagnostic[]): void {
    if (this.disposed) return;
    // Ensure they are valid diagnostics
    for (const diagnostic of diagnostics) {
      ok(diagnostic.$tag === 'diagnostic');
      ok(diagnostic.location);
    }
    const payload: DiagnosticsEventPayload = {
      code: code instanceof Code ? code : undefined,
      filePath: code instanceof Code ? code.path.absolute : code,
      diagnostics,
    };
    if (this.resourcesPending) {
      this.resourceDiagnostics.set(payload.filePath, payload);
      return;
    }
    for (const listener of this.emitter.rawListeners('diagnostics')) {
      try {
        const result: unknown = Reflect.apply(listener, this.emitter, [
          payload,
        ]);
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        )
          void Promise.resolve(result).catch((error) =>
            logger.error('Diagnostics subscriber failed', error),
          );
      } catch (error) {
        logger.error('Diagnostics subscriber failed', error);
      }
    }
  }

  /** Resource producers replace only their own diagnostics, including recovery. */
  setResourceDiagnostics(
    filePath: string,
    owner: string,
    diagnostics: readonly Diagnostic[],
  ): void {
    let groups = this.resourceDiagnosticGroups.get(filePath);
    if (!groups)
      this.resourceDiagnosticGroups.set(filePath, (groups = new Map()));
    if (diagnostics.length) groups.set(owner, diagnostics);
    else groups.delete(owner);
    if (!groups.size) this.resourceDiagnosticGroups.delete(filePath);
    this.emitDiagnostics(filePath, [...groups.values()].flat());
  }

  clearResourceDiagnostics(filePath: string): void {
    this.resourceDiagnosticGroups.delete(filePath);
    this.emitDiagnostics(filePath, []);
  }

  /** Metadata follows the same host-buffer ownership as GML. */
  async readDocumentText(path: Pathy): Promise<string> {
    const buffer = this.options?.documentText?.(path.absolute);
    if (typeof buffer === 'string') return buffer;
    const disk = await readFile(path.absolute, 'utf8');
    return this.options?.documentText?.(path.absolute) ?? disk;
  }

  sourceOwners(path: Pathy): Asset[] {
    const key = path.absolute.toLocaleLowerCase();
    return [...this.assets.values()].filter(
      (asset) =>
        asset.sourcePaths?.some(
          (source) => source.absolute.toLocaleLowerCase() === key,
        ) ||
        asset.sourceCandidates?.some(
          (source) => source.path.absolute.toLocaleLowerCase() === key,
        ),
    );
  }

  /** A physical query/edit document has one execution context. Conflicts remain explicit metadata diagnostics. */
  private async reconcileSourceOwnership(): Promise<void> {
    const claims = new Map<string, Set<Asset>>();
    for (const asset of this.assets.values())
      for (const source of asset.sourceCandidates || []) {
        const key = source.path.absolute.toLocaleLowerCase();
        let owners = claims.get(key);
        if (!owners) claims.set(key, (owners = new Set()));
        owners.add(asset);
      }
    for (const asset of this.assets.values()) {
      if (!asset.sourceCandidates) continue;
      const conflicts = asset.sourceCandidates.filter(
        (source) =>
          claims.get(source.path.absolute.toLocaleLowerCase())!.size > 1,
      );
      this.setResourceDiagnostics(
        asset.yyPath.absolute,
        'source-ownership',
        conflicts.map(
          (source) =>
            new Diagnostic(
              `The GML source ${source.path.relativeFrom(this.dir)} is shared by multiple resources. Analysis and source deletion require an unambiguous execution context.`,
              {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
              },
              'warning',
            ),
        ),
      );
      await asset.reconcileGmlSources(
        asset.sourceCandidates.filter(
          (source) =>
            claims.get(source.path.absolute.toLocaleLowerCase())!.size === 1,
        ),
      );
    }
  }

  /** Reconcile listed metadata or a source URI, including paths outside its resource directory. */
  async reloadResource(path: Pathy): Promise<void> {
    const names = new Set(
      this.sourceOwners(path).map((asset) => asset.name.toLocaleLowerCase()),
    );
    names.add(this.assetNameFromPath(path));
    await this.withResourceUpdate(async () => {
      for (const name of names) {
        const resource = this.yyp.resources.find(
          (entry) => entry.id.name.toLocaleLowerCase() === name,
        );
        if (!resource) continue;
        const existing = this.assets.get(name);
        if (existing) await existing.reload(false);
        else {
          const restored = await Asset.from(this, resource);
          if (restored) this.registerAsset(restored);
        }
      }
      for (const asset of this.assets.values()) asset.refreshParent();
    });
  }

  /**
   * Since GameMaker assets are global they must have unique names independent of their type. Find an asset give it's name. Note that this is case-insensitive!
   * @param name The name of the asset to find, case-insensitive.
   */
  getAssetByName<Assert extends boolean>(
    name: string | undefined,
    options?: { assertExists: Assert },
  ): Assert extends true ? Asset : Asset | undefined {
    assert(name || !options?.assertExists, 'No asset name provided');
    if (!name) {
      return undefined as Assert extends true ? Asset : Asset | undefined;
    }
    const asset = this.assets.get(name.toLocaleLowerCase());
    assert(asset || !options?.assertExists, `Asset "${name}" does not exist.`);
    return asset as Assert extends true ? Asset : Asset | undefined;
  }

  /**
   * @param name The name of the asset to find and remove, case-insensitive.
   */
  @sequential
  async removeAssetByName(name: string | undefined) {
    if (!name) return;
    name = name.toLocaleLowerCase();
    const asset = this.assets.get(name);
    if (!asset) return;
    const directory =
      asset.dir.absolute.toLocaleLowerCase().replaceAll('\\', '/') + '/';
    assert(
      ![...this.assets.values()].some(
        (other) =>
          other !== asset &&
          other.sourcePaths?.some((path) =>
            path.absolute
              .toLocaleLowerCase()
              .replaceAll('\\', '/')
              .startsWith(directory),
          ),
      ),
      'Resource deletion would remove GML source referenced by another resource.',
    );
    // Remove the asset from the yyp
    const resourceIdx = this.yyp.resources.findIndex(
      (r) => r.id.name.toLocaleLowerCase() === name,
    );
    // If it's a room, remove it from the room order list
    if (isAssetOfKind(asset, 'rooms')) {
      this.yyp.RoomOrderNodes = this.yyp.RoomOrderNodes.filter((node) => {
        return (
          node.roomId.path.toLowerCase() !==
          asset.resource.id.path.toLowerCase()
        );
      });
    }
    // If it'll be referenced in other assets, remove those references
    else if (
      isAssetOfKind(asset, 'objects') ||
      isAssetOfKind(asset, 'sprites')
    ) {
      for (const other of this.assets.values()) {
        if (
          isAssetOfKind(asset, 'sprites') &&
          isAssetOfKind(other, 'objects')
        ) {
          // If this object has this sprite, unset it!
          if (other.sprite?.name === asset.name) {
            other.sprite = undefined;
          }
        } else if (
          isAssetOfKind(asset, 'objects') &&
          isAssetOfKind(other, 'objects')
        ) {
          // Then this object might be referenced in a collision event
          // with the other object.
          const yy = other.yy;
          const [keepEvents, removeEvents] = yy.eventList.reduce(
            (acc, event) => {
              if (event.collisionObjectId?.name === asset.name) {
                acc[1].push(event);
              } else {
                acc[0].push(event);
              }
              return acc;
            },
            [[], []] as [keep: YyObjectEvent[], discard: YyObjectEvent[]],
          );
          if (removeEvents.length) {
            // Remove the collision events
            other.yy.eventList = keepEvents;
            await other.saveYy();
            // Remove the leftover collision event file
            const eventFile = other.dir.join(`Collision_${asset.name}.gml`);
            await eventFile.delete({ recursive: true });
            await other.reload();
          }
          // It could also be listed as the parent
          if (other.parent?.name === asset.name) {
            other.parent = undefined;
          }
        }
      }
    }

    this.assets.delete(name);
    if (resourceIdx > -1) {
      this.yyp.resources.splice(resourceIdx, 1);
      await this.saveYyp();
    }

    // Clean up
    await asset.onRemove();
  }

  getAsset(path: Pathy<any>): Asset | undefined {
    return this.assets.get(this.assetNameFromPath(path));
  }

  getGmlFile(path: Pathy<any>): Code | undefined {
    return (
      this.analysis.document(path.absolute) ||
      this.getAsset(path)?.getGmlFile(path)
    );
  }

  /** Normalize path information for a datafile ("Included File") */
  parseIncludedFilePath(
    filePath: string,
    name?: string,
  ): { filePath: string; name: string } {
    filePath.replace(/[/\\]+$/, '/').replace(/\/$/, '');
    if (!name) {
      ({ folder: filePath, name } =
        filePath.match(/^(?<folder>.*)[/\\](?<name>[^/\\]+)$/)?.groups || {});
    }
    assert(filePath, `Invalid folder: ${filePath}`);
    assert(name, `Invalid name: ${name}`);
    assert(
      filePath === 'datafiles' || filePath.startsWith('datafiles/'),
      `Folder must be in datafiles: ${filePath}`,
    );
    return { filePath, name };
  }

  findIncludedFile(filePath: string, name?: string) {
    ({ filePath, name } = this.parseIncludedFilePath(filePath, name));
    return this.datafiles.find(
      (f) =>
        f.name.toLowerCase() === name!.toLowerCase() &&
        f.filePath.toLowerCase() === filePath.toLowerCase(),
    );
  }

  /**
   * Ensure that the included files listed in the YYP exactly match
   * the files in the `datafiles` directory.
   */
  @sequential
  async syncIncludedFiles() {
    const includedFiles = (
      await this.dir.join('datafiles').listChildrenRecursively()
    ).map((f) => {
      /** The filepath relative to the project dir (starts with 'datafiles') */
      const fullPath = f.relativeFrom(this.dir);
      // Will throw with unexpected paths, preventing anything from being
      // overwritten. This is a better outcome than skipping those files.
      const { filePath, name } = this.parseIncludedFilePath(fullPath);
      const existing = this.findIncludedFile(filePath, name);

      return existing || { filePath, name };
    });
    const sortByFullPath = <T extends { filePath: string; name: string }>(
      files: readonly T[],
    ) =>
      [...files].sort((a, b) =>
        `${a.filePath}/${a.name}`
          .toLowerCase()
          .localeCompare(`${b.filePath}/${b.name}`.toLowerCase()),
      );
    if (
      Yy.areEqual(
        sortByFullPath(this.yyp.IncludedFiles),
        sortByFullPath(includedFiles),
      )
    ) {
      return;
    }

    // @ts-expect-error The schema will ensure it's written correctly
    this.yyp.IncludedFiles = includedFiles;
    await this.saveYyp();
  }

  /** @internal Load an Asset instance into the project's data model. For use by methods that load the project, add assets, etc. */
  registerAsset(resource: Asset): void {
    const name = this.assetNameFromPath(resource.dir);
    ok(!this.assets.has(name), `Resource ${name} already exists`);
    this.assets.set(name, resource);
  }

  /**
   * @param from The name of the asset to rename, case-insensitive.
   * @param to The new name for the asset, which must be a valid identifier that doesn't already have an associated asset. The name will be set in the provided casing, but must be unique case-insensitively.
   */
  @sequential
  async renameAsset(from: string, to: string) {
    await this.analysis.analyze();
    assert(
      this.analysis.isCurrent,
      'Current project analysis is required before rename.',
    );
    const asset = this.getAssetByName(from, { assertExists: true });
    assertIsValidIdentifier(to);
    const destination = this.getAssetByName(to);
    assert(
      !destination || destination === asset,
      `Cannot rename. An asset named "${to}" already exists`,
    );
    if (asset.name === to) return;
    const global = this.self.getMember(to);
    assert(
      !global || global === asset.signifier || global.placeholder,
      `The name ${to} already exists in global scope.`,
    );
    const guard = this.editGuard();
    const documents = this.renameDocuments(asset.signifier, to);
    const moves = new Map<string, { from: string; to: string }>();
    const addMove = (from: string, to: string) => {
      if (from === to) return;
      const previous = moves.get(from);
      assert(
        !previous || previous.to === to,
        `Conflicting rename destinations for ${from}`,
      );
      moves.set(from, { from, to });
    };
    const oldNamePattern = new RegExp(`\\b${asset.name}\\b`, 'gi');
    const collectFiles = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = joinPath(directory, entry.name);
        if (entry.isDirectory()) {
          await collectFiles(path);
          continue;
        }
        const name =
          entry.name.toLocaleLowerCase() ===
          `${asset.name}.yy`.toLocaleLowerCase()
            ? `${to}.yy`
            : entry.name.replace(oldNamePattern, to);
        if (name !== entry.name)
          addMove(
            pathy(path).absolute,
            pathy(joinPath(directory, name)).absolute,
          );
      }
    };
    await collectFiles(asset.dir.absolute);
    if (asset.isObject)
      for (const other of this.assets.values()) {
        if (!other.isObject) continue;
        for (const event of (other.yy as YyObject).eventList) {
          if (
            event.eventType !== 4 ||
            event.collisionObjectId?.name.toLocaleLowerCase() !==
              asset.name.toLocaleLowerCase()
          )
            continue;
          const expected = `Collision_${event.collisionObjectId.name}.gml`;
          const code = [...other.gmlFiles.values()].find(
            (code) =>
              code.path.basename.toLocaleLowerCase() ===
              expected.toLocaleLowerCase(),
          );
          assert(
            code,
            `Cannot rename while the collision event file is missing: ${other.name}/${expected}`,
          );
          addMove(
            code.path.absolute,
            other.dir.join(`Collision_${to}.gml`).absolute,
          );
        }
      }
    addMove(asset.dir.absolute, asset.dir.up().join(to).absolute);
    const renames = [...moves.values()];
    const oldResourcePath = asset.resource.id.path
      .replaceAll('\\', '/')
      .toLocaleLowerCase();
    const rewriteLinks = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(rewriteLinks);
        return;
      }
      const record = value as Record<string, unknown>;
      if (
        record.resourceType === 'GMObjectProperty' &&
        record.varType === YyObjectPropertyVarType.Asset &&
        typeof record.value === 'string' &&
        record.value.trim() === asset.name
      )
        record.value = record.value.replace(asset.name, to);
      if (
        typeof record.creationCodeFile === 'string' &&
        record.creationCodeFile
      ) {
        const prefix =
          record.creationCodeFile.match(/^\$\{project_dir\}[/\\]?/)?.[0] || '';
        const path = this.dir.join(
          record.creationCodeFile.slice(prefix.length),
        ).absolute;
        const renamed = renamedPath(path, renames);
        if (renamed !== path)
          record.creationCodeFile =
            prefix +
            pathy(renamed).relativeFrom(this.dir).replaceAll('\\', '/');
      }
      if (typeof record.path === 'string') {
        if (
          record.path.replaceAll('\\', '/').toLocaleLowerCase() ===
            oldResourcePath &&
          typeof record.name === 'string' &&
          record.name.toLocaleLowerCase() === asset.name.toLocaleLowerCase()
        )
          record.name = to;
        const path = this.dir.join(record.path).absolute;
        const renamed = renamedPath(path, renames);
        if (renamed !== path)
          record.path = pathy(renamed)
            .relativeFrom(this.dir)
            .replaceAll('\\', '/');
      }
      for (const child of Object.values(record)) rewriteLinks(child);
    };
    const changedAssets = new Set<Asset>();
    for (const current of this.assets.values()) {
      // An unsaved metadata edit must be reconciled before binding-based rename.
      const buffer = this.options?.documentText?.(current.yyPath.absolute);
      if (typeof buffer === 'string')
        assert(
          Yy.areEqual(Yy.parse(buffer, current.assetKind), current.yy),
          `Resource metadata changed; refresh before renaming: ${current.yyPath.absolute}`,
        );
      // YY numbers retain precision metadata and custom prototypes. The YY
      // codec preserves those values; structuredClone converts them to Number.
      const yy = Yy.parse(
        Yy.stringify(current.yy, current.assetKind, this.yyp),
        current.assetKind,
      );
      rewriteLinks(yy);
      if (current === asset) {
        yy.name = to;
        if ('%Name' in yy) yy['%Name'] = to;
        if (isAssetOfKind(asset, 'sounds'))
          (yy as YySound).soundFile = (yy as YySound).soundFile.replace(
            oldNamePattern,
            to,
          );
        if (isAssetOfKind(asset, 'sprites')) {
          const sequence = (yy as YySprite).sequence;
          if (sequence?.name === asset.name) sequence.name = to;
          if (
            sequence &&
            '%Name' in sequence &&
            sequence['%Name'] === asset.name
          )
            sequence['%Name'] = to;
        }
      }
      if (Yy.areEqual(yy, current.yy)) continue;
      const expectedText = await this.readDocumentText(current.yyPath);
      assert(
        Yy.areEqual(Yy.parse(expectedText, current.assetKind), current.yy),
        `Resource metadata changed; refresh before renaming: ${current.yyPath.absolute}`,
      );
      documents.push({
        filePath: current.yyPath.absolute,
        expectedText,
        edits: [
          {
            start: 0,
            end: expectedText.length,
            text: Yy.stringify(yy, current.assetKind, this.yyp),
          },
        ],
      });
      changedAssets.add(current);
    }
    const expectedYyp = await this.readDocumentText(this.yypPath);
    assert(
      Yy.areEqual(Yy.parse(expectedYyp, 'project'), this.yyp),
      'The project resource list changed; refresh before renaming.',
    );
    const yyp = Yy.parse(expectedYyp, 'project');
    rewriteLinks(yyp);
    documents.push({
      filePath: this.yypPath.absolute,
      expectedText: expectedYyp,
      edits: [
        {
          start: 0,
          end: expectedYyp.length,
          text: Yy.stringify(yyp, 'project'),
        },
      ],
    });
    guard();
    await this.commitEdits(
      `Rename resource ${asset.name} to ${to}`,
      documents,
      renames,
      guard,
      async () => {
        this.yyp = Yy.parse(
          await this.readDocumentText(this.yypPath),
          'project',
        );
        this.assets.delete(asset.name.toLocaleLowerCase());
        asset.retireModel();
        const resource = this.yyp.resources.find(
          (entry) => entry.id.name === to,
        );
        assert(resource, `The renamed resource is not listed: ${to}`);
        const replacement = await Asset.from(this, resource);
        assert(replacement, `The renamed resource could not be loaded: ${to}`);
        this.registerAsset(replacement);
        for (const current of changedAssets)
          if (current !== asset) await current.reload(false);
        for (const current of this.assets.values()) current.refreshParent();
      },
    );
  }

  async renameSignifier(signifier: Signifier, newName: string) {
    await this.analysis.analyze();
    assert(
      this.analysis.isCurrent,
      'Current project analysis is required before rename.',
    );
    const resource = [...this.assets.values()].find(
      (asset) => asset.signifier === signifier,
    );
    if (resource) return this.renameAsset(resource.name, newName);
    assert(
      signifier.isRenameable,
      'This symbol does not have a safe editable GML definition.',
    );
    const guard = this.editGuard();
    const documents = this.renameDocuments(signifier, newName);
    if (!documents.length) return;
    await this.commitEdits(
      `Rename ${signifier.name} to ${newName}`,
      documents,
      [],
      guard,
    );
  }

  private renameDocuments(
    signifier: Signifier,
    newName: string,
  ): ProjectDocumentEdit[] {
    const universe = this.analysis.references;
    const edits = planReferenceRename(
      universe.filter((reference) => reference.item === signifier),
      newName,
      universe,
    );
    const documents = new Map<
      string,
      {
        filePath: string;
        expectedText: string;
        edits: { start: number; end: number; text: string }[];
      }
    >();
    for (const edit of edits) {
      const file = edit.range.file;
      let document = documents.get(file.path.absolute);
      if (!document)
        documents.set(
          file.path.absolute,
          (document = {
            filePath: file.path.absolute,
            expectedText: file.content,
            edits: [],
          }),
        );
      document.edits.push({
        start: edit.range.start.offset,
        end: edit.range.end.offset + 1,
        text: edit.text,
      });
    }
    for (const document of documents.values()) editedText(document);
    return [...documents.values()];
  }

  private editGuard(): (ownInvalidations?: number) => void {
    const generation = this.analysis.generation;
    const documents = [...this.assets.values()]
      .flatMap((asset) => [...asset.gmlFiles.values()])
      .map((code) => ({ code, version: code.analysisState.contentVersion }));
    return (ownInvalidations = 0) => {
      if (
        this.disposed ||
        this.analysis.generation !== generation + ownInvalidations ||
        documents.some(
          ({ code, version }) =>
            this.analysis.document(code.path.absolute) !== code ||
            code.analysisState.contentVersion !== version,
        )
      )
        throw new Error(
          'The project changed while preparing the rename. Retry against the current analysis.',
        );
    };
  }

  private async commitEdits(
    label: string,
    documents: readonly ProjectDocumentEdit[],
    renames: ProjectEditBatch['renames'],
    guard: (ownInvalidations?: number) => void,
    reconcile?: () => Promise<void>,
  ): Promise<boolean> {
    const paths = [
      ...new Set([
        ...documents.map((document) => document.filePath),
        ...renames.flatMap((move) => [move.from, move.to]),
      ]),
    ];
    // Preflight outside the resource barrier. Nothing is written on rejection.
    for (const document of documents) {
      editedText(document);
      if (
        !this.options?.applyEdits &&
        (typeof this.options?.documentText?.(document.filePath) === 'string' ||
          this.getGmlFile(pathy(document.filePath))?.hasOwnedBuffer)
      )
        throw new ProjectEditError(
          'A host-owned buffer requires the applyEdits callback',
          paths,
        );
      if (
        (await this.readDocumentText(pathy(document.filePath))) !==
        document.expectedText
      )
        throw new ProjectEditError('A document changed before rename', paths);
    }
    if (!this.options?.applyEdits && renames.length)
      for (const current of this.assets.values())
        for (const code of current.gmlFiles.values()) {
          if (
            renamedPath(code.path.absolute, renames) !== code.path.absolute &&
            code.hasOwnedBuffer
          )
            throw new ProjectEditError(
              'Moving a host-owned document requires the applyEdits callback',
              paths,
            );
        }
    await validateRenames(renames);
    guard();
    const batch: ProjectEditBatch = {
      label,
      documents,
      renames,
      validate: () => guard(1),
    };
    let applicationStarted = false;
    try {
      const committed = await this.withResourceUpdate(async () => {
        batch.validate();
        if (this.options?.applyEdits) {
          applicationStarted = true;
          if (!(await this.options.applyEdits(batch))) {
            applicationStarted = false;
            return false;
          }
        } else {
          applicationStarted = true;
          await applyDiskEdits(batch);
        }
        // Confirm the actual host/filesystem result before installing a new model.
        for (const document of documents) {
          const finalPath = renamedPath(document.filePath, renames);
          if (
            (await this.readDocumentText(pathy(finalPath))) !==
            editedText(document)
          )
            throw new ProjectEditError(
              'Document state changed during rename application',
              paths,
            );
        }
        for (let index = 0; index < renames.length; index++) {
          const move = renames[index];
          const destination = renamedPath(move.to, renames.slice(index + 1));
          if (!(await pathExists(destination)))
            throw new ProjectEditError(
              'A renamed path is missing after application',
              paths,
            );
        }
        if (reconcile) await reconcile();
        for (const document of documents)
          await this.getGmlFile(
            pathy(renamedPath(document.filePath, renames)),
          )?.readContent(undefined, true);
        this.setResourceDiagnostics(this.yypPath.absolute, 'edit', []);
        return true;
      });
      if (!committed)
        throw new Error(
          'The host rejected the edit batch before applying changes.',
        );
      return true;
    } catch (cause) {
      let failure: unknown = cause;
      if (applicationStarted) {
        // A host may have applied only part of a mixed edit. Re-read reality;
        // never install the unfinished plan or reverse newer buffer edits.
        try {
          await this.reloadYyp();
          const names = new Set(
            paths.map((path) => this.assetNameFromPath(pathy(path))),
          );
          await this.withResourceUpdate(async () => {
            for (const name of names)
              await this.assets.get(name)?.reload(false);
            for (const current of this.assets.values()) current.refreshParent();
            for (const path of paths)
              await this.getGmlFile(pathy(path))?.readContent(undefined, true);
          });
        } catch (recovery) {
          failure = new AggregateError(
            [cause, recovery],
            'The edit failed and final-state reconciliation also failed.',
          );
        }
      }
      const detail =
        cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
      const error = new ProjectEditError(
        `${applicationStarted ? 'Rename application failed' : 'Rename preflight rejected'}: ${detail}`,
        paths,
        { cause: failure },
      );
      const location = { line: 1, column: 1, offset: 0 };
      this.setResourceDiagnostics(this.yypPath.absolute, 'edit', [
        new Diagnostic(
          error.message,
          { start: location, end: location },
          'error',
        ),
      ]);
      throw error;
    }
  }

  @sequential
  async import(
    fromProject: Project | string,
    options: ImportModuleOptions = {},
  ) {
    if (typeof fromProject === 'string') {
      fromProject = await Project.initialize(fromProject);
    }
    return await importAssets(fromProject, this, options);
  }

  @sequential
  async duplicateAsset(sourceName: string, newPath: string) {
    const source = this.getAssetByName(sourceName, { assertExists: true });
    const parsed = await this.parseNewAssetPath(newPath);
    assert(parsed, `Invalid new asset path: ${newPath}`);
    // Copy all files in the source's directory to a new directory named
    // after the new name.
    const kind = source.assetKind;
    const cloneDir = this.dir.join(`${kind}/${parsed.name}`);
    await cloneDir.ensureDirectory();
    await source.dir.copy(cloneDir);
    // Rename any files named after the original asset
    const oldNamePattern = new RegExp(`\\b${sourceName}\\b`, 'gi');
    let yyFile: Pathy<YySchema<any>> | undefined;
    await cloneDir.listChildrenRecursively({
      filter: async (p) => {
        if (await p.isDirectory()) return;
        // Get the relative path
        const relative = p.relativeFrom(cloneDir);
        const newRelative = relative.replaceAll(oldNamePattern, parsed.name);
        if (newRelative === relative) return;
        // Rename!
        const newFile = cloneDir.join(newRelative);
        await p.copy(newFile);
        await p.delete();
        if (
          newFile.hasExtension('yy') &&
          newFile.name.toLowerCase() === parsed.name.toLowerCase()
        ) {
          yyFile = newFile;
        }
      },
    });
    assert(yyFile, `Could not find yy file for new asset ${parsed.name}`);
    // Update the yy files to replace the old name with the new
    // Just read them as text so we don't have to deal with parsing
    const content: string = await yyFile.read({ encoding: 'utf8' });
    const newContent = content.replaceAll(
      new RegExp(`"${sourceName}"`, 'gi'),
      `"${parsed.name}"`,
    );
    await yyFile.write(newContent);
    // Add the new asset to the yyp file
    const info = await this.addAssetToYyp(yyFile.absolute);
    const newAsset = await Asset.from(this, info);
    assert(newAsset, `Could not create new asset ${parsed.name}`);
    this.registerAsset(newAsset);
    return newAsset;
  }

  /**
   * Create a new sound asset. Will not do anything if the asset by this name already exists (but will log an error).
   * @param newSoundPath The POSIX-style path within the asset tree where you want this sound to be created, where the last component is the name of the sound asset.
   * @param fromFile The path to the source sound file to copy into the new asset's directory.
   * @example project.createSound('folder/of/sounds/snd_my_new_sound', 'path/to/sound.mp3');
   */
  @sequential
  async createSound(newSoundPath: string, fromFile: string | Pathy) {
    // Create the yy file
    const parsed = await this.parseNewAssetPath(newSoundPath);
    if (!parsed) {
      return;
    }
    const { name, folder } = parsed;
    assert(
      isValidSoundName(name, this.config),
      `Sound name '${name}' does not match allowed patterns`,
    );

    const defaults = getDefaultsForNewSound(name, this.config);
    const soundDir = this.dir.join(`sounds/${name}`);
    await soundDir.ensureDirectory();
    const soundYy = soundDir.join(`${name}.yy`);
    // Copy the sound file over
    fromFile = pathy(fromFile);
    const soundFileName = `${name}${fromFile.extname}`;
    await fromFile.copy(soundDir.join(soundFileName));

    await Yy.write(
      soundYy.absolute,
      {
        name,
        parent: {
          name: folder.name,
          path: folder.folderPath,
        },
        type: defaults?.mono ? SoundChannel.Mono : SoundChannel.Stereo,
        soundFile: soundFileName,
        resourceVersion: '2.0',
      } as any,
      'sounds',
      this.yyp,
    );

    // Update the yyp file
    const info = await this.addAssetToYyp(soundYy.absolute);

    // Create and add the asset
    const asset = await Asset.from(this, info);
    if (asset) {
      this.registerAsset(asset);
    }
    return asset;
  }

  /**
   * Create a new room asset. Will not do anything if the asset by this name already exists (but will log an error).
   * @param newRoomPath The POSIX-style path within the asset tree where you want this asset to be created, where the last component is the name of the asset.
   * @example project.createRoom('folder/of/rooms/rm_my_room');
   */
  @sequential
  async createRoom(newRoomPath: string): Promise<Asset<'rooms'> | undefined> {
    const parsed = await this.parseNewAssetPath(newRoomPath);
    if (!parsed) {
      return;
    }
    const { name, folder } = parsed;

    const roomDir = this.dir.join(`rooms/${name}`);
    await roomDir.ensureDirectory();
    const roomYy = roomDir.join(`${name}.yy`);

    const yy = yyRoomSchema.parse({
      name,
      parent: {
        name: folder.name,
        path: folder.folderPath,
      },
      layers: [{ resourceType: 'GMRBackgroundLayer' }],
      views: [...Array(8)].map(() => ({})),
    });
    yy.views[0].visible = true;

    await Yy.write(roomYy.absolute, yy, 'rooms', this.yyp);

    // Update the yyp file
    const info = await this.addAssetToYyp(roomYy.absolute, { skipSave: true });
    this.yyp.RoomOrderNodes.push({ roomId: info.id });
    await this.saveYyp();

    // Create and add the asset
    const asset = await Asset.from(this, info);
    if (asset) {
      this.registerAsset(asset);
    }
    return asset as Asset<'rooms'>;
  }

  /**
   * Create a new sprite asset. Will not do anything if the asset by this name already exists (but will log an error).
   * @param newSpritePath The POSIX-style path within the asset tree where you want this asset to be created, where the last component is the name of the asset.
   * @param fromImageFile Path to a source PNG image to use as the first frame of the sprite.
   * @example project.createSprite('folder/of/sprites/sp_my_sprite', 'path/to/sprite.png');
   */
  @sequential
  async createSprite(
    newSpritePath: string,
    fromImageFile: string | Pathy,
  ): Promise<Asset<'sprites'> | undefined> {
    // Create the yy file
    const parsed = await this.parseNewAssetPath(newSpritePath);
    if (!parsed) {
      return;
    }
    const { name, folder } = parsed;
    assert(
      isValidSpriteName(name, this.config),
      `Sprite name '${name}' does not match allowed patterns`,
    );

    const spriteDir = this.dir.join(`sprites/${name}`);
    await spriteDir.ensureDirectory();
    const spriteYy = spriteDir.join(`${name}.yy`);

    // Get the source image dimensions
    fromImageFile = pathy(fromImageFile);
    assert(fromImageFile.hasExtension('png'), `Expected a .png file`);
    const { width, height } = await getPngSize(fromImageFile);
    const xorigin = Math.floor(width / 2) - 1;
    const yorigin = Math.floor(height / 2) - 1;
    const frames: any[] = [];
    frames.length = 1;
    const yy = yySpriteSchema.parse({
      name,
      parent: {
        name: folder.name,
        path: folder.folderPath,
      },
      type: SpriteType.Default,
      width,
      height,
      sequence: { xorigin, yorigin },
      frames,
    });
    // Now we'll have a frameId
    const frameId = yy.frames[0].name;
    assert(frameId, `Expected a frameId`);
    await fromImageFile.copy(spriteDir.join(`${frameId}.png`));

    await Yy.write(spriteYy.absolute, yy, 'sprites', this.yyp);

    // Update the yyp file
    const info = await this.addAssetToYyp(spriteYy.absolute);

    // Create and add the asset
    const asset = await Asset.from(this, info);
    if (asset) {
      this.registerAsset(asset);
    }
    return asset as Asset<'sprites'>;
  }

  /**
   * Add an object to the yyp file. The string can include separators,
   * in which case folders will be ensured up to the final component.
   * @param newObjectName The POSIX-style path within the asset tree where you want this asset to be created, where the last component is the name of the asset.
   */
  @sequential
  async createObject(
    newObjectName: string,
  ): Promise<Asset<'objects'> | undefined> {
    // Create the yy file
    const parsed = await this.parseNewAssetPath(newObjectName);
    if (!parsed) {
      return;
    }
    const { name, folder } = parsed;
    const objectDir = this.dir.join(`objects/${name}`);
    await objectDir.ensureDirectory();
    const objectYy = objectDir.join(`${name}.yy`);
    const objectCreateFile = objectDir.join('Create_0.gml');
    await objectCreateFile.write('/// ');

    await Yy.write(
      objectYy.absolute,
      {
        name,
        parent: {
          name: folder.name,
          path: folder.folderPath,
        },
        // Include the Create event by default
        eventList: [{ eventNum: 0, eventType: 0 } as any],
      } as any,
      'objects',
      this.yyp,
    );

    // Update the yyp file
    const info = await this.addAssetToYyp(objectYy.absolute);

    // Create and add the asset
    const asset = await Asset.from(this, info);
    if (asset) {
      this.registerAsset(asset);
    }
    return asset as Asset<'objects'>;
  }

  @sequential
  async createShader(path: string): Promise<Asset<'shaders'> | undefined> {
    // Create the yy file
    const parsed = await this.parseNewAssetPath(path);
    if (!parsed) {
      return;
    }
    const { name, folder } = parsed;
    const shaderDir = this.dir.join(`shaders/${name}`);
    await shaderDir.ensureDirectory();
    const shaderYy = shaderDir.join(`${name}.yy`);
    await Yy.write(
      shaderYy.absolute,
      {
        name,
        parent: {
          name: folder.name,
          path: folder.folderPath,
        },
      } as any,
      'shaders',
      this.yyp,
    );

    // Create the fsh and vsh files
    const fsh = shaderYy.changeExtension('fsh');
    await fsh.write(fshDefault);
    const vsh = shaderYy.changeExtension('vsh');
    await vsh.write(vshDefault);

    // Update the yyp file
    const info = await this.addAssetToYyp(shaderYy.absolute);

    // Create and add the asset
    const asset = await Asset.from(this, info);
    if (asset) {
      this.registerAsset(asset);
    }
    return asset as Asset<'shaders'>;
  }

  /**
   * Add a script to the yyp file. The path string can include separators,
   * in which case folders will be ensured up to the final component.
   */
  @sequential
  async createScript(path: string): Promise<Asset<'scripts'> | undefined> {
    // Create the yy file
    const parsed = await this.parseNewAssetPath(path);
    if (!parsed) {
      return;
    }
    const { name, folder } = parsed;
    assertIsValidIdentifier(name);
    const scriptDir = this.dir.join(`scripts/${name}`);
    await scriptDir.ensureDirectory();
    const scriptYy = scriptDir.join(`${name}.yy`);
    await Yy.write(
      scriptYy.absolute,
      {
        name,
        parent: {
          name: folder.name,
          path: folder.folderPath,
        },
      } as any,
      'scripts',
      this.yyp,
    );

    // Create the gml file
    const scriptGml = scriptYy.changeExtension('gml');
    await scriptGml.write('/// ');

    // Update the yyp file
    const info = await this.addAssetToYyp(scriptYy.absolute);

    // Create and add the asset
    const asset = await Asset.from(this, info);
    if (asset) {
      this.registerAsset(asset);
    }
    return asset as Asset<'scripts'>;
  }

  protected async parseNewAssetPath(path: string) {
    const parts = path.split(/[/\\]+/);
    const name = parts.pop()!;
    if (!name) {
      logger.error(`Attempted to add script with no name: ${path}`);
      return;
    }
    assertIsValidIdentifier(name);
    const existingAsset = this.getAssetByName(name);
    if (existingAsset) {
      logger.error(
        `An asset named ${path} (${existingAsset.assetKind}) already exists`,
      );
      return;
    }
    if (!parts.length) {
      logger.error(`Adding scripts to the root directory is not supported.`);
      return;
    }
    const folder = (await this.createFolder(parts))!;
    return { folder, name };
  }

  /**
   * Given the path to a yy file for an asset, ensure
   * it has an entry in the yyp file. */
  async addAssetToYyp(
    yyPath: string,
    options?: { skipSave?: boolean },
  ): Promise<YypResource> {
    assert(yyPath.endsWith('.yy'), `Expected yy file, got ${yyPath}`);
    const parts = yyPath.split(/[/\\]+/).slice(-3);
    assert(
      parts.length === 3,
      `Expected path with at least 3 parts, got ${yyPath}`,
    );
    const [type, name, basename] = parts;
    const resourceEntry: YypResource = {
      id: {
        name,
        path: `${type}/${name}/${basename}`,
      },
    };
    // Insert the resource into a random spot in the list to avoid git conflicts,
    // avoiding the last spot because that's where changes are most likely to be.
    // (This only matters for older project versions -- the newer version )
    const lastAllowed = Math.max(0, this.yyp.resources.length - 1);
    const insertAt = Math.floor(Math.random() * lastAllowed);
    this.yyp.resources.splice(insertAt, 0, resourceEntry);
    if (!options?.skipSave) {
      await this.saveYyp();
    }
    return resourceEntry;
  }

  protected parseFolderPath(path: string | string[]) {
    const parts = Array.isArray(path) ? path : path.split(/[/\\]+/);
    const full = `folders/${parts.join('/')}.yy`;
    const prefix = `folders/${parts.join('/')}/`;
    return { parts, full, prefix };
  }

  listAssetsInFolder(
    path: string | string[],
    options?: { recursive: boolean },
  ) {
    const { full, prefix } = this.parseFolderPath(path);
    const foundAssets: Asset[] = [];

    for (const asset of this.assets.values()) {
      const assetFolder = asset.yy?.parent as yyParentSchema;
      if (assetFolder.path === full) {
        foundAssets.push(asset);
      } else if (options?.recursive && assetFolder.path.startsWith(prefix)) {
        foundAssets.push(asset);
      }
    }
    return foundAssets;
  }

  /**
   * Delete a folder recursively. Only allowed if there are no assets
   * in this or any subfolder.
   */
  @sequential
  async deleteFolder(path: string | string[]) {
    const assets = this.listAssetsInFolder(path, { recursive: true });
    const { full, prefix } = this.parseFolderPath(path);
    assert(!assets.length, 'Cannot delete folder containing assets!');
    for (let f = this.yyp.Folders.length - 1; f >= 0; f--) {
      const currentFolder = this.yyp.Folders[f];
      // If this is the "old" folder, delete it
      if (
        full === currentFolder.folderPath ||
        currentFolder.folderPath.startsWith(prefix)
      ) {
        this.yyp.Folders.splice(f, 1);
        continue;
      }
    }
    await this.saveYyp();
  }

  /**
   * Rename an existing folder. Allows for renaming any part of
   * the path (useful both "moving" and "renaming" a folder).
   * Array inputs are interpreted as pre-split paths. If the new
   * name matches an existing folder, it will in effect be "merged"
   * with that existing folder.
   *
   * Returns the list of folders and assets that are now in a new
   * location. */
  @sequential
  async renameFolder(oldPath: string | string[], newPath: string | string[]) {
    const oldParts = Array.isArray(oldPath) ? oldPath : oldPath.split(/[/\\]+/);
    const newParts = Array.isArray(newPath) ? newPath : newPath.split(/[/\\]+/);
    if (!oldParts.length) {
      logger.warn(`Cannot rename root folder`);
      return;
    }
    if (oldParts.join('/') === newParts.join('/')) {
      logger.warn(`Folder is already named that. Skipping rename.`);
      return;
    }
    // Ensure the new folder exists
    const targetFolder = await this.createFolder(newParts);
    if (!targetFolder) return;

    // Move subfolders from the old folder to the new folder
    const oldPathFull = `folders/${oldParts.join('/')}.yy`;
    const oldPathPrefix = `folders/${oldParts.join('/')}/`;
    const newPathPrefix = `folders/${newParts.join('/')}/`;
    const movedFolders: [from: YypFolder, to: YypFolder | undefined][] = [];
    // Start from the end so we can delete as we go
    for (let f = this.yyp.Folders.length - 1; f >= 0; f--) {
      const currentFolder = this.yyp.Folders[f];
      // If this is the "old" folder, delete it
      if (oldPathFull === currentFolder.folderPath) {
        this.yyp.Folders.splice(f, 1);
        movedFolders.push([currentFolder, undefined]);
        continue;
      }
      // If this is a subfolder of the old folder, move it
      if (currentFolder.folderPath.startsWith(oldPathPrefix)) {
        const newPath = currentFolder.folderPath.replace(
          oldPathPrefix,
          newPathPrefix,
        );
        this.yyp.Folders[f] = {
          ...currentFolder,
          folderPath: newPath,
        };
        movedFolders.push([currentFolder, this.yyp.Folders[f]]);
      }
    }
    await this.saveYyp();

    // Move assets from the old folder to the new folder
    const movedAssets: Asset[] = [];
    for (const asset of this.assets.values()) {
      const assetFolder = asset.yy?.parent as yyParentSchema;
      let moved = false;
      if (assetFolder.path === oldPathFull) {
        asset.yy.parent = {
          name: targetFolder.name,
          path: targetFolder.folderPath,
        };
        moved = true;
      } else if (assetFolder.path.startsWith(oldPathPrefix)) {
        // The name comes from a subfolder, so just need to update the path
        asset.yy.parent = {
          name: assetFolder.name,
          path: assetFolder.path.replace(oldPathPrefix, newPathPrefix),
        };
        moved = true;
      }
      if (moved) {
        movedAssets.push(asset);
        await asset.saveYy();
      }
    }
    return { movedFolders, movedAssets };
  }

  /**
   * Add a folder to the yyp file. The string can include separators,
   * in which case nested folders will be created. If an array is provided,
   * it is interpreted as a pre-split path. */
  async createFolder(
    path: string | string[],
    options?: { skipSave?: boolean },
  ): Promise<YypFolder | undefined> {
    const parts = Array.isArray(path) ? path : path.split(/[/\\]+/);
    const folders = this.yyp.Folders;
    let current = 'folders/';
    let folder: YypFolder | undefined;
    /** A random location in the list where this new folder should be put,
     * to reduce git conflicts.*/
    const insertAt = Math.max(
      Math.floor(Math.random() * folders.length - 1),
      0,
    );
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) {
        continue;
      }
      const thisFolderPath = current + part + '.yy';
      folder = folders.find((f) => f.folderPath === thisFolderPath);
      if (!folder) {
        folder = yypFolderSchema.parse({
          folderPath: thisFolderPath,
          name: part,
        });
        folders.splice(insertAt, 0, folder);
      }
      current += part + '/';
    }
    if (!options?.skipSave) {
      await this.saveYyp();
    }
    return folder;
  }

  @sequential
  async saveYyp() {
    await Yy.write(this.yypPath.absolute, this.yyp, 'project');
  }

  /**
   * The name of a resource, *in lower case*, from
   * a path. This is used as the key for looking up resources.
   *
   * The path can be to the asset's folder, or to any file within
   * that folder.
   */
  assetNameFromPath(path: Pathy<any>): string {
    const parts = path.relativeFrom(this.dir).split(/[/\\]+/);
    return parts[1]?.toLocaleLowerCase?.();
  }

  /**
   * When first creating an instance, we need to get all project file
   * content into memory for fast access. In particular, we need all
   * yyp, yy, and gml files for scripts and objects. For other asset types
   * we just need their names and yyp filepaths.
   *
   * Can be called at any time -- will only operate on new assets.
   *
   * Returns the list of added assets. Assets are instanced and registered but their
   * code is not parsed!
   */
  protected async loadAssets(options?: ProjectOptions): Promise<Asset[]> {
    const t = Date.now();

    // We'll say that resources take 80% of loading,
    // and distribute that across the number of resources.
    const perAssetIncrement = this.yyp.resources.length
      ? 80 / this.yyp.resources.length
      : 0;
    const resourceWaits: Promise<Asset | undefined>[] = [];
    for (const resourceInfo of this.yyp.resources) {
      assert(
        resourceInfo.id.name,
        `Resource ${resourceInfo.id.path} has no name`,
      );
      const name = resourceInfo.id.name.toLocaleLowerCase();
      // Skip it if we already have it
      if (this.assets.has(name)) {
        continue;
      }

      resourceWaits.push(
        Asset.from(this, resourceInfo).then((r) => {
          if (!r) {
            logger.warn(`Resource ${resourceInfo.id.name} has no yy file`);
            return;
          }
          this.registerAsset(r);
          options?.onLoadProgress?.(perAssetIncrement, `Loading assets...`);
          return r;
        }),
      );
    }
    const addedAssets = await Promise.all(resourceWaits);
    options?.onLoadProgress?.(1, `Loaded ${this.assets.size} resources`);
    logger.log(`Loaded ${this.assets.size} resources in ${Date.now() - t}ms`);
    return addedAssets.filter((x) => x) as Asset[];
  }

  protected async loadHelpLinks(): Promise<void> {
    // Need the path to the IDE folder. Can probably get by with the default
    // installation location...
    await this.nativeWaiter;
    const file = await Native.findHelpLinksFile(this.ideVersion);
    const content = await file?.read({ fallback: {} });
    this.helpLinks = new Proxy(content || ({} as { [key: string]: string }), {
      get: (target, key) => {
        const baseUrl = `https://beta-manual.yoyogames.com/#t=`;
        if (typeof key === 'string' && key in target) {
          return `${baseUrl}${encodeURIComponent(target[key])}.htm`;
        } else if (typeof key === 'string') {
          return `${baseUrl}Content.htm&rhsearch=${encodeURIComponent(
            key,
          )}&ux=${encodeURIComponent(key)}`;
        }
        return `${baseUrl}Content.htm`;
      },
    });
  }

  @sequential
  async reloadConfig() {
    const load = async () => {
      const previous = this.config?.runtimeVersion;
      this.config = await this.stitchConfig.read({ fallback: {} });
      if (this.native && previous !== this.config.runtimeVersion)
        await this.loadGmlSpec();
      return this.config;
    };
    // Initialization has no native graph yet. Later changes are semantic inputs.
    return this.native ? this.withResourceUpdate(load) : load();
  }

  @sequential
  async getWindowsName(): Promise<string | undefined> {
    const windowOptionsFile = this.dir.join(
      'options/windows/options_windows.yy',
    );
    if (!(await windowOptionsFile.exists())) {
      return;
    }
    const content = (await Yy.read(windowOptionsFile.absolute)) as {
      option_windows_display_name?: string;
    };
    return content.option_windows_display_name;
  }

  /**
   * Load the GML spec for the project's runtime version, falling
   * back on the included spec if necessary.
   */
  protected async loadGmlSpec(): Promise<void> {
    const t = Date.now();

    const nativeSelf = new Type('Struct').named('global') as StructType;
    const nativeTypes = new Map<string, Type>();
    if (!this.self) {
      this.self = new Type('Struct').named('global') as StructType;
      this.symbol = new Signifier(this.self, 'global', this.self);
      this.symbol.global = true;
      this.symbol.writable = false;
      this.symbol.def = {};
    }

    let runtimeVersion: string | undefined;
    // Check for a stitch config file that specifies the runtime version.
    // If it exists, use that version. It's likely that it is correct, and this
    // way we don't have to download the releases summary.
    if (this.config.runtimeVersion) {
      logger.info('Found stitch config');
      runtimeVersion = this.config.runtimeVersion;
    }
    await this.yypWaiter; // To ensure that `this.ideVersion` exists
    const selection = { ideVersion: this.ideVersion, runtimeVersion };
    const specFiles = await Native.listSpecFiles(selection);
    this.native = await Native.from(specFiles, nativeSelf, nativeTypes);
    this.languageProfile = new LanguageProfile({
      ...selection,
      specSources: this.native.getSpecSources(),
    });
    this.analysis.captureNative();
    for (const asset of this.assets.values()) asset.refreshNativeVariables();
    const diagnostics: Diagnostic[] = [];
    const location = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    };
    if (this.languageProfile.versionSource === 'unknown')
      diagnostics.push(
        new Diagnostic(
          'The target GameMaker version is unknown. Version-specific syntax and script semantics cannot be verified.',
          location,
          'warning',
        ),
      );
    if (this.languageProfile.nativeDegraded)
      diagnostics.push(
        new Diagnostic(
          'Native completion uses the bundled GML specification because the selected runtime specification is unavailable. API availability may differ from the target runtime.',
          location,
          'warning',
        ),
      );
    this.setResourceDiagnostics(this.yypPath.absolute, 'native', diagnostics);
    logger.log(`Loaded GML spec in ${Date.now() - t}ms`);
  }

  /**
   * Call to reload the project's yyp file (e.g. because it has changed
   * on disk) and add/remove any resources.
   */
  async reloadYyp(): Promise<void> {
    return this.withResourceUpdate(async () => {
      assert(this.yypPath, 'Cannot reload YYP without a path');
      const oldIde = this.yyp.MetaData.IDEVersion;
      const next = Yy.parse(
        await this.readDocumentText(this.yypPath),
        'project',
      );
      const nextPaths = new Set(
        next.resources.map((resource) => resource.id.path),
      );
      for (const previous of this.yyp.resources)
        if (!nextPaths.has(previous.id.path))
          this.clearResourceDiagnostics(
            this.dir.join(previous.id.path).absolute,
          );
      this.yyp = next;
      if (
        this.selectedAnalysisConfiguration &&
        !this.configs.includes(this.selectedAnalysisConfiguration)
      )
        this.selectedAnalysisConfiguration = undefined;
      const wanted = new Map(
        next.resources.map((resource) => [
          resource.id.name.toLocaleLowerCase(),
          resource,
        ]),
      );
      for (const [name, asset] of this.assets) {
        const resource = wanted.get(name);
        if (
          !resource ||
          resource.id.path !== asset.resource.id.path ||
          resource.id.name !== asset.name
        ) {
          this.assets.delete(name);
          asset.retireModel();
        }
      }
      if (oldIde !== next.MetaData.IDEVersion) await this.loadGmlSpec();
      await this.loadAssets();
      for (const asset of this.assets.values()) asset.refreshParent();
    });
  }

  /**
   * @internal
   * Initialize a collection of new assets by parsing their GML */
  async initiallyParseAssetCode(assets: Asset[]): Promise<void> {
    await this.reconcileSourceOwnership();
    for (const asset of this.assets.values()) asset.refreshParent();
    for (const asset of assets) {
      for (const code of asset.gmlFiles.values()) this.analysis.register(code);
    }
    this.analysis.invalidate();
    await this.analysis.analyze();
  }

  protected async initialize(options?: ProjectOptions): Promise<void> {
    const log = options?.logger || logger;
    log.log('Initializing project...');
    if (options?.onDiagnostics) {
      this.onDiagnostics(options.onDiagnostics);
    }
    let t = Date.now();
    await this.reloadConfig();
    assert(this.yypPath, 'Cannot initialize without a path');
    this.yypWaiter = Yy.read(this.yypPath.absolute, 'project').then((yyp) => {
      this.yyp = yyp;
      options?.onLoadProgress?.(5, 'Loaded project file');
      log.log('Loaded yyp file!');
    });
    this.nativeWaiter = this.loadGmlSpec().then(() => {
      options?.onLoadProgress?.(5, 'Loaded GML spec');
    });
    log.log('Loading asset files...');
    await Promise.all([
      this.nativeWaiter,
      this.yypWaiter,
      this.loadHelpLinks(),
    ]);

    const assets = await this.loadAssets(options);
    log.log(
      'Resources',
      this.assets.size,
      'loaded files in',
      Date.now() - t,
      'ms',
    );

    t = Date.now();
    // Discover all globals
    // Sort assets by type, with objects 2nd to last and scripts last
    // to minimize the number of things that need to be updated after
    // loading.
    options?.onLoadProgress?.(1, 'Parsing resource code...');

    await this.initiallyParseAssetCode(assets);
  }

  /**
   * Create a new project instance and initialize it.
   */
  static async initialize(
    yypPath: string,
    options?: ProjectOptions,
  ): Promise<Project> {
    let path = pathy(yypPath);
    if (await path.isDirectory()) {
      const children = await path.listChildren();
      path = children.find((p) => p.hasExtension('yyp'))!;
      ok(path, 'No yyp file found in project directory');
    }
    await path.exists({ assert: true });
    const project = new Project(path, options);
    try {
      await project.initialize(options);
      return project;
    } catch (error) {
      project.dispose();
      throw error;
    }
  }

  static readonly fallbackGmlSpecPath = pathy(import.meta.url).resolveTo(
    '../../assets/GmlSpec.xml',
  );
}
