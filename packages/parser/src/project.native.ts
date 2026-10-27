import { Pathy, pathy } from '@bscotch/pathy';
import { findReleaseFromFeeds } from '@bscotch/gamemaker-releases';
import { GameMakerIde, GameMakerRuntime } from '@bscotch/stitch-launcher';
import { ok } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseStringPromise } from 'xml2js';
import { parseJsdoc } from './jsdoc.js';
import { logger } from './logger.js';
import { GmlSpec, GmlSpecConstant, gmlSpecSchema } from './project.spec.js';
import { Signifier } from './signifiers.js';
import { typeFromParsedJsdocs } from './types.feather.js';
import { Type, type StructType } from './types.js';
import { addSpriteInfoStruct } from './types.sprites.js';
import { StitchParserError, assert } from './util.js';

export type NativeSpecStage = 'read' | 'xml' | 'schema' | 'load';

export interface NativeSpecSource {
  readonly path: string;
  /** The spec's declared header, not independently verified API coverage. */
  readonly runtime: string;
  readonly module: string;
  readonly bundled: boolean;
  readonly sha256: string;
}

type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

function freezeSpec<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      freezeSpec(child);
    }
  }
  return Object.freeze(value);
}

/** A selected specification failed; callers must not treat it as a partial load. */
export class NativeSpecError extends StitchParserError {
  constructor(
    readonly specFilePath: string,
    readonly stage: NativeSpecStage,
    cause: unknown,
  ) {
    super(`Error loading native spec "${specFilePath}" during ${stage}`);
    this.cause = cause;
  }
}

export class Native {
  protected specs!: GmlSpec[];
  protected specSources: readonly NativeSpecSource[] = [];
  protected readonly sourcesBySpec = new Map<GmlSpec, NativeSpecSource>();
  objectInstanceBase!: StructType;
  protected readonly enumMemberValues = new WeakMap<Signifier, number>();

  getSpecSources(): readonly NativeSpecSource[] {
    return this.specSources;
  }

  /** Parsed source metadata, including availability flags not yet interpreted. */
  getSpecs(): readonly DeepReadonly<GmlSpec>[] {
    return this.specs;
  }

  /** The numeric spec value, not the declaration/parameter index. */
  getEnumMemberValue(symbol: Signifier): number | undefined {
    return this.enumMemberValues.get(symbol);
  }

  protected constructor(
    readonly globalSelf: StructType,
    readonly types: Map<string, Type>,
  ) {}

  protected load() {
    assert(this.specs.length, 'No specs to load!');

    // Prepare the base object instance type.
    this.objectInstanceBase = new Type('Struct');
    const idInstance = new Type('Id.Instance');
    this.types.set('Id.Instance', idInstance);
    idInstance.extends = this.objectInstanceBase;
    const assetGmObject = new Type('Asset.GMObject');
    assetGmObject.extends = this.objectInstanceBase;
    this.types.set('Asset.GMObject', assetGmObject);

    // Process all of the found specs
    for (const spec of this.specs) {
      try {
        logger.info(`Loading spec for module ${spec.module}`);
        this.loadEnumerations(spec);
        this.loadConstants(spec);
        this.loadVariables(spec);
        this.loadStructs(spec);
        this.loadFunctions(spec);
      } catch (cause) {
        throw new NativeSpecError(
          this.sourcesBySpec.get(spec)!.path,
          'load',
          cause,
        );
      }
    }

    // Update the base instance type using instance variables.
    for (const member of this.globalSelf.listMembers()) {
      if (member.instance) {
        this.objectInstanceBase.addMember(member);
      }
    }
    this.objectInstanceBase.isReadonly = true;

    // Have the base Id.Instance and Asset.GmObject types
    // use the object instance base as their parent, and make them readonly.
    idInstance.isReadonly = true;
    assetGmObject.isReadonly = true;
  }

