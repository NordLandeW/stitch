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
  if (typeof type === 'string') {
    return flattenFeatherTypes(parseFeatherTypeString(type), flattened);
  }
  if (type.kind === 'type') {
    flattened.push(type);
    if (type.of) {
      flattenFeatherTypes(type.of, flattened);
    }
  } else {
    type.types.forEach((t) => flattenFeatherTypes(t, flattened));
  }
  return flattened;
}

export interface FeatherTypeDiagnostic {
  message: string;
  /** Zero-based offset within the type string. */
  offset: number;
  /** Length of the offending token; zero denotes an empty type string. */
  length: number;
}

/**
 * Parse a type string, retaining recognizable types around local syntax errors.
 * Callers displaying diagnostics can supply a collector without changing the
 * type tree consumed by existing native/type-resolution callers.
 */
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
    // Preserve the historical inferred default for callers without a type.
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
      // A leading wrapper (<Real|String> or [Real|String]) is accepted for
      // compatibility. Other ownerless brackets recover into the same union.
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
        // Never pop the root. Treat an extra closer as a synchronization point
        // so a later type (and the rest of the document) remains available.
        report(`Unexpected closing bracket '${match[0]}'`, match.index);
        frame.currentType = undefined;
        frame.expectType = true;
        continue;
      }
      const expected = frame.opening!.content === '<' ? '>' : ']';
      if (match[0] !== expected) {
        report(`Expected '${expected}' but found '${match[0]}'`, match.index);
      }
      if (frame.separator) {
        report(
          'Expected a type after union separator',
          frame.separator.offset,
          frame.separator.length,
        );
      } else if (!frame.union.types.length) {
        report(`Expected a type before '${match[0]}'`, match.index);
      }
      stack.pop();
      continue;
    }

    match = lex(or);
    if (match) {
      if (frame.expectType && (!frame.union.types.length || frame.separator)) {
        report(
          'Expected a type before union separator',
          match.index,
          match[0].length,
        );
      }
      frame.currentType = undefined;
      frame.expectType = true;
      frame.separator = { offset: match.index, length: match[0].length };
      continue;
    }

    match = lex(identifier);
    if (match) {
      if (!frame.expectType) {
        report(
          'Expected a union separator before type',
          match.index,
          match[0].length,
        );
      }
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

    // Consume, rather than silently truncate at, an unsupported token. Every
    // branch advances the cursor, including malformed and incomplete input.
    report(`Unexpected character '${typeString[offset]}' in type`, offset);
    offset++;
    frame.currentType = undefined;
    frame.expectType = true;
  }

  for (const frame of stack) {
    if (frame.separator) {
      report(
        'Expected a type after union separator',
        frame.separator.offset,
        frame.separator.length,
      );
    }
    if (frame.opening) {
      const expected = frame.opening.content === '<' ? '>' : ']';
      report(`Missing closing bracket '${expected}'`, frame.opening.offset);
    }
  }
  return rootUnion;
}

export function typeToFeatherString(type: Type): string {
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
  // Arrays etc can contain items of a type) {
  if (type.items?.type.length) {
    return `${type.kind}<${type.items.type
      .map((t) => t.toFeatherString())
      .join('|')}>`;
  }
  return type.kind;
}
