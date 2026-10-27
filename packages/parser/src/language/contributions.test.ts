import { assert } from 'chai';
import { globalKey, globalOwner } from '../analysis/model.js';
import { Signifier } from '../signifiers.js';
import { Type } from '../types.js';
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
