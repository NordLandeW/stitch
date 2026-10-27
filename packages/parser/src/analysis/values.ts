import { createHash } from 'node:crypto';
import type { Signifier } from '../signifiers.js';
import { Type, TypeStore } from '../types.js';
import type { PrimitiveName } from '../types.primitives.js';

export type Value = TypeStore;
type ValueInput = Type | TypeStore | undefined;

/** Enum values name declarations, not allocation sites. Detached copies retain
 * their signifier even when their graph-local type key is intentionally absent. */
function enumDeclarationKey(type: Type): string | undefined {
  if (type.kind !== 'Enum' && type.kind !== 'EnumMember') return;
  const key = type.signifier?.semanticKey || type.semanticKey;
  return key && JSON.stringify([type.kind, key]);
}

function* valueTypes(inputs: Iterable<ValueInput>): Iterable<Type> {
  for (const input of inputs) {
    if (input?.$tag === 'TypeStore') yield* input.type;
    else if (input) yield input;
  }
}

export function value(...types: ValueInput[]): Value {
  return valueFrom(types);
}

/** Normalize arbitrary-width inputs without using the JS argument stack. */
export function valueFrom(types: Iterable<ValueInput>): Value {
  const result = new TypeStore();
  const seen = new Map<string | Type | Signifier, number>();
  const normalized: Type[] = [];
  for (const type of valueTypes(types)) {
    // Distinct allocation sites and enum declarations must retain identity.
    const structured = [
      'Struct',
      'Function',
      'Array',
      'Enum',
      'EnumMember',
    ].includes(type.kind);
    const nominal = type.kind === 'Enum' || type.kind === 'EnumMember';
    const identity =
      enumDeclarationKey(type) ||
      type.semanticKey ||
      (nominal
        ? type.signifier || type
        : structured
          ? type
          : `${type.kind}:${type.name || ''}:${String(type.nullPointer)}`);
    const priorIndex = seen.get(identity);
    if (priorIndex !== undefined) {
      const prior = normalized[priorIndex];
      if (
        !structured &&
        !type.semanticKey &&
        prior.literalValue !== type.literalValue
      ) {
        const widened = new Type(type.kind);
        widened.name = type.name;
        widened.isGeneric = type.isGeneric;
        widened.nullPointer = type.nullPointer;
        normalized[priorIndex] = widened;
      }
      continue;
    }
    seen.set(identity, normalized.length);
    normalized.push(type);
  }
  result.type = normalized;
  return result;
}
export function primitive(kind: PrimitiveName): Value {
  return value(new Type(kind));
}
export function join(...values: Value[]): Value {
  return valueFrom(values);
}
export function unknown(): Value {
  return primitive('Any');
}
/** Empty is inference-pending, not runtime Undefined or unreachable Never. */
export function pending(): Value {
  return value();
}
export function knownConstant(
  input: Value,
): string | number | boolean | undefined {
  const types = input.type;
  if (!types.length || types[0].literalValue === undefined) return;
  const first = types[0].literalValue;
  return types.every((type) => type.literalValue === first) ? first : undefined;
}

/** GML's numeric boolean conversion is > 0.5, not JavaScript truthiness.
 * https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Data_Types.htm
 */
export function constantTruth(input: Value): boolean | undefined {
  const constant = knownConstant(input);
  if (typeof constant === 'boolean') return constant;
  if (typeof constant === 'number' && Number.isFinite(constant))
    return constant > 0.5;
  if (
    input.hasTypes &&
    input.type.every(
      (type) =>
        type.kind === 'Undefined' ||
        (type.kind === 'Pointer' && type.nullPointer === true),
    )
  )
    return false;
  return;
}

/** Exact finite-number facts only. Unknown target/precision cases remain unfolded.
 * GML div converts both operands to integers before division; bitwise results
 * are signed int64 even when their inputs were ordinary numbers.
 * https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Expressions_And_Operators.htm
 */
