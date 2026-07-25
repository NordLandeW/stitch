import vscode from 'vscode';
import { collectGmlDocumentSymbols } from './extension.documentSymbols.core.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { rangeFrom } from './lib.mjs';
import { warn } from './log.mjs';

const symbolKinds = {
  constant: vscode.SymbolKind.Constant,
  constructor: vscode.SymbolKind.Class,
  enum: vscode.SymbolKind.Enum,
  enumMember: vscode.SymbolKind.EnumMember,
  field: vscode.SymbolKind.Field,
  function: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  struct: vscode.SymbolKind.Struct,
  variable: vscode.SymbolKind.Variable,
} as const;

export class StitchDocumentSymbolProvider
  implements vscode.DocumentSymbolProvider
{
  constructor(readonly workspace: StitchWorkspace) {}

  async provideDocumentSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentSymbol[]> {
    try {
      const pendingUpdate = this.workspace.processingFiles.get(
        document.uri.fsPath,
      );
      if (pendingUpdate) {
        await pendingUpdate;
      }
      if (token.isCancellationRequested) return [];

      const file = this.workspace.getGmlFile(document);
      if (!file) return [];

      const convert = (
        symbol: ReturnType<typeof collectGmlDocumentSymbols>[number],
      ): vscode.DocumentSymbol => {
        const result = new vscode.DocumentSymbol(
          symbol.name,
          symbol.detail,
          symbolKinds[symbol.kind],
          rangeFrom(symbol.range),
          rangeFrom(symbol.selectionRange),
        );
        result.children = symbol.children.map(convert);
        if (symbol.item.deprecated) {
          result.tags = [vscode.SymbolTag.Deprecated];
        }
        return result;
      };
      return collectGmlDocumentSymbols(file).map(convert);
    } catch (error) {
      warn(error);
      return [];
    }
  }

  static register(workspace: StitchWorkspace) {
    return vscode.languages.registerDocumentSymbolProvider(
      { language: 'gml', scheme: 'file' },
      new StitchDocumentSymbolProvider(workspace),
      { label: 'Stitch' },
    );
  }
}
