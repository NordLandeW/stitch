import { Pathy, pathy } from '@bscotch/pathy';
import { readdir } from 'node:fs/promises';
import { pathExists } from './project.edits.js';
import { sequential } from '@bscotch/utility';
import {
  Yy,
  YyData,
  YyExtension,
  YyObject,
  YyResourceType,
  YyRoom,
  YyRoomInstanceLayer,
  YySound,
  YySprite,
  YypResource,
  yyObjectEventSchema,
  yyRoomInstanceLayerSchema,
  yyRoomInstanceSchema,
  yySchemas,
  yySpriteSchema,
} from '@bscotch/yy';
import type { ObjectEvent, ObjectEventName } from './lib.objects.js';
import { logger } from './logger.js';
import { Code } from './project.code.js';
import { Diagnostic } from './project.diagnostics.js';
import { Project } from './project.js';
import { Signifier } from './signifiers.js';
import { StructType, Type } from './types.js';
import { assert, getPngSize, groupPathToPosix, ok } from './util.js';

export function isAssetOfKind<T extends YyResourceType>(
  asset: any,
  kind: T,
): asset is Asset<T> {
  return (
    asset !== null && typeof asset === 'object' && asset.assetKind === kind
  );
}

export function assertIsAssetOfKind<T extends YyResourceType>(
  asset: any,
  kind: T,
): asserts asset is Asset<T> {
  assert(isAssetOfKind(asset, kind), `Expected asset to be of kind ${kind}`);
}

export class Asset<T extends YyResourceType = YyResourceType> {
  readonly $tag = 'Asset';
  readonly assetKind: T;
  readonly gmlFiles: Map<string, Code> = new Map();
  yy!: YyData<T>;
  yyPath: Pathy<YyData<T>>;
  readonly signifier: Signifier;
  /** For objects, their instance type. */
  instanceType: Type<'Id.Instance'> | undefined;
  assetType: Type<Asset['assetTypeKind']>;
  variables: StructType | undefined;
  nativeVariables: StructType | undefined;
  readonly extensionSymbols = new Map<string, Signifier>();
  readonly extensionTypes = new Map<string, Type>();

  /** For objects, their parent */
  protected _parent: Asset<'objects'> | undefined = undefined;

  protected initalized = {
    globals: false,
    locals: false,
  };

  protected constructor(
    readonly project: Project,
    readonly resource: YypResource,
    yyPath: Pathy,
  ) {
    assert(yyPath, 'Must provide a YY path');
    this.assetKind = resource.id.path.split(/[/\\]/)[0] as T;
    this.yyPath = yyPath.withValidator(yySchemas[this.assetKind]) as Pathy<
      YyData<T>
    >;

    // Create the symbol
    this.signifier = new Signifier(this.project.self, this.name);
    this.signifier.def = {};
    this.signifier.global = true;
    this.signifier.asset = true;

    // Create the Asset.<> type
    this.assetType = new Type(this.assetTypeKind).named(this.name);
    this.signifier.setType(this.assetType);
    this.assetType.signifier = this.signifier;

    // If this is an object, also create the instance type
    if (this.assetKind === 'objects') {
      this.refreshNativeVariables();

      this.variables = new Type('Struct');
      this.variables.extends = this.nativeVariables;
      this.variables.signifier = this.signifier;

      // It will be used as the parent for the Instance/Asset types
      this.assetType.extends = this.variables;

      this.instanceType = new Type('Id.Instance').named(this.name);
      this.instanceType.extends = this.variables;
      this.instanceType.signifier = this.signifier;
      const id = new Signifier(this.variables, 'id', this.instanceType);
      id.instance = true;
      id.native = 'Base';
      id.writable = false;
      id.override = true; // We are guaranteeing that we're using

      this.variables.addMember(id)!;
    }
  }

  /** Refresh schema-owned instance members without retaining user contributions. */
  refreshNativeVariables(): void {
    if (!this.isObject) return;
    const native = new Type('Struct');
    for (const member of this.project.native.objectInstanceBase.listMembers()) {
      if (member.name === 'id') continue;
      const copy = member.copy();
      copy.override = true;
      native.addMember(copy);
    }
    this.nativeVariables = native;
  }