export function foldNumeric(
  operator: string,
  a: number,
  b: number,
): number | undefined {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  const arithmetic: Record<string, () => number> = {
    '+': () => a + b,
    '-': () => a - b,
    '*': () => a * b,
    '/': () => a / b,
    '%': () => a % b,
    mod: () => a % b,
    div: () =>
      Math.trunc(b) >= 1 ? Math.trunc(Math.trunc(a) / Math.trunc(b)) : NaN,
  };
  if (arithmetic[operator]) {
    const result = arithmetic[operator]();
    return Number.isFinite(result) ? result : undefined;
  }
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return;
  const left = BigInt.asIntN(64, BigInt(a)),
    right = BigInt.asIntN(64, BigInt(b));
  const result =
    operator === '&'
      ? left & right
      : operator === '|'
        ? left | right
        : operator === '^'
          ? left ^ right
          : operator === '<<' && b >= 0 && b < 64
            ? left << right
            : operator === '>>' && b >= 0 && b < 64
              ? left >> right
              : undefined;
  if (result === undefined) return;
  const narrowed = Number(BigInt.asIntN(64, result));
  return Number.isSafeInteger(narrowed) ? narrowed : undefined;
}
export function foldBitwiseNot(input: number): number | undefined {
  if (!Number.isSafeInteger(input)) return;
  const result = Number(BigInt.asIntN(64, ~BigInt(input)));
  return Number.isSafeInteger(result) ? result : undefined;
}

export function withoutUndefined(input: Value): Value {
  return value(...input.type.filter((type) => type.kind !== 'Undefined'));
}
export function nullishPaths(input: Value): {
  present: Value;
  mayRun: boolean;
  maySkip: boolean;
} {
  let mayRun = !input.hasTypes,
    maySkip = !input.hasTypes;
  const retained: Type[] = [];
  for (const type of input.type) {
    if (type.kind === 'Never') {
      retained.push(type);
      continue;
    }
    if (
      type.kind === 'Undefined' ||
      (type.kind === 'Pointer' && type.nullPointer === true)
    )
      mayRun = true;
    else {
      maySkip = true;
      if (type.kind === 'Pointer' && type.nullPointer === undefined) {
        mayRun = true;
        const present = type.deriveDetached();
        present.nullPointer = false;
        retained.push(present);
      } else {
        retained.push(type);
        if (['Any', 'Unknown', 'Mixed'].includes(type.kind)) mayRun = true;
      }
    }
  }
  return { present: value(...retained), mayRun, maySkip };
}
export function nullishResult(left: Value, right: Value): Value {
  const paths = nullishPaths(left);
  return value(paths.present, paths.mayRun ? right : undefined);
}
interface SummaryEdge {
  readonly label: string;
  readonly target: number;
}
interface SummaryNode {
  readonly label: string;
  readonly edges: readonly SummaryEdge[];
}
interface SummaryClass {
  members: Set<number>;
  signature: string;
}

function digest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Edges are a labelled set: union alternatives and member insertion order do
 * not carry meaning, while parameter positions are part of their edge labels. */
function describe(node: SummaryNode, target: (id: number) => unknown): string {
  return JSON.stringify([
    node.label,
    [
      ...new Set(
        node.edges.map((edge) =>
          JSON.stringify([edge.label, target(edge.target)]),
        ),
      ),
    ].sort(),
  ]);
}

/** Coarsest structural equivalence of the finite snapshot. A shared node, an
 * equivalent copy, and a finite unfolding of a recursive value have the same
 * meaning. Only splits are allowed; every split moves the smaller groups and
 * schedules their predecessors, rather than rescanning the entire graph. */
