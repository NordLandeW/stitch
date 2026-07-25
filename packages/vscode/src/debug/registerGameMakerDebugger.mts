import vscode from 'vscode';
import path from 'node:path';
import type { GameMakerProject } from '../extension.project.mjs';
import type { StitchWorkspace } from '../extension.workspace.mjs';
import {
  GameMakerDebugSession,
  GameMakerDebugSessionHost,
  GameMakerLaunchRequestArguments,
} from './gameMakerDebugSession.mjs';

const DEBUG_TYPE = 'gamemaker';

function samePath(left: string, right: string) {
  const normalize = (value: string) => {
    const normalized = vscode.Uri.file(value).fsPath;
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function projectForConfiguration(
  workspace: StitchWorkspace,
  configuration: Pick<GameMakerLaunchRequestArguments, 'project'>,
) {
  return (
    workspace.projects.find((project) =>
      samePath(project.yypPath.absolute, configuration.project),
    ) ?? workspace.projects[0]
  );
}

class GameMakerDebugConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  constructor(private readonly workspace: StitchWorkspace) {}

  provideDebugConfigurations(): vscode.ProviderResult<
    vscode.DebugConfiguration[]
  > {
    const project = this.workspace.projects[0];
    if (!project) return [];
    return [
      {
        type: DEBUG_TYPE,
        request: 'launch',
        name: `Debug ${project.name}`,
        project: project.yypPath.absolute,
      },
    ];
  }

  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    const project =
      (configuration.project &&
        projectForConfiguration(this.workspace, {
          project: configuration.project as string,
        })) ||
      this.workspace.projects[0];
    if (!project) {
      void vscode.window.showErrorMessage(
        'Stitch could not find a GameMaker project to debug.',
      );
      return undefined;
    }
    return {
      ...configuration,
      type: DEBUG_TYPE,
      request: 'launch',
      name: configuration.name || `Debug ${project.name}`,
      project: project.yypPath.absolute,
    };
  }
}

class GameMakerDebugAdapterFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  constructor(private readonly host: GameMakerDebugSessionHost) {}

  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(
      new GameMakerDebugSession(this.host),
    );
  }
}

function createHost(workspace: StitchWorkspace): GameMakerDebugSessionHost {
  const requireProject = (args: GameMakerLaunchRequestArguments) => {
    const project = projectForConfiguration(workspace, args);
    if (!project) {
      throw new Error(`GameMaker project not found: ${args.project}`);
    }
    return project;
  };

  return {
    async launch(args, debuggerPort) {
      const project = requireProject(args);
      const launched = await project.run({
        config: args.config,
        compiler: 'vm',
        debug: true,
        debuggerPort,
      });
      if (!launched) {
        throw new Error('Stitch could not launch the GameMaker debug build.');
      }
    },
    async stop(args) {
      await requireProject(args).kill();
    },
    async loadSources(args) {
      const project = requireProject(args);
      const root = vscode.Uri.file(project.dir.absolute);
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, '**/*.gml'),
      );
      return Promise.all(
        files.map(async (file) => ({
          path: file.fsPath,
          text: new TextDecoder().decode(
            await vscode.workspace.fs.readFile(file),
          ),
        })),
      );
    },
    async expressionCompilerOptions(args) {
      const project = requireProject(args);
      const runtime = await project.resolveRuntime();
      if (!runtime) {
        throw new Error('The GameMaker Runtime is no longer available.');
      }
      const platform =
        process.platform === 'win32'
          ? 'windows'
          : process.platform === 'darwin'
            ? 'osx'
            : 'linux';
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
      const executableName =
        process.platform === 'win32'
          ? 'GMAssetCompiler.exe'
          : 'GMAssetCompiler';
      const assetCompiler = runtime.directory.join(
        'bin',
        'assetcompiler',
        platform,
        architecture,
        executableName,
      );
      if (!(await assetCompiler.exists())) {
        throw new Error(
          `GameMaker expression compiler not found: ${assetCompiler.absolute}`,
        );
      }
      return {
        assetCompilerPath: assetCompiler.absolute,
        projectPath: project.yypPath.absolute,
        prefabsPath: runtime.directory.up().up().up().join('Prefabs').absolute,
        startupHookPath: path.join(__dirname, 'GameMakerExpressionHook.dll'),
      };
    },
  };
}

export function registerGameMakerDebugger(
  workspace: StitchWorkspace,
  ctx: vscode.ExtensionContext,
) {
  const provider = new GameMakerDebugConfigurationProvider(workspace);
  const factory = new GameMakerDebugAdapterFactory(createHost(workspace));
  ctx.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory),
  );
}

export async function startGameMakerDebugging(
  project: GameMakerProject,
  config?: string,
) {
  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(project.yypPath.absolute),
  );
  await vscode.commands.executeCommand('workbench.view.debug');
  const started = await vscode.debug.startDebugging(folder, {
    type: DEBUG_TYPE,
    request: 'launch',
    name: `Debug ${project.name}`,
    project: project.yypPath.absolute,
    config,
  });
  if (!started) {
    throw new Error('VS Code did not start the GameMaker debug session.');
  }
}
