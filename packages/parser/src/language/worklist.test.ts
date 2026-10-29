import { expect } from 'chai';
import type { SemanticDependency } from '../analysis/model.js';
import { WorklistHistory } from './worklist.js';

const readsB: SemanticDependency = {
  kind: 'type',
  owner: 'B',
  facet: 'returns',
};
const readsA: SemanticDependency = {
  kind: 'type',
  owner: 'A',
  facet: 'returns',
};

describe('Analysis worklist convergence', function () {
  it('accepts a repeated unit output when the complete worklist continues to advance', function () {
    const history = new WorklistHistory();
    history.setUnit('A', { summary: 'Real', dependencies: [readsB] });
    history.setUnit('B');
    expect(history.repeats(['A', 'B'])).to.equal(false);
    history.setUnit('B', { summary: 'String', dependencies: [] });
    history.setUnit('A', { summary: 'String', dependencies: [readsB] });
    expect(history.repeats(['B', 'A'])).to.equal(false);
    history.setUnit('B', { summary: 'Undefined', dependencies: [] });
    history.setUnit('A', { summary: 'Real', dependencies: [readsB] });
    expect(history.repeats(['A', 'B'])).to.equal(false);
    expect(history.repeats([])).to.equal(false);
    expect(history.repeats([])).to.equal(false);
  });

  it('detects an actual return to the complete output, dependency, base and queue state', function () {
    const history = new WorklistHistory();
    history.setUnit('A', { summary: 'Real', dependencies: [readsB] });
    history.setUnit('B', { summary: 'String', dependencies: [readsA] });
    history.setResourceBases([['child', 'parent']]);
    expect(history.repeats(['A', 'B'])).to.equal(false);
    history.setUnit('A', { summary: 'String', dependencies: [readsB] });
    history.setUnit('B', { summary: 'Real', dependencies: [readsA] });
    expect(history.repeats(['B', 'A'])).to.equal(false);
    history.setUnit('A', { summary: 'Real', dependencies: [readsB] });
    history.setUnit('B', { summary: 'String', dependencies: [readsA] });
    expect(history.repeats(['A', 'B'])).to.equal(true);
  });

  it('distinguishes pending declarations, changed dependencies, dynamic bases and queue order', function () {
    const history = new WorklistHistory();
    history.setUnit('A');
    history.setUnit('B');
    history.setResourceBases([['child', 'first']]);
    expect(history.repeats(['A', 'B'])).to.equal(false);
    history.setUnit('A', { summary: '', dependencies: [] });
    expect(history.repeats(['A', 'B'])).to.equal(false);
    history.setUnit('A', { summary: '', dependencies: [readsB] });
    expect(history.repeats(['A', 'B'])).to.equal(false);
    history.setResourceBases([['child', 'second']]);
    expect(history.repeats(['A', 'B'])).to.equal(false);
    expect(history.repeats(['B', 'A'])).to.equal(false);
    history.setUnit('A', { summary: '', dependencies: [readsB] }, ['new-key']);
    expect(history.repeats(['B', 'A'])).to.equal(false);
    history.setUnit(
      'A',
      { summary: '', dependencies: [{ ...readsB }, readsB] },
      ['new-key', 'new-key'],
    );
    expect(history.repeats(['B', 'A'])).to.equal(true);
  });

  it('tracks restored values and new units after the first observation', function () {
    const history = new WorklistHistory();
    history.setUnit('later', { summary: 'Real', dependencies: [] });
    expect(history.repeats(['later'])).to.equal(false);
    history.setUnit('earlier', { summary: 'String', dependencies: [] });
    expect(history.repeats(['later'])).to.equal(false);
    history.setUnit('later', { summary: 'Bool', dependencies: [] });
    expect(history.repeats(['later'])).to.equal(false);
    history.setUnit('later', { summary: 'Real', dependencies: [] });
    expect(history.repeats(['later'])).to.equal(true);
    history.setUnit('earlier', { summary: 'String', dependencies: [] });
    expect(history.repeats(['later'])).to.equal(true);
    expect(history.repeats(['earlier', 'later'])).to.equal(false);
    expect(history.repeats(['later', 'earlier'])).to.equal(false);
  });

  it('reuses an immutable unit summary without changing cycle detection', function () {
    const history = new WorklistHistory();
    const state = history.setUnit(
      'A',
      { summary: 'Real', dependencies: [readsB] },
      ['field'],
    );
    expect(history.repeats(['A'])).to.equal(false);
    history.setUnit('A', { summary: 'String', dependencies: [readsB] }, [
      'field',
    ]);
    expect(history.repeats(['A'])).to.equal(false);
    history.setUnitState('A', state);
    expect(history.repeats(['A'])).to.equal(true);
  });

  it('distinguishes exact value ports and preserves known effects during withdrawal', function () {
    const history = new WorklistHistory();
    const result = { summary: 'String', dependencies: [] };
    const effects = { valueReads: ['items:x'], valueWrites: ['returns:y'] };
    history.setUnit('A', result, [], effects);
    expect(history.repeats(['A'])).to.equal(false);
    history.setUnit('A', result, [], { ...effects, valueReads: ['symbol:x'] });
    expect(history.repeats(['A'])).to.equal(false);
    history.setUnit('A', result, [], {
      valueReads: ['items:x', 'items:x'],
      valueWrites: ['returns:y'],
    });
    expect(history.repeats(['A'])).to.equal(true);
    const withdrawn = history.setUnit('A', undefined, [], effects);
    expect(history.repeats(['A'])).to.equal(false);
    history.setUnit('A');
    expect(history.repeats(['A'])).to.equal(false);
    history.setUnitState('A', withdrawn);
    expect(history.repeats(['A'])).to.equal(true);
  });

  it('tracks active membership and deferred order without changing the real queue', function () {
    const history = new WorklistHistory();
    history.setUnit('A');
    const queue = new Set(['A']);
    expect(history.repeats(queue)).to.equal(false);
    history.setSchedulingState(['A', 'B'], ['consumer', 'provider']);
    expect(history.repeats(queue)).to.equal(false);
    history.setSchedulingState(['B', 'A'], ['consumer', 'provider']);
    expect(history.repeats(queue)).to.equal(true);
    history.setSchedulingState(['A', 'B'], ['provider', 'consumer']);
    expect(history.repeats(queue)).to.equal(false);
    history.setSchedulingState(['A'], ['provider', 'consumer']);
    expect(history.repeats(queue)).to.equal(false);
    history.setSchedulingState();
    expect(history.repeats(queue)).to.equal(true);
    expect([...queue]).to.deep.equal(['A']);
  });

  it('distinguishes component comparison baselines that determine outward work', function () {
    const history = new WorklistHistory();
    history.setUnit('A');
    history.setSchedulingState(
      ['A', 'B'],
      [],
      [
        ['A', 'old'],
        ['B', 'same'],
      ],
    );
    expect(history.repeats(['A'])).to.equal(false);
    history.setSchedulingState(
      ['B', 'A'],
      [],
      [
        ['B', 'same'],
        ['A', 'new'],
      ],
    );
    expect(history.repeats(['A'])).to.equal(false);
    history.setSchedulingState(
      ['A', 'B'],
      [],
      [
        ['B', 'same'],
        ['A', 'old'],
      ],
    );
    expect(history.repeats(['A'])).to.equal(true);
  });

  it('distinguishes first-evaluation retry eligibility from a cached semantic state', function () {
    const history = new WorklistHistory();
    const state = history.setUnit('A');
    expect(history.repeats(['A'])).to.equal(false);
    history.markEvaluated('A');
    expect(history.repeats(['A'])).to.equal(false);
    history.setUnitState('A', state);
    expect(history.repeats(['A'])).to.equal(true);
    history.markEvaluated('A');
    expect(history.repeats(['A'])).to.equal(true);
  });
});
