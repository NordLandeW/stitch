import {
  Code,
  JsdocSummary,
  Signifier,
  primitiveNames,
  type CompletionCandidate,
} from '@bscotch/gml-parser';
import vscode, { CancellationToken, CompletionContext } from 'vscode';
import { stitchConfig } from './config.mjs';
import {
  InScopeCompletionItems,
  captureCompletionView,
  completionScopeSymbols,
  type GmlCompletionKind,
} from './extension.completions.core.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';

const completionItems = new InScopeCompletionItems<vscode.CompletionItem>();

export const completionTriggerCharacters = ['.', '{', '<', '|'] as const;

export class StitchCompletionProvider implements vscode.CompletionItemProvider {
  constructor(readonly provider: StitchWorkspace) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: CancellationToken,
    context: CompletionContext,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const gmlFile = await this.provider.ensureDocumentCurrent(document, token);
    const offset = document.offsetAt(position);
    if (!gmlFile || token.isCancellationRequested) {
      return undefined;
    }
    // Are we inside a JSDoc comment?
    const jsdoc = gmlFile.getJsdocAt(offset);
    if (jsdoc && context.triggerCharacter === '.') {
      // Then abort!
      return;
    } else if (jsdoc) {
      return jsdocCompletions(document, position, gmlFile, jsdoc);
    } else if (context.triggerCharacter === '.' || !context.triggerCharacter) {
      const scopeSymbols = stitchConfig.autocompleteIgnoredPrefix
        ? completionScopeSymbols(
            gmlFile.getScopeRangeAt(offset),
            gmlFile.project.self,
          )
        : undefined;
      const isCurrent = captureCompletionView(
        gmlFile,
        () => this.provider.getGmlFile(document),
        () => gmlFile.project.analysis.generation,
        document,
      );
      // Are we in a StructNewMember range?
      const inStruct = gmlFile.getStructNewMemberRangeAt(offset);
      if (inStruct) {
        return inScopeSymbolsToCompletions(
          document,
          inStruct.type.listMembers(),
          token,
          scopeSymbols,
          isCurrent,
        );
      }
      const items = gmlFile.getCompletionCandidatesAt(offset);
      return inScopeSymbolsToCompletions(
        document,
        items,
        token,
        scopeSymbols,
        isCurrent,
      );
    }
    return undefined;
  }

  resolveCompletionItem(
    item: vscode.CompletionItem,
    token: CancellationToken,
  ): vscode.CompletionItem {
    return completionItems.resolve(item, () => token.isCancellationRequested);
  }

  static register(provider: StitchWorkspace) {
    return vscode.languages.registerCompletionItemProvider(
      { language: 'gml', scheme: 'file' },
      new StitchCompletionProvider(provider),
      ...completionTriggerCharacters,
    );
  }
}

export function jsdocCompletions(
  document: vscode.TextDocument,
  position: vscode.Position,
  file: Code,
  jsdoc: JsdocSummary,
): vscode.CompletionItem[] {
  // For now just grab all of the global types and return them as completions.
  const completions: vscode.CompletionItem[] = [];
  const typeNames = new Set<string>(file.project.types.keys());
  for (const primitiveName of primitiveNames) {
    typeNames.add(primitiveName);
  }
  for (const type of typeNames) {
    const item = new vscode.CompletionItem(
      type,
      vscode.CompletionItemKind.Interface,
    );
    completions.push(item);
  }
  return completions;
}

export function inScopeSymbolsToCompletions(
  document: vscode.TextDocument,
  items: readonly (Signifier | CompletionCandidate)[],
  token?: CancellationToken,
  scopeSymbols?: ReadonlySet<Signifier>,
  isCurrent?: () => boolean,
): vscode.CompletionItem[] {
  return completionItems.create(items, {
    documentPath: document.uri.fsPath,
    ignoredPrefix: stitchConfig.autocompleteIgnoredPrefix,
    scopeSymbols,
    isCurrent,
    createItem: (name, kind, { present, total }) =>
      new vscode.CompletionItem(
        present < total
          ? { label: name, description: `partial ${present}/${total}` }
          : name,
        completionKinds[kind],
      ),
    isCancelled: () => token?.isCancellationRequested ?? false,
  });
}

const completionKinds: Record<GmlCompletionKind, vscode.CompletionItemKind> = {
  enum: vscode.CompletionItemKind.Enum,
  constructor: vscode.CompletionItemKind.Constructor,
  function: vscode.CompletionItemKind.Function,
  variable: vscode.CompletionItemKind.Variable,
};
