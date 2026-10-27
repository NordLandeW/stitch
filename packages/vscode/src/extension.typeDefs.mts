import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { locationOf } from './lib.mjs';

export class StitchTypeDefinitionProvider
  implements vscode.TypeDefinitionProvider
{
  constructor(readonly workspace: StitchWorkspace) {}

  async provideTypeDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
    const file = await this.workspace.ensureDocumentCurrent(document, token);
    const references =
      file?.getReferenceCandidatesAt(document.offsetAt(position)) || [];
    if (!references.length) return;
    const locations = new Map<string, vscode.Location>();
    for (const reference of references)
      for (const type of (reference.evaluatedType || reference.item.type)
        .type) {
        const definition = type.signifier?.def;
        if (!definition?.file) continue;
        const location = locationOf(definition);
        if (location)
          locations.set(
            `${definition.file.path.absolute}:${definition.start.offset}:${definition.end.offset}`,
            location,
          );
      }
    return [...locations.values()];
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