  protected loadEnumerations(spec: GmlSpec) {
    for (const enumeration of spec.enumerations) {
      const typeName = `Enum.${enumeration.name}`;
      const enumType = this.types.get(typeName) || new Type('Enum');
      assert(enumType.kind === 'Enum', `Expected enum type ${typeName}`);
      assert(
        !this.globalSelf.getMember(enumeration.name),
        `Native enum ${enumeration.name} already exists`,
      );
      enumType.named(enumeration.name);
      const symbol = new Signifier(this.globalSelf, enumeration.name, enumType);
      symbol.enum = true;
      symbol.global = true;
      symbol.writable = false;
      symbol.native = enumeration.module;
      enumType.signifier = symbol;
      this.types.set(typeName, enumType);
      this.globalSelf.addMember(symbol);

      for (const member of enumeration.members) {
        const memberType = new Type('EnumMember').named(member.name);
        const memberSymbol = new Signifier(enumType, member.name, memberType)
          .describe(member.description)
          .deprecate(member.deprecated);
        memberSymbol.enumMember = true;
        memberSymbol.writable = false;
        memberSymbol.native = enumeration.module;
        memberType.signifier = memberSymbol;
        enumType.addMember(memberSymbol);
        this.enumMemberValues.set(memberSymbol, member.value);
      }
      enumType.isReadonly = true;
    }
  }

  protected loadVariables(spec: GmlSpec) {
    for (const variable of spec.variables) {
      assert(variable, 'Variable must be defined');
      const type = Type.fromFeatherString(variable.type, this.types, true);
      const symbol = new Signifier(this.globalSelf, variable.name, type)
        .describe(variable.description)
        .deprecate(variable.deprecated);
      symbol.readable = variable.readable;
      symbol.writable = variable.writable;
      symbol.native = variable.module;
      symbol.global = !variable.instance;
      symbol.instance = variable.instance;
      this.globalSelf.addMember(symbol);
    }
  }

  protected loadFunctions(spec: GmlSpec) {
    for (const func of spec.functions) {
      const existing = this.globalSelf.getMember(func.name);
      if (existing) {
        logger.warn(`Native function ${func.name} already exists, skipping.`);
        if (!existing.description && func.description) {
          existing.describe(func.description);
        }
        continue;
      }

      const typeName = `Function.${func.name}`;
      // Need a type and a symbol for each function.
      const functionType = (
        this.types.get(typeName) || new Type('Function').named(func.name)
      ).describe(func.description);
      this.types.set(typeName, functionType);

      // Create a new generic type for this function (in particular, to be re-used by types that contain it!)
      const genericType = new Type('ArgumentIdentity');
      genericType.isGeneric = true;
      const generics = { ArgumentIdentity: [genericType] };
      const usesGenerics =
        func.parameters?.some((param) =>
          param.name.includes('ArgumentIdentity'),
        ) || func.returnType?.includes('ArgumentIdentity');
      const addGenericToContainer = (typeString: string) => {
        if (!usesGenerics) return typeString;
        const replaced = typeString.replace(
          /^(id.ds[a-z]+|array)(<\w+>)?/i,
          `$1<ArgumentIdentity>`,
        );
        return replaced;
      };

      // Add parameters to the type.
      assert(func.parameters, 'Function must have parameters');
      for (let i = 0; i < func.parameters.length; i++) {
        const param = func.parameters[i];
        assert(param, 'Parameter must be defined');
        const paramType = Type.fromFeatherString(
          addGenericToContainer(param.type),
          [generics, this.types],
          true,
        );
        functionType
          .addParameter(i, param.name, {
            type: paramType,
            optional: param.optional,
          })
          .describe(param.description);
      }
      // Add return type to the type.
      functionType.addReturnType(
        Type.fromFeatherString(
          addGenericToContainer(func.returnType),
          [generics, this.types],
          true,
        ),
      );

      // Refine only a signature actually present in the selected spec. In
      // particular, older Struct-only signatures must not gain Function support,
      // and unfamiliar future signatures keep their original spec types.
      if (
        func.name === 'static_get' &&
        func.parameters.length === 1 &&
        func.returnType === 'Struct' &&
        func.parameters[0].type
          .split('|')
          .every((type) =>
            ['Function', 'Struct', 'Asset.GMScript'].includes(type),
          )
      ) {
        const param = func.parameters[0];
        const inferred = typeFromParsedJsdocs(
          parseJsdoc(`
          /// @template {${param.type}} T
          /// @param {T} ${param.name}
          /// @returns {StaticType<T>}
        `),
          this.types,
          false,
        )[0] as Type<'Function'>;
        functionType.getParameter(0)!.setType(inferred.getParameter(0)!.type);
        functionType.setReturnType(inferred.returns!);
      }

      const symbol = new Signifier(
        this.globalSelf,
        func.name,
        functionType,
      ).deprecate(func.deprecated);
      symbol.describe(func.description);
      symbol.writable = false;
      symbol.native = func.module;
      functionType.signifier = symbol;
      this.globalSelf.addMember(symbol);
    }
  }

