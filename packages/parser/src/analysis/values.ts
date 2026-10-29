import { createHash } from 'node:crypto';
import type { Signifier } from '../signifiers.js';
import { Type, TypeStore } from '../types.js';
import type { PrimitiveName } from '../types.primitives.js';

export type Value = TypeStore;
type ValueInput = Type | TypeStore | undefined;
type FingerprintMode = 'value' | 'storage' | 'export-shape';

/** Enum values name declarations, not allocation sites. Detached copies retain
 * their signifier even when their graph-local type key is intentionally absent. */
function enumDeclarationKey(type: Type): string | undefined {
  if (type.kind !== 'Enum' && type.kind !== 'EnumMember') return;
  const key = type.signifier?.semanticKey || type.semanticKey;
  return key && JSON.stringify([type.kind, key]);
}

// Only rest arrays created here use this shortcut. Arbitrary iterables retain
// valueFrom's eager per-alternative observations while advancing the iterator.
function valueList(types: ValueInput[]): Value {
  if (types.length > 1) return valueFrom(types);
  let input = types[0];
  if (input?.$tag === 'TypeStore') {
    const alternatives = input.type;
    if (alternatives.length > 1) return valueFrom(alternatives);
    input = alternatives[0];
  }
  const result = new TypeStore();
  result.type = input;
  return result;
}

export function value(...types: ValueInput[]): Value {
  return valueList(types);
}

/** Normalize arbitrary-width inputs without using the JS argument stack. */
export function valueFrom(types: Iterable<ValueInput>): Value {
  const result = new TypeStore();
  type Identity = string | Type | Signifier;
  let seen: Map<Identity, number> | undefined;
  let first: Identity;
  const normalized: Type[] = [];
  function append(type: Type): void {
    // Distinct allocation sites and enum declarations must retain identity.
    const nominal = type.kind === 'Enum' || type.kind === 'EnumMember';
    const structured =
      nominal ||
      type.kind === 'Struct' ||
      type.kind === 'Function' ||
      type.kind === 'Array';
    const identity =
      (nominal && enumDeclarationKey(type)) ||
      type.semanticKey ||
      (nominal
        ? type.signifier || type
        : structured
          ? type
          : `${type.kind}:${type.name || ''}:${String(type.nullPointer)}`);
    if (!normalized.length) {
      first = identity;
      normalized.push(type);
      return;
    }
    // Most semantic values contain one alternative. Allocate an index only
    // when a second distinct identity actually enters the union.
    const priorIndex = seen
      ? seen.get(identity)
      : first === identity
        ? 0
        : undefined;
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
      return;
    }
    seen ||= new Map([[first, 0]]);
    seen.set(identity, normalized.length);
    normalized.push(type);
  }
  for (const input of types) {
    if (input?.$tag === 'TypeStore') {
      for (const type of input.type) append(type);
    } else if (input) append(input);
  }
  result.type = normalized;
  return result;
}
export function primitive(kind: PrimitiveName): Value {
  return value(new Type(kind));
}
export function join(...values: Value[]): Value {
  return valueList(values);
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
  // Descriptions are already unambiguously framed. Do not JSON-escape their
  // complete contents again; retain a separate domain for structured inputs.
  return createHash('sha256')
    .update(
      typeof input === 'string' ? `s${input}` : `j${JSON.stringify(input)}`,
    )
    .digest('hex');
}

/** Edges are a labelled set: union alternatives and member insertion order do
 * not carry meaning, while parameter positions are part of their edge labels. */
