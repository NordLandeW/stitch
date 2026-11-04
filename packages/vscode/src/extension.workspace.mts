import {
  Project,
  type Asset,
  type Code,
  type DiagnosticsEventPayload,
  type OnDiagnostics,
} from '@bscotch/gml-parser';
import { Yy, yypSchema } from '@bscotch/yy';
import { randomUUID } from 'node:crypto';
import vscode from 'vscode';
import { assertLoudly } from './assert.mjs';
import { ChangeTracker } from './changes.mjs';
import { stitchConfig } from './config.mjs';
import {
  diagnosticCollection,
  normalizeDiagnosticsEvents,
} from './diagnostics.mjs';
import { stitchEvents } from './events.mjs';
import { activateStitchExtension } from './extension.activate.mjs';
import { completionTriggerCharacters } from './extension.completions.mjs';
import { WorkerLanguageService, cancellable } from './language/client.mjs';
import type {
  DiagnosticSnapshot,
  LanguageService,
  Overlay,
  Query,
  QueryKind,
  QueryResults,
  RenamePlan,
  Selection,
} from './language/protocol.mjs';
import { displayRange, displaySignature } from './language/presentation.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GameMakerSemanticTokenProvider } from './extension.highlighting.mjs';
import { GameMakerProject } from './extension.project.mjs';
import {
  activeTab,
  isSpriteTab,
  openPath,
  pathyFromUri,
  showProgress,
} from './lib.mjs';
import { info, logger, warn, showErrorMessage } from './log.mjs';

export class StitchWorkspace implements vscode.SignatureHelpProvider {
  readonly semanticHighlightProvider = new GameMakerSemanticTokenProvider(this);
  readonly signatureHelpStatus = vscode.window.createStatusBarItem(
    stitchConfig.functionSignatureStatusAlignment,
    stitchConfig.functionSignatureStatusAlignment ===
      vscode.StatusBarAlignment.Left
      ? -Infinity
      : Infinity,
  );
  readonly diagnosticCollection = diagnosticCollection;
  readonly externalChangeTracker = new ChangeTracker(this);

  projects: GameMakerProject[] = [];

  private disposed = false;
  private readonly languages = new Map<Project, LanguageService>();
  private readonly bufferSnapshots = new Map<
    string,
    { document: vscode.TextDocument; overlay: Overlay }
  >();
  private nextDocumentGeneration = 0;
  private readonly renameRevisions = new WeakMap<
    object,
    { language: number; resources: number }
  >();
  private readonly resourceSubscriptions = new Map<Project, () => void>();
  private readonly nativeWatchers = new Map<Project, vscode.Disposable[]>();

