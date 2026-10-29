import { expect } from 'chai';
import { ValueFeedbackIndex, type ValueEffects } from './value-feedback.js';

const members = (index: ValueFeedbackIndex, unit: string) =>
  [...(index.component(unit) || [])].sort();

/** Independent all-pairs relation built directly from the current port facts. */
function expectedComponent(
  effects: ReadonlyMap<string, ValueEffects>,
  unit: string,
): string[] {
  const reaches = new Map<string, Set<string>>();
  for (const [writer, output] of effects) {
    const targets = new Set([writer]);
    for (const [reader, input] of effects)
      if (output.valueWrites?.some((key) => input.valueReads?.includes(key)))
        targets.add(reader);
    reaches.set(writer, targets);
  }
  for (const via of effects.keys())
    for (const targets of reaches.values())
      if (targets.has(via))
        for (const target of reaches.get(via)!) targets.add(target);
  const result = [...effects.keys()].filter(
    (other) => reaches.get(unit)?.has(other) && reaches.get(other)?.has(unit),
  );
  return result.length > 1 ? result.sort() : [];
}

describe('Value feedback index', function () {
  it('distinguishes shared value feedback from one-way consumers and self reads', function () {
    const index = new ValueFeedbackIndex();
    index.replace('A', { valueReads: ['right'], valueWrites: ['left'] });
    index.replace('B', { valueReads: ['left'], valueWrites: ['right'] });
    index.replace('consumer', { valueReads: ['left'] });
    index.replace('self', {
      valueReads: ['private'],
      valueWrites: ['private'],
    });
    expect(members(index, 'A')).to.deep.equal(['A', 'B']);
    expect(members(index, 'B')).to.deep.equal(['A', 'B']);
    expect(members(index, 'consumer')).to.deep.equal([]);
    expect(members(index, 'self')).to.deep.equal([]);
    expect(members(index, 'absent')).to.deep.equal([]);
  });

  it('retains an edge until its last port support is removed at either endpoint', function () {
    const index = new ValueFeedbackIndex();
    index.replace('A', { valueReads: ['back'], valueWrites: ['p', 'q'] });
    index.replace('B', { valueReads: ['p', 'q'], valueWrites: ['back'] });
    expect(members(index, 'A')).to.deep.equal(['A', 'B']);
    index.replace('B', { valueReads: ['q'], valueWrites: ['back'] });
    expect(members(index, 'A')).to.deep.equal(['A', 'B']);
    index.replace('A', { valueReads: ['back'], valueWrites: ['p'] });
    expect(members(index, 'A')).to.deep.equal([]);
    index.replace('B', { valueReads: ['p'], valueWrites: ['back'] });
    expect(members(index, 'A')).to.deep.equal(['A', 'B']);
    index.remove('B');
    expect(members(index, 'A')).to.deep.equal([]);
    expect(index.effects('B')).to.equal(undefined);
  });

  it('invalidates cached components when feedback expands, splits or disappears', function () {
    const index = new ValueFeedbackIndex();
    index.replace('A', { valueReads: ['b'], valueWrites: ['a'] });
    index.replace('B', { valueReads: ['a'], valueWrites: ['b'] });
    index.replace('C', { valueReads: ['b'], valueWrites: ['c'] });
    expect(members(index, 'A')).to.deep.equal(['A', 'B']);
    expect(members(index, 'C')).to.deep.equal([]);
    index.replace('A', { valueReads: ['c'], valueWrites: ['a'] });
    expect(members(index, 'B')).to.deep.equal(['A', 'B', 'C']);
    index.replace('C', { valueReads: ['a'], valueWrites: ['c'] });
    expect(members(index, 'A')).to.deep.equal(['A', 'C']);
    expect(members(index, 'B')).to.deep.equal([]);
    index.replace('C');
    expect(members(index, 'A')).to.deep.equal([]);
  });

  it('treats keys as exact opaque sets and owns its input snapshots', function () {
    const index = new ValueFeedbackIndex();
    const writes = ['items:x', 'items:x'];
    index.replace('A', { valueReads: ['returns:x'], valueWrites: writes });
    index.replace('B', {
      valueReads: ['symbol:x'],
      valueWrites: ['returns:x'],
    });
    expect(members(index, 'A')).to.deep.equal([]);
    writes.push('symbol:x');
    expect(index.effects('A')?.valueWrites).to.deep.equal(['items:x']);
    index.replace('B', {
      valueReads: ['items:x', 'items:x'],
      valueWrites: ['returns:x'],
    });
    expect(members(index, 'A')).to.deep.equal(['A', 'B']);
    index.replace('A', {
      valueReads: ['returns:x', 'returns:x'],
      valueWrites: ['items:x'],
    });
    expect(members(index, 'A')).to.deep.equal(['A', 'B']);
  });

  it('matches direct reachability through bounded mixed replacements and removals', function () {
    const index = new ValueFeedbackIndex();
    const effects = new Map<string, ValueEffects>();
    const units = ['A', 'B', 'C', 'D', 'E', 'F'];
    const ports = ['items:x', 'symbol:x', 'returns:x', 'opaque:[x,"y"]'];
    let seed = 0x13579bdf;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let step = 0; step < 96; step++) {
      const unit = units[random() % units.length];
      if (random() % 5 === 0) {
        index.remove(unit);
        effects.delete(unit);
      } else {
        const next = {
          valueReads: ports.filter(() => random() % 3 === 0),
          valueWrites: ports.filter(() => random() % 3 === 0),
        };
        index.replace(unit, next);
        effects.set(unit, next);
      }
      for (const current of units)
        expect(
          members(index, current),
          `step ${step}, unit ${current}`,
        ).to.deep.equal(expectedComponent(effects, current));
    }
  });
});
