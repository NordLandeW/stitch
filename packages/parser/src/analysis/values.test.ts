import assert from 'node:assert/strict';
import { Signifier } from '../signifiers.js';
import { Type, type FunctionType } from '../types.js';
import { flowKey, initialFlow } from './flow.js';
import { equalValues, fingerprint, fingerprints, value } from './values.js';

function nested(depth: number, leaf: Type): Type {
  let result = leaf;
  for (let index = 0; index < depth; index++) {
    const parent = Type.Struct;
    parent.setOwnMember(new Signifier(parent, 'child', result));
    result = parent;
  }
  return result;
}

describe('Semantic value summaries', function () {
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
});
