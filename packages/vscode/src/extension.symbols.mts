import {
  isAssetOfKind,
  type Asset,
  type Code,
  type Signifier,
  type Type,
} from '@bscotch/gml-parser';
import vscode from 'vscode';
import { stitchConfig } from './config.mjs';
import type { GameMakerProject } from './extension.project.mjs';
import {
  WorkspaceSymbolSearch,
  captureSymbolProjectGeneration,
} from './extension.symbols.core.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { locationOf } from './lib.mjs';
import { info, warn } from './log.mjs';

type SymbolResults = Map<Signifier | Code | Asset, vscode.SymbolInformation>;

export class StitchWorkspaceSymbolProvider
  implements vscode.WorkspaceSymbolProvider
{
  constructor(readonly provider: StitchWorkspace) {}

  get projects() {
    return this.provider.projects;
  }

  protected async variablesToSymbols(
    variables: Type,
    symbols: SymbolResults,
    search: WorkspaceSymbolSearch,
  ): Promise<SymbolResults> {
    // Add any variables defined in this object
    if (!variables || search.stopped) return symbols;
    for (const member of variables.listMembers(true)) {
      const pending = search.checkpoint();
      if (pending) await pending;
      if (search.stopped) return symbols;
      if (symbols.has(member)) continue;
      const symbol = this.signifierToSymbol(member, search);
      if (symbol) {
        symbols.set(member, symbol);
      }
    }
    return symbols;
  }

  protected async assetContentsToSymbols(
    resource: Asset,
    symbols: SymbolResults,
    search: WorkspaceSymbolSearch,
  ): Promise<SymbolResults> {
    if (search.stopped) return symbols;
    const start = new vscode.Position(0, 0);

    if (resource.assetKind === 'scripts') {
      // Add the script itself if it doesn't already include
      // a global function within it by the same name.
      const canAdd =
        !!resource.gmlFile &&
        search.matches(resource.name) &&
        !symbols.has(resource);
      const globalVarWithSameName =
        resource.project.analysis.globalStorage.getMember(resource.name);
      const containsGlobalFunctionWithSameName =
        !!globalVarWithSameName &&
        globalVarWithSameName.def?.file === resource.gmlFile;
      if (canAdd && !containsGlobalFunctionWithSameName) {
        symbols.set(
          resource,
          new vscode.SymbolInformation(
            resource.name,
            vscode.SymbolKind.Module,
            resource.assetKind,
            new vscode.Location(
              vscode.Uri.file(resource.gmlFile!.path.absolute),
              start,
            ),
          ),
        );
      }
    } else if (isAssetOfKind(resource, 'shaders')) {
      // Go to the fragment shader
      const canAdd = search.matches(resource.name) && !symbols.has(resource);
      const fragShad = resource.shaderPaths.fragment;
      if (canAdd && fragShad) {
        symbols.set(
          resource,
          new vscode.SymbolInformation(
            resource.name,
            vscode.SymbolKind.Module,
            resource.assetKind,
            new vscode.Location(vscode.Uri.file(fragShad.absolute), start),
          ),
        );
      }
    } else if (resource.assetKind === 'objects') {
      for (const file of resource.gmlFiles.values()) {
        const pending = search.checkpoint();
        if (pending) await pending;
        if (search.stopped) return symbols;
        // Add the object event itself
        const canAdd = search.matches(resource.name) && !symbols.has(file);
        if (canAdd) {
          const symbol = new vscode.SymbolInformation(
            resource.name,
            vscode.SymbolKind.Class,
            `${resource.assetKind} (${file.path.name})`,
            new vscode.Location(vscode.Uri.file(file.path.absolute), start),
          );
          symbols.set(file, symbol);
        }

        // Add any variables defined in this object
        if (!stitchConfig.symbolsIncludeInstanceVars) continue;
        await this.variablesToSymbols(file.asset.variables!, symbols, search);
      }
    } else {
      // Add the asset yy file for all other asset types
      const canAdd = search.matches(resource.name) && !symbols.has(resource);
      if (canAdd) {
        symbols.set(
          resource,
          new vscode.SymbolInformation(
            resource.name,
            vscode.SymbolKind.File,
            resource.assetKind,
            new vscode.Location(
              vscode.Uri.file(resource.yyPath.absolute),
              start,
            ),
          ),
        );
      }
    }
    return symbols;
  }

  /**
   * Mutates the `symbols` map to include all global symbols in the project.
   */
  protected async globalsToSymbols(
    project: GameMakerProject,
    symbols: SymbolResults,
    search: WorkspaceSymbolSearch,
  ): Promise<SymbolResults> {
    if (search.stopped) return symbols;
    for (const item of project.analysis.globalStorage.listMembers()) {
      const pending = search.checkpoint();
      if (pending) await pending;
      if (search.stopped) return symbols;
      // Assets are already handled by the resource cache.
      if (!symbols.has(item)) {
        const symbol = this.signifierToSymbol(item, search);
        if (symbol) {
          symbols.set(item, symbol);
        }
      }

      // Even if the symbol itself doesn't match, it may have members that do!
      if (!stitchConfig.symbolsIncludeInstanceVars) continue;

      // If it's a mixin or constructor, add its members
      const functionType = item.getTypeByKind('Function');
      if (functionType?.self && (item.mixin || functionType.isConstructor)) {
        // Add any variables defined in this object
        await this.variablesToSymbols(functionType.self, symbols, search);
      }
    }
    return symbols;
  }

  protected signifierToSymbol(
    item: Signifier,
    search?: WorkspaceSymbolSearch,
  ): vscode.SymbolInformation | undefined {
    if (
      !item.def?.file ||
      !item.name ||
      (search && !search.matches(item.name))
    ) {
      return;
    }

    const type = item.type;
    const functionType = item.getTypeByKind('Function');

    const kind = item.enum
      ? vscode.SymbolKind.Enum
      : item.enumMember
        ? vscode.SymbolKind.EnumMember
        : item.macro
          ? vscode.SymbolKind.Constant
          : functionType?.isConstructor
            ? vscode.SymbolKind.Constructor
            : functionType
              ? vscode.SymbolKind.Function
              : vscode.SymbolKind.Variable;
    return new vscode.SymbolInformation(
      item.name,
      kind,
      type.kind,
      locationOf(item.def)!,
    );
  }

  async provideWorkspaceSymbols(
    query: string,
    token?: vscode.CancellationToken,
  ): Promise<vscode.SymbolInformation[]> {
    if (!query?.trim() || token?.isCancellationRequested) {
      // No value in searching for nothing, unless we start doing
      // active-editor-dependent searching.
      return [];
    }
    try {
      const project = this.provider.getActiveProject();
      if (
        !project ||
        !(await this.provider.ensureProjectAnalysis(project, token))
      )
        return [];
      const symbols: SymbolResults = new Map();
      const isCurrentGeneration = captureSymbolProjectGeneration(project);
      const search = new WorkspaceSymbolSearch(query, {
        isCancelled: () => token?.isCancellationRequested ?? false,
        isCurrent: () =>
          this.provider.projects.includes(project) && isCurrentGeneration(),
      });

      await this.globalsToSymbols(project, symbols, search);
      if (search.stopped) return [];
      for (const resource of project.assets.values()) {
        const pending = search.checkpoint();
        if (pending) await pending;
        if (search.stopped) return [];
        await this.assetContentsToSymbols(resource, symbols, search);
      }
      if (search.stopped) return [];
      if (stitchConfig.symbolsIncludeLocalVars) {
        // Add the local variables defined in the current document
        const activeFile = this.provider.getGmlFile(undefined);
        if (activeFile) {
          for (const scope of activeFile.scopes) {
            const pending = search.checkpoint();
            if (pending) await pending;
            if (search.stopped) return [];
            await this.variablesToSymbols(scope.local, symbols, search);
          }
        }
      }

      const results = await search.rank(
        symbols.values(),
        stitchConfig.symbolsMaxSearchResults,
      );
      if (search.stopped) return [];
      info(`Found ${symbols.size} symbols matching "${search.query}"`);
      return results;
    } catch (error) {
      warn(error);
      return [];
    }
  }

  static register(provider: StitchWorkspace) {
    return vscode.languages.registerWorkspaceSymbolProvider(
      new StitchWorkspaceSymbolProvider(provider),
    );
  }
}
