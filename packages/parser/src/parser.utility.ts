import { keysOf } from '@bscotch/utility';
import {
  createTokenInstance,
  type CstNode,
  type CstNodeLocation,
  type IToken,
  type TokenType,
} from 'chevrotain';
import type { Code } from './project.code.js';
import { t } from './tokens.js';
import type {
  AccessorSuffixesCstChildren,
  AccessorSuffixesCstNode,
  AssignmentCstChildren,
  AssignmentCstNode,
  AssignmentRightHandSideCstChildren,
  AssignmentRightHandSideCstNode,
  ExpressionCstChildren,
  PrimaryExpressionCstChildren,
  PropertyNameCstNode,
  FunctionArgumentCstNode,
  FunctionArgumentsCstNode,
  IdentifierCstChildren,
  IdentifierCstNode,
  MultilineDoubleStringLiteralCstChildren,
  MultilineSingleStringLiteralCstChildren,
  StringLiteralCstChildren,
} from '../gml-cst.js';
import { isArray, ok } from './util.js';

/** Right-hand side from the CST, normalized via `rhsFrom` */
export type Rhs =
  | AssignmentCstNode[]
  | AssignmentCstNode
  | AssignmentRightHandSideCstNode[]
  | AssignmentRightHandSideCstNode
  | AssignmentRightHandSideCstChildren
  | AssignmentCstChildren
  | undefined;

export function rhsFrom(
  item: Rhs,
): AssignmentRightHandSideCstChildren | undefined {
  if (item === undefined) {
    return;
  }
  if (isArray(item)) {
    return rhsFrom(item[0]?.children);
  }
  if ('name' in item) {
    if (item.name === 'assignmentRightHandSide') {
      return item.children;
    } else if (item.name == 'assignment') {
      return rhsFrom(item.children);
    } else {
      // Unexpected item type
      return undefined;
    }
  }
  if ('assignmentRightHandSide' in item) {
    return item.assignmentRightHandSide[0].children;
  }
  return item as AssignmentRightHandSideCstChildren;
}

/** A whole value, allowing transparent parentheses but no operation on it. */
export function unwrappedPrimary(
  expression: ExpressionCstChildren | undefined,
): PrimaryExpressionCstChildren | undefined {
  while (expression) {
    if (
      expression.assignment ||
      expression.binaryExpression ||
      expression.ternaryExpression
    )
      return;
    const primary = expression.primaryExpression?.[0]?.children;
    if (
      !primary ||
      primary.New ||
      primary.UnaryPrefixOperator ||
      primary.UnarySuffixOperator ||
      primary.assignment ||
      primary.accessorSuffixes
    )
      return;
    if (!primary.parenthesizedExpression) return primary;
    expression =
      primary.parenthesizedExpression[0].children.expression?.[0]?.children;
  }
  return;
}

function literalFromRhs(rhs: Rhs) {
  return unwrappedPrimary(rhsFrom(rhs)?.expression?.[0]?.children);
}

export function functionFromRhs(rhs: Rhs) {
  return literalFromRhs(rhs)?.functionExpression?.[0].children;
}

export function structLiteralFromRhs(rhs: Rhs) {
  return literalFromRhs(rhs)?.structLiteral?.[0].children;
}

export function arrayLiteralFromRhs(rhs: Rhs) {
  return literalFromRhs(rhs)?.arrayLiteral?.[0]?.children;
}

type NamedTokenNode = IdentifierCstNode | PropertyNameCstNode;
export type IdentifierSource =
  | IdentifierCstChildren
  | NamedTokenNode
  | NamedTokenNode[]
  | { identifier: NamedTokenNode[] }
  | { children: { identifier: NamedTokenNode[] } };

type AccessorSuffixName = keyof AccessorSuffixesCstChildren;
export type SortedAccessorSuffix<
  T extends AccessorSuffixName = AccessorSuffixName,
> = Required<AccessorSuffixesCstChildren>[T][0];

export function isEmpty(obj: unknown) {
  if (!obj) return true;
  if (typeof obj !== 'object')
    throw new Error('Can only check objects for emptiness.');
  return Object.keys(obj).length === 0;
}

