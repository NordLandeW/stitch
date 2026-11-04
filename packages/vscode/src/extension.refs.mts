import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { displayLocation } from './language/presentation.mjs';

export class StitchReferenceProvider implements vscode.ReferenceProvider {
  constructor(readonly workspace: StitchWorkspace) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const locations = await this.workspace.query(
      document,
      { kind: 'references', offset: document.offsetAt(position) },
      token,
    );
    return locations?.map(displayLocation);
  }

  static register(workspace: StitchWorkspace) {
    const provider = new StitchReferenceProvider(workspace);
    return [
      vscode.languages.registerReferenceProvider(
        { language: 'gml', scheme: 'file' },
        provider,
      ),
    ];
  }
}
