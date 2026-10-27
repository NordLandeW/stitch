import { expect } from 'chai';
import {
  flattenFeatherTypes,
  parseFeatherTypeString,
  type FeatherTypeDiagnostic,
} from './jsdoc.feather.js';
import { typeFromFeatherString } from './types.feather.js';
import { Type, TypeStore } from './types.js';

describe('Feather type string recovery', function () {
  for (const source of [
    'String|Real',
    'String,Real',
    'String OR Real',
    'String or Real',
    '<String|Real>',
    '[String|Real]',
  ]) {
    it(`preserves supported union syntax: ${source}`, function () {
      const diagnostics: FeatherTypeDiagnostic[] = [];
      const parsed = parseFeatherTypeString(source, diagnostics);
      expect(diagnostics).to.deep.equal([]);
      expect(parsed.types.map((type) => type.name.content)).to.deep.equal([
        'String',
        'Real',
      ]);
      for (const type of flattenFeatherTypes(parsed)) {
        expect(
          source.slice(
            type.name.offset,
            type.name.offset + type.name.content.length,
          ),
        ).to.equal(type.name.content);
      }
    });
  }

  it('preserves nested generic ownership, names and source offsets', function () {
    const source = ' Array[T|Array<Real>] OR Id.Map<String,Struct.Item> ';
    const diagnostics: FeatherTypeDiagnostic[] = [];
    const parsed = parseFeatherTypeString(source, diagnostics);
    expect(diagnostics).to.deep.equal([]);
    expect(parsed.types).to.have.lengthOf(2);
    expect(parsed.types[0].name.content).to.equal('Array');
    expect(
      parsed.types[0].of!.types.map((type) => type.name.content),
    ).to.deep.equal(['T', 'Array']);
    expect(parsed.types[0].of!.types[1].of!.types[0].name.content).to.equal(
      'Real',
    );
    expect(parsed.types[1].name.content).to.equal('Id.Map');
    expect(
      parsed.types[1].of!.types.map((type) => type.name.content),
    ).to.deep.equal(['String', 'Struct.Item']);
    for (const type of flattenFeatherTypes(parsed)) {
      expect(
        source.slice(
          type.name.offset,
          type.name.offset + type.name.content.length,
        ),
      ).to.equal(type.name.content);
    }
  });

  it('recovers an extra closer without discarding either recognizable type', function () {
    const diagnostics: FeatherTypeDiagnostic[] = [];
    const parsed = parseFeatherTypeString('Real>String', diagnostics);
    expect(parsed.types.map((type) => type.name.content)).to.deep.equal([
      'Real',
      'String',
    ]);
    expect(diagnostics).to.deep.equal([
      { message: "Unexpected closing bracket '>'", offset: 4, length: 1 },
    ]);
    expect(
      typeFromFeatherString('Real>String', new Map(), false).map(
        (type) => type.kind,
      ),
    ).to.deep.equal(['Real', 'String']);
  });

  const malformed = [
    {
      source: 'Array<Array<Real>|String',
      token: '<',
      offset: 5,
      names: ['Array', 'Array', 'Real', 'String'],
    },
    {
      source: 'Array[Real>|String',
      token: '>',
      offset: 10,
      names: ['Array', 'Real', 'String'],
    },
    {
      source: 'Array<>|String',
      token: '>',
      offset: 6,
      names: ['Array', 'String'],
    },
    {
      source: 'Array<Real|>',
      token: '|',
      offset: 10,
      names: ['Array', 'Real'],
    },
    {
      source: 'Real||String',
      token: '|',
      offset: 5,
      names: ['Real', 'String'],
    },
    {
      source: 'Real String',
      token: 'String',
      offset: 5,
      names: ['Real', 'String'],
    },
    { source: 'Real?String', token: '?', offset: 4, names: ['Real', 'String'] },
    { source: 'Array<', token: '<', offset: 5, names: ['Array'] },
    { source: '<Real', token: '<', offset: 0, names: ['Real'] },
    { source: 'Real|', token: '|', offset: 4, names: ['Real'] },
    { source: '>', token: '>', offset: 0, names: [] },
    { source: '?', token: '?', offset: 0, names: [] },
  ];
  for (const { source, token, offset, names } of malformed) {
    it(`reports local syntax errors and retains type tokens: ${source}`, function () {
      const diagnostics: FeatherTypeDiagnostic[] = [];
      const parsed = parseFeatherTypeString(source, diagnostics);
      expect(
        flattenFeatherTypes(parsed).map((type) => type.name.content),
      ).to.deep.equal(names);
      expect(diagnostics.length).to.be.greaterThan(0);
      const local = diagnostics.find(
        (diagnostic) => diagnostic.offset === offset,
      );
      expect(local, 'diagnostic at the offending token').not.to.equal(
        undefined,
      );
      expect(local!.length).to.equal(token.length);
      expect(source.slice(offset, offset + token.length)).to.equal(token);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.message).to.be.a('string').and.not.equal('');
        expect(diagnostic.offset).to.be.at.least(0);
        expect(diagnostic.length).to.be.greaterThan(0);
        expect(diagnostic.offset + diagnostic.length).to.be.at.most(
          source.length,
        );
      }
    });
  }

  for (const source of ['', '   ']) {
    it(`reports an empty type while retaining the historical inferred default: ${JSON.stringify(source)}`, function () {
      const diagnostics: FeatherTypeDiagnostic[] = [];
      const parsed = parseFeatherTypeString(source, diagnostics);
      expect(diagnostics).to.deep.equal([
        { message: 'Expected a type', offset: 0, length: source.length },
      ]);
      expect(parsed.types[0].name).to.deep.equal({
        content: 'Any',
        inferred: true,
        offset: 0,
      });
    });
  }
});