  get typeName() {
    return `${this.assetType.kind}.${this.name}`;
  }

  get instanceTypeName() {
    return `Id.Instance.${this.name}`;
  }

  @sequential
  async saveYy() {
    assert(this.yyPath, 'Cannot save YY without a path');
    await Yy.write(
      this.yyPath.absolute,
      this.yy,
      this.assetKind,
      this.project.yyp,
    );
  }

  get isScript() {
    return this.assetKind === 'scripts';
  }

  get isObject() {
    return this.assetKind === 'objects';
  }

  get isSound() {
    return this.assetKind === 'sounds';
  }

  get isRoom() {
    return this.assetKind === 'rooms';
  }

  get isSprite() {
    return this.assetKind === 'sprites';
  }

  get isSpineSprite() {
    if (this.assetKind !== 'sprites') {
      return false;
    }
    const yy = this.yy as YySprite;
    return yy.type === 2;
  }

  get soundFile(): Pathy<Buffer> {
    assert(
      isAssetOfKind(this, 'sounds'),
      'Can only get sound files from sound assets',
    );
    const yy = this.yy as YySound;
    return this.dir.join(yy.soundFile);
  }

  get sprite(): Asset<'sprites'> | undefined {
    assert(isAssetOfKind(this, 'objects'), 'Can only get sprites from objects');
    const yy = this.yy as YyObject;
    const spriteName = yy.spriteId?.name;
    const sprite = spriteName
      ? this.project.getAssetByName(spriteName)
      : undefined;
    if (spriteName && !sprite) {
      logger.warn(`Sprite ${spriteName} has no asset`);
    }
    return sprite as Asset<'sprites'> | undefined;
  }
  set sprite(sprite: Asset<'sprites'> | undefined) {
    assert(isAssetOfKind(this, 'objects'), 'Can only set sprites on objects');
    const yy = this.yy as YyObject;
    yy.spriteId = sprite ? sprite.resource.id : null;
    // Fire off async to avoid blocking
    void this.saveYy().catch((error) => logger.error(error));
  }

  get children(): Asset<'objects'>[] {
    assert(isAssetOfKind(this, 'objects'), 'Can only get children of objects');
    const children: Asset<'objects'>[] = [];
    for (const asset of this.project.assets.values()) {
      if (isAssetOfKind(asset, 'objects') && asset.parent === this) {
        children.push(asset);
      }
    }
    return children;
  }

  get parent() {
    return this._parent;
  }
  set parent(parent: Asset<'objects'> | undefined) {
    const oldParent = this._parent;
    if (oldParent === parent) {
      // No change!
      return;
    }
    if (parent === this || parent?.parents.includes(this as Asset<'objects'>))
      throw new Error('Object inheritance cannot contain a cycle');
    this._parent = parent;
    this.project.analysis.invalidate();
    // Do we need to change the yy file?
    const yy = this.yy as YyObject;
    const parentFromYy = this.project.getAssetByName(yy.parentObjectId?.name);
    if (parentFromYy !== parent) {
      // Then we need to update the yy. Just fire it off async for now so
      // that this function can remain synchronous.
      if (!parent) {
        yy.parentObjectId = null;
      } else {
        yy.parentObjectId = parent.resource.id;
      }
      void this.saveYy()
        .then(() => this.project.analysis.analyze())
        .catch((error) => logger.error(error));
    }
  }

  /**
   * Get the entire parent heirarchy, with immediate first
   * and most-distant last
   */
  get parents(): Asset<'objects'>[] {
    const parents: Asset<'objects'>[] = [];
    const seen = new Set<Asset>([this]);
    for (let parent = this.parent; parent; parent = parent.parent) {
      if (seen.has(parent))
        throw new Error('Object inheritance contains a cycle');
      seen.add(parent);
      parents.push(parent);
    }
    return parents;
  }

  /**
   * Get the first GML file belonging to this resource.
   * For scripts, this is the *only* GML file.*/
  get gmlFile() {
    return this.gmlFilesArray[0];
  }

