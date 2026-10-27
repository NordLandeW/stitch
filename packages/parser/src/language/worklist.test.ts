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
});
