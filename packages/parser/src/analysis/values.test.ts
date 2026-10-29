import assert from 'node:assert/strict';
import { Signifier } from '../signifiers.js';
import { Type, TypeStore, type FunctionType } from '../types.js';
import { flowKey, initialFlow } from './flow.js';
import {
  equalValues,
  fingerprint,
  fingerprints,
  FingerprintCache,
  ValueHistory,
  value,
  join,
  valueFrom,
} from './values.js';

function nested(depth: number, leaf: Type): Type {
  let result = leaf;
  for (let index = 0; index < depth; index++) {
    const parent = Type.Struct;
    parent.setOwnMember(new Signifier(parent, 'child', result));
    result = parent;
  }
  return result;
}

describe('Semantic value construction', function () {
  it('keeps empty and single-alternative stores independent without cloning their types', function () {
    const leaf = Type.Real;
    leaf.literalValue = 7;
    for (const input of [undefined, leaf, value(), value(leaf)]) {
      const result = value(input);
      const expected =
        input?.$tag === 'TypeStore' ? input.type : input ? [input] : [];
      assert.deepEqual(result.type, expected);
      assert.notEqual(result, input);
      const joined = join(result);
      assert.notEqual(joined, result);
      result.type = [Type.String];
      assert.deepEqual(joined.type, expected);
      if (input?.$tag === 'TypeStore') assert.deepEqual(input.type, expected);
      if (expected.length) assert.equal(joined.type[0], leaf);
    }
    assert.deepEqual(value().type, []);
    assert.deepEqual(join().type, []);
  });

  it('does not retain an input getter array and reads each source once', function () {
    const leaf = Type.Real;
    const inputs: Type[][] = [[], [leaf]];
    for (const backing of inputs) {
      const expected = [...backing];
      const input = new TypeStore();
      let reads = 0;
      Object.defineProperty(input, 'type', {
        get: () => {
          reads++;
          return backing;
        },
      });
      const outputs = [value(input), join(input)];
      assert.equal(reads, 2);
      backing[0] = Type.String;
      for (const output of outputs) assert.deepEqual(output.type, expected);
    }
  });

  it('still normalizes a single store containing duplicate literals and distinct allocations', function () {
    const first = Type.Real,
      second = Type.Real;
    first.literalValue = 1;
    second.literalValue = 2;
    const left = Type.Struct,
      right = Type.Struct;
    const input = new TypeStore();
    input.type = [first, second, left, right, left];
    for (const output of [value(input), join(input)]) {
      assert.equal(output.type.length, 3);
      assert.equal(output.type[0].kind, 'Real');
      assert.equal(output.type[0].literalValue, undefined);
      assert.equal(output.type[1], left);
      assert.equal(output.type[2], right);
    }
    assert.deepEqual(input.type, [first, second, left, right, left]);
  });

  it('observes arbitrary iterable alternatives before advancing to later mutations', function () {
    const first = Type.Real,
      second = Type.Real;
    first.name = 'before';
    function* inputs() {
      yield first;
      first.name = 'after';
      second.name = 'before';
      yield second;
    }
    // The first identity was observed as Real:before before the next yield.
    assert.deepEqual(valueFrom(inputs()).type, [first]);
  });
});