  get gmlFilesArray() {
    return [...this.gmlFiles.values()].sort((a, b) => {
      if (a.name === 'Create_0') {
        return -1;
      } else if (b.name === 'Create_0') {
        return 1;
      }
      return 0;
    });
  }

  getEventByName(name: ObjectEventName): Code | undefined {
    assert(this.isObject, 'Can only get events for objects');
    return this.gmlFilesArray.find((gml) => gml.name === name);
  }

  get shaderPaths(): T extends 'shaders'
    ? { [K in 'vertex' | 'fragment']: Pathy<string> }
    : undefined {
    if (this.assetKind !== 'shaders') {
      return undefined as any;
    }
    return {
      vertex: this.yyPath.changeExtension('vsh'),
      fragment: this.yyPath.changeExtension('fsh'),
    } as any;
  }

  get roomInstances(): { instanceId: string; object: Asset<'objects'> }[] {
    assertIsAssetOfKind(this, 'rooms');
    const instances = new Map<string, Asset<'objects'>>();
    // Loop through each instance layer's instances to get IDs and objects
    const yy = this.yy as YyRoom;
    for (const layer of (yy as YyRoom).layers) {
      if (layer.resourceType !== 'GMRInstanceLayer') {
        continue;
      }
      for (const instance of (layer as YyRoomInstanceLayer).instances || []) {
        const obj = this.project.getAssetByName(instance.objectId.name);
        if (isAssetOfKind(obj, 'objects')) {
          instances.set(instance.name, obj);
        }
      }
    }
    // Loop through the instance order to get everything in the expected order
    return yy.instanceCreationOrder
      .map((x) => ({
        instanceId: x.name,
        object: instances.get(x.name)!,
      }))
      .filter((x) => !!x.object);
  }

  get frameIds(): string[] {
    if (this.assetKind !== 'sprites') {
      return [];
    }
    const yy = this.yy as YySprite;
    return yy.frames.map((f) => f.name);
  }

  get framePaths(): Pathy<Buffer>[] {
    const paths: Pathy<Buffer>[] = [];
    if (this.assetKind !== 'sprites') {
      return paths;
    }
    const yy = this.yy as YySprite;
    for (const frame of yy.frames || []) {
      paths.push(this.dir.join<Buffer>(`${frame.name}.png`));
    }
    return paths;
  }

  get spinePaths() {
    if (!this.isSpineSprite) {
      return undefined;
    }
    const yy = this.yy as YySprite;
    const frameId = yy.frames?.[0].name;
    if (!frameId) {
      return undefined;
    }
    return {
      json: this.dir.join(`${frameId}.json`),
      atlas: this.dir.join(`${frameId}.atlas`),
    };
  }

  /**
   * During an Object asset rename, we need to ensure that all references to the
   * old name are updated to the new name. This includes the object's name in rooms.
   */
  @sequential
  async renameRoomInstanceObjects(
    oldObjectName: string,
    newObjectName: string,
  ) {
    assert(this.isRoom, 'Can only rename object instances in rooms'); // Iterate through each instance layer and remove any instances with the given ID
    const yy = this.yy as YyRoom;
    let didUpdate = false;
    for (const layer of yy.layers) {
      if (layer.resourceType !== 'GMRInstanceLayer') {
        continue;
      }
      layer.instances.forEach((instance) => {
        if (
          instance.objectId.name.toLowerCase() === oldObjectName.toLowerCase()
        ) {
          instance.objectId.name = newObjectName;
          instance.objectId.path = `objects/${newObjectName}/${newObjectName}.yy`;
          didUpdate = true;
        }
      });
    }
    if (didUpdate) {
      await this.saveYy();
    }
  }

  @sequential
  async removeRoomInstance(instanceId: string) {
    assert(this.isRoom, 'Can only add object instances to rooms');
    const yy = this.yy as YyRoom;
    // Iterate through each instance layer and remove any instances with the given ID
    for (const layer of yy.layers) {
      if (layer.resourceType !== 'GMRInstanceLayer') {
        continue;
      }
      layer.instances = (layer.instances || []).filter(
        (x) => x.name !== instanceId,
      );
    }
    // Remove the instance from the creation order
    yy.instanceCreationOrder = (yy.instanceCreationOrder || []).filter(
      (x) => x.name !== instanceId,
    );
    await this.saveYy();
  }

