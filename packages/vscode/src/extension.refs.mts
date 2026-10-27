import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { locationOf } from './lib.mjs';

export class StitchReferenceProvider implements vscode.ReferenceProvider {
  constructor(readonly workspace: StitchWorkspace) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const file = await this.workspace.ensureProjectCurrent(document, token);
    const candidates =
      file?.getReferenceCandidatesAt(document.offsetAt(position)) || [];
    if (!candidates.length) return;
    const symbols = new Set(candidates.map((reference) => reference.item));
    const references = new Set(
      [...symbols].flatMap((symbol) => [...symbol.refs]),
    );
    const locations = new Map<string, vscode.Location>();
    for (const ref of references) {
      if (!context.includeDeclaration && ref.isDef) continue;
      for (const range of ref.queryRange ? [ref, ref.queryRange] : [ref]) {
        const location = locationOf(range);
        if (location)
          locations.set(
            `${location.uri.toString()}:${range.start.offset}:${range.end.offset}`,
            location,
          );
      }
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
