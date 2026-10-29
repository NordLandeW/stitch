import { expect } from 'chai';
import { LanguageProfile } from '../language/version.js';
import { GmlParser } from '../parser.js';
import { Signifier } from '../signifiers.js';
import { Type } from '../types.js';
import { bindUnit } from './binding.js';
import { evaluateUnit } from './evaluation.js';
import { globalKey, nativeGlobalKey, nativeGlobalOwner } from './model.js';
import { normalizeSyntax } from './syntax.js';
import { value } from './values.js';

function analyze(
  text: string,
  natives: ReadonlyMap<string, { input?: Type; result: Type }> = new Map(),
) {
  const unitId = 'storage-identity.gml';
  const parsed = new GmlParser().parse(text);
  expect(parsed.errors).to.deep.equal([]);
  const syntax = normalizeSyntax({
    unitId,
    text,
    cst: parsed.cst,
    origin: (start, end) => ({
      spelling: { uri: unitId, start, end },
      editable: true,
    }),
  });
  const bound = bindUnit(syntax, {
    unitId,
    assetId: 'fixture',
    assetName: 'fixture',
    kind: 'script',
    definitiveSelf: false,
    language: new LanguageProfile({ runtimeVersion: '2024.13.0.0' }),
  });
  const definitions = new Map<string, { input?: Type; result: Type }>(
    ['is_struct', 'is_array', 'is_callable'].map((name) => [
      name,
      { input: Type.Any, result: Type.Bool },
    ]),
  );
  for (const [name, signature] of natives) definitions.set(name, signature);
  const guards = new Map(
    [...definitions].map(([name, signature]) => {
      const fn = Type.Function.named(name);
      fn.callKind = 'native';
      fn.addParameter(0, 'input', {
        type: signature.input || Type.Any,
        optional: !signature.input,
      });
      fn.setReturnType(signature.result);
      const item = new Signifier(Type.Struct, name, fn);
      item.native = 'Base';
      item.semanticKey = nativeGlobalKey(name);
      fn.signifier = item;
      return [name, { key: item.semanticKey, item }] as const;
    }),
  );
  let steps = 0;
  return evaluateUnit(bound, {
    lookup: ({ owner, name }) =>
      owner === nativeGlobalOwner ? guards.get(name) : undefined,
    type: () => undefined,
    observe: () => {},
    // Isolate a nonconverging implementation without a wall-clock assertion.
    cancelled: () => ++steps > 10000,
  });
}

function returned(result: ReturnType<typeof analyze>) {
  return result.symbols
    .get(globalKey('example'))!
    .item.getTypeByKind('Function')!.returns!.type;
}

