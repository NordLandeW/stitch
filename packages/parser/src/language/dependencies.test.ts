import { expect } from 'chai';
import type { SemanticDependency } from '../analysis/model.js';
import { DependencyIndex } from './dependencies.js';

describe('Dependency index snapshots', function () {
  it('isolates transaction replacement and removal while retaining unchanged lookups', function () {
    const initial: readonly SemanticDependency[] = [
      { kind: 'lookup', owner: 'root', name: 'first', target: 'first' },
    ];
    const next: readonly SemanticDependency[] = [
      { kind: 'missing', owner: 'root', name: 'second' },
    ];
    const index = new DependencyIndex();
    index.replace('consumer', initial);
    index.replace('other', initial);
    const transaction = index.clone();
    transaction.replace('consumer', next);
    transaction.remove('other');
    expect([...index.affected(['first'])]).to.deep.equal(['consumer', 'other']);
    expect([...transaction.affected(['first'])]).to.deep.equal([]);
    expect([...transaction.affected(['root/lookup:second'])]).to.deep.equal([
      'consumer',
    ]);
    index.remove('consumer');
    expect([...transaction.affected(['root/lookup:second'])]).to.deep.equal([
      'consumer',
    ]);
    transaction.replace('consumer', next);
    expect([...transaction.affected(['root/lookup:second'])]).to.deep.equal([
      'consumer',
    ]);
    transaction.replace('consumer', initial);
    expect([...transaction.affected(['first'])]).to.deep.equal(['consumer']);
    expect([...transaction.affected(['root/lookup:second'])]).to.deep.equal([]);
  });
});
