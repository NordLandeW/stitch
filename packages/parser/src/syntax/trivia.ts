import type { CstNode, IToken } from 'chevrotain';
import { t } from '../tokens.js';

interface DocGroup {
  tokens: IToken[];
  used?: boolean;
}

interface JsdocTrivia {
  tokens: IToken[];
  before: Map<number | undefined, DocGroup>;
  after: Map<number | undefined, DocGroup>;
}

const isJsdoc = (token: IToken) =>
  token.tokenType === t.JsdocGmlLine || token.tokenType === t.JsdocJs;

/** Keep the lexer's public token vector intact, including macro comment input. */
export function separateJsdoc(tokens: IToken[]): JsdocTrivia | undefined {
  const first = tokens.findIndex(isJsdoc);
  if (first < 0) return;
  const trivia: JsdocTrivia = {
    tokens: tokens.slice(0, first),
    before: new Map(),
    after: new Map(),
  };
  let pending: DocGroup | undefined;
  const finish = (next: IToken | undefined) => {
    if (!pending) return;
    trivia.before.set(next?.startOffset, pending);
    trivia.after.set(trivia.tokens.at(-1)?.endOffset, pending);
    pending = undefined;
  };
  for (let index = first; index < tokens.length; index++) {
    const token = tokens[index];
    if (isJsdoc(token)) (pending ||= { tokens: [] }).tokens.push(token);
    else {
      finish(token);
      trivia.tokens.push(token);
    }
  }
  finish(undefined);
  return trivia;
}

function includeLocation(node: CstNode, source: CstNode['location'] | IToken) {
  const target = node.location;
  if (!source || !target) return;
  if (
    Number.isFinite(source.startOffset) &&
    (!Number.isFinite(target.startOffset) ||
      source.startOffset < target.startOffset)
  ) {
    target.startOffset = source.startOffset;
    target.startLine = source.startLine;
    target.startColumn = source.startColumn;
  }
  if (
    Number.isFinite(source.endOffset) &&
    (!Number.isFinite(target.endOffset) ||
      source.endOffset! > target.endOffset!)
  ) {
    target.endOffset = source.endOffset;
    target.endLine = source.endLine;
    target.endColumn = source.endColumn;
  }
}

function node(name: string, children: CstNode['children']): CstNode {
  const result: CstNode = {
    name,
    children,
    location: { startOffset: NaN, endOffset: NaN },
  };
  for (const entries of Object.values(children))
    for (const entry of entries)
      includeLocation(result, 'children' in entry ? entry.location : entry);
  return result;
}

/** Preserve the old line-comment grouping and block-comment ordering. */
function take(group: DocGroup | undefined): CstNode[] {
  if (!group || group.used) return [];
  group.used = true;
  const docs: CstNode[] = [];
  for (let index = 0; index < group.tokens.length; ) {
    const first = group.tokens[index];
    if (first.tokenType === t.JsdocGmlLine) {
      const lines = [first];
      while (group.tokens[++index]?.tokenType === t.JsdocGmlLine)
        lines.push(group.tokens[index]);
      docs.push(
        node('jsdoc', {
          jsdocGml: [node('jsdocGml', { JsdocGmlLine: lines })],
        }),
      );
    } else {
      index++;
      docs.push(
        node('jsdoc', { jsdocJs: [node('jsdocJs', { JsdocJs: [first] })] }),
      );
    }
  }
  return docs;
}

/**
 * Reattach docs at actual statement/argument/member boundaries. Inline groups
 * have no matching boundary and remain trivia. Existing CST locations provide
 * the indexes; one postorder walk propagates only changed ranges and recovery
 * at a node's end. All indexes and cursors belong to the current parse.
 */
