import { Range, type Code, type Signifier } from '@bscotch/gml-parser';

export type GmlDocumentSymbolKind =
  | 'constant'
  | 'constructor'
  | 'enum'
  | 'enumMember'
  | 'field'
  | 'function'
  | 'method'
  | 'struct'
  | 'variable';

export interface GmlDocumentSymbol {
  readonly item: Signifier;
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
  const declaration = item.declaration;
  if (
    declaration?.file === item.def.file &&
    declaration.start.offset <= item.def.start.offset &&
    declaration.end.offset >= item.def.end.offset
  ) {
    return declaration;
  }
  return new Range(item.def.start, item.def.end);
}

function contains(parent: Range, child: Range) {
  return (
    parent.file === child.file &&
    parent.start.offset <= child.start.offset &&
    parent.end.offset >= child.end.offset
  );
}

/**
 * Collect parser-backed symbols defined by one GML document and arrange them
 * into their lexical hierarchy.
 */
export function collectGmlDocumentSymbols(file: Code): GmlDocumentSymbol[] {
  const items = new Set<Signifier>();
  for (const reference of file.refs) {
    if (
      reference.isDef &&
      !reference.item.parameter &&
      reference.item.def?.file === file
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
      const selectionRange = item.def?.file ? item.def : undefined;
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
    .sort(
      (a, b) =>
        a.range.start.offset - b.range.start.offset ||
        b.range.end.offset - a.range.end.offset ||
        a.name.localeCompare(b.name),
    );

  const roots: GmlDocumentSymbol[] = [];
  const parents: GmlDocumentSymbol[] = [];
  for (const symbol of symbols) {
    while (parents.length && !contains(parents.at(-1)!.range, symbol.range)) {
      parents.pop();
    }
    const parent = parents.at(-1);
    if (parent) {
      parent.children.push(symbol);
    } else {
      roots.push(symbol);
    }
    if (
      symbol.range.start.offset < symbol.range.end.offset &&
      (symbol.kind === 'constructor' ||
        symbol.kind === 'enum' ||
        symbol.kind === 'function' ||
        symbol.kind === 'method' ||
        symbol.kind === 'struct')
    ) {
      parents.push(symbol);
    }
  }
  return roots;
}