  protected loadConstants(spec: GmlSpec) {
    // Handle the constants.
    // Each constant value represents a unique expression
    // of its type (e.g. it's not just a Real, it's the Real
    // value 7 or whatever). Unlike the structs section of
    // the spec, which are *only* used for types, constants
    // are referenceabled in the code. Therefore we need
    // a unique symbol and type for each constant value,
    // along with a type that collects all of those types.

    // First group them all by "class". The empty-string
    // class represents the absence of a class.
    const constantsByClass = new Map<string, GmlSpecConstant[]>();
    for (const constant of spec.constants) {
      const klass = constant.class || '';
      constantsByClass.set(klass, constantsByClass.get(klass) || []);
      constantsByClass.get(klass)!.push(constant);
    }
    // Then create a type for each class and a symbol for each constant.
    for (const [klass, constants] of constantsByClass) {
      if (!klass) {
        for (const constant of constants) {
          assert(constant, 'Constant must be defined');
          const symbol =
            this.globalSelf.getMember(constant.name) ||
            new Signifier(
              this.globalSelf,
              constant.name,
              Type.fromFeatherString(constant.type, this.types, true),
            ).describe(constant.description);
          symbol.writable = false;
          symbol.native = constant.module;
          this.globalSelf.addMember(symbol);
        }
        continue;
      }

      // Figure out what types are in use by this class.
      const typeNames = new Set<string>();
      for (const constant of constants) {
        assert(constant, 'Constant must be defined');
        typeNames.add(constant.type);
      }
      ok(typeNames.size, `Class ${klass} has no types`);

      // Create the base type for the class.
      const classTypeName = `Constant.${klass}`;
      const typeString = [...typeNames.values()].join('|');
      const classType =
        this.types.get(classTypeName) ||
        Type.fromFeatherString(typeString, this.types, true)[0].named(klass);

      this.types.set(classTypeName, classType);

      // Create symbols for each class member.
      for (const constant of constants) {
        const symbol =
          this.globalSelf.getMember(constant.name) ||
          new Signifier(this.globalSelf, constant.name).describe(
            constant.description,
          );
        symbol.writable = false;
        symbol.native = constant.module;
        symbol.setType(classType);
        const typeName = `${classTypeName}.${constant.name}`;
        this.types.set(typeName, classType);

        this.globalSelf.addMember(symbol);
      }
    }
  }

  protected loadStructs(spec: GmlSpec) {
    // Create struct types. Each one extends the base Struct type.
    if (
      spec.functions.some(
        (func) =>
          func.name === 'sprite_get_info' &&
          func.returnType === 'Struct.SpriteInfo',
      ) &&
      !spec.structures.some((struct) => struct.name === 'SpriteInfo')
    ) {
      addSpriteInfoStruct(this.types);
    }
    for (const struct of spec.structures) {
      if (!struct.name) {
        continue;
      }
      const typeName = `Struct.${struct.name}`;
      const structType =
        this.types.get(typeName) || new Type('Struct').named(struct.name);
      ok(!structType.listMembers().length, `Type ${typeName} already exists`);
      this.types.set(typeName, structType);

      for (const prop of struct.properties) {
        if (prop && !structType.getMember(prop.name)) {
          const type = Type.fromFeatherString(prop.type, this.types, true);
          const symbol = structType
            .addMember(prop.name, { type, writable: prop.writable })!
            .describe(prop.description);
          symbol.readable = prop.readable;
          symbol.native = struct.module;
        }
      }
    }
    // Set all native structs as read-only
    for (const struct of spec.structures) {
      if (!struct.name) {
        continue;
      }
      const typeName = `Struct.${struct.name}`;
      const structType = this.types.get(typeName);
      ok(structType, `Type ${typeName} does not exist`);
      structType.isReadonly = true;
    }
  }

