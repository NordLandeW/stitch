import { expect } from 'chai';
import { bindUnit } from '../analysis/binding.js';
import {
  createDeclarationSummary,
  evaluateUnit,
} from '../analysis/evaluation.js';
import { normalizeSyntax } from '../analysis/syntax.js';
import { fingerprint } from '../analysis/values.js';
import { GmlParser } from '../parser.js';
import type { Code } from '../project.code.js';
import { Signifier } from '../signifiers.js';
import { Type } from '../types.js';
import {
  ContributionGraph,
  ContributionIndex,
  type Contribution,
} from './contributions.js';
import { LanguageProfile } from './version.js';

function contribution(
  unitId: string,
  kind: 'Real' | 'String' | 'Bool' = 'Real',
  extra = false,
): Contribution {
  const owner = Type.Struct;
  owner.semanticKey = 'shared';
  const item = new Signifier(owner, 'field', new Type(kind));
  item.semanticKey = 'shared/member:field';
  item.replaceDefinition({});
  owner.setOwnMember(item);
  const types = new Map([['shared', owner]]);
  if (extra) {
    const additional = Type.Struct;
    additional.semanticKey = `extra:${unitId}`;
    types.set(additional.semanticKey, additional);
  }
  return {
    types,
    symbols: new Map([
      [
        item.semanticKey,
        {
          key: item.semanticKey,
          owner: 'shared',
          item,
          unitId,
          exported: true,
        },
      ],
    ]),
    namedTypes: new Map([['Alias', extra ? `extra:${unitId}` : 'shared']]),
  };
}

function rebuilt(parts: ReadonlyMap<string, Contribution>): ContributionIndex {
  const index = new ContributionIndex();
  for (const [unit, part] of parts) index.replace(unit, part);
  return index;
}

function verify(
  index: ContributionIndex,
  parts: ReadonlyMap<string, Contribution>,
  source: ContributionGraph['source'] = () => undefined,
) {
  const fresh = rebuilt(parts);
  expect([...index.units.keys()].sort()).to.deep.equal(
    [...parts.keys()].sort(),
  );
  const replacement = contribution('overlay', 'Bool', true);
  const checkSources = <T>(
    actual: Map<string, Map<string, T>>,
    expected: Map<string, Map<string, T>>,
    overlay: ReadonlyMap<string, T>,
  ) => {
    expect([...actual.keys()].sort()).to.deep.equal(
      [...expected.keys()].sort(),
    );
    for (const key of new Set([
      ...expected.keys(),
      ...overlay.keys(),
      'missing',
    ])) {
      for (const excluded of [undefined, 'a', 'z', 'absent']) {
        expect(index.sources(actual, key, excluded)).to.deep.equal(
          fresh.sources(expected, key, excluded),
        );
        expect(index.sources(actual, key, excluded, overlay)).to.deep.equal(
          fresh.sources(expected, key, excluded, overlay),
        );
      }
    }
  };
  checkSources(index.types, fresh.types, replacement.types);
  checkSources(index.symbols, fresh.symbols, replacement.symbols);
  checkSources(index.names, fresh.names, replacement.namedTypes);
  for (const excluded of [undefined, 'a', 'missing']) {
    const actual = new ContributionGraph(
      index,
      source,
      excluded,
      excluded ? replacement : undefined,
    ).complete();
    const expected = new ContributionGraph(
      fresh,
      source,
      excluded,
      excluded ? replacement : undefined,
    ).complete();
    for (const key of fresh.types.keys()) {
      expect(fingerprint(actual.type(key))).to.equal(
        fingerprint(expected.type(key)),
      );
    }
    expect(actual.namedType('Alias')).to.equal(expected.namedType('Alias'));
  }
}

function evaluated(text: string) {
  const uri = 'branch.gml';
  const parsed = new GmlParser().parse(text);
  expect(parsed.errors).to.deep.equal([]);
  const syntax = normalizeSyntax({
    unitId: uri,
    text,
    cst: parsed.cst,
    origin: (start, end) => ({ spelling: { uri, start, end }, editable: true }),
  });
  const bound = bindUnit(syntax, {
    unitId: uri,
    assetId: 'branch',
    assetName: 'branch',
    kind: 'script',
    definitiveSelf: false,
    language: new LanguageProfile({ runtimeVersion: '2024.13.0.0' }),
  });
  return {
    declaration: createDeclarationSummary(bound),
    evaluation: evaluateUnit(bound, {
      lookup: () => undefined,
      type: () => undefined,
      observe: () => {},
      cancelled: () => false,
    }),
  };
}