  @sequential
  async reorganizeRoomInstances(instanceIds: string[]) {
    assert(this.isRoom, 'Can only add object instances to rooms');
    const instanceIdsSet = new Set(instanceIds);
    assert(
      instanceIds.length === instanceIdsSet.size,
      'Cannot have duplicate instance IDs',
    );
    const yy = this.yy as YyRoom;
    const currentIds = new Set(yy.instanceCreationOrder.map((x) => x.name));
    // Ensure that the new order includes all existing instances
    assert(
      instanceIdsSet.size === currentIds.size &&
        [...instanceIdsSet].every((x) => currentIds.has(x)),
      'New order must include all existing instances',
    );
    yy.instanceCreationOrder = instanceIds.map((name) => ({
      name,
      path: `rooms/${this.name}/${this.name}.yy`,
    }));
    await this.saveYy();
  }

  @sequential
  async addRoomInstance(obj: Asset<'objects'>, x = 0, y = 0) {
    assert(this.isRoom, 'Can only add object instances to rooms');
    const yy = this.yy as YyRoom;
    // Ensure we have an instance layer
    let instanceLayer = yy.layers.find(
      (x) => x.resourceType === 'GMRInstanceLayer',
    ) as YyRoomInstanceLayer | undefined;
    if (!instanceLayer) {
      instanceLayer = yyRoomInstanceLayerSchema.parse({});
      yy.layers.unshift(instanceLayer);
    }
    // Add a new instance
    const instance = yyRoomInstanceSchema.parse({
      objectId: obj.resource.id,
      x,
      y,
    });
    instanceLayer.instances.push(instance);
    yy.instanceCreationOrder ||= [];
    yy.instanceCreationOrder.push({
      name: instance.name,
      path: `rooms/${this.name}/${this.name}.yy`,
    });
    await this.saveYy();
  }

  get folder() {
    return groupPathToPosix((this.yy.parent as any).path);
  }

  /**
   * Check if this asset is in the given asset group ("folder").
   * @param path E.g. `my/folder/of/stuff`
   */
  isInFolder(path: string) {
    // Normalize the incoming path
    path = groupPathToPosix(path);
    const currentFolder = this.folder;
    return path === currentFolder || currentFolder.startsWith(`${path}/`);
  }

  /** Move to a different, *existing* folder. */
  async moveToFolder(path: string) {
    assert(path, 'Must provide a path with non-zero length!');
    if (!path.endsWith('.yy')) {
      path = `folders/${path}.yy`;
    }
    const folderName = path
      .split(/[/\\]+/)
      .pop()!
      .replace(/\.yy$/, '');
    // Make sure that folder exists.
    assert(folderName, 'Folder name is empty');
    assert(
      this.project.yyp.Folders.find((x) => x.folderPath === path),
      `Folder ${path} does not exist`,
    );
    assert(this.yy.parent, 'Asset has no folder field');
    // @ts-expect-error
    logger.info('moving', this.name, 'from', this.yy.parent.path, 'to', path);
    this.yy.parent = { name: folderName, path };
    await this.saveYy();
  }

  /**
   * Re-order the existing frames of a sprite.
   * Any frames not included in the new order will be deleted.
   */
  @sequential
  async reorganizeFrames(newFrameIdOrder: string[]) {
    assert(this.isSprite, 'Can only delete frames from a sprite');
    assert(!this.isSpineSprite, 'Cannot delete frames from a Spine sprite');
    if (!newFrameIdOrder.length) return;
    let yy = this.yy as YySprite;
    const oldFrameIds = yy.frames.map((x) => x.name);
    assert(
      newFrameIdOrder.every((x) => oldFrameIds.includes(x)),
      "Can't reorder frames that don't exist",
    );
    yy.frames = newFrameIdOrder.map((frameId) => {
      const oldFrame = yy.frames.find((x) => x.name === frameId);
      assert(oldFrame, 'Frame not found');
      return oldFrame;
    });
    await this.saveYy();
    // Delete any old frame images
    await Promise.all(
      oldFrameIds
        .filter((x) => !newFrameIdOrder.includes(x))
        .map((frameId) => {
          const path = this.dir.join(`${frameId}.png`);
          return path.delete();
        }),
    );
  }

