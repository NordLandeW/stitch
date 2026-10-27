import { Asset, Code } from '@bscotch/gml-parser';
import { literal } from '@bscotch/utility';
import vscode from 'vscode';
import { stitchConfig } from './config.mjs';
import { stitchEvents } from './events.mjs';
import { StitchCompletionProvider } from './extension.completions.mjs';
import {
  createCopyAsJsdocSelfCallback,
  createCopyAsJsdocTypeCallback,
  createCopyAsTypeCallback,
} from './extension.copyType.mjs';
import { StitchDefinitionsProvider } from './extension.definitions.mjs';
import { StitchDocumentSymbolProvider } from './extension.documentSymbols.mjs';
import { StitchYyFormatProvider } from './extension.formatting.mjs';
import { StitchHoverProvider } from './extension.hover.mjs';
import { StitchLensProvider } from './extension.lens.mjs';
import { StitchLocationsProvider } from './extension.locations.mjs';
import { ProjectSelection } from './extension.projectSelection.core.mjs';
import { chooseGameMakerProject } from './extension.projectSelection.mjs';
import { StitchReferenceProvider } from './extension.refs.mjs';
import { StitchReleasePickerProvider } from './extension.releases.mjs';
import { StitchRenameProvider } from './extension.rename.mjs';
import { StitchWorkspaceSymbolProvider } from './extension.symbols.mjs';
import { StitchTypeDefinitionProvider } from './extension.typeDefs.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { StitchIncludedFilesTree } from './includedFilesTree.mjs';
import { GameMakerInspectorProvider } from './inspector.mjs';
import {
  createSorter,
  findProject,
  getAssetFromRef,
  pathyFromUri,
  registerCommand,
} from './lib.mjs';
import {
  Timer,
  info,
  logger,
  showErrorMessage,
  getErrorMessage,
  Logger,
} from './log.mjs';
import { SpriteSourcesTree } from './spriteSources.mjs';
import { GameMakerFolder } from './tree.folder.mjs';
import { GameMakerTreeProvider } from './tree.mjs';
import { StitchIgorView } from './webview.igor.mjs';
import { StitchSpriteEditorProvider } from './webviews.spriteEditor.mjs';
import {
  registerGameMakerDebugger,
  startGameMakerDebugging,
} from './debug/registerGameMakerDebugger.mjs';

