import { expect } from 'chai';
import { Type, TypeStore } from '../types.js';
import { Signifier } from '../signifiers.js';
import {
  copyFlow,
  flowKey,
  FlowHistory,
  initialFlow,
  mergeFlow,
} from './flow.js';
import { value } from './values.js';

// Branch joins must retain unions and constraints while bounding repeated reads
// of an unchanged incoming value. No wall-clock threshold is involved.
describe('Flow merge work', function () {
  it('reads an unchanged branch value once and keeps output stores independent', function () {
    const type = Type.Struct;
    const input = value(type);
    const state = initialFlow();
    state.values.set('field', input);
    const getter = Object.getOwnPropertyDescriptor(
      TypeStore.prototype,
      'type',
    )!.get!;
    let reads = 0;
    Object.defineProperty(input, 'type', {
      get: () => {
        reads++;
        return getter.call(input);
      },
    });
    const merged = mergeFlow(Array.from({ length: 32 }, () => copyFlow(state)));
    expect(reads).to.equal(1);
    expect(merged.values.get('field')!.type).to.deep.equal([type]);
    merged.values.get('field')!.type = [Type.String];
    expect(input.type).to.deep.equal([type]);
    expect(state.values.get('field')).to.equal(input);
  });

  it('preserves widening, distinct allocations, conditional constraints and unreachable inputs', function () {
    const left = initialFlow(),
      right = initialFlow(),
      dead = initialFlow();
    const first = Type.Real,
      second = Type.Real;
    first.literalValue = 1;
    second.literalValue = 2;
    const a = Type.Struct,
      b = Type.Struct;
    left.values.set('number', value(first));
    right.values.set('number', value(second));
    left.values.set('shape', value(a));
    right.values.set('shape', value(b));
    left.constraints.set('shape', { type: value(a), conditional: false });
    dead.reachable = false;
    dead.values.set('number', value(Type.String));
    const merged = mergeFlow([left, right, dead]);
    expect(
      merged.values.get('number')!.type.map((type) => type.kind),
    ).to.deep.equal(['Real']);
    expect(merged.values.get('number')!.type[0].literalValue).to.equal(
      undefined,
    );
    expect(merged.values.get('shape')!.type).to.deep.equal([a, b]);
    expect(merged.constraints.get('shape')!.conditional).to.equal(true);
    right.constraints.set('shape', { type: value(b), conditional: false });
    const constrained = mergeFlow([left, right]);
    expect(constrained.constraints.get('shape')!.conditional).to.equal(false);
    expect(constrained.constraints.get('shape')!.type.type).to.deep.equal([
      a,
      b,
    ]);
    expect(mergeFlow([dead]).reachable).to.equal(false);
    expect(mergeFlow([dead]).values.size).to.equal(0);
  });

  it('captures shared value and constraint roots once and starts fresh after a graph write', function () {
    const shared = Type.Struct;
    const field = new Signifier(shared, 'field', Type.Real);
    shared.setOwnMember(field);
    const state = initialFlow();
    for (let index = 0; index < 32; index++) {
      state.values.set(`value:${index}`, value(shared));
      state.constraints.set(`constraint:${index}`, {
        type: value(shared),
        conditional: false,
      });
    }
    const listMembers = shared.listMembers.bind(shared);
    let visits = 0;
    shared.listMembers = (...args) => {
      visits++;
      return listMembers(...args);
    };
    const before = flowKey(state);
    expect(visits).to.equal(1);
    field.type.type = [Type.String];
    expect(flowKey(state)).not.to.equal(before);
    expect(visits).to.equal(2);
  });

  it('retains static initialization only when every reachable branch has executed it', function () {
    const first = initialFlow(),
      second = initialFlow(),
      dead = initialFlow();
    first.initializedStatics.add('cached');
    dead.reachable = false;
    expect([...mergeFlow([first, second]).initializedStatics]).to.deep.equal(
      [],
    );
    second.initializedStatics.add('cached');
    expect([
      ...mergeFlow([first, second, dead]).initializedStatics,
    ]).to.deep.equal(['cached']);
    const copy = copyFlow(first);
    copy.initializedStatics.add('another');
    expect([...first.initializedStatics]).to.deep.equal(['cached']);
  });
});

