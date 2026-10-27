import { assert } from 'chai';
import { globalKey, globalOwner, memberKey } from '../analysis/model.js';
import { bindUnit } from '../analysis/binding.js';
import { evaluateUnit } from '../analysis/evaluation.js';
import { normalizeSyntax } from '../analysis/syntax.js';
import { fingerprint, valueFrom } from '../analysis/values.js';
import { GmlParser } from '../parser.js';
import { LanguageProfile } from './version.js';
import { Signifier } from '../signifiers.js';
import { Type, TypeStore } from '../types.js';
import {
  collectInputContribution,
  ContributionGraph,
  ContributionIndex,
} from './contributions.js';

const globalCount = 256;

/** No Code, project, source documents, or filesystem are needed for lookup. */
function globalsFixture() {
  const root = new Type('Struct');
  const globals = Array.from({ length: globalCount }, (_, index) => {
    const name = `global_${index}`;
    const returns = new Type('Real');
    const type = new Type('Function').named(name);
    type.callKind = 'native';
    type.setReturnType(returns);
    const symbol = new Signifier(root, name, type);
    symbol.global = true;
    symbol.native = 'Base';
    symbol.writable = false;
    symbol.replaceDefinition({});
    type.signifier = symbol;
    root.setOwnMember(symbol);
    return { name, type, returns };
  });
  const input = collectInputContribution(
    '$fixture',
    new Map([[globalOwner, root]]),
  );
  const index = new ContributionIndex();
  index.replace('$fixture', input);
  return {
    graph: new ContributionGraph(index, () => undefined),
    index,
    globals,
  };
}

describe('Contribution graph lookup allocation', function () {
  it('does not materialize unrelated symbols or types for a missing global', function () {
    const { graph, index } = globalsFixture();
    assert.equal(index.symbols.size, globalCount);
    assert.equal(index.types.size, 1 + globalCount * 2);
    assert.equal(graph.symbols.size, 0);
    assert.equal(graph.types.size, 0);

    assert.isUndefined(graph.lookup(globalOwner, 'missing_global'));

    // Count allocations rather than relying on machine-dependent timing.
    assert.equal(graph.symbols.size, 0);
    assert.equal(graph.types.size, 0);
  });

  it('materializes an existing global without allocating its unrelated peers', function () {
    const { graph, globals } = globalsFixture();
    const selected = globals[128];
    const found = graph.lookup(globalOwner, selected.name);
    assert.isDefined(found);
    assert.equal(found!.key, globalKey(selected.name));
    assert.equal(found!.item.name, selected.name);
    assert.strictEqual(found!.item, graph.symbols.get(found!.key));
    const type = found!.item.getTypeByKind('Function');
    assert.isDefined(type);
    assert.strictEqual(type, graph.types.get(selected.type.semanticKey!));
    assert.deepEqual(
      type!.returns!.type.map((entry) => entry.kind),
      ['Real'],
    );
    assert.strictEqual(
      type!.returns!.type[0],
      graph.types.get(selected.returns.semanticKey!),
    );
    assert.sameMembers([...graph.symbols.keys()], [globalKey(selected.name)]);
    assert.sameMembers(
      [...graph.types.keys()],
      [globalOwner, selected.type.semanticKey!, selected.returns.semanticKey!],
    );

    const symbols = [...graph.symbols.keys()];
    const types = [...graph.types.keys()];
    assert.isUndefined(graph.lookup(globalOwner, 'another_missing_global'));
    assert.deepEqual([...graph.symbols.keys()], symbols);
    assert.deepEqual([...graph.types.keys()], types);
  });

  it('withdraws borrowed members when their owning unit is excluded or retired and restores current values', function () {
    const owner = 'struct:fixture';
    const root = Type.Struct;
    root.semanticKey = owner;
    const field = new Signifier(root, 'field', Type.Real);
    field.replaceDefinition({});
    root.setOwnMember(field);
    const original = collectInputContribution(
      'provider',
      new Map([[owner, root]]),
    );
    const index = new ContributionIndex();
    index.replace('provider', original);
    // A consumer can retain a type view without owning its imported symbols.
    index.replace('consumer', {
      symbols: new Map(),
      types: new Map([[owner, root]]),
      namedTypes: new Map(),
    });
    assert.isDefined(
      new ContributionGraph(index, () => undefined)
        .type(owner)
        .getMember('field'),
    );
    const replacement = {
      symbols: new Map(),
      types: new Map(),
      namedTypes: new Map(),
    };
    const duringUpdate = new ContributionGraph(
      index,
      () => undefined,
      'provider',
      replacement,
    );
    assert.isUndefined(duringUpdate.type(owner).getMember('field'));
    index.replace('provider');
    const retired = new ContributionGraph(index, () => undefined).complete();
    assert.isUndefined(retired.type(owner).getMember('field'));
    assert.isFalse(retired.hasSymbol(field.semanticKey!));
    const nextRoot = Type.Struct;
    nextRoot.semanticKey = owner;
    const nextField = new Signifier(nextRoot, 'field', Type.String);
    nextField.replaceDefinition({});
    nextRoot.setOwnMember(nextField);
    index.replace(
      'provider',
      collectInputContribution('provider', new Map([[owner, nextRoot]])),
    );
    const restored = new ContributionGraph(index, () => undefined).complete();
    assert.deepEqual(
      restored
        .type(owner)
        .getMember('field')!
        .type.type.map((type) => type.kind),
      ['String'],
    );
  });
});

