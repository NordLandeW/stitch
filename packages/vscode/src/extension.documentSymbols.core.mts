import {
  Position,
  Range,
  type Code,
  type Signifier,
} from '@bscotch/gml-parser';
import type { DocumentSymbol } from './language/protocol.mjs';

export type GmlDocumentSymbolKind = DocumentSymbol['kind'];

export interface GmlDocumentSymbol {
  readonly item?: Signifier;
  readonly name: string;
  readonly detail: string;
  readonly kind: GmlDocumentSymbolKind;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children: GmlDocumentSymbol[];
}

function kindOf(item: Signifier): GmlDocumentSymbolKind {
  const functionType = item.getTypeByKind('Function');
  if (item.enum) return 'enum';
  if (item.enumMember) return 'enumMember';
  if (item.macro) return 'constant';
  if (functionType?.isConstructor) return 'constructor';
  if (functionType) {
    return item.global || item.local ? 'function' : 'method';
  }
  if (item.getTypeByKind('Struct')) return 'struct';
  if (item.instance || item.static) return 'field';
  return 'variable';
}

function detailOf(item: Signifier): string {
  const functionType = item.getTypeByKind('Function');
  if (!functionType) {
    return item.global && !item.enum && !item.macro ? 'global' : '';
  }
  const parameters = functionType.listParameters().map((parameter) => {
    if (!parameter) return '?';
    return `${parameter.name}${parameter.optional ? '?' : ''}`;
  });
  const parameterDetail = `(${parameters.join(', ')})`;
  const parentName = functionType.isConstructor
    ? functionType.self?.extends?.name ||
      functionType.self?.extends?.signifier?.name
    : undefined;
  const inheritanceDetail = parentName ? `: ${parentName}` : '';
  return [
    functionType.isConstructor ? 'constructor' : '',
    parameterDetail,
    inheritanceDetail,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Local variables are implementation details. Local function and constructor
 * declarations remain useful navigation targets, as do explicitly static
 * declarations.
 */
function isExcludedLocal(item: Signifier): boolean {
  return item.local && !item.static && !item.getTypeByKind('Function');
}

/**
 * Struct-literal entries are parser signifiers too, but entries belonging to
 * an anonymous or excluded local literal are implementation details rather
 * than document symbols. Follow named struct owners outward so nested named
 * structs remain visible only when their whole ownership chain is visible.
 */
function belongsToAnonymousStruct(
  item: Signifier,
  structOwners: ReadonlyMap<object, Signifier>,
): boolean {
  let current = item;
  const visited = new Set<Signifier>();
  while (current.instance && !visited.has(current)) {
    visited.add(current);
    const owner = structOwners.get(current.parent) || current.parent._signifier;
    if (!owner) return true;
    if (isExcludedLocal(owner)) return true;
    if (owner.asset || owner.global) return false;
    current = owner;
  }
  return false;
}

function symbolRange(item: Signifier): Range | undefined {
  if (!item.def?.file) return;
  const definition = item.def.source;
  const declaration = item.declaration?.source;
  if (
    declaration?.file === definition.file &&
    declaration.start.offset <= definition.start.offset &&
    declaration.end.offset >= definition.end.offset
  ) {
    return declaration;
  }
  return definition;
}

function contains(parent: Range, child: Range) {
  return (
    parent.file === child.file &&
    parent.start.offset <= child.start.offset &&
    parent.end.offset >= child.end.offset
  );
}

function regionSymbols(file: Code): GmlDocumentSymbol[] {
  const result: GmlDocumentSymbol[] = [];
  const open: GmlDocumentSymbol[] = [];
  for (const marker of file.regionMarkers) {
    const offset = marker.startOffset;
    const { line: lineNumber, column } = file.sourcePositionAt(offset);
    // Match the line-leading directives used by editor folding.
    if (
      column > 1 &&
      /\S/.test(file.content.slice(offset - column + 1, offset))
    )
      continue;
    const line = marker.image.split('\r', 1)[0].trimEnd();
    const at = (index: number) =>
      new Position(file, offset + index, lineNumber, column + index);
    if (marker.tokenType.name === 'EndRegion') {
      if (/^#endregion\b/.test(line)) {
        const previous = open.pop();
        if (previous) previous.range.end = at(line.length - 1);
      }
      continue;
    }
    const title = line.slice('#region'.length).trimStart();
    const end = at(line.length - 1);
    const range = Range.physical(at(0), end);
    const symbol: GmlDocumentSymbol = {
      name: title || '#region',
      detail: '',
      kind: 'region',
      range,
      selectionRange: Range.physical(
        title ? at(line.length - title.length) : range.start,
        end,
      ),
      children: [],
    };
    // While the footer is missing, keep the heading navigable without
    // moving the rest of the document into an unfinished section.
    result.push(symbol);
    open.push(symbol);
  }
  return result;
}

function enclosing(parents: GmlDocumentSymbol[], range: Range) {
  while (
    parents.length &&
    parents.at(-1)!.range.end.offset < range.start.offset
  )
    parents.pop();
  for (let i = parents.length - 1; i >= 0; i--) {
    if (contains(parents[i].range, range)) return parents[i];
  }
  return undefined;
}

/**
 * Collect parser-backed symbols defined by one GML document and arrange them
 * into their lexical hierarchy.
 */
export function collectGmlDocumentSymbols(file: Code): GmlDocumentSymbol[] {
  const macros = file.project.macros.declarationsIn(file);
  const macroItems = new Set(macros.map((declaration) => declaration.item));
  const items = new Set<Signifier>();
  for (const reference of file.sourceRefs) {
    if (
      reference.isDef &&
      !reference.item.parameter &&
      !macroItems.has(reference.item) &&
      reference.item.def?.file &&
      reference.item.def.source.file === file
    ) {
      items.add(reference.item);
    }
  }

  const structOwners = new Map<object, Signifier>();
  for (const item of items) {
    const functionType = item.getTypeByKind('Function');
    if (functionType?.isConstructor && functionType.self) {
      structOwners.set(functionType.self, item);
    }
    const structType = item.getTypeByKind('Struct');
    if (structType && item.declaration) {
      structOwners.set(structType, item);
    }
  }

  const symbols = [...items]
    .filter(
      (item) =>
        !isExcludedLocal(item) && !belongsToAnonymousStruct(item, structOwners),
    )
    .map((item): GmlDocumentSymbol | undefined => {
      const selectionRange = item.def?.file ? item.def.source : undefined;
      const range = symbolRange(item);
      if (!selectionRange || !range || !item.name) return;
      return {
        item,
        name: item.name,
        detail: detailOf(item),
        kind: kindOf(item),
        range,
        selectionRange,
        children: [],
      };
    })
    .filter((symbol): symbol is GmlDocumentSymbol => !!symbol)
    .concat(
      macros.map((declaration) => ({
        ...declaration,
        name: declaration.item.name!,
        detail: declaration.configuration || '',
        kind: 'constant' as const,
        children: [],
      })),
    )
    .concat(regionSymbols(file))
    .sort(
      (a, b) =>
        a.range.start.offset - b.range.start.offset ||
        b.range.end.offset - a.range.end.offset ||
        a.name.localeCompare(b.name),
    );

  const roots: GmlDocumentSymbol[] = [];
  const declarations: GmlDocumentSymbol[] = [];
  const regions: GmlDocumentSymbol[] = [];
  for (const symbol of symbols) {
    // Region boundaries can cross declarations. Keep both stacks alive and
    // preserve the declaration owner if neither container contains the other.
    const declaration = enclosing(declarations, symbol.range);
    const region = enclosing(regions, symbol.range);
    const parent =
      region && (!declaration || contains(declaration.range, region.range))
        ? region
        : declaration;
    if (parent) {
      parent.children.push(symbol);
    } else {
      roots.push(symbol);
    }
    if (symbol.kind === 'region') {
      regions.push(symbol);
    } else if (
      symbol.range.start.offset < symbol.range.end.offset &&
      (symbol.kind === 'constructor' ||
        symbol.kind === 'enum' ||
        symbol.kind === 'function' ||
        symbol.kind === 'method' ||
        symbol.kind === 'struct')
    ) {
      declarations.push(symbol);
    }
  }
  return roots;
}
