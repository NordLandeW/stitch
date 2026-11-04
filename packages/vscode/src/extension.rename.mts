import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { displayRange } from './language/presentation.mjs';

export class StitchRenameProvider implements vscode.RenameProvider {
  constructor(readonly workspace: StitchWorkspace) {}

  async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Range | undefined> {
    const range = await this.workspace.query(
      document,
      { kind: 'prepareRename', offset: document.offsetAt(position) },
      token,
    );
    return range && displayRange(range);
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
  ) {
    const plan = await this.workspace.query(
      document,
      { kind: 'rename', offset: document.offsetAt(position), newName },
      token,
    );
    if (
      !plan ||
      !(await this.workspace.validateRenamePlan(document, plan, token))
    )
      return;
    const edits = new vscode.WorkspaceEdit();
    for (const edit of plan.edits)
      edits.replace(
        vscode.Uri.file(edit.location.path),
        displayRange(edit.location),
        edit.text,
      );
    return edits;
  }

  static register(workspace: StitchWorkspace) {
    return [
      vscode.languages.registerRenameProvider(
        { language: 'gml', scheme: 'file' },
        new StitchRenameProvider(workspace),
      ),
    ];
  }
}