describe('Contribution graph wide values', function () {
  function wide() {
    const first = Type.Real;
    first.literalValue = 1;
    const last = Type.Real;
    last.literalValue = 2;
    const text = Type.String;
    const store = new TypeStore();
    store.type = Array<Type>(200000).fill(first).concat(last, text);
    return { store, first, last, text };
  }
  function assertUnion(store: TypeStore) {
    assert.deepEqual(
      store.type.map((type) => type.kind),
      ['Real', 'String'],
    );
    assert.isUndefined(
      store.type[0].literalValue,
      'distinct numeric literals widen',
    );
  }

  it('materializes wide item and return unions with bounded source mapping', function () {
    for (const field of ['items', 'returns'] as const) {
      const input = wide();
      const source = new Type(field === 'items' ? 'Array' : 'Function');
      source[field] = input.store;
      const graph = new ContributionGraph(
        new ContributionIndex(),
        () => undefined,
      );
      const map = graph.value.bind(graph);
      let leafVisits = 0;
      graph.value = (type) => {
        if (
          type === input.first ||
          type === input.last ||
          type === input.text
        ) {
          assert.isAtMost(
            ++leafVisits,
            3,
            'duplicate union slots must not remap a source object',
          );
        }
        return map(type);
      };
      const result = graph.value(source);
      assertUnion(result[field]!);
      assert.equal(leafVisits, 3);
      assert.equal(
        input.store.type.length,
        200002,
        'input unions remain unchanged',
      );
      assert.equal(input.first.literalValue, 1);
      assert.equal(input.last.literalValue, 2);
    }
  });

  it('materializes wide anonymous member and indexed symbol unions without dropping the tail', function () {
    const input = wide();
    const owner = Type.Struct;
    const member = new Signifier(owner, 'field');
    member.type = input.store;
    member.replaceDefinition({});
    owner.setOwnMember(member);
    const anonymous = new ContributionGraph(
      new ContributionIndex(),
      () => undefined,
    );
    assertUnion(anonymous.value(owner).getMember('field')!.type);

    owner.semanticKey = globalOwner;
    member.semanticKey = globalKey(member.name);
    const index = new ContributionIndex();
    index.replace('fixture', {
      types: new Map([[globalOwner, owner]]),
      symbols: new Map([
        [
          member.semanticKey,
          {
            key: member.semanticKey,
            item: member,
            owner: globalOwner,
            unitId: 'fixture',
            exported: true,
          },
        ],
      ]),
      namedTypes: new Map(),
    });
    const graph = new ContributionGraph(index, () => undefined);
    assertUnion(graph.symbol(member.semanticKey).type);
    assert.strictEqual(
      graph.type(globalOwner).getMember('field'),
      graph.symbol(member.semanticKey),
    );
  });

  it('keeps distinct allocation sites and cyclic aliases while normalizing repeated source slots', function () {
    const first = Type.Struct,
      second = Type.Struct;
    const source = new Type('Array');
    source.items = new TypeStore();
    source.items.type = [first, first, second, source];
    const graph = new ContributionGraph(
      new ContributionIndex(),
      () => undefined,
    );
    const result = graph.value(source);
    const items = result.items!.type;
    assert.lengthOf(items, 3);
    assert.strictEqual(items[0], graph.value(first));
    assert.strictEqual(items[1], graph.value(second));
    assert.notStrictEqual(items[0], items[1]);
    assert.strictEqual(items[2], result);
  });
});

