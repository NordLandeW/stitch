import { expect } from 'chai';
import { Type } from '../types.js';
import { ContributionGraph, ContributionIndex } from './contributions.js';
import { Signifier } from '../signifiers.js';
import type { Code } from '../project.code.js';
import { fingerprint, value } from '../analysis/values.js';
import type { Contribution } from './contributions.js';
import { copyPreparedSymbol } from '../analysis/materialization.js';

// A reference-heavy unit repeatedly asks for the same merged source set.
// Bound the input scans, while checking ordering, exclusion and replacement.
describe('Contribution source lookup work', function () {
  it('reuses ordered sources until their owning contributions change', function () {
    const index = new ContributionIndex();
    const values = [Type.Real, Type.String, Type.Bool];
    const replace = (unit: string, type?: Type) =>
      index.replace(
        unit,
        type && {
          symbols: new Map(),
          types: new Map([['shared', type]]),
          namedTypes: new Map(),
        },
      );
    replace('second', values[1]);
    replace('first', values[0]);
    const sources = index.types.get('shared')!;
    const iterate = sources[Symbol.iterator].bind(sources);
    let scans = 0;
    sources[Symbol.iterator] = () => {
      scans++;
      return iterate();
    };
    for (let query = 0; query < 16; query++) {
      expect(index.sources(index.types, 'shared')).to.deep.equal(
        values.slice(0, 2),
      );
      expect(
        index.sources(
          index.types,
          'shared',
          'first',
          new Map([['shared', values[2]]]),
        ),
      ).to.deep.equal([values[1], values[2]]);
    }
    expect(scans).to.equal(1);
    replace('first', values[2]);
    expect(index.sources(index.types, 'shared')).to.deep.equal([
      values[2],
      values[1],
    ]);
    expect(scans).to.equal(2);
    replace('second');
    expect(index.sources(index.types, 'shared')).to.deep.equal([values[2]]);
    replace('first');
    expect(index.sources(index.types, 'shared')).to.deep.equal([]);
    replace('new', values[0]);
    expect(index.sources(index.types, 'shared')).to.deep.equal([values[0]]);
  });

  it('reads each source set once within a detached graph and refreshes for the next graph', function () {
    const index = new ContributionIndex();
    const first = Type.Real,
      second = Type.String;
    const part = (type: Type) => ({
      symbols: new Map(),
      types: new Map([['shared', type]]),
      namedTypes: new Map([['Alias', 'shared']]),
    });
    index.replace('owner', part(first));
    const read = index.sources.bind(index);
    let queries = 0;
    index.sources = function <T>(
      entries: Map<string, Map<string, T>>,
      key: string,
      excluded?: string,
      replacement?: ReadonlyMap<string, T>,
    ): T[] {
      queries++;
      return read(entries, key, excluded, replacement);
    };
    const graph = new ContributionGraph(
      index,
      () => undefined,
      'owner',
      part(second),
    );
    for (let query = 0; query < 16; query++) {
      expect(graph.typeSources('shared')).to.deep.equal([second]);
      expect(graph.namedType('Alias')).to.equal('shared');
      expect(graph.hasSymbol('missing')).to.equal(false);
    }
    expect(queries).to.equal(3);
    index.replace('owner', part(second));
    expect(
      new ContributionGraph(index, () => undefined).typeSources('shared'),
    ).to.deep.equal([second]);
  });

  it('refreshes private publication children without traversing unchanged parent shapes', function () {
    const root = Type.Struct;
    root.semanticKey = 'root';
    const makePart = (
      owner: Type,
      entries: Signifier[],
      unitId: string,
    ): Contribution => ({
      types: new Map([[owner.semanticKey!, owner]]),
      namedTypes: new Map(),
      symbols: new Map(
        entries.map((item) => {
          item.semanticKey = `${owner.semanticKey}/${item.name}`;
          owner.setOwnMember(item);
          return [
            item.semanticKey,
            {
              key: item.semanticKey,
              owner: owner.semanticKey!,
              item,
              unitId,
              exported: true,
            },
          ];
        }),
      ),
    });
    const leaf = (type?: Type): Contribution => {
      const owner = Type.Struct;
      owner.semanticKey = 'child';
      return makePart(
        owner,
        [
          new Signifier(owner, 'back', root),
          ...(type ? [new Signifier(owner, 'payload', type)] : []),
        ],
        'leaf',
      );
    };
    const firstLeaf = leaf(Type.Real);
    const base = makePart(
      root,
      [new Signifier(root, 'nested', firstLeaf.types.get('child')!)],
      'base',
    );
    const index = (part: Contribution) => {
      const result = new ContributionIndex();
      result.replace('base', base);
      result.replace('leaf', part);
      return result;
    };
    const firstIndex = index(firstLeaf);
    const publicCopy = new ContributionGraph(
      firstIndex,
      () => undefined,
    ).complete();
    const list = root.listMembers.bind(root);
    let reads = 0;
    root.listMembers = (...args) => {
      reads++;
      return list(...args);
    };
    const first = ContributionGraph.prepare(firstIndex, () => undefined);
    expect(reads).to.equal(1);
    const nextIndex = index(leaf(Type.String));
    const next = ContributionGraph.prepare(nextIndex, () => undefined, first);
    expect(reads).to.equal(1);
    const payload = (graph: ContributionGraph) =>
      graph
        .type('root')
        .getMember('nested')!
        .getTypeByKind('Struct')!
        .getMember('payload')?.type.kind;
    expect(payload(next)).to.equal('String');
    expect(payload(publicCopy)).to.equal('Real');
    expect(fingerprint(next.type('root'))).to.equal(
      fingerprint(
        new ContributionGraph(nextIndex, () => undefined)
          .complete()
          .type('root'),
      ),
    );
    const removedIndex = index(leaf());
    const removed = ContributionGraph.prepare(
      removedIndex,
      () => undefined,
      next,
    );
    expect(payload(removed)).to.equal(undefined);
    expect(payload(publicCopy)).to.equal('Real');
    expect(fingerprint(removed.type('root'))).to.equal(
      fingerprint(
        new ContributionGraph(removedIndex, () => undefined)
          .complete()
          .type('root'),
      ),
    );
  });

  it('rebuilds private publication handles when a stable key changes value kind', function () {
    const input = (type: Type) => {
      type.semanticKey = 'slot';
      const index = new ContributionIndex();
      index.replace('unit', {
        types: new Map([['slot', type]]),
        symbols: new Map(),
        namedTypes: new Map(),
      });
      return index;
    };
    const first = ContributionGraph.prepare(input(Type.Real), () => undefined);
    const next = ContributionGraph.prepare(
      input(Type.Struct),
      () => undefined,
      first,
    );
    expect(first.type('slot').kind).to.equal('Real');
    expect(next.type('slot').kind).to.equal('Struct');
  });

  it('refreshes definition positions when their document changes without a new contribution', function () {
    const uri = 'location.gml';
    let text = 'abcd';
    const file = { path: { absolute: uri } } as unknown as Code;
    const source = () => ({ file, text });
    const owner = Type.Struct;
    owner.semanticKey = 'root';
    const item = new Signifier(owner, 'field', Type.Real);
    item.semanticKey = 'field';
    item.replaceDefinition({});
    owner.setOwnMember(item);
    const part: Contribution = {
      types: new Map([['root', owner]]),
      namedTypes: new Map(),
      symbols: new Map([
        [
          'field',
          {
            key: 'field',
            owner: 'root',
            item,
            unitId: 'owner',
            exported: true,
            origin: { spelling: { uri, start: 2, end: 3 }, editable: true },
          },
        ],
      ]),
    };
    const index = () => {
      const result = new ContributionIndex();
      result.replace('owner', part);
      return result;
    };
    const first = ContributionGraph.prepare(index(), source);
    const firstDefinition = first.symbol('field').def;
    if (!firstDefinition?.file) throw new Error('Expected a source definition');
    expect(firstDefinition.start.line).to.equal(1);
    text = 'a\ncd';
    const next = ContributionGraph.prepare(
      index(),
      source,
      first,
      new Set([uri]),
    );
    const nextDefinition = next.symbol('field').def;
    if (!nextDefinition?.file) throw new Error('Expected a source definition');
    expect(nextDefinition.start.line).to.equal(2);
    expect(nextDefinition.start.column).to.equal(1);
  });

  it('copies prepared declaration priority and normalized unions to stable public symbols', function () {
    const index = new ContributionIndex();
    const add = (
      unitId: string,
      type: Type,
      description: string,
      definitive: boolean,
    ) => {
      const owner = Type.Struct;
      owner.semanticKey = 'owner';
      const item = new Signifier(owner, 'member', type);
      item.semanticKey = 'member';
      item.describe(description);
      item.definitive = definitive;
      item.replaceDefinition({});
      owner.setOwnMember(item);
      index.replace(unitId, {
        types: new Map([['owner', owner]]),
        namedTypes: new Map(),
        symbols: new Map([
          [
            'member',
            { key: 'member', owner: 'owner', item, unitId, exported: true },
          ],
        ]),
      });
    };
    add('z', Type.Real, 'preferred declaration', true);
    add('a', Type.String, 'fallback declaration', false);
    const staged = new ContributionGraph(index, () => undefined).complete();
    const owner = Type.Struct,
      target = new Signifier(owner, 'member');
    const host = {
      source: () => undefined,
      hasSymbol: () => true,
      type: () => owner,
      symbol: () => target,
      value: (source: Type) => source.deriveDetached(),
    };
    copyPreparedSymbol(staged.symbol('member'), target, host);
    expect(target.parent).to.equal(owner);
    expect(target.description).to.equal('preferred declaration');
    expect(target.type.type.map((type) => type.kind).sort()).to.deep.equal([
      'Real',
      'String',
    ]);
    expect(
      target.type.type.every(
        (type) => !staged.symbol('member').type.type.includes(type),
      ),
    ).to.equal(true);
    index.replace('z');
    const next = new ContributionGraph(index, () => undefined).complete();
    copyPreparedSymbol(next.symbol('member'), target, host);
    expect(target.description).to.equal('fallback declaration');
    expect(target.type.kind).to.equal('String');
    copyPreparedSymbol(undefined, target, host);
    expect(target.def).to.equal(undefined);
    expect(target.type.hasTypes).to.equal(false);
  });
});