  static async from(
    filePaths: Pathy[] | undefined,
    globalSelf: StructType,
    types: Map<string, Type>,
  ): Promise<Native> {
    filePaths = filePaths || [Native.fallbackGmlSpecPath];
    // Every selected spec is required. Silently dropping a failed module would
    // publish an apparently complete but version-inaccurate native environment.
    const parsed = await Promise.all(
      filePaths.map((path) => Native.parseSource(path.absolute)),
    );
    // Stable ordering preserves module precedence while always loading Base first.
    parsed.sort(
      (a, b) =>
        Number(b.spec.module.toLowerCase() === 'base') -
        Number(a.spec.module.toLowerCase() === 'base'),
    );
    const native = new Native(globalSelf, types);
    native.specs = parsed.map(({ spec, source }) => {
      native.sourcesBySpec.set(spec, source);
      return spec;
    });
    native.specSources = Object.freeze(parsed.map(({ source }) => source));
    native.load();
    freezeSpec(native.specs);
    return native;
  }

  static async parse(specFilePath: string): Promise<GmlSpec> {
    return (await Native.parseSource(specFilePath)).spec;
  }

  private static async parseSource(specFilePath: string): Promise<{
    spec: GmlSpec;
    source: NativeSpecSource;
  }> {
    let specRaw: Buffer;
    try {
      specRaw = await readFile(specFilePath);
    } catch (cause) {
      throw new NativeSpecError(specFilePath, 'read', cause);
    }
    let asJson: unknown;
    try {
      asJson = await parseStringPromise(
        specRaw.toString('utf8').replace(/^\ufeff/, ''),
        {
          trim: true,
          normalize: true,
          emptyTag() {
            return {};
          },
          // Prevent surprises if modules provide single entries.
          explicitArray: true,
        },
      );
    } catch (cause) {
      throw new NativeSpecError(specFilePath, 'xml', cause);
    }
    let spec: GmlSpec;
    try {
      spec = gmlSpecSchema.parse(asJson);
    } catch (cause) {
      throw new NativeSpecError(specFilePath, 'schema', cause);
    }
    const path = pathy(specFilePath).absolute;
    return {
      spec,
      source: Object.freeze({
        path,
        runtime: spec.runtime,
        module: spec.module,
        bundled: path === Native.fallbackGmlSpecPath.absolute,
        sha256: createHash('sha256').update(specRaw).digest('hex'),
      }),
    };
  }

  static readonly fallbackGmlSpecPath = pathy(import.meta.url).resolveTo(
    '../../assets/GmlSpec.xml',
  );

  static async findHelpLinksFile(
    ideVersion: string,
  ): Promise<Pathy<{ [method: string]: string }> | undefined> {
    const ides = await GameMakerIde.listInstalled();
    const ide = ides.find((ide) => ide.version === ideVersion) || ides[0];
    return ide?.directory.join('RoboHelp/helpdocs_keywords.json');
  }

  static async listSpecFiles(options: {
    runtimeVersion?: string;
    ideVersion?: string;
  }): Promise<Pathy[]> {
    if (!options.runtimeVersion && options.ideVersion) {
      logger.warn(
        'No stitch config found, looking up runtime version from live feeds',
      );
      try {
        let usingRelease = await findReleaseFromFeeds(options.ideVersion);
        if (!usingRelease) {
          logger.info(
            'IDE version is no longer in the live feeds, checking release history',
          );
          usingRelease = await GameMakerIde.findRelease({
            ideVersion: options.ideVersion,
            logger,
          });
        }
        logger.info('Done looking, found:', usingRelease?.runtime.version);
        options.runtimeVersion = usingRelease?.runtime.version;
      } catch (error) {
        logger.warn('Could not look up runtime version from live feeds', error);
      }
    }
    if (options.runtimeVersion) {
      // Find the locally installed runtime folder
      logger.info('Looking for runtime', options.runtimeVersion);
      const installedRuntime = (
        await GameMakerRuntime.listInstalled({
          logger,
          includeReleaseMetadata: false,
        })
      ).find((runtime) => runtime.version === options.runtimeVersion);
      if (installedRuntime) {
        logger.info(
          `Looking for spec files in "${installedRuntime.directory?.absolute}"`,
        );
        const specs = await pathy(
          installedRuntime.directory,
        ).listChildrenRecursively({
          filter(path) {
            return path.basename === 'GmlSpec.xml' || undefined;
          },
          maxDepth: 3,
        });
        if (specs.length) {
          return specs;
        } else {
          logger.warn(
            'Found runtime, but could not find any GmlSpec.xml files!',
          );
        }
      } else {
        logger.warn(
          `Could not find runtime version ${options.runtimeVersion} locally!`,
        );
      }
    }
    logger.warn('Falling back to default GmlSpec.xml included with Stitch.');
    return [Native.fallbackGmlSpecPath];
  }
}