describe('Semantic value summaries', function () {
  it('tracks exported storage identities through cycles without changing value equivalence', function () {
    const graph = (shared: boolean, reversed = false) => {
      const root = Type.Struct;
      root.semanticKey = 'storage:root';
      const left = Type.Struct;
      left.semanticKey = 'storage:left';
      left.setOwnMember(new Signifier(left, 'field', Type.Real));
      left.setOwnMember(new Signifier(left, 'next', left));
      const right = shared ? left : Type.Struct;
      if (!shared) {
        right.semanticKey = 'storage:right';
        right.setOwnMember(new Signifier(right, 'next', right));
        right.setOwnMember(new Signifier(right, 'field', Type.Real));
      }
      const members: [string, Type][] = [
        ['left', left],
        ['right', right],
      ];
      for (const [name, type] of reversed ? members.reverse() : members)
        root.setOwnMember(new Signifier(root, name, type));
      return root;
    };
    const distinct = graph(false),
      shared = graph(true),
      rebuilt = graph(false, true);
    const ordinary = fingerprint(distinct);
    assert.equal(fingerprint(shared), ordinary);
    assert.equal(fingerprint(rebuilt), ordinary);
    const history = new ValueHistory();
    assert.equal(history.repeats([['root', distinct]]), false);
    assert.equal(history.repeats([['root', shared]]), true);
    const cache = new FingerprintCache();
    const exported = (root: Type) =>
      fingerprints([root], undefined, cache, 'export-shape')[0];
    const first = exported(distinct);
    assert.notEqual(exported(shared), first);
    assert.equal(exported(rebuilt), first);
    assert.equal(fingerprints([shared], undefined, cache)[0], ordinary);
  });

  it('reuses only freshly identical captures and keeps returned summaries independent', function () {
    const cache = new FingerprintCache();
    const root = Type.Struct;
    const field = new Signifier(root, 'field', Type.Real);
    root.setOwnMember(field);
    const read = cache.read.bind(cache);
    let hits = 0;
    cache.read = (...args) => {
      const result = read(...args);
      if (result.summaries) hits++;
      return result;
    };
    const first = fingerprints([value(root)], undefined, cache);
    const expected = [...first];
    first[0] = 'modified by caller';
    // The store and scalar leaf are new objects with identical contents.
    field.setType(Type.Real);
    const second = fingerprints([value(root)], undefined, cache);
    assert.deepEqual(second, expected);
    assert.equal(hits, 1);
    second[0] = 'also modified';
    assert.deepEqual(fingerprints([value(root)], undefined, cache), expected);
    field.setType(Type.String);
    const changed = fingerprints([value(root)], undefined, cache);
    assert.deepEqual(changed, fingerprints([value(root)]));
    assert.notDeepEqual(changed, expected);
    assert.equal(hits, 2);
    let captured = 0;
    assert.deepEqual(
      fingerprints([value(root)], () => captured++, cache),
      changed,
    );
    assert.equal(captured, 2);
  });

  it('keeps cached flow comparisons equivalent through aliases cycles constraints and identity rebuilds', function () {
    const cache = new FingerprintCache();
    const left = Type.Struct,
      right = Type.Struct;
    left.semanticKey = right.semanticKey = 'shared-declaration';
    const field = new Signifier(left, 'field', Type.Real);
    left.setOwnMember(field);
    left.setOwnMember(new Signifier(left, 'next', right));
    right.setOwnMember(new Signifier(right, 'next', left));
    const array = new Type('Array');
    array.items = value(left, right);
    const fn = Type.Function;
    fn.self = left;
    fn.returns = value(array);
    const state = initialFlow();
    state.values.set('value', value(fn, array, left));
    state.constraints.set('value', { type: value(left), conditional: false });
    const check = () => assert.equal(flowKey(state, cache), flowKey(state));
    check();
    check();
    field.setType(Type.String);
    check();
    right.setOwnMember(new Signifier(right, 'field', Type.Bool));
    check();
    array.items = value(right, left);
    check();
    fn.usesOther = true;
    check();
    fn.callsLocalCallable = true;
    check();
    state.initializedStatics.add('cached');
    check();
    state.constraints.set('value', { type: value(right), conditional: true });
    check();
    state.reachable = false;
    check();
    state.reachable = true;
    // Rebuilt identities must fall back to the canonical graph algorithm.
    const cycle = Type.Struct;
    cycle.setOwnMember(new Signifier(cycle, 'next', cycle));
    state.values.set('value', value(cycle));
    check();
    const unfolded = Type.Struct;
    unfolded.setOwnMember(new Signifier(unfolded, 'next', cycle));
    state.values.set('value', value(cycle, unfolded));
    check();
  });
  it('bounds nested summaries without losing deep changes or union order independence', function () {
    for (const depth of [1, 12, 64]) {
      const real = nested(depth, Type.Real);
      const text = nested(depth, Type.String);
      const summary = fingerprint(real);
      // Bound output volume, not elapsed time. A 12-level chain previously
      // expanded past 25 KB, and representative projects exhausted JS strings.
      assert(summary.length < 4096);
      assert.equal(summary, fingerprint(nested(depth, Type.Real)));
      assert.notEqual(summary, fingerprint(text));
      assert.equal(
        fingerprint(value(real, text)),
        fingerprint(value(text, real)),
      );
    }
  });

  it('keeps cyclic graphs finite, reflects mutations and ignores member insertion order', function () {
    function graph(reverse: boolean) {
      const root = Type.Struct;
      const entries = [
        new Signifier(root, 'next', root),
        new Signifier(root, 'value', Type.Real),
      ];
      for (const entry of reverse ? entries.reverse() : entries)
        root.setOwnMember(entry);
      return root;
    }
    const first = graph(false);
    const before = fingerprint(first);
    assert.equal(before, fingerprint(graph(true)));
    first.getMember('value')!.setType(Type.String);
    assert.notEqual(before, fingerprint(first));
    first.getMember('value')!.setType(Type.Real);
    assert.equal(before, fingerprint(first));
  });

  it('captures shared subgraphs once for a whole flow or summary batch', function () {
    const nodes: Type[] = [Type.Real];
    for (let depth = 0; depth < 64; depth++) {
      const parent = Type.Struct;
      parent.setOwnMember(
        new Signifier(parent, 'left', nodes[nodes.length - 1]),
      );
      parent.setOwnMember(
        new Signifier(parent, 'right', nodes[nodes.length - 1]),
      );
      nodes.push(parent);
    }
    let reads = 0;
    for (const node of nodes) {
      const original = node.listMembers.bind(node);
      node.listMembers = (...args) => {
        // An accidental path traversal fails deterministically before it can
        // expand this diamond into 2^64 recursive visits.
        assert(++reads <= nodes.length, 'a snapshot revisited a shared type');
        return original(...args);
      };
    }
    const root = nodes[nodes.length - 1];
    const roots = Array.from({ length: 80 }, () => value(root));
    const summaries = fingerprints(roots);
    assert.equal(reads, nodes.length);
    assert(summaries.every((summary) => summary === summaries[0]));
    reads = 0;
    const flow = initialFlow();
    roots.forEach((current, index) =>
      flow.values.set(`value:${index}`, current),
    );
    const key = flowKey(flow);
    assert.equal(reads, nodes.length);
    reads = 0;
    const reordered = { ...flow, values: new Map([...flow.values].reverse()) };
    assert.equal(flowKey(reordered), key);
    assert.equal(reads, nodes.length);
  });

  it('summarizes deep mutable graphs without using recursive traversal', function () {
    const leaf = Type.Real;
    const root = nested(4096, leaf);
    const before = fingerprint(root);
    leaf.literalValue = 7;
    assert.notEqual(fingerprint(root), before);
    leaf.literalValue = undefined;
    assert.equal(fingerprint(root), before);
  });

  it('equates shared and copied shapes without making allocation or semantic keys into values', function () {
    function tree(depth: number, shared: boolean): Type {
      if (!depth) return Type.Real;
      const node = Type.Struct;
      const left = tree(depth - 1, shared);
      const right = shared ? left : tree(depth - 1, shared);
      node.setOwnMember(new Signifier(node, 'left', left));
      node.setOwnMember(new Signifier(node, 'right', right));
      return node;
    }
    assert.equal(fingerprint(tree(7, true)), fingerprint(tree(7, false)));
    const root = Type.Struct;
    const child = Type.Struct;
    root.semanticKey = child.semanticKey = 'same-declaration';
    root.setOwnMember(new Signifier(root, 'child', child));
    const member = new Signifier(child, 'value', Type.Real);
    child.setOwnMember(member);
    const before = fingerprint(root);
    member.setType(Type.String);
    assert.notEqual(fingerprint(root), before);
    member.setType(Type.Real);
    assert.equal(fingerprint(root), before);
  });

  it('equates cycles with finite unfoldings and redundant cyclic union alternatives', function () {
    function cycle() {
      const node = Type.Struct;
      node.setOwnMember(new Signifier(node, 'next', node));
      return node;
    }
    const original = cycle();
    let unfolded = cycle();
    for (let index = 0; index < 24; index++) {
      const node = Type.Struct;
      node.setOwnMember(new Signifier(node, 'next', unfolded));
      unfolded = node;
    }
    assert.equal(fingerprint(original), fingerprint(unfolded));
    const redundant = cycle();
    redundant.getMember('next')!.type = value(redundant, original, unfolded);
    assert.equal(fingerprint(original), fingerprint(redundant));
    assert(equalValues(value(original, unfolded), value(redundant)));
  });

  it('canonicalizes asymmetric cycles independently of root batches and insertion order', function () {
    function ring(reverse: boolean) {
      const nodes = Array.from({ length: 12 }, () => Type.Struct);
      const order = nodes.map((_, index) => index);
      for (const index of reverse ? order.reverse() : order) {
        const current = nodes[index];
        const members = [
          new Signifier(current, 'next', nodes[(index + 1) % nodes.length]),
        ];
        if (index === 0)
          members.push(new Signifier(current, 'payload', Type.Real));
        for (const member of reverse ? members.reverse() : members)
          current.setOwnMember(member);
      }
      return nodes;
    }
    const first = ring(false),
      second = ring(true);
    const individual = first.map((node) => fingerprint(node));
    assert.deepEqual(
      second.map((node) => fingerprint(node)),
      individual,
    );
    const batch = [
      Type.String,
      ...second.slice().reverse(),
      ...first,
      nested(3, Type.Bool),
    ];
    const combined = fingerprints(batch);
    assert.deepEqual(combined.slice(1, 13).reverse(), individual);
    assert.deepEqual(combined.slice(13, 25), individual);
    // A real change anywhere in the cycle reaches every root, and restoring
    // it restores every digest without relying on mutation notifications.
    const changed = new Signifier(first[6], 'added', Type.Bool);
    first[6].setOwnMember(changed);
    const after = fingerprints(first);
    assert(after.every((summary, index) => summary !== individual[index]));
    first[6].replaceOwnMembers(
      first[6].listMembers(true).filter((member) => member !== changed),
    );
    assert.deepEqual(fingerprints(first), individual);
  });

  it('retains semantic flags, source ownership and labelled container edges', function () {
    const root = Type.Struct;
    const member = new Signifier(root, 'field', Type.Real);
    root.setOwnMember(member);
    const before = fingerprint(root);
    for (const flag of [
      'static',
      'readable',
      'writable',
      'placeholder',
      'override',
      'mixin',
      'hidden',
    ] as const) {
      const previous = member[flag];
      member[flag] = !previous;
      assert.notEqual(fingerprint(root), before, flag);
      member[flag] = previous;
      assert.equal(fingerprint(root), before);
    }
    for (const flag of ['isReadonly', 'isGeneric', 'isConstructor'] as const) {
      root[flag] = true;
      assert.notEqual(fingerprint(root), before, flag);
      root[flag] = false;
      assert.equal(fingerprint(root), before);
    }
    member.resourceDefinition = {
      kind: 'object-variable',
      unitId: 'resources',
      uri: 'objects/First.yy',
      name: 'field',
    };
    const owned = fingerprint(root);
    assert.notEqual(owned, before);
    for (const field of ['unitId', 'uri', 'name'] as const) {
      const source: NonNullable<Signifier['resourceDefinition']> =
        member.resourceDefinition;
      member.resourceDefinition = {
        ...source,
        [field]: `${source[field]}-changed`,
      };
      assert.notEqual(fingerprint(root), owned, field);
      member.resourceDefinition = source;
      assert.equal(fingerprint(root), owned);
    }
    member.resourceDefinition = undefined;
    assert.equal(fingerprint(root), before);
    const first = Type.Struct,
      second = Type.Struct;
    first.items = value(Type.Real);
    second.returns = value(Type.Real);
    assert.notEqual(fingerprint(first), fingerprint(second));
    first.items = value(Type.String);
    second.items = value(Type.Real);
    second.returns = undefined;
    assert.notEqual(fingerprint(first), fingerprint(second));
  });

  it('retains parameter positions, constant facts and function or method provenance', function () {
    const fn = Type.Function;
    fn.addParameter(0, 'first', { type: Type.Real });
    fn.addParameter(1, 'second', { type: Type.String });
    const first = fn.getParameter(0)!,
      second = fn.getParameter(1)!;
    const before = fingerprint(fn);
    first.idx = 1;
    second.idx = 0;
    assert.notEqual(fingerprint(fn), before);
    first.idx = 0;
    second.idx = 1;
    assert.equal(fingerprint(fn), before);
    first.optional = true;
    assert.notEqual(fingerprint(fn), before);
    first.optional = false;
    const pointer = new Type('Pointer');
    const unknown = fingerprint(pointer);
    pointer.nullPointer = false;
    const present = fingerprint(pointer);
    pointer.nullPointer = true;
    assert.notEqual(fingerprint(pointer), present);
    assert.notEqual(fingerprint(pointer), unknown);
    const constant = Type.Real;
    const unqualified = fingerprint(constant);
    constant.literalValue = 3;
    assert.notEqual(fingerprint(constant), unqualified);
    fn.functionSource = {
      // Only the immutable body fingerprint is semantic here. Binding object
      // allocation and unrelated source bookkeeping must not affect equality.
      bound: {} as NonNullable<Type['functionSource']>['bound'],
      functionId: 'fixture',
      fingerprint: 'body-one',
    };
    const source = fingerprint(fn);
    fn.functionSource = {
      ...fn.functionSource,
      bound: {} as NonNullable<Type['functionSource']>['bound'],
    };
    assert.equal(fingerprint(fn), source);
    fn.functionSource = { ...fn.functionSource, fingerprint: 'body-two' };
    assert.notEqual(fingerprint(fn), source);
    const method = fn.deriveDetached() as FunctionType;
    method.methodSource = fn;
    const bound = fingerprint(method);
    fn.functionSource = { ...fn.functionSource, fingerprint: 'body-three' };
    assert.notEqual(fingerprint(method), bound);
    fn.functionSource = { ...fn.functionSource, fingerprint: 'body-two' };
    assert.equal(fingerprint(method), bound);
    fn.callKind = 'legacy';
    assert.notEqual(fingerprint(method), bound);
  });

  it('uses enum declaration identity across detached copies without conflating equal names or values', function () {
    function enumeration(key: string) {
      const owner = Type.Struct;
      const declaration = new Signifier(owner, 'Example');
      declaration.semanticKey = `global:${key}`;
      const type = new Type('Enum').named('Example');
      type.semanticKey = `enum:global:${key}`;
      type.signifier = declaration;
      declaration.setType(type);
      const member = new Signifier(type, 'same');
      member.semanticKey = `member:enum:global:${key}:same`;
      const current = new Type('EnumMember').named('same');
      current.semanticKey = `enum-member:${member.semanticKey}`;
      current.literalValue = 1;
      current.signifier = member;
      member.setType(current);
      type.setOwnMember(member);
      return { type, current };
    }
    const first = enumeration('First'),
      second = enumeration('Second');
    for (const field of ['type', 'current'] as const) {
      const original = first[field];
      const copy = original.deriveDetached();
      assert.equal(
        copy.semanticKey,
        undefined,
        'general detached-copy identity remains unchanged',
      );
      assert.equal(value(original, copy).type.length, 1);
      assert.equal(fingerprint(original), fingerprint(copy));
      const unrelated = second[field];
      assert.equal(
        value(original, copy, unrelated, unrelated.deriveDetached()).type
          .length,
        2,
      );
      assert.notEqual(fingerprint(original), fingerprint(unrelated));
      assert.equal(
        fingerprint(original),
        fingerprint(enumeration('First')[field]),
      );
    }
    const before = fingerprint(first.current);
    first.current.literalValue = 2;
    assert.notEqual(fingerprint(first.current), before);
    first.current.literalValue = 1;
    assert.equal(fingerprint(first.current), before);
    const shape = Type.Struct;
    assert.equal(
      value(shape, shape.deriveDetached()).type.length,
      2,
      'struct allocation sites retain their separate identities',
    );
  });

  it('keeps arbitrary labels distinct through summary framing', function () {
    const labels = [
      '',
      '1:',
      'svalue',
      'j["value"]',
      'name:with;delimiters',
      '"\\\n',
      '猫',
    ];
    const hashes = labels.map((name) => {
      const type = Type.Struct;
      type.name = name;
      type.setOwnMember(new Signifier(type, `${name}:field`, Type.Real));
      return fingerprint(type);
    });
    assert.equal(new Set(hashes).size, labels.length);
    assert.deepEqual(
      labels.map((name) => {
        const type = Type.Struct;
        type.name = name;
        type.setOwnMember(new Signifier(type, `${name}:field`, Type.Real));
        return fingerprint(type);
      }),
      hashes,
    );
  });

  it('preserves labelled cyclic shapes when unrelated roots change the capture order', function () {
    const names = [
      '',
      '0',
      '1:2',
      '1;2',
      '1,2',
      '"\\\n',
      '猫',
      ...Array.from({ length: 32 }, (_, index) => `field-${index}`),
    ];
    const roots = names.map((name, index) => {
      const type = Type.Struct;
      type.setOwnMember(
        new Signifier(type, name, Type.Struct.named(`leaf-${index % 16}`)),
      );
      type.setOwnMember(new Signifier(type, 'next', type));
      return type;
    });
    const individual = roots.map((root) => fingerprint(root));
    assert.equal(new Set(individual).size, roots.length);
    assert.deepEqual(fingerprints(roots), individual);
    const mixed = fingerprints([
      nested(4, Type.Bool),
      ...roots.slice().reverse(),
      Type.String,
    ]);
    assert.deepEqual(mixed.slice(1, -1).reverse(), individual);
    const before = fingerprint(roots[0]);
    roots[0].getMember('')!.setType(Type.String);
    assert.notEqual(fingerprint(roots[0]), before);
    assert.deepEqual(fingerprints(roots.slice(1)), individual.slice(1));
  });

  it('tracks caller-sensitive function effects independently of return types', function () {
    const fn = Type.Function;
    const original = fingerprint(fn);
    fn.usesOther = true;
    const other = fingerprint(fn);
    assert.notEqual(other, original);
    fn.callsLocalCallable = true;
    assert.notEqual(fingerprint(fn), other);
    fn.usesOther = false;
    const local = fingerprint(fn);
    assert.notEqual(local, original);
    fn.callsLocalCallable = false;
    assert.equal(fingerprint(fn), original);
  });

  it('separates export shape from body versions while retaining callable origin and ordinary fingerprints', function () {
    const fn = Type.Function;
    fn.functionSource = {
      bound: { unitId: 'provider.gml' } as NonNullable<
        Type['functionSource']
      >['bound'],
      functionId: 'first',
      fingerprint: 'body-one',
    };
    fn.returns = value(Type.Real);
    const root = Type.Struct;
    root.setOwnMember(new Signifier(root, 'callback', fn));
    fn.self = root;
    const shape = () =>
      fingerprints([root], undefined, undefined, 'export-shape')[0];
    const original = shape();
    const ordinary = fingerprint(root);
    fn.functionSource = { ...fn.functionSource, fingerprint: 'body-two' };
    assert.equal(shape(), original);
    assert.notEqual(fingerprint(root), ordinary);
    fn.functionSource = { ...fn.functionSource, functionId: 'second' };
    assert.notEqual(shape(), original);
    fn.functionSource = {
      ...fn.functionSource,
      functionId: 'first',
      bound: { unitId: 'other.gml' } as NonNullable<
        Type['functionSource']
      >['bound'],
    };
    assert.notEqual(shape(), original);
    fn.functionSource = {
      ...fn.functionSource,
      bound: { unitId: 'provider.gml' } as NonNullable<
        Type['functionSource']
      >['bound'],
    };
    assert.equal(shape(), original);
    fn.returns = value(Type.String);
    assert.notEqual(shape(), original);
    const cache = new FingerprintCache();
    assert.deepEqual(fingerprints([root], undefined, cache), [
      fingerprint(root),
    ]);
    assert.deepEqual(fingerprints([root], undefined, cache, 'export-shape'), [
      shape(),
    ]);
    assert.deepEqual(fingerprints([root], undefined, cache), [
      fingerprint(root),
    ]);
  });
});

