import vscode from 'vscode';
import { stitchConfig } from './config.mjs';
import { ProjectSelection } from './extension.projectSelection.core.mjs';
import { pathyFromUri } from './lib.mjs';
import { warn } from './log.mjs';

export async function chooseGameMakerProject(
  selection: ProjectSelection,
  forcePick = false,
): Promise<vscode.Uri | undefined> {
  const files = await vscode.workspace.findFiles('**/*.yyp');
  if (!files.length) warn('No .yyp files found in workspace!');
  const chosen = await selection.choose(
    files.map((file) => {
      const path = pathyFromUri(file);
      return {
        uri: file.toString(),
        name: path.name,
        folderName: path.up().name,
        label: path.basename,
        description: path.up().absolute,
        file,
      };
    }),
    stitchConfig.allowedProjects,
    (projects, previous) =>
      vscode.window.showQuickPick(
        projects.map((project) => ({
          ...project,
          detail: project === previous ? 'Last selected project' : undefined,
        })),
        {
          title: 'Stitch: Select GameMaker Project',
          placeHolder: forcePick
            ? 'Choose a project. VS Code will reload to switch projects.'
            : 'Multiple GameMaker projects found. Choose a project to load.',
        },
      ),
    forcePick,
  );
  if (!files.length && forcePick) {
    void vscode.window.showInformationMessage(
      'Stitch: No GameMaker projects (.yyp files) found in this workspace.',
    );
  }
  return chosen?.file;
}