function quotient(nodes: readonly SummaryNode[]): {
  nodes: SummaryNode[];
  classOf: number[];
} {
  const classes: SummaryClass[] = [];
  const classOf: number[] = [];
  const labels = new Map<string, number>();
  const incoming: number[][] = nodes.map(() => []);
  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id];
    let group = labels.get(node.label);
    if (group === undefined) {
      group = classes.length;
      labels.set(node.label, group);
      classes.push({ members: new Set(), signature: node.label });
    }
    classes[group].members.add(id);
    classOf[id] = group;
    for (const edge of node.edges) incoming[edge.target].push(id);
  }
  let dirty = new Set(nodes.map((_, id) => id));
  while (dirty.size) {
    const changes = new Map<number, Map<string, Set<number>>>();
    // Read one partition before applying any splits in this batch.
    for (const id of dirty) {
      const group = classOf[id];
      if (classes[group].members.size === 1) continue;
      const signature = describe(nodes[id], (target) => classOf[target]);
      if (signature === classes[group].signature) continue;
      let buckets = changes.get(group);
      if (!buckets) changes.set(group, (buckets = new Map()));
      let bucket = buckets.get(signature);
      if (!bucket) buckets.set(signature, (bucket = new Set()));
      bucket.add(id);
    }
    dirty = new Set();
    for (const [group, buckets] of changes) {
      const current = classes[group];
      for (const bucket of buckets.values())
        for (const id of bucket) current.members.delete(id);
      if (current.members.size) buckets.set(current.signature, current.members);
      const ordered = [...buckets].sort((a, b) => b[1].size - a[1].size);
      const [signature, members] = ordered[0];
      classes[group] = { signature, members };
      for (const [signature, members] of ordered.slice(1)) {
        const next = classes.length;
        classes.push({ signature, members });
        for (const id of members) {
          classOf[id] = next;
          for (const parent of incoming[id]) dirty.add(parent);
        }
      }
    }
  }
  const result = classes.map((group) => {
    const node = nodes[group.members.values().next().value!];
    const edges = new Map<string, SummaryEdge>();
    for (const edge of node.edges) {
      const target = classOf[edge.target];
      edges.set(JSON.stringify([edge.label, target]), {
        label: edge.label,
        target,
      });
    }
    return { label: node.label, edges: [...edges.values()] };
  });
  return { nodes: result, classOf };
}

/** Iterative Kosaraju traversal, returning components in source-first order.
 * Both capture and graph algorithms use explicit worklists, not the JS stack. */
function components(nodes: readonly SummaryNode[]): {
  groups: number[][];
  groupOf: number[];
} {
  const incoming: number[][] = nodes.map(() => []);
  for (let id = 0; id < nodes.length; id++)
    for (const edge of nodes[id].edges) incoming[edge.target].push(id);
  const seen = new Set<number>();
  const finished: number[] = [];
  for (let id = 0; id < nodes.length; id++) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{ id, edge: 0 }];
    while (stack.length) {
      const current = stack[stack.length - 1];
      const edges = nodes[current.id].edges;
      if (current.edge === edges.length) {
        finished.push(current.id);
        stack.pop();
      } else {
        const next = edges[current.edge++].target;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push({ id: next, edge: 0 });
        }
      }
    }
  }
  const groups: number[][] = [];
  const groupOf: number[] = [];
  for (const id of finished.reverse()) {
    if (groupOf[id] !== undefined) continue;
    const group = groups.length;
    const members: number[] = [];
    groups.push(members);
    groupOf[id] = group;
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      members.push(next);
      for (const parent of incoming[next])
        if (groupOf[parent] === undefined) {
          groupOf[parent] = group;
          stack.push(parent);
        }
    }
  }
  return { groups, groupOf };
}

function canonicalColors(signatures: readonly string[]): number[] {
  const ordered = [...new Set(signatures)].sort();
  const colors = new Map(ordered.map((signature, index) => [signature, index]));
  return signatures.map((signature) => colors.get(signature)!);
}

/** Hash each quotient node once. Cycles use a canonical finite equation table,
 * shared by all their roots; ancestors embed only fixed-size child digests. */