describe('Frozen value history equivalence', function () {
  it('matches canonical labelled batches through cyclic unfoldings and union reorderings', function () {
    const history = new ValueHistory();
    const fallback = new ValueHistory({ maxNodes: 0 });
    const seen = new Set<string>();
    const check = (entries: [string, Type][], context = '') => {
      const summaries = fingerprints(entries.map(([, type]) => type));
      const key = JSON.stringify([
        context,
        entries.map(([label], index) => [label, summaries[index]]).sort(),
      ]);
      const expected = seen.has(key);
      assert.equal(history.repeats(entries, context), expected);
      assert.equal(fallback.repeats(entries, context), expected);
      seen.add(key);
    };
    const root = Type.Struct;
    root.setOwnMember(new Signifier(root, 'next', root));
    check([
      ['first', root],
      ['second', root],
    ]);
    const unfolded = Type.Struct;
    unfolded.setOwnMember(new Signifier(unfolded, 'next', root));
    check([
      ['second', unfolded],
      ['first', root],
    ]);
    const array = new Type('Array');
    array.items = value(root, unfolded);
    check([
      ['array', array],
      ['root', root],
    ]);
    array.items = value(unfolded, root);
    check([
      ['root', root],
      ['array', array],
    ]);
    array.items = value(root);
    check([
      ['array', array],
      ['root', unfolded],
    ]);
    check([['first', root]]);
    check([['first', root]]);
    assert.equal(history.statistics.exactHits, 1);
    check([['first', root]], 'other-context');
    check([['renamed', root]], 'other-context');
    check([['first', root]]);
    assert.equal(history.statistics.exactHits, 1);
    assert.equal(history.statistics.distinctStates, seen.size);
    assert.equal(history.statistics.canonicalizations, 0);
  });

  it('retains ordinary callable versions, member ownership, parameter positions and nominal/literal distinctions', function () {
    const history = new ValueHistory();
    const fallback = new ValueHistory({ maxBytes: 1 });
    const seen = new Set<string>();
    const root = Type.Struct;
    const fn = Type.Function;
    fn.self = root;
    fn.addParameter(0, 'first', { type: Type.Real });
    fn.addParameter(1, 'second', { type: Type.String });
    fn.functionSource = {
      bound: {} as NonNullable<Type['functionSource']>['bound'],
      functionId: 'fixture',
      fingerprint: 'body-one',
    };
    const member = new Signifier(root, 'callback', fn);
    root.setOwnMember(member);
    const check = (type: Type = root) => {
      const key = fingerprint(type);
      const expected = seen.has(key);
      assert.equal(history.repeats([['value', type]]), expected);
      assert.equal(fallback.repeats([['value', type]]), expected);
      seen.add(key);
    };
    check();
    fn.functionSource = { ...fn.functionSource, fingerprint: 'body-two' };
    check();
    fn.functionSource = { ...fn.functionSource, fingerprint: 'body-one' };
    check();
    fn.usesOther = true;
    check();
    fn.usesOther = false;
    fn.callsLocalCallable = true;
    check();
    fn.callsLocalCallable = false;
    const first = fn.getParameter(0)!,
      second = fn.getParameter(1)!;
    first.idx = 1;
    second.idx = 0;
    check();
    first.idx = 0;
    second.idx = 1;
    check();
    for (const flag of [
      'static',
      'readable',
      'writable',
      'placeholder',
      'override',
      'mixin',
      'hidden',
    ] as const) {
      const before = member[flag];
      member[flag] = !before;
      check();
      member[flag] = before;
    }
    member.resourceDefinition = {
      kind: 'object-variable',
      unitId: 'resources',
      uri: 'objects/First.yy',
      name: 'callback',
    };
    check();
    member.resourceDefinition = {
      ...member.resourceDefinition,
      uri: 'objects/Second.yy',
    };
    check();
    member.resourceDefinition = undefined;
    check();
    const scalar = Type.Real;
    scalar.literalValue = 1;
    check(scalar);
    scalar.literalValue = 2;
    check(scalar);
    scalar.literalValue = 1;
    check(scalar);
    const enumValue = new Type('EnumMember').named('same');
    const declaration = new Signifier(Type.Struct, 'same');
    declaration.semanticKey = 'enum:first';
    enumValue.signifier = declaration;
    enumValue.literalValue = 1;
    check(enumValue);
    declaration.semanticKey = 'enum:second';
    check(enumValue);
    declaration.semanticKey = 'enum:first';
    check(enumValue);
    assert.equal(history.statistics.distinctStates, seen.size);
  });

  it('recaptures nested live values before skipping repeated graph work', function () {
    const history = new ValueHistory();
    const root = Type.Struct,
      nested = Type.Struct;
    const field = new Signifier(nested, 'field', Type.Real);
    nested.setOwnMember(field);
    root.setOwnMember(new Signifier(root, 'nested', nested));
    root.setOwnMember(new Signifier(root, 'next', root));
    let captures = 0;
    const listMembers = nested.listMembers.bind(nested);
    nested.listMembers = (...args) => {
      captures++;
      return listMembers(...args);
    };
    const entries: [string, Type][] = [['value', root]];
    assert.equal(history.repeats(entries), false);
    const before = { ...history.statistics };
    assert(before.jointNodes > 0 && before.quotientNodes > 0);
    assert.equal(history.repeats(entries), true);
    assert.equal(captures, 2);
    assert.deepEqual(history.statistics, {
      ...before,
      observations: before.observations + 1,
      exactHits: 1,
      jointNodes: 0,
      quotientNodes: 0,
    });
    field.setType(Type.String);
    assert.equal(history.repeats(entries), false);
    assert.equal(captures, 3);
    assert.equal(history.statistics.exactHits, 1);
    assert(history.statistics.jointNodes > 0);
    assert(history.statistics.quotientNodes > 0);
    field.setType(Type.Real);
    assert.equal(history.repeats(entries), true);
    assert.equal(captures, 4);
    assert.equal(history.statistics.exactHits, 1);
  });

  it('keeps arena semantics when optional raw retention exhausts the graph budget', function () {
    const root = Type.Real;
    root.literalValue = 0;
    const entries: [string, Type][] = [['value', root]];
    const probe = new ValueHistory();
    probe.repeats(entries);
    for (const budget of [
      { maxNodes: probe.statistics.retainedNodes * 2 },
      { maxBytes: probe.statistics.retainedBytes * 2 },
    ]) {
      const history = new ValueHistory(budget);
      const canonical = new ValueHistory({ maxNodes: 0 });
      for (const [index, literal] of [0, 0, 1, 1, 0, 2, 0, 1, 2].entries()) {
        root.literalValue = literal;
        assert.equal(history.repeats(entries), canonical.repeats(entries));
        const stats = history.statistics;
        assert.equal(stats.mode, index < 5 ? 'arena' : 'canonical');
        assert.equal(stats.exactHits, index === 0 ? 0 : 1);
        if (index < 2) {
          assert(stats.exactRetainedNodes > 0 && stats.exactRetainedBytes > 0);
          assert(
            stats.retainedNodes + stats.exactRetainedNodes <=
              (budget.maxNodes ?? 8192),
          );
          assert(
            stats.retainedBytes + stats.exactRetainedBytes <=
              (budget.maxBytes ?? 4 * 1024 * 1024),
          );
        } else {
          assert.equal(stats.exactRetainedNodes, 0);
          assert.equal(stats.exactRetainedBytes, 0);
        }
      }
      assert.equal(
        history.statistics.distinctStates,
        canonical.statistics.distinctStates,
      );
    }
  });
});
