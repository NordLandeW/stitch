import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { registerCommand } from './lib.mjs';
import { displayLocation } from './language/presentation.mjs';

export class StitchDefinitionsProvider implements vscode.DefinitionProvider {
  constructor(readonly workspace: StitchWorkspace) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | undefined> {
    const locations = await this.workspace.query(
      document,
      { kind: 'definition', offset: document.offsetAt(position) },
      token,
    );
    const results = locations?.map(displayLocation) || [];
    return results.length === 1
      ? results[0]
      : results.length
        ? results
        : undefined;
  }

  register() {
    return [
      vscode.languages.registerDefinitionProvider('gml', this),
      registerCommand(
        'stitch.openDocs',
        async (info?: { from?: 'keybind' }) => {
          // Get the currently select word, if any.
          let word = '';
          const editor = vscode.window.activeTextEditor;
          const project = this.workspace.getActiveProject();
          if (!project) return;
          if (editor) {
            const cursorPosition = editor.selection.active;
            const wordRange =
              editor.document.getWordRangeAtPosition(cursorPosition);
            if (wordRange) {
              word = editor.document.getText(wordRange);
            }
          }
          const openDocs = () =>
            vscode.env.openExternal(vscode.Uri.parse(project.helpLinks[word]));
          if (info?.from === 'keybind') {
            // Then we only want to open if the word is a native value of some sort.
            const selection =
              editor &&
              (await this.workspace.query(editor.document, {
                kind: 'selection',
                offset: editor.document.offsetAt(editor.selection.active),
              }));
            if (selection?.native) {
              openDocs();
            }
          } else {
            openDocs();
          }
        },
      ),
    ];
  }
}
