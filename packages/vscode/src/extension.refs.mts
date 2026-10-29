import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { locationOf } from './lib.mjs';

export class StitchReferenceProvider implements vscode.ReferenceProvider {
  constructor(readonly workspace: StitchWorkspace) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const file = await this.workspace.ensureProjectCurrent(document, token);
    if (!file) return;
    const symbols = new Set(
      file
        .getReferenceCandidatesAt(document.offsetAt(position))
        .map((ref) => ref.item),
    );
    const locations = new Map<string, vscode.Location>();
    for (const symbol of symbols)
      for (const reference of symbol.refs) {
        const location = locationOf(reference);
        if (!location) continue;
        const range = location.range;
        locations.set(
          `${location.uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`,
          location,
        );
      }
    return [...locations.values()];
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