  private watchNativeInputs(project: GameMakerProject) {
    for (const watcher of this.nativeWatchers.get(project) || [])
      watcher.dispose();
    const subscriptions: vscode.Disposable[] = [];
    for (const file of project.nativeSpecFiles) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(path.dirname(file)),
          path.basename(file),
        ),
      );
      const changed = () => {
        if (this.disposed || !this.projects.includes(project)) return;
        this.markExternalChange();
        this.language(project).update(
          { kind: 'native', files: project.nativeSpecFiles },
          true,
        );
      };
      subscriptions.push(
        watcher,
        watcher.onDidChange(changed),
        watcher.onDidCreate(changed),
        watcher.onDidDelete(changed),
      );
    }
    this.nativeWatchers.set(project, subscriptions);
  }

  private resourceRevision = 0;
  private readonly pendingDiagnostics = new Map<
    Project,
    Map<string, DiagnosticSnapshot>
  >();

  markExternalChange() {
    this.resourceRevision++;
  }

  publishPendingDiagnostics() {
    if (this.disposed || this.externalChangeTracker.hasPending) return;
    for (const [project, snapshots] of this.pendingDiagnostics) {
      if (!project.sourcesCurrent || !this.languages.get(project)?.isCurrent)
        continue;
      for (const snapshot of snapshots.values())
        this.emitDiagnosticSnapshot(snapshot);
      snapshots.clear();
    }
  }

  protected createLanguageService(project: GameMakerProject): LanguageService {
    const service = new WorkerLanguageService(
      {
        yypPath: project.yypPath.absolute,
        configuration: project.analysisConfiguration,
        nativeSpecFiles: project.nativeSpecFiles,
        autoDeclareGlobalsPrefixes: stitchConfig.autoDeclaredGlobalsPrefixes,
      },
      path.join(this.ctx.extensionPath, 'dist/language-worker.js'),
      {
        delay: () => stitchConfig.reprocessOnTypeDelay,
        onCommit: (diagnostics) => {
          if (
            this.disposed ||
            !this.projects.includes(project) ||
            this.languages.get(project) !== service
          )
            return;
          let pending = this.pendingDiagnostics.get(project);
          if (!pending)
            this.pendingDiagnostics.set(project, (pending = new Map()));
          for (const snapshot of diagnostics)
            pending.set(snapshot.path, snapshot);
          this.publishPendingDiagnostics();
          this.semanticHighlightProvider.refresh();
        },
        onError: (error) => {
          logger.error(error);
          if (!this.disposed)
            void showErrorMessage(
              'Stitch language analysis stopped. Resource operations remain available; precise language results are temporarily unavailable.',
              'Retry analysis',
            ).then((choice) => {
              if (choice === 'Retry analysis')
                void this.retryLanguageService(project, service).catch(
                  (error) => logger.error(error),
                );
            });
        },
        onLog: (level, message) => logger[level](message),
      },
    );
    return service;
  }

  private language(project: GameMakerProject): LanguageService {
    let service = this.languages.get(project);
    if (!service) {
      service = this.createLanguageService(project);
      this.languages.set(project, service);
    }
    return service;
  }

  /** Explicit, bounded recovery: a new session reads current disk and overlays. */
  async retryLanguageService(
    project: GameMakerProject,
    expected?: LanguageService,
  ): Promise<boolean> {
    if (
      this.disposed ||
      !this.projects.includes(project) ||
      (expected && this.languages.get(project) !== expected)
    )
      return false;
    await this.externalChangeTracker.retryPending();
    await project.whenSourcesCurrent();
    if (
      this.disposed ||
      !this.projects.includes(project) ||
      (expected && this.languages.get(project) !== expected)
    )
      return false;
    this.languages.get(project)?.dispose();
    this.languages.delete(project);
    this.pendingDiagnostics.delete(project);
    this.resourceRevision++;
    for (const [uri, snapshot] of this.bufferSnapshots)
      if (this.getProject(snapshot.document) === project)
        this.bufferSnapshots.delete(uri);
    for (const asset of project.assets.values())
      for (const code of asset.gmlFiles.values())
        this.diagnosticCollection.delete(vscode.Uri.file(code.path.absolute));
    this.language(project);
    this.syncBuffers(project);
    return this.language(project).flush();
  }

  private emitDiagnosticSnapshot(snapshot: DiagnosticSnapshot) {
    if (this.disposed) return;
    const uri = vscode.Uri.file(snapshot.path);
    const document = this.openDocument(uri);
    if (
      document &&
      snapshot.text !== undefined &&
      snapshot.text !== document.getText()
    )
      return;
    if (
      stitchConfig.suppressDiagnosticsInGroups.some(
        (group) =>
          snapshot.folder === `folders/${group}.yy` ||
          snapshot.folder?.startsWith(`folders/${group}/`),
      )
    )
      return;
    this.diagnosticCollection.set(
      uri,
      snapshot.diagnostics.map((diagnostic) => ({
        range: displayRange(diagnostic.range),
        message: diagnostic.message,
        severity:
          diagnostic.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : diagnostic.severity === 'info'
              ? vscode.DiagnosticSeverity.Information
              : vscode.DiagnosticSeverity.Warning,
        source: 'stitch',
      })),
    );
  }

  protected constructor(readonly ctx: vscode.ExtensionContext) {
    this.signatureHelpStatus.hide();
  }

  clearDiagnosticsInGroups(groups: string[]) {
    if (!groups.length) return;
    for (const project of this.projects) {
      for (const [, asset] of project.assets) {
        for (const group of groups) {
          if (asset.isInFolder(group)) {
            for (const [, code] of asset.gmlFiles) {
              this.diagnosticCollection.delete(
                vscode.Uri.file(code.path.absolute),
              );
            }
          }
        }
      }
    }
  }

  /**
   * Emit a collection of diagnostics for a particular file. */
  emitDiagnostics(payload: DiagnosticsEventPayload) {
    if (this.disposed) return;
    const document = this.openDocument(vscode.Uri.file(payload.filePath));
    if (document && payload.code && document.getText() !== payload.code.content)
      return;
    const suppresedGroups = stitchConfig.suppressDiagnosticsInGroups;
    for (const group of suppresedGroups) {
      if (payload.code?.asset.isInFolder(group)) {
        // Then skip this file!
        return;
      }
    }
    this.diagnosticCollection.set(
      vscode.Uri.file(payload.filePath),
      normalizeDiagnosticsEvents(payload, document),
    );
  }

  clearProjects() {
    for (const unsubscribe of this.resourceSubscriptions.values())
      unsubscribe();
    this.resourceSubscriptions.clear();
    for (const watchers of this.nativeWatchers.values())
      for (const watcher of watchers) watcher.dispose();
    this.nativeWatchers.clear();
    for (const project of this.projects)
      project.onAnalysisConfiguration = undefined;
    for (const service of this.languages.values()) service.dispose();
    this.languages.clear();
    this.bufferSnapshots.clear();
    this.pendingDiagnostics.clear();
    this.resourceRevision++;
    this.diagnosticCollection.clear();
    this.projects = [];
    void vscode.commands.executeCommand(
      'setContext',
      'stitch.projectCount',
      this.projects.length,
    );
  }

  async loadProject(yypPath: vscode.Uri, onDiagnostics: OnDiagnostics) {
    let project!: GameMakerProject;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Stitch: Loading project from ${pathyFromUri(yypPath).basename}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({
          increment: 0,
        });
        project = await GameMakerProject.from(
          yypPath,
          onDiagnostics,
          (percent, message) => {
            progress.report({
              increment: percent,
              message,
            });
          },
        );
        try {
          this.selectAnalysisConfiguration(
            project,
            this.configuredRunConfiguration(project),
          );
        } catch (error) {
          void showErrorMessage(
            `${String(error)}. Analysis remains on ${project.analysisConfiguration}.`,
          );
        }
        try {
          await project.syncIncludedFiles();
        } catch {}
        this.projects.push(project);
        this.watchNativeInputs(project);
        this.resourceSubscriptions.set(
          project,
          project.onResourceChange((file) =>
            this.externalChangeTracker.addChange({
              uri: vscode.Uri.file(file),
              type: 'change',
            }),
          ),
        );
        project.onAnalysisConfiguration = (name) =>
          this.language(project).update({ kind: 'configuration', name }, true);
        this.syncBuffers(project);
        // A failed language startup keeps resource UI available and offers Retry.
        try {
          await this.language(project).flush();
        } catch (error) {
          logger.error(error);
        }
        progress.report({ increment: 100, message: 'Done!' });
      },
    );
    void vscode.commands.executeCommand(
      'setContext',
      'stitch.projectCount',
      this.projects.length,
    );
    return project;
  }

  savedRunOptions(
    project: Project,
  ): { config: string; compiler?: 'vm' | 'yyc' } | undefined {
    const saved = this.ctx.workspaceState.get<{
      config?: unknown;
      compiler?: unknown;
    }>('lastRunConfig');
    if (!saved || typeof saved.config !== 'string' || !('compiler' in saved))
      return;
    // The last target belongs to the workspace; another project may not define it.
    if (saved.config && !project.configs.includes(saved.config)) return;
    return {
      config: saved.config,
      compiler:
        saved.compiler === 'vm' || saved.compiler === 'yyc'
          ? saved.compiler
          : undefined,
    };
  }

  private configuredRunConfiguration(project: Project): string | undefined {
    return (
      (this.savedRunOptions(project)?.config ??
        stitchConfig.runConfigDefault) ||
      undefined
    );
  }

  selectAnalysisConfiguration(project: Project, configuration?: string) {
    project.setAnalysisConfiguration(configuration);
    if (
      this.projects.includes(project as GameMakerProject) &&
      !(project as GameMakerProject).onAnalysisConfiguration
    )
      this.language(project as GameMakerProject).update(
        { kind: 'configuration', name: configuration },
        true,
      );
    this.semanticHighlightProvider.refresh();
  }

  refreshAnalysisConfigurations() {
    for (const project of this.projects) {
      try {
        this.selectAnalysisConfiguration(
          project,
          this.configuredRunConfiguration(project),
        );
      } catch (error) {
        void showErrorMessage(
          `${String(error)}. Analysis remains on ${project.analysisConfiguration}.`,
        );
      }
    }
  }

  async reloadAsset(asset: Asset) {
    const project = asset.project as GameMakerProject;
    this.syncBuffers(project);
    this.language(project).update({ kind: 'asset', name: asset.name }, true);
    await asset.reload((code) =>
      this.openDocument(vscode.Uri.file(code.path.absolute))?.getText(),
    );
    await this.language(project).flush();
  }

  async reloadProject(project: GameMakerProject) {
    this.syncBuffers(project);
    const previousIde = project.ideVersion;
    this.markExternalChange();
    await project.reloadYyp();
    this.language(project).update(
      { kind: 'project', configuration: project.analysisConfiguration },
      true,
    );
    if (previousIde !== project.ideVersion)
      await this.reloadNativeInputs(project);
    await this.language(project).flush();
  }

  async reloadNativeInputs(project: GameMakerProject) {
    await project.reloadConfig();
    const files = await project.resolveNativeSpecFiles();
    this.watchNativeInputs(project);
    this.language(project).update({ kind: 'native', files }, true);
    await this.language(project).flush();
  }

  refreshAnalysisSettings() {
    for (const project of this.projects)
      this.language(project).update(
        {
          kind: 'settings',
          prefixes: stitchConfig.autoDeclaredGlobalsPrefixes,
        },
        true,
      );
  }

  async deleteAsset(asset: Asset) {
    await asset.project.removeAssetByName(asset.name);
    this.language(asset.project as GameMakerProject).update(
      { kind: 'project', configuration: asset.project.analysisConfiguration },
      true,
    );
    stitchEvents.emit('asset-deleted', asset);
  }

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<vscode.SignatureHelp | undefined> {
    const signature = await this.query(
      document,
      { kind: 'signature', offset: document.offsetAt(position) },
      token,
    );
    return signature && displaySignature(signature);
  }

  private syncBuffers(project: GameMakerProject) {
    const versions: { document: vscode.TextDocument; version: number }[] = [];
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.isClosed ||
        document.languageId !== 'gml' ||
        document.uri.scheme !== 'file' ||
        this.getProject(document) !== project
      )
        continue;
      this.acceptBuffer(project, document);
      versions.push({ document, version: document.version });
    }
    return versions;
  }

  private acceptBuffer(
    project: GameMakerProject,
    document: vscode.TextDocument,
    immediate = false,
  ) {
    const key = document.uri.toString();
    const prior = this.bufferSnapshots.get(key);
    if (
      prior?.document === document &&
      prior.overlay.version === document.version
    )
      return;
    const overlay: Overlay = {
      path: document.uri.fsPath,
      text: document.getText(),
      version: document.version,
      generation:
        prior?.document === document
          ? prior.overlay.generation
          : ++this.nextDocumentGeneration,
    };
    this.bufferSnapshots.set(key, { document, overlay });
    this.language(project).update({ kind: 'document', ...overlay }, immediate);
  }

  async query<K extends QueryKind>(
    document: vscode.TextDocument,
    query: Omit<Query<K>, 'path'>,
    token?: vscode.CancellationToken,
  ): Promise<QueryResults[K] | undefined> {
    if (
      this.disposed ||
      document.isClosed ||
      token?.isCancellationRequested ||
      document.languageId !== 'gml' ||
      document.uri.scheme !== 'file'
    )
      return;
    const project = this.getProject(document);
    if (!project) return;
    const version = document.version;
    const result = await this.queryProject(
      project,
      { ...query, path: document.uri.fsPath },
      token,
    );
    if (
      this.disposed ||
      document.isClosed ||
      document.version !== version ||
      token?.isCancellationRequested ||
      this.getProject(document) !== project
    )
      return;
    return result;
  }

  async queryProject<K extends QueryKind>(
    project: GameMakerProject,
    query: Query<K>,
    token?: vscode.CancellationToken,
  ): Promise<QueryResults[K] | undefined> {
    if (
      this.disposed ||
      !this.projects.includes(project) ||
      token?.isCancellationRequested
    )
      return;
    if (
      (await cancellable(
        this.externalChangeTracker.flushPending().then(() => true),
        token,
      )) !== true
    )
      return;
    if (
      (await cancellable(
        project.whenSourcesCurrent().then(() => true),
        token,
      )) !== true
    )
      return;
    const resources = this.resourceRevision;
    const versions = this.syncBuffers(project);
    const service = this.language(project);
    const revision = service.revision;
    const result = await service.query(query, token);
    if (
      this.disposed ||
      !this.projects.includes(project) ||
      token?.isCancellationRequested ||
      revision !== service.revision ||
      resources !== this.resourceRevision ||
      versions.some(
        ({ document, version }) =>
          document.isClosed || document.version !== version,
      )
    )
      return;
    if (
      (query.kind === 'rename' ||
        query.kind === 'assetRename' ||
        query.kind === 'importPlan') &&
      result
    )
      this.renameRevisions.set(result as object, {
        language: revision,
        resources,
      });
    return result;
  }

  /** Compatibility barrier for consumers of resource/file identity, not a graph. */
  async ensureDocumentCurrent(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
    _immediate = true,
  ): Promise<Code | undefined> {
    if (
      this.disposed ||
      document.isClosed ||
      token?.isCancellationRequested ||
      document.languageId !== 'gml' ||
      document.uri.scheme !== 'file'
    )
      return;
    const project = this.getProject(document);
    if (!project) return;
    await project.whenSourcesCurrent();
    const versions = this.syncBuffers(project);
    if (
      !(await this.language(project).flush(token)) ||
      versions.some(
        ({ document, version }) =>
          document.isClosed || document.version !== version,
      )
    )
      return;
    return this.getGmlFile(document);
  }

  ensureProjectCurrent(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
  ) {
    return this.ensureDocumentCurrent(document, token);
  }

  async validateRenamePlan(
    document: vscode.TextDocument,
    plan: RenamePlan,
    token?: vscode.CancellationToken,
  ): Promise<boolean> {
    const project = this.getProject(document);
    return !!project && this.validateSourcePlan(project, plan, token);
  }

  private async validateSourcePlan(
    project: GameMakerProject,
    plan: { sources: { path: string; text: string }[] },
    token?: vscode.CancellationToken,
  ): Promise<boolean> {
    const service = this.language(project),
      revision = this.renameRevisions.get(plan);
    if (
      !revision ||
      revision.language !== service.revision ||
      revision.resources !== this.resourceRevision
    )
      return false;
    const opened: { document: vscode.TextDocument; version: number }[] = [];
    for (const source of plan.sources) {
      if (token?.isCancellationRequested) return false;
      const doc = this.openDocument(vscode.Uri.file(source.path));
      if (doc) {
        if (doc.getText() !== source.text) return false;
        opened.push({ document: doc, version: doc.version });
      } else if ((await readFile(source.path, 'utf8')) !== source.text)
        return false;
    }
    return (
      !this.disposed &&
      !token?.isCancellationRequested &&
      service.revision === revision.language &&
      this.resourceRevision === revision.resources &&
      opened.every(
        ({ document, version }) =>
          !document.isClosed && document.version === version,
      )
    );
  }

  async renameAsset(asset: Asset, to: string) {
    const project = asset.project as GameMakerProject;
    const plan = await this.queryProject(project, {
      kind: 'assetRename',
      assetName: asset.name,
      newName: to,
    });
    assertLoudly(
      plan && (await this.validateSourcePlan(project, plan)),
      'Asset inputs changed while planning rename. Try again.',
    );
    const assertSaved = (files: readonly { path: string }[]) => {
      const paths = new Set(
        files.map((file) => vscode.Uri.file(file.path).toString()),
      );
      assertLoudly(
        !vscode.workspace.textDocuments.some(
          (document) =>
            !document.isClosed &&
            document.isDirty &&
            (paths.has(document.uri.toString()) ||
              asset.dir.isParentOf(pathyFromUri(document))),
        ),
        'Save modified files affected by this resource rename, then try again. Resource renames write to disk and do not enter editor Undo.',
      );
    };
    assertSaved(plan.sources);
    try {
      await project.renameAsset(asset.name, to, {
        plan,
        validate: async (batch) => {
          assertSaved(batch.texts);
          const versions: { document: vscode.TextDocument; version: number }[] =
            [];
          for (const text of batch.texts) {
            const opened = this.openDocument(vscode.Uri.file(text.path));
            if (opened) {
              if (opened.getText() !== text.before) return false;
              versions.push({ document: opened, version: opened.version });
            }
          }
          return (
            (await this.validateSourcePlan(project, plan)) &&
            versions.every(
              ({ document, version }) =>
                !document.isClosed &&
                document.version === version &&
                !document.isDirty,
            )
          );
        },
      });
    } finally {
      // Read actual disk state after either a committed command or its recovery.
      this.markExternalChange();
      this.language(project).update(
        { kind: 'project', configuration: project.analysisConfiguration },
        true,
      );
    }
  }

  async importAssets(
    project: GameMakerProject,
    source: Project,
    options: import('@bscotch/gml-parser').ImportModuleOptions,
  ) {
    const plan = await this.queryProject(project, {
      kind: 'importPlan',
      sourceProject: source.yypPath.absolute,
      sourceNativeSpecFiles: source.nativeSpecFiles,
      importOptions: options,
    });
    assertLoudly(
      plan && (await this.validateSourcePlan(project, plan)),
      'Import inputs changed while planning. Save source files and try again.',
    );
    assertLoudly(
      !this.openDocument(vscode.Uri.file(project.yypPath.absolute))?.isDirty,
      'Save the modified target YYP before importing resources.',
    );
    for (const entry of plan.assets) {
      if (entry.skip) continue;
      const imported = source.getAssetByName(entry.name, {
        assertExists: true,
      });
      const targetDirectory = project.dir.join(
        imported.dir.relativeFrom(source.dir),
      );
      assertLoudly(
        !vscode.workspace.textDocuments.some(
          (document) =>
            !document.isClosed &&
            document.isDirty &&
            targetDirectory.isParentOf(pathyFromUri(document)),
        ),
        'Save or close modified target resource documents before importing over them.',
      );
    }
    const result = await project.import(
      source,
      options,
      plan,
      async (file) =>
        this.openDocument(vscode.Uri.file(file))?.getText() ??
        readFile(file, 'utf8'),
    );
    this.language(project).update(
      { kind: 'project', configuration: project.analysisConfiguration },
      true,
    );
    return result;
  }

  private openDocument(uri: vscode.Uri) {
    return vscode.workspace.textDocuments.find(
      (document) =>
        !document.isClosed && document.uri.toString() === uri.toString(),
    );
  }

  async onChangeFile(uri: vscode.Uri): Promise<void> {
    if (this.disposed) return;
    const project = this.getProject(uri);
    if (!project) return;
    const open = this.openDocument(uri);
    if (open) this.acceptBuffer(project, open, true);
    else
      this.language(project).update({ kind: 'disk', path: uri.fsPath }, true);
    await this.language(project).flush();
  }

  async onCloseDoc(document: vscode.TextDocument): Promise<void> {
    if (
      document.languageId !== 'gml' ||
      document.uri.scheme !== 'file' ||
      this.disposed
    )
      return;
    const project = this.getProject(document),
      key = document.uri.toString();
    const prior = this.bufferSnapshots.get(key);
    if (prior && prior.document !== document) return;
    if (prior?.document === document) this.bufferSnapshots.delete(key);
    if (!project) return;
    this.language(project).update(
      {
        kind: 'close',
        path: document.uri.fsPath,
        generation: prior?.overlay.generation || 0,
      },
      true,
    );
    await this.language(project).flush();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearProjects();
    this.externalChangeTracker.dispose();
    this.semanticHighlightProvider.dispose();
  }

  getActiveDocument(): vscode.TextDocument | undefined {
    return vscode.window.activeTextEditor?.document;
  }

  getActiveProject(): GameMakerProject | undefined {
    const doc = this.getActiveDocument();
    const project = doc ? this.getProject(doc) : undefined;
    return project || this.projects[0];
  }

  /** Given a URI, get the project that contains that file */
  getProject(
    document: vscode.TextDocument | vscode.Uri,
  ): GameMakerProject | undefined {
    if (!document) {
      return;
    }
    return this.projects.find((p) => p.includesFile(document));
  }

  /** If there is only one project in the workspace, return it. Otherwise prompt the user. */
  async chooseProject(
    title = 'Choose a project',
  ): Promise<GameMakerProject | undefined> {
    if (this.projects.length === 1) {
      return this.projects[0];
    }
    // Create a quickpick
    const projectName = await vscode.window.showQuickPick(
      this.projects.map((p) => p.name),
      { title },
    );
    if (!projectName) return;
    return this.projects.find((p) => p.name === projectName);
  }

  getSprite(
    document: vscode.TextDocument,
    name: string,
  ): Asset<'sprites'> | undefined {
    const asset = this.getAsset(document, name);
    if (asset && asset.assetKind === 'sprites') {
      return asset as Asset<'sprites'>;
    }
    return;
  }

  getCurrentAsset() {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    if (isSpriteTab(tab)) {
      // Then we have the asset name, get the first project
      // that has that name.
      const project = this.projects.find((p) =>
        p.getAssetByName(tab.assetName),
      );
      return project?.getAssetByName(tab.assetName);
    }
    // Otherwise we have a full URI so we can find the project
    // and asset.
    const currentProject = this.getProject(tab.uri);
    return currentProject?.getAsset(pathyFromUri(tab.uri));
  }

  getAsset(document: vscode.TextDocument, name?: string): Asset | undefined {
    const project = this.getProject(document);
    if (!project) {
      warn(`getAsset: Could not find project for`, document);
      return;
    }
    name ||= pathyFromUri(document).name;
    const asset = project.getAssetByName(name);
    return asset;
  }

  getGmlFile(
    document: vscode.TextDocument | vscode.Uri | undefined,
  ): Code | undefined {
    document ||= this.getActiveDocument();
    if (!document) {
      // warn(`getGmlFile: Could not find document`);
      return;
    }
    const path = pathyFromUri(document);
    if (!path.hasExtension('gml')) return;
    const project = this.getProject(document);
    if (!project) {
      warn(`getGmlFile: Could not find project for`, path);
      return;
    }
    const file = project.getGmlFile(path);
    if (!file) {
      warn(`getGmlFile: Could not find file for ${path.absolute}`);
      return;
    }
    return file;
  }

  async getSelection(
    document?: vscode.TextDocument,
    selections?: readonly vscode.Selection[],
  ): Promise<Selection | undefined> {
    document ||= vscode.window.activeTextEditor?.document;
    selections ||= vscode.window.activeTextEditor?.selections;
    if (!document || !selections?.length) return;
    return this.query(document, {
      kind: 'selection',
      offset: document.offsetAt(selections[0].start),
    });
  }

  async getSelectedAsset(): Promise<Asset | undefined> {
    const document = vscode.window.activeTextEditor?.document;
    const selection = await this.getSelection(document);
    return document && selection?.assetName
      ? this.getAsset(document, selection.assetName)
      : undefined;
  }

  /** Send only immutable text/version input. CPU analysis lives in the worker. */
  onChangeDoc(
    event: vscode.TextDocumentChangeEvent | vscode.TextDocument | undefined,
  ): void {
    if (!event || this.disposed) return;
    const document = 'document' in event ? event.document : event;
    if (
      document.languageId !== 'gml' ||
      document.uri.scheme !== 'file' ||
      document.isClosed ||
      ('contentChanges' in event && !event.contentChanges.length)
    )
      return;
    const project = this.getProject(document);
    if (!project) return;
    const triggers: readonly string[] = [
      ...completionTriggerCharacters,
      ' ',
      '\r\n',
      '\n',
      ';',
      ',',
    ];
    const immediate =
      !('contentChanges' in event) ||
      (event.contentChanges.length === 1 &&
        triggers.includes(event.contentChanges[0].text));
    this.acceptBuffer(project, document, immediate);
  }

  async createNewProject() {
    const project = this.getActiveProject();
    assertLoudly(project, 'Must have an active project to use as a template.');

    // Clone the current yyp file
    const roomName = 'rm_init';
    const objName = 'o_init';
    const resourceFolder = 'Init';
    let yyp = structuredClone(project.yyp);
    // Remove its contents
    yyp.IncludedFiles = [];
    yyp.resources = [];
    yyp.LibraryEmitters = [];
    yyp.Folders = [];
    yyp.configs.children = [];
    // @ts-expect-error We'll rely on the yywriter to complete
    yyp.AudioGroups = [{ name: 'audiogroup_default' }];
    // @ts-expect-error We'll rely on the yywriter to complete
    yyp.TextureGroups = [{ name: 'default' }];
    // @ts-expect-error We'll rely on the yywriter to complete
    yyp.RoomOrderNodes = [{ roomId: { name: roomName } }];

    // Prompt for the project name
    const projectName = await vscode.window.showInputBox({
      prompt: 'Enter a name for the new project',
      value: 'NewProject',
    });
    if (!projectName) return;

    yyp.name = projectName;
    yyp = yypSchema.parse(yyp);

    const where = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: `Choose a parent folder for the "${projectName}" project folder`,
      openLabel: `Create project in folder`,
    });
    if (!where?.length) return;

    await showProgress(async () => {
      const parentDir = pathyFromUri(where[0]);
      await parentDir.ensureDir();
      const dir = parentDir.join(projectName);
      await dir.ensureDir();
      const yypPath = dir.join(`${projectName}.yyp`);
      assertLoudly(!(await yypPath.exists()), `That project already exists!`);
      await Yy.write(yypPath.absolute, yyp, 'project');
      if (yyp['%Name']) {
        // Then this is in the new format. Requires a main options file
        const optionsDir = dir.join('options/main');
        await optionsDir.ensureDir();
        const optionsPath = optionsDir.join('options_main.yy');
        Yy.write(
          optionsPath.absolute,
          {
            $GMMainOptions: '',
            '%Name': 'Main',
            name: 'Main',
            option_author: '',
            option_collision_compatibility: false,
            option_copy_on_write_enabled: false,
            option_draw_colour: 4294967295,
            option_gameguid: randomUUID(),
            option_gameid: '0',
            option_game_speed: 60,
            option_mips_for_3d_textures: false,
            option_sci_usesci: false,
            option_spine_licence: false,
            option_steam_app_id: '0',
            option_template_description: null,
            option_template_icon: '${base_options_dir}/main/template_icon.png',
            option_template_image:
              '${base_options_dir}/main/template_image.png',
            option_window_colour: 255,
            resourceType: 'GMMainOptions',
            resourceVersion: '2.0',
          },
          undefined,
        );
      }

      // Load as a project
      const newProject = await Project.initialize(yypPath.absolute, {
        analysis: 'resources',
      });
      // Add the default object
      const obj = await newProject.createObject(`${resourceFolder}/${objName}`);
      // Add the default room
      const room = await newProject.createRoom(`${resourceFolder}/${roomName}`);
      // Add an object instance to the room
      if (obj && room) {
        await room?.addRoomInstance(obj);
      }

      // TODO: Open the new project folder in a new window
      await openPath(dir);
    }, 'Creating new project...');
  }

  /**
   * Only allow a single instance at a time.
   */
  protected static provider: StitchWorkspace;

  static async activate(ctx: vscode.ExtensionContext) {
    info('Activating extension...');
    if (this.provider) {
      info('Extension already active!');
      return this.provider;
    }
    this.provider = new StitchWorkspace(ctx);
    await activateStitchExtension(this.provider, ctx);
    return this.provider;
  }
}
