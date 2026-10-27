export interface NativeSpecSource {
  readonly path: string;
  readonly runtime: string;
  readonly module: string;
  readonly bundled: boolean;
  readonly sha256: string;
}

export type LanguageFeature =
  | 'functions'
  | 'structs'
  | 'constructors'
  | 'exceptions'
  | 'chainedAccessors'
  | 'delete'
  | 'nullish'
  | 'templateStrings';

export type ScriptSemantics = 'legacy-callable' | 'global-startup' | 'unknown';

type Version = readonly [number, number, number, number];

/** Release anchors describe syntax, not native API availability. */
const introduced: Readonly<Record<LanguageFeature, Version>> = {
  // https://gamemaker.io/en/blog/gamemaker-studio-2-dot-3-new-gml-features
  functions: [2, 3, 0, 0],
  structs: [2, 3, 0, 0],
  constructors: [2, 3, 0, 0],
  exceptions: [2, 3, 0, 0],
  chainedAccessors: [2, 3, 0, 0],
  delete: [2, 3, 0, 0],
  // https://gms.yoyogames.com/release-notes-2.3.7.474.json
  // Both ?? and ??= were introduced together in the 2.3.7 release family.
  nullish: [2, 3, 7, 0],
  // https://gamemaker.io/en/blog/release-2023-4
  templateStrings: [2023, 4, 0, 0],
};

function parseVersion(value: string | undefined): Version | undefined {
  if (!value || !/^\d+(?:\.\d+){1,3}$/.test(value)) return;
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return;
  return [parts[0], parts[1], parts[2] || 0, parts[3] || 0];
}

function atLeast(version: Version, minimum: Version): boolean {
  for (let index = 0; index < version.length; index++) {
    if (version[index] !== minimum[index]) {
      return version[index] > minimum[index];
    }
  }
  return true;
}

export interface LanguageProfileOptions {
  /** Explicit runtime or the runtime resolved for the project's IDE. */
  runtimeVersion?: string;
  ideVersion?: string;
  specSources?: readonly NativeSpecSource[];
}

/** A versioned language input. An unknown feature is not an unsupported one. */
export class LanguageProfile {
  readonly version: Version | undefined;
  readonly versionSource: 'runtime' | 'ide' | 'spec' | 'unknown';
  readonly scriptSemantics: ScriptSemantics;
  readonly specSources: readonly NativeSpecSource[];
  readonly nativeDegraded: boolean;

  constructor(readonly options: Readonly<LanguageProfileOptions> = {}) {
    this.specSources = Object.freeze(
      (options.specSources || []).map((source) => Object.freeze({ ...source })),
    );
    this.nativeDegraded = this.specSources.some((source) => source.bundled);
    const runtime = parseVersion(options.runtimeVersion);
    const ide = parseVersion(options.ideVersion);
    // A bundled file may contain backported/newer entries. Its header is not
    // evidence that the project targets that historical runtime.
    const nativeBase = this.specSources.find(
      (source) => !source.bundled && source.module.toLowerCase() === 'base',
    );
    const spec = parseVersion(nativeBase?.runtime);
    if (runtime) {
      this.version = runtime;
      this.versionSource = 'runtime';
    } else if (ide) {
      this.version = ide;
      this.versionSource = 'ide';
    } else if (spec) {
      this.version = spec;
      this.versionSource = 'spec';
    } else {
      this.versionSource = 'unknown';
    }
    this.scriptSemantics = this.version
      ? atLeast(this.version, introduced.functions)
        ? 'global-startup'
        : 'legacy-callable'
      : 'unknown';
  }

  supports(feature: LanguageFeature): boolean | undefined {
    return this.version
      ? atLeast(this.version, introduced[feature])
      : undefined;
  }

  /** Changes when semantic inputs change, even if document text does not. */
  get key(): string {
    return JSON.stringify({
      version: this.version,
      source: this.versionSource,
      specs: this.specSources.map(
        ({ path, runtime, module, bundled, sha256 }) => ({
          path,
          runtime,
          module,
          bundled,
          sha256,
        }),
      ),
    });
  }
}