/** Cursor-only delimiter for a partial CST; never an authored reference. */
export function recoveredDelimiter(
  file: Code,
  token: IToken | undefined,
  children: Record<string, (IToken | CstNode)[] | undefined>,
  tokenType: TokenType,
  image: string,
  edge: 'start' | 'end' = 'end',
): IToken {
  if (token && Number.isFinite(token.startOffset)) return token;
  const pending = Object.values(children).flatMap((parts) => parts || []);
  let offset: number | undefined;
  while (pending.length) {
    const part = pending.pop()!;
    let at: number | undefined;
    if ('children' in part) {
      // Full CST locations already bound real descendants and ignore inserted
      // NaN tokens. Reuse them instead of rescanning each nested partial tree.
      at =
        edge === 'end' ? part.location?.endOffset : part.location?.startOffset;
      if (!Number.isFinite(at)) {
        for (const nodes of Object.values(part.children))
          for (const node of nodes) pending.push(node);
      }
    } else if (!part.isInsertedInRecovery) {
      at = edge === 'end' ? part.endOffset : part.startOffset;
    }
    if (Number.isFinite(at))
      offset =
        offset === undefined
          ? at!
          : edge === 'end'
            ? Math.max(offset, at!)
            : Math.min(offset, at!);
  }
  const point = file.analysisPositionAt(
    offset === undefined
      ? file.analysisLength
      : offset + (edge === 'end' ? 1 : 0),
  );
  const result = createTokenInstance(
    tokenType,
    image,
    point.offset,
    point.offset,
    point.line,
    point.line,
    point.column,
    point.column,
  );
  result.isInsertedInRecovery = true;
  return result;
}

export function sortedFunctionCallParts(
  node: FunctionArgumentsCstNode,
  file: Code,
): (IToken | FunctionArgumentCstNode)[] {
  return [
    ...(node.children.StartParen || []),
    ...(node.children.functionArgument || []),
    ...(node.children.Comma || []),
    recoveredDelimiter(
      file,
      node.children.EndParen?.[0],
      node.children,
      t.EndParen,
      ')',
    ),
  ].sort((a, b) => {
    const aLocation = ('location' in a ? a.location! : a) as CstNodeLocation;
    const bLocation = ('location' in b ? b.location! : b) as CstNodeLocation;
    return aLocation.startOffset - bLocation.startOffset;
  });
}

export function stringLiteralAsString(
  children:
    | StringLiteralCstChildren
    | MultilineSingleStringLiteralCstChildren
    | MultilineDoubleStringLiteralCstChildren,
): string {
  const start =
    'StringStart' in children
      ? children.StringStart[0].image
      : 'MultilineSingleStringStart' in children
        ? children.MultilineSingleStringStart[0].image
        : children.MultilineDoubleStringStart[0].image;
  const end =
    'StringEnd' in children
      ? children.StringEnd[0].image
      : 'MultilineSingleStringEnd' in children
        ? children.MultilineSingleStringEnd[0].image
        : children.MultilineDoubleStringEnd[0].image;
  return `${start}${(children.Substring || [])
    .map((s) => s.image)
    .join('')}${end}`;
}

function getStartOffset(node: CstNode | IToken): number {
  return 'startOffset' in node ? node.startOffset : node.location!.startOffset;
}

export function sortChildren(
  records: Record<string, (IToken | CstNode)[]>,
): (IToken | CstNode)[] {
  const sorted: (IToken | CstNode)[] = [];
  for (const key of keysOf(records)) {
    sorted.push(...records[key]);
  }
  sorted.sort((a, b) => getStartOffset(a) - getStartOffset(b));
  return sorted;
}

export function sortedAccessorSuffixes(
  suffixNodes: AccessorSuffixesCstNode[] | undefined,
): SortedAccessorSuffix[] {
  // Convert into a flat array of suffixes, sorted by their position in the source code.
  const sorted: SortedAccessorSuffix[] = [];
  if (!suffixNodes) {
    return sorted;
  }
  for (const node of suffixNodes) {
    const { children } = node;
    const suffixKinds = keysOf(children);
    for (const kind of suffixKinds) {
      ok(children[kind]!.length === 1);
      sorted.push(children[kind]![0]);
    }
  }
  sorted.sort((a, b) => a.location!.startOffset - b.location!.startOffset);
  return sorted;
}

const identifierCstNames = [
  'All',
  'Global',
  'Identifier',
  'Noone',
  'Other',
  'Self',
] as const satisfies readonly (keyof IdentifierCstChildren)[];

export function identifierFrom(nodes: IdentifierSource | undefined):
  | {
      token: IToken;
      type: keyof IdentifierCstChildren;
      name: string;
    }
  | undefined {
  if (!nodes) return;
  let node: NamedTokenNode;
  if (Array.isArray(nodes)) {
    node = nodes[0];
  } else if ('children' in nodes && 'identifier' in nodes.children) {
    node = nodes.children.identifier[0];
  } else if ('identifier' in nodes) {
    node = nodes.identifier[0];
  } else {
    node = nodes as IdentifierCstNode;
  }
  if (!node) return;
  const children: IdentifierCstChildren =
    'children' in node ? node.children : node;

  const type = identifierCstNames.find((name) => children[name]);
  if (!type) {
    return;
  }
  const token = children[type]![0];
  if (!token || token.isInsertedInRecovery || !token.image) return;
  return { token, type, name: token.image };
}