  @sequential
  async deleteFrames(frameIds: string[]) {
    assert(this.isSprite, 'Can only delete frames from a sprite');
    assert(!this.isSpineSprite, 'Cannot delete frames from a Spine sprite');
    if (!frameIds.length) return;
    let yy = this.yy as YySprite;
    yy.frames = yy.frames.filter((x) => !frameIds.includes(x.name));
    await this.saveYy();

    // TODO: Delete the image files
    await Promise.all(
      frameIds.map((frameId) => {
        const path = this.dir.join(`${frameId}.png`);
        return path.delete();
      }),
    );
  }

  @sequential
  async addFrames(sourceImages: Pathy[]) {
    assert(this.isSprite, 'Can only add frames to a sprite');
    assert(!this.isSpineSprite, 'Cannot add frames to a Spine sprite');
    if (!sourceImages.length) return;
    assert(
      sourceImages.every((x) => x.hasExtension('png')),
      'All frames must be PNGs',
    );
    let yy = this.yy as YySprite;
    let expectedDims: { width: number; height: number };
    if (!yy.frames.length) {
      // Then get the expected dimensions from the first image
      expectedDims = await getPngSize(sourceImages[0]);
    } else {
      expectedDims = {
        width: yy.width,
        height: yy.height,
      };
    }
    const frameSizes = await Promise.all(
      sourceImages.map((x) => getPngSize(x)),
    );
    assert(
      frameSizes.every(
        (x) =>
          x.width === expectedDims.width && x.height === expectedDims.height,
      ),
      `Expected all frames to have width ${expectedDims.width} and height ${expectedDims.height}`,
    );
    const startingFrameCount = yy.frames.length;
    // Update the YY file to get new frameIds
    yy.frames.length = startingFrameCount + sourceImages.length;
    yy = yySpriteSchema.parse(yy); // Will fill out the new frames
    // Copy the new frames over.
    await Promise.all(
      sourceImages.map((source, i) => {
        const dest = this.dir.join(
          `${yy.frames[startingFrameCount + i].name}.png`,
        );
        return source.copy(dest);
      }),
    );
    await this.saveYy();
  }

  async createEvent(eventInfo: ObjectEvent) {
    assert(this.isObject, 'Can only create events for objects');
    // Create the file if it doesn't already exist
    const path = this.dir.join<string>(`${eventInfo.name}.gml`);
    if (!(await path.exists())) {
      await path.write('/// ');
    }
    // Update the YY file
    const yy = this.yy as YyObject;
    yy.eventList ||= [];
    if (
      yy.eventList.find(
        (x) =>
          x.eventNum === eventInfo.eventNum &&
          x.eventType === eventInfo.eventType,
      )
    ) {
      logger.warn(`Event ${eventInfo.name} already exists on ${this.name}`);
      return;
    }
    yy.eventList.push(
      yyObjectEventSchema.parse({
        eventNum: eventInfo.eventNum,
        eventType: eventInfo.eventType,
      }),
    );
    await this.saveYy();
    return this.addGmlFile(path);
  }

  async readYy(): Promise<YyData<T>> {
    const resolved = await Asset.resolveYyPath(this.project, this.resource);
    if (!resolved)
      throw Object.assign(
        new Error(`Listed resource file is missing: ${this.resource.id.path}`),
        { code: 'ENOENT' },
      );
    if (resolved.absolute !== this.yyPath.absolute) {
      this.project.clearResourceDiagnostics(this.yyPath.absolute);
      this.yyPath = resolved.withValidator(yySchemas[this.assetKind]) as Pathy<
        YyData<T>
      >;
    }
    try {
      this.yy = Yy.parse(
        await this.project.readDocumentText(resolved),
        this.assetKind,
      );
      this.project.setResourceDiagnostics(this.yyPath.absolute, 'metadata', []);
      return this.yy;
    } catch (error) {
      this.project.setResourceDiagnostics(this.yyPath.absolute, 'metadata', [
        Asset.resourceDiagnostic(
          `Cannot read resource ${this.resource.id.path}: ${error instanceof Error ? error.message : error}`,
        ),
      ]);
      throw error;
    }
  }

