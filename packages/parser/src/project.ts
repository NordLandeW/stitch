import { pathy, Pathy } from '@bscotch/pathy';
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
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';
import {
  importAssets,
  planAssetImport,
  type ModuleImportPlan,
} from './modules.js';
export type { ModuleImportPlan } from './modules.js';
import { ImportModuleOptions } from './modules.types.js';
import { Asset, isAssetOfKind } from './project.asset.js';
import { Code } from './project.code.js';
import { Diagnostic } from './project.diagnostics.js';
import { Native } from './project.native.js';
import { ProjectMacros } from './project.macros.js';
import { createRenameEdits, type RenameEdit } from './project.rename.js';
import { semanticReaders } from './project.dependencies.js';
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

export interface ResourceRenamePlan {
  from: string;
  to: string;
  resourceState: string;
  sources: { path: string; text: string }[];
  edits: { path: string; start: number; end: number; text: string }[];
}
export interface ResourceEditBatch {
  texts: { path: string; before: string; after: string }[];
  /** Ordered after text changes; paths after an earlier move use its destination. */
  moves: { from: string; to: string }[];
}
export interface ResourceRenameOptions {
  plan: ResourceRenamePlan;
  /** Final editor-side validation only; all writes use the common disk transaction. */
  validate?(batch: ResourceEditBatch): Promise<boolean>;
}

export interface ProjectOptions {
  /** Resource inventory and writes only; language analysis remains in its owner. */
  analysis?: 'full' | 'resources';
  /** Already selected spec files, avoiding duplicate discovery in a worker. */
  nativeSpecFiles?: string[];
  /** Load documentation links for presentation; language-only owners can omit them. */
  documentation?: boolean;
  /** Active GameMaker configuration; omitted uses the build's first-child/default selection. */
  configuration?: string;
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
  settings?: {
    /**
     * Symbols starting with these prefixes that are not declared
     * in the coded will be treated as global symbols. This is
     * useful for ensuring globals created by extensions will not
     * show up as being undeclared.
     */
    autoDeclareGlobalsPrefixes?: string[];
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
  readonly macros = new ProjectMacros(this);
  private readonly sourceUpdates = new Set<Promise<unknown>>();
  private resourceOperations: Promise<void> = Promise.resolve();

  private serializeResourceOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.resourceOperations;
    const result = this.withSourceUpdate(() => prior.then(operation));
    this.resourceOperations = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  get analysisEnabled() {
    return this.options?.analysis !== 'resources';
  }
  nativeSpecFiles: string[] = [];

  onResourceChange(callback: (path: string) => void): () => void {
    this.emitter.on('resource-change', callback);
    return () => this.emitter.off('resource-change', callback);
  }

  /** A completed host resource write invalidates its independent language owner. */
  resourceChanged(path: string) {
    this.emitter.emit('resource-change', path);
  }

  /** Keep editor queries outside async resource reads and physical rename writes. */
  async withSourceUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const update = Promise.resolve().then(operation);
    this.sourceUpdates.add(update);
    try {
      return await update;
    } finally {
      this.sourceUpdates.delete(update);
    }
  }

  get sourcesCurrent(): boolean {
    return this.sourceUpdates.size === 0;
  }

  async whenSourcesCurrent(): Promise<void> {
    while (this.sourceUpdates.size) await Promise.all([...this.sourceUpdates]);
  }

  get analysisConfiguration(): string {
    return this.macros.configuration;
  }

  setAnalysisConfiguration(configuration?: string) {
    this.macros.configure(configuration);
    if (this.analysisEnabled) this.macros.flush();
  }
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
   * The type of the 'global' struct, which contains all globalvars
   * and globally defined functions. */
  self!: StructType;
  /**
   * The `global` symbol, which has type `self`. */
  symbol!: Signifier;
  /**
   * Non-native global types, which can be referenced in JSDocs
   * and in a symbol's types. */
  readonly types = new Map<string, Type>();

  protected emitter = new EventEmitter();
  /** Code that needs to be reprocessed, for one reason or another. */
  protected dirtyFiles = new Set<Code>();
  private readonly semanticDirtyFiles = new Set<Code>();
  private refreshingSemanticFiles = false;