describe('Feather type graph display', function () {
  it('shows recursive item paths in type and function hover text without changing the graph', function () {
    const array = new Type('Array');
    const items = new TypeStore().addType([array, new Type('Real')]);
    array.items = items;
    expect(array.toFeatherString()).to.equal('Array<...|Real>');
    expect(array.code).to.equal('Array<...|Real>');
    const fn = Type.Function.named('read');
    fn.setReturnType(array);
    expect(fn.code).to.equal('function read(): Array<...|Real>');
    expect(array.items).to.equal(items);
    expect(array.items.type[0]).to.equal(array);
    expect(array.toFeatherString()).to.equal('Array<...|Real>');
  });

  it('expands shared acyclic paths and same-key distinct objects normally', function () {
    const leaf = new Type('Array');
    leaf.semanticKey = 'same-key';
    leaf.items = new TypeStore().addType(new Type('Real'));
    const root = new Type('Array');
    root.semanticKey = 'same-key';
    root.items = new TypeStore().addType([leaf, leaf]);
    expect(root.toFeatherString()).to.equal('Array<Array<Real>|Array<Real>>');
    leaf.items = new TypeStore().addType(root);
    expect(root.toFeatherString()).to.equal('Array<Array<...>|Array<...>>');
    const named = new Type('Struct').named('Entry');
    named.items = new TypeStore().addType(named);
    expect(named.toFeatherString()).to.equal('Struct.Entry');
  });

  it('renders deeply nested finite input iteratively', function () {
    let root: Type = new Type('Real');
    for (let depth = 0; depth < 4096; depth++) {
      const parent = new Type('Array');
      parent.items = new TypeStore().addType(root);
      root = parent;
    }
    expect(root.toFeatherString()).to.equal(
      'Array<'.repeat(4096) + 'Real' + '>'.repeat(4096),
    );
  });

  it('bounds exponentially shared display expansion without changing semantic aliases', function () {
    let root: Type = new Type('Real');
    let reads = 0;
    for (let depth = 0; depth < 64; depth++) {
      const parent = new Type('Array');
      const items = new TypeStore().addType([root, root]);
      // A broken formatter must fail deterministically instead of exhausting
      // the test worker while expanding an otherwise small finite graph.
      Object.defineProperty(parent, 'items', {
        get() {
          if (++reads > 100_000)
            throw new Error('Unbounded shared graph display');
          return items;
        },
      });
      root = parent;
    }
    const text = root.toFeatherString();
    expect(text).to.match(/^Array</);
    expect(text).to.include('...');
    expect(text.length).to.be.lessThan(100_000);
    expect(text.match(/</g)!.length).to.equal(text.match(/>/g)!.length);
    expect(root.items!.type[0]).to.equal(root.items!.type[1]);
  });
});