  get dir() {
    return this.yyPath.up();
  }

  get name() {
    return this.resource.id.name;
  }

  /**
   * Reprocess an existing file after it has been modified.
   */
  async reloadFile(path: Pathy, virtualContent?: string) {
    const gml = this.getGmlFile(path);
    if (!gml) {
      return;
    }
    await gml.reload(virtualContent, { reloadDirty: true });
  }

  getGmlFile(path: Pathy) {
    assert(path, 'GML Path does not exist');
    return this.gmlFiles.get(path.absolute.toLocaleLowerCase());
  }

  /** Reconcile model metadata without writing YY or mutating the public type graph. */
  refreshParent(): void {
    if (!this.isObject) return;
    const yy = this.yy as YyObject;
    const parent = this.project.getAssetByName(yy.parentObjectId?.name);
    const seen = new Set<Asset>([this]);
    let invalid: string | undefined;
    for (
      let current = parent;
      current;
      current = this.project.getAssetByName(
        (current.yy as YyObject).parentObjectId?.name,
      )
    ) {
      if (seen.has(current)) {
        invalid = 'Object inheritance contains a cycle.';
        break;
      }
      seen.add(current);
      if (!current.isObject) {
        invalid = 'The parent resource must be an object.';
        break;
      }
    }
    if (yy.parentObjectId && !parent)
      invalid = `Parent object ${yy.parentObjectId.name} is unavailable.`;
    this._parent =
      !invalid && parent?.isObject ? (parent as Asset<'objects'>) : undefined;
    this.project.setResourceDiagnostics(
      this.yyPath.absolute,
      'parent',
      invalid
        ? [
            new Diagnostic(
              invalid,
              {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
              },
              'error',
            ),
          ]
        : [],
    );
  }

  /** @deprecated Use Project.analysis.analyze() for the complete dependency closure. */
  updateGlobals(_initial = false) {
    this.refreshParent();
    this.project.analysis.analyzeSync();
  }
  /** @deprecated Use Project.analysis.analyze(). */
  updateAllSymbols(_initial = false) {
    this.project.analysis.analyzeSync();
  }

  updateDiagnostics() {
    for (const gml of this.gmlFilesArray) {
      gml.updateDiagnostics();
    }
  }

  protected addGmlFile(path: Pathy<string>): Code {
    const existing = this.getGmlFile(path);
    if (existing && existing.path.absolute !== path.absolute) {
      this.project.analysis.retire(existing);
      this.gmlFiles.delete(path.absolute.toLocaleLowerCase());
    }
    const gml =
      this.getGmlFile(path) ||
      new Code(this as Asset<'scripts' | 'objects'>, path);
    assert(path, 'Cannot add GML file, path does not exist');
    this.gmlFiles.set(path.absolute.toLocaleLowerCase(), gml);
    return gml;
  }

