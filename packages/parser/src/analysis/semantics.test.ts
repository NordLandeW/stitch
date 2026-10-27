import { pathy } from '@bscotch/pathy';
import { expect } from 'chai';
import { LanguageProfile } from '../language/version.js';
import { GmlParser } from '../parser.js';
import { Code } from '../project.code.js';
import { readFileSync } from 'node:fs';
import { planReferenceRename } from '../project.location.js';
import { Signifier } from '../signifiers.js';
import { SourceMap } from '../syntax/source.js';
import { Type } from '../types.js';
import { value } from './values.js';
import { bindUnit } from './binding.js';
import { checkUnit } from './checking.js';
import { createDeclarationSummary, evaluateUnit } from './evaluation.js';
import {
  installSymbolContributions,
  materializeUnit,
} from './materialization.js';
import {
  globalKey,
  type MaterializationHost,
  type SemanticEnvironment,
  type SymbolView,
  type UnitContext,
} from './model.js';
import { normalizeSyntax } from './syntax.js';
import { fingerprint } from './values.js';
import {
  collectInputContribution,
  ContributionGraph,
  ContributionIndex,
} from '../language/contributions.js';

function analyze(
  source: string,
  external = new Map<string, SymbolView>(),
  runtimeVersion = '2024.13.0.0',
  context: Partial<UnitContext> = {},
  externalTypes = new Map<string, Type>(),
  uri = 'semantic-test.gml',
  parseErrors = 0,
) {
  const parsed = new GmlParser().parse(source);
  expect(parsed.errors, source).to.have.length(parseErrors);
  const sourceMap = new SourceMap({ uri, text: source });
  const syntax = normalizeSyntax({
    unitId: uri,
    text: source,
    cst: parsed.cst,
    origin: (start, end) => sourceMap.origin(start, end),
  });
  const bound = bindUnit(syntax, {
    unitId: uri,
    assetId: 'test',
    assetName: 'test',
    kind: 'script',
    definitiveSelf: false,
    language: new LanguageProfile({ runtimeVersion }),
    ...context,
  });
  const environment: SemanticEnvironment = {
    lookup: ({ owner, name }) => {
      const global = external.get(name);
      if (global) return global;
      const member = externalTypes.get(owner)?.getMember(name);
      return (
        member && {
          key: member.semanticKey!,
          item: member,
          intrinsic: !!member.native,
        }
      );
    },
    type: (key) => externalTypes.get(key),
    observe: () => {},
    cancelled: () => false,
  };
  const evaluated = evaluateUnit(bound, environment);
  const result = {
    ...evaluated,
    diagnostics: [...evaluated.diagnostics, ...checkUnit(bound, evaluated)],
  };
  const file = { path: pathy(uri), content: source } as Code;
  const host: MaterializationHost = {
    source: (requested) =>
      requested === uri ? { file, text: source } : undefined,
    hasSymbol: (key) =>
      result.symbols.has(key) ||
      [...external.values()].some((entry) => entry.key === key) ||
      [...externalTypes.values()].some((type) =>
        type.listMembers(true).some((member) => member.semanticKey === key),
      ),
    symbol: (key) => {
      const symbol =
        result.symbols.get(key) ||
        [...external.values()].find((entry) => entry.key === key);
      const imported = [...externalTypes.values()]
        .flatMap((type) => type.listMembers(true))
        .find((member) => member.semanticKey === key);
      if (!symbol && !imported) throw new Error(`Missing symbol ${key}`);
      return symbol?.item || imported!;
    },
    type: (key) => {
      const type = result.types.get(key) || externalTypes.get(key);
      if (!type) throw new Error(`Missing type ${key}`);
      return type;
    },
    value: (type) => type,
  };
  for (const symbol of result.symbols.values())
    installSymbolContributions([symbol], symbol.item, host);
  const view = materializeUnit(result, host);
  return {
    source,
    bound,
    result,
    view,
    returns(name: string) {
      return result.symbols
        .get(globalKey(name))!
        .item.getTypeByKind('Function')!.returns!;
    },
  };
}
function kinds(type: { type: Type[] }) {
  return [...new Set(type.type.map((entry) => entry.kind))].sort();
}
function native(name: string, parameterCount = 0): SymbolView {
  const owner = Type.Struct;
  const fn = Type.Function.named(name);
  fn.callKind = 'native';
  for (let index = 0; index < parameterCount; index++)
    fn.addParameter(index, `p${index}`, { type: Type.Any });
  fn.setReturnType(Type.Real);
  const item = new Signifier(owner, name, fn);
  item.native = 'Base';
  item.semanticKey = globalKey(name);
  fn.signifier = item;
  return { key: item.semanticKey, item };
}

// Exercise Code's actual query/range methods over the materialized semantic
// view, without requiring a disk-loaded Project for each recovery position.
function queryCode(analysis: ReturnType<typeof analyze>): Code {
  return Object.setPrototypeOf(
    {
      content: analysis.source,
      scopes: analysis.view.scopes,
      _refs: analysis.view.refs,
      _rangesAreSorted: true,
      project: { self: analysis.result.types.get('global') },
    },
    Code.prototype,
  );
}

