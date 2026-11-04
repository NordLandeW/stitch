import { Project, type ProjectOptions } from '@bscotch/gml-parser';
import { pathy } from '@bscotch/pathy';
import type {
  DiagnosticSnapshot,
  Initialization,
  Input,
  Overlay,
  Query,
  QueryKind,
  QueryResults,
} from './protocol.mjs';
import {
  diagnosticSnapshot,
  queryLanguage,
  nativeCandidates,
} from './query.mjs';

export const pathKey = (path: string) => pathy(path).absolute.toLowerCase();

/** One serialized owner of the existing parser graph. No VS Code or file writes. */
export class LanguageEngine {
  private readonly overlays = new Map<string, Overlay>();
  private readonly dirtyDiagnostics = new Map<string, DiagnosticSnapshot>();
  private project!: Project;
  private initialization!: Initialization;

  constructor(
    private readonly callbacks: Pick<
      ProjectOptions,
      'onLoadProgress' | 'logger'
    > = {},
    project?: Project,
  ) {
    if (project) {
      this.project = project;
      this.initialization = {
        yypPath: project.yypPath.absolute,
        configuration: project.analysisConfiguration,
        nativeSpecFiles: project.nativeSpecFiles,
        autoDeclareGlobalsPrefixes:
          project.options?.settings?.autoDeclareGlobalsPrefixes,
      };
    }
  }

  async initialize(input: Initialization): Promise<void> {
    this.initialization = { ...input };
    if (this.project)
      for (const asset of this.project.assets.values()) {
        this.record({ path: asset.yyPath.absolute, diagnostics: [] });
        for (const code of asset.gmlFiles.values())
          this.record({ path: code.path.absolute, diagnostics: [] });
      }
    this.project = await Project.initialize(input.yypPath, {
      configuration: input.configuration,
      nativeSpecFiles: input.nativeSpecFiles,
      documentation: false,
      settings: {
        autoDeclareGlobalsPrefixes: input.autoDeclareGlobalsPrefixes,
      },
      ...this.callbacks,
      onDiagnostics: (payload) => this.record(diagnosticSnapshot(payload)),
    });
    await this.restoreOverlays();
  }

  private record(snapshot: DiagnosticSnapshot) {
    this.dirtyDiagnostics.set(pathKey(snapshot.path), snapshot);
  }

  diagnostics(): DiagnosticSnapshot[] {
    const diagnostics = [...this.dirtyDiagnostics.values()];
    this.dirtyDiagnostics.clear();
    return diagnostics;
  }

  private async restoreOverlays() {
    for (const overlay of this.overlays.values()) {
      const code = this.project.getGmlFile(pathy(overlay.path));
      if (code && code.content !== overlay.text) await code.parse(overlay.text);
    }
    this.project.macros.flush();
    this.project.drainDirtyFileUpdateQueue();
  }

  async apply(inputs: Input[]) {
    for (const input of inputs) {
      switch (input.kind) {
        case 'document': {
          const key = pathKey(input.path);
          const previous = this.overlays.get(key);
          if (
            previous &&
            (previous.generation > input.generation ||
              (previous.generation === input.generation &&
                previous.version >= input.version))
          )
            break;
          this.overlays.set(key, input);
          const code = this.project.getGmlFile(pathy(input.path));
          if (code && code.content !== input.text) await code.parse(input.text);
          break;
        }
        case 'close': {
          const key = pathKey(input.path),
            previous = this.overlays.get(key);
          if (previous && previous.generation !== input.generation) break;
          this.overlays.delete(key);
          const code = this.project.getGmlFile(pathy(input.path));
          if (code) await code.parse();
          break;
        }
        case 'disk': {
          const code = this.project.getGmlFile(pathy(input.path));
          if (code && !this.overlays.has(pathKey(input.path)))
            await code.parse();
          break;
        }
        case 'asset': {
          // Commit buffered source changes before a metadata transaction resets it.
          this.project.macros.flush();
          const asset = this.project.getAssetByName(input.name);
          if (asset?.assetKind === 'extensions')
            await this.initialize(this.initialization);
          else
            await asset?.reload(
              (code) => this.overlays.get(pathKey(code.path.absolute))?.text,
            );
          break;
        }
        case 'project': {
          // Metadata can remove native-like extension/audio declarations that
          // have no Code owner. Rebuild this rare boundary on the worker only.
          this.initialization.configuration = input.configuration;
          await this.initialize(this.initialization);
          break;
        }
        case 'configuration':
          this.initialization.configuration = input.name;
          this.project.setAnalysisConfiguration(input.name);
          break;
        case 'settings':
          this.initialization.autoDeclareGlobalsPrefixes = input.prefixes;
          await this.initialize(this.initialization);
          break;
        case 'native':
          this.initialization.nativeSpecFiles = input.files;
          await this.initialize(this.initialization);
          break;
      }
    }
    this.project.macros.flush();
    this.project.drainDirtyFileUpdateQueue();
  }

  nativeCandidates() {
    return nativeCandidates(this.project);
  }

  async query<K extends QueryKind>(query: Query<K>): Promise<QueryResults[K]> {
    if (query.kind === 'importPlan') {
      const source = await Project.initialize(query.sourceProject!, {
        nativeSpecFiles: query.sourceNativeSpecFiles,
        documentation: false,
        logger: this.callbacks.logger,
      });
      return this.project.planImport(
        source,
        query.importOptions,
      ) as QueryResults[K];
    }
    return queryLanguage(this.project, query);
  }
}
