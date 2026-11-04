import type { Code } from './project.code.js';
import type { Signifier } from './signifiers.js';
import type { Type } from './types.js';

// Anonymous literals have identity within one parsed syntax tree. Derived call
// results must compare through that identity, not their temporary wrappers.
const literalIds = new WeakMap<Type, number>();
let nextLiteralId = 0;
export function identifyLiteral(type: Type) {
  literalIds.set(type, ++nextLiteralId);
}

function definition(symbol: Signifier) {
  const range = symbol.def;
  if (!range?.file) return !!range;
  const source = range.source;
  return [source.file.path.absolute, source.start.offset, source.end.offset];
}

/** Compare published bindings with a flat, shared graph instead of a recursive tree. */
export function semanticSignature(code: Code, includeLocals = false): string {
  const nodes: unknown[][] = [];
  const ids = new Map<Type | string, number>();
  const pending: (() => void)[] = [];
  // Comparison may collapse equal views; live unions must retain every mutable
  // branch because another assignment can add members after the union is made.
  const identity = (type: Type): Type | string =>
    type.kind !== 'Function' && type.name
      ? JSON.stringify([type.kind, type.name, type.isReadonly, type.isGeneric])
      : type.inferenceIdentity;
  function links(values: Type[]): number[] {
    const distinct = new Map<Type | string, Type>();
    for (const type of values) distinct.set(identity(type), type);
    const types = [...distinct.values()];
    const result: number[] = new Array(types.length);
    for (let index = types.length - 1; index >= 0; index--) {
      pending.push(() => {
        const type = types[index];
        let root = type;
        while (root.extends && root.kind === root.extends.kind) {
          if (root.name || literalIds.has(root)) break;
          root = root.extends;
        }
        const key = identity(type);
        const previous = ids.get(key);
        if (previous !== undefined) {
          result[index] = previous;
          return;
        }
        const id = nodes.length;
        result[index] = id;
        ids.set(key, id);
        const row: unknown[] = [
          type.kind,
          type.name || '',
          literalIds.get(root) || 0,
          type.isReadonly,
          type.isGeneric,
        ];
        nodes.push(row);
        if (type.kind !== 'Function' && type.name) return;
        if (type.kind === 'Function') {
          const lineage: string[] = [];
          const seen = new Set<Type>();
          for (
            let self: Type | undefined = type.self;
            self && !seen.has(self);
            self = self.extends
          ) {
            seen.add(self);
            lineage.push(self.name || self.kind);
          }
          row.push(
            type.isConstructor,
            type
              .listParameters()
              .map((parameter) =>
                parameter
                  ? [
                      parameter.name,
                      parameter.optional,
                      links(parameter.type.type),
                    ]
                  : null,
              ),
            links(type.returns?.type || []),
            lineage,
          );
        } else if (type.kind === 'Struct') {
          const members = new Map(
            type
              .listMembers()
              .filter((member) => member.def)
              .map((member) => [member.name, member]),
          );
          row.push(
            [...members]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, member]) => [
                name,
                definition(member),
                links(member.type.type),
              ]),
          );
        } else {
          row.push(links(type.items?.type || []));
        }
      });
    }
    return result;
  }
  const symbols = new Set<Signifier>();
  for (const ref of code.refs) {
    if (ref.item.def?.file === code && (includeLocals || !ref.item.local))
      symbols.add(ref.item);
  }
  const ordered = [...symbols].sort((a, b) =>
    JSON.stringify([a.name, definition(a)]).localeCompare(
      JSON.stringify([b.name, definition(b)]),
    ),
  );
  const roots = ordered.map((symbol) => [
    symbol.name,
    definition(symbol),
    links(symbol.type.type),
  ]);
  while (pending.length) pending.pop()!();
  return JSON.stringify([roots, nodes]);
}

/** Directed definition-to-reader edges, captured before definitions are retired. */
export function semanticReaders(code: Code): Set<Code> {
  const readers = new Set<Code>();
  const symbols = new Set<Signifier>();
  for (const ref of code.refs) {
    if (ref.item.def?.file === code) symbols.add(ref.item);
  }
  for (const symbol of symbols) {
    for (const ref of symbol.refs) if (ref.file !== code) readers.add(ref.file);
  }
  return readers;
}
