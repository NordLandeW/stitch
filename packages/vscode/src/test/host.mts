import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function deferred<T = void>() {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = (value) => yes(value as T);
    reject = no;
  });
  return { promise, resolve, reject };
}

// The normal runner bundles this helper into a temporary CJS test file. Resolve
// tools/subjects from the package cwd, not that temporary output's __dirname.
const packageRoot = existsSync(
  path.join(process.cwd(), 'src/extension.workspace.mts'),
)
  ? process.cwd()
  : path.join(process.cwd(), 'packages/vscode');
const localRequire = createRequire(path.join(packageRoot, 'package.json'));
const source = (name: string) => path.join(packageRoot, 'src', name);
const parserSource = (name: string) =>
  path.resolve(packageRoot, '../parser/src', name);
const boundary = 'stitch-test-host-boundary';
const bundles = new Map<string, Promise<string>>();

const iterableProviders: Record<string, string> = {
  'extension.definitions': 'StitchDefinitionsProvider',
  'extension.typeDefs': 'StitchTypeDefinitionProvider',
  'extension.releases': 'StitchReleasePickerProvider',
  'extension.rename': 'StitchRenameProvider',
  includedFilesTree: 'StitchIncludedFilesTree',
  spriteSources: 'SpriteSourcesTree',
  tree: 'GameMakerTreeProvider',
  inspector: 'GameMakerInspectorProvider',
  'webview.igor': 'StitchIgorView',
  'webviews.spriteEditor': 'StitchSpriteEditorProvider',
  'extension.refs': 'StitchReferenceProvider',
  'extension.locations': 'StitchLocationsProvider',
};
const singleProviders: Record<string, string> = {
  'extension.hover': 'StitchHoverProvider',
  'extension.lens': 'StitchLensProvider',
  'extension.documentSymbols': 'StitchDocumentSymbolProvider',
  'extension.symbols': 'StitchWorkspaceSymbolProvider',
  'extension.completions': 'StitchCompletionProvider',
};