function describe(node: SummaryNode, target: (id: number) => unknown): string {
  const edges = new Set<string>();
  for (const edge of node.edges) {
    const value = target(edge.target);
    const encoded =
      typeof value === 'string'
        ? `s${value}`
        : typeof value === 'number'
          ? `n${value}`
          : `j${JSON.stringify(value)}`;
    edges.add(`${edge.label.length}:${edge.label}${encoded.length}:${encoded}`);
  }
  // Length-prefixed fields preserve the labelled-set encoding without repeatedly
  // escaping JSON labels and child digests inside another JSON string.
  return `${node.label.length}:${node.label}${[...edges]
    .sort()
    .map((edge) => `${edge.length}:${edge}`)
    .join('')}`;
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
  // Refinement compares nodes only inside one label class. Intern edge labels
  // once for this capture instead of repeatedly copying their full metadata.
  const edgeLabels = new Map<string, number>();
  const edgeIds: number[][] = [];
  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id];
    let group = labels.get(node.label);
    if (group === undefined) {
      group = classes.length;
      labels.set(node.label, group);
      classes.push({ members: new Set(), signature: 'unrefined' });
    }
    classes[group].members.add(id);
    classOf[id] = group;
    edgeIds[id] = node.edges.map((edge) => {
      incoming[edge.target].push(id);
      let label = edgeLabels.get(edge.label);
      if (label === undefined) {
        label = edgeLabels.size;
        edgeLabels.set(edge.label, label);
      }
      return label;
    });
  }
  let dirty = new Set(nodes.map((_, id) => id));
  while (dirty.size) {
    const changes = new Map<number, Map<string, Set<number>>>();
    // Read one partition before applying any splits in this batch.
    for (const id of dirty) {
      const group = classOf[id];
      if (classes[group].members.size === 1) continue;
      const edges = new Set<string>();
      nodes[id].edges.forEach((edge, offset) => {
        edges.add(`${edgeIds[id][offset]}:${classOf[edge.target]}`);
      });
      // Nonnegative integer pairs have unambiguous separators. These local IDs
      // never enter the quotient nodes or the canonical value summaries.
      const signature = [...edges].sort().join(';');
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
    const id = group.members.values().next().value!;
    const node = nodes[id];
    const edges = new Map<string, SummaryEdge>();
    for (let offset = 0; offset < node.edges.length; offset++) {
      const edge = node.edges[offset];
      const target = classOf[edge.target];
      // Interned labels are exact within this capture. Only the temporary key
      // uses their IDs; output labels and first-edge ordering stay unchanged.
      edges.set(`${edgeIds[id][offset]}:${target}`, {
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

/** Reuse only after a fresh capture proves an exact graph unchanged. Object
 * identities strengthen this fast check; they never define canonical equality.
 * Union stores and leaves may be rebuilt without changing their contents. */
interface FingerprintSnapshot {
  readonly pending: readonly (Type | TypeStore)[];
  readonly nodes: readonly SummaryNode[];
  readonly roots: readonly number[];
}
export class FingerprintCache {
  private previous?: {
    snapshot: FingerprintSnapshot;
    types: ReadonlyMap<Type, number>;
    summaries: readonly string[];
  };

  read(
    pending: readonly (Type | TypeStore)[],
    nodes: readonly SummaryNode[],
    roots: readonly number[],
  ) {
    const snapshot = { pending, nodes, roots };
    const previous = this.previous;
    const old = previous?.snapshot;
    let unchanged = !!old && roots.length === old.roots.length;
    // Only frozen labels/edges are read from the old snapshot. Its live objects
    // provide identity anchors, never their potentially mutated contents.
    const sameType = (current: number, prior: number): boolean => {
      const a = nodes[current],
        b = old!.nodes[prior];
      return !a.edges.length && !b.edges.length
        ? a.label === b.label
        : !!a.edges.length &&
            !!b.edges.length &&
            pending[current] === old!.pending[prior];
    };
    const sameTarget = (current: number, prior: number): boolean => {
      if (pending[current].$tag !== old!.pending[prior].$tag) return false;
      if (pending[current].$tag === 'Type') return sameType(current, prior);
      const a = nodes[current],
        b = old!.nodes[prior];
      // TypeStore alternatives are Types, so this comparison is nonrecursive.
      return (
        a.label === b.label &&
        a.edges.length === b.edges.length &&
        a.edges.every(
          (edge, index) =>
            edge.label === b.edges[index].label &&
            sameType(edge.target, b.edges[index].target),
        )
      );
    };
    if (unchanged)
      unchanged = roots.every((root, index) =>
        sameTarget(root, old!.roots[index]),
      );
    if (unchanged)
      for (let index = 0; index < pending.length; index++) {
        const input = pending[index],
          node = nodes[index];
        if (input.$tag !== 'Type' || !node.edges.length) continue;
        const prior = previous!.types.get(input);
        if (prior === undefined) {
          unchanged = false;
          break;
        }
        const before = old!.nodes[prior];
        if (
          node.label !== before.label ||
          node.edges.length !== before.edges.length ||
          !node.edges.every(
            (edge, offset) =>
              edge.label === before.edges[offset].label &&
              sameTarget(edge.target, before.edges[offset].target),
          )
        ) {
          unchanged = false;
          break;
        }
      }
    return {
      snapshot,
      summaries: unchanged ? [...previous!.summaries] : undefined,
    };
  }

  remember(snapshot: FingerprintSnapshot, summaries: readonly string[]) {
    const types = new Map<Type, number>();
    snapshot.pending.forEach((input, index) => {
      if (input.$tag === 'Type' && snapshot.nodes[index].edges.length)
        types.set(input, index);
    });
    this.previous = { snapshot, types, summaries: [...summaries] };
  }
}

/** Capture the complete current graph once. Both canonical summaries and local
 * history comparisons consume these frozen labels/edges, never old live values. */
function captureValues(
  inputs: readonly (Type | TypeStore)[],
  mode: FingerprintMode,
): FingerprintSnapshot {
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
        input.allocationSource,
        input.usesOther,
        input.callsLocalCallable,
        input.nullPointer,
        input.literalValue,
        mode === 'export-shape' && input.functionSource
          ? [input.functionSource.bound.unitId, input.functionSource.functionId]
          : input.functionSource?.fingerprint,
        input.methodSource?.semanticKey,
        params.length,
        enumDeclarationKey(input),
        // Scalar specification addresses are not mutable storage. A native
        // Real and a computed Real remain the same flow fact.
        ...((mode === 'export-shape' ||
          (mode === 'storage' &&
            (input.kind === 'Struct' ||
              input.kind === 'Function' ||
              input.kind === 'Array' ||
              input.kind.startsWith('Id.')))) &&
        input.semanticKey
          ? [input.semanticKey]
          : []),
      ]),
      edges,
    });
  }
  return { pending, nodes, roots };
}