describe('Transactional GML semantics', function () {
  it('keeps shorthand source and member identities separate and expands either rename', function () {
    const source =
      'function Probe() { var original = 1; var holder = { original }; return holder.original; }';
    const { view } = analyze(source);
    const local = view.refs.find(
      (ref) => ref.isDef && ref.start.offset === source.indexOf('original ='),
    )!;
    const property = view.refs.find(
      (ref) => ref.start.offset === source.lastIndexOf('original'),
    )!;
    expect(local.item).not.to.equal(property.item);
    const localEdits = planReferenceRename(
      view.refs.filter((ref) => ref.item === local.item),
      'value',
      view.refs,
    );
    expect(localEdits.map((edit) => edit.text)).to.include('original: value');
    const propertyEdits = planReferenceRename(
      view.refs.filter((ref) => ref.item === property.item),
      'field',
      view.refs,
    );
    expect(propertyEdits.map((edit) => edit.text)).to.include(
      'field: original',
    );
    expect(
      propertyEdits.some(
        (edit) => edit.range.start.offset === local.start.offset,
      ),
    ).to.equal(false);
  });

  it('validates rename identifiers, storage conflicts and property-only keywords', function () {
    const result = analyze(
      'function Probe(){var first=1, second=2; var holder={field:1}; return [first,holder.field];}',
    );
    const local = result.view.refs.filter(
      (reference) => reference.item.name === 'first',
    );
    expect(() =>
      planReferenceRename(local, 'bad name', result.view.refs),
    ).to.throw('valid GML identifier');
    expect(() =>
      planReferenceRename(local, 'return', result.view.refs),
    ).to.throw('valid GML identifier');
    expect(() =>
      planReferenceRename(local, 'second', result.view.refs),
    ).to.throw('already exists');
    expect(
      planReferenceRename(local, 'valid_name', result.view.refs),
    ).to.have.length(2);
    const property = result.view.refs.filter(
      (reference) => reference.item.name === 'field',
    );
    expect(
      planReferenceRename(property, 'static', result.view.refs),
    ).to.have.length(2);
  });

  it('visits constructor base arguments in the child parameter scope', function () {
    const source =
      'function Parent(value) constructor {} function Child(arg):Parent(arg) constructor {}';
    const { view, result } = analyze(source);
    const declaration = view.refs.find(
      (ref) => ref.isDef && ref.text === 'arg',
    )!;
    const use = view.refs.find((ref) => !ref.isDef && ref.text === 'arg')!;
    expect(use.item).to.equal(declaration.item);
    expect(
      result.calls.some((call) => call.kind === 'base-constructor'),
    ).to.equal(true);
    expect(
      analyze(
        source.replace('Parent(arg)', 'Parent(unknownInput)'),
      ).result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('unknownInput'),
      ),
    ).to.equal(true);
  });

  it('preserves variable unions, logical kinds and exact nullish alternatives', function () {
    expect(
      kinds(
        analyze(
          'function Probe(flag) { var a=1; var b="s"; return flag ? a : b; }',
        ).returns('Probe'),
      ),
    ).to.deep.equal(['Real', 'String']);
    expect(
      kinds(
        analyze(
          'function Probe() { return undefined ?? { value: 42 }; }',
        ).returns('Probe'),
      ),
    ).to.deep.equal(['Struct']);
    expect(
      kinds(
        analyze(
          'function Probe() { return pointer_null ?? { value: 42 }; }',
        ).returns('Probe'),
      ),
    ).to.deep.equal(['Struct']);
    expect(
      kinds(
        analyze(
          'function Probe() { return pointer_invalid ?? { value: 42 }; }',
        ).returns('Probe'),
      ),
    ).to.deep.equal(['Pointer']);
    for (const source of ['1 ^^ 0', '1 and 0', 'not 1'])
      expect(
        kinds(
          analyze(`function Probe() { return ${source}; }`).returns('Probe'),
        ),
      ).to.deep.equal(['Bool']);
  });

  it('records both reads in legacy equality expressions', function () {
    const source =
      'function Probe() { var a=1; var b=2; if (a = b) return 1; return 0; }';
    const { view } = analyze(source);
    const rhs = view.refs.find(
      (ref) => ref.start.offset === source.indexOf('b)'),
    )!;
    expect(rhs.text).to.equal('b');
    expect(rhs.isDef).to.equal(false);
  });

  it('uses current flow values and excludes unreachable returns', function () {
    expect(
      kinds(
        analyze(
          'function Produce(){return {x:1};} function Probe(){var value=undefined; value=Produce(); return value.x;}',
        ).returns('Probe'),
      ),
    ).to.deep.equal(['Real']);
    expect(
      kinds(
        analyze('function Probe(flag){if(flag) return {x:1};}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Struct', 'Undefined']);
    expect(
      kinds(
        analyze('function Probe(){throw "error"; return 42;}').returns('Probe'),
      ),
    ).to.deep.equal(['Never']);
  });

  it('supports known struct keys and writes through array element types', function () {
    const keyed = analyze(
      'function Probe(){var source={}; source[$ "value"]=42; return source.value;}',
    );
    expect(kinds(keyed.returns('Probe'))).to.deep.equal(['Real']);
    expect(
      keyed.result.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('value'),
      ),
    ).to.have.length(0);
    expect(
      kinds(
        analyze(
          'function Probe(){var values=[]; values[0]={value:42}; return values[0].value;}',
        ).returns('Probe'),
      ),
    ).to.deep.equal(['Real']);
  });

  it('separates native mandatory signatures from permissive user calls', function () {
    const external = new Map([['required', native('required', 1)]]);
    const { result } = analyze(
      'function User(value){return value;} User(); User(1,2); required();',
      external,
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.collection === 'MISSING_REQUIRED_ARGUMENT',
      ),
    ).to.have.length(1);
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.collection === 'TOO_MANY_ARGUMENTS',
      ),
    ).to.have.length(0);
  });

  it('discovers script global assignment independently of subsequent access', function () {
    const { result, view } = analyze('thing=10;');
    expect(result.symbols.get(globalKey('thing'))?.item.global).to.equal(true);
    expect(view.refs.find((ref) => ref.text === 'thing')?.isDef).to.equal(true);
    expect(result.diagnostics).to.have.length(0);
  });

  it('keeps declaration placeholders callable with pending return types', function () {
    const { bound } = analyze('function Later(value){return value;}');
    const declarations = createDeclarationSummary(bound);
    const callable = declarations.symbols
      .get(globalKey('Later'))!
      .item.getTypeByKind('Function')!;
    expect(callable).not.to.equal(undefined);
    expect(
      callable.listParameters().map((parameter) => parameter?.name),
    ).to.deep.equal(['value']);
    expect(callable.returns!.hasTypes).to.equal(false);
  });

  it('keeps base field navigation canonical while preserving derived methods and statics', function () {
    const source =
      'function Parent() constructor { field=1; static count=1; action=function(){return 1;}; } function Child():Parent() constructor { field=2; static count=2; action=function(){return 2;}; } function Probe(){var child=new Child(); return child.field;}';
    const { view, result } = analyze(source);
    const parent = view.refs.find(
      (ref) => ref.start.offset === source.indexOf('field=1'),
    )!;
    const child = view.refs.find(
      (ref) => ref.start.offset === source.indexOf('field=2'),
    )!;
    const read = view.refs.find(
      (ref) => ref.start.offset === source.lastIndexOf('field'),
    )!;
    expect(child.item).to.equal(parent.item);
    expect(read.item).to.equal(parent.item);
    expect(child.isDef).to.equal(false);
    const shape = result.symbols
      .get(globalKey('Child'))!
      .item.getTypeByKind('Function')!.self!;
    expect(shape.getMember('field', true)).to.equal(undefined);
    expect(shape.getMember('count', true)).not.to.equal(undefined);
    expect(shape.getMember('action', true)).not.to.equal(undefined);
  });

  it('resolves inherited members independently of reader and constructor source order', function () {
    const reader =
      '/** @param {Struct.Child} value */ function Read(value){return value.parentField;}';
    const constructors =
      'function Child():Parent() constructor {} function Parent() constructor {parentField=1;}';
    for (const source of [reader + constructors, constructors + reader]) {
      const result = analyze(source);
      expect(kinds(result.returns('Read'))).to.deep.equal(['Real']);
      expect(
        result.result.diagnostics.filter((diagnostic) =>
          diagnostic.message.includes('parentField'),
        ),
      ).to.have.length(0);
    }
  });

  it('preinitializes lexically conditional statics and keeps their function namespace', function () {
    const source =
      'function Probe(){return cached; if(false){static cached={value:1};}} function Read(){return Probe.cached.value;}';
    const result = analyze(source);
    expect(kinds(result.returns('Probe'))).to.deep.equal(['Struct']);
    expect(kinds(result.returns('Read'))).to.deep.equal(['Real']);
    expect(
      result.result.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('cached'),
      ),
    ).to.have.length(0);
    expect(
      kinds(
        analyze(
          'function Read(){var fn=function(){static cached=1;}; return fn.cached;}',
        ).returns('Read'),
      ),
    ).to.deep.equal(['Real']);
  });

  it('maps with writes to the evaluated target storage', function () {
    const result = analyze(
      'function Probe(){var target={value:1}; with(target){value="changed"; added=true;} return target.added;}',
    );
    expect(kinds(result.returns('Probe'))).to.deep.equal(['Bool']);
    expect(
      result.result.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('added'),
      ),
    ).to.have.length(0);
    expect(
      result.view.refs.find((reference) => reference.text === 'added')?.isDef,
    ).to.equal(true);
  });

  it('separates numeric addition, string concatenation and invalid mixed inputs', function () {
    expect(
      kinds(analyze('function Probe(){return "a"+"b";}').returns('Probe')),
    ).to.deep.equal(['String']);
    expect(
      kinds(analyze('function Probe(){return 1+2;}').returns('Probe')),
    ).to.deep.equal(['Real']);
    const invalid = analyze('function Probe(){return "a"+2;}');
    expect(
      invalid.result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('String on both sides'),
      ),
    ).to.equal(true);
    expect(kinds(invalid.returns('Probe'))).not.to.include('String');
  });

  it('solves recursive return shapes without an arbitrary pass limit', function () {
    const recursive = analyze('function Tree(){return {next:Tree()};}');
    const shape = recursive.returns('Tree').type[0];
    expect(shape.kind).to.equal('Struct');
    expect(shape.getMember('next')!.type.type[0].kind).to.equal('Struct');
    expect(recursive.result.status).to.equal('complete');
  });

  it('keeps legacy script calls and caller storage available before 2.3', function () {
    const legacy = analyze(
      'stored=argument0; return stored;',
      new Map(),
      '2.2.5.481',
    );
    const script = legacy.result.symbols
      .get(globalKey('test'))!
      .item.getTypeByKind('Function')!;
    expect(script.callKind).to.equal('legacy');
    expect(legacy.result.symbols.has(globalKey('stored'))).to.equal(false);
    expect(script.self!.getMember('stored')).not.to.equal(undefined);
  });

  it('keeps reassigned callable values distinct from their storage declaration', function () {
    const result = analyze(
      'function Probe(){var make=function(){return 1;}; var saved=make; make=function(){return "later";}; return saved();}',
    );
    expect(kinds(result.returns('Probe'))).to.deep.equal(['Real']);
    const constructors = analyze(
      'function Probe(){var Build=function() constructor {first=1;}; var old=new Build(); Build=function() constructor {second=2;}; return old;}',
    );
    const old = constructors.returns('Probe').type[0];
    expect(old.getMember('first')).not.to.equal(undefined);
    expect(old.getMember('second')).to.equal(undefined);
  });

  it('uses defining self for a method reassigned through local storage', function () {
    const result = analyze(
      'function Build() constructor {value=1; var selected=function(){return value;}; selected=function(){return value;}; read=selected;} function Probe(){var item=new Build(); return item.read();}',
    );
    expect(kinds(result.returns('Probe'))).to.deep.equal(['Real']);
  });

  it('evaluates declared functions against completed script startup bindings', function () {
    const result = analyze(
      'function Probe(){return global.item.value;} global.item={value:1};',
    );
    expect(kinds(result.returns('Probe'))).to.deep.equal(['Real']);
  });

  it('keeps imported types and reverse references unchanged during evaluation', function () {
    const shape = Type.Struct.named('Imported');
    shape.semanticKey = 'external:Imported';
    const existing = new Signifier(shape, 'existing', Type.Real);
    existing.semanticKey = 'external:Imported/member:existing';
    existing.replaceDefinition({});
    shape.setOwnMember(existing);
    const factory = native('factory');
    factory.item.getTypeByKind('Function')!.setReturnType(shape);
    const before = fingerprint(shape);
    const result = analyze(
      'function Probe(){var item=factory(); item.added=1; return item.added;}',
      new Map([['factory', factory]]),
    );
    expect(kinds(result.returns('Probe'))).to.deep.equal(['Real']);
    expect(fingerprint(shape)).to.equal(before);
    expect(shape.getMember('added')).to.equal(undefined);
    expect(factory.item.refs.size).to.equal(0);
    expect(existing.refs.size).to.equal(0);
  });

  it('renames quoted struct declarations and literal access keys together', function () {
    const source =
      'function Probe(){var item={"old":1}; return item[$ "old"];}';
    const { view } = analyze(source);
    const references = view.refs.filter(
      (reference) => reference.item.name === 'old',
    );
    const edits = planReferenceRename(references, 'updated', view.refs);
    expect(edits.map((edit) => edit.text)).to.deep.equal([
      '"updated"',
      '"updated"',
    ]);
  });

  it('observes container item inputs and summarizes writes without new declarations', function () {
    const array = new Type('Array');
    array.semanticKey = 'external:values';
    array.items = value();
    const owner = Type.Struct;
    const values = new Signifier(owner, 'values', array);
    values.semanticKey = globalKey('values');
    values.replaceDefinition({});
    const payload = new Signifier(owner, 'payload', Type.Real);
    payload.semanticKey = globalKey('payload');
    payload.replaceDefinition({});
    const external = new Map<string, SymbolView>([
      ['values', { key: values.semanticKey, item: values }],
      ['payload', { key: payload.semanticKey, item: payload }],
    ]);
    const source = 'global.values[0]=global.payload;';
    const first = analyze(source, external).result;
    payload.setType(Type.String);
    const second = analyze(source, external).result;
    expect(first.summary).not.to.equal(second.summary);
    expect(kinds(first.types.get(array.semanticKey)!.items!)).to.deep.equal([
      'Real',
    ]);
    expect(kinds(second.types.get(array.semanticKey)!.items!)).to.deep.equal([
      'String',
    ]);
    array.items = value(Type.Real);
    const reader = analyze(
      'function Read(){return global.values[0];}',
      external,
    );
    expect(kinds(reader.returns('Read'))).to.deep.equal(['Real']);
    expect(
      reader.result.dependencies.some(
        (dependency) =>
          dependency.kind === 'type' &&
          dependency.owner === array.semanticKey &&
          dependency.facet === 'items',
      ),
    ).to.equal(true);
  });

  it('preserves intrinsic identity and readonly metadata after invalid source declarations', function () {
    const item = new Signifier(Type.Struct, 'os_type', Type.Real);
    item.semanticKey = globalKey('os_type');
    item.native = 'Base';
    item.writable = false;
    const result = analyze(
      'globalvar os_type; os_type=1;',
      new Map([['os_type', { key: item.semanticKey, item, intrinsic: true }]]),
    );
    const published = result.result.symbols.get(item.semanticKey)!.item;
    expect(published.native).to.equal('Base');
    expect(published.writable).to.equal(false);
    expect(published.isRenameable).to.equal(false);
    expect(kinds(published.type)).to.deep.equal(['Real']);
    expect(
      result.view.refs
        .filter((reference) => reference.item === published)
        .every((reference) => !reference.isDef),
    ).to.equal(true);
    expect(
      result.result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Cannot redeclare'),
      ),
    ).to.equal(true);
    const documented = analyze(
      '/** @type {String} */\nglobalvar os_type;',
      new Map([['os_type', { key: item.semanticKey, item, intrinsic: true }]]),
    );
    expect(
      kinds(documented.result.symbols.get(item.semanticKey)!.item.type),
    ).to.deep.equal(['Real']);
    const writable = new Signifier(Type.Struct, 'score', Type.Real);
    writable.semanticKey = globalKey('score');
    writable.native = 'Base';
    writable.writable = true;
    expect(
      analyze(
        'score=42;',
        new Map([
          [
            'score',
            { key: writable.semanticKey, item: writable, intrinsic: true },
          ],
        ]),
      ).result.diagnostics,
    ).to.have.length(0);
  });

  it('preserves native instance storage through object-event assignments', function () {
    const nativeSelf = Type.Struct;
    nativeSelf.semanticKey = 'native:instance';
    const id = new Signifier(nativeSelf, 'id', new Type('Id.Instance'));
    id.native = 'Base';
    id.writable = false;
    id.semanticKey = 'native:instance/member:id';
    nativeSelf.setOwnMember(id);
    const x = new Signifier(nativeSelf, 'x', Type.Real);
    x.native = 'Base';
    x.writable = true;
    x.semanticKey = 'native:instance/member:x';
    nativeSelf.setOwnMember(x);
    const self = Type.Struct;
    self.semanticKey = 'object:test:self';
    self.setBaseView(nativeSelf);
    const types = new Map([
      [self.semanticKey, self],
      [nativeSelf.semanticKey, nativeSelf],
    ]);
    const result = analyze(
      'id=1; x=42;',
      new Map(),
      '2024.13.0.0',
      { kind: 'object-event', selfOwner: self.semanticKey },
      types,
    );
    const idRef = result.view.refs.find(
      (reference) => reference.text === 'id',
    )!;
    const xRef = result.view.refs.find((reference) => reference.text === 'x')!;
    expect(idRef.item.native).to.equal('Base');
    expect(idRef.item.writable).to.equal(false);
    expect(idRef.isRenameable).to.equal(false);
    expect(xRef.item.native).to.equal('Base');
    expect(xRef.item.writable).to.equal(true);
    expect(
      result.result.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('read-only'),
      ),
    ).to.have.length(1);
    expect(
      result.result.diagnostics.filter(
        (diagnostic) => diagnostic.origin.spelling.start === 'id=1; '.length,
      ),
    ).to.have.length(0);
  });

  it('checks constructor invocation, immutable writes and finally exits', function () {
    const source =
      'function Build() constructor {} function Plain(){} Build(); new Plain(); enum E{A=1} E.A=2; static invalid=1; function Probe(){try {} finally {return 1;}}';
    const { result } = analyze(source);
    for (const message of [
      'must be called with new',
      'requires a constructor',
      'read-only',
      'inside functions',
      'inside finally',
    ])
      expect(
        result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes(message),
        ),
        message,
      ).to.equal(true);
  });

  it('separates enum compile-time eligibility from inferred runtime literals', function () {
    for (const source of [
      'var input=1; enum E{A=input}',
      'function One(){return 1;} enum E{A=One()}',
      'enum E{A=E.B,B=2}',
    ]) {
      expect(
        analyze(source).result.diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === 'error' &&
            diagnostic.message.includes('compile-time constants'),
        ),
        source,
      ).to.equal(true);
    }
    const external = new Map([
      ['abs', native('abs', 1)],
      ['floor', native('floor', 1)],
      ['ceil', native('ceil', 1)],
      ['round', native('round', 1)],
    ]);
    const result = analyze(
      'enum Previous{A=10} enum E{A=Previous.A*3,B=abs(-4),C=floor(3.9),D=ceil(4.1)}',
      external,
    ).result;
    const shape = result.symbols.get(globalKey('E'))!.item.type.type[0];
    expect(
      ['A', 'B', 'C', 'D'].map(
        (name) => shape.getMember(name)!.type.type[0].literalValue,
      ),
    ).to.deep.equal([30, 4, 3, 5]);
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      ),
    ).to.have.length(0);
    const uncertain = analyze('enum E{A=round(2.5),B}', external).result;
    expect(uncertain.status).to.equal('degraded');
    expect(
      uncertain.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      ),
    ).to.have.length(0);
    expect(
      uncertain.symbols.get(globalKey('E'))!.item.type.type[0].getMember('B')!
        .type.type[0].literalValue,
    ).to.equal(undefined);
  });

  it('folds GML div and int64 bitwise facts without JavaScript int32 truncation', function () {
    const result = analyze(
      'enum E{Quotient=5.1 div 2.9,Complement=~4294967296,Shift=1<<40}',
    ).result;
    const shape = result.symbols.get(globalKey('E'))!.item.type.type[0];
    expect(shape.getMember('Quotient')!.type.type[0].literalValue).to.equal(2);
    expect(shape.getMember('Complement')!.type.type[0].literalValue).to.equal(
      -4294967297,
    );
    expect(shape.getMember('Shift')!.type.type[0].literalValue).to.equal(
      1099511627776,
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      ),
    ).to.have.length(0);
  });

  it('runs do-until bodies before their conditions without inventing zero-iteration exits', function () {
    expect(
      kinds(
        analyze('function Probe(){do{return 42;}until(true);}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Real']);
    expect(
      kinds(
        analyze('function Probe(){do{throw 1;}until(true);return 42;}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Never']);
    expect(
      kinds(
        analyze(
          'function Probe(){var item=undefined;do{item={value:1};continue;}until(true);return item.value;}',
        ).returns('Probe'),
      ),
    ).to.deep.equal(['Real']);
    expect(
      kinds(
        analyze('function Probe(){do{break;}until(false);return 42;}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Real']);
    expect(
      kinds(
        analyze('function Probe(){do{}until(false);return 42;}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Never']);
    for (const condition of ['false', '0.5', '-1'])
      expect(
        kinds(
          analyze(
            `function Probe(){while(${condition}){return "unreachable";}return 1;}`,
          ).returns('Probe'),
        ),
      ).to.deep.equal(['Real']);
  });

  it('evaluates local callable statics through static_get and obeys its selected support set', function () {
    const getter = native('static_get', 1);
    const external = new Map([['static_get', getter]]);
    const source =
      'function Probe(){var counter=function(){static count=0;};return static_get(counter).count;}';
    expect(kinds(analyze(source, external).returns('Probe'))).to.deep.equal([
      'Real',
    ]);
    getter.item
      .getTypeByKind('Function')!
      .getParameter(0)!
      .setType(Type.Struct);
    const older = analyze(source, external);
    expect(
      older.result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('does not support static_get on functions'),
      ),
    ).to.equal(true);
    expect(kinds(older.returns('Probe'))).not.to.deep.equal(['Real']);
  });

  it('gates 2.3 chained accessors and function statics while retaining legacy array syntax', function () {
    const invalid = analyze(
      'static count=0;var values;return values[0][1];',
      new Map(),
      '2.2.5.481',
    ).result;
    expect(
      invalid.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Chained accessors are unavailable'),
      ),
    ).to.equal(true);
    expect(
      invalid.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Static variables are unavailable'),
      ),
    ).to.equal(true);
    const legacy = analyze(
      'var values;return values[0,1];',
      new Map(),
      '2.2.5.481',
    ).result;
    expect(
      legacy.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('unavailable'),
      ),
    ).to.equal(false);
    const deletion = 'var item; delete item;';
    expect(
      analyze(deletion, new Map(), '2.2.5.481').result.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('delete operator is unavailable'),
      ),
    ).to.equal(true);
    expect(
      analyze(deletion, new Map(), '2.3.0.401').result.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('delete operator is unavailable'),
      ),
    ).to.equal(false);
  });

  it('checks both nullish operators at the documented 2.3.7 release boundary', function () {
    const source = 'var item=undefined; item ??= 1; var result=item ?? 2;';
    const before = analyze(source, new Map(), '2.3.6.464').result;
    expect(
      before.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('Nullish operators are unavailable'),
      ),
    ).to.have.length(2);
    const supported = analyze(source, new Map(), '2.3.7.474').result;
    expect(
      supported.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('Nullish operators are unavailable'),
      ),
    ).to.have.length(0);
  });

  it('creates independently rebound method values without changing the original callable', function () {
    const external = new Map([['method', native('method', 2)]]);
    const result = analyze(
      'function Build()constructor{value=1;read=function(){return value;};} function Probe(){var item=new Build();var saved=item.read;var first=method({value:"text"},saved);var second=method({value:true},saved);return [first(),second(),saved()];}',
      external,
    );
    const functionValue = (name: string) =>
      result.view.refs
        .find((reference) => reference.isDef && reference.item.name === name)!
        .item.getTypeByKind('Function')!;
    const saved = functionValue('saved'),
      first = functionValue('first'),
      second = functionValue('second');
    expect(first).not.to.equal(saved);
    expect(second).not.to.equal(first);
    expect(first.methodSource).to.equal(saved);
    expect(second.methodSource).to.equal(saved);
    expect(kinds(saved.returns!)).to.deep.equal(['Real']);
    expect(kinds(first.returns!)).to.deep.equal(['String']);
    expect(kinds(second.returns!)).to.deep.equal(['Bool']);
    expect(kinds(saved.self!.getMember('value')!.type)).to.deep.equal(['Real']);
    expect(kinds(result.returns('Probe').type[0].items!)).to.deep.equal([
      'Bool',
      'Real',
      'String',
    ]);
    const currentSelf = analyze(
      'function Build()constructor{value=1;read=method(undefined,function(){return value;});}function Probe(){var item=new Build();return item.read();}',
      external,
    );
    expect(kinds(currentSelf.returns('Probe'))).to.deep.equal(['Real']);
  });

  it('applies rebound self writes at invocation and keeps ambiguous definitions unrenameable', function () {
    const external = new Map([['method', native('method', 2)]]);
    const source =
      'function Write(){created=1;}function Probe(){var target={};var write=method(target,Write);write();return target.created;}';
    const result = analyze(source, external);
    expect(kinds(result.returns('Probe'))).to.deep.equal(['Real']);
    const use = result.view.refs.find(
      (reference) => reference.start.offset === source.lastIndexOf('created'),
    )!;
    expect(use.rename?.kind).to.equal('none');
    const beforeCall = analyze(source.replace('write();', ''), external);
    expect(
      beforeCall.result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('created'),
      ),
    ).to.equal(true);
  });

  it('specializes imported callable bodies and invalidates when self-dependent code changes', function () {
    const provider = analyze(
      'function Read(){return value;}',
      new Map(),
      '2024.13.0.0',
      {},
      new Map(),
      'provider.gml',
    );
    const imported = provider.result.symbols.get(globalKey('Read'))!;
    const original = fingerprint(imported.item.type);
    const external = new Map<string, SymbolView>([
      ['Read', imported],
      ['method', native('method', 2)],
    ]);
    const consumer = analyze(
      'function Probe(){var read=method({value:"bound"},Read);return read();}',
      external,
      '2024.13.0.0',
      {},
      new Map(provider.result.types),
      'consumer.gml',
    );
    expect(kinds(consumer.returns('Probe'))).to.deep.equal(['String']);
    expect(fingerprint(imported.item.type)).to.equal(original);
    expect(
      consumer.result.dependencies.some(
        (dependency) =>
          dependency.owner ===
            imported.item.getTypeByKind('Function')!.semanticKey &&
          dependency.facet === 'returns',
      ),
    ).to.equal(true);
    const changed = analyze(
      'function Read(){return otherValue;}',
      new Map(),
      '2024.13.0.0',
      {},
      new Map(),
      'provider.gml',
    );
    expect(changed.result.summary).not.to.equal(provider.result.summary);
  });

  it('preserves readable metadata and checks reads separately from writes and fallback evidence', function () {
    const output = new Signifier(Type.Struct, 'output', Type.Real);
    output.native = 'Fixture';
    output.semanticKey = globalKey('output');
    output.readable = false;
    output.writable = true;
    const external = new Map<string, SymbolView>([
      ['output', { key: output.semanticKey, item: output, intrinsic: true }],
    ]);
    const written = analyze('output=1;', external);
    expect(written.result.diagnostics).to.have.length(0);
    expect(
      written.result.symbols.get(output.semanticKey)!.item.readable,
    ).to.equal(false);
    expect(
      written.result.symbols.get(output.semanticKey)!.item.writable,
    ).to.equal(true);
    expect(
      written.result.symbols.get(output.semanticKey)!.item.isRenameable,
    ).to.equal(false);
    const read = analyze('var copy=output;', external);
    expect(
      read.result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.message.includes('unreadable') &&
          diagnostic.severity === 'error',
      ),
    ).to.have.length(1);
    const compound = analyze('output+=1;', external);
    expect(
      compound.result.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('unreadable'),
      ),
    ).to.have.length(1);
    const language = new LanguageProfile({
      runtimeVersion: '2024.13.0.0',
      specSources: [
        {
          path: '/fallback/GmlSpec.xml',
          runtime: '2022.4',
          module: 'Base',
          bundled: true,
          sha256: 'fixture',
        },
      ],
    });
    const fallback = analyze('var copy=output;', external, '2024.13.0.0', {
      language,
    });
    expect(fallback.result.status).to.equal('degraded');
    expect(
      fallback.result.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('availability is unverified') &&
          diagnostic.severity === 'info',
      ),
    ).to.equal(true);
    expect(
      fallback.result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      ),
    ).to.have.length(0);
    output.writable = false;
    const reserved = analyze('globalvar output;', external).result.symbols.get(
      output.semanticKey,
    )!.item;
    expect(reserved.readable).to.equal(false);
    expect(reserved.writable).to.equal(false);
    expect(reserved.native).to.equal('Fixture');
  });

  it('nullish effects skip RHS methods for definite non-nullish values', function () {
    const external = new Map([['method', native('method', 2)]]);
    for (const initial of ['0', 'false', '""', 'pointer_invalid'])
      for (const operator of ['??', '??=']) {
        const operation =
          operator === '??'
            ? 'var result=left ?? update();'
            : 'left ??= update();';
        const source = `function Probe(){var receiver={value:"kept"};var update=method(receiver,function(){value=1;return 2;});var left=${initial};${operation}return receiver.value;}`;
        expect(
          kinds(analyze(source, external).returns('Probe')),
          `${initial} ${operator}`,
        ).to.deep.equal(['String']);
      }
  });

  it('nullish effects execute RHS methods for definite nullish values', function () {
    const external = new Map([['method', native('method', 2)]]);
    for (const initial of ['undefined', 'pointer_null'])
      for (const operator of ['??', '??=']) {
        const operation =
          operator === '??'
            ? 'var result=left ?? update();'
            : 'left ??= update();';
        const source = `function Probe(){var receiver={value:"kept"};var update=method(receiver,function(){value=1;return 2;});var left=${initial};${operation}return receiver.value;}`;
        expect(
          kinds(analyze(source, external).returns('Probe')),
          `${initial} ${operator}`,
        ).to.deep.equal(['Real']);
      }
  });

  it('nullish effects retain both feasible RHS paths for unknown values', function () {
    const external = new Map([['method', native('method', 2)]]);
    for (const operation of [
      'var result=left ?? update();',
      'left ??= update();',
    ]) {
      const source = `function Probe(left){var receiver={value:"kept"};var update=method(receiver,function(){value=1;return 2;});${operation}return receiver.value;}`;
      expect(
        kinds(analyze(source, external).returns('Probe')),
        operation,
      ).to.deep.equal(['Real', 'String']);
    }
  });

  it('nullish effects capture the original lvalue before an RHS method changes its receiver', function () {
    const external = new Map([['method', native('method', 2)]]);
    for (const target of [
      'controller.target.slot',
      'controller.target[$ "slot"]',
    ]) {
      const source = `function Probe(){var first={slot:undefined};var replacement={slot:1};var controller={target:first,replacement:replacement};var redirect=method(controller,function(){target=replacement;return replacement;});${target} ??= redirect();return first.slot;}`;
      expect(
        kinds(analyze(source, external).returns('Probe')),
        target,
      ).to.deep.equal(['Struct']);
    }
  });

  it('nullish effects apply inheritance and mixin input only on executable RHS paths', function () {
    const inherited = new Map([['event_inherited', native('event_inherited')]]);
    for (const initial of ['0', 'undefined'])
      for (const operator of ['??', '??=']) {
        const operation =
          operator === '??'
            ? 'var result=left ?? event_inherited();'
            : 'left ??= event_inherited();';
        expect(
          analyze(`var left=${initial};${operation}`, inherited).result
            .callsSuper,
          `${initial} ${operator}`,
        ).to.equal(initial === 'undefined');
      }
    const install = native('install');
    install.item.mixin = true;
    const added = Type.Struct;
    added.semanticKey = 'fixture:mixin';
    const member = new Signifier(added, 'installed', Type.Real);
    member.semanticKey = 'fixture:mixin/member:installed';
    member.replaceDefinition({});
    added.setOwnMember(member);
    install.item.getTypeByKind('Function')!.self = added;
    for (const initial of ['0', 'undefined']) {
      const result = analyze(
        `var result=${initial} ?? install();`,
        new Map([['install', install]]),
      ).result;
      expect(
        !!result.types.get('global')!.getMember('installed'),
        initial,
      ).to.equal(initial === 'undefined');
    }
  });

  it('nullish effects do not create a member through a skipped accessor increment', function () {
    const source =
      'var result=0 ?? global.phantom++; var observed=global.phantom;';
    const result = analyze(source);
    const read = result.view.refs.find(
      (reference) => reference.start.offset === source.lastIndexOf('phantom'),
    )!;
    expect(read.item.def).to.equal(undefined);
    expect(
      result.result.diagnostics.some(
        (diagnostic) =>
          diagnostic.origin.spelling.start === source.lastIndexOf('phantom') &&
          diagnostic.message.includes('Undeclared'),
      ),
    ).to.equal(true);
  });

  it('preserves resource-field provenance through GML writes and releases it after the input is removed', function () {
    const owner = 'object:test:self';
    const self = Type.Struct;
    self.semanticKey = owner;
    const setting = new Signifier(self, 'setting', Type.Real);
    setting.semanticKey = `${owner}/member:setting`;
    setting.instance = true;
    setting.replaceDefinition({});
    setting.resourceDefinition = {
      kind: 'object-variable',
      unitId: '$resources',
      uri: 'objects/Parent/Parent.yy',
      name: 'setting',
    };
    self.setOwnMember(setting);
    const source = 'var before=setting; setting="updated"; var after=setting;';
    const uri = 'resource-field.gml';
    const { bound } = analyze(
      source,
      new Map(),
      '2024.13.0.0',
      { kind: 'object-event', selfOwner: owner, definitiveSelf: true },
      new Map(),
      uri,
    );
    const file = { path: pathy(uri), content: source } as Code;
    const sourceHost = (requested: string) =>
      requested === uri ? { file, text: source } : undefined;
    const index = new ContributionIndex();
    index.replace(
      '$resources',
      collectInputContribution('$resources', new Map([[owner, self]])),
    );
    const evaluate = () => {
      const input = new ContributionGraph(
        index,
        sourceHost,
        uri,
        createDeclarationSummary(bound),
      );
      const environment: SemanticEnvironment = {
        lookup: ({ owner, name }) => input.lookup(owner, name),
        type: (key) =>
          input.typeSources(key).length || input.namedType(key)
            ? input.type(key)
            : undefined,
        observe: () => {},
        cancelled: () => false,
      };
      const evaluated = evaluateUnit(bound, environment);
      index.replace(uri, evaluated);
      const graph = new ContributionGraph(index, sourceHost).complete();
      return { evaluated, graph, view: materializeUnit(evaluated, graph) };
    };
    const initial = evaluate();
    const references = initial.view.refs.filter(
      (reference) => reference.item.name === 'setting',
    );
    expect(
      kinds(
        references.find(
          (reference) => reference.start.offset === source.indexOf('setting'),
        )!.evaluatedType!,
      ),
    ).to.deep.equal(['Real']);
    expect(
      kinds(
        references.find(
          (reference) =>
            reference.start.offset === source.lastIndexOf('setting'),
        )!.evaluatedType!,
      ),
    ).to.deep.equal(['String']);
    expect(
      references.every(
        (reference) =>
          !reference.isDef &&
          !reference.isRenameable &&
          reference.rename?.kind === 'none',
      ),
    ).to.equal(true);
    expect(() =>
      planReferenceRename(references, 'renamed', initial.view.refs),
    ).to.throw('no safe source edit');
    const published = initial.graph.symbol(setting.semanticKey);
    expect(published.resourceDefinition).to.deep.equal(
      setting.resourceDefinition,
    );
    expect(published.native).to.equal(undefined);
    expect(published.writable).to.equal(true);
    expect(published.def?.file).to.equal(undefined);
    expect(setting.type.type[0].kind).to.equal('Real');

    const remaining = Type.Struct;
    remaining.semanticKey = owner;
    index.replace(
      '$resources',
      collectInputContribution('$resources', new Map([[owner, remaining]])),
    );
    // Stale source copies do not own the YY declaration, even before reevaluation.
    expect(
      new ContributionGraph(index, sourceHost).symbol(setting.semanticKey)
        .resourceDefinition,
    ).to.equal(undefined);
    const changed = evaluate();
    const current = changed.view.refs.filter(
      (reference) => reference.item.name === 'setting',
    );
    expect(
      changed.graph.symbol(setting.semanticKey).resourceDefinition,
    ).to.equal(undefined);
    expect(current.every((reference) => reference.isRenameable)).to.equal(true);
    expect(
      planReferenceRename(current, 'renamed', changed.view.refs),
    ).to.have.length(3);
  });

  it('copies resource provenance as metadata and fingerprints ownership-only changes', function () {
    const owner = Type.Struct;
    owner.semanticKey = 'object:fixture:self';
    const field = new Signifier(owner, 'field', Type.Real);
    field.replaceDefinition({});
    owner.setOwnMember(field);
    field.resourceDefinition = {
      kind: 'object-variable',
      unitId: '$resources',
      uri: 'objects/First/First.yy',
      name: 'field',
    };
    expect(field.copy().resourceDefinition).to.deep.equal(
      field.resourceDefinition,
    );
    const copy = new Signifier(owner, field.name);
    copy.replaceMetadata(field, value(Type.String));
    expect(copy.resourceDefinition).to.deep.equal(field.resourceDefinition);
    expect(copy.isRenameable).to.equal(false);
    const before = fingerprint(owner);
    field.resourceDefinition = {
      ...field.resourceDefinition,
      uri: 'objects/Second/Second.yy',
    };
    expect(fingerprint(owner)).not.to.equal(before);
    const ordinary = new Signifier(owner, 'field', Type.Real);
    ordinary.replaceDefinition({});
    copy.replaceMetadata(ordinary, value(ordinary.type));
    expect(copy.resourceDefinition).to.equal(undefined);
    expect(copy.isRenameable).to.equal(true);
  });

  it('retains the real Recovery sample enum receiver at the point after its dangling dot', function () {
    const provider = analyze(
      'enum SurpriseEnum { surprise, another_surprise }',
      new Map(),
      '2024.13.0.0',
      {},
      new Map(),
      'enum.gml',
    );
    const external = new Map([
      ['SurpriseEnum', provider.result.symbols.get(globalKey('SurpriseEnum'))!],
    ]);
    const sample = readFileSync(
      new URL(
        '../../samples/project/scripts/Recovery/Recovery.gml',
        import.meta.url,
      ),
      'utf8',
    );
    for (const source of [
      sample,
      sample.trimEnd(),
      sample.replace(/\r?\n/g, '\r\n'),
    ]) {
      const analysis = analyze(
        source,
        external,
        '2024.13.0.0',
        {},
        new Map(provider.result.types),
        'recovery.gml',
        1,
      );
      const code = queryCode(analysis);
      const cursor = source.indexOf('SurpriseEnum.') + 'SurpriseEnum.'.length;
      const scope = code.getScopeRangeAt(3, 22)!;
      expect(scope.isDotAccessor).to.equal(true);
      expect(scope.self.kind).to.equal('Enum');
      expect([scope.start.offset, scope.end.offset]).to.deep.equal([
        cursor - 1,
        cursor,
      ]);
      expect(code.getScopeRangeAt(cursor)).to.equal(scope);
      expect(
        code
          .getInScopeSymbolsAt(3, 22)
          .map((item) => item.name)
          .sort(),
      ).to.deep.equal(['another_surprise', 'surprise']);
      expect(
        code
          .getInScopeSymbolsAt(cursor)
          .map((item) => item.name)
          .sort(),
      ).to.deep.equal(['another_surprise', 'surprise']);
      expect(code.getScopeRangeAt(3, 10)!.isDotAccessor).to.equal(false);
      if (source.endsWith('\n'))
        expect(code.getScopeRangeAt(4, 1)!.isDotAccessor).to.equal(false);
      expect(
        analysis.view.refs.some((reference) => reference.item.name === ''),
      ).to.equal(false);
      expect(analysis.result.diagnostics).to.have.length(0);
      const declaration =
        analysis.bound.syntax.root.kind === 'block'
          ? analysis.bound.syntax.root.statements.find(
              (statement) => statement.kind === 'declarations',
            )
          : undefined;
      const access =
        declaration?.kind === 'declarations'
          ? declaration.declarations[0].value
          : undefined;
      expect(access?.kind).to.equal('member');
      if (access?.kind === 'member') {
        expect([access.name.start, access.name.end]).to.deep.equal([
          cursor,
          cursor,
        ]);
        expect(access.name.origin.editable).to.equal(false);
      }
    }
  });

  it('includes the caret after a typed member without extending references or leaking scope into the next statement', function () {
    for (const name of ['first', 'fi']) {
      const source = `enum E{first,second} var value=E.${name}; var later=1;`;
      const analysis = analyze(source);
      const code = queryCode(analysis);
      const start = source.indexOf(`E.${name}`) + 2;
      const cursor = start + name.length;
      expect(
        code
          .getInScopeSymbolsAt(cursor)
          .map((item) => item.name)
          .sort(),
      ).to.deep.equal(['first', 'second']);
      const reference = analysis.view.refs.find(
        (entry) => entry.start.offset === start,
      )!;
      expect(reference.text).to.equal(name);
      expect(reference.end.offset).to.equal(cursor - 1);
      expect(
        code.getScopeRangeAt(source.indexOf('later'))!.isDotAccessor,
      ).to.equal(false);
    }
  });

  it('keeps the last receiver in an unfinished chained member access', function () {
    const source = 'var holder={inner:{leaf:1}}; holder.inner.';
    const analysis = analyze(
      source,
      new Map(),
      '2024.13.0.0',
      {},
      new Map(),
      'chain.gml',
      1,
    );
    const code = queryCode(analysis);
    expect(
      code.getInScopeSymbolsAt(source.length).map((item) => item.name),
    ).to.deep.equal(['leaf']);
    expect(analysis.result.diagnostics).to.have.length(0);
    expect(
      [...analysis.result.symbols.values()].some(
        (symbol) => symbol.item.name === '',
      ),
    ).to.equal(false);
  });

  it('keeps unknown receiver completion inside an empty dot boundary', function () {
    for (const source of [
      'function visibleGlobal(){} missing.',
      'function visibleGlobal(){} function Probe(receiver){receiver.}',
    ]) {
      const analysis = analyze(
        source,
        new Map(),
        '2024.13.0.0',
        {},
        new Map(),
        'unknown-receiver.gml',
        1,
      );
      const code = queryCode(analysis);
      const cursor = source.lastIndexOf('.') + 1;
      expect(code.getScopeRangeAt(cursor)!.isDotAccessor).to.equal(true);
      expect(code.getInScopeSymbolsAt(cursor)).to.have.length(0);
      expect(code.getCompletionCandidatesAt(cursor)).to.have.length(0);
      expect(code.getInScopeSymbolsAt(0).map((item) => item.name)).to.include(
        'visibleGlobal',
      );
    }
  });

  it('aggregates all union member names, values and branch coverage independently of branch order', function () {
    const alternatives = ['{a:1,common:1}', '{b:2,common:"text"}'];
    for (const branches of [alternatives, [...alternatives].reverse()]) {
      const source = `function Probe(flag){var receiver=flag?${branches[0]}:${branches[1]};receiver.common;}`;
      const analysis = analyze(source);
      const code = queryCode(analysis);
      const cursor = source.lastIndexOf('receiver.') + 'receiver.'.length;
      const scope = code.getScopeRangeAt(cursor)!;
      expect(scope.isDotAccessor).to.equal(true);
      expect(scope.dotReceivers).to.have.length(2);
      expect(
        analysis.view.scopes.filter(
          (entry) =>
            entry.isDotAccessor &&
            entry.start.offset === scope.start.offset &&
            entry.end.offset === scope.end.offset,
        ),
      ).to.have.length(1);
      const candidates = code.getCompletionCandidatesAt(cursor);
      expect(candidates.map((candidate) => candidate.name)).to.deep.equal([
        'a',
        'b',
        'common',
      ]);
      expect(
        candidates.map((candidate) => candidate.availability),
      ).to.deep.equal([
        { present: 1, total: 2 },
        { present: 1, total: 2 },
        { present: 2, total: 2 },
      ]);
      const common = candidates.find(
        (candidate) => candidate.name === 'common',
      )!;
      expect(kinds(common.type)).to.deep.equal(['Real', 'String']);
      expect(common.symbols).to.have.length(2);
      const references = analysis.view.refs.filter(
        (reference) => reference.start.offset === cursor,
      );
      expect(common.symbols).to.have.members(
        references.map((reference) => reference.item),
      );
      expect(
        code
          .getReferenceCandidatesAt(cursor)
          .map((reference) => reference.item),
      ).to.have.members(common.symbols);
      expect(code.getReferenceAt(cursor)).to.equal(undefined);
      expect(common.symbols.every((symbol) => !!symbol.def?.file)).to.equal(
        true,
      );
      expect(code.getInScopeSymbolsAt(cursor)).to.have.members(
        candidates.flatMap((candidate) => candidate.symbols),
      );
      expect(() =>
        planReferenceRename(
          analysis.view.refs.filter(
            (reference) => reference.item === common.symbols[0],
          ),
          'renamed',
          analysis.view.refs,
        ),
      ).to.throw('ambiguous');
    }
  });

  it('preserves a union dot boundary at LF, CRLF and EOF recovery positions', function () {
    const prefix = 'var receiver=flag?{a:1,common:1}:{b:2,common:"text"};';
    for (const ending of ['', '\n', '\r\n']) {
      const source = `${prefix}receiver.${ending}`;
      const analysis = analyze(
        source,
        new Map(),
        '2024.13.0.0',
        {},
        new Map(),
        'union-recovery.gml',
        1,
      );
      const code = queryCode(analysis);
      const cursor = prefix.length + 'receiver.'.length;
      const scope = code.getScopeRangeAt(cursor)!;
      expect(scope.isDotAccessor).to.equal(true);
      expect([scope.start.offset, scope.end.offset]).to.deep.equal([
        cursor - 1,
        cursor,
      ]);
      expect(
        code
          .getCompletionCandidatesAt(1, cursor + 1)
          .map((candidate) => candidate.name),
      ).to.deep.equal(['a', 'b', 'common']);
      if (ending)
        expect(code.getScopeRangeAt(2, 1)!.isDotAccessor).to.equal(false);
      expect(
        analysis.view.refs.some((reference) => reference.item.name === ''),
      ).to.equal(false);
    }
  });

  it('counts inherited shared identities by receiver coverage and respects overriding members', function () {
    for (const branches of [
      'new First():new Second()',
      'new Second():new First()',
    ]) {
      const source =
        'function Base() constructor {common=1;static overrideValue=1;}' +
        'function First():Base() constructor {a=1;static overrideValue="first";}' +
        'function Second():Base() constructor {b=2;}' +
        `function Probe(flag){var receiver=flag?${branches};receiver.common;}`;
      const analysis = analyze(source);
      const code = queryCode(analysis);
      const cursor = source.lastIndexOf('receiver.') + 'receiver.'.length;
      const candidates = code.getCompletionCandidatesAt(cursor);
      const common = candidates.find(
        (candidate) => candidate.name === 'common',
      )!;
      expect(common.symbols).to.have.length(1);
      expect(common.availability).to.deep.equal({ present: 2, total: 2 });
      const overridden = candidates.find(
        (candidate) => candidate.name === 'overrideValue',
      )!;
      expect(overridden.symbols).to.have.length(2);
      expect(overridden.availability).to.deep.equal({ present: 2, total: 2 });
      expect(kinds(overridden.type)).to.deep.equal(['Real', 'String']);
      expect(
        candidates.find((candidate) => candidate.name === 'a')!.availability,
      ).to.deep.equal({ present: 1, total: 2 });
      expect(
        candidates.find((candidate) => candidate.name === 'b')!.availability,
      ).to.deep.equal({ present: 1, total: 2 });
    }
  });

  it('includes unknown and non-member alternatives in coverage without leaking lexical names', function () {
    for (const unknown of ['unknownReceiver', 'undefined', '5']) {
      for (const branches of [`{known:1}:${unknown}`, `${unknown}:{known:1}`]) {
        const source = `function visibleGlobal(){} function Probe(flag,unknownReceiver){var localOnly=1;var receiver=flag?${branches};receiver.}`;
        const analysis = analyze(
          source,
          new Map(),
          '2024.13.0.0',
          {},
          new Map(),
          'partial-receiver.gml',
          1,
        );
        const code = queryCode(analysis);
        const cursor = source.lastIndexOf('.') + 1;
        const candidates = code.getCompletionCandidatesAt(cursor);
        expect(candidates.map((candidate) => candidate.name)).to.deep.equal([
          'known',
        ]);
        expect(candidates[0].availability).to.deep.equal({
          present: 1,
          total: 2,
        });
        expect(
          code.getInScopeSymbolsAt(cursor).map((symbol) => symbol.name),
        ).to.deep.equal(['known']);
      }
    }
  });

  it('snapshots member flow values for completion before subsequent writes', function () {
    const source =
      'function Probe(){var holder={field:1};holder.field="current";holder.field;holder.field=true;}';
    const analysis = analyze(source);
    const code = queryCode(analysis);
    const cursor = source.indexOf('holder.field;') + 'holder.'.length;
    const candidate = code
      .getCompletionCandidatesAt(cursor)
      .find((entry) => entry.name === 'field')!;
    expect(kinds(candidate.type)).to.deep.equal(['String']);
    expect(kinds(candidate.symbols[0].type)).to.deep.equal([
      'Bool',
      'Real',
      'String',
    ]);
    expect(candidate.availability).to.deep.equal({ present: 1, total: 1 });
  });

  it('keeps global dot filtering and ordinary lexical precedence in the candidate API', function () {
    const source =
      'enum VisibleEnum {entry} globalvar stored; stored=1; function VisibleFunction(){} function Probe(){var stored="local";global.stored;stored;}';
    const analysis = analyze(source);
    const code = queryCode(analysis);
    const dot = source.indexOf('global.stored') + 'global.'.length;
    const candidates = code.getCompletionCandidatesAt(dot);
    expect(candidates.map((candidate) => candidate.name)).not.to.include(
      'VisibleEnum',
    );
    expect(
      candidates.find((candidate) => candidate.name === 'stored')!.symbols[0],
    ).to.equal(analysis.result.symbols.get(globalKey('stored'))!.item);
    const lexical = code.getCompletionCandidatesAt(
      source.lastIndexOf('stored;'),
    );
    expect(lexical.map((candidate) => candidate.name)).to.deep.equal(
      code
        .getInScopeSymbolsAt(source.lastIndexOf('stored;'))
        .map((symbol) => symbol.name),
    );
    expect(
      lexical.find((candidate) => candidate.name === 'stored')!.symbols[0]
        .local,
    ).to.equal(true);
    expect(
      lexical.every(
        (candidate) =>
          candidate.availability.present === 1 &&
          candidate.availability.total === 1,
      ),
    ).to.equal(true);
  });

  it('consumes with break and continue without terminating the function or an enclosing loop', function () {
    for (const control of ['break', 'continue']) {
      const direct = analyze(
        `function Probe(){with({value:1}){${control};}return "after";}`,
      );
      expect(kinds(direct.returns('Probe')), control).to.deep.equal(['String']);
      expect(direct.result.diagnostics).to.have.length(0);
      const nested = analyze(
        `function Probe(){while(true){with({}){${control};}return 1;}return "outer";}`,
      );
      expect(kinds(nested.returns('Probe')), control).to.deep.equal(['Real']);
      expect(nested.result.diagnostics).to.have.length(0);
      const invalid = analyze(`function Probe(){${control};}`);
      expect(
        invalid.result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes('requires an enclosing loop'),
        ),
      ).to.equal(true);
      const localFunction = analyze(
        `function Probe(){with({}){var callback=function(){${control};};}}`,
      );
      expect(
        localFunction.result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes('requires an enclosing loop'),
        ),
      ).to.equal(true);
    }
  });

  it('keeps return throw and exit abrupt through a single-target with', function () {
    expect(
      kinds(
        analyze('function Probe(){with({}){return 1;}return "after";}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Real']);
    expect(
      kinds(
        analyze('function Probe(){with({}){throw 1;}return "after";}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Never']);
    expect(
      kinds(
        analyze('function Probe(){with({}){exit;}return "after";}').returns(
          'Probe',
        ),
      ),
    ).to.deep.equal(['Undefined']);
    const effects = analyze(
      'function Probe(){var state="initial";with({}){state=1;continue;state=true;}return state;}',
    );
    expect(kinds(effects.returns('Probe'))).to.deep.equal(['Real']);
    expect(effects.result.diagnostics).to.have.length(0);
    const other = analyze(
      'function Probe(){var outer={value:"outer"};with(outer){with({value:1}){return other.value;}}return false;}',
    );
    expect(kinds(other.returns('Probe'))).to.deep.equal(['String']);
    expect(other.result.diagnostics).to.have.length(0);
    const restored = analyze(
      'function Probe(){var outer={value:"outer"};with(outer){with({value:1}){break;}return value;}return false;}',
    );
    expect(kinds(restored.returns('Probe'))).to.deep.equal(['String']);
    expect(restored.result.diagnostics).to.have.length(0);
  });

  it('models noone as zero targets through aliases and optional struct targets', function () {
    for (const target of ['noone', '-4']) {
      const empty = analyze(
        `function Probe(){var target=${target};var state="initial";with(target){state=1;return false;}return state;}`,
      );
      expect(kinds(empty.returns('Probe')), target).to.deep.equal(['String']);
      expect(empty.result.diagnostics).to.have.length(0);
    }
    for (const other of ['all', '{value:1}'])
      for (const alternatives of [`noone:${other}`, `${other}:noone`]) {
        const optional = analyze(
          `function Probe(flag){var target=flag?${alternatives};with(target){return 1;}return "after";}`,
        );
        expect(kinds(optional.returns('Probe')), alternatives).to.deep.equal([
          'Real',
          'String',
        ]);
        expect(optional.result.diagnostics).to.have.length(0);
        const target = optional.view.refs.find(
          (reference) => reference.isDef && reference.item.name === 'target',
        )!;
        expect(
          new Set(target.evaluatedType!.type.map((type) => type.semanticKey))
            .size,
        ).to.equal(2);
        if (other === 'all')
          expect(
            target.evaluatedType!.type.map((type) => type.literalValue).sort(),
          ).to.deep.equal([-3, -4]);
      }
    for (const name of ['noone', 'all']) {
      const property = analyze(
        `function Probe(){var holder={"${name}":{value:1}};with(holder[$ "${name}"]){return 1;}return "after";}`,
      );
      expect(kinds(property.returns('Probe')), name).to.deep.equal(['Real']);
      expect(property.result.diagnostics).to.have.length(0);
    }
  });

  it('models instance targets once and object assets as zero or multiple iterations', function () {
    const targets = new Map<string, SymbolView>();
    const types = new Map<string, Type>();
    for (const [name, kind] of [
      ['instance', 'Id.Instance'],
      ['objectAsset', 'Asset.GMObject'],
      ['all', 'Id.Instance'],
    ] as const) {
      const shape = Type.Struct;
      shape.semanticKey = `fixture:${name}:self`;
      types.set(shape.semanticKey, shape);
      const marker = new Signifier(shape, 'marker', Type.Bool);
      marker.semanticKey = `${shape.semanticKey}/member:marker`;
      marker.native = 'Fixture';
      shape.setOwnMember(marker);
      const type = new Type(kind);
      type.semanticKey = `fixture:${name}`;
      type.setBaseView(shape);
      types.set(type.semanticKey, type);
      const item = new Signifier(Type.Struct, name, type);
      item.native = 'Fixture';
      item.semanticKey = globalKey(name);
      targets.set(name, { key: item.semanticKey, item });
    }
    for (const target of ['instance', 'objectAsset', 'all']) {
      const source = `function Probe(){var target=${target};with(target){return 1;}return "after";}`;
      const result = analyze(source, targets, '2024.13.0.0', {}, types);
      expect(kinds(result.returns('Probe')), target).to.deep.equal(
        target === 'instance' ? ['Real'] : ['Real', 'String'],
      );
      expect(result.result.diagnostics).to.have.length(0);
    }
    const nativeAll = analyze(
      'function Probe(){with(all){return marker;}return "after";}',
      targets,
      '2024.13.0.0',
      {},
      types,
    );
    expect(kinds(nativeAll.returns('Probe'))).to.deep.equal(['Bool', 'String']);
    expect(
      nativeAll.view.refs.find((reference) => reference.text === 'all')!.item,
    ).to.equal(targets.get('all')!.item);
    expect(nativeAll.result.diagnostics).to.have.length(0);
    const repeated = analyze(
      'function Probe(){var previous="initial";var next=1;with(all){previous=next;next=true;continue;}return previous;}',
    );
    expect(kinds(repeated.returns('Probe'))).to.deep.equal([
      'Bool',
      'Real',
      'String',
    ]);
    expect(repeated.result.diagnostics).to.have.length(0);
    const stopped = analyze(
      'function Probe(){var previous="initial";var next=1;with(all){previous=next;next=true;break;}return previous;}',
    );
    expect(kinds(stopped.returns('Probe'))).to.deep.equal(['Real', 'String']);
    expect(stopped.result.diagnostics).to.have.length(0);
  });
});
