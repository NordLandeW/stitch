import assert from 'node:assert/strict';
import { Signifier } from '../signifiers.js';
import { Type } from '../types.js';
import { fingerprint, value } from './values.js';

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
});
