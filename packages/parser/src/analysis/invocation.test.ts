import { expect } from 'chai';
import { LanguageProfile } from '../language/version.js';
import { DependencyIndex } from '../language/dependencies.js';
import { GmlParser } from '../parser.js';
import { Signifier } from '../signifiers.js';
import { SourceMap } from '../syntax/source.js';
import { Type } from '../types.js';
import { bindUnit } from './binding.js';
import { evaluateUnit } from './evaluation.js';
import {
  globalKey,
  globalOwner,
  nativeGlobalKey,
  nativeGlobalOwner,
  implementationKey,
  type SemanticEnvironment,
} from './model.js';
import { normalizeSyntax } from './syntax.js';
import { value } from './values.js';

function analyze(
  text: string,
  legacyOtherBehaviour?: boolean,
  onStep?: () => void,
  external: Partial<SemanticEnvironment> = {},
  uri = 'invocation.gml',
) {
  const parsed = new GmlParser().parse(text);
  expect(parsed.errors).to.have.length(0);
  const source = new SourceMap({ uri, text });
  const syntax = normalizeSyntax({
    unitId: uri,
    text,
    cst: parsed.cst,
    origin: (start, end) => source.origin(start, end),
  });
  const bound = bindUnit(syntax, {
    unitId: uri,
    assetId: 'fixture',
    assetName: 'fixture',
    kind: 'script',
    definitiveSelf: false,
    legacyOtherBehaviour,
    language: new LanguageProfile({ runtimeVersion: '2024.13.0.0' }),
  });
  const method = Type.Function.named('method');
  method.callKind = 'native';
  method.addParameter(0, 'self', { type: Type.Any });
  method.addParameter(1, 'callable', { type: Type.Any });
  const item = new Signifier(Type.Struct, 'method', method);
  item.native = 'Fixture';
  item.semanticKey = nativeGlobalKey('method');
  method.signifier = item;
  const result = evaluateUnit(bound, {
    lookup: (request) =>
      request.owner === nativeGlobalOwner && request.name === 'method'
        ? { key: item.semanticKey!, item }
        : external.lookup?.(request),
    type: (key) => external.type?.(key),
    implementation: external.implementation,
    observe: (dependency) => external.observe?.(dependency),
    cancelled: () => {
      onStep?.();
      return false;
    },
  });
  return {
    result,
    returns: (name: string) =>
      result.symbols.get(globalKey(name))!.item.getTypeByKind('Function')!
        .returns!,
  };
}
const kinds = (value: { type: Type[] }) =>
  [...new Set(value.type.map((type) => type.kind))].sort();

