import type { CstNode, CstNodeLocation, IToken } from 'chevrotain';
import { gmlLinesByGroup, parseJsdoc, type JsdocSummary } from '../jsdoc.js';
import type {
  Argument,
  EnumMember,
  Expression,
  FunctionExpression,
  Name,
  Parameter,
  SemanticDiagnostic,
  Statement,
  StructEntry,
  SyntaxInput,
  SyntaxNode,
  SyntaxUnit,
  VariableDeclaration,
} from './model.js';

type Children = Record<string, (CstNode | IToken)[] | undefined>;
function child(node: CstNode, key: string): CstNode | undefined {
  return node.children[key]?.[0] as CstNode | undefined;
}
function children(node: CstNode, key: string): CstNode[] {
  return (node.children[key] || []) as CstNode[];
}
function token(node: CstNode, key: string): IToken | undefined {
  return node.children[key]?.[0] as IToken | undefined;
}
function isNode(entry: CstNode | IToken): entry is CstNode {
  return 'children' in entry;
}
function start(entry: CstNode | IToken): number {
  return isNode(entry)
    ? (entry.location?.startOffset ?? NaN)
    : entry.startOffset;
}
function ordered(node: CstNode): (CstNode | IToken)[] {
  return Object.values(node.children)
    .flat()
    .filter((entry): entry is CstNode | IToken => !!entry)
    .sort((a, b) => start(a) - start(b));
}