/** Summarize a synchronous, mutation-free batch. Every call reads the current
 * graph; optional reuse skips canonicalization only after exact fresh capture.
 * Object identity only accelerates that check, never defines value equality.
 * Export shapes retain storage identities and callable origins; executable
 * content is a separate input.
 * Storage comparisons retain both alias identities and full callable content;
 * value comparisons retain content while comparing structurally equal storage. */
export function fingerprints(
  inputs: readonly (Type | TypeStore)[],
  captureType?: (type: Type, summary: string) => void,
  reuse?: FingerprintCache,
  mode: FingerprintMode = 'value',
): string[] {
  const { pending, nodes, roots } = captureValues(inputs, mode);
  const cached = captureType ? undefined : reuse?.read(pending, nodes, roots);
  if (cached?.summaries) return cached.summaries;
  const graph = quotient(nodes);
  const summaries = summarize(graph.nodes);
  if (captureType)
    pending.forEach((input, index) => {
      if (input.$tag === 'Type')
        captureType(input, summaries[graph.classOf[index]]);
    });
  const result = roots.map((root) => summaries[graph.classOf[root]]);
  if (cached) reuse!.remember(cached.snapshot, result);
  return result;
}

export interface ValueHistoryBudget {
  readonly maxNodes?: number;
  readonly maxBytes?: number;
}

function graphSize(nodes: readonly SummaryNode[]) {
  let edges = 0,
    estimatedBytes = nodes.length * 64;
  for (const node of nodes) {
    estimatedBytes += node.label.length * 2;
    for (const edge of node.edges) {
      edges++;
      estimatedBytes += 32 + edge.label.length * 2;
    }
  }
  return { nodes: nodes.length, edges, estimatedBytes };
}

/** Exact equivalence within one bounded history domain. Frozen quotient graphs
 * retain all earlier states; exceeding the graph budget transfers every root
 * to the ordinary canonical comparison instead of truncating the history. */
export class ValueHistory {
  private arena: readonly SummaryNode[] = [];
  private roots = new Set<number>();
  private canonical?: Set<string>;
  // Only frozen strings, numeric targets and descriptor arrays; no live inputs.
  private previousExact?: readonly SummaryNode[];
  private readonly maxNodes: number;
  private readonly maxBytes: number;
  readonly statistics = {
    observations: 0,
    distinctStates: 0,
    rawNodes: 0,
    rawEdges: 0,
    jointNodes: 0,
    quotientNodes: 0,
    retainedNodes: 0,
    retainedEdges: 0,
    retainedBytes: 0,
    peakRawNodes: 0,
    peakJointNodes: 0,
    peakQuotientNodes: 0,
    peakRetainedNodes: 0,
    peakRetainedBytes: 0,
    canonicalizations: 0,
    canonicalStates: 0,
    exactHits: 0,
    exactRetainedNodes: 0,
    exactRetainedBytes: 0,
    exactBudgetMisses: 0,
    mode: 'arena' as 'arena' | 'canonical',
  };