  async reload(analyze = true): Promise<void> {
    if (analyze) return this.project.reloadResource(this.yyPath);
    try {
      await this.readYy();
    } catch (error) {
      if (!Asset.isMissing(error)) throw error;
      if (this.project.getAssetByName(this.name) === this)
        this.project.assets.delete(this.name.toLocaleLowerCase());
      this.retireModel();
      this.project.setResourceDiagnostics(this.yyPath.absolute, 'metadata', [
        Asset.resourceDiagnostic(
          `Listed resource file is missing: ${this.resource.id.path}`,
        ),
      ]);
      return;
    }
    if (this.isScript || this.isObject) {
      const children = await Asset.children(this.dir);
      const oldFiles = new Map(this.gmlFiles);
      const listed = this.isScript
        ? [`${this.name}.gml`]
        : this.listedEventFileNames();
      const wanted: Pathy[] = [];
      const diagnostics: Diagnostic[] = [];
      for (const name of new Set(listed)) {
        const matches = children.filter(
          (path) =>
            path.basename.toLocaleLowerCase() === name.toLocaleLowerCase(),
        );
        if (matches.length === 1) wanted.push(matches[0]);
        else
          diagnostics.push(
            Asset.resourceDiagnostic(
              matches.length
                ? `Several files match the listed GML file: ${name}`
                : `Listed GML file is missing: ${name}`,
            ),
          );
      }
      this.project.setResourceDiagnostics(
        this.yyPath.absolute,
        'files',
        diagnostics,
      );
      const selected = new Set(
        wanted.map((path) => path.absolute.toLocaleLowerCase()),
      );
      for (const [key, code] of oldFiles)
        if (!selected.has(key)) {
          this.gmlFiles.delete(key);
          this.project.analysis.retire(code);
        }
      for (const path of wanted) this.addGmlFile(path as Pathy<string>);
    } else if (this.assetKind === 'extensions') {
      this.extensionSymbols.clear();
      this.extensionTypes.clear();
      const extensionSelf = new Type('Struct');
      extensionSelf.semanticKey = 'global';
      const diagnostics: Diagnostic[] = [];

      // Load constants and functions from the extension
      const typeIndexToName = (idx: 1 | 2): 'String' | 'Real' => {
        return idx === 1 ? 'String' : 'Real';
      };

      const yy = this.yy as YyExtension;
      for (const file of yy.files) {
        for (const constant of file.constants) {
          if (constant.hidden) {
            continue;
          }
          try {
            // Get the type by parsing the value. For now we'll just check for number or string, else "Any".
            const type = constant.value.startsWith('"')
              ? 'String'
              : constant.value.match(/^-?[\d_.]+$/)
                ? 'Real'
                : 'Any';
            const signifier = new Signifier(
              extensionSelf,
              constant.name,
              new Type(type),
            );
            signifier.macro = true;
            signifier.native = this.name;
            signifier.global = true;
            signifier.writable = false;
            signifier.def = {};

            this.extensionSymbols.set(signifier.name, signifier);
          } catch (err) {
            diagnostics.push(
              new Diagnostic(
                `Error loading extension constant: ${constant.name}`,
                {
                  start: { line: 1, column: 1, offset: 0 },
                  end: { line: 1, column: 1, offset: 0 },
                },
                'error',
                err,
              ),
            );
          }
        }
        for (const func of file.functions) {
          if (func.hidden) {
            continue;
          }
          try {
            const type = new Type('Function')
              .named(func.name)
              .describe(func.help);
            type.setReturnType(new Type(typeIndexToName(func.returnType)));
            for (let i = 0; i < func.args.length; i++) {
              const typeIdx = func.args[i];
              type.addParameter(i, `argument${i}`, {
                type: new Type(typeIndexToName(typeIdx)),
              });
            }
            type.callKind = 'native';
            const signifier = new Signifier(extensionSelf, func.name, type);
            signifier.native = this.name;
            signifier.global = true;
            signifier.writable = false;
            signifier.def = {};
            this.extensionSymbols.set(signifier.name, signifier);
            this.extensionTypes.set(`Function.${func.name}`, type);
          } catch (err) {
            diagnostics.push(
              new Diagnostic(
                `Error loading extension function: ${func.name}`,
                {
                  start: { line: 1, column: 1, offset: 0 },
                  end: { line: 1, column: 1, offset: 0 },
                },
                'error',
                err,
              ),
            );
          }
        }
      }

      this.project.setResourceDiagnostics(
        this.yyPath.absolute,
        'extension',
        diagnostics,
      );
    }
    await this.initiallyReadAndParseGml();
  }

  /** Model-only retirement; watcher reconciliation must never delete user files. */
  retireModel(): void {
    for (const code of this.gmlFiles.values())
      this.project.analysis.retire(code);
    this.gmlFiles.clear();
    this.extensionSymbols.clear();
    this.extensionTypes.clear();
    this.project.analysis.invalidate();
    this.project.clearResourceDiagnostics(this.yyPath.absolute);
  }

  async onRemove() {
    this.retireModel();
    await this.dir.delete({ force: true, recursive: true });
    await this.project.analysis.analyze();
  }