describe('Invocation scope contexts', function () {
  it('uses the actual alias caller and separates two callers of one bound value', function () {
    const { returns } = analyze(
      `function Read(){return other.field;}
      function Probe(){var target={};var callback=method(target,Read);
        var first={field:"text"};var second={field:1};var a;var b;
        with(first){a=callback();}with(second){b=callback();}return {first:a,second:b};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('first')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('second')!.type)).to.deep.equal(['Real']);
  });

  it('distinguishes direct member dispatch from an alias without binding other at creation', function () {
    const { returns } = analyze(
      `function Read(){return other.field;}
      function Probe(){var target={field:1};var holder={field:true};holder.callback=method(target,Read);
        var callback=holder.callback;var caller={field:"text"};var a;var b;
        with(caller){a=callback();b=holder.callback();}return {alias:a,direct:b};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('alias')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('direct')!.type)).to.deep.equal(['Bool']);
  });

  it('retains unbound scope and forwards a contextual callable parameter', function () {
    const { returns } = analyze(
      `function Read(){return other.field;}
      /// @param {Function} callback
      function Forward(callback){return callback();}
      function Probe(){var target={};var callback=method(target,Read);var caller={field:"text"};var result;
        with(caller){result=Forward(callback);}return result;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });

  it('applies other writes to the real caller and reads fresh point inputs', function () {
    const { returns } = analyze(
      `function Read(){return other.field;}
      function Write(){other.created="written";return other.created;}
      function Probe(){var target={};var read=method(target,Read);var write=method(target,Write);
        var caller={field:"first"};var a;var b;with(caller){a=read();field=1;b=read();write();}
        return {before:a,after:b,created:caller.created};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('before')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('after')!.type)).to.deep.equal(['Real']);
    expect(kinds(result.getMember('created')!.type)).to.deep.equal(['String']);
  });

  it('imports distinct returned structures while retaining each external owner alias', function () {
    const { returns } = analyze(
      `function Capture(){return {captured:other.field,owner:other};}
      function Probe(){var callback=method({},Capture);var first={field:"first"};var second={field:1};var a;var b;
        with(first){a=callback();}with(second){b=callback();}a.owner.field=true;
        return {capturedA:a.captured,capturedB:b.captured,first:first.field,second:second.field};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('capturedA')!.type)).to.deep.equal([
      'String',
    ]);
    expect(kinds(result.getMember('capturedB')!.type)).to.deep.equal(['Real']);
    expect(kinds(result.getMember('first')!.type)).to.deep.equal(['Bool']);
    expect(kinds(result.getMember('second')!.type)).to.deep.equal(['Real']);
  });

  it('honors legacy mode and keeps absent mode conservative', function () {
    const source = `function Read(){return other.field;}
      function Outer() constructor {field=1;var callback=method({},Read);var caller={field:"text"};var selected;
        with(caller){selected=callback();}result=selected;}
      function Probe(){return (new Outer()).result;}`;
    expect(kinds(analyze(source, false).returns('Probe'))).to.deep.equal([
      'String',
    ]);
    expect(kinds(analyze(source, true).returns('Probe'))).to.deep.equal([
      'Real',
    ]);
    expect(kinds(analyze(source).returns('Probe'))).not.to.deep.equal([
      'String',
    ]);
  });

  it('keeps same-shaped constructed callers independent when only one is written', function () {
    const { returns } = analyze(
      `function Box()constructor{field=1;}function Write(){other.field="changed";}
      function Probe(){var a=new Box();var b=new Box();var callback=method({},Write);
        with(a){callback();}return {first:a.field,second:b.field};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('first')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('second')!.type)).to.deep.equal(['Real']);
  });

  it('uses constructor callers and the mode-specific bound constructor other', function () {
    for (const legacy of [false, true]) {
      const { returns } = analyze(
        `function Capture()constructor{copied=other.field;}
        function Probe(){var bound=method({field:"bound"},Capture);var caller={field:1};var a;var b;
          with(caller){a=new Capture();b=new bound();}return {a:a.copied,b:b.copied};}`,
        legacy,
      );
      const result = returns('Probe').type[0];
      expect(kinds(result.getMember('a')!.type)).to.deep.equal(['Real']);
      expect(kinds(result.getMember('b')!.type)).to.deep.equal([
        legacy ? 'Real' : 'String',
      ]);
    }
  });

  it('executes parameter defaults only on missing or possible-undefined paths', function () {
    const { returns } = analyze(
      `function Touch(){other.touched=1;return 1;}function Read(input=Touch()){return other.field;}
      function Probe(){var callback=method({},Read);var caller={field:1,touched:"clean"};var before;var after;
        with(caller){callback(7);before=touched;callback();after=touched;}return {before,after};}
      function Conditional(input){var callback=method({},Read);var caller={field:1,touched:"clean"};
        with(caller){callback(input);}return caller.touched;}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('before')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('after')!.type)).to.deep.equal(['Real']);
    expect(kinds(returns('Conditional'))).to.deep.equal(['Real', 'String']);
  });

  it('preserves a shared self-other alias and implicit callback arguments', function () {
    const { returns } = analyze(
      `function Change(){self.field="changed";return other.field;}
      function Forward(){return argument0();}function Indexed(){return argument[0]();}
      function Probe(){var owner={field:1};owner.change=method(owner,Change);var direct=owner.change();
        var callback=owner.change;var a;var b;with(owner){a=Forward(callback);b=Indexed(callback);}return [direct,a,b];}`,
      false,
    );
    expect(kinds(returns('Probe').type[0].items!)).to.deep.equal(['String']);
  });

  it('preserves cyclic returned graphs and returned bound callable contexts', function () {
    const { returns } = analyze(
      `function Capture(){var result={captured:other.field};result.again=result;return result;}
      function Factory(){var captured={field:other.field};return method(captured,function(){return field;});}
      function Probe(){var capture=method({},Capture);var factory=method({},Factory);var caller={field:"text"};var result;var callback;
        with(caller){result=capture();callback=factory();}return {cycle:result,called:callback()};}`,
      false,
    );
    const result = returns('Probe').type[0];
    const cycle = result.getMember('cycle')!.type.type[0];
    expect(cycle.getMember('again')!.type.type[0]).to.equal(cycle);
    expect(kinds(cycle.getMember('captured')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('called')!.type)).to.deep.equal(['String']);
  });

  it('converges recursive contextual returns together with caller effects', function () {
    const { returns } = analyze(
      `function Read(flag){if(flag){other.done="done";return other.field;}return Read(true);}
      function Probe(){var callback=method({},Read);var caller={field:1};var result;
        with(caller){result=callback(false);}return {result,done:caller.done};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('result')!.type)).to.deep.equal(['Real']);
    expect(kinds(result.getMember('done')!.type)).to.deep.equal(['String']);
  });
});

