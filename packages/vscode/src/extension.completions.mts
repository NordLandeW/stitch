import vscode, { CancellationToken, CompletionContext } from 'vscode';
import { stitchConfig } from './config.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';

export const completionTriggerCharacters = ['.', '{', '<', '|'] as const;
const kinds = {
  enum: vscode.CompletionItemKind.Enum,
  constructor: vscode.CompletionItemKind.Constructor,
  function: vscode.CompletionItemKind.Function,
  variable: vscode.CompletionItemKind.Variable,
  interface: vscode.CompletionItemKind.Interface,
};

export class StitchCompletionProvider implements vscode.CompletionItemProvider {
  constructor(readonly provider: StitchWorkspace) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: CancellationToken,
    context: CompletionContext,
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
    const linePrefix = document.getText(
      new vscode.Range(position.line, 0, position.line, position.character),
    );
    const candidates = await this.provider.query(
      document,
      {
        kind: 'completion',
        offset: document.offsetAt(position),
        trigger: context.triggerCharacter,
        // A bare identifier can use labelled native suggestions. Member/JSDoc/
        // constructor/struct contexts retain the precise worker query.
        allowNativeFallback:
          !context.triggerCharacter &&
          /^\s*[A-Za-z_][A-Za-z0-9_]*$/.test(linePrefix),
      },
      token,
    );
    const items = candidates
      ?.filter((candidate) => {
        const prefix = stitchConfig.autocompleteIgnoredPrefix;
        return !(
          prefix &&
          candidate.name.startsWith(prefix) &&
          candidate.definitionPath &&
          vscode.Uri.file(candidate.definitionPath).toString() ===
            document.uri.toString()
        );
      })
      .map((candidate) => {
        const item = new vscode.CompletionItem(
          candidate.name,
          kinds[candidate.kind],
        );
        item.detail = candidate.detail;
        return item;
      });
    return items && candidates?.some((candidate) => candidate.fallback)
      ? new vscode.CompletionList(items, true)
      : items;
  }

  static register(provider: StitchWorkspace) {
    return vscode.languages.registerCompletionItemProvider(
      { language: 'gml', scheme: 'file' },
      new StitchCompletionProvider(provider),
      ...completionTriggerCharacters,
    );
  }
}