  private listedEventFileNames(): string[] {
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
    return (this.yy as YyObject).eventList.flatMap((event) => {
      const suffix =
        event.eventType === 4 ? event.collisionObjectId?.name : event.eventNum;
      return suffix !== undefined && prefixes[event.eventType]
        ? [`${prefixes[event.eventType]}_${suffix}.gml`]
        : [];
    });
  }

  protected addScriptFile(children: Pathy<string>[]) {
    // Scripts should have exactly one GML file, which is the script itself,
    // named the same as the script (though there could be casing variations)
    const matches = children.filter(
      (p) =>
        p.basename.toLocaleLowerCase() ===
        `${this.name?.toLocaleLowerCase?.()}.gml`,
    );
    if (matches.length !== 1) {
      logger.error(
        `Script ${this.name} has ${matches.length} GML files. Expected 1.`,
      );
    } else {
      this.addGmlFile(matches[0]);
    }
  }

  protected async initiallyReadAndParseGml() {
    const parseWaits: Promise<any>[] = [];
    for (const file of this.gmlFilesArray) {
      parseWaits.push(file.readContent());
    }
    return await Promise.all(parseWaits);
  }

  get assetTypeKind() {
    switch (this.assetKind) {
      case 'objects':
        return 'Asset.GMObject';
      case 'rooms':
        return 'Asset.GMRoom';
      case 'scripts':
        return 'Asset.GMScript';
      case 'sprites':
        return 'Asset.GMSprite';
      case 'sounds':
        return 'Asset.GMSound';
      case 'paths':
        return 'Asset.GMPath';
      case 'shaders':
        return 'Asset.GMShader';
      case 'timelines':
        return 'Asset.GMTimeline';
      case 'fonts':
        return 'Asset.GMFont';
      default:
        return 'Any';
    }
  }

  private static isMissing(error: unknown): boolean {
    return ['ENOENT', 'ENOTDIR'].includes(
      (error as NodeJS.ErrnoException)?.code || '',
    );
  }

  private static resourceDiagnostic(message: string): Diagnostic {
    const location = { line: 1, column: 1, offset: 0 };
    return new Diagnostic(message, { start: location, end: location }, 'error');
  }

  private static async children(dir: Pathy): Promise<Pathy[]> {
    try {
      return (await readdir(dir.absolute, { withFileTypes: true }))
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => dir.join(entry.name));
    } catch (error) {
      if (Asset.isMissing(error)) return [];
      throw error;
    }
  }

  private static async resolveYyPath(
    project: Project,
    resource: YypResource,
  ): Promise<Pathy | undefined> {
    const expected = project.dir.join(resource.id.path);
    if (
      typeof project.options?.documentText?.(expected.absolute) === 'string' ||
      (await pathExists(expected.absolute))
    )
      return expected;
    let directories;
    try {
      directories = await readdir(expected.up(2).absolute, {
        withFileTypes: true,
      });
    } catch (error) {
      if (Asset.isMissing(error)) return;
      throw error;
    }
    const matches = directories.filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.toLocaleLowerCase() === resource.id.name.toLocaleLowerCase(),
    );
    if (matches.length !== 1) return;
    const children = await Asset.children(expected.up(2).join(matches[0].name));
    const files = children.filter(
      (path) =>
        path.basename.toLocaleLowerCase() ===
        `${resource.id.name}.yy`.toLocaleLowerCase(),
    );
    return files.length === 1 ? files[0] : undefined;
  }

  static async from<T extends YyResourceType>(
    project: Project,
    resource: YypResource,
  ): Promise<Asset<T> | undefined> {
    const yyPath = await Asset.resolveYyPath(project, resource);
    if (!yyPath) {
      project.setResourceDiagnostics(
        project.dir.join(resource.id.path).absolute,
        'metadata',
        [
          Asset.resourceDiagnostic(
            `Listed resource file is missing: ${resource.id.path}`,
          ),
        ],
      );
      return;
    }
    project.setResourceDiagnostics(
      project.dir.join(resource.id.path).absolute,
      'metadata',
      [],
    );
    const item = new Asset(project, resource, yyPath) as Asset<T>;
    await item.reload(false);
    return item.yy ? item : undefined;
  }
}