  constructor(
    budget: ValueHistoryBudget = {},
    private readonly comparison: FingerprintMode = 'value',
  ) {
    this.maxNodes = budget.maxNodes ?? 8192;
    this.maxBytes = budget.maxBytes ?? 4 * 1024 * 1024;
    if (
      ![this.maxNodes, this.maxBytes].every(
        (limit) => Number.isSafeInteger(limit) && limit >= 0,
      )
    )
      throw new RangeError('History budgets must be nonnegative safe integers');
  }

  repeats(
    entries: readonly (readonly [string, Type | TypeStore])[],
    label = '',
  ): boolean {
    const captured = captureValues(
      entries.map(([, input]) => input),
      this.comparison,
    );
    const fresh: SummaryNode[] = [
      ...captured.nodes,
      {
        label: JSON.stringify(['value-history', label]),
        edges: entries.map(([label], index) => ({
          label,
          target: captured.roots[index],
        })),
      },
    ];
    const root = fresh.length - 1;
    const raw = graphSize(fresh);
    const stats = this.statistics;
    stats.observations++;
    stats.rawNodes = raw.nodes;
    stats.rawEdges = raw.edges;
    stats.peakRawNodes = Math.max(stats.peakRawNodes, raw.nodes);
    const previous = this.previousExact;
    if (
      previous?.length === fresh.length &&
      fresh.every((node, index) => {
        const prior = previous[index];
        return (
          node.label === prior.label &&
          node.edges.length === prior.edges.length &&
          node.edges.every(
            (edge, offset) =>
              edge.label === prior.edges[offset].label &&
              edge.target === prior.edges[offset].target,
          )
        );
      })
    ) {
      stats.exactHits++;
      stats.jointNodes = stats.quotientNodes = 0;
      return true;
    }
    // A miss releases the optional descriptor before the original history path.
    this.previousExact = undefined;
    stats.exactRetainedNodes = stats.exactRetainedBytes = 0;
    const offset = this.arena.length;
    const joined = offset
      ? [
          ...this.arena,
          ...fresh.map((node) => ({
            label: node.label,
            edges: node.edges.map((edge) => ({
              label: edge.label,
              target: edge.target + offset,
            })),
          })),
        ]
      : fresh;
    stats.jointNodes = joined.length;
    stats.peakJointNodes = Math.max(stats.peakJointNodes, joined.length);
    const graph = quotient(joined);
    const current = graph.classOf[offset + root];
    stats.quotientNodes = graph.nodes.length;
    stats.peakQuotientNodes = Math.max(
      stats.peakQuotientNodes,
      graph.nodes.length,
    );
    if (this.canonical) {
      stats.canonicalizations++;
      const key = summarize(graph.nodes)[current];
      const repeated = this.canonical.has(key);
      this.canonical.add(key);
      stats.distinctStates = stats.canonicalStates = this.canonical.size;
      return repeated;
    }
    const roots = new Set([...this.roots].map((id) => graph.classOf[id]));
    const repeated = roots.has(current);
    roots.add(current);
    stats.distinctStates = roots.size;
    const retained = graphSize(graph.nodes);
    if (
      retained.nodes > this.maxNodes ||
      retained.estimatedBytes > this.maxBytes
    ) {
      stats.canonicalizations++;
      const summaries = summarize(graph.nodes);
      this.canonical = new Set([...roots].map((id) => summaries[id]));
      this.arena = [];
      this.roots.clear();
      stats.mode = 'canonical';
      stats.canonicalStates = this.canonical.size;
      stats.retainedNodes = stats.retainedEdges = stats.retainedBytes = 0;
    } else {
      this.arena = graph.nodes;
      this.roots = roots;
      stats.retainedNodes = retained.nodes;
      stats.retainedEdges = retained.edges;
      // Deterministic graph-storage accounting, not a V8 heap measurement.
      stats.retainedBytes = retained.estimatedBytes;
      stats.peakRetainedNodes = Math.max(
        stats.peakRetainedNodes,
        retained.nodes,
      );
      stats.peakRetainedBytes = Math.max(
        stats.peakRetainedBytes,
        retained.estimatedBytes,
      );
      // Optional raw retention uses only the original arena budget's surplus.
      // It never changes the existing arena/canonical fallback boundary.
      if (
        retained.nodes + raw.nodes <= this.maxNodes &&
        retained.estimatedBytes + raw.estimatedBytes <= this.maxBytes
      ) {
        this.previousExact = fresh;
        stats.exactRetainedNodes = raw.nodes;
        stats.exactRetainedBytes = raw.estimatedBytes;
      } else stats.exactBudgetMisses++;
    }
    return repeated;
  }
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
