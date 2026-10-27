import { expect } from 'chai';
import { Signifier } from './signifiers.js';
import {
  getTypes,
  narrows,
  replaceGenerics,
  updateGenericsMap,
} from './types.checks.js';
import { KnownTypesMap, typeFromFeatherString } from './types.feather.js';
import { Type, TypeStore } from './types.js';

describe('Types', function () {
  it('preserves generic alias unions and leaves parameterized inputs unchanged', function () {
    const alternatives = [
      new Type('Real').named('T').genericize(),
      new Type('String').named('T').genericize(),
    ];
    const expanded = typeFromFeatherString(
      'Array<T>|T',
      [{ T: alternatives }],
      false,
    );
    expect(expanded.map((type) => type.kind)).to.deep.equal([
      'Array',
      'Real',
      'String',
    ]);
    expect(expanded[0].items!.type.map((type) => type.kind)).to.deep.equal([
      'Real',
      'String',
    ]);
    const container = new Type('Struct').named('Container');
    container.addItemType(new Type('Real'));
    const parameterized = typeFromFeatherString(
      'Container<String>',
      new Map([['Container', container]]),
      false,
    )[0];
    expect(parameterized.items!.type.map((type) => type.kind)).to.deep.equal([
      'String',
    ]);
    expect(container.items!.type.map((type) => type.kind)).to.deep.equal([
      'Real',
    ]);
  });

  it('substitutes generics in recursive item graphs without mutating inputs', function () {
    const generic = new Type('Any').named('T').genericize();
    const input = new Type('Array');
    input.items = new TypeStore().addType([input, generic]);
    const result = replaceGenerics(
      input,
      new Map(),
      new Map([['T', new TypeStore().addType(new Type('Real'))]]),
    ).type[0];
    expect(result).not.to.equal(input);
    expect(result.items!.type[0]).to.equal(result);
    expect(result.items!.type[1].kind).to.equal('Real');
    expect(input.items!.type).to.deep.equal([input, generic]);
    const expected = new Type('Array');
    expected.items = new TypeStore().addType(expected);
    expect(updateGenericsMap(expected, input, new Map()).size).to.equal(0);
    const mapped = updateGenericsMap(generic, input, new Map());
    expect(mapped.get('T')!.type).to.deep.equal([input]);
  });

  it('checks recursive return compatibility while retaining incompatible alternatives', function () {
    const left = Type.Function;
    const right = Type.Function;
    left.setReturnType([left, new Type('Real')]);
    right.setReturnType([right, new Type('Real')]);
    expect(narrows(left, right)).to.equal(true);
    right.setReturnType([right, new Type('String')]);
    expect(narrows(left, right)).to.equal(false);
    expect(narrows(right, left)).to.equal(false);
  });

  it('extracts wide type stores without spreading function arguments', function () {
    const real = new Type('Real');
    const input = new TypeStore().addType(Array(200001).fill(real));
    const output = getTypes(input);
    expect(output).to.have.length(200001);
    expect(output.every((type) => type === real)).to.equal(true);
  });

  it('can resursively resolve generic types', function () {
    const genericType = new Type('Any').named('T').genericize();
    const generics = [{ T: [genericType] }];
    const toType = (s: string) => typeFromFeatherString(s, generics, false);

    const knownTypes: KnownTypesMap = new Map();

    let resolved = updateGenericsMap(
      genericType,
      new Type('String'),
      knownTypes,
    );
    expect(resolved.get('T')!.type[0].kind).to.equal('String');

    resolved = updateGenericsMap(
      toType('Array<T>'),
      new Type('String'),
      knownTypes,
    );
    expect(resolved.get('T')).to.be.undefined;

    resolved = updateGenericsMap(
      toType('Array<T>'),
      toType('Array<String>'),
      knownTypes,
    );
    expect(resolved.get('T')!.type[0].kind).to.equal('String');

    resolved = updateGenericsMap(
      toType('Array<T>'),
      toType('Array<Struct<String>>'),
      knownTypes,
    );
    expect(resolved.get('T')!.type[0].kind).to.equal('Struct');
    expect(resolved.get('T')!.type[0].items!.type[0].kind).to.equal('String');

    // For cases with mixed types, this should still all work!
    resolved = updateGenericsMap(
      toType('Real|Array<T>|Struct<Array<T>>'),
      toType('Real|Struct<String>|Array<Id.DsMap>|Struct<Array<Id.Instance>>'),
      knownTypes,
    );
    const resolvedTypes = resolved.get('T')!.type;
    expect(resolvedTypes.length).to.equal(2);
    expect(resolvedTypes[0].kind).to.equal('Id.DsMap');
    expect(resolvedTypes[1].kind).to.equal('Id.Instance');

    // Make sure we can substitue generics
    const replaced = replaceGenerics(
      toType('Real|Array<T>|Struct<Array<T>>|ObjectType<Id.Instance>'),
      knownTypes,
      resolved,
    );
    expect(replaced.type[0].kind).to.equal('Real');
    expect(replaced.type[1].kind).to.equal('Array');
    expect(replaced.type[1].items!.type[0].kind).to.equal('Id.DsMap');
    expect(replaced.type[1].items!.type[1].kind).to.equal('Id.Instance');
    expect(replaced.type[2].kind).to.equal('Struct');
    expect(replaced.type[2].items!.type[0].kind).to.equal('Array');
    expect(replaced.type[2].items!.type[0].items!.type[0].kind).to.equal(
      'Id.DsMap',
    );
    expect(replaced.type[2].items!.type[0].items!.type[1].kind).to.equal(
      'Id.Instance',
    );
  });

  it('can check whether one simple type satisfies another', function () {
    const string = new Type('String');
    expect(string.narrows(new Type('String'))).to.be.true;
    expect(string.narrows(new Type('Real'))).to.be.false;

    const union = new TypeStore();
    union.type = [new Type('String'), new Type('Real')];
    expect(string.narrows(union)).to.be.true;
    expect(union.narrows(string)).to.be.false;
  });

  it('keeps unresolved ancestor accesses separate until a declaration exists', function () {
    const base = new Type('Struct');
    const child = base.derive();
    const grandchild = child.derive();
    const observed = base.addMember('value', { placeholder: true })!;
    const declared = child.addMember('value', { type: new Type('Real') })!;
    declared.def = {};
    expect(child.getMember('value', true)).to.equal(declared);
    expect(grandchild.getMember('value')).to.equal(declared);
    expect(base.getMember('value')).to.equal(observed);
    expect(grandchild.listMembers()).to.deep.equal([declared]);
    expect(grandchild.totalMembers()).to.equal(1);

    // A later actual base declaration still unifies inherited references.
    observed.def = {};
    expect(child.getMember('value', true)).to.equal(undefined);
    expect(grandchild.getMember('value')).to.equal(observed);
    expect(grandchild.listMembers()).to.deep.equal([observed]);
    expect(grandchild.totalMembers()).to.equal(1);

    // Explicit overrides retain their separate identity.
    const overridden = new Signifier(child, 'value');
    overridden.override = true;
    child.addMember(overridden);
    overridden.def = {};
    expect(overridden).not.to.equal(observed);
    base.refreshMemberInheritance(observed);
    expect(grandchild.getMember('value')).to.equal(overridden);
  });

  it('can check whether one struct type satisfies another', function () {
    const broadStruct = new Type('Struct');
    const narrowStruct = new Type('Struct');

    for (const struct of [broadStruct, narrowStruct]) {
      struct.addMember('name', { type: new Type('String') });
      struct.addMember('id', { type: new Type('Real') });
    }

    // They are the same at the moment, so should be true both ways
    expect(narrowStruct.narrows(broadStruct)).to.be.true;
    expect(broadStruct.narrows(narrowStruct)).to.be.true;

    // Now making the narrow struct more specific
    narrowStruct.addMember('specialty', { type: new Type('String') });
    expect(narrowStruct.narrows(broadStruct)).to.be.true;
    expect(broadStruct.narrows(narrowStruct)).to.be.false;
  });
});
