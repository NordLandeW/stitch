import { Reference, type Code, type Range } from '@bscotch/gml-parser';
import { literal } from '@bscotch/utility';
import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { locationOf } from './lib.mjs';
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
  private cache = new WeakMap<
    Code,
    { key: string; tokens: vscode.SemanticTokens }
  >();

  clear(): void {
    this.cache = new WeakMap();
  }
  dispose(): void {
    this.clear();
    this._onDidChangeSemanticTokens.dispose();
  }

  refresh() {
    this._onDidChangeSemanticTokens.fire();
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens | undefined> {
    try {
      const file = await this.provider.ensureDocumentCurrent(
        document,
        token,
        false,
      );
      if (!file) {
        return;
      }

      const key = `${document.version}:${JSON.stringify(file.analysisState)}:${file.project.analysis.generation}`;
      const cached = this.cache.get(file);
      if (cached?.key === key) return cached.tokens;
      const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
      const emitted = new Set<string>();
      const references = [
        ...file.refs,
        ...file.project.analysis.spellingReferences(file.path.absolute),
      ];
      for (const ref of references) {
        if (token.isCancellationRequested) return;
        const source: Range =
          ref.ownerUnitId === file.path.absolute ? ref.queryRange || ref : ref;
        if (source.file !== file) continue;
        const signifier = ref.item;
        if (
          ['self', 'other', 'noone', 'all', 'global'].includes(signifier.name)
        )
          continue;
        const location = locationOf(source);
        if (!location) continue;
        const range = location.range;
        if (
          !range.isSingleLine ||
          range.start.line < 0 ||
          range.end.line >= document.lineCount ||
          range.start.character < 0 ||
          range.end.character > document.lineAt(range.end.line).text.length
        )
          continue;
        const span = `${source.start.offset}:${source.end.offset}`;
        if (emitted.has(span)) continue;
        emitted.add(span);
        let type = inferSemanticToken(ref);
        if (type === 'variable' && signifier.instance) type = 'property';
        const modifiers = inferSemanticModifiers(ref);
        if (ref.isDef) modifiers.add('declaration');
        if (signifier.deprecated) modifiers.add('deprecated');
        if (
          (ref.evaluatedType || signifier.type).type.some((value) =>
            value.kind.startsWith('Asset.'),
          )
        )
          modifiers.add('asset');
        builder.push(range, type, [...modifiers]);
      }
      const tokens = builder.build();
      this.cache.set(file, { key, tokens });
      return tokens;
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

function inferSemanticToken(ref: Reference): SemanticTokenType {
  const signifier = ref.item;
  const functionType = (ref.evaluatedType || signifier.type).type.find(
    (type) => type.kind === 'Function',
  );

  if (signifier.enum) {
    return 'enum';
  }
  if (signifier.enumMember) {
    return 'enumMember';
  }
  if (functionType?.isConstructor) {
    return 'class';
  }
  if (functionType) {
    return 'function';
  }
  if (signifier.macro) {
    return 'macro';
  }
  if (signifier.parameter) {
    return 'parameter';
  }
  if (signifier.instance && !!signifier.def) {
    return 'property';
  }
  return 'variable';
}

/** Clobbers conflicting, allowing e.g. overriding type modifiers with symbol modifiers. */
function inferSemanticModifiers(
  ref: Reference,
  modifiers = new Set<SemanticTokenModifier>(),
): Set<SemanticTokenModifier> {
  const signifier = ref.item;
  // const isDeclaration = signifier.def?.file && ref.isDef;

  // // If only the only reference is also the declaration,
  // // then this is an unused variable.
  // const unused = isDeclaration && signifier.refs.size === 1;
  // if (unused) {
  //   modifiers.add('deprecated');
  // }

  if (signifier.native) {
    modifiers.add('defaultLibrary');
  } else {
    // modifiers.delete('defaultLibrary');
  }

  if (signifier.global) {
    modifiers.add('global');
    modifiers.delete('local');
  }
  if (signifier.local) {
    modifiers.add('local');
    modifiers.delete('global');
  }

  if (!signifier.writable) {
    modifiers.add('readonly');
  } else {
    modifiers.delete('readonly');
  }

  if (signifier.static) {
    modifiers.add('static');
  } else {
    modifiers.delete('static');
  }
  return modifiers;
}
