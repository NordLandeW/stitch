import vscode from 'vscode';
import type { DocumentSymbol } from './language/protocol.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { displayRange } from './language/presentation.mjs';
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
      const symbols = await this.workspace.query(
        document,
        { kind: 'documentSymbols' },
        token,
      );
      if (!symbols) return [];

      const convert = (symbol: DocumentSymbol): vscode.DocumentSymbol => {
        const result = new vscode.DocumentSymbol(
          symbol.name,
          symbol.detail,
          symbolKinds[symbol.kind],
          document.validateRange(displayRange(symbol.range)),
          document.validateRange(displayRange(symbol.selectionRange)),
        );
        result.children = symbol.children.map(convert);
        if (symbol.deprecated) {
          result.tags = [vscode.SymbolTag.Deprecated];
        }
        return result;
      };
      return symbols.map(convert);
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