// These fixtures exercise writable branches and actual sorted/merged outputs.
// Iterator counts bound cache work without depending on timing or GC behavior.
describe('Contribution index branches', function () {
  it('isolates writable parents, siblings and grandchildren through replacement, removal and restoration', function () {
    const p = contribution('z'),
      p2 = contribution('z', 'Bool', true);
    const q = contribution('a', 'String'),
      q2 = contribution('a', 'Bool', true);
    const r = contribution('m', 'Real', true);
    const initial = new Map([
      ['z', p],
      ['a', q],
    ]);
    const parent = rebuilt(initial),
      left = parent.fork(),
      right = parent.fork();
    const models = new Map([
      [parent, new Map(initial)],
      [left, new Map(initial)],
      [right, new Map(initial)],
    ]);
    const change = (
      branch: ContributionIndex,
      unit: string,
      next?: Contribution,
    ) => {
      branch.replace(unit, next);
      const model = models.get(branch)!;
      if (next) model.set(unit, next);
      else model.delete(unit);
      for (const [index, expected] of models) verify(index, expected);
    };
    change(parent, 'a', q2);
    change(left, 'z');
    change(right, 'm', r);
    const grandchild = right.fork();
    models.set(grandchild, new Map(models.get(right)!));
    change(right, 'z', p2);
    change(grandchild, 'z');
    change(parent, 'z');
    change(left, 'a');
    change(right, 'a');
    change(left, 'z', p);
    change(parent, 'a');
    change(parent, 'a', q);
    change(grandchild, 'missing');
  });

  it('retires excluded units and all their facts during a single unit copy pass', function () {
    const keep = contribution('keep');
    const evaluation = evaluated('function branch_fn(){return 1;}').evaluation;
    const implementation = [...evaluation.implementations.values()][0];
    const retired: Contribution = {
      ...contribution('branch.gml', 'String', true),
      implementations: evaluation.implementations,
      namedTypes: new Map([
        ['RetiredAlias', 'extra:branch.gml'],
        ['Alias', 'shared'],
      ]),
    };
    const parts = new Map([
      ['keep', keep],
      ['branch.gml', retired],
    ]);
    const parent = rebuilt(parts);
    parent.sources(parent.types, 'shared');
    const iterate = parent.units[Symbol.iterator].bind(parent.units);
    let scans = 0,
      selections = 0;
    parent.units[Symbol.iterator] = () => {
      scans++;
      return iterate();
    };
    const child = parent.fork((unit) => {
      selections++;
      return unit === 'keep';
    });
    expect(scans).to.equal(1);
    expect(selections).to.equal(parts.size);
    verify(child, new Map([['keep', keep]]));
    verify(parent, parts);
    const parentGraph = new ContributionGraph(parent, () => undefined);
    const childGraph = new ContributionGraph(child, () => undefined);
    expect(
      parentGraph.implementation('branch.gml', implementation.functionId),
    ).to.equal(implementation);
    expect(
      childGraph.implementation('branch.gml', implementation.functionId),
    ).to.equal(undefined);
    expect(childGraph.namedType('RetiredAlias')).to.equal(undefined);
    verify(
      parent.fork(() => false),
      new Map(),
    );
    verify(parent, parts);
  });

  it('shares valid ordering caches and invalidates only a genuinely changed source version', function () {
    const first = contribution('a'),
      second = contribution('z', 'String');
    const parent = rebuilt(
      new Map([
        ['z', second],
        ['a', first],
      ]),
    );
    const sources = parent.types.get('shared')!;
    const iterate = sources[Symbol.iterator].bind(sources);
    let scans = 0;
    sources[Symbol.iterator] = () => {
      scans++;
      return iterate();
    };
    const expected = [first.types.get('shared'), second.types.get('shared')];
    expect(parent.sources(parent.types, 'shared')).to.deep.equal(expected);
    const child = parent.fork(),
      sibling = parent.fork();
    child.replace('a', first);
    child.replace('a', {
      types: new Map(first.types),
      symbols: new Map(first.symbols),
      namedTypes: new Map(first.namedTypes),
    });
    for (const branch of [parent, child, sibling])
      expect(branch.sources(branch.types, 'shared')).to.deep.equal(expected);
    expect(scans).to.equal(1);
    const changed = contribution('a', 'Bool');
    child.replace('a', changed);
    // The second iteration copies the shared map, preserving its cached order.
    expect(scans).to.equal(2);
    expect(child.sources(child.types, 'shared')).to.deep.equal([
      changed.types.get('shared'),
      expected[1],
    ]);
    for (const branch of [parent, sibling])
      expect(branch.sources(branch.types, 'shared')).to.deep.equal(expected);
    expect(scans).to.equal(2);
    const childSources = child.types.get('shared')!;
    const childIterate = childSources[Symbol.iterator].bind(childSources);
    let childScans = 0;
    childSources[Symbol.iterator] = () => {
      childScans++;
      return childIterate();
    };
    child.replace('z');
    expect(child.sources(child.types, 'shared')).to.deep.equal([
      changed.types.get('shared'),
    ]);
    expect(child.sources(child.types, 'shared')).to.deep.equal([
      changed.types.get('shared'),
    ]);
    expect(childScans).to.equal(1);
    expect(parent.sources(parent.types, 'shared')).to.deep.equal(expected);
  });

  it('updates implementation-only contribution versions while retaining unchanged source maps', function () {
    const first = evaluated('function branch_fn(){return 1;}').evaluation;
    const next = evaluated('function branch_fn(){return 2;}').evaluation;
    const implementation = [...first.implementations.values()][0];
    const changedImplementation = [...next.implementations.values()][0];
    expect(implementation.fingerprint).not.to.equal(
      changedImplementation.fingerprint,
    );
    const parent = rebuilt(new Map([['branch.gml', first]]));
    const child = parent.fork();
    const changed = { ...first, implementations: next.implementations };
    child.replace('branch.gml', changed);
    expect(child.units.get('branch.gml')).to.equal(changed);
    for (const key of first.types.keys())
      expect(child.types.get(key)).to.equal(parent.types.get(key));
    expect(
      new ContributionGraph(parent, () => undefined).implementation(
        'branch.gml',
        implementation.functionId,
      )?.fingerprint,
    ).to.equal(implementation.fingerprint);
    expect(
      new ContributionGraph(child, () => undefined).implementation(
        'branch.gml',
        implementation.functionId,
      )?.fingerprint,
    ).to.equal(changedImplementation.fingerprint);
  });

  it('keeps a fixed branch overlay readable when other branches change or are discarded', function () {
    const p = contribution('z'),
      q = contribution('a', 'String');
    const model = new Map([
      ['z', p],
      ['a', q],
    ]);
    const parent = rebuilt(model),
      fixed = parent.fork();
    const replacement = contribution('z', 'Bool');
    const overlay = new ContributionGraph(
      fixed,
      () => undefined,
      'z',
      replacement,
    );
    const expected = fingerprint(overlay.type('shared'));
    parent.replace('a', contribution('a', 'Bool', true));
    model.set('a', parent.units.get('a')!);
    const discarded = parent.fork();
    discarded.replace('a');
    discarded.replace('z', contribution('z', 'String', true));
    new ContributionGraph(discarded, () => undefined).complete();
    expect(fingerprint(overlay.type('shared'))).to.equal(expected);
    expect(overlay.namedType('Alias')).to.equal('shared');
    expect(overlay.typeSources('shared')).to.deep.equal([
      q.types.get('shared'),
      replacement.types.get('shared'),
    ]);
    verify(parent, model);
    verify(
      fixed,
      new Map([
        ['z', p],
        ['a', q],
      ]),
    );
  });

  it('indexes real declaration and evaluation versions without mutating retained payloads', function () {
    const text = 'function provider(){return {field:1};} var item=provider();';
    const { declaration, evaluation } = evaluated(text);
    const file = { path: { absolute: 'branch.gml' } } as unknown as Code;
    const source: ContributionGraph['source'] = (uri) =>
      uri === file.path.absolute ? { file, text } : undefined;
    const payload = (part: Contribution) => ({
      types: [...part.types].map(([key, type]) => [key, fingerprint(type)]),
      symbols: [...part.symbols].map(([key, symbol]) => [
        key,
        fingerprint(symbol.item.type),
      ]),
      names: [...part.namedTypes],
    });
    const before = [payload(declaration), payload(evaluation)];
    const parent = rebuilt(new Map([['branch.gml', declaration]]));
    const child = parent.fork();
    child.replace('branch.gml', evaluation);
    verify(parent, new Map([['branch.gml', declaration]]), source);
    verify(child, new Map([['branch.gml', evaluation]]), source);
    expect([payload(declaration), payload(evaluation)]).to.deep.equal(before);
  });
});