function summarize(nodes: readonly SummaryNode[]): string[] {
  const { groups, groupOf } = components(nodes);
  const summaries: string[] = [];
  for (let group = groups.length - 1; group >= 0; group--) {
    const members = groups[group];
    const first = members[0];
    if (
      members.length === 1 &&
      !nodes[first].edges.some((edge) => edge.target === first)
    ) {
      summaries[first] = digest(
        describe(nodes[first], (target) => summaries[target]),
      );
      continue;
    }
    const local = new Map(members.map((id, index) => [id, index]));
    const signature = (id: number, colors?: readonly number[]) =>
      describe(nodes[id], (target) =>
        groupOf[target] === group
          ? ['cycle', colors ? colors[local.get(target)!] : 0]
          : ['value', summaries[target]],
      );
    let colors = canonicalColors(members.map((id) => signature(id)));
    let count = new Set(colors).size;
    while (count < members.length) {
      const next = canonicalColors(
        members.map((id, index) =>
          JSON.stringify([colors[index], signature(id, colors)]),
        ),
      );
      const nextCount = new Set(next).size;
      colors = next;
      if (nextCount === count) break;
      count = nextCount;
    }
    const equations: string[] = [];
    for (let index = 0; index < members.length; index++)
      equations[colors[index]] = signature(members[index], colors);
    const cycle = digest(['cycle', equations]);
    for (let index = 0; index < members.length; index++)
      summaries[members[index]] = digest(['cycle-root', cycle, colors[index]]);
  }
  return summaries;
}

/** Summarize a synchronous, mutation-free batch. All caches belong to this call:
 * Type/TypeStore graphs are mutable, so callers must start a new snapshot after
 * any write. Object identity only deduplicates capture, never defines equality. */
export function fingerprints(inputs: readonly (Type | TypeStore)[]): string[] {
  const ids = new Map<Type | TypeStore, number>();
  const pending: (Type | TypeStore)[] = [];
  const nodes: SummaryNode[] = [];
  const parameters = new Map<Type, ReturnType<Type['listParameters']>>();
  function identify(input: Type | TypeStore): number {
    let id = ids.get(input);
    if (id === undefined) {
      id = pending.length;
      ids.set(input, id);
      pending.push(input);
    }
    return id;
  }
  const roots = inputs.map(identify);
  for (let index = 0; index < pending.length; index++) {
    const input = pending[index];
    const edges: SummaryEdge[] = [];
    const edge = (label: unknown, target: Type | TypeStore | undefined) => {
      if (target)
        edges.push({ label: JSON.stringify(label), target: identify(target) });
    };
    if (input.$tag === 'TypeStore') {
      for (const type of input.type) edge('alternative', type);
      nodes.push({ label: 'union', edges });
      continue;
    }
    for (const member of input.listMembers(true)) {
      const source = member.resourceDefinition;
      edge(
        [
          'member',
          member.name,
          member.static,
          member.readable,
          member.writable,
          member.placeholder,
          member.override,
          member.mixin,
          member.hidden,
          source && [source.kind, source.unitId, source.uri, source.name],
        ],
        member.type,
      );
    }
    let params: ReturnType<Type['listParameters']> = [];
    if (input.local) {
      params = parameters.get(input.local) || input.listParameters();
      parameters.set(input.local, params);
    }
    params.forEach((param, position) => {
      if (param)
        edge(['parameter', position, param.name, param.optional], param.type);
    });
    edge('returns', input.returns);
    edge('items', input.items);
    edge('self', input.self);
    edge('statics', input.statics);
    edge('extends', input.extends);
    edge('method-source', input.methodSource);
    nodes.push({
      label: JSON.stringify([
        'type',
        input.kind,
        input.name,
        input.isConstructor,
        input.isReadonly,
        input.isGeneric,
        input.callKind,
        input.nullPointer,
        input.literalValue,
        input.functionSource?.fingerprint,
        input.methodSource?.semanticKey,
        params.length,
        enumDeclarationKey(input),
      ]),
      edges,
    });
  }
  const graph = quotient(nodes);
  const summaries = summarize(graph.nodes);
  return roots.map((root) => summaries[graph.classOf[root]]);
}

export function fingerprint(input: Type | TypeStore): string {
  return fingerprints([input])[0];
}
export function equalValues(left: Value, right: Value): boolean {
  const [a, b] = fingerprints([left, right]);
  return a === b;
}
export function dynamic(input: Value): boolean {
  return (
    !input.hasTypes ||
    input.type.some((type) =>
      ['Any', 'Unknown', 'Mixed', 'ArgumentIdentity'].includes(type.kind),
    )
  );
}