export async function activateStitchExtension(
  workspace: StitchWorkspace,
  ctx: vscode.ExtensionContext,
) {
  info('Activating extension...');
  stitchConfig.context = ctx;

  const t = Timer.start();
  // Ensure that things stay up to date!

  // Dispose any existing subscriptions
  // to allow for reloading the extension
  for (const subscription of ctx.subscriptions.splice(0))
    subscription.dispose();
  function own<T extends vscode.Disposable>(
    resource: T,
    local?: vscode.Disposable[],
  ): T {
    const lifetime = new vscode.Disposable(() => resource.dispose());
    ctx.subscriptions.push(lifetime);
    local?.push(lifetime);
    return resource;
  }
  own({ dispose: () => Logger.disposeAll() });
  Logger.resume();
  workspace.clearProjects();
  own(workspace);
  own(
    vscode.workspace.onDidChangeTextDocument((event) =>
      workspace.onChangeDoc(event),
    ),
  );
  own(
    vscode.workspace.onDidOpenTextDocument((document) =>
      workspace.onChangeDoc(document),
    ),
  );
  own(
    vscode.workspace.onDidCloseTextDocument((document) => {
      void workspace.onCloseDoc(document).catch((error) => logger.error(error));
    }),
  );
  let loading = true;
  const pendingSettings: vscode.ConfigurationChangeEvent[] = [];
  own(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (loading) pendingSettings.push(event);
      else
        void workspace
          .onConfigurationChanged(event)
          .catch((error) => logger.error(error));
    }),
  );

  // Dev-only watcher: reload window when files in dist/ or assets/ change,
  // debounced so rapid changes only trigger one reload.
  if (ctx.extensionMode === vscode.ExtensionMode.Development) {
    const patterns = [
      new vscode.RelativePattern(ctx.extensionPath, 'dist/**'),
      new vscode.RelativePattern(ctx.extensionPath, 'assets/**'),
    ];

    let timer: NodeJS.Timeout | undefined;
    ctx.subscriptions.push({ dispose: () => clearTimeout(timer) });
    const DEBOUNCE_MS = 100; // adjust delay as needed

    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        console.log('Extension source updated. Reloading!');
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, DEBOUNCE_MS);
    };

    for (const pattern of patterns) {
      const watcher = own(
        vscode.workspace.createFileSystemWatcher(pattern, false, false, false),
      );
      own(watcher.onDidCreate(scheduleReload));
      own(watcher.onDidChange(scheduleReload));
      own(watcher.onDidDelete(scheduleReload));
    }
  }

  info('Loading projects...');

  const projectSelection = new ProjectSelection(ctx.workspaceState);
  const selectedProject = await chooseGameMakerProject(projectSelection);
  const yypFiles = selectedProject ? [selectedProject] : [];

  for (const yypFile of yypFiles) {
    info('Loading project', yypFile);
    const pt = Timer.start();
    const ownedWatchers: vscode.Disposable[] = [];
    const pending: { uri: vscode.Uri; type: 'create' | 'change' | 'delete' }[] =
      [];
    let ready = false;
    const enqueue = (uri: vscode.Uri, type: 'create' | 'change' | 'delete') => {
      if (ready) workspace.externalChangeTracker.addChange({ uri, type });
      else pending.push({ uri, type });
    };
    try {
      // Observe before the first resource read. Replay the load-time changes
      // only after the project can be addressed by the workspace host.
      const base = vscode.Uri.file(pathyFromUri(yypFile).up().absolute);
      for (const glob of [
        '*.yyp',
        'stitch.config.json',
        '*/*/*.yy',
        '**/*.gml',
        '*/*/*.atlas',
        '*/*/*.png',
        'datafiles/**/*',
      ]) {
        const watcher = own(
          vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(base, glob),
          ),
          ownedWatchers,
        );
        own(
          watcher.onDidCreate((uri) => enqueue(uri, 'create')),
          ownedWatchers,
        );
        own(
          watcher.onDidChange((uri) => enqueue(uri, 'change')),
          ownedWatchers,
        );
        own(
          watcher.onDidDelete((uri) => enqueue(uri, 'delete')),
          ownedWatchers,
        );
      }
      await workspace.loadProject(
        yypFile,
        workspace.emitDiagnostics.bind(workspace),
      );
      ready = true;
      for (const event of pending.splice(0))
        workspace.externalChangeTracker.addChange(event);
      await workspace.externalChangeTracker.flush();
      pt.seconds('Loaded project in');
      try {
        await projectSelection.remember({
          uri: yypFile.toString(),
        });
      } catch (error) {
        logger.error(error);
        showErrorMessage(
          'Stitch could not remember the selected project. See the Stitch Output panel for details.',
        );
      }
    } catch (error) {
      for (const watcher of ownedWatchers) watcher.dispose();
      logger.error(error);
      logger.error('Error loading project', yypFile);
      const message = `Could not load project ${pathyFromUri(yypFile).basename}: ${getErrorMessage(error)}. See the Stitch Output panel for the source and phase details.`;
      showErrorMessage(message);
    }
  }
  while (pendingSettings.length)
    for (const event of pendingSettings.splice(0))
      await workspace.onConfigurationChanged(event);
  loading = false;

  const runProject = async (
    uriOrFolder: string[] | GameMakerFolder,
    debug = false,
  ) => {
    const project = findProject(workspace, uriOrFolder);
    if (!project) {
      void showErrorMessage('No project found to run!');
      return;
    }
    let lastConfig: any = ctx.workspaceState.get('lastRunConfig');
    const isValidConfig =
      lastConfig !== null &&
      typeof lastConfig === 'object' &&
      'compiler' in lastConfig &&
      'config' in lastConfig;
    if (!isValidConfig) {
      lastConfig = undefined;
    }
    try {
      if (debug) {
        await startGameMakerDebugging(project, lastConfig?.config);
      } else {
        await project.run(lastConfig);
      }
    } catch (err) {
      void showErrorMessage(err as Error);
    }
  };

  registerGameMakerDebugger(workspace, ctx);

  function* registrations(): Generator<vscode.Disposable> {
    yield* new GameMakerTreeProvider(workspace).register();
    yield* new GameMakerInspectorProvider(workspace).register();
    yield* new StitchDefinitionsProvider(workspace).register();
    yield* StitchIncludedFilesTree.register(workspace);
    yield* StitchTypeDefinitionProvider.register(workspace);
    yield* StitchReleasePickerProvider.register(workspace);
    yield* StitchRenameProvider.register(workspace);
    yield* SpriteSourcesTree?.register(workspace) || [];
    yield StitchHoverProvider.register(workspace);
    yield StitchLensProvider.register(workspace);
    yield StitchDocumentSymbolProvider.register(workspace);
    yield StitchWorkspaceSymbolProvider.register(workspace);
    yield StitchCompletionProvider.register(workspace);
    yield* StitchIgorView.register(workspace);
    yield* StitchSpriteEditorProvider.register(workspace);
    yield* StitchReferenceProvider.register(workspace);
    yield* StitchLocationsProvider.register(workspace);
    yield vscode.languages.registerSignatureHelpProvider(
      'gml',
      workspace,
      '(',
      ',',
    );
    yield vscode.languages.registerDocumentFormattingEditProvider(
      'yy',
      new StitchYyFormatProvider(),
    );
    yield registerCommand('stitch.assets.delete', (what) => {
      // Convert the incoming argument to an Asset, then emit the event
      let asset: Asset | undefined;
      if (what && typeof what === 'object') {
        if (what instanceof Asset) {
          asset = what;
        } else if ('asset' in what && what.asset instanceof Asset) {
          asset = what.asset;
        }
      }
      if (!asset) {
        logger.warn('stitch.assets.delete called on unknown type', what);
        return;
      }
      return workspace.deleteAsset(asset);
    });
    yield registerCommand('stitch.assets.deleteCode', async (what) => {
      // Convert the incoming argument to a Code instance, then emit the event
      let code: Code | undefined;
      if (what && typeof what === 'object') {
        if (what instanceof Code) {
          code = what;
        } else if ('code' in what && what.code instanceof Code) {
          code = what.code;
        }
      }
      // Actually delete the code!
      if (!code) {
        logger.warn('stitch.assets.deleteCode called on unknown type', what);
        return;
      }
      await code.remove();
      stitchEvents.emit('code-file-deleted', code);
    });
    yield registerCommand(
      'stitch.types.copy',
      createCopyAsTypeCallback(workspace),
    );
    yield registerCommand(
      'stitch.types.copyAsJsdocSelf',
      createCopyAsJsdocSelfCallback(workspace),
    );
    yield registerCommand(
      'stitch.types.copyAsJsdocType',
      createCopyAsJsdocTypeCallback(workspace),
    );
    yield registerCommand(
      'stitch.run',
      (uriOrFolder: string[] | GameMakerFolder) =>
        runProject(uriOrFolder, false),
    );
    yield registerCommand(
      'stitch.debug',
      (uriOrFolder: string[] | GameMakerFolder) =>
        runProject(uriOrFolder, true),
    );
    yield registerCommand(
      'stitch.stop',
      (uriOrFolder: string[] | GameMakerFolder) => {
        const project = findProject(workspace, uriOrFolder);
        if (!project) {
          void showErrorMessage('No project found to run!');
          return;
        }
        return project.kill();
      },
    );
    yield registerCommand(
      'stitch.run.noDefaults',
      async (uriOrFolder: string[] | GameMakerFolder) => {
        const project = findProject(workspace, uriOrFolder);
        if (!project) {
          void showErrorMessage('No project found to run!');
          return;
        }
        // QuickPick to select the config
        const configs = project.configs.sort(
          createSorter({
            first: [stitchConfig.runConfigDefault || '', 'Default'],
          }),
        );
        const chosenConfig = await vscode.window.showQuickPick(configs, {
          title: 'Select a config',
        });
        if (!chosenConfig) return;

        // QuickPick to select the compiler
        const compilers = literal(['vm', 'yyc']).sort(
          createSorter({ first: [stitchConfig.runCompilerDefault] }),
        );
        const chosenCompiler = await vscode.window.showQuickPick(compilers, {
          title: 'Select a compiler',
        });
        if (!chosenCompiler) return;

        await ctx.workspaceState.update('lastRunConfig', {
          compiler: chosenCompiler as any,
          config: chosenConfig,
        });
        await project.setAnalysisConfiguration(chosenConfig);

        const when = await vscode.window.showQuickPick(
          [
            { label: 'Run Now', now: true, picked: true },
            {
              label: 'Run Later',
              now: false,
              detail:
                'All future runs will use the new target until you change it again.',
            },
          ],
          {
            title: 'Target Updated! Run now?',
          },
        );
        if (when?.now) {
          await project.run({
            compiler: chosenCompiler as any,
            config: chosenConfig,
          });
        }
      },
    );
    yield registerCommand(
      'stitch.clean',
      (uriOrFolder: string[] | GameMakerFolder) => {
        const project = findProject(workspace, uriOrFolder);
        if (!project) {
          void showErrorMessage('No project found to run!');
          return;
        }
        return project.run({ clean: true });
      },
    );
    yield registerCommand(
      'stitch.openIde',
      async (uriOrFolder: string[] | GameMakerFolder) => {
        const project = findProject(workspace, uriOrFolder);
        if (!project) {
          void showErrorMessage('No project found to open!');
          return;
        }
        await project.openInIde();
      },
    );
    yield registerCommand('stitch.newProject', async () => {
      await workspace.createNewProject();
    });
    yield registerCommand('stitch.selectProject', async () => {
      try {
        await projectSelection.switchProject(
          async () => {
            const chosen = await chooseGameMakerProject(projectSelection, true);
            return chosen ? { uri: chosen.toString() } : undefined;
          },
          workspace.projects.length ? selectedProject?.toString() : undefined,
          () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
        );
      } catch (error) {
        logger.error(error);
        showErrorMessage(
          'Stitch could not switch projects. See the Stitch Output panel for details.',
        );
      }
    });
    yield workspace.semanticHighlightProvider.register();
  }
  for (const registration of registrations()) own(registration);

  let selectionRequest = 0;
  const updateSelection = async (
    event: vscode.TextEditorSelectionChangeEvent,
  ) => {
    const request = ++selectionRequest;
    workspace.signatureHelpStatus.text = '';
    workspace.signatureHelpStatus.hide();
    const document = event.textEditor.document;
    const selection = event.selections[0];
    const context = (key: string, value: unknown) => {
      void vscode.commands
        .executeCommand('setContext', key, value)
        .then(undefined, (error) => logger.error(error));
    };
    context('stitch.selectionIsNative', false);
    context('stitch.selectionIsSprite', false);
    context('stitch.selectionIsSound', false);
    if (
      !selection ||
      document.languageId !== 'gml' ||
      document.uri.scheme !== 'file'
    )
      return;
    const code = await workspace.ensureDocumentCurrent(
      document,
      undefined,
      false,
    );
    if (
      !code ||
      request !== selectionRequest ||
      vscode.window.activeTextEditor !== event.textEditor
    )
      return;
    const ref = code.getReferenceAt(document.offsetAt(selection.start));
    const asset = ref && getAssetFromRef(ref);
    context(
      'stitch.selectionIsNative',
      !!ref?.item.native &&
        !ref.item.def?.file &&
        ref.item.name !== 'event_inherited',
    );
    context('stitch.selectionIsSprite', asset?.isSprite ? asset.name : false);
    context('stitch.selectionIsSound', asset?.isSound ? asset.name : false);
    if (
      !stitchConfig.enableFunctionSignatureStatus ||
      event.selections.length !== 1 ||
      !selection.isEmpty
    )
      return;
    const help = workspace.getSignatureHelp(document, selection.start);
    const signature = help?.signatures[help.activeSignature];
    if (!signature) return;
    const name = signature.label.match(/^function\s+([^(]+)/i)?.[1];
    if (!name) return;
    workspace.signatureHelpStatus.text = `${name}(${signature.parameters.map((parameter, index) => (typeof parameter.label === 'string' && index === help!.activeParameter ? parameter.label.toUpperCase() : parameter.label)).join(', ')})`;
    workspace.signatureHelpStatus.show();
  };
  own(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      void updateSelection(event).catch((error) => logger.error(error));
    }),
  );

  for (const document of vscode.workspace.textDocuments) {
    workspace.onChangeDoc(document);
  }

  t.seconds('Extension activated in');
  return workspace;
}