describe('Contribution graph enum declaration identity', function () {
  function enumeration(name: string, numericValue = 1) {
    const root = Type.Struct;
    const type = new Type('Enum').named(name);
    const declaration = new Signifier(root, name, type);
    declaration.semanticKey = globalKey(name);
    declaration.enum = true;
    declaration.replaceDefinition({});
    type.semanticKey = `enum:${declaration.semanticKey}`;
    type.signifier = declaration;
    root.setOwnMember(declaration);
    const member = new Signifier(type, 'same');
    member.semanticKey = memberKey(type.semanticKey, member.name);
    member.enumMember = true;
    member.replaceDefinition({});
    const current = new Type('EnumMember').named(member.name);
    current.semanticKey = `enum-member:${member.semanticKey}`;
    current.literalValue = numericValue;
    current.signifier = member;
    member.setType(current);
    type.setOwnMember(member);
    const contribution = collectInputContribution(
      `declaration:${name}`,
      new Map([[globalOwner, root]]),
      new Map([[`Enum.${name}`, type]]),
    );
    return { type, member, current, contribution };
  }

  it('indexes evaluated enum members as canonical declaration values', function () {
    const text = 'enum First { same = 1 }';
    const uri = 'enum-identity.gml';
    const parsed = new GmlParser().parse(text);
    assert.isEmpty(parsed.errors);
    const syntax = normalizeSyntax({
      unitId: uri,
      text,
      cst: parsed.cst,
      origin: (start, end) => ({
        spelling: { uri, start, end },
        editable: true,
      }),
    });
    const bound = bindUnit(syntax, {
      unitId: uri,
      assetId: 'fixture',
      assetName: 'fixture',
      kind: 'script',
      definitiveSelf: false,
      language: new LanguageProfile({ runtimeVersion: '2024.13.0.0' }),
    });
    const result = evaluateUnit(bound, {
      lookup: () => undefined,
      type: () => undefined,
      observe: () => {},
      cancelled: () => false,
    });
    const enumeration = result.symbols.get(globalKey('First'))!.item.type
      .type[0];
    const current = enumeration.getMember('same')!.type.type[0];
    assert.equal(current.kind, 'EnumMember');
    assert.equal(current.literalValue, 1);
    assert.isString(current.semanticKey);
    assert.strictEqual(result.types.get(current.semanticKey!), current);
  });

  it('bounds repeated cross-unit contributions by enum declarations and resolves current literals', function () {
    const first = enumeration('First'),
      second = enumeration('Second');
    const index = new ContributionIndex();
    index.replace('declaration:First', first.contribution);
    index.replace('declaration:Second', second.contribution);
    const containerKey = 'native:container:items';
    for (let generation = 0; generation < 8; generation++) {
      for (const unit of ['consumer-a', 'consumer-b']) {
        const imported =
          new ContributionGraph(index, () => undefined).type(containerKey).items
            ?.type || [];
        const owned = new Type('Id.DsMap');
        owned.semanticKey = containerKey;
        owned.items = valueFrom([
          ...imported.map((type) => type.deriveDetached()),
          first.current.deriveDetached(),
          second.current.deriveDetached(),
        ]);
        index.replace(unit, {
          types: new Map([[containerKey, owned]]),
          symbols: new Map(),
          namedTypes: new Map(),
        });
      }
      const graph = new ContributionGraph(index, () => undefined);
      const union = graph.type(containerKey).items!.type;
      assert.lengthOf(
        union,
        2,
        `generation ${generation} retained enum copies`,
      );
      assert.sameMembers(
        union.map((type) => type.signifier!.semanticKey),
        [first.member.semanticKey, second.member.semanticKey],
      );
      assert.strictEqual(
        union.find(
          (type) => type.signifier!.semanticKey === first.member.semanticKey,
        ),
        graph.value(first.current),
      );
    }
    const before = fingerprint(
      new ContributionGraph(index, () => undefined).type(containerKey),
    );
    const revised = enumeration('First', 7);
    index.replace('declaration:First', revised.contribution);
    const graph = new ContributionGraph(index, () => undefined);
    const result = graph.type(containerKey);
    assert.lengthOf(result.items!.type, 2);
    assert.sameMembers(
      result.items!.type.map((type) => type.literalValue),
      [7, 1],
    );
    assert.notEqual(fingerprint(result), before);
    const detached = first.current.deriveDetached();
    assert.equal(detached.literalValue, 1);
    assert.strictEqual(
      graph.value(detached),
      graph.symbol(revised.member.semanticKey!).type.type[0],
    );
    assert.equal(graph.value(detached).literalValue, 7);
    const copiedEnum = first.type.deriveDetached();
    assert.strictEqual(graph.value(copiedEnum), graph.value(revised.type));
    assert.equal(
      graph.value(copiedEnum).getMember('same')!.type.type[0].literalValue,
      7,
    );
  });
});
