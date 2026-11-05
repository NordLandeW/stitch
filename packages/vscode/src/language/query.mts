import {
  isAssetOfKind,
  primitiveNames,
  type Code,
  type Project,
  type Range,
  type Reference,
  type Signifier,
  type Type,
} from '@bscotch/gml-parser';
import { pathy } from '@bscotch/pathy';
import { completionAnchor } from './completion-context.mjs';
import {
  documentationCompletions,
  documentationContext,
} from './documentation-context.mjs';
import {
  collectGmlDocumentSymbols,
  type GmlDocumentSymbol,
} from '../extension.documentSymbols.core.mjs';
import type {
  Completion,
  DiagnosticSnapshot,
  DocumentSymbol,
  Location,
  Query,
  QueryKind,
  QueryResults,
  RenamePlan,
  Span,
  Token,
  WorkspaceSymbol,
} from './protocol.mjs';

const lineCache = new WeakMap<Code, { text: string; lines: string[] }>();
function linesOf(file: Code): string[] {
  let cached = lineCache.get(file);
  if (cached?.text !== file.content) {
    cached = { text: file.content, lines: file.content.split(/\r\n|\r|\n/) };
    lineCache.set(file, cached);
  }
  return cached!.lines;
}
/** Physical source projection happens beside the graph that owns the mapping. */
export function spanOf(
  range: import('@bscotch/gml-parser').DiagnosticsEventPayload['diagnostics'][number]['location'],
  file?: Code,
): Span {
  const source = 'source' in range ? (range as Range).source : range;
  const owner = 'file' in source ? (source as Range).file : file;
  const lines = owner ? linesOf(owner) : undefined;
  if (!lines) {
    const nonnegative = (value: number) =>
      Number.isFinite(value) ? Math.max(0, value) : 0;
    return {
      start: {
        line: nonnegative(source.start.line - 1),
        character: nonnegative(source.start.column - 1),
      },
      end: {
        line: nonnegative(source.end.line - 1),
        character: nonnegative(source.end.column),
      },
    };
  }
  const bound = (line: number, character: number) => {
    line = Math.max(
      0,
      Math.min(
        Number.isFinite(line) ? line : lines.length - 1,
        lines.length - 1,
      ),
    );
    return {
      line,
      character: Math.max(
        0,
        Math.min(
          Number.isFinite(character) ? character : lines[line].length,
          lines[line].length,
        ),
      ),
    };
  };
  return {
    start: bound(source.start.line - 1, source.start.column - 1),
    end: bound(source.end.line - 1, source.end.column),
  };
}
export function locationOf(range: Range | string): Location {
  return typeof range === 'string'
    ? {
        path: range,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      }
    : { path: range.source.file.path.absolute, ...spanOf(range) };
}
function uniqueLocations(locations: Location[]): Location[] {
  return [
    ...new Map(
      locations.map((location) => [JSON.stringify(location), location]),
    ).values(),
  ];
}
function definitionOf(ref: Reference): Location | undefined {
  const item = ref.item;
  const assetName = item.asset
    ? item.name
    : item.getTypeByKind('Id.Instance')?.name ||
      item.getTypeByKind('Asset.GMObject')?.name;
  if (item.native && item.name !== 'event_inherited') return;
  if (item.name === 'event_inherited') {
    let parent = ref.file.asset.parent;
    const visited = new Set<unknown>();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const event = parent.gmlFilesArray.find(
        (file) => file.name === ref.file.name,
      );
      if (event) return locationOf(event.startRange);
      parent = parent.parent;
    }
  } else if (!item.native && item.def?.file) return locationOf(item.def);
  else if (assetName) {
    const asset = ref.file.project.getAssetByName(assetName);
    if (isAssetOfKind(asset, 'objects')) {
      const files = asset.gmlFilesArray;
      const file =
        files.find((file) => file.isCreateEvent || file.isStepEvent) ||
        files[0];
      if (file) return locationOf(file.startRange);
    } else if (isAssetOfKind(asset, 'shaders') && asset.shaderPaths.fragment)
      return locationOf(asset.shaderPaths.fragment.absolute);
    else if (isAssetOfKind(asset, 'sounds') && asset.soundFile)
      return locationOf(asset.soundFile.absolute);
  }
  return;
}
function completions(
  file: Code,
  offset: number,
  trigger?: string,
): Completion[] | undefined {
  const documentation = documentationContext(file.content, offset);
  if (documentation)
    return documentationCompletions(
      documentation,
      completionTypeNames(file.project),
    );
  offset = completionAnchor(file.content, offset);
  if (file.getJsdocAt(offset)) return [];
  if (trigger && trigger !== '.') return;
  return completionSymbols(file, offset)
    .filter((item) => item.name)
    .map(completionValue);
}
export function completionTypeNames(project: Project): string[] {
  return [...new Set([...project.types.keys(), ...primitiveNames])];
}
export function completionSymbols(file: Code, offset: number): Signifier[] {
  return (
    file.getStructNewMemberRangeAt(offset)?.type.listMembers() ||
    file.getInScopeSymbolsAt(offset)
  );
}
export function completionValue(item: Signifier): Completion {
  const fn = item.getTypeByKind('Function');
  return {
    name: item.name!,
    kind: item.getTypeByKind('Enum')
      ? 'enum'
      : fn?.isConstructor
        ? 'constructor'
        : fn
          ? 'function'
          : 'variable',
    definitionPath: item.def?.file?.path.absolute,
    detail: [
      item.type.toFeatherString(),
      item.native && 'native',
      item.global && 'global',
      item.local && 'local',
      item.parameter && 'parameter',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
function renameReference(file: Code, offset: number): Reference {
  const ref =
    file.getReferenceAt(offset) ||
    (offset > 0 ? file.getReferenceAt(offset - 1) : undefined);
  if (!ref)
    throw new Error(
      'No unique symbol reference; a shared macro spelling may bind to different symbols',
    );
  const item = ref.item;
  const source = ref.source;
  if (
    !item.name ||
    source.file.content.slice(source.start.offset, source.end.offset + 1) !==
      item.name
  )
    throw new Error('Cannot rename from type string');
  if (item.native) throw new Error('Cannot rename native functions');
  if (item.asset) throw new Error('Rename assets using the asset tree');
  if (!item.isRenameable || !ref.isRenameable)
    throw new Error('Cannot rename this symbol');
  return ref;
}
function renamePlan(
  project: Project,
  item: Signifier,
  name: string,
): RenamePlan {
  const edits = project.renameEdits(item, name);
  const sources = new Map<string, string>();
  return {
    edits: edits.map((edit) => {
      const source = edit.range.source;
      sources.set(source.file.path.absolute, source.file.content);
      return { location: locationOf(source), text: edit.text };
    }),
    sources: [...sources].map(([path, text]) => ({ path, text })),
  };
}
function tokenType(ref: Reference): string {
  const item = ref.item,
    fn = item.getTypeByKind('Function');
  return item.enum
    ? 'enum'
    : item.enumMember
      ? 'enumMember'
      : fn?.isConstructor
        ? 'class'
        : fn
          ? 'function'
          : item.macro
            ? 'macro'
            : item.parameter
              ? 'parameter'
              : item.instance && !!item.def
                ? 'property'
                : 'variable';
}
function tokens(file: Code): Token[] {
  const spellings = new Map<string, { ref: Reference; ambiguous: boolean }>();
  for (const ref of file.sourceRefs) {
    const source = ref.source,
      key = `${source.start.offset}:${source.end.offset}`;
    const prior = spellings.get(key);
    if (!prior) spellings.set(key, { ref, ambiguous: false });
    else if (tokenType(prior.ref) !== tokenType(ref)) prior.ambiguous = true;
  }
  const result: Token[] = [];
  let previousEnd = -1;
  for (const { ref, ambiguous } of spellings.values()) {
    const source = ref.source,
      item = ref.item;
    if (
      source.file !== file ||
      !Number.isFinite(source.start.line) ||
      source.start.line !== source.end.line ||
      source.start.offset <= previousEnd
    )
      continue;
    if (
      item.name &&
      ['self', 'other', 'noone', 'all', 'global'].includes(item.name)
    )
      continue;
    const range = spanOf(ref);
    if (range.end.character <= range.start.character) continue;
    previousEnd = source.end.offset;
    const modifiers: string[] = [];
    if (!ambiguous) {
      if (item.native) modifiers.push('defaultLibrary');
      if (item.local) modifiers.push('local');
      else if (item.global) modifiers.push('global');
      if (!item.writable) modifiers.push('readonly');
      if (item.static) modifiers.push('static');
      if (item.type.type.some((type) => type.kind.startsWith('Asset.')))
        modifiers.push('asset');
    }
    result.push({
      range,
      type: ambiguous
        ? 'variable'
        : item.instance && tokenType(ref) === 'variable'
          ? 'property'
          : tokenType(ref),
      modifiers,
    });
  }
  return result;
}
function documentSymbol(symbol: GmlDocumentSymbol): DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: symbol.kind,
    range: spanOf(symbol.range),
    selectionRange: spanOf(symbol.selectionRange),
    deprecated: !!symbol.item.deprecated,
    children: symbol.children.map(documentSymbol),
  };
}
function workspaceSymbols(project: Project, query: Query): WorkspaceSymbol[] {
  const result = new Map<object, WorkspaceSymbol>();
  const add = (item: Signifier) => {
    if (!item.name || !item.def?.file || result.has(item)) return;
    const fn = item.getTypeByKind('Function');
    result.set(item, {
      name: item.name,
      kind: item.enum
        ? 'enum'
        : item.enumMember
          ? 'enumMember'
          : item.macro
            ? 'constant'
            : fn?.isConstructor
              ? 'constructor'
              : fn
                ? 'function'
                : 'variable',
      container: item.type.kind,
      location: locationOf(item.def),
    });
  };
  const members = (type?: Type) => {
    for (const member of type?.listMembers(true) || []) add(member);
  };
  for (const item of [
    ...project.macros.activeSymbols(),
    ...project.self.listMembers(),
  ]) {
    add(item);
    const fn = item.getTypeByKind('Function');
    if (query.includeInstance && fn?.self && (item.mixin || fn.isConstructor))
      members(fn.self);
  }
  for (const asset of project.assets.values()) {
    if (asset.assetKind === 'scripts') {
      if (
        asset.gmlFile &&
        project.self.getMember(asset.name)?.def?.file !== asset.gmlFile
      )
        result.set(asset, {
          name: asset.name,
          kind: 'module',
          container: asset.assetKind,
          location: locationOf(asset.gmlFile.path.absolute),
        });
    } else if (isAssetOfKind(asset, 'shaders')) {
      if (asset.shaderPaths.fragment)
        result.set(asset, {
          name: asset.name,
          kind: 'module',
          container: asset.assetKind,
          location: locationOf(asset.shaderPaths.fragment.absolute),
        });
    } else if (asset.assetKind === 'objects') {
      for (const file of asset.gmlFiles.values()) {
        result.set(file, {
          name: asset.name,
          kind: 'class',
          container: `${asset.assetKind} (${file.path.name})`,
          location: locationOf(file.path.absolute),
        });
        if (query.includeInstance) members(file.asset.variables);
      }
    } else
      result.set(asset, {
        name: asset.name,
        kind: 'file',
        container: asset.assetKind,
        location: locationOf(asset.yyPath.absolute),
      });
  }
  if (query.includeLocal && query.path)
    for (const scope of project.getGmlFile(pathy(query.path))?.scopes || [])
      members(scope.local);
  return [...result.values()];
}

export function nativeCandidates(project: Project): Completion[] {
  return project.self
    .listMembers()
    .filter((item) => item.native && item.name)
    .map((item) => ({
      name: item.name!,
      kind: item.getTypeByKind('Function') ? 'function' : 'variable',
      detail: 'Analysis updating · built-in candidate',
      fallback: 'native',
    }));
}

/** The sole query implementation, executed on the language graph's thread. */
export function queryLanguage<K extends QueryKind>(
  project: Project,
  query: Query<K>,
): QueryResults[K] {
  return execute(project, query) as QueryResults[K];
}
function execute(project: Project, query: Query): unknown {
  if (query.kind === 'workspaceSymbols')
    return workspaceSymbols(project, query);
  if (query.kind === 'assetRename') {
    return project.createAssetRenamePlan(query.assetName!, query.newName!);
  }
  const file = query.path && project.getGmlFile(pathy(query.path));
  if (!file || file.isRetired) return;
  const offset = query.offset || 0;
  const refs = () => file.getReferenceCandidatesAt(offset);
  switch (query.kind) {
    case 'completion':
      return completions(file, offset, query.trigger);
    case 'definition':
      return uniqueLocations(
        refs().flatMap((ref) => {
          const location = definitionOf(ref);
          return location ? [location] : [];
        }),
      );
    case 'typeDefinition':
      return uniqueLocations(
        (file.getReferenceAt(offset)?.item.type.type || []).flatMap((type) =>
          type.signifier?.def?.file ? [locationOf(type.signifier.def)] : [],
        ),
      );
    case 'references':
      return uniqueLocations(
        [...new Set(refs().map((ref) => ref.item))].flatMap((item) =>
          [...item.refs].map((ref) => locationOf(ref)),
        ),
      );
    case 'prepareRename':
      return spanOf(renameReference(file, offset));
    case 'rename':
      return renamePlan(
        project,
        renameReference(file, offset).item,
        query.newName!,
      );
    case 'hover': {
      const items = new Set(refs().map((ref) => ref.item));
      if (!items.size) return;
      const code = new Set<string>(),
        text = new Set<string>(),
        sprites = new Set<string>();
      if (items.size > 1)
        text.add('This spelling has multiple macro expansion contexts.');
      for (const item of items) {
        if (item.description) text.add(item.description);
        if (!item.type.type.length) code.add('Any');
        for (const type of item.type.type) {
          if (type.code) code.add(type.code);
          if (type.description) text.add(type.description);
          if (type.details) text.add(type.details);
          if (type.kind === 'Asset.GMSprite' && item.name)
            sprites.add(item.name);
        }
      }
      return { code: [...code], text: [...text], sprites: [...sprites] };
    }
    case 'selection': {
      const ref = file.getReferenceAt(offset);
      if (!ref) return;
      const item = ref.item;
      return {
        name: item.name,
        native: !!item.native,
        assetName: item.asset ? item.name : item.def?.file?.asset.name,
        type: item.type.constructs.length
          ? `Struct.${item.name}`
          : item.type.toFeatherString(),
      };
    }
    case 'signature': {
      const args = file.getFunctionArgRangeAt(offset);
      if (!args?.param?.parent) return;
      return {
        label: args.type.code,
        description: args.type.description,
        activeParameter: args.param.idx!,
        parameters: args.type.listParameters().map((param) => ({
          name: param?.name || 'unknown',
          description: param?.description,
        })),
      };
    }
    case 'tokens':
      return tokens(file);
    case 'documentSymbols':
      return collectGmlDocumentSymbols(file).map(documentSymbol);
  }
  return undefined;
}

export function diagnosticSnapshot(
  payload: import('@bscotch/gml-parser').DiagnosticsEventPayload,
): DiagnosticSnapshot {
  return {
    path: payload.filePath,
    text: payload.code?.content,
    folder: (payload.code?.asset.yy.parent as { path?: string } | undefined)
      ?.path,
    diagnostics: payload.diagnostics.map((diagnostic) => ({
      range: spanOf(diagnostic.location, payload.code),
      message: diagnostic.message,
      severity:
        diagnostic.severity === 'error'
          ? 'error'
          : diagnostic.severity === 'info'
            ? 'info'
            : 'warning',
    })),
  };
}
