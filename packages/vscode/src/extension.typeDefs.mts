import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { displayLocation } from './language/presentation.mjs';

export class StitchTypeDefinitionProvider
  implements vscode.TypeDefinitionProvider
{
  constructor(readonly workspace: StitchWorkspace) {}

  async provideTypeDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
    const locations = await this.workspace.query(
      document,
      { kind: 'typeDefinition', offset: document.offsetAt(position) },
      token,
    );
    return locations?.map(displayLocation);
  }

  static register(workspace: StitchWorkspace) {
    const provider = new StitchTypeDefinitionProvider(workspace);
    return [
      vscode.languages.registerTypeDefinitionProvider(
        { language: 'gml', scheme: 'file' },
        provider,
      ),
    ];
  }
}