  /** Semantic invalidation follows definitions, unlike diagnostic-only dirtiness. */
  queueSemanticFileUpdate(code: Code) {
    if (!code.isRetired) this.semanticDirtyFiles.add(code);
  }

  completeSemanticFileUpdate(code: Code) {
    this.semanticDirtyFiles.delete(code);
  }

  /** Withdraw an edited region together, so cycles cannot retain obsolete facts. */
  prepareSemanticFiles(changed: Iterable<Code>): Code[] {
    const affected = new Set(changed);
    for (const code of affected)
      for (const reader of semanticReaders(code)) affected.add(reader);
    for (const code of affected) code.invalidateSemanticInference();
    return [...affected].filter((code) => !code.isRetired);
  }

  refreshSemanticFiles() {
    if (this.refreshingSemanticFiles || !this.semanticDirtyFiles.size) return;
    this.refreshingSemanticFiles = true;
    const visits = new Map<Code, number>();
    const declarations = new Set<unknown>();
    try {
      while (this.semanticDirtyFiles.size) {
        const code = this.semanticDirtyFiles.values().next().value!;
        this.semanticDirtyFiles.delete(code);
        if (code.isRetired) continue;
        if (!visits.has(code)) {
          for (const ref of code.refs)
            if (ref.item.def?.file === code) declarations.add(ref.item);
        }
        const count = (visits.get(code) || 0) + 1;
        visits.set(code, count);
        // A finite symbol path may revisit the same file many times. Bound
        // unsuccessful convergence by declarations, not by source-file count.
        if (count > declarations.size + 1) {
          this.semanticDirtyFiles.add(code);
          throw new Error(
            `Semantic analysis did not stabilize at ${code.path.absolute}`,
          );
        }
        code.updateGlobals();
        code.updateAllSymbols();
        this.dirtyFiles.add(code);
      }
    } finally {
      this.refreshingSemanticFiles = false;
    }
  }

  protected constructor(
    readonly yypPath: Pathy<any>,
    readonly options?: ProjectOptions,
  ) {}

  /**
   * @internal For tracking changed code files that will need to be re-parsed.
   */
  queueDirtyFileUpdate(code: Code): void {
    this.dirtyFiles.add(code);
  }