/** CST normalization is the only semantic layer that knows parser rule names. */
export function normalizeSyntax(input: SyntaxInput): SyntaxUnit {
  let nextId = 0;
  const jsdocs: JsdocSummary[] = [];
  const diagnostics: SemanticDiagnostic[] = [];
  function base(
    source: CstNode | IToken | CstNodeLocation,
    role = '',
  ): SyntaxNode {
    const location = 'children' in source ? source.location : source;
    const rawStart = location?.startOffset;
    const rawEnd = location?.endOffset;
    const first = Number.isFinite(rawStart)
      ? Math.max(0, Math.min(rawStart!, input.text.length))
      : 0;
    const last = Number.isFinite(rawEnd)
      ? Math.max(first, Math.min(rawEnd!, Math.max(0, input.text.length - 1)))
      : first;
    return {
      id: `${input.unitId}:${role}:${nextId++}`,
      start: first,
      end: last,
      origin: input.origin(first, last),
    };
  }
  function name(source: CstNode | IToken | undefined, fallback: CstNode): Name {
    if (!source) return { ...base(fallback, 'missing-name'), text: '' };
    if (!isNode(source))
      return { ...base(source, 'name'), text: source.image || '' };
    const selected =
      ordered(source).find((entry) => !isNode(entry)) ||
      ordered(source).find(isNode);
    return selected
      ? name(selected, fallback)
      : { ...base(source, 'missing-name'), text: '' };
  }
  function docs(node: CstNode): JsdocSummary[] {
    const gml =
      child(node, 'jsdocGml') || (node.name === 'jsdocGml' ? node : undefined);
    const js =
      child(node, 'jsdocJs') || (node.name === 'jsdocJs' ? node : undefined);
    const parsed = gml
      ? gmlLinesByGroup((gml.children.JsdocGmlLine || []) as IToken[]).map(
          (lines) => parseJsdoc(lines),
        )
      : js && token(js, 'JsdocJs')
        ? [parseJsdoc(token(js, 'JsdocJs')!)]
        : [];
    jsdocs.push(...parsed);
    return parsed;
  }
  function block(node: CstNode, nodes: readonly CstNode[]): Statement {
    const statements: Statement[] = [];
    let pending: JsdocSummary | undefined;
    for (const source of nodes) {
      const result = statement(source, pending);
      const list =
        result.kind === 'block' && source.name === 'statements'
          ? result.statements
          : [result];
      for (const entry of list) {
        statements.push(entry);
        pending = entry.kind === 'doc' ? entry.docs : undefined;
      }
    }
    return { ...base(node, 'block'), kind: 'block', statements };
  }
  function empty(node: CstNode): Statement {
    return { ...base(node, 'empty'), kind: 'empty' };
  }
  function statement(node: CstNode, annotation?: JsdocSummary): Statement {
    const b = () => base(node, node.name);
    switch (node.name) {
      case 'file':
        return block(node, ordered(node).filter(isNode));
      case 'extensionFunction': {
        const body = child(node, 'statements');
        return {
          ...b(),
          kind: 'function',
          expression: {
            ...b(),
            kind: 'function',
            extension: true,
            name: name(token(node, 'Identifier'), node),
            parameters: [],
            constructor: false,
            body: body ? statement(body) : empty(node),
            docs: annotation,
          },
        };
      }
      case 'statements':
        return block(node, children(node, 'statement'));
      case 'blockStatement':
        return block(
          node,
          children(node, 'statement').length
            ? children(node, 'statement')
            : children(node, 'statements'),
        );
      case 'statement':
      case 'blockableStatement':
      case 'blockableStatements': {
        const nested = ordered(node).find(isNode);
        return nested ? statement(nested, annotation) : empty(node);
      }
      case 'jsdoc':
      case 'jsdocGml':
      case 'jsdocJs': {
        const summaries = docs(node);
        if (!summaries.length) return empty(node);
        const entries: Statement[] = summaries.map((summary) => ({
          ...b(),
          kind: 'doc',
          docs: summary,
        }));
        return entries.length === 1
          ? entries[0]
          : { ...b(), kind: 'block', statements: entries };
      }
      case 'localVarDeclarationsStatement':
      case 'globalVarDeclarationsStatement':
      case 'staticVarDeclarationStatement':
      case 'variableAssignmentStatement': {
        const nested = ordered(node).find(isNode);
        return nested ? statement(nested, annotation) : empty(node);
      }
      case 'localVarDeclarations':
      case 'globalVarDeclarations':
      case 'staticVarDeclarations': {
        const storage =
          node.name === 'localVarDeclarations'
            ? 'local'
            : node.name === 'globalVarDeclarations'
              ? 'global'
              : 'static';
        const declarations =
          storage === 'static'
            ? [node]
            : children(
                node,
                storage === 'local'
                  ? 'localVarDeclaration'
                  : 'globalVarDeclaration',
              );
        return {
          ...b(),
          kind: 'declarations',
          storage,
          declarations: declarations.map(
            (entry): VariableDeclaration => ({
              ...base(entry, 'declaration'),
              name: name(token(entry, 'Identifier'), entry),
              value: child(entry, 'assignmentRightHandSide')
                ? expression(child(entry, 'assignmentRightHandSide')!)
                : undefined,
              docs: annotation,
            }),
          ),
        };
      }
      case 'variableAssignment': {
        const identifier = name(token(node, 'Identifier'), node);
        const target: Expression = {
          ...identifier,
          kind: 'name',
          name: identifier,
        };
        return {
          ...b(),
          kind: 'expression',
          docs: annotation,
          expression: {
            ...b(),
            kind: 'assign',
            operator: token(node, 'AssignmentOperator')?.image || '=',
            target,
            value: expression(child(node, 'assignmentRightHandSide')),
          },
        };
      }
      case 'expressionStatement':
        return {
          ...b(),
          kind: 'expression',
          expression: expression(child(node, 'expression'), true),
          docs: annotation,
        };
      case 'functionStatement': {
        const fn = child(node, 'functionExpression');
        return fn
          ? {
              ...b(),
              kind: 'function',
              expression: functionExpression(fn, annotation),
            }
          : empty(node);
      }
      case 'returnStatement':
      case 'throwStatement': {
        const rhs =
          child(node, 'assignmentRightHandSide') || child(node, 'expression');
        return {
          ...b(),
          kind: node.name === 'throwStatement' ? 'throw' : 'return',
          value: rhs ? expression(rhs) : undefined,
        };
      }
      case 'breakStatement':
      case 'continueStatement':
      case 'exitStatement':
        return {
          ...b(),
          kind:
            node.name === 'breakStatement'
              ? 'break'
              : node.name === 'continueStatement'
                ? 'continue'
                : 'exit',
        };
      case 'ifStatement': {
        let otherwise = child(node, 'elseStatement')
          ? statement(child(node, 'elseStatement')!, annotation)
          : undefined;
        for (const elseIf of children(node, 'elseIfStatement').reverse()) {
          otherwise = {
            ...base(elseIf, 'if'),
            kind: 'if',
            condition: expression(child(elseIf, 'expression')),
            yes: statement(child(elseIf, 'blockableStatement')!),
            no: otherwise,
          };
        }
        return {
          ...b(),
          kind: 'if',
          condition: expression(child(node, 'expression')),
          yes: statement(child(node, 'blockableStatement')!),
          no: otherwise,
        };
      }
      case 'elseStatement':
        return child(node, 'blockableStatement')
          ? statement(child(node, 'blockableStatement')!)
          : empty(node);
      case 'whileStatement':
      case 'doUntilStatement':
      case 'repeatStatement':
        return {
          ...b(),
          kind: 'loop',
          loop:
            node.name === 'whileStatement'
              ? 'while'
              : node.name === 'repeatStatement'
                ? 'repeat'
                : 'do-until',
          condition: expression(child(node, 'expression')),
          body: statement(child(node, 'blockableStatement')!),
        };
      case 'forStatement': {
        const separators = (node.children.Semicolon || []) as IToken[];
        const expressions = children(node, 'expression');
        const initial = expressions.find(
          (entry) => start(entry) < separators[0]?.startOffset,
        );
        const condition = expressions.find(
          (entry) =>
            start(entry) > separators[0]?.startOffset &&
            start(entry) < separators[1]?.startOffset,
        );
        const update = expressions.find(
          (entry) => start(entry) > separators[1]?.startOffset,
        );
        const declarations = child(node, 'localVarDeclarations');
        return {
          ...b(),
          kind: 'loop',
          loop: 'for',
          initializer: declarations
            ? statement(declarations)
            : initial
              ? {
                  ...base(initial),
                  kind: 'expression',
                  expression: expression(initial, true),
                }
              : undefined,
          condition: condition ? expression(condition) : undefined,
          update: update ? expression(update, true) : undefined,
          body: statement(child(node, 'blockableStatement')!),
        };
      }
      case 'switchStatement': {
        const cases = ordered(node).filter(
          (entry): entry is CstNode =>
            isNode(entry) &&
            ['caseStatement', 'defaultStatement'].includes(entry.name),
        );
        return {
          ...b(),
          kind: 'switch',
          expression: expression(child(node, 'expression')),
          cases: cases.map((entry) => ({
            test: child(entry, 'expression')
              ? expression(child(entry, 'expression')!)
              : undefined,
            body: child(entry, 'blockableStatements')
              ? statement(child(entry, 'blockableStatements')!)
              : empty(entry),
          })),
        };
      }
      case 'withStatement':
        return {
          ...b(),
          kind: 'with',
          expression: expression(child(node, 'expression')),
          body: statement(child(node, 'blockableStatement')!),
          docs: annotation,
        };
      case 'tryStatement': {
        const blocks = children(node, 'blockStatement');
        const caught = child(node, 'catchStatement');
        return {
          ...b(),
          kind: 'try',
          body: blocks[0] ? statement(blocks[0]) : empty(node),
          catchName: caught
            ? name(token(caught, 'Identifier'), caught)
            : undefined,
          catchBody:
            caught && child(caught, 'blockStatement')
              ? statement(child(caught, 'blockStatement')!)
              : undefined,
          finallyBody:
            token(node, 'Finally') && blocks[1]
              ? statement(blocks[1])
              : undefined,
        };
      }
      case 'enumStatement':
        return {
          ...b(),
          kind: 'enum',
          name: name(token(node, 'Identifier'), node),
          docs: annotation,
          members: children(node, 'enumMember').map((entry): EnumMember => {
            const rhs =
              child(entry, 'expression') ||
              child(entry, 'assignmentRightHandSide');
            let memberValue = rhs
              ? expression(rhs)
              : token(entry, 'NumericLiteral')
                ? literal(token(entry, 'NumericLiteral')!, 'Real')
                : undefined;
            if (memberValue && token(entry, 'Minus'))
              memberValue = {
                ...base(entry, 'unary'),
                kind: 'unary',
                operator: '-',
                operand: memberValue,
                postfix: false,
              };
            return {
              ...base(entry, 'enum-member'),
              name: name(token(entry, 'Identifier'), entry),
              value: memberValue,
            };
          }),
        };
      case 'emptyStatement':
        return empty(node);
      case 'macroStatement':
        diagnostics.push({
          collection: 'INVALID_OPERATION',
          severity: 'warning',
          origin: b().origin,
          message:
            'Macro directives require preprocessing before semantic analysis.',
        });
        return empty(node);
      default: {
        const nested = ordered(node).filter(isNode);
        if (nested.length) return block(node, nested);
        return empty(node);
      }
    }
  }
  function literal(
    source: IToken,
    type: 'Real' | 'Bool' | 'Pointer' | 'Undefined',
  ): Expression {
    let constant: number | boolean | undefined;
    if (type === 'Real') {
      constant =
        source.image === 'pi'
          ? Math.PI
          : source.image === 'infinity'
            ? Infinity
            : Number(source.image.replace(/^\$/, '0x'));
      if (Number.isNaN(constant)) constant = undefined;
    } else if (type === 'Bool') constant = source.image === 'true';
    return {
      ...base(source, 'literal'),
      kind: 'literal',
      type,
      value: constant,
      nullPointer:
        type === 'Pointer' ? source.image === 'pointer_null' : undefined,
    };
  }
  function stringValue(node: CstNode): string {
    const raw = (node.children.Substring || [])
      .map((entry) => (entry as IToken).image)
      .join('');
    if (node.name !== 'stringLiteral') return raw;
    return raw.replace(
      /\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/g,
      (_match, escaped: string) => {
        if (/^[ux][\da-fA-F]+$/.test(escaped))
          return String.fromCharCode(parseInt(escaped.slice(1), 16));
        return (
          (
            { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<
              string,
              string
            >
          )[escaped] ?? escaped
        );
      },
    );
  }
  function args(node: CstNode): Argument[] {
    const parts = ordered(node);
    const result: Argument[] = [];
    let delimiter = token(node, 'StartParen');
    let current: Expression | undefined;
    let annotation: JsdocSummary | undefined;
    for (const part of parts) {
      if (isNode(part) && part.name === 'functionArgument') {
        current = expression(
          child(part, 'assignmentRightHandSide') || child(part, 'expression'),
        );
        const comment = child(part, 'jsdoc');
        annotation = comment ? docs(comment)[0] : undefined;
      } else if (!isNode(part) && [',', ')'].includes(part.image)) {
        const first =
          delimiter && Number.isFinite(delimiter.endOffset)
            ? delimiter.endOffset! + 1
            : part.startOffset;
        const last = Math.max(first, part.startOffset - 1);
        const metadata = base(
          { startOffset: first, endOffset: last },
          'argument',
        );
        result.push({ ...metadata, value: current, docs: annotation });
        delimiter = part;
        current = undefined;
        annotation = undefined;
      }
    }
    return result;
  }
  function functionExpression(
    node: CstNode,
    annotation?: JsdocSummary,
  ): FunctionExpression {
    const parameters = child(node, 'functionParameters');
    const suffix = child(node, 'constructorSuffix');
    const parent = suffix && token(suffix, 'Identifier');
    return {
      ...base(node, 'function'),
      kind: 'function',
      name: token(node, 'Identifier')
        ? name(token(node, 'Identifier'), node)
        : undefined,
      constructor: !!suffix,
      parameters: parameters
        ? children(parameters, 'functionParameter').map(
            (entry): Parameter => ({
              ...base(entry, 'parameter'),
              name: name(token(entry, 'Identifier'), entry),
              value: child(entry, 'assignmentRightHandSide')
                ? expression(child(entry, 'assignmentRightHandSide')!)
                : undefined,
            }),
          )
        : [],
      body: child(node, 'blockStatement')
        ? statement(child(node, 'blockStatement')!)
        : empty(node),
      base: parent
        ? {
            name: name(parent, suffix!),
            arguments: child(suffix!, 'functionArguments')
              ? args(child(suffix!, 'functionArguments')!)
              : [],
          }
        : undefined,
      docs: annotation,
    };
  }
  function suffixes(
    target: Expression,
    nodes: readonly CstNode[],
    usesNew = false,
  ): Expression {
    for (const wrapper of nodes) {
      const suffix =
        wrapper.name === 'accessorSuffixes' || wrapper.name === 'postfixSuffix'
          ? ordered(wrapper).find(isNode)
          : wrapper;
      if (!suffix) continue;
      const metadata = {
        ...base(suffix, 'postfix'),
        start: target.start,
        origin: input.origin(
          target.start,
          suffix.location?.endOffset ?? target.end,
        ),
      };
      if (suffix.name === 'functionArguments') {
        target = {
          ...metadata,
          kind: 'call',
          target,
          arguments: args(suffix),
          usesNew,
        };
        usesNew = false;
      } else if (suffix.name === 'dotAccessSuffix') {
        const property =
          child(suffix, 'propertyName') ||
          child(suffix, 'propertyIdentifier') ||
          child(suffix, 'identifier');
        const dot = base(token(suffix, 'Dot') || suffix, 'dot');
        let member = name(property || token(suffix, 'Identifier'), suffix);
        if (!member.text) {
          // Recovery leaves propertyName with NaN coordinates. It has no source
          // spelling; locate its insertion point after the real dot, not at 0.
          const { spelling, expansion } = dot.origin;
          member = {
            ...member,
            start: dot.end + 1,
            end: dot.end + 1,
            origin: {
              ...dot.origin,
              spelling: {
                ...spelling,
                start: spelling.end + 1,
                end: spelling.end + 1,
              },
              expansion: expansion && {
                ...expansion,
                start: expansion.end + 1,
                end: expansion.end + 1,
              },
              editable: false,
            },
          };
        }
        target = { ...metadata, kind: 'member', target, name: member, dot };
      } else {
        const accessor =
          suffix.name === 'structAccessSuffix'
            ? 'struct'
            : suffix.name === 'mapAccessSuffix'
              ? 'map'
              : suffix.name === 'listAccessSuffix'
                ? 'list'
                : suffix.name === 'gridAccessSuffix'
                  ? 'grid'
                  : suffix.name === 'arrayMutationAccessorSuffix'
                    ? 'array-mutation'
                    : 'array';
        target = {
          ...metadata,
          kind: 'index',
          target,
          accessor,
          indices: children(suffix, 'expression').map((entry) =>
            expression(entry),
          ),
        };
      }
    }
    return target;
  }
  function expression(
    node: CstNode | undefined,
    assignmentAllowed = false,
  ): Expression {
    if (!node)
      return {
        ...base({ startOffset: 0, endOffset: 0 }, 'missing-expression'),
        kind: 'unknown',
        children: [],
      };
    const metadata = () => base(node, node.name);
    switch (node.name) {
      case 'assignmentRightHandSide': {
        const nested = ordered(node).find(isNode);
        return nested
          ? expression(nested, assignmentAllowed)
          : { ...metadata(), kind: 'unknown', children: [] };
      }
      case 'functionExpression':
        return functionExpression(node);
      case 'structLiteral':
        return {
          ...metadata(),
          kind: 'struct',
          entries: children(node, 'structLiteralEntry').map(
            (entry): StructEntry => {
              const keyString = child(entry, 'stringLiteral');
              const key: Name = keyString
                ? {
                    ...base(keyString, 'string-key'),
                    text: stringValue(keyString),
                  }
                : name(
                    child(entry, 'propertyName') || token(entry, 'Identifier'),
                    entry,
                  );
              const rhs = child(entry, 'assignmentRightHandSide');
              const comment = child(entry, 'jsdoc');
              return {
                ...base(entry, 'struct-entry'),
                name: key,
                value: rhs ? expression(rhs) : undefined,
                shorthand: !rhs,
                docs: comment ? docs(comment)[0] : undefined,
              };
            },
          ),
        };
      case 'arrayLiteral':
        return {
          ...metadata(),
          kind: 'array',
          values: children(node, 'assignmentRightHandSide').map((entry) =>
            expression(entry),
          ),
        };
      case 'stringLiteral':
      case 'multilineDoubleStringLiteral':
      case 'multilineSingleStringLiteral':
        return {
          ...metadata(),
          kind: 'literal',
          type: 'String',
          value: stringValue(node),
        };
      case 'templateLiteral':
        return {
          ...metadata(),
          kind: 'template',
          values: children(node, 'expression').map((entry) =>
            expression(entry),
          ),
        };
      case 'parenthesizedExpression': {
        const inner = expression(child(node, 'expression'), assignmentAllowed);
        return suffixes(
          { ...inner, ...metadata(), grouped: true },
          children(node, 'accessorSuffixes'),
        );
      }
      case 'identifier':
      case 'propertyIdentifier':
      case 'propertyName': {
        const identifier = name(node, node);
        return { ...metadata(), kind: 'name', name: identifier };
      }
      case 'identifierAccessor': {
        let result = expression(
          child(node, 'identifier') || child(node, 'parenthesizedExpression'),
        );
        result = suffixes(
          result,
          children(node, 'accessorSuffixes'),
          !!token(node, 'New'),
        );
        const assignment = child(node, 'assignment');
        if (assignment)
          result = applyAssignment(result, assignment, assignmentAllowed);
        return result;
      }
      case 'primaryExpression': {
        const nested = ordered(node).find(isNode);
        let result: Expression;
        if (nested) result = expression(nested, assignmentAllowed);
        else if (token(node, 'NumericLiteral'))
          result = literal(token(node, 'NumericLiteral')!, 'Real');
        else if (token(node, 'BooleanLiteral'))
          result = literal(token(node, 'BooleanLiteral')!, 'Bool');
        else if (token(node, 'PointerLiteral'))
          result = literal(token(node, 'PointerLiteral')!, 'Pointer');
        else if (token(node, 'Undefined'))
          result = literal(token(node, 'Undefined')!, 'Undefined');
        else if (token(node, 'NaN'))
          result = literal(token(node, 'NaN')!, 'Real');
        else result = { ...metadata(), kind: 'unknown', children: [] };
        result = suffixes(result, children(node, 'accessorSuffixes'));
        for (const operator of [
          ...(node.children.UnaryPrefixOperator || []),
        ].reverse() as IToken[])
          result = {
            ...metadata(),
            kind: 'unary',
            operator: operator.image,
            operand: result,
            postfix: false,
          };
        for (const operator of (node.children.UnarySuffixOperator ||
          []) as IToken[])
          result = {
            ...metadata(),
            kind: 'unary',
            operator: operator.image,
            operand: result,
            postfix: true,
          };
        return result;
      }
      case 'expression': {
        let result = expression(
          child(node, 'primaryExpression'),
          assignmentAllowed,
        );
        for (const binary of children(node, 'binaryExpression')) {
          const right = expression(child(binary, 'assignmentRightHandSide'));
          result = binaryExpression(
            token(binary, 'BinaryOperator')?.image || '',
            result,
            right,
          );
        }
        const ternary = child(node, 'ternaryExpression');
        if (ternary) {
          const alternatives = children(ternary, 'assignmentRightHandSide');
          result = {
            ...metadata(),
            kind: 'conditional',
            condition: result,
            yes: expression(alternatives[0]),
            no: expression(alternatives[1]),
          };
        }
        const assignment = child(node, 'assignment');
        return assignment
          ? applyAssignment(result, assignment, assignmentAllowed)
          : result;
      }
      default: {
        // New precedence/postfix wrappers are normalized by source order. Their
        // grouping is already decided by the parser, never by a JS precedence table.
        const parts = ordered(node);
        const nested = parts.filter(isNode);
        if (nested.length === 1)
          return expression(nested[0], assignmentAllowed);
        let result = nested[0]
          ? expression(nested[0], assignmentAllowed)
          : { ...metadata(), kind: 'unknown' as const, children: [] };
        let operator: string | undefined;
        for (const part of parts.slice(parts.indexOf(nested[0]) + 1)) {
          if (!isNode(part)) operator = part.image;
          else if (operator) {
            result = {
              ...metadata(),
              kind: 'binary',
              operator,
              left: result,
              right: expression(part),
            };
            operator = undefined;
          }
        }
        return result;
      }
    }
  }
  function binaryExpression(
    operator: string,
    left: Expression,
    right: Expression,
  ): Expression {
    const metadata = () =>
      base({ startOffset: left.start, endOffset: right.end }, 'binary');
    // The legacy CST recursively accepts a complete expression on a binary RHS.
    // A following conditional applies to the complete condition, unless the RHS
    // conditional is explicitly parenthesized. Keep target-dependent binary
    // grouping conservative instead of substituting JavaScript precedence.
    if (right.kind === 'conditional' && !right.grouped) {
      return {
        ...metadata(),
        kind: 'conditional',
        condition: binaryExpression(operator, left, right.condition),
        yes: right.yes,
        no: right.no,
      };
    }
    return {
      ...metadata(),
      kind: 'binary',
      operator,
      left,
      right,
      uncertainGrouping:
        (left.kind === 'binary' && !left.grouped) ||
        (right.kind === 'binary' && !right.grouped),
    };
  }
  function applyAssignment(
    target: Expression,
    node: CstNode,
    allowed: boolean,
  ): Expression {
    const operator =
      token(node, 'AssignmentOperator')?.image ||
      token(node, 'Assign')?.image ||
      '=';
    const rhs = expression(child(node, 'assignmentRightHandSide'));
    return allowed || operator !== '='
      ? {
          ...base(node, 'assignment'),
          start: target.start,
          origin: input.origin(
            target.start,
            node.location?.endOffset ?? target.end,
          ),
          kind: 'assign',
          operator,
          target,
          value: rhs,
        }
      : binaryExpression('=', target, rhs);
  }
  return { input, root: statement(input.cst), jsdocs, diagnostics };
}
