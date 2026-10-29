import { expect } from 'chai';
import { GmlParser } from '../parser.js';
import { LanguageProfile } from '../language/version.js';
import { bindUnit } from './binding.js';
import { normalizeSyntax } from './syntax.js';

function functions(text: string) {
  const uri = 'identity.gml';
  const parsed = new GmlParser().parse(text);
  expect(parsed.errors).to.deep.equal([]);
  const syntax = normalizeSyntax({
    unitId: uri,
    text,
    cst: parsed.cst,
    origin: (start, end) => ({ spelling: { uri, start, end }, editable: true }),
  });
  return [
    ...bindUnit(syntax, {
      unitId: uri,
      assetId: 'fixture',
      assetName: 'fixture',
      kind: 'script',
      definitiveSelf: false,
      language: new LanguageProfile({ runtimeVersion: '2024.13.0.0' }),
    }).functions.values(),
  ];
}

function identities(text: string) {
  return functions(text).map((fn) => ({
    id: fn.node.id,
    type: fn.typeKey,
    local: fn.localOwner,
    self: fn.selfOwner,
    statics: fn.staticOwner,
  }));
}

describe('Syntax function identity', function () {
  it('keeps a later constructor and its anonymous members stable after a call is removed', function () {
    const source =
      'function Changed(){ show_debug_message("x"); return 1; } function Holder() constructor { static stable = function(){var local = 2; return local;}; }';
    const before = functions(source),
      after = functions(source.replace('show_debug_message("x"); ', ''));
    for (const name of ['Holder', 'stable']) {
      const first = before.find((fn) => fn.declaration?.name === name)!;
      const second = after.find((fn) => fn.declaration?.name === name)!;
      expect(first).to.not.equal(undefined);
      expect(second.node.id).to.equal(first.node.id);
      expect(second.typeKey).to.equal(first.typeKey);
      expect(second.localOwner).to.equal(first.localOwner);
    }
  });

  it('preserves distinct identical anonymous allocation sites and isolates unrelated statements', function () {
    const source =
      'function Owner(){var first=function(){return 2;}; var second=function(){return 2;};}';
    const before = functions(source).filter((fn) => !fn.node.name);
    const after = functions(
      source.replace('var first=', 'show_debug_message("x"); var first='),
    ).filter((fn) => !fn.node.name);
    expect(before).to.have.lengthOf(2);
    expect(new Set(before.map((fn) => fn.typeKey)).size).to.equal(2);
    expect(after.map((fn) => fn.typeKey)).to.deep.equal(
      before.map((fn) => fn.typeKey),
    );
  });

  it('keeps both identical anonymous siblings stable when either body changes', function () {
    const source =
      'function Owner(){var first=function(){return 2;}; var second=function(){return 2;};}';
    const before = identities(source);
    for (const name of ['first', 'second']) {
      const after = source.replace(
        `var ${name}=function(){return 2;}`,
        `var ${name}=function(){return 3;}`,
      );
      expect(identities(after), name).to.deep.equal(before);
    }
  });

  it('keeps distinct allocation sites when an edited body matches its sibling', function () {
    const source =
      'function Owner(){var first=function(){return 2;}; var second=function(){return 3;};}';
    const after = source.replace('return 2;', 'return 3;');
    expect(identities(after)).to.deep.equal(identities(source));
    const anonymous = functions(after).filter((fn) => !fn.node.name);
    expect(new Set(anonymous.map((fn) => fn.typeKey)).size).to.equal(2);
  });

  it('keeps nested anonymous owners stable when the inner body changes', function () {
    const source =
      'function Owner(){var first=function(){var nested=function(){return 2;}; return nested;}; var second=function(){return 2;};}';
    const after = source.replace(
      'return 2;',
      'show_debug_message("changed"); return 3;',
    );
    expect(identities(after)).to.deep.equal(identities(source));
  });
});
