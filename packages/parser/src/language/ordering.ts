import {
  AnalysisCancelled,
  globalKey,
  globalOwner,
  nativeGlobalKey,
  type BoundUnit,
  type Expression,
  type Name,
  type Statement,
} from '../analysis/model.js';
import type { ContributionIndex } from './contributions.js';

/** A cold-start hint only. These possible provider edges never become semantic
 * dependencies: dynamic self/with and shared-storage effects still use the real
 * evaluator/worklist. Every input unit appears once in the returned permutation. */
export function orderColdSources(
  preferred: readonly string[],
  units: ReadonlyMap<string, { readonly bound?: BoundUnit }>,
  index: ContributionIndex,
  cancelled: () => boolean = () => false,
): string[] {
  const positions = new Map(preferred.map((uri, position) => [uri, position]));
  const edges = preferred.map(() => new Set<number>());
  const globals = new Map<string, { providers: number[]; bare: boolean }>();
  const check = () => {
    if (cancelled()) throw new AnalysisCancelled();
  };
  const providers = (name: string) => {
    let entry = globals.get(name);
    if (!entry) {
      const sources = index.symbols.get(globalKey(name));
      entry = { providers: [], bare: false };
      for (const [uri, symbol] of sources || []) {
        if (!symbol.item.def && !symbol.item.native) continue;
        entry.bare ||= symbol.bare !== false;
        const position = positions.get(uri);
        if (position !== undefined) entry.providers.push(position);
      }
      globals.set(name, entry);
    }
    return entry;
  };
  for (const [position, uri] of preferred.entries()) {
    check();
    const bound = units.get(uri)?.bound;
    if (!bound) continue;
    const add = (provider: number) => {
      if (provider !== position) edges[position].add(provider);
    };
    const read = (name: Name, explicitGlobal = false) => {
      const scope = bound.scopes.get(bound.nodeScopes.get(name.id) || '');
      if (!scope) return;
      if (!explicitGlobal) {
        if (['global', 'self', 'other'].includes(name.text)) return;
        let local = scope;
        for (;;) {
          if (local.declarations.has(name.text)) return;
          const parent = local.parent && bound.scopes.get(local.parent);
          if (!parent || parent.functionId !== scope.functionId) break;
          local = parent;
        }
        // Bare native names precede global storage, including native instance
        // fallback outside the global scope. Extension declarations in global
        // storage are source providers even when their Signifier is native.
        const native = index.symbols.get(nativeGlobalKey(name.text));
        for (const symbol of native?.values() || []) {
          if (
            (symbol.item.def || symbol.item.native) &&
            (!symbol.item.instance || scope.selfOwner !== globalOwner)
          )
            return;
        }
      }
      const candidate = providers(name.text);
      if (explicitGlobal || scope.selfOwner === globalOwner || candidate.bare) {
        // possible-self-shadow: symbolic caller-self and with scopes may resolve
        // another member at runtime. Keep the possible globals as ordering hints.
        for (const provider of candidate.providers) add(provider);
      }
    };
    const statements: Statement[] = [bound.syntax.root];
    const expressions: Expression[] = [];
    const seenStatements = new Set<Statement>();
    const seenExpressions = new Set<Expression>();
    for (const fn of bound.functions.values()) {
      statements.push(fn.node.body);
      for (const parameter of fn.node.parameters)
        if (parameter.value) expressions.push(parameter.value);
      if (fn.node.base) {
        read(fn.node.base.name);
        for (const argument of fn.node.base.arguments)
          if (argument.value) expressions.push(argument.value);
      }
    }
    for (const docs of bound.syntax.jsdocs)
      for (const range of docs.typeRanges)
        for (const provider of index.names.get(range.content)?.keys() || []) {
          const at = positions.get(provider);
          if (at !== undefined) add(at);
        }
    while (statements.length) {
      check();
      const node = statements.pop()!;
      if (seenStatements.has(node)) continue;
      seenStatements.add(node);
      switch (node.kind) {
        case 'block':
          for (const child of node.statements) statements.push(child);
          break;
        case 'declarations':
          for (const declaration of node.declarations)
            if (declaration.value) expressions.push(declaration.value);
          break;
        case 'expression':
          expressions.push(node.expression);
          break;
        case 'enum':
          for (const member of node.members)
            if (member.value) expressions.push(member.value);
          break;
        case 'if':
          expressions.push(node.condition);
          statements.push(node.yes);
          if (node.no) statements.push(node.no);
          break;
        case 'loop':
          if (node.initializer) statements.push(node.initializer);
          if (node.condition) expressions.push(node.condition);
          if (node.update) expressions.push(node.update);
          statements.push(node.body);
          break;
        case 'switch':
          expressions.push(node.expression);
          for (const entry of node.cases) {
            if (entry.test) expressions.push(entry.test);
            statements.push(entry.body);
          }
          break;
        case 'with':
          expressions.push(node.expression);
          statements.push(node.body);
          break;
        case 'try':
          statements.push(node.body);
          if (node.catchBody) statements.push(node.catchBody);
          if (node.finallyBody) statements.push(node.finallyBody);
          break;
        case 'return':
        case 'throw':
          if (node.value) expressions.push(node.value);
          break;
        // Function bodies/defaults/base arguments are already in bound.functions,
        // including legacy synthetic bodies that share the syntax root.
        case 'function':
        case 'doc':
        case 'break':
        case 'continue':
        case 'exit':
        case 'empty':
          break;
      }
    }
    while (expressions.length) {
      check();
      const node = expressions.pop()!;
      if (seenExpressions.has(node)) continue;
      seenExpressions.add(node);
      switch (node.kind) {
        case 'name':
          read(node.name);
          break;
        case 'member': {
          const scope = bound.scopes.get(bound.nodeScopes.get(node.id) || '');
          const explicitGlobal =
            node.target.kind === 'name' &&
            (node.target.name.text === 'global' ||
              (node.target.name.text === 'self' &&
                scope?.selfOwner === globalOwner &&
                scope.functionId === undefined &&
                !bound.context.dynamicSelf));
          if (explicitGlobal) read(node.name, true);
          else expressions.push(node.target);
          break;
        }
        case 'assign':
          expressions.push(node.value);
          if (node.operator !== '=') expressions.push(node.target);
          else if (node.target.kind === 'member')
            expressions.push(node.target.target);
          else if (node.target.kind === 'index') {
            expressions.push(node.target.target);
            for (const child of node.target.indices) expressions.push(child);
          }
          break;
        case 'struct':
          for (const entry of node.entries) {
            if (entry.shorthand) read(entry.name);
            else if (entry.value) expressions.push(entry.value);
          }
          break;
        case 'array':
        case 'template':
          for (const child of node.values) expressions.push(child);
          break;
        case 'binary':
          expressions.push(node.left, node.right);
          break;
        case 'conditional':
          expressions.push(node.condition, node.yes, node.no);
          break;
        case 'unary':
          expressions.push(node.operand);
          break;
        case 'index':
          expressions.push(node.target);
          for (const child of node.indices) expressions.push(child);
          break;
        case 'call':
          expressions.push(node.target);
          for (const argument of node.arguments)
            if (argument.value) expressions.push(argument.value);
          break;
        case 'unknown':
          for (const child of node.children) expressions.push(child);
          break;
        case 'function':
        case 'literal':
          break;
      }
    }
  }
  return providerOrder(preferred, edges, check);
}