describe('Anonymous storage identity', function () {
  it('converges repeated struct guards while keeping independent receivers separate', function () {
    const result = analyze(
      'function example(left,right){while(unknown_condition){if(is_struct(left)){left.field=1;} if(is_struct(right)){right.field="text";}}return [left,right];}',
    );
    const structures = returned(result)[0].items!.type.filter(
      (type) => type.kind === 'Struct',
    );
    expect(structures).to.have.lengthOf(2);
    expect(
      structures.map((type) =>
        type.getMember('field')!.type.type.map((member) => member.kind),
      ),
    ).to.have.deep.members([['Real'], ['String']]);
  });

  it('converges repeated array guards and retains the written element type', function () {
    const result = analyze(
      'function example(input){while(unknown_condition){if(is_array(input)){input[0]=1;}}return input;}',
    );
    const array = returned(result).find((type) => type.kind === 'Array')!;
    expect(array.items!.type.map((type) => type.kind)).to.deep.equal(['Real']);
  });

  it('converges recursive results that reach a later narrowing site', function () {
    const result = analyze(
      'function example(input,key,recurse){if(is_struct(input)){if(recurse)input[$key]=example(input,key,false);return input;} if(is_array(input)){if(recurse)input[0]=example(input,key,false);return input;} return input;}',
    );
    expect(returned(result).map((type) => type.kind)).to.have.members([
      'Struct',
      'Array',
      'Any',
    ]);
    for (const type of returned(result).filter(
      (type) => type.kind === 'Struct' || type.kind === 'Array',
    ))
      expect(type.items!.type.map((item) => item.kind)).to.have.members([
        'Struct',
        'Array',
        'Any',
      ]);
  });

  it('converges a mutable generic result without claiming it aliases its type argument', function () {
    const generic = new Type('Mixed').genericize().named('T');
    const result = analyze(
      'function example(condition){var source={};var result;while(condition){result=choose(source);result.mark=1;}return [source,result];}',
      new Map([['choose', { input: generic, result: generic }]]),
    );
    const structures = returned(result)[0].items!.type.filter(
      (type) => type.kind === 'Struct',
    );
    expect(structures).to.have.lengthOf(2);
    expect(structures[0].getMember('mark')).to.equal(undefined);
    expect(
      structures[1].getMember('mark')!.type.type.map((type) => type.kind),
    ).to.deep.equal(['Real']);
  });

  it('isolates nested anonymous result members and items at separate call sites', function () {
    const generic = new Type('Mixed').genericize().named('T');
    const schema = Type.Struct,
      array = new Type('Array'),
      element = Type.Struct;
    array.items = value(element);
    const childrenMember = new Signifier(schema, 'children', array);
    childrenMember.def = {};
    schema.setOwnMember(childrenMember);
    const result = analyze(
      'function example(condition){var left;var right;while(condition){left=shape(1);right=shape(1);left.children[0].first=1;right.children[0].second="text";}return [left,right];}',
      new Map([['shape', { input: generic, result: schema }]]),
    );
    const structures = returned(result)[0].items!.type.filter(
      (type) => type.kind === 'Struct',
    );
    expect(structures).to.have.lengthOf(2);
    const children = structures.map(
      (type) => type.getMember('children')!.type.type[0].items!.type[0],
    );
    expect(
      children.map((type) =>
        type.listMembers(true).map((member) => member.name),
      ),
    ).to.deep.equal([['first'], ['second']]);
    expect(
      children[0].getMember('first')!.type.type.map((type) => type.kind),
    ).to.deep.equal(['Real']);
    expect(children[0].getMember('second')).to.equal(undefined);
    expect(
      children[1].getMember('second')!.type.type.map((type) => type.kind),
    ).to.deep.equal(['String']);
    expect(children[1].getMember('first')).to.equal(undefined);
    expect(element.listMembers(true)).to.deep.equal([]);
  });

  it('preserves finite recursive result schemas and existing keyed aliases', function () {
    const schema = Type.Struct;
    const next = new Signifier(schema, 'next', schema);
    next.def = {};
    schema.setOwnMember(next);
    const alias = Type.Struct;
    alias.semanticKey = 'fixture:shared';
    const result = analyze(
      'function example(condition){var result;while(condition){result=shape();result.next.mark=1;}var left=alias();var right=alias();left.shared="text";return [result,right.shared];}',
      new Map([
        ['shape', { result: schema }],
        ['alias', { result: alias }],
      ]),
    );
    const items = returned(result)[0].items!.type;
    expect(items.map((type) => type.kind)).to.include('String');
    const shape = items.find((type) => type.kind === 'Struct')!;
    expect(
      shape
        .getMember('next')!
        .type.type[0].getMember('mark')!
        .type.type.map((type) => type.kind),
    ).to.deep.equal(['Real']);
    expect(schema.getMember('mark')).to.equal(undefined);
    expect(alias.getMember('shared')).to.equal(undefined);
  });

  it('converges repeated callable guards and retains a callable signature', function () {
    const result = analyze(
      'function example(input){while(unknown_condition){if(is_callable(input)){input();}}return input;}',
    );
    const callable = returned(result).find((type) => type.kind === 'Function')!;
    expect(callable.listParameters()).to.have.lengthOf(1);
    expect(callable.returns!.type.map((type) => type.kind)).to.deep.equal([
      'Any',
    ]);
  });
});
