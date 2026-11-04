import { literal } from '@bscotch/utility';
import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { displayRange } from './language/presentation.mjs';
import { warn } from './log.mjs';

export type SemanticTokenType = (typeof semanticTokenTypes)[number];
export type SemanticTokenModifier = (typeof semanticTokenModifiers)[number];

const semanticTokenTypes = literal([
  'function',
  'variable',
  'enum',
  'macro',
  'class',
  'enumMember',
  'parameter',
  'property', // Self/instance variables
]);
const semanticTokenModifiers = literal([
  'readonly',
  'defaultLibrary',
  'declaration',
  'static',
  'deprecated',
  // Custom
  'local',
  'asset',
  'global',
]);

export const semanticTokensLegend = new vscode.SemanticTokensLegend(
  semanticTokenTypes,
  semanticTokenModifiers,
);

export class GameMakerSemanticTokenProvider
  implements vscode.DocumentSemanticTokensProvider
{
  constructor(readonly provider: StitchWorkspace) {}

  private _onDidChangeSemanticTokens: vscode.EventEmitter<void> =
    new vscode.EventEmitter();
  readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

  refresh() {
    this._onDidChangeSemanticTokens.fire();
  }

  dispose() {
    this._onDidChangeSemanticTokens.dispose();
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens | undefined> {
    try {
      const tokens = await this.provider.query(
        document,
        { kind: 'tokens' },
        token,
      );
      if (!tokens) return;
      const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
      for (const entry of tokens)
        builder.push(displayRange(entry.range), entry.type, entry.modifiers);
      return builder.build();
    } catch (error) {
      warn(error);
      warn('OUTER ERROR');
    }
    return;
  }

  register() {
    return vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'gml', scheme: 'file' }, // By excluding "git" scheme, we avoid wonky highlighting in the diff view
      this,
      semanticTokensLegend,
    );
  }
}