/** Iterative SCC walks avoid making source count a JavaScript call-stack limit. */
function providerOrder(
  units: readonly string[],
  edges: readonly ReadonlySet<number>[],
  check: () => void,
): string[] {
  const reverse = units.map(() => [] as number[]);
  for (const [consumer, providers] of edges.entries())
    for (const provider of providers) reverse[provider].push(consumer);
  const visited = new Set<number>(),
    finished: number[] = [];
  for (let root = 0; root < units.length; root++) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack = [{ unit: root, next: edges[root].values() }];
    while (stack.length) {
      check();
      const head = stack[stack.length - 1];
      const next = head.next.next();
      if (next.done) {
        finished.push(head.unit);
        stack.pop();
      } else if (!visited.has(next.value)) {
        visited.add(next.value);
        stack.push({ unit: next.value, next: edges[next.value].values() });
      }
    }
  }
  const component = Array<number>(units.length).fill(-1);
  let componentCount = 0;
  for (const root of finished.reverse()) {
    if (component[root] !== -1) continue;
    component[root] = componentCount;
    const stack = [root];
    while (stack.length) {
      check();
      const head = stack.pop()!;
      for (const next of reverse[head])
        if (component[next] === -1) {
          component[next] = componentCount;
          stack.push(next);
        }
    }
    componentCount++;
  }
  const members = Array.from({ length: componentCount }, () => [] as number[]);
  for (let unit = 0; unit < units.length; unit++)
    members[component[unit]].push(unit);
  const needed = members.map(() => new Set<number>());
  const users = members.map(() => new Set<number>());
  for (const [consumer, providers] of edges.entries())
    for (const provider of providers) {
      const from = component[consumer],
        to = component[provider];
      if (from !== to) {
        needed[from].add(to);
        users[to].add(from);
      }
    }
  // A min-heap preserves the earliest original position among ready components.
  const ready: number[] = [];
  const earlier = (left: number, right: number) =>
    members[left][0] < members[right][0];
  const push = (value: number) => {
    let at = ready.length;
    ready.push(value);
    while (at) {
      const parent = (at - 1) >> 1;
      if (!earlier(value, ready[parent])) break;
      ready[at] = ready[parent];
      at = parent;
    }
    ready[at] = value;
  };
  const pop = () => {
    const first = ready[0],
      last = ready.pop()!;
    if (ready.length) {
      let at = 0;
      while (at * 2 + 1 < ready.length) {
        let child = at * 2 + 1;
        if (child + 1 < ready.length && earlier(ready[child + 1], ready[child]))
          child++;
        if (!earlier(ready[child], last)) break;
        ready[at] = ready[child];
        at = child;
      }
      ready[at] = last;
    }
    return first;
  };
  for (let id = 0; id < members.length; id++) if (!needed[id].size) push(id);
  const result: string[] = [];
  while (ready.length) {
    check();
    const provider = pop();
    for (const unit of members[provider]) result.push(units[unit]);
    for (const consumer of users[provider]) {
      needed[consumer].delete(provider);
      if (!needed[consumer].size) push(consumer);
    }
  }
  return result;
}