describe('Incremental publication domains', function () {
  function contribution(
    unitId: string,
    types: Type[],
    members: Signifier[] = [],
  ): Contribution {
    return {
      types: new Map(types.map((type) => [type.semanticKey!, type])),
      namedTypes: new Map(),
      symbols: new Map(
        members.map((item) => {
          item.semanticKey ||= `${item.parent.semanticKey}/member:${item.name}`;
          return [
            item.semanticKey,
            {
              key: item.semanticKey,
              owner: item.parent.semanticKey!,
              item,
              unitId,
              exported: true,
            },
          ];
        }),
      ),
    };
  }

  it('transfers completed private domains without enumerating unchanged handle maps', function () {
    const roots = Array.from({ length: 128 }, (_, index) => {
      const type = Type.Struct;
      type.semanticKey = `stable:${index}`;
      return type;
    });
    const fields = roots.map((owner) => {
      const field = new Signifier(owner, 'field', Type.Real);
      owner.setOwnMember(field);
      return field;
    });
    const stable = contribution('stable', roots, fields);
    const changed = (kind: 'Real' | 'String') => {
      const root = Type.Struct;
      root.semanticKey = 'changing';
      const field = new Signifier(root, 'field', new Type(kind));
      root.setOwnMember(field);
      return contribution('changing', [root], [field]);
    };
    const index = (part?: Contribution) => {
      const current = new ContributionIndex();
      current.replace('stable', stable);
      if (part) current.replace('changing', part);
      return current;
    };
    let previous = ContributionGraph.prepare(
      index(changed('Real')),
      () => undefined,
    );
    const stableType = previous.type('stable:0');
    const stableSymbol = previous.symbol('stable:0/member:field');
    let handleEnumerations = 0;
    const observeHandles = <T>(handles: Map<string, T>) => {
      const iterate = handles[Symbol.iterator].bind(handles);
      handles[Symbol.iterator] = () => {
        handleEnumerations++;
        return iterate();
      };
    };
    observeHandles(previous.types);
    observeHandles(previous.symbols);
    for (const part of [changed('String'), undefined, changed('Real')]) {
      const current = index(part);
      const next = ContributionGraph.prepare(
        current,
        () => undefined,
        previous,
      );
      expect(next.publicationReused).to.equal(true);
      expect(handleEnumerations).to.equal(0);
      expect(next.type('stable:0')).to.equal(stableType);
      expect(next.symbol('stable:0/member:field')).to.equal(stableSymbol);
      expect([...next.types.keys()]).to.deep.equal([
        ...roots.map((root) => root.semanticKey!),
        ...(part ? ['changing'] : []),
      ]);
      expect(next.types.has('changing')).to.equal(!!part);
      expect(next.symbols.has('changing/member:field')).to.equal(!!part);
      if (part) {
        const cold = new ContributionGraph(current, () => undefined).complete();
        expect(fingerprint(next.type('changing'))).to.equal(
          fingerprint(cold.type('changing')),
        );
        expect(next.symbol('changing/member:field').parent).to.equal(
          next.type('changing'),
        );
      }
      previous = next;
    }
  });

  it('remaps a prepared domain with equal size but different named and queried keys', function () {
    const alias = Type.Struct,
      target = Type.Struct;
    alias.semanticKey = 'Alias';
    target.semanticKey = 'target';
    const part: Contribution = {
      ...contribution('unit', [alias, target]),
      namedTypes: new Map([['Alias', 'target']]),
    };
    const index = new ContributionIndex();
    index.replace('unit', part);
    const previous = ContributionGraph.prepare(index, () => undefined);
    previous.type('missing');
    expect(previous.types.size).to.equal(index.types.size);
    expect([...previous.types.keys()]).to.deep.equal(['target', 'missing']);
    const current = index.fork();
    const next = ContributionGraph.prepare(current, () => undefined, previous);
    expect(next.publicationReused).to.equal(false);
    expect([...next.types.keys()]).to.deep.equal(['target']);
    expect(fingerprint(next.type('Alias'))).to.equal(
      fingerprint(
        new ContributionGraph(current, () => undefined)
          .complete()
          .type('Alias'),
      ),
    );
    expect(previous.types.has('missing')).to.equal(true);
  });

  for (const domain of ['allocation', 'placeholder']) {
    it(`keeps unrelated private graph work when a local ${domain} appears and disappears`, function () {
      const root = Type.Struct;
      root.semanticKey = 'stable';
      const field = new Signifier(root, 'field', Type.String);
      root.setOwnMember(field);
      const stable = contribution('stable', [root], [field]);
      const allocation = Type.Struct;
      allocation.semanticKey = 'allocation:local:0';
      const placeholder = new Signifier(root, 'missing', Type.Any);
      const changed = contribution(
        'edit',
        domain === 'allocation' ? [allocation] : [],
        domain === 'placeholder' ? [placeholder] : [],
      );
      const index = (part?: Contribution) => {
        const current = new ContributionIndex();
        current.replace('stable', stable);
        if (part) current.replace('edit', part);
        return current;
      };
      const publicCopy = new ContributionGraph(
        index(),
        () => undefined,
      ).complete();
      const first = ContributionGraph.prepare(index(), () => undefined);
      const handle = first.type('stable');
      const list = root.listMembers.bind(root);
      let reads = 0;
      root.listMembers = (...args) => {
        reads++;
        return list(...args);
      };
      const added = ContributionGraph.prepare(
        index(changed),
        () => undefined,
        first,
      );
      expect(reads).to.equal(0);
      expect(added.type('stable')).to.equal(handle);
      expect(added.type('stable').getMember('missing')).to.equal(undefined);
      expect(added.types.has(allocation.semanticKey)).to.equal(
        domain === 'allocation',
      );
      expect(added.symbols.has(placeholder.semanticKey!)).to.equal(
        domain === 'placeholder',
      );
      const removed = ContributionGraph.prepare(
        index(),
        () => undefined,
        added,
      );
      expect(reads).to.equal(0);
      expect(removed.type('stable')).to.equal(handle);
      expect(removed.types.has(allocation.semanticKey)).to.equal(false);
      expect(removed.symbols.has(placeholder.semanticKey!)).to.equal(false);
      expect(fingerprint(removed.type('stable'))).to.equal(
        fingerprint(publicCopy.type('stable')),
      );
      expect(publicCopy.type('stable')).not.to.equal(handle);
    });
  }

  it('refreshes shared anonymous cycles when keyed targets and borrowed members appear or retire', function () {
    const left = Type.Struct,
      right = Type.Struct,
      target = Type.Struct;
    left.semanticKey = 'left';
    right.semanticKey = 'right';
    target.semanticKey = 'target';
    const a = new Type('Array'),
      b = Type.Struct;
    a.items = value(b, target);
    b.items = value(a);
    left.items = value(a);
    right.items = value(b);
    const link = new Signifier(b, 'link', target);
    b.setOwnMember(link);
    const field = new Signifier(target, 'field', Type.String);
    target.setOwnMember(field);
    const roots = contribution('roots', [left, right]);
    const owner = contribution('owner', [target]);
    const member = contribution('member', [], [field]);
    const index = (hasOwner: boolean, hasMember: boolean) => {
      const current = new ContributionIndex();
      current.replace('roots', roots);
      if (hasOwner) current.replace('owner', owner);
      if (hasMember) current.replace('member', member);
      return current;
    };
    let previous: ContributionGraph | undefined;
    for (const [hasOwner, hasMember] of [
      [false, false],
      [true, true],
      [true, false],
      [false, false],
      [true, true],
    ]) {
      const currentIndex = index(hasOwner, hasMember);
      const graph = ContributionGraph.prepare(
        currentIndex,
        () => undefined,
        previous,
      );
      const first = graph.type('left').items!.type[0];
      const second = graph.type('right').items!.type[0];
      expect(first.items!.type[0]).to.equal(second);
      expect(second.items!.type[0]).to.equal(first);
      const leaf = second.getMember('link')!.getTypeByKind('Struct')!;
      expect(leaf.getMember('field')?.type.kind).to.equal(
        hasMember ? 'String' : undefined,
      );
      if (hasOwner) expect(leaf).to.equal(graph.type('target'));
      else expect(graph.types.has('target')).to.equal(false);
      const cold = new ContributionGraph(
        currentIndex,
        () => undefined,
      ).complete();
      expect(fingerprint(graph.type('left'))).to.equal(
        fingerprint(cold.type('left')),
      );
      expect(fingerprint(graph.type('right'))).to.equal(
        fingerprint(cold.type('right')),
      );
      previous = graph;
    }
  });

  it('retires replaced anonymous lookup paths while keeping the current missing-target dependency', function () {
    const placeholder = (key: string) => {
      const type = Type.Struct;
      type.semanticKey = key;
      return type;
    };
    const firstTarget = placeholder('first-target');
    const secondTarget = placeholder('second-target');
    const roots = (target: Type) => {
      const root = placeholder('root');
      const anonymous = Type.Struct;
      anonymous.items = value(target);
      root.items = value(anonymous);
      return contribution('roots', [root]);
    };
    const first = roots(firstTarget),
      second = roots(secondTarget);
    const owner = (target: Type) => {
      const type = placeholder(target.semanticKey!);
      const member = new Signifier(type, 'payload', Type.String);
      type.setOwnMember(member);
      return contribution('owner', [type], [member]);
    };
    const index = (root: Contribution, provided?: Contribution) => {
      const result = new ContributionIndex();
      result.replace('roots', root);
      if (provided) result.replace('owner', provided);
      return result;
    };
    let previous = ContributionGraph.prepare(index(first), () => undefined);
    previous = ContributionGraph.prepare(
      index(second),
      () => undefined,
      previous,
    );
    const source = second.types.get('root')!;
    const list = source.listMembers.bind(source);
    let reads = 0;
    source.listMembers = (...args) => {
      reads++;
      return list(...args);
    };
    previous = ContributionGraph.prepare(
      index(second, owner(firstTarget)),
      () => undefined,
      previous,
    );
    expect(reads).to.equal(0);
    for (const provided of [
      owner(secondTarget),
      undefined,
      owner(secondTarget),
    ]) {
      const currentIndex = index(second, provided);
      const next = ContributionGraph.prepare(
        currentIndex,
        () => undefined,
        previous,
      );
      const target = next.type('root').items!.type[0].items!.type[0];
      expect(target.getMember('payload')?.type.kind).to.equal(
        provided ? 'String' : undefined,
      );
      const cold = new ContributionGraph(
        currentIndex,
        () => undefined,
      ).complete();
      expect(fingerprint(next.type('root'))).to.equal(
        fingerprint(cold.type('root')),
      );
      previous = next;
    }
  });

  it('refreshes detached queries and returning owners after the last root of a shared cycle retires', function () {
    const root = Type.Struct,
      a = Type.Struct,
      b = Type.Struct;
    const placeholder = Type.Struct,
      provider = Type.Struct;
    root.semanticKey = 'root';
    placeholder.semanticKey = provider.semanticKey = 'target';
    root.items = value(a);
    a.items = value(b);
    b.items = value(a);
    b.returns = value(placeholder);
    const payload = new Signifier(provider, 'payload', Type.String);
    provider.setOwnMember(payload);
    const roots = contribution('roots', [root]);
    const owner = contribution('owner', [provider], [payload]);
    let previous: ContributionGraph | undefined;
    for (const [hasRoot, hasOwner, queryAfter] of [
      [true, false, false],
      [false, false, true],
      [false, true, true],
      [true, true, false],
      [false, false, true],
      [true, false, false],
    ]) {
      const index = new ContributionIndex();
      if (hasRoot) index.replace('roots', roots);
      if (hasOwner) index.replace('owner', owner);
      const next = ContributionGraph.prepare(index, () => undefined, previous);
      const cold = new ContributionGraph(index, () => undefined).complete();
      if (hasRoot) {
        const leaf =
          next.type('root').items!.type[0].items!.type[0].returns!.type[0];
        expect(leaf.getMember('payload')?.type.kind).to.equal(
          hasOwner ? 'String' : undefined,
        );
        expect(fingerprint(next.type('root'))).to.equal(
          fingerprint(cold.type('root')),
        );
      }
      if (queryAfter)
        expect(fingerprint(next.value(a))).to.equal(fingerprint(cold.value(a)));
      previous = next;
    }
  });

  it('refreshes enum readers when the current declaration selects a new surviving type key', function () {
    const root = Type.Struct,
      globals = Type.Struct;
    root.semanticKey = 'root';
    globals.semanticKey = 'globals';
    const enumeration = (key: string) => {
      const declaration = new Signifier(globals, 'Enum');
      declaration.semanticKey = 'enum-declaration';
      const type = new Type('Enum').named('Enum');
      type.semanticKey = key;
      type.signifier = declaration;
      declaration.setType(type);
      return { type, declaration };
    };
    const first = enumeration('enum:first'),
      second = enumeration('enum:second');
    root.items = value(first.type);
    const retained = contribution('retained', [root, first.type]);
    const index = (entry: typeof first) => {
      const current = new ContributionIndex();
      current.replace('retained', retained);
      current.replace(
        'declaration',
        contribution('declaration', [globals, entry.type], [entry.declaration]),
      );
      return current;
    };
    const old = ContributionGraph.prepare(index(first), () => undefined);
    const currentIndex = index(second);
    const next = ContributionGraph.prepare(currentIndex, () => undefined, old);
    expect(next.type('root').items!.type[0]).to.equal(
      next.symbol('enum-declaration').getTypeByKind('Enum'),
    );
    expect(next.type('root').items!.type[0].semanticKey).to.equal(
      'enum:second',
    );
    expect(fingerprint(next.type('root'))).to.equal(
      fingerprint(
        new ContributionGraph(currentIndex, () => undefined)
          .complete()
          .type('root'),
      ),
    );
  });

  it('remaps a surviving symbol when its owner changes without mutating the old graph', function () {
    const first = Type.Struct,
      second = Type.Struct;
    first.semanticKey = 'first';
    second.semanticKey = 'second';
    const index = (owner: Type) => {
      const field = new Signifier(owner, 'field', Type.String);
      field.semanticKey = 'field';
      const current = new ContributionIndex();
      current.replace('unit', contribution('unit', [first, second], [field]));
      return current;
    };
    const before = ContributionGraph.prepare(index(first), () => undefined);
    const after = ContributionGraph.prepare(
      index(second),
      () => undefined,
      before,
    );
    expect(before.symbol('field').parent.semanticKey).to.equal('first');
    expect(after.symbol('field').parent).to.equal(after.type('second'));
    expect(after.symbol('field')).not.to.equal(before.symbol('field'));
  });

  it('retains a shared anonymous union alternative when only one keyed owner changes', function () {
    const shared = Type.Struct;
    shared.items = value(shared);
    const stable = Type.Struct;
    stable.semanticKey = 'stable';
    stable.items = value(shared);
    const retained = contribution('stable', [stable]);
    const index = (description: string) => {
      const changed = Type.Struct;
      changed.semanticKey = 'changed';
      changed.description = description;
      changed.items = value(shared);
      const current = new ContributionIndex();
      current.replace('stable', retained);
      current.replace('changed', contribution('changed', [changed]));
      return current;
    };
    const before = ContributionGraph.prepare(index('before'), () => undefined);
    const after = ContributionGraph.prepare(
      index('after'),
      () => undefined,
      before,
    );
    const left = after.type('stable').items!,
      right = after.type('changed').items!;
    expect(value(left, right).type).to.have.length(1);
    expect(left.type[0]).to.equal(right.type[0]);
    expect(right.type[0].items!.type[0]).to.equal(right.type[0]);
  });
});