export function attachJsdoc(
  root: CstNode,
  trivia: JsdocTrivia,
  rootRecovery: readonly IToken[] = [],
): void {
  // The parser explicitly resumed at these file-level boundaries. Preserve
  // their standalone docs even when the final root chunk has no code tokens.
  const recovered: CstNode[] = [];
  const recover = (group: DocGroup | undefined) => {
    for (const doc of take(group))
      recovered.push(node('statement', { jsdoc: [doc] }));
  };
  for (const token of rootRecovery)
    recover(trivia.before.get(token.startOffset));
  const lastSkipped = rootRecovery.at(-1);
  if (lastSkipped && lastSkipped === trivia.tokens.at(-1))
    recover(trivia.after.get(lastSkipped.endOffset));
  const nodes = [root];
  const parents = [-1];
  let unfinished: Set<CstNode> | undefined;
  for (let index = 0; index < nodes.length; index++) {
    const current = nodes[index];
    if (current.recoveredNode) (unfinished ||= new Set()).add(current);
    for (const key in current.children) {
      for (const child of current.children[key]) {
        if ('children' in child) {
          nodes.push(child);
          parents.push(index);
        } else if (child.isInsertedInRecovery) {
          (unfinished ||= new Set()).add(current);
        }
      }
    }
  }
  const rootStatements = root.children.statements?.[0];
  const leading = (target: CstNode) =>
    Number.isFinite(target.location?.startOffset)
      ? take(trivia.before.get(target.location!.startOffset))
      : [];
  const append = (target: CstNode, group: DocGroup | undefined) => {
    for (const doc of take(group)) {
      (target.children.statement ||= []).push(
        node('statement', { jsdoc: [doc] }),
      );
      includeLocation(target, doc.location);
    }
  };
  for (let index = nodes.length - 1; index >= 0; index--) {
    const current = nodes[index];
    const parent = nodes[parents[index]];
    const sharesEnd =
      parent &&
      Number.isFinite(current.location?.endOffset) &&
      current.location!.endOffset === parent.location?.endOffset;
    const statements = current.children.statement as CstNode[] | undefined;
    if (statements) {
      let joined: CstNode[] | undefined;
      for (let i = 0; i < statements.length; i++) {
        const docs = leading(statements[i]);
        if (docs.length) {
          joined ||= statements.slice(0, i);
          for (const doc of docs) {
            joined.push(node('statement', { jsdoc: [doc] }));
            includeLocation(current, doc.location);
          }
        }
        joined?.push(statements[i]);
      }
      if (joined) current.children.statement = joined;
    }
    if (
      current.name === 'functionArgument' ||
      current.name === 'structLiteralEntry'
    ) {
      const docs = leading(current);
      if (docs.length) {
        current.children.jsdoc = docs;
        for (const doc of docs) includeLocation(current, doc.location);
      }
    }
    if (current.name === 'statements' || current.name === 'blockStatement') {
      const last = statements?.at(-1);
      // A comment inside an unfinished expression must not become a new
      // declaration. A complete statement inside an unclosed block still can.
      if (
        last &&
        !unfinished?.has(last) &&
        Number.isFinite(last.location?.endOffset)
      )
        append(current, trivia.after.get(last.location!.endOffset));
      else if (!last) {
        const opening = current.children.StartBrace?.[0] as IToken | undefined;
        if (opening && !opening.isInsertedInRecovery)
          append(current, trivia.after.get(opening.endOffset));
        else if (current === rootStatements)
          append(current, trivia.after.get(undefined));
      }
    }
    if (
      current.name === 'caseStatement' ||
      current.name === 'defaultStatement'
    ) {
      const body = current.children.blockableStatements?.[0] as
        | CstNode
        | undefined;
      const empty = body?.children.statements?.[0] as CstNode | undefined;
      const colon = current.children.Colon?.[0] as IToken | undefined;
      if (
        empty &&
        !empty.children.statement?.length &&
        colon &&
        !colon.isInsertedInRecovery
      ) {
        append(empty, trivia.after.get(colon.endOffset));
        includeLocation(body!, empty.location);
        includeLocation(current, body!.location);
      }
    }
    if (current === rootStatements && recovered.length) {
      // Both streams follow source order; merging avoids a sort or repeated
      // insertion/copying when a file has many damaged root boundaries.
      const merged: CstNode[] = [];
      let next = 0;
      for (const statement of (current.children.statement || []) as CstNode[]) {
        const at = statement.location?.startOffset;
        while (
          next < recovered.length &&
          (!Number.isFinite(at) || recovered[next].location!.startOffset < at!)
        )
          merged.push(recovered[next++]);
        merged.push(statement);
      }
      while (next < recovered.length) merged.push(recovered[next++]);
      current.children.statement = merged;
      for (const statement of recovered)
        includeLocation(current, statement.location);
    }
    if (parent) {
      if (sharesEnd && unfinished?.has(current)) unfinished.add(parent);
      includeLocation(parent, current.location);
    }
  }
}