describe('Local flow history', function () {
  it('keeps alias changes distinct through both arena and canonical history', function () {
    const a = Type.Struct,
      b = Type.Struct;
    a.semanticKey = 'storage:a';
    b.semanticKey = 'storage:b';
    a.allocationSource = b.allocationSource = 'one-call-site';
    for (const budget of [undefined, { maxNodes: 0 }]) {
      const history = new FlowHistory('aliases', budget);
      const state = initialFlow();
      state.values.set('alias', value(a));
      const first = flowKey(state);
      expect(history.repeats(state)).to.equal(false);
      state.values.set('alias', value(a, b));
      expect(flowKey(state)).not.to.equal(first);
      expect(history.repeats(state)).to.equal(false);
      state.values.set('alias', value(a));
      expect(history.repeats(state)).to.equal(true);
      state.constraints.set('alias', { type: value(a), conditional: false });
      expect(history.repeats(state)).to.equal(false);
      state.constraints.set('alias', { type: value(b), conditional: false });
      expect(history.repeats(state)).to.equal(false);
      state.constraints.set('alias', { type: value(a), conditional: false });
      expect(history.repeats(state)).to.equal(true);
    }
  });

  it('compares scalar values independently of native specification addresses', function () {
    const input = Type.Real;
    input.semanticKey = 'native:Function.length/returns/0';
    const state = initialFlow();
    state.values.set('index', value(input));
    const first = flowKey(state);
    const history = new FlowHistory('scalar');
    expect(history.repeats(state)).to.equal(false);
    state.values.set('index', value(input, Type.Real));
    expect(flowKey(state)).to.equal(first);
    expect(history.repeats(state)).to.equal(true);
  });

  it('captures current aliases once and remembers nonadjacent cyclic states without reading old live objects', function () {
    const make = () => {
      const root = Type.Struct;
      const field = new Signifier(root, 'field', Type.Real);
      root.setOwnMember(field);
      root.setOwnMember(new Signifier(root, 'next', root));
      return { root, field };
    };
    const { root, field } = make();
    const state = initialFlow();
    for (let index = 0; index < 16; index++)
      state.values.set(`alias:${index}`, value(root));
    const list = root.listMembers.bind(root);
    let visits = 0;
    root.listMembers = (...args) => {
      visits++;
      return list(...args);
    };
    const history = new FlowHistory('cycle');
    expect(history.repeats(state)).to.equal(false);
    expect(visits).to.equal(1);
    field.setType(Type.String);
    expect(history.repeats(state)).to.equal(false);
    expect(visits).to.equal(2);
    field.setType(Type.Real);
    expect(history.repeats(state)).to.equal(true);
    expect(visits).to.equal(3);
    const rebuilt = make().root;
    root.listMembers = () => {
      throw new Error('History must not revisit old live values');
    };
    for (const key of state.values.keys())
      state.values.set(key, value(rebuilt));
    expect(history.repeats(state)).to.equal(true);
    expect(history.statistics.canonicalizations).to.equal(0);
    expect(history.statistics.distinctStates).to.equal(2);
  });

  it('matches complete flow metadata including missing slots and empty unions', function () {
    const state = initialFlow();
    state.values.set('field', value(Type.Real));
    state.constraints.set('field', {
      type: value(Type.Real),
      conditional: false,
    });
    const history = new FlowHistory('metadata');
    const seen = new Set<string>();
    const check = () => {
      const key = flowKey(state);
      expect(history.repeats(state)).to.equal(seen.has(key));
      seen.add(key);
    };
    check();
    state.constraints.set('field', {
      type: value(Type.Real),
      conditional: true,
    });
    check();
    state.initializedStatics.add('a');
    check();
    state.initializedStatics.add('b');
    check();
    state.initializedStatics.clear();
    state.initializedStatics.add('b');
    state.initializedStatics.add('a');
    check();
    state.reachable = false;
    check();
    state.constraints.clear();
    check();
    state.values.delete('field');
    check();
    state.values.set('field', value());
    check();
    state.values.clear();
    check();
    expect(history.statistics.distinctStates).to.equal(seen.size);
  });

  for (const budget of [
    { maxNodes: 12, maxBytes: 1024 * 1024 },
    { maxNodes: 8192, maxBytes: 1 },
  ]) {
    it(`preserves all earlier states after the ${budget.maxBytes === 1 ? 'byte' : 'node'} arena budget falls back`, function () {
      const history = new FlowHistory('budget', budget);
      const state = initialFlow();
      const scalar = Type.Real;
      state.values.set('value', value(scalar));
      const seen = new Set<string>();
      for (const literal of [
        ...Array.from({ length: 16 }, (_, index) => index),
        0,
        3,
        15,
        1,
        1000,
        0,
      ]) {
        scalar.literalValue = literal;
        const key = flowKey(state);
        expect(history.repeats(state), `literal ${literal}`).to.equal(
          seen.has(key),
        );
        seen.add(key);
      }
      expect(history.statistics.mode).to.equal('canonical');
      expect(history.statistics.retainedNodes).to.equal(0);
      expect(history.statistics.retainedBytes).to.equal(0);
      expect(history.statistics.peakRetainedNodes).to.be.at.most(
        budget.maxNodes,
      );
      expect(history.statistics.peakRetainedBytes).to.be.at.most(
        budget.maxBytes,
      );
      expect(history.statistics.canonicalStates).to.equal(seen.size);
      expect(history.statistics.distinctStates).to.equal(17);
    });
  }
});
