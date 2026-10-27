import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkspaceSymbolSearch,
  captureSymbolProjectGeneration,
} from './extension.symbols.core.mjs';

class CountingSearch extends WorkspaceSymbolSearch {
  readonly computations = new Map<string, number>();
  protected override computeScore(name: string): number {
    this.computations.set(name, (this.computations.get(name) ?? 0) + 1);
    return super.computeScore(name);
  }
}

for (const character of [
  '[',
  ']',
  '(',
  ')',
  '.',
  '+',
  '*',
  '?',
  '\\',
  '^',
  '$',
  '{',
  '}',
  '|',
]) {
  test(`workspace symbol query treats ${JSON.stringify(character)} literally`, () => {
    const search = new WorkspaceSymbolSearch(character);
    assert.equal(search.matches(`before${character}after`), true);
    assert.equal(search.matches('ordinary_identifier'), false);
    assert.equal(
      new WorkspaceSymbolSearch(`a${character}b`).matches(`a__${character}__b`),
      true,
    );
    assert.equal(
      new WorkspaceSymbolSearch(`a${character}b`).matches('a__b'),
      false,
    );
  });
}

test('preserves trimmed, case-insensitive, greedy fuzzy scores', () => {
  const search = new WorkspaceSymbolSearch('  ab  ');
  assert.equal(search.query, 'ab');
  assert.equal(search.score('ab'), 4);
  assert.equal(search.score('AB'), 4);
  assert.equal(search.score('axb'), 2.9999999999999996);
  assert.equal(search.score('xxab'), 3);
  // The original greedy pattern spans the last b, not just the first ab.
  assert.equal(search.score('abxb'), 2.5);
  assert.equal(search.score('xb'), 0);
  assert.equal(search.score(''), 0);
  assert.equal(new WorkspaceSymbolSearch('  ').matches('anything'), false);
});

test('ranks by cached score, then locale name order, and retains stable identical-name ties', async () => {
  const search = new WorkspaceSymbolSearch('ab');
  const first = { name: 'ab', id: 1 };
  const second = { name: 'ab', id: 2 };
  const items = [
    { name: 'abxb' },
    { name: 'xxab' },
    second,
    { name: 'axb' },
    first,
  ];
  assert.deepEqual(await search.rank(items, 4), [
    second,
    first,
    items[1],
    items[3],
  ]);
  const tiedNames = [{ name: 'ab' }, { name: 'AB' }];
  assert.deepEqual(
    await search.rank(tiedNames, 30),
    [...tiedNames].sort((a, b) => a.name.localeCompare(b.name)),
  );
});

test('filtering, duplicate names and ranking compute each score only once, including misses', async () => {
  const search = new CountingSearch('ab');
  const items = ['ab', 'xxab', 'ab', 'absent', 'no_match'].map((name) => ({
    name,
  }));
  const matches = items.filter(({ name }) => search.matches(name));
  for (const { name } of items) search.matches(name);
  await search.rank(matches, 30);
  assert.deepEqual(
    [...search.computations],
    [
      ['ab', 1],
      ['xxab', 1],
      ['absent', 1],
      ['no_match', 1],
    ],
  );
});

test('a pre-cancelled search does not start traversing its input', async () => {
  let visited = 0;
  function* items() {
    visited++;
    yield { name: 'value' };
  }
  const search = new WorkspaceSymbolSearch('value', {
    isCancelled: () => true,
  });
  assert.deepEqual(await search.rank(items(), 30), []);
  assert.equal(visited, 0);
});

test('batch yields let cancellation stop work and discard partial results', async () => {
  let cancelled = false;
  let yielded = 0;
  let visited = 0;
  const total = 10000;
  function* items() {
    for (let index = 0; index < total; index++) {
      visited++;
      yield { name: `value_${index}` };
    }
  }
  const search = new WorkspaceSymbolSearch('value', {
    isCancelled: () => cancelled,
    async yieldToHost() {
      yielded++;
      cancelled = true;
    },
  });
  assert.deepEqual(await search.rank(items(), 30), []);
  assert.equal(yielded, 1);
  assert(visited > 0 && visited < total);
  assert.equal(search.cancelled, true);
});

test('symbol generation guards capture the generation value rather than analysis object identity', () => {
  const project = { analysis: { generation: 4 } };
  const isCurrent = captureSymbolProjectGeneration(project);
  assert.equal(isCurrent(), true);
  project.analysis = { generation: 4 };
  assert.equal(isCurrent(), true);
  project.analysis.generation++;
  assert.equal(isCurrent(), false);
});

test('generation invalidation before traversal discards results without pretending user cancellation', async () => {
  const project = { analysis: { generation: 4 } };
  const search = new WorkspaceSymbolSearch('value', {
    isCurrent: captureSymbolProjectGeneration(project),
  });
  project.analysis.generation++;
  let visited = false;
  function* items() {
    visited = true;
    yield { name: 'value' };
  }
  assert.deepEqual(await search.rank(items(), 30), []);
  assert.equal(visited, false);
  assert.equal(search.cancelled, false);
  assert.equal(search.stopped, true);
});

test('a project-generation change while yielded discards the complete partial ranking', async () => {
  const project = { analysis: { generation: 4 } };
  let visited = 0;
  const total = 10000;
  function* items() {
    for (let index = 0; index < total; index++) {
      visited++;
      yield { name: `value_${index}` };
    }
  }
  const search = new WorkspaceSymbolSearch('value', {
    isCurrent: captureSymbolProjectGeneration(project),
    async yieldToHost() {
      project.analysis.generation++;
    },
  });
  assert.deepEqual(await search.rank(items(), 30), []);
  assert(visited > 0 && visited < total);
  assert.equal(search.cancelled, false);
  assert.equal(search.stopped, true);
});