async function compileSubjects(
  realAdapters = false,
  realSpriteSources = false,
  realLogger = false,
  realTrees = false,
): Promise<string> {
  // Deliberately not a static import: esbuild must not bundle its own executable
  // locator into the test output. No production/dist files are written here.
  const esbuild = localRequire('esbuild') as typeof import('esbuild');
  const stubs = new Map<string, string>();
  const hostImport = `import host from ${JSON.stringify(boundary)};\n`;
  for (const [module, name] of Object.entries(iterableProviders)) {
    stubs.set(
      module,
      `${hostImport}export class ${name} {
      register() { return [host.registration('${name}')]; }
      static register() { return [host.registration('${name}')]; }
    }`,
    );
  }
  for (const [module, name] of Object.entries(singleProviders)) {
    stubs.set(
      module,
      `${hostImport}export class ${name} {
      static register() { return host.registration('${name}'); }
    }`,
    );
  }
  stubs.set(
    'extension.completions',
    stubs.get('extension.completions') +
      '\nexport const completionTriggerCharacters = [".", "{", "<", "|"];',
  );
  stubs.set('extension.formatting', 'export class StitchYyFormatProvider {}');
  stubs.set('tree.folder', 'export class GameMakerFolder {}');
  stubs.set(
    'extension.copyType',
    `export const createCopyAsTypeCallback = () => () => {};
    export const createCopyAsJsdocSelfCallback = () => () => {};
    export const createCopyAsJsdocTypeCallback = () => () => {};`,
  );
  stubs.set(
    'extension.projectSelection',
    `${hostImport}export const chooseGameMakerProject = (...args) => host.chooseProject(...args);`,
  );
  stubs.set(
    'registerGameMakerDebugger',
    `${hostImport}
    export function registerGameMakerDebugger(workspace, ctx) { ctx.subscriptions.push(host.registration('debugger')); }
    export function startGameMakerDebugging() { throw new Error('Unexpected debugger launch'); }`,
  );
  stubs.set(
    'extension.highlighting',
    `${hostImport}export class GameMakerSemanticTokenProvider {
    constructor() { this.resource = host.registration('semantic-owner'); }
    clear() {} refresh() {} dispose() { this.resource.dispose(); }
    register() { return host.registration('semantic-registration'); }
  }`,
  );
  stubs.set(
    '@bscotch/stitch-launcher',
    `
    export class GameMakerIde {} export class GameMakerRuntime {} export class GameMakerLauncher {}
    export function computeGameMakerBuildCommand() { throw new Error('Unexpected build'); }
    export function computeGameMakerCleanCommand() { throw new Error('Unexpected clean'); }
    export function stringifyGameMakerBuildCommand() { throw new Error('Unexpected build'); }
    export function stringifyGameMakerCleanCommand() { throw new Error('Unexpected clean'); }`,
  );
  stubs.set(
    '@bscotch/gamemaker-releases',
    `export function findReleaseFromFeeds() { throw new Error('Unexpected release discovery'); }`,
  );
  stubs.set(
    '@bscotch/gml-parser',
    `
    export { Project, setLogger } from ${JSON.stringify(parserSource('project.ts'))};
    export { Code } from ${JSON.stringify(parserSource('project.code.ts'))};
    export { Asset, isAssetOfKind } from ${JSON.stringify(parserSource('project.asset.ts'))};
    export { Reference, planReferenceRename } from ${JSON.stringify(parserSource('project.location.ts'))};
    export { primitiveNames } from ${JSON.stringify(parserSource('types.primitives.ts'))};`,
  );
  if (realAdapters)
    for (const module of [
      'extension.definitions',
      'extension.refs',
      'extension.rename',
      'extension.highlighting',
      'extension.hover',
      'extension.typeDefs',
      'extension.completions',
      'extension.symbols',
    ])
      stubs.delete(module);
  if (realTrees) {
    for (const module of [
      'tree',
      'inspector',
      'includedFilesTree',
      'tree.folder',
    ])
      stubs.delete(module);
    stubs.set(
      '@bscotch/gml-parser',
      stubs.get('@bscotch/gml-parser') +
        `
      export { assertIsAssetOfKind } from ${JSON.stringify(parserSource('project.asset.ts'))};
      export { getEventFromFilename, objectEvents } from ${JSON.stringify(parserSource('lib.objects.ts'))};`,
    );
  }
  if (realSpriteSources) {
    stubs.delete('spriteSources');
    if (!realTrees)
      stubs.set(
        'inspector',
        stubs.get('inspector') + '\nexport class ObjectSpriteItem {}',
      );
  }
  if (realSpriteSources || realTrees) {
    // Keep third-party I/O injectable, with defaults that forbid disk loading
    // or sprite transformations. Tree/watcher/lifetime behavior remains real.
    stubs.set(
      '@bscotch/sprite-source',
      `${hostImport}
      export class SpriteDest { static from(...args) { return host.spriteDestFrom(...args); } }
      export class SpriteSource { static from(...args) { return host.spriteSourceFrom(...args); } }
      export class SpriteDir { static from() { throw new Error('Unexpected SpriteDir disk loading'); } }
      export function applySpriteAction() { throw new Error('Unexpected sprite transformation'); }`,
    );
  }
  const entry = realLogger
    ? `export { Logger, logger } from ${JSON.stringify(source('log.mts'))};`
    : `
    import host from ${JSON.stringify(boundary)};
    import { pathy } from '@bscotch/pathy';
    import { Asset } from ${JSON.stringify(parserSource('project.asset.ts'))};
    import { Code } from ${JSON.stringify(parserSource('project.code.ts'))};
    import { Type } from ${JSON.stringify(parserSource('types.ts'))};
    import { Signifier } from ${JSON.stringify(parserSource('signifiers.ts'))};
    import { GameMakerProject } from ${JSON.stringify(source('extension.project.mts'))};
    export { StitchWorkspace } from ${JSON.stringify(source('extension.workspace.mts'))};
    export { activateStitchExtension } from ${JSON.stringify(source('extension.activate.mts'))};
    export { ChangeTracker } from ${JSON.stringify(source('changes.mts'))};
    export { stitchEvents } from ${JSON.stringify(source('events.mts'))};
    export { applyProjectEdits } from ${JSON.stringify(source('extension.edits.mts'))};
    export { GameMakerProject, Code, Type, Signifier };
    ${
      realAdapters
        ? `
      export { StitchDefinitionsProvider } from ${JSON.stringify(source('extension.definitions.mts'))};
      export { StitchReferenceProvider } from ${JSON.stringify(source('extension.refs.mts'))};
      export { StitchRenameProvider } from ${JSON.stringify(source('extension.rename.mts'))};
      export { StitchHoverProvider } from ${JSON.stringify(source('extension.hover.mts'))};
      export { StitchTypeDefinitionProvider } from ${JSON.stringify(source('extension.typeDefs.mts'))};
      export { StitchCompletionProvider } from ${JSON.stringify(source('extension.completions.mts'))};
      export { StitchWorkspaceSymbolProvider } from ${JSON.stringify(source('extension.symbols.mts'))};
      export { GameMakerSemanticTokenProvider, semanticTokensLegend } from ${JSON.stringify(source('extension.highlighting.mts'))};
    `
        : ''
    }
    ${realSpriteSources ? `export { SpriteSourcesTree } from ${JSON.stringify(source('spriteSources.mts'))};` : ''}
    ${
      realTrees
        ? `
      export { GameMakerTreeProvider } from ${JSON.stringify(source('tree.mts'))};
      export { GameMakerInspectorProvider } from ${JSON.stringify(source('inspector.mts'))};
      export { StitchIncludedFilesTree } from ${JSON.stringify(source('includedFilesTree.mts'))};
      export { TreeAsset, TreeCode } from ${JSON.stringify(source('tree.items.mts'))};
      export { GameMakerFolder } from ${JSON.stringify(source('tree.folder.mts'))};
    `
        : ''
    }
    // This is the disk/project-discovery boundary, not a replacement for resource
    // serialization, Code buffer ownership, analysis, or host query algorithms.
    GameMakerProject.prototype.initialize = function() { return host.initializeProject(this); };
    export function seedProject(project) {
      project.self = new Type('Struct').named('global');
      project.symbol = new Signifier(project.self, 'global', project.self);
      project.symbol.global = true; project.symbol.def = {};
      project.yyp = { name: 'memory', MetaData: { IDEVersion: '2024.11.0.0' }, resources: [],
        configs: { name: 'Default', children: [{ name: 'Test', children: [] }] }, AudioGroups: [] };
      project.config = { runtimeVersion: '2024.11.0.0' };
      project.syncIncludedFiles = async () => {};
      if (project.options?.onDiagnostics) project.onDiagnostics(project.options.onDiagnostics);
    }
    class MemoryScript extends Asset {
      constructor(project, name) {
        const resource = { id: { name, path: 'scripts/' + name + '/' + name + '.yy' } };
        super(project, resource, project.dir.join(resource.id.path));
        this.yy = { name, resourceType: 'GMScript' };
      }
    }
    export function addCode(project, name, text) {
      const asset = new MemoryScript(project, name);
      project.assets.set(name.toLowerCase(), asset); project.yyp.resources.push(asset.resource);
      const code = new Code(asset, asset.dir.join(name + '.gml'));
      asset.gmlFiles.set(code.path.absolute.toLowerCase(), code); code.content = text;
      return code;
    }
    export function replaceCode(previous, text) {
      const code = new Code(previous.asset, previous.path);
      previous.asset.gmlFiles.set(code.path.absolute.toLowerCase(), code); code.content = text;
      return code;
    }
  `;
  const result = await esbuild.build({
    stdin: {
      contents: entry,
      resolveDir: packageRoot,
      sourcefile: 'host-contract-entry.mts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    keepNames: true,
    logLevel: 'silent',
    external: [boundary],
    // Both real uses are static fallback-spec identities. Tests never load a spec.
    define: {
      'import.meta.url': JSON.stringify(
        pathToFileURL(parserSource('project.ts')).href,
      ),
    },
    plugins: [
      {
        name: 'bounded-host-boundaries',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === 'vscode')
              return { path: 'vscode', namespace: 'host-double' };
            const name = args.path.startsWith('@')
              ? args.path
              : path.basename(args.path).replace(/\.(mjs|mts)$/, '');
            if (stubs.has(name))
              return { path: name, namespace: 'host-double' };
            return undefined;
          });
          build.onLoad({ filter: /.*/, namespace: 'host-double' }, (args) => ({
            contents:
              args.path === 'vscode'
                ? `${hostImport}export default host.vscode;`
                : stubs.get(args.path)!,
            loader: 'ts',
            resolveDir: packageRoot,
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

class Disposable {
  private disposed = false;
  constructor(private readonly cleanup: () => void) {}
  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.cleanup();
    }
  }
}
class Uri {
  readonly scheme = 'file';
  readonly fsPath: string;
  readonly path: string;
  private constructor(file: string) {
    this.fsPath = path.resolve(file);
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(file: string) {
    return new Uri(file);
  }
  toString() {
    return pathToFileURL(this.fsPath).href;
  }
}
class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  translate(lineDelta = 0, characterDelta = 0) {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
}
class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
}
class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range | Position,
  ) {}
}
class WorkspaceEdit {
  readonly operations: (
    | {
        kind: 'replace';
        uri: Uri;
        range: Range;
        newText: string;
        metadata?: { label: string; needsConfirmation: boolean };
      }
    | {
        kind: 'renameFile';
        oldUri: Uri;
        newUri: Uri;
        options?: { overwrite?: boolean; ignoreIfExists?: boolean };
        metadata?: { label: string; needsConfirmation: boolean };
      }
  )[] = [];
  private readonly changes = new Map<
    string,
    { uri: Uri; edits: { range: Range; newText: string }[] }
  >();
  replace(
    uri: Uri,
    range: Range,
    newText: string,
    metadata?: { label: string; needsConfirmation: boolean },
  ) {
    this.operations.push({ kind: 'replace', uri, range, newText, metadata });
    let change = this.changes.get(uri.toString());
    if (!change) {
      change = { uri, edits: [] };
      this.changes.set(uri.toString(), change);
    }
    change.edits.push({ range, newText });
  }
  renameFile(
    oldUri: Uri,
    newUri: Uri,
    options?: { overwrite?: boolean; ignoreIfExists?: boolean },
    metadata?: { label: string; needsConfirmation: boolean },
  ) {
    this.operations.push({
      kind: 'renameFile',
      oldUri,
      newUri,
      options,
      metadata,
    });
  }
  entries() {
    return [...this.changes.values()].map(
      ({ uri, edits }) => [uri, [...edits]] as const,
    );
  }
}
class SemanticTokensLegend {
  constructor(
    readonly tokenTypes: string[],
    readonly tokenModifiers: string[],
  ) {}
}
class SemanticTokensBuilder {
  private readonly entries: {
    range: Range;
    type: string;
    modifiers: string[];
  }[] = [];
  constructor(readonly legend: SemanticTokensLegend) {}
  push(range: Range, type: string, modifiers: string[]) {
    this.entries.push({ range, type, modifiers: [...modifiers] });
  }
  // Record the actual adapter's push calls. Token classification, source-range
  // choice, filtering and deduplication remain exclusively production behavior.
  build() {
    return { data: new Uint32Array(), entries: [...this.entries] };
  }
}
class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

// Host/provider switches preserve their original seams. realLogger instead
// selects an isolated actual log.mts/log.core.mts entry, without workspace/parser.
export async function createHost(
  options: {
    realAdapters?: boolean;
    realSpriteSources?: boolean;
    realLogger?: boolean;
    realTrees?: boolean;
  } = {},
) {
  const resources: {
    label: string;
    disposed: boolean;
    disposeCalls: number;
    fireCalls?: number;
    dispose(): void;
  }[] = [];
  const timers = new Map<number, () => void>();
  const intervals = new Map<
    number,
    { callback(): void; milliseconds: number }
  >();
  let timerId = 0;
  const registrationOrder: string[] = [];
  const commandCallbacks = new Map<string, (...args: any[]) => unknown>();
  const contexts = new Map<string, unknown>();
  const contextWaiters = new Set<{
    key: string;
    value: unknown;
    resolve(): void;
  }>();
  const documents: any[] = [];
  const watchers: any[] = [];
  const treeViews: any[] = [];
  const logs: unknown[][] = [];
  const outputEvents: (
    | { kind: 'create' | 'dispose'; name: string }
    | { kind: 'append'; name: string; line: string }
  )[] = [];
  const workspaces = new Set<any>();
  const allContexts: any[] = [];
  function resource(label: string, cleanup = () => {}) {
    const result = {
      label,
      disposed: false,
      disposeCalls: 0,
      dispose() {
        result.disposeCalls++;
        if (!result.disposed) {
          result.disposed = true;
          cleanup();
        }
      },
    };
    resources.push(result);
    return result;
  }
  function event(label: string) {
    const listeners = new Set<(value: any) => unknown>();
    return {
      subscribe(callback: (value: any) => unknown) {
        listeners.add(callback);
        return resource(label, () => listeners.delete(callback));
      },
      fire(value: any) {
        for (const callback of [...listeners]) callback(value);
      },
      clear() {
        listeners.clear();
      },
      get size() {
        return listeners.size;
      },
    };
  }
  const events = {
    change: event('document-change'),
    open: event('document-open'),
    close: event('document-close'),
    configuration: event('configuration'),
    selection: event('selection'),
    activeEditor: event('active-editor'),
  };
  const settings = new Map<string, unknown>([
    ['editing.reprocessOnTypeDelay', 50],
    ['editing.externalChangeDelay', 100],
    ['editing.signatureStatus.enable', true],
    ['run.defaultConfig', 'Default'],
  ]);
  const host: any = {
    resources,
    timers,
    intervals,
    registrationOrder,
    commandCallbacks,
    contexts,
    documents,
    watchers,
    treeViews,
    logs,
    outputEvents,
    events,
    settings,
    failOutputCreation: false,
    failOutputAppend: false,
    spriteDestFrom() {
      throw new Error('Unexpected SpriteDest disk loading');
    },
    spriteSourceFrom() {
      throw new Error('Unexpected SpriteSource disk loading');
    },
    root: path.join(
      tmpdir(),
      `stitch-host-contract-${process.pid}-${createHostId++}`,
    ),
    failRegistration: undefined,
    chooseProject: async () => undefined,
    initializeProject: async (project: any) =>
      host.subject.seedProject(project),
    registration(label: string, cleanup = () => {}) {
      registrationOrder.push(label);
      if (label === host.failRegistration)
        throw new Error(`Registration failed: ${label}`);
      return resource(label, cleanup);
    },
    waitForContext(key: string, value: unknown) {
      if (contexts.get(key) === value) return Promise.resolve();
      return new Promise<void>((resolve) =>
        contextWaiters.add({ key, value, resolve }),
      );
    },
    context() {
      const state = new Map<string, unknown>();
      const ctx = {
        subscriptions: [] as any[],
        extensionMode: 1,
        extensionPath: packageRoot,
        workspaceState: {
          get: (key: string) => state.get(key),
          update: async (key: string, value: unknown) => {
            state.set(key, value);
          },
        },
      };
      allContexts.push(ctx);
      return ctx;
    },
  };
  function statusBar() {
    const result = Object.assign(resource('status-bar'), {
      text: '',
      visible: false,
      hide() {
        result.visible = false;
      },
      show() {
        result.visible = true;
      },
    });
    return result;
  }
  host.vscode = {
    Uri,
    Position,
    Range,
    Location,
    WorkspaceEdit,
    RelativePattern,
    Disposable,
    SemanticTokensLegend,
    SemanticTokensBuilder,
    TreeItem: class {
      constructor(readonly label: string) {}
    },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
      private readonly source = event('semantic-event');
      private readonly resource = Object.assign(
        resource('semantic-emitter', () => this.source.clear()),
        { fireCalls: 0 },
      );
      readonly event = this.source.subscribe;
      fire(value?: unknown) {
        this.resource.fireCalls++;
        this.source.fire(value);
      }
      dispose() {
        this.resource.dispose();
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    MarkdownString: class {
      readonly codeBlocks: { value: string; language?: string }[] = [];
      readonly markdown: string[] = [];
      appendCodeblock(value: string, language?: string) {
        this.codeBlocks.push({ value, language });
        return this;
      }
      appendMarkdown(value: string) {
        this.markdown.push(value);
        return this;
      }
    },
    Hover: class {
      constructor(readonly contents: any) {}
    },
    CompletionItem: class {
      constructor(
        public label: any,
        public kind: number,
      ) {}
    },
    CompletionItemKind: {
      Enum: 1,
      Constructor: 2,
      Function: 3,
      Variable: 4,
      Interface: 5,
    },
    SymbolInformation: class {
      constructor(
        public name: string,
        public kind: number,
        public containerName: string,
        public location: Location,
      ) {}
    },
    SymbolKind: {
      File: 0,
      Module: 1,
      Class: 4,
      Method: 5,
      Property: 6,
      Field: 7,
      Constructor: 8,
      Enum: 9,
      Function: 11,
      Variable: 12,
      Constant: 13,
      EnumMember: 21,
    },
    ExtensionMode: { Development: 2, Production: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      textDocuments: documents,
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (key: string) => settings.get(key) }),
      onDidChangeTextDocument: events.change.subscribe,
      onDidOpenTextDocument: events.open.subscribe,
      onDidCloseTextDocument: events.close.subscribe,
      onDidChangeConfiguration: events.configuration.subscribe,
      createFileSystemWatcher(pattern: RelativePattern) {
        const create = event('watch-create'),
          change = event('watch-change'),
          remove = event('watch-delete');
        const watcher = Object.assign(
          resource(`watcher:${pattern.pattern}`, () => {
            create.clear();
            change.clear();
            remove.clear();
          }),
          {
            pattern: pattern.pattern,
            onDidCreate: create.subscribe,
            onDidChange: change.subscribe,
            onDidDelete: remove.subscribe,
            create: create.fire,
            change: change.fire,
            delete: remove.fire,
          },
        );
        watchers.push(watcher);
        return watcher;
      },
    },
    window: {
      activeTextEditor: undefined,
      createStatusBarItem: statusBar,
      onDidChangeTextEditorSelection: events.selection.subscribe,
      onDidChangeActiveTextEditor(callback: (value: any) => unknown) {
        if (host.failRegistration === 'active-editor')
          throw new Error('Registration failed: active-editor');
        return events.activeEditor.subscribe(callback);
      },
      createTreeView(name: string, options: { treeDataProvider: unknown }) {
        const view = Object.assign(host.registration(`tree-view:${name}`), {
          name,
          treeDataProvider: options.treeDataProvider,
        });
        treeViews.push(view);
        return view;
      },
      createOutputChannel(name: string) {
        outputEvents.push({ kind: 'create', name });
        if (host.failOutputCreation)
          throw new Error('Output channel creation failed');
        const channel = Object.assign(
          resource(`output:${name}`, () =>
            outputEvents.push({ kind: 'dispose', name }),
          ),
          {
            appendLine(line: string) {
              outputEvents.push({ kind: 'append', name, line });
              if (channel.disposed || host.failOutputAppend)
                throw new Error('Output channel append failed');
              logs.push([name, line]);
            },
          },
        );
        return channel;
      },
      withProgress: async (
        _options: unknown,
        task: (progress: any) => Promise<unknown>,
      ) => task({ report() {} }),
      showErrorMessage: async (message: unknown) => {
        logs.push(['message', message]);
      },
    },
    languages: {
      createDiagnosticCollection() {
        const entries = new Map<string, any[]>();
        const collection = Object.assign(
          resource('diagnostics', () => entries.clear()),
          {
            entries,
            set(uri: Uri, diagnostics: any[]) {
              if (collection.disposed) throw new Error('Disposed diagnostics');
              entries.set(uri.toString(), diagnostics);
            },
            delete(uri: Uri) {
              entries.delete(uri.toString());
            },
            clear() {
              entries.clear();
            },
          },
        );
        return collection;
      },
      registerDefinitionProvider: () =>
        host.registration('StitchDefinitionsProvider'),
      registerReferenceProvider: () =>
        host.registration('StitchReferenceProvider'),
      registerRenameProvider: () => host.registration('StitchRenameProvider'),
      registerHoverProvider: () => host.registration('StitchHoverProvider'),
      registerTypeDefinitionProvider: () =>
        host.registration('StitchTypeDefinitionProvider'),
      registerCompletionItemProvider: () =>
        host.registration('StitchCompletionProvider'),
      registerDocumentSemanticTokensProvider: () =>
        host.registration('semantic-registration'),
      registerSignatureHelpProvider: () =>
        host.registration('signature-provider'),
      registerDocumentFormattingEditProvider: () =>
        host.registration('yy-format-provider'),
    },
    commands: {
      registerCommand(name: string, callback: (...args: any[]) => unknown) {
        const registration = host.registration(`command:${name}`, () => {
          if (commandCallbacks.get(name) === callback)
            commandCallbacks.delete(name);
        });
        commandCallbacks.set(name, callback);
        return registration;
      },
      executeCommand: async (name: string, key: string, value: unknown) => {
        if (name !== 'setContext')
          throw new Error(`Unexpected command ${name}`);
        contexts.set(key, value);
        for (const waiter of [...contextWaiters])
          if (waiter.key === key && waiter.value === value) {
            contextWaiters.delete(waiter);
            waiter.resolve();
          }
      },
    },
  };
  host.console = Object.fromEntries(
    ['debug', 'info', 'log', 'warn', 'error', 'dir'].map((level) => [
      level,
      (...args: unknown[]) => logs.push([level, ...args]),
    ]),
  );
  const module = { exports: {} };
  const mode = JSON.stringify([
    !!options.realAdapters,
    !!options.realSpriteSources,
    !!options.realLogger,
    !!options.realTrees,
  ]);
  let compiled = bundles.get(mode);
  if (!compiled) {
    compiled = compileSubjects(
      !!options.realAdapters,
      !!options.realSpriteSources,
      !!options.realLogger,
      !!options.realTrees,
    );
    bundles.set(mode, compiled);
  }
  const code = await compiled;
  const schedule = (callback: () => void) => {
    const id = ++timerId;
    timers.set(id, callback);
    return id;
  };
  const scheduleInterval = (callback: () => void, milliseconds: number) => {
    const id = schedule(callback);
    intervals.set(id, { callback, milliseconds });
    return id;
  };
  new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    'console',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    code,
  )(
    (id: string) => (id === boundary ? host : localRequire(id)),
    module,
    module.exports,
    source('host-contract-entry.mts'),
    path.dirname(source('host-contract-entry.mts')),
    host.console,
    schedule,
    (id: number) => timers.delete(id),
    scheduleInterval,
    (id: number) => {
      intervals.delete(id);
      timers.delete(id);
    },
  );
  host.subject = module.exports;
  host.ctx = host.context();
  host.newWorkspace = (ctx = host.ctx) => {
    const workspace = new host.subject.StitchWorkspace(ctx);
    workspaces.add(workspace);
    return workspace;
  };
  host.activate = async (ctx = host.ctx) => {
    const workspace = await host.subject.StitchWorkspace.activate(ctx);
    workspaces.add(workspace);
    return workspace;
  };
  host.project = async () =>
    host.subject.GameMakerProject.from(
      Uri.file(path.join(host.root, 'memory.yyp')),
      () => {},
      () => {},
    );
  host.document = (codeFile: any, text: string) => {
    const document = {
      uri: Uri.file(codeFile.path.absolute),
      languageId: 'gml',
      version: 1,
      isClosed: false,
      getText: (range?: Range) =>
        range
          ? text.slice(
              document.offsetAt(range.start),
              document.offsetAt(range.end),
            )
          : text,
      get lineCount() {
        return text.split('\n').length;
      },
      lineAt: (line: number) => ({ text: text.split('\n')[line] }),
      offsetAt: (position: Position) =>
        text
          .split('\n')
          .slice(0, position.line)
          .reduce((offset, line) => offset + line.length + 1, 0) +
        position.character,
      positionAt(offset: number) {
        const prefix = text.slice(0, offset).split('\n');
        return new Position(
          prefix.length - 1,
          prefix[prefix.length - 1].length,
        );
      },
      setText(value: string) {
        text = value;
        document.version++;
      },
    };
    return document;
  };
  host.disposeContext = (ctx: any) => {
    for (const disposable of ctx.subscriptions.splice(0)) disposable.dispose();
  };
  host.dispose = () => {
    for (const ctx of allContexts) host.disposeContext(ctx);
    for (const workspace of workspaces) workspace.dispose();
    for (const item of resources) item.dispose();
    timers.clear();
    intervals.clear();
  };
  return host;
}
let createHostId = 0;