  /**
   * @internal Drain the queue of dirty files, updating their diagnostics
   */
  drainDirtyFileUpdateQueue() {
    if (!this.analysisEnabled) return;
    this.refreshSemanticFiles();
    for (const code of this.dirtyFiles) {
      code.updateDiagnostics();
      // await code.reload(code.content);
    }
    this.dirtyFiles.clear();
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
    // Ensure they are valid diagnostics
    for (const diagnostic of diagnostics) {
      ok(diagnostic.$tag === 'diagnostic');
      ok(diagnostic.location);
    }
    this.emitter.emit('diagnostics', {
      code: code instanceof Code ? code : undefined,
      filePath: code instanceof Code ? code.path.absolute : code,
      diagnostics,
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
    return this.withSourceUpdate(() => this.removeAssetFiles(name));
  }

  private async removeAssetFiles(name: string | undefined) {
    if (!name) return;
    name = name.toLocaleLowerCase();
    const asset = this.assets.get(name);
    if (!asset) return;
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
    const resource = this.getAsset(path);
    if (!resource) {
      return;
    }
    return resource.getGmlFile(path);
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
  async renameAsset(
    from: string,
    to: string,
    external?: ResourceRenameOptions,
  ) {
    return this.serializeResourceOperation(async () => {
      assert(
        this.analysisEnabled || external,
        'Resource-only rename requires a current language plan',
      );
      return this.renameResourceAsset(
        from,
        to,
        external || { plan: this.createAssetRenamePlan(from, to) },
      );
    });
  }

  resourceState(): string {
    return JSON.stringify([
      Yy.stringify(this.yyp, 'project'),
      [...this.assets.values()]
        .sort((a, b) => a.yyPath.absolute.localeCompare(b.yyPath.absolute))
        .map((asset) => [
          asset.yyPath.absolute,
          Yy.stringify(asset.yy, asset.assetKind, this.yyp),
        ]),
    ]);
  }

  /** Verify metadata baselines immediately before a separately planned write. */
  async validateResourceState(expected: string): Promise<boolean> {
    if (this.resourceState() !== expected) return false;
    const yyp = await Yy.read(this.yypPath.absolute, 'project');
    if (Yy.stringify(yyp, 'project') !== Yy.stringify(this.yyp, 'project'))
      return false;
    for (const asset of this.assets.values()) {
      const yy = await Yy.read(asset.yyPath.absolute, asset.assetKind);
      if (
        Yy.stringify(yy, asset.assetKind, yyp) !==
        Yy.stringify(asset.yy, asset.assetKind, yyp)
      )
        return false;
    }
    return this.resourceState() === expected;
  }

  /** Language-owner validation; only physical immutable source values leave it. */
  createAssetRenamePlan(from: string, to: string): ResourceRenamePlan {
    assert(
      this.analysisEnabled,
      'Asset rename planning requires language analysis',
    );
    const asset = this.getAssetByName(from, { assertExists: true });
    assertIsValidIdentifier(to);
    assert(!this.getAssetByName(to), `An asset named "${to}" already exists`);
    const sources = new Map<string, string>();
    const edits = this.renameEdits(asset.signifier, to).map((edit) => {
      const source = edit.range.source;
      sources.set(source.file.path.absolute, source.file.content);
      return {
        path: source.file.path.absolute,
        start: source.start.offset,
        end: source.end.offset + 1,
        text: edit.text,
      };
    });
    return {
      from: asset.name,
      to,
      resourceState: this.resourceState(),
      edits,
      sources: [...sources].map(([path, text]) => ({ path, text })),
    };
  }

  private async renameResourceAsset(
    from: string,
    to: string,
    external: ResourceRenameOptions,
  ) {
    const asset = this.getAssetByName(from, { assertExists: true }),
      plan = external.plan;
    assertIsValidIdentifier(to);
    assert(
      plan.from === asset.name && plan.to === to,
      'Asset rename plan does not match the requested operation',
    );
    assert(!this.getAssetByName(to), `An asset named "${to}" already exists`);
    assert(
      await this.validateResourceState(plan.resourceState),
      'Resource metadata changed since rename planning',
    );
    const destination = asset.dir.up().join(to);
    assert(
      !(await destination.exists()),
      'Asset rename destination already exists',
    );
    const batch: ResourceEditBatch = {
      texts: [],
      moves: [{ from: asset.dir.absolute, to: destination.absolute }],
    };
    const sourceTexts = new Map(
      plan.sources.map((source) => [source.path, source.text]),
    );
    // Full-analysis clients may own physical sources outside the resource
    // inventory. Keep those owners local; only value plans cross workers.
    const sourceFiles = new Set(
      this.analysisEnabled
        ? [...asset.signifier.refs]
            .map((reference) => reference.source.file)
            .filter((code) => sourceTexts.has(code.path.absolute))
        : [],
    );
    assert(sourceTexts.size === plan.sources.length, 'Duplicate rename source');
    for (const edit of plan.edits)
      assert(sourceTexts.has(edit.path), 'Rename edit has no source baseline');
    for (const [file, text] of sourceTexts) {
      assert(
        this.dir.isParentOf(pathy(file)) && pathy(file).hasExtension('gml'),
        'Rename source is outside project GML',
      );
      assert(
        (await readFile(file, 'utf8')) === text,
        'Rename source changed since planning; save affected files and try again',
      );
      const edits = plan.edits
        .filter((edit) => edit.path === file)
        .sort((a, b) => b.start - a.start);
      let after = text,
        boundary = text.length;
      for (const edit of edits) {
        const spelling = text.slice(edit.start, edit.end);
        assert(
          Number.isInteger(edit.start) &&
            Number.isInteger(edit.end) &&
            edit.start >= 0 &&
            edit.end <= boundary &&
            edit.end > edit.start &&
            edit.text !== spelling &&
            edit.text ===
              spelling.replace(new RegExp(`\\b${asset.name}\\b`), to),
          'Invalid or overlapping asset rename edit',
        );
        after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
        boundary = edit.start;
      }
      if (after !== text) batch.texts.push({ path: file, before: text, after });
    }
    const oldPattern = new RegExp(`\\b${asset.name}\\b`, 'gi');
    const copiedFiles = await asset.dir.listChildrenRecursively();
    for (const file of copiedFiles) {
      if (await file.isDirectory()) continue;
      const relative = file.relativeFrom(asset.dir),
        renamed = relative.replaceAll(oldPattern, to);
      if (relative !== renamed)
        batch.moves.push({
          from: destination.join(relative).absolute,
          to: destination.join(renamed).absolute,
        });
    }
    const oldId = asset.resource.id.path,
      newId = `${asset.assetKind}/${to}/${to}.yy`;
    const replaceIds = (value: any): void => {
      if (!value || typeof value !== 'object') return;
      if (
        typeof value.path === 'string' &&
        value.path.toLowerCase() === oldId.toLowerCase()
      ) {
        value.path = newId;
        if ('name' in value) value.name = to;
      }
      for (const child of Object.values(value)) replaceIds(child);
    };
    const originalYyp = Yy.parse(Yy.stringify(this.yyp, 'project'), 'project');
    const yypBefore = await readFile(this.yypPath.absolute, 'utf8');
    assert(
      Yy.stringify(Yy.parse(yypBefore), 'project') ===
        Yy.stringify(originalYyp, 'project'),
      'Project metadata changed while capturing rename inputs',
    );
    // Derive replacements from these validated disk bytes. Schema-populated YY
    // values contain FixedNumber instances: structuredClone loses their class,
    // while schema serialization can round otherwise untouched numeric fields.
    const nextYyp = Yy.parse(yypBefore) as Yyp;
    replaceIds(nextYyp);
    for (const resource of this.assets.values()) {
      const originalYy = Yy.stringify(
        resource.yy,
        resource.assetKind,
        originalYyp,
      );
      const before = await readFile(resource.yyPath.absolute, 'utf8');
      const original = Yy.parse(before);
      assert(
        Yy.stringify(original, resource.assetKind, originalYyp) === originalYy,
        'Resource metadata changed while capturing rename inputs',
      );
      const yy = Yy.parse(before) as typeof resource.yy;
      replaceIds(yy);
      if (resource === asset) {
        yy.name = to;
        if ('%Name' in yy) yy['%Name'] = to;
        if (isAssetOfKind(asset, 'sounds'))
          (yy as YySound).soundFile = (yy as YySound).soundFile.replace(
            oldPattern,
            to,
          );
        if (isAssetOfKind(asset, 'sprites')) {
          const sprite = yy as YySprite;
          if (sprite.sequence?.tracks)
            sprite.sequence.tracks = Yy.parse(
              Yy.stringify(sprite.sequence.tracks).replaceAll(oldPattern, to),
            ) as typeof sprite.sequence.tracks;
        }
      }
      if (
        isAssetOfKind(asset, 'objects') &&
        isAssetOfKind(resource, 'objects')
      ) {
        for (const event of resource.yy.eventList)
          if (event.collisionObjectId?.name === asset.name) {
            const file = resource.dir.join(`Collision_${asset.name}.gml`);
            if (await file.exists()) {
              const root = resource === asset ? destination : resource.dir;
              batch.moves.push({
                from: root.join(file.basename).absolute,
                to: root.join(`Collision_${to}.gml`).absolute,
              });
            }
          }
      }
      if (!Yy.areEqual(original, yy)) {
        batch.texts.push({
          path: resource.yyPath.absolute,
          before,
          after: Yy.stringify(yy, undefined, nextYyp),
        });
      }
    }
    batch.texts.push({
      path: this.yypPath.absolute,
      before: yypBefore,
      after: Yy.stringify(nextYyp),
    });
    const destinations = new Set<string>();
    for (const move of batch.moves) {
      const key = pathy(move.to).absolute.toLowerCase();
      assert(!destinations.has(key), 'Asset rename paths collide');
      destinations.add(key);
      const existingPath = key.startsWith(
        destination.absolute.toLowerCase() + '/',
      )
        ? asset.dir.join(pathy(move.to).relativeFrom(destination))
        : pathy(move.to);
      assert(
        !(await existingPath.exists()),
        'An asset rename target file already exists',
      );
    }
    assert(
      plan.resourceState === this.resourceState(),
      'Resource metadata changed while preparing rename',
    );
    await this.applyResourceRename(batch, sourceFiles, external.validate);
    return this.getAssetByName(to, { assertExists: true });
  }

  /** Single IO seam for ordinary replacement, moves, and their reverse operations. */
  private readonly renameResourceFile = rename;

  private async applyResourceRename(
    batch: ResourceEditBatch,
    sourceFiles: ReadonlySet<Code>,
    validate?: ResourceRenameOptions['validate'],
  ) {
    const recovery = await mkdtemp(join(tmpdir(), 'stitch-resource-rename-'));
    const id = randomUUID();
    const staged = batch.texts.map((text) => `${text.path}.stitch-${id}.tmp`);
    const writes: ResourceEditBatch['texts'] = [];
    const moves: ResourceEditBatch['moves'] = [];
    const journal = {
      project: this.yypPath.absolute,
      batch,
      status: 'prepared',
      writes: [] as string[],
      moves,
    };
    const record = () =>
      writeFile(
        join(recovery, 'recovery.json'),
        JSON.stringify(journal, null, 2),
        'utf8',
      );
    const reload = async () => {
      await this.reloadYyp();
      for (const asset of this.assets.values()) await asset.reload();
      // Publish actual disk contents after both success and rollback. Collect
      // every surviving physical source before expanding its macro consumers.
      try {
        for (const code of sourceFiles) {
          if (code.isRetired) continue;
          if (this.getAssetByName(code.asset.name) !== code.asset) {
            code.retire();
            continue;
          }
          await code.parse();
        }
      } finally {
        if (sourceFiles.size) this.macros.flush();
      }
    };
    const currentPath = (original: string) => {
      let file = pathy(original);
      for (const move of moves) {
        const from = pathy(move.from);
        if (file.absolute.toLowerCase() === from.absolute.toLowerCase())
          file = pathy(move.to);
        else if (from.isParentOf(file))
          file = pathy(move.to).join(file.relativeFrom(from));
      }
      return file.absolute;
    };
    try {
      // Durable before/after baselines precede any project mutation. Stage beside
      // each target so replacement does not depend on cross-volume rename.
      await record();
      for (const [index, text] of batch.texts.entries())
        await writeFile(staged[index], text.after, {
          encoding: 'utf8',
          flag: 'wx',
        });
      for (const text of batch.texts)
        assert(
          (await readFile(text.path, 'utf8')) === text.before,
          `Rename input changed: ${text.path}`,
        );
      assert(
        !validate || (await validate(batch)),
        'Asset rename inputs changed; save affected files and try again',
      );
      journal.status = 'applying';
      await record();
      for (const [index, text] of batch.texts.entries()) {
        assert(
          (await readFile(text.path, 'utf8')) === text.before,
          `Rename input changed: ${text.path}`,
        );
        await this.renameResourceFile(staged[index], text.path);
        writes.push(text);
        journal.writes.push(text.path);
        await record();
      }
      for (const move of batch.moves) {
        assert(
          !(await pathy(move.to).exists()),
          `Rename destination appeared: ${move.to}`,
        );
        await this.renameResourceFile(move.from, move.to);
        moves.push(move);
        await record();
      }
      await reload();
      journal.status = 'complete';
      await record().catch((error) =>
        logger.warn(
          `Could not finalize rename recovery record at ${recovery}`,
          error,
        ),
      );
      await rm(recovery, { recursive: true, force: true }).catch((error) =>
        logger.warn(
          `Rename succeeded; recovery cleanup remains at ${recovery}`,
          error,
        ),
      );
    } catch (error) {
      const failures: unknown[] = [];
      // Stop reversing dependent moves at the first failure. Remaining moves
      // then still describe the actual path mapping for text restoration.
      while (moves.length) {
        const move = moves.at(-1)!;
        try {
          assert(
            !(await pathy(move.from).exists()),
            `Rollback destination is occupied: ${move.from}`,
          );
          await this.renameResourceFile(move.to, move.from);
          moves.pop();
        } catch (failure) {
          failures.push(failure);
          break;
        }
      }
      for (const text of [...writes].reverse()) {
        const file = currentPath(text.path),
          temporary = `${file}.stitch-${id}.restore`;
        try {
          const current = await readFile(file, 'utf8');
          if (current === text.before) continue;
          assert(
            current === text.after,
            `Rollback preserved a subsequent external edit: ${file}`,
          );
          await writeFile(temporary, text.before, {
            encoding: 'utf8',
            flag: 'wx',
          });
          await this.renameResourceFile(temporary, file);
        } catch (failure) {
          failures.push(failure);
        } finally {
          await rm(temporary, { force: true }).catch((failure) =>
            logger.warn(failure),
          );
        }
      }
      await reload().catch((failure) => failures.push(failure));
      journal.status = failures.length ? 'rollback-incomplete' : 'rolled-back';
      await record().catch((failure) => failures.push(failure));
      if (!failures.length)
        await rm(recovery, { recursive: true, force: true }).catch((failure) =>
          failures.push(failure),
        );
      const state = failures.length
        ? `Recovery is incomplete. Recovery data: ${recovery}`
        : 'Original files were restored.';
      throw new AggregateError(
        [error, ...failures],
        `Asset rename failed. ${state}`,
      );
    } finally {
      for (const file of staged)
        await rm(file, { force: true }).catch((error) => logger.warn(error));
      this.resourceChanged(this.yypPath.absolute);
    }
  }

  renameEdits(signifier: Signifier, newName: string) {
    return createRenameEdits(signifier, newName);
  }

  async renameSignifier(signifier: Signifier, newName: string) {
    await this.applyRenameEdits(this.renameEdits(signifier, newName));
  }

  private async applyRenameEdits(edits: readonly RenameEdit[]) {
    const grouped = new Map<Code, RenameEdit[]>();
    for (const edit of edits) {
      let fileEdits = grouped.get(edit.range.file);
      if (!fileEdits) grouped.set(edit.range.file, (fileEdits = []));
      fileEdits.push(edit);
    }
    const updates = [...grouped].map(
      ([code, fileEdits]) => [code, code.renamedContent(fileEdits)] as const,
    );
    await this.withSourceUpdate(async () => {
      // A failed write must not release the gate while a sibling still writes.
      // Successful files still need publication; filesystem writes are not atomic
      // across files, and their actual outcome must remain visible after failure.
      const results = await Promise.allSettled(
        updates.map(([code, text]) => code.path.write(text)),
      );
      const errors: unknown[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') errors.push(result.reason);
        else await updates[index][0].parse(updates[index][1]);
      }
      this.macros.flush();
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(
          errors,
          'Some renamed source files could not be written',
        );
    });
  }

  async import(
    fromProject: Project | string,
    options: ImportModuleOptions = {},
    plan?: ModuleImportPlan,
    readSource?: (path: string) => Promise<string>,
  ) {
    assert(
      this.analysisEnabled || plan,
      'Resource-only import requires a current language dependency plan',
    );
    if (typeof fromProject === 'string') {
      fromProject = await Project.initialize(fromProject, {
        analysis: this.options?.analysis,
      });
    }
    const source = fromProject;
    return this.serializeResourceOperation(() =>
      importAssets(source, this, options, plan, readSource),
    );
  }

  planImport(
    source: Project,
    options: ImportModuleOptions = {},
  ): ModuleImportPlan {
    return planAssetImport(source, this, options);
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
    await this.withSourceUpdate(async () => {
      await Yy.write(this.yypPath.absolute, this.yyp, 'project');
      this.resourceChanged(this.yypPath.absolute);
    });
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

    // Load AudioGroup assets
    for (const audioGroup of this.analysisEnabled ? this.yyp.AudioGroups : []) {
      if (!this.self.getMember(audioGroup.name)) {
        const signifier = new Signifier(
          this.self,
          audioGroup.name,
          new Type('Asset.GMAudioGroup'),
        );
        signifier.global = true;
        signifier.writable = false;
        this.self.addMember(signifier);
      }
    }

    // We'll say that resources take 80% of loading,
    // and distribute that across the number of resources.
    const perAssetIncrement = this.yyp.resources.length / 80;
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
    this.config = await this.stitchConfig.read({ fallback: {} });
    return this.config;
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
    await this.resolveNativeSpecFiles();
    if (!this.analysisEnabled) return;
    this.self = new Type('Struct').named('global') as StructType;
    this.symbol = new Signifier(this.self, 'global', this.self);
    this.symbol.global = true;
    this.symbol.writable = false;
    this.symbol.def = {};

    this.native = await Native.from(
      this.nativeSpecFiles.map((file) => pathy(file)),
      this.self,
      this.types,
    );
    logger.log(`Loaded GML spec in ${Date.now() - t}ms`);
  }

  /** Select native inputs without parsing XML or creating any language types. */
  async resolveNativeSpecFiles(): Promise<string[]> {
    await this.yypWaiter;
    if (this.options?.nativeSpecFiles) {
      assert(
        this.options.nativeSpecFiles.length,
        'At least one native spec file is required',
      );
      this.nativeSpecFiles = [...this.options.nativeSpecFiles];
    } else {
      this.nativeSpecFiles = (
        await Native.listSpecFiles({
          ideVersion: this.ideVersion,
          runtimeVersion: this.config.runtimeVersion,
        })
      ).map((file) => file.absolute);
    }
    return this.nativeSpecFiles;
  }

  /**
   * Call to reload the project's yyp file (e.g. because it has changed
   * on disk) and add/remove any resources.
   */
  reloadYyp() {
    return this.withSourceUpdate(() => this.reloadProjectSources());
  }

  private async reloadProjectSources() {
    assert(this.yypPath, 'Cannot reload YYP without a path');
    this.yyp = await Yy.read(this.yypPath.absolute, 'project');
    const active = new Map(
      this.yyp.resources.map((resource) => [
        resource.id.name.toLocaleLowerCase(),
        this.dir.join(resource.id.path).absolute.toLocaleLowerCase(),
      ]),
    );
    for (const [name, asset] of this.assets) {
      // Compare the loaded path, not resource metadata that a caller may have edited.
      if (active.get(name) === asset.yyPath.absolute.toLocaleLowerCase())
        continue;
      asset.retire();
      this.assets.delete(name);
    }
    this.macros.configurationTreeChanged();

    // Add new assets
    const newAssets = await this.loadAssets();
    await this.initiallyParseAssetCode(newAssets);

    // Try to keep anything that got touched *clean*
    this.drainDirtyFileUpdateQueue();
  }

  /**
   * @internal
   * Initialize a collection of new assets by parsing their GML */
  initiallyParseAssetCode(assets: Asset[]) {
    if (!this.analysisEnabled) return;
    const codes = assets.flatMap((asset) => asset.gmlFilesArray);
    const pending = this.macros.preparePending();
    // Metadata-only resources can invalidate readers without owning any GML.
    const affected = this.prepareSemanticFiles(
      new Set([...codes, ...pending, ...this.semanticDirtyFiles]),
    );
    for (const code of affected) this.queueSemanticFileUpdate(code);
    // Do scripts before objects
    assets = [...assets.values()].sort((a, b) => {
      if (a.assetKind === b.assetKind) {
        return a.name.localeCompare(b.name);
      }
      if (a.assetKind === 'scripts') {
        return -1;
      }
      if (b.assetKind === 'scripts') {
        return 1;
      }
      if (a.assetKind === 'objects') {
        return -1;
      }
      if (b.assetKind === 'objects') {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    logger.info('Discovering globals...');
    for (const asset of assets) {
      asset.updateGlobals(true);
    }
    // Discover all symbols and their references
    logger.info('Discovering symbols...');
    for (const asset of assets) {
      asset.updateAllSymbols(true);
    }
    // Second pass
    // TODO: Find a better way than brute-forcing to resolve cross-file references
    for (const pass of [1]) {
      logger.info(`Re-processing pass ${pass}...`);
      // const reloads: Promise<any>[] = [];
      for (const asset of assets) {
        asset.updateGlobals();
        asset.updateAllSymbols();
        //   for (const file of asset.gmlFilesArray) {
        //     reloads.push(file.reload(file.content));
        //   }
      }
      // await Promise.all(reloads);
    }

    // But for now, that's what we'll do!
    logger.info('Updating diagnostics...');
    for (const asset of assets) {
      asset.updateDiagnostics();
    }
    this.macros.complete(codes);
    this.macros.flush();
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
    this.nativeWaiter = this.loadGmlSpec();
    void this.nativeWaiter.then(
      () => {
        options?.onLoadProgress?.(5, 'Loaded GML spec');
      },
      () => {},
    );
    log.log('Loading asset files...');
    await Promise.all([
      this.nativeWaiter,
      this.yypWaiter,
      options?.documentation === false ? undefined : this.loadHelpLinks(),
    ]);
    this.macros.configure(options?.configuration);

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
    await project.initialize(options);
    return project;
  }

  static readonly fallbackGmlSpecPath = pathy(import.meta.url).resolveTo(
    '../../assets/GmlSpec.xml',
  );
}