describe('Invocation composition', function () {
  it('borrows storage published by an earlier call to the same source', function () {
    const { returns } = analyze(
      `function Change(reset){var context=other;if(reset)global.box={field:1};else global.box.field="changed";}
      function Probe(){var cb=method({},Change);cb(true);cb(false);return global.box.field;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });

  it('converges a finite recursive bound constructor', function () {
    let steps = 0;
    const { returns } = analyze(
      `function Build(stop) constructor {var context=other;
      if(stop)value=1;else{var again=method(self,Build);child=new again(true);}}
      function Probe(){return (new Build(false)).child.value;}`,
      false,
      () => {
        if (++steps > 6000)
          throw new Error('Bound constructor analysis did not converge');
      },
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['Real']);
  });

  it('closes recursive bound construction when the terminating branch is unknown', function () {
    let steps = 0;
    const { returns } = analyze(
      `function Build(stop) constructor {var context=other;
      if(stop)value=1;else{var again=method(self,Build);child=new again(stop);}}
      function Probe(flag){return new Build(flag);}`,
      false,
      () => {
        if (++steps > 6000)
          throw new Error('Recursive construction analysis did not converge');
      },
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['Struct']);
    expect(kinds(returns('Probe').type[0].getMember('value')!.type)).to.include(
      'Real',
    );
  });

  it('keeps distinct bound constructor receivers at one construction site', function () {
    const { returns } = analyze(
      `function Capture()constructor{value=other.field;}
      function Probe(flag){var first=method({field:"text"},Capture);var second=method({field:1},Capture);
        var selected=flag?first:second;return (new selected()).value;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['Real', 'String']);
  });

  it('preserves named bound callbacks returned from contextual factories', function () {
    const { returns } = analyze(
      `function ReadSelf(){return field;}
      function Factory(){var captured={field:other.field};return method(captured,ReadSelf);}
      function Probe(){var make=method({},Factory);var caller={field:"text"};var cb;
        with(caller){cb=make();}return cb();}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });

  it('keeps a returned owner aliased to its named bound callback', function () {
    const { returns } = analyze(
      `function ReadSelf(){return field;}
      function Factory(){var owner={field:other.field};return {owner,read:method(owner,ReadSelf)};}
      function Probe(){var make=method({},Factory);var caller={field:"text"};var result;
        with(caller){result=make();}result.owner.field=1;return result.read();}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['Real']);
  });

  it('retains bound callables when an earlier result returns through the same call site', function () {
    const { returns } = analyze(
      `function ReadSelf(){return field;}
      function Factory(input){var context=other;var fresh={field:1};return {owner:fresh,read:method(input,ReadSelf)};}
      function Repeated(){var make=method({},Factory);var owner={field:"text"};var answer;var result;
        repeat(2){result=make(owner);owner=result.owner;answer=result.read();}return {answer,callback:result.read};}
      function Expanded(){var make=method({},Factory);var first=make({field:"text"});var second=make(first.owner);
        return {answer:second.read(),callback:second.read};}
      function Wrapper(input){var context=other;var make=method({},Factory);return make(input);}
      function Wrapped(){var make=method({},Wrapper);var owner={field:"text"};var answer;var result;
        repeat(2){result=make(owner);owner=result.owner;answer=result.read();}return {answer,callback:result.read};}`,
      false,
    );
    for (const name of ['Expanded', 'Repeated', 'Wrapped']) {
      const result = returns(name).type[0];
      expect(kinds(result.getMember('answer')!.type), name).to.include('Real');
      const callback = kinds(result.getMember('callback')!.type);
      expect(callback, name).to.include('Function');
      expect(callback, name).not.to.include('Struct');
    }
  });

  it('preserves named constructed results through contextual wrappers', function () {
    const { returns } = analyze(
      `function Box(input)constructor{var context=other;payload=input;}
      function Wrapper(){return new Box(other.field);}
      function Probe(){var cb=method({},Wrapper);var caller={field:"text"};var r;
        with(caller){r=cb();}return r.payload;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });

  it('includes recursive container writes in the return fixed point', function () {
    const { returns } = analyze(
      `function Recur(stop){if(stop)return other.box[0];other.box[0]="changed";return Recur(true);}
      function Probe(){var cb=method({},Recur);var caller={box:[1]};var r;
        with(caller){r=cb(false);}return r;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.include('String');
  });

  it('converges a finite call that rebinds its own source', function () {
    let steps = 0;
    const { returns } = analyze(
      `function Rebind(stop){var context=other;if(stop)return 1;
      var again=method(self,Rebind);return again(true);}
      function Probe(){return Rebind(false);}`,
      false,
      () => {
        if (++steps > 4000)
          throw new Error('Rebinding analysis did not converge');
      },
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['Real']);
  });

  it('retains a callable returned from a contextual factory', function () {
    const { returns } = analyze(
      `function Factory(){var context=other;return function(){return 1;};}
      function Probe(){var make=method({},Factory);var callback=make();return callback();}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['Real']);
  });

  it('includes recursive caller storage changes in the return fixed point', function () {
    const { returns } = analyze(
      `function Recur(stop){if(stop)return other.field;other.field="changed";return Recur(true);}
      function Probe(){var callback=method({},Recur);var caller={field:1};var result;
        with(caller){result=callback(false);}return result;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.include('String');
  });

  it('retains actual argument storage under a struct parameter contract', function () {
    const { returns } = analyze(
      `/// @param {Struct} target
      function SetValue(target){target.field=other.field;}
      function Probe(){var target={field:1};var caller={field:"text"};var callback=method({},SetValue);
        with(caller){callback(target);}return target.field;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });

  it('forwards self-only helper writes through a contextual wrapper', function () {
    const { returns } = analyze(
      `function WriteSelf(){field="changed";}
      function Wrapper(){var context=other;var write=method(self,WriteSelf);write();}
      function Probe(){var owner={field:1};var callback=method(owner,Wrapper);callback();return owner.field;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });

  it('retains writes and returned aliases reached through global storage', function () {
    const { returns } = analyze(
      `function WriteGlobalBox(){var context=other;global.box.field="changed";return global.box;}
      function Probe(){global.box={field:1};var callback=method({},WriteGlobalBox);var result=callback();
        var after=global.box.field;result.field=true;return {after,aliased:global.box.field};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('after')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('aliased')!.type)).to.deep.equal(['Bool']);
  });

  it('retains possible first static initialization effects without repeating an initialized static', function () {
    const { returns } = analyze(
      `function InitializeOnce(){other.touched=1;return 1;}
      function Once(){static cached=InitializeOnce();return cached;}
      function Probe(){var caller={touched:"clean"};var callback=method({},Once);var first;
        with(caller){callback();first=touched;touched="reset";callback();}return {first,second:caller.touched};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('first')!.type)).to.include('Real');
    expect(kinds(result.getMember('second')!.type)).to.deep.equal(['String']);
  });

  it('returns the actual implicit argument container', function () {
    const { returns } = analyze(
      `function CaptureArguments(){var context=other;return argument;}
      function Probe(){var callback=method({},CaptureArguments);return callback("text")[0];}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });

  it('separates helper allocations returned through constructors and contextual wrappers', function () {
    const { returns } = analyze(
      `function Make(){return {field:1};}
      function Box()constructor{inner=Make();}
      function Wrap(){var context=other;return Make();}
      function Probe(){var a=new Box();var b=new Box();a.inner.field="changed";
        var callback=method({},Wrap);var first=callback();var second=callback();first.field=true;
        return {constructed:b.inner.field,returned:second.field};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('constructed')!.type)).to.deep.equal([
      'Real',
    ]);
    expect(kinds(result.getMember('returned')!.type)).to.deep.equal(['Real']);
  });

  it('invalidates a call when a nested static alias changes result ownership', function () {
    const cache = new Type('Id.DsMap');
    cache.semanticKey = 'fixture:shared-cache';
    const shared = new Signifier(Type.Struct, 'shared', cache);
    shared.semanticKey = nativeGlobalKey('shared');
    shared.native = 'Fixture';
    const provider = analyze(
      'function Factory(){static retained=shared;return {field:1};}',
      false,
      undefined,
      {
        lookup: (request) =>
          request.owner === nativeGlobalOwner && request.name === 'shared'
            ? { key: shared.semanticKey!, item: shared }
            : undefined,
      },
      'factory.gml',
    );
    const environment: Partial<SemanticEnvironment> = {
      lookup: (request) =>
        request.owner === globalOwner && request.name === 'Factory'
          ? provider.result.symbols.get(globalKey('Factory'))
          : undefined,
      type: (key) =>
        key === cache.semanticKey ? cache : provider.result.types.get(key),
    };
    const read = () =>
      analyze(
        'function Read(){return Factory();}',
        false,
        undefined,
        environment,
        'consumer.gml',
      );
    const before = read();
    const dependencies = new DependencyIndex();
    dependencies.replace(before.result.unitId, before.result.dependencies);
    cache.items = provider.returns('Factory');
    const after = read();
    expect(provider.result.diagnostics).to.deep.equal([]);
    expect(before.result.diagnostics).to.deep.equal([]);
    expect(after.result.diagnostics).to.deep.equal([]);
    expect(before.returns('Read').type[0].semanticKey).not.to.equal(
      after.returns('Read').type[0].semanticKey,
    );
    expect(after.returns('Read').type[0].semanticKey).to.equal(
      provider.returns('Factory').type[0].semanticKey,
    );
    expect(
      kinds(after.returns('Read').type[0].getMember('field')!.type),
    ).to.deep.equal(['Real']);
    expect([...dependencies.affected([cache.semanticKey])]).to.include(
      before.result.unitId,
    );

    // A producer must announce identity changes even when the stored shapes
    // are equal; otherwise the registered consumer is never scheduled.
    const original = provider.returns('Factory').type[0];
    const independent = original.deriveDetached();
    independent.semanticKey = 'fixture:independent-storage';
    const input = new Signifier(Type.Struct, 'inputValue', independent);
    input.semanticKey = nativeGlobalKey('inputValue');
    input.native = 'Fixture';
    const summaries: string[] = [];
    for (const current of [independent, original]) {
      cache.items = value(current);
      input.setType(current);
      const writer = analyze(
        'shared[?"slot"]=inputValue;',
        false,
        undefined,
        {
          lookup: (request) => {
            if (request.owner !== nativeGlobalOwner) return;
            const item =
              request.name === 'shared'
                ? shared
                : request.name === 'inputValue'
                  ? input
                  : undefined;
            return item && { key: item.semanticKey!, item };
          },
          type: (key) =>
            key === cache.semanticKey
              ? cache
              : key === current.semanticKey
                ? current
                : provider.result.types.get(key),
        },
        'writer.gml',
      );
      expect(writer.result.diagnostics).to.deep.equal([]);
      expect(
        writer.result.types
          .get(cache.semanticKey)!
          .items!.type.map((type) => type.semanticKey),
      ).to.deep.equal([current.semanticKey]);
      const summary = writer.result.semanticSummaries.get(cache.semanticKey);
      expect(summary).to.be.a('string');
      summaries.push(summary!);
    }
    expect(summaries[0]).not.to.equal(summaries[1]);
  });

  it('preserves shared aliases inside fresh helper allocations', function () {
    const { returns } = analyze(
      `global.shared={field:1};
      function Make(){static retained={field:1};return {owned:{field:1},shared:global.shared,retained};}
      function Wrap(){var context=other;return Make();}
      function Probe(){var callback=method({},Wrap);var a=callback();var b=callback();
        a.owned.field="own";a.shared.field=true;a.retained.field="static";
        return {owned:b.owned.field,shared:b.shared.field,retained:b.retained.field};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('owned')!.type)).to.deep.equal(['Real']);
    expect(kinds(result.getMember('shared')!.type)).to.deep.equal(['Bool']);
    expect(kinds(result.getMember('retained')!.type)).to.deep.equal(['String']);
  });

  it('copies allocations inherited from base constructors without redirecting self aliases', function () {
    const { returns } = analyze(
      `function Base()constructor{inner={field:1};node={owner:self};}
      function Child():Base()constructor{own={field:true};}
      function Probe(){var a=new Child();var b=new Child();a.inner.field="changed";a.node.owner.own.field="self";
        return {base:b.inner.field,own:a.own.field,other:b.own.field};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('base')!.type)).to.deep.equal(['Real']);
    expect(kinds(result.getMember('own')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('other')!.type)).to.deep.equal(['Bool']);
  });

  it('keeps constructor-owned nested allocations separate', function () {
    const { returns } = analyze(
      `function Box()constructor{inner={field:1};}
      function Probe(){var first=new Box();var second=new Box();first.inner.field="changed";return second.inner.field;}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['Real']);
  });

  it('copies constructor allocation graphs while preserving self, global and static aliases', function () {
    const { returns } = analyze(
      `global.shared={field:1};
      function Box()constructor{flag=1;inner=[{field:1}];external=global.shared;static shared={field:1};alias=shared;node={root:self};}
      function Probe(){var a=new Box();var b=new Box();a.inner[0].field="changed";a.external.field=true;a.alias.field="static";a.node.root.flag="self";
        return {inner:b.inner[0].field,external:global.shared.field,shared:b.alias.field,own:a.flag,other:b.flag};}`,
      false,
    );
    const result = returns('Probe').type[0];
    for (const [name, kind] of [
      ['inner', 'Real'],
      ['external', 'Bool'],
      ['shared', 'String'],
      ['own', 'String'],
      ['other', 'Real'],
    ])
      expect(kinds(result.getMember(name)!.type), name).to.deep.equal([kind]);
  });

  it('rebinds methods inside constructor-owned result graphs to the corresponding instance', function () {
    const { returns } = analyze(
      `function ReadFlag(){return flag;}
      function Box()constructor{flag=1;inner={read:method(self,ReadFlag)};}
      function Probe(){var a=new Box();var b=new Box();a.flag="changed";return {first:a.inner.read(),second:b.inner.read()};}`,
      false,
    );
    const result = returns('Probe').type[0];
    expect(kinds(result.getMember('first')!.type)).to.deep.equal(['String']);
    expect(kinds(result.getMember('second')!.type)).to.deep.equal(['Real']);
  });

  it('visits all possible with callers', function () {
    for (const alternatives of ['first:second', 'second:first']) {
      const { returns } = analyze(
        `function ReadOther(){return other.field;}
        function Probe(flag){var callback=method({},ReadOther);var first={field:"text"};var second={field:1};var result;
          with(flag?${alternatives}){result=callback();}return result;}
        function Advance(){var chosen=next;next=chosen.next;return chosen;}
        function Once(flag){var first={field:"text",next:{field:true,next:{field:"twice"}}};
          var second={field:1,next:{field:true,next:{field:"twice"}}};
          var holder={next:flag?${alternatives}};var advance=method(holder,Advance);var result;
          with(advance()){result=field;}return {result,selected:holder.next.field};}`,
        false,
      );
      expect(kinds(returns('Probe')), alternatives).to.deep.equal([
        'Real',
        'String',
      ]);
      const once = returns('Once').type[0];
      expect(kinds(once.getMember('result')!.type), alternatives).to.deep.equal(
        ['Real', 'String'],
      );
      expect(
        kinds(once.getMember('selected')!.type),
        alternatives,
      ).to.deep.equal(['Bool']);
    }
  });

  it('reads the current receiver at a self-only method call', function () {
    const { returns } = analyze(
      `function ReadSelf(){return field;}
      function Probe(){var owner={field:1};var callback=method(owner,ReadSelf);owner.field="changed";return callback();}`,
      false,
    );
    expect(kinds(returns('Probe'))).to.deep.equal(['String']);
  });
});

describe('Current transaction callable implementations', function () {
  it('executes the current nested body with the retained closure receiver and rejects missing implementations', function () {
    const source =
      'function Factory(){var captured={left:"old",right:1};return method(captured,function(){return left;});}';
    const previous = analyze(source, false, undefined, {}, 'provider.gml');
    const current = analyze(
      source.replace('return left', 'return right'),
      false,
      undefined,
      {},
      'provider.gml',
    );
    // Freeze a real earlier callable graph. Deliberately do not rematerialize it
    // through the new provider's types: body freshness must come from the resolver.
    const callback = previous.returns('Factory').type[0];
    const carrier = new Signifier(Type.Struct, 'retained', callback);
    carrier.semanticKey = globalKey('retained');
    carrier.global = true;
    carrier.replaceDefinition({});
    const provenance = callback.functionSource!;
    const bodyKey = implementationKey(
      provenance.bound.unitId,
      provenance.functionId,
    );
    let implementations = current.result.implementations;
    const execute = () =>
      analyze(
        'function Probe(){return retained();}',
        false,
        undefined,
        {
          lookup: ({ name }) =>
            name === 'retained'
              ? { key: carrier.semanticKey!, item: carrier }
              : undefined,
          implementation: (unitId, functionId) =>
            implementations.get(implementationKey(unitId, functionId)),
        },
        'executor.gml',
      );
    const updated = execute();
    expect(kinds(updated.returns('Probe'))).to.deep.equal(['Real']);
    expect(
      updated.result.dependencies.some(
        (dependency) =>
          dependency.kind === 'implementation' && dependency.owner === bodyKey,
      ),
    ).to.equal(true);
    implementations = new Map();
    const missing = kinds(execute().returns('Probe'));
    expect(missing).not.to.include('String');
    expect(missing).not.to.include('Real');
    implementations = current.result.implementations;
    expect(kinds(execute().returns('Probe'))).to.deep.equal(['Real']);
    expect(callback.functionSource).to.equal(provenance);
    expect(kinds(previous.returns('Factory').type[0].returns!)).to.deep.equal([
      'String',
    ]);
  });

  it('keeps the actual receiver arguments and caller mode when the current implementation was bound under another mode', function () {
    const source = `function Read(input){return {own:self.field,caller:other.left,argument:input};}
      function Factory(){return method({field:true},Read);}`;
    const previous = analyze(source, true, undefined, {}, 'provider.gml');
    const current = analyze(
      source.replace('other.left', 'other.right'),
      true,
      undefined,
      {},
      'provider.gml',
    );
    const carrier = new Signifier(
      Type.Struct,
      'retained',
      previous.returns('Factory').type,
    );
    carrier.semanticKey = globalKey('retained');
    carrier.global = true;
    carrier.replaceDefinition({});
    const result = analyze(
      `function Probe(){var callback=retained;var caller={left:"old",right:1};var result;
        with(caller){result=callback("argument");}return result;}`,
      false,
      undefined,
      {
        lookup: ({ name }) =>
          name === 'retained'
            ? { key: carrier.semanticKey!, item: carrier }
            : undefined,
        implementation: (unitId, functionId) =>
          current.result.implementations.get(
            implementationKey(unitId, functionId),
          ),
      },
      'executor.gml',
    ).returns('Probe').type[0];
    expect(kinds(result.getMember('own')!.type)).to.deep.equal(['Bool']);
    expect(kinds(result.getMember('caller')!.type)).to.deep.equal(['Real']);
    expect(kinds(result.getMember('argument')!.type)).to.deep.equal(['String']);
  });
});

describe('Base constructor receiver storage', function () {
  const source = `function BaseContext()constructor{payload=other.field;}
    function DerivedContext():BaseContext()constructor{}
    function Probe(){var caller={field:"text"};var result;
      with(caller){result=new DerivedContext();}var observed=result.payload;return result;}`;
  for (const mode of [false, true, undefined]) {
    const label = mode === undefined ? 'unknown' : mode ? 'legacy' : 'modern';
    it(`writes inherited fields into the actual constructed receiver in ${label} mode`, function () {
      const { result, returns } = analyze(source, mode);
      expect(
        kinds(returns('Probe').type[0].getMember('payload')!.type),
      ).to.include('String');
      const read = result.references.find(
        (entry) =>
          entry.origin.spelling.start === source.lastIndexOf('payload'),
      )!;
      expect(kinds(read.type)).to.deep.equal(['String']);
    });
    it(`retains source navigation identity separately from receiver storage in ${label} mode`, function () {
      const { result, returns } = analyze(source, mode);
      const instance = returns('Probe').type[0];
      const field = instance.getMember('payload')!;
      const contribution = result.symbols.get(field.semanticKey!)!;
      const declaration = result.bound.declarations.find(
        (entry) => entry.role === 'field' && entry.name === 'payload',
      )!;
      expect(field.parent).to.equal(instance);
      expect(contribution.owner).to.equal(instance.semanticKey);
      expect(contribution.canonicalKey).to.equal(declaration.key);
      const reference = result.references.find(
        (entry) =>
          entry.origin.spelling.start === source.lastIndexOf('payload'),
      )!;
      expect(reference.symbol).to.equal(declaration.key);
    });
    it(`does not publish a constructed receiver's value into its base template in ${label} mode`, function () {
      const { result } = analyze(source, mode);
      const template = result.types.get('struct:global:BaseContext')!;
      expect(kinds(template.getMember('payload')!.type)).to.deep.equal(['Any']);
    });
  }

  for (const [mode, expected] of [
    [false, ['Real', 'String']],
    [true, ['Bool']],
    [undefined, ['Any']],
  ] as const) {
    it(`keeps receiver alternatives at one bound new site in ${String(mode)} mode`, function () {
      const { returns } = analyze(
        `function BaseChoice()constructor{payload=other.field;}
        function DerivedChoice():BaseChoice()constructor{}
        function Probe(flag){var first=method({field:"text"},DerivedChoice);var second=method({field:1},DerivedChoice);
          var selected=flag?first:second;var caller={field:true};var result;with(caller){result=new selected();}return result.payload;}`,
        mode,
      );
      expect(kinds(returns('Probe'))).to.deep.equal(expected);
    });
  }
});
