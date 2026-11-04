import vscode from 'vscode';
import { stitchConfig } from './config.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { displayLocation } from './language/presentation.mjs';
import { info, warn } from './log.mjs';

export class StitchWorkspaceSymbolProvider
  implements vscode.WorkspaceSymbolProvider
{
  constructor(readonly provider: StitchWorkspace) {}

  get projects() {
    return this.provider.projects;
  }

  async provideWorkspaceSymbols(
    query: string,
    token?: vscode.CancellationToken,
  ): Promise<vscode.SymbolInformation[]> {
    if (!query?.trim()) {
      // No value in searching for nothing, unless we start doing
      // active-editor-dependent searching.
      return [];
    }
    try {
      query = query.trim();
      const pattern = new RegExp(
        [...query]
          .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*'),
      );
      const project = this.provider.getActiveProject();
      if (!project) return [];
      const entries = await this.provider.queryProject(
        project,
        {
          kind: 'workspaceSymbols',
          path: this.provider.getActiveDocument()?.uri.fsPath,
          includeInstance: stitchConfig.symbolsIncludeInstanceVars,
          includeLocal: stitchConfig.symbolsIncludeLocalVars,
        },
        token,
      );
      const kinds = {
        enum: vscode.SymbolKind.Enum,
        enumMember: vscode.SymbolKind.EnumMember,
        constant: vscode.SymbolKind.Constant,
        constructor: vscode.SymbolKind.Constructor,
        function: vscode.SymbolKind.Function,
        variable: vscode.SymbolKind.Variable,
        module: vscode.SymbolKind.Module,
        class: vscode.SymbolKind.Class,
        file: vscode.SymbolKind.File,
      };
      const symbols = (entries || [])
        .filter((entry) => this.scoreResult(query, pattern, entry.name) > 0)
        .map(
          (entry) =>
            new vscode.SymbolInformation(
              entry.name,
              kinds[entry.kind],
              entry.container,
              displayLocation(entry.location),
            ),
        );
      // Sort by match quality and then only return the top results.
      const filteredSymbols = symbols.sort(this.resultSorter(query, pattern));
      info(`Found ${filteredSymbols.length} symbols matching "${query}"`);
      const results = filteredSymbols.slice(
        0,
        stitchConfig.symbolsMaxSearchResults,
      );
      return results;
    } catch (error) {
      warn(error);
      return [];
    }
  }

  scoreResult(query: string, pattern: RegExp, result: string) {
    // Prioritize in order of:
    // 1. Exact match
    // 2. Size of matching substring (shorter is better)
    // 3. Position of match (earlier is better)
    let score = 0;
    const patterns = [
      // pattern without case sensitivity
      new RegExp(pattern.source, 'i'),
      // pattern with case sensitivity
      // new RegExp(pattern.source),
    ];
    for (const pattern of patterns) {
      const match = result.match(pattern);
      if (!match) {
        break;
      }
      const characterProximityScore = query.length / match[0].length;
      const matchLengthScore = query.length / result.length;
      const positionScore = 1 - match.index! / result.length;
      score += characterProximityScore * 2 + positionScore + matchLengthScore;
    }
    return score;
  }

  resultSorter(query: string, pattern: RegExp) {
    return (a: { name: string }, b: { name: string }) => {
      const aScore = this.scoreResult(query, pattern, a.name);
      const bScore = this.scoreResult(query, pattern, b.name);
      return bScore - aScore || a.name.localeCompare(b.name);
    };
  }

  static register(provider: StitchWorkspace) {
    return vscode.languages.registerWorkspaceSymbolProvider(
      new StitchWorkspaceSymbolProvider(provider),
    );
  }
}
