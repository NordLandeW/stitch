// Handle GameMaker JSDoc typestrings
// GameMaker allows for some variations on the allowed syntax.
// Examples:
//  - `String`
//  - `String|Real`
//  - `String,Real`
//  - `String OR Real`
//  - `Array`
//  - `Array<String>`
//  - `Array[String|Real]`

import type { Type } from './types.js';

export interface FeatherTypeUnion {
  kind: 'union';
  types: FeatherType[];
}

export interface FeatherType {
  kind: 'type';
  name: {
    content: string;
    offset: number;
    inferred?: boolean;
  };
  of?: FeatherTypeUnion;
}

/**
 * Given a parsed feather type, create a flat array of flat types.
 * Useful for e.g. getting the offsets of all types in a union.
 * @param flattened The array collecting the flattened types
 */
export function flattenFeatherTypes(
  type: FeatherTypeUnion | FeatherType | string,
  flattened: FeatherType[] = [],
): FeatherType[] {
  const pending: (FeatherTypeUnion | FeatherType)[] = [
    typeof type === 'string' ? parseFeatherTypeString(type) : type,
  ];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === 'type') {
      flattened.push(node);
      if (node.of) pending.push(node.of);
    } else {
      for (let index = node.types.length - 1; index >= 0; index--)
        pending.push(node.types[index]);
    }
  }
  return flattened;
}

export interface FeatherTypeDiagnostic {
  message: string;
  /** Zero-based offset within the type string. */
  offset: number;
  length: number;
}

/** Retain recognizable types around local errors without changing callers' type tree. */
export function parseFeatherTypeString(
  typeString: string,
  diagnostics: FeatherTypeDiagnostic[] = [],
): FeatherTypeUnion {
  const whitespace = /\s+/y;
  const leftBracket = /[<[]/y;
  const rightBracket = /[>\]]/y;
  const or = /(\bOR\b|\bor\b|\||,)/y;
  const identifier = /[a-zA-Z_][a-zA-Z0-9_.]*/y;
  let offset = 0;
  const report = (message: string, offset: number, length = 1) => {
    diagnostics.push({ message, offset, length });
  };
  const lex = (pattern: RegExp) => {
    pattern.lastIndex = offset;
    const match = pattern.exec(typeString);
    if (!match) return;
    offset = pattern.lastIndex;
    return match;
  };
  const rootUnion: FeatherTypeUnion = { kind: 'union', types: [] };
  interface Frame {
    union: FeatherTypeUnion;
    opening?: { content: string; offset: number };
    currentType?: FeatherType;
    expectType: boolean;
    separator?: { offset: number; length: number };
  }
  const stack: Frame[] = [{ union: rootUnion, expectType: true }];
  if (!typeString.trim()) {
    report('Expected a type', 0, typeString.length);
    rootUnion.types.push({
      kind: 'type',
      name: { content: 'Any', inferred: true, offset: 0 },
    });
    return rootUnion;
  }
  while (offset < typeString.length) {
    const frame = stack.at(-1)!;
    if (lex(whitespace)) continue;
    let match = lex(leftBracket);
    if (match) {
      let union = frame.union;
      if (frame.currentType) {
        union = { kind: 'union', types: [] };
        frame.currentType.of = union;
      } else if (stack.length !== 1 || frame.union.types.length) {
        report(`Expected a type before '${match[0]}'`, match.index);
      }
      // Leading <Real|String> and [Real|String] wrappers remain compatible.
      frame.currentType = undefined;
      frame.expectType = false;
      frame.separator = undefined;
      stack.push({
        union,
        opening: { content: match[0], offset: match.index },
        expectType: true,
      });
      continue;
    }
    match = lex(rightBracket);
    if (match) {
      if (stack.length === 1) {
        report(`Unexpected closing bracket '${match[0]}'`, match.index);
        frame.currentType = undefined;
        frame.expectType = true;
        continue;
      }
      const expected = frame.opening!.content === '<' ? '>' : ']';
      if (match[0] !== expected)
        report(`Expected '${expected}' but found '${match[0]}'`, match.index);
      if (frame.separator)
        report(
          'Expected a type after union separator',
          frame.separator.offset,
          frame.separator.length,
        );
      else if (!frame.union.types.length)
        report(`Expected a type before '${match[0]}'`, match.index);
      stack.pop();
      continue;
    }
    match = lex(or);
    if (match) {
      if (frame.expectType && (!frame.union.types.length || frame.separator))
        report(
          'Expected a type before union separator',
          match.index,
          match[0].length,
        );
      frame.currentType = undefined;
      frame.expectType = true;
      frame.separator = { offset: match.index, length: match[0].length };
      continue;
    }
    match = lex(identifier);
    if (match) {
      if (!frame.expectType)
        report(
          'Expected a union separator before type',
          match.index,
          match[0].length,
        );
      const type: FeatherType = {
        kind: 'type',
        name: { content: match[0], offset: match.index },
      };
      frame.union.types.push(type);
      frame.currentType = type;
      frame.expectType = false;
      frame.separator = undefined;
      continue;
    }
    report(`Unexpected character '${typeString[offset]}' in type`, offset);
    offset++;
    frame.currentType = undefined;
    frame.expectType = true;
  }
  for (const frame of stack) {
    if (frame.separator)
      report(
        'Expected a type after union separator',
        frame.separator.offset,
        frame.separator.length,
      );
    if (frame.opening)
      report(
        `Missing closing bracket '${frame.opening.content === '<' ? '>' : ']'}'`,
        frame.opening.offset,
      );
  }
  return rootUnion;
}

function simpleFeatherString(type: Type): string | undefined {
  // Functions, Structs, and Enums are the only types that can have names
  if (type.isGeneric && type.name) {
    return type.name;
  }
  if (type.signifier?.enumMember) {
    const parent = type.signifier.parent;
    return `Enum.${parent.name}.${type.name}`;
  }
  if (type.signifier?.enum) {
    return `Enum.${type.name}`;
  }
  if (type.name) {
    if (['Real', 'String', 'Boolean'].includes(type.kind)) {
      // Then this is a constant, represented in Feather as `Constant.<Class>`
      return `Constant.${type.name}`;
    }
    return `${type.kind}.${type.name}`;
  }
  return type.items?.type.length ? undefined : type.kind;
}

export function typeToFeatherString(type: Type): string {
  const simple = simpleFeatherString(type);
  if (simple !== undefined) return simple;
  const output: string[] = [];
  const active = new Set<Type>();
  const pending: (Type | '|' | { close: Type })[] = [type];
  while (pending.length) {
    const work = pending.pop()!;
    if (work === '|') output.push(work);
    else if ('close' in work) {
      output.push('>');
      active.delete(work.close);
    } else {
      const leaf = simpleFeatherString(work);
      if (leaf !== undefined) output.push(leaf);
      else if (active.has(work)) output.push(work.kind);
      else {
        active.add(work);
        output.push(work.kind, '<');
        pending.push({ close: work });
        const items = work.items!.type;
        for (let index = items.length - 1; index >= 0; index--) {
          pending.push(items[index]);
          if (index) pending.push('|');
        }
      }
    }
  }
  return output.join('');
}
