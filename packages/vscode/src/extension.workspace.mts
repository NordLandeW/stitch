import {
  Project,
  type Asset,
  type Code,
  type DiagnosticsEventPayload,
  type FunctionArgRange,
  type OnDiagnostics,
  type Reference,
  type ReferenceableType,
} from '@bscotch/gml-parser';
import { Yy, yypSchema } from '@bscotch/yy';
import { randomUUID } from 'node:crypto';
import vscode from 'vscode';
import { assertLoudly } from './assert.mjs';
import { ChangeTracker } from './changes.mjs';
import { stitchConfig } from './config.mjs';
import {
  createDiagnosticCollection,
  normalizeDiagnosticsEvents,
} from './diagnostics.mjs';
import { stitchEvents } from './events.mjs';
import { activateStitchExtension } from './extension.activate.mjs';
import { completionTriggerCharacters } from './extension.completions.mjs';
import { DocumentAnalysisQueue } from './extension.analysis.core.mjs';
import { GameMakerSemanticTokenProvider } from './extension.highlighting.mjs';
import { GameMakerProject } from './extension.project.mjs';
import {
  activeTab,
  isSpriteTab,
  openPath,
  pathyFromUri,
  showProgress,
} from './lib.mjs';
import { info, logger, warn } from './log.mjs';

export class StitchWorkspace implements vscode.SignatureHelpProvider {
  readonly semanticHighlightProvider = new GameMakerSemanticTokenProvider(this);
  readonly signatureHelpStatus = vscode.window.createStatusBarItem(
    stitchConfig.functionSignatureStatusAlignment,
    stitchConfig.functionSignatureStatusAlignment ===
      vscode.StatusBarAlignment.Left
      ? -Infinity
      : Infinity,
  );
  readonly diagnosticCollection = createDiagnosticCollection();
  readonly externalChangeTracker = new ChangeTracker(this);

  projects: GameMakerProject[] = [];

  private disposed = false;
  private lifetime = 0;
  private readonly diskReads = new WeakMap<Code, object>();
  private readonly analysis = new DocumentAnalysisQueue<Code>({
    content: (code) =>
      code.project.analysis.isCurrent &&
      ['complete', 'degraded'].includes(code.analysisState.status)
        ? code.content
        : undefined,
    analyze: async (code, snapshot) => {
      if (snapshot.version === undefined) {
        code.releaseBuffer();
        code.content = snapshot.text;
        await code.project.analysis.analyze();
      } else {
        await code.readContent(snapshot.text);
        await code.project.analysis.analyze();
      }
      if (
        !this.disposed &&
        this.projects.some((project) => project === code.project)
      ) {
        this.semanticHighlightProvider.refresh();
      }
    },
    delay: () => stitchConfig.reprocessOnTypeDelay,
    onError: (error) => logger.error(error),
  });

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
        this.diagnosticCollection.delete(vscode.Uri.file(payload.filePath));
        return;
      }
    }
    this.diagnosticCollection.set(
      vscode.Uri.file(payload.filePath),
      normalizeDiagnosticsEvents(payload),
    );
  }

  clearProjects() {
    this.lifetime++;
    this.analysis.clear();
    for (const project of this.projects) project.dispose();
    this.projects = [];
    this.diagnosticCollection.clear();
    this.semanticHighlightProvider.clear();
    void vscode.commands.executeCommand(
      'setContext',
      'stitch.projectCount',
      this.projects.length,
    );
  }

  async loadProject(yypPath: vscode.Uri, onDiagnostics: OnDiagnostics) {
    let project!: GameMakerProject;
    const lifetime = this.lifetime;
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
          (payload) => {
            if (!this.disposed && lifetime === this.lifetime)
              onDiagnostics(payload);
          },
          (percent, message) => {
            progress.report({
              increment: percent,
              message,
            });
          },
        );
        if (this.disposed || lifetime !== this.lifetime) {
          project.dispose();
          throw new Error('Project loading was cancelled');
        }
        try {
          await project.syncIncludedFiles();
        } catch (error) {
          logger.warn('Could not synchronize Included Files', error);
        }
        progress.report({
          increment: 100,
          message: 'Done!',
        });
      },
    );
    if (this.disposed || lifetime !== this.lifetime) {
      project.dispose();
      throw new Error('Project loading was cancelled');
    }
    this.projects.push(project);
    void vscode.commands.executeCommand(
      'setContext',
      'stitch.projectCount',
      this.projects.length,
    );
    return project;
  }

  async deleteAsset(asset: Asset) {
    await asset.project.removeAssetByName(asset.name);
    stitchEvents.emit('asset-deleted', asset);
  }

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<vscode.SignatureHelp | undefined> {
    if (!(await this.ensureDocumentCurrent(document, token))) return;
    return this.getSignatureHelp(document, position);
  }

  getSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.SignatureHelp | undefined {
    const argRange = this.getFunctionArg(document, position);
    if (!argRange?.param?.parent) {
      return;
    }
    const param = argRange.param;
    const func = argRange.type;
    // Create the signature help
    const signature = new vscode.SignatureInformation(
      func.code,
      func.description,
    );
    signature.activeParameter = param.idx!;
    signature.parameters = func.listParameters().map((p) => {
      return new vscode.ParameterInformation(
        p?.name || 'unknown',
        p?.description,
      );
    });
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = param.idx!;
    return help;
  }

  /** Obtain current positions and symbols without waiting for unrelated diagnostics. */
  async ensureDocumentCurrent(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
    immediate = true,
  ): Promise<Code | undefined> {
    if (
      this.disposed ||
      document.isClosed ||
      token?.isCancellationRequested ||
      document.languageId !== 'gml' ||
      document.uri.scheme !== 'file'
    )
      return;
    await this.externalChangeTracker.flush();
    if (this.disposed || document.isClosed || token?.isCancellationRequested)
      return;
    const code = this.getGmlFile(document);
    if (!code) return;
    this.diskReads.delete(code);
    const version = document.version;
    const snapshot = { version, text: document.getText() };
    this.stageOpenBuffers(code.project);
    try {
      if (immediate) await this.analysis.flush(code, snapshot);
      else await this.analysis.wait(code, snapshot, token);
      if (token?.isCancellationRequested) return;
      await code.project.analysis.analyze();
    } catch {
      return;
    }
    if (
      this.disposed ||
      document.isClosed ||
      token?.isCancellationRequested ||
      document.version !== version ||
      this.getGmlFile(document) !== code ||
      !code.project.analysis.isCurrent ||
      !['complete', 'degraded'].includes(code.analysisState.status)
    )
      return;
    return code;
  }

  /** Reference edits need current positions in every open buffer in the project. */
  async ensureProjectCurrent(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
  ) {
    const version = document.version;
    const project = this.getProject(document);
    if (!project || !(await this.ensureProjectAnalysis(project, token))) return;
    if (
      document.version !== version ||
      document.isClosed ||
      token?.isCancellationRequested
    )
      return;
    return this.ensureDocumentCurrent(document, token);
  }

  private stageOpenBuffers(project: Project): void {
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.isClosed ||
        document.languageId !== 'gml' ||
        document.uri.scheme !== 'file' ||
        this.getProject(document) !== project
      )
        continue;
      const code = this.getGmlFile(document);
      if (!code) continue;
      this.diskReads.delete(code);
      code.setBufferContent(document.getText());
    }
  }

  /** Join the project closure after staging every authoritative open buffer. */
  async ensureProjectAnalysis(
    project: GameMakerProject,
    token?: vscode.CancellationToken,
  ): Promise<boolean> {
    if (
      this.disposed ||
      token?.isCancellationRequested ||
      !this.projects.includes(project)
    )
      return false;
    await this.externalChangeTracker.flush();
    if (
      this.disposed ||
      token?.isCancellationRequested ||
      !this.projects.includes(project)
    )
      return false;
    this.stageOpenBuffers(project);
    const buffers = vscode.workspace.textDocuments.filter(
      (other) =>
        other.languageId === 'gml' &&
        other.uri.scheme === 'file' &&
        !other.isClosed &&
        this.getProject(other) === project,
    );
    const versions = buffers.map((other) => other.version);
    try {
      await project.analysis.analyze();
    } catch {
      return false;
    }
    return (
      !this.disposed &&
      !token?.isCancellationRequested &&
      this.projects.includes(project) &&
      project.analysis.isCurrent &&
      buffers.every(
        (other, index) => !other.isClosed && other.version === versions[index],
      )
    );
  }

  private openDocument(uri: vscode.Uri) {
    return vscode.workspace.textDocuments.find(
      (document) =>
        !document.isClosed && document.uri.toString() === uri.toString(),
    );
  }

  private async updateOpenBuffer(document: vscode.TextDocument): Promise<void> {
    const code = this.getGmlFile(document);
    if (!code) return;
    this.diskReads.delete(code);
    this.stageOpenBuffers(code.project);
    await this.analysis.flush(code, {
      version: document.version,
      text: document.getText(),
    });
  }

  /** Open buffers are authoritative, including when a watcher races a save or edit. */
  async onChangeFile(uri: vscode.Uri): Promise<void> {
    if (this.disposed) return;
    const open = this.openDocument(uri);
    if (open) {
      await this.updateOpenBuffer(open);
      return;
    }
    const code = this.getGmlFile(uri);
    if (!code) return;
    const read = {};
    this.diskReads.set(code, read);
    await code.project.withResourceUpdate(async () => {
      const text = await code.path.read();
      if (
        this.disposed ||
        this.diskReads.get(code) !== read ||
        this.getGmlFile(uri) !== code
      )
        return;
      const openedDuringRead = this.openDocument(uri);
      if (openedDuringRead) code.setBufferContent(openedDuringRead.getText());
      else {
        code.releaseBuffer();
        code.content = text;
      }
    });
    if (!this.disposed) this.semanticHighlightProvider.refresh();
  }

  async onCloseDoc(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'gml' || document.uri.scheme !== 'file') return;
    const code = this.getGmlFile(document);
    if (code) {
      this.analysis.forget(code);
      code.releaseBuffer();
    }
    // Closing an unsaved buffer must restore the on-disk model as well.
    await this.onChangeFile(document.uri);
  }

  async onConfigurationChanged(
    event: vscode.ConfigurationChangeEvent,
  ): Promise<void> {
    if (this.disposed || !event.affectsConfiguration('stitch')) return;
    const semantic =
      event.affectsConfiguration('stitch.run.defaultConfig') ||
      event.affectsConfiguration(
        'stitch.diagnostics.autoDeclaredGlobalsPatterns',
      );
    for (const project of [...this.projects]) {
      if (semantic) {
        if (project.options)
          (project.options.settings ||= {}).autoDeclareGlobalsPrefixes =
            stitchConfig.autoDeclaredGlobalsPrefixes;
        project.analysis.invalidate();
        if (project.options)
          (project.options.settings ||= {}).analysisConfiguration =
            stitchConfig.runConfigDefault || undefined;
        await project.setAnalysisConfiguration(
          project.defaultAnalysisConfiguration,
        );
      }
      if (this.disposed || !this.projects.includes(project)) return;
      for (const asset of project.assets.values())
        for (const code of asset.gmlFiles.values()) code.publishDiagnostics();
    }
    this.semanticHighlightProvider.clear();
    this.semanticHighlightProvider.refresh();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearProjects();
    this.analysis.dispose();
    this.externalChangeTracker.dispose();
    this.semanticHighlightProvider.dispose();
    this.signatureHelpStatus.dispose();
    this.diagnosticCollection.dispose();
    stitchEvents.clear();
    if (StitchWorkspace.provider === this) StitchWorkspace.provider = undefined;
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

  getFunctionArg(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): FunctionArgRange | undefined {
    const offset = document.offsetAt(position);
    return this.getGmlFile(document)?.getFunctionArgRangeAt(offset);
  }

  getReference(
    where: vscode.TextDocument | vscode.Uri,
    position: vscode.Position,
  ): Reference | undefined {
    const document =
      where instanceof vscode.Uri
        ? vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === where.fsPath,
          )
        : where;
    if (!document) {
      return;
    }
    const offset = document.offsetAt(position);
    const file = this.getGmlFile(document);
    if (!file) {
      warn(`Could not find file for ${document}`);
      return;
    }
    const ref = file.getReferenceAt(offset);
    if (!ref) {
      warn(`Could not find reference at ${offset}`);
      return;
    }
    return ref;
  }

  getSignifier(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): ReferenceableType | undefined {
    const ref = this.getReference(document, position);
    if (!ref) {
      return;
    }
    const item = ref.item;
    if (!item) {
      warn(`Could not find symbol for ${ref}`);
      return;
    }
    return item;
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

  async getRefFromSelection(
    document?: vscode.TextDocument,
    selection?: readonly vscode.Selection[],
  ) {
    document ||= vscode.window.activeTextEditor?.document;
    if (
      !document ||
      document.uri.scheme !== 'file' ||
      !document.uri.fsPath.endsWith('.gml')
    ) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    selection ||= editor?.document === document ? editor.selections : undefined;
    const start = selection?.[0]?.start;
    if (!start) return;
    const file = await this.ensureDocumentCurrent(document);
    if (
      !file ||
      (editor?.document === document &&
        (vscode.window.activeTextEditor !== editor ||
          !editor.selection.start.isEqual(start)))
    )
      return;
    return file.getReferenceAt(document.offsetAt(start));
  }

  /** Record every text change; explicit completion triggers can bypass the delay. */
  onChangeDoc(
    event: vscode.TextDocumentChangeEvent | vscode.TextDocument | undefined,
  ): void {
    if (!event || this.disposed) return;
    const document = 'document' in event ? event.document : event;
    if (
      document.languageId !== 'gml' ||
      document.uri.scheme !== 'file' ||
      document.isClosed
    )
      return;
    if ('contentChanges' in event && !event.contentChanges.length) return;
    const code = this.getGmlFile(document);
    if (!code) return;
    this.diskReads.delete(code);
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
    const snapshot = { version: document.version, text: document.getText() };
    // Input generations advance immediately; debounce only delays analysis.
    code.setBufferContent(snapshot.text);
    this.analysis.enqueue(code, snapshot, immediate);
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
      const newProject = await Project.initialize(yypPath.absolute);
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
  protected static provider: StitchWorkspace | undefined;
  private static activation: Promise<StitchWorkspace> | undefined;

  static activate(ctx: vscode.ExtensionContext): Promise<StitchWorkspace> {
    info('Activating extension...');
    // An allocated instance is not a readiness result. Concurrent callers
    // share the same initialization, cancellation and failure ownership.
    if (this.activation) return this.activation;
    if (this.provider) {
      info('Extension already active!');
      return Promise.resolve(this.provider);
    }
    const provider = new StitchWorkspace(ctx);
    this.provider = provider;
    const activation = Promise.resolve()
      .then(async () => {
        try {
          await activateStitchExtension(provider, ctx);
          if (provider.disposed)
            throw new Error('Extension activation was cancelled');
          return provider;
        } catch (error) {
          provider.dispose();
          for (const subscription of ctx.subscriptions.splice(0)) {
            try {
              subscription.dispose();
            } catch (cleanupError) {
              logger.warn(cleanupError);
            }
          }
          throw error;
        }
      })
      .finally(() => {
        if (this.activation === activation) this.activation = undefined;
      });
    this.activation = activation;
    return activation;
  }
}
