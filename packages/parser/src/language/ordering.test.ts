import { expect } from 'chai';
import { bindUnit } from '../analysis/binding.js';
import { createDeclarationSummary } from '../analysis/evaluation.js';
import {
  AnalysisCancelled,
  nativeGlobalOwner,
  type BoundUnit,
  type UnitContext,
} from '../analysis/model.js';
import { normalizeSyntax } from '../analysis/syntax.js';
import { GmlParser } from '../parser.js';
import { Signifier } from '../signifiers.js';
import { SourceMap } from '../syntax/source.js';
import { Type } from '../types.js';
import {
  collectInputContribution,
  ContributionIndex,
} from './contributions.js';
import { orderColdSources } from './ordering.js';
import { LanguageProfile } from './version.js';

function fixture(
  sources: Record<string, string>,
  contexts: Record<string, Partial<UnitContext>> = {},
) {
  const units = new Map<string, { bound: BoundUnit }>();
  const index = new ContributionIndex();
  for (const [uri, text] of Object.entries(sources)) {
    const parsed = new GmlParser().parse(text);
    expect(parsed.errors, uri).to.have.length(0);
    const source = new SourceMap({ uri, text });
    const syntax = normalizeSyntax({
      unitId: uri,
      text,
      cst: parsed.cst,
      origin: (start, end) => source.origin(start, end),
    });
    const bound = bindUnit(syntax, {
      unitId: uri,
      assetId: uri,
      assetName: uri,
      kind: 'script',
      definitiveSelf: false,
      language: new LanguageProfile({ runtimeVersion: '2024.13.0.0' }),
      ...contexts[uri],
    });
    units.set(uri, { bound });
    index.replace(uri, createDeclarationSummary(bound));
  }
  const order = (preferred = Object.keys(sources), cancelled?: () => boolean) =>
    orderColdSources(preferred, units, index, cancelled);
  return { units, index, order };
}
function native(index: ContributionIndex, name: string, instance = false) {
  const root = new Type('Struct');
  const item = new Signifier(root, name, Type.Real);
  item.native = 'Fixture';
  item.instance = instance;
  root.setOwnMember(item);
  index.replace(
    '$native',
    collectInputContribution('$native', new Map([[nativeGlobalOwner, root]])),
  );
}

describe('Bound cold provider ordering', function () {
  it('puts transitive providers first while keeping unconstrained ready units stable', function () {
    const f = fixture({
      A: 'function a(){return b();}',
      Unrelated: 'var marker=1;',
      B: 'function b(){return c();}',
      C: 'function c(){return 1;}',
    });
    expect(f.order()).to.deep.equal(['Unrelated', 'C', 'B', 'A']);
    expect(f.order([])).to.deep.equal([]);
    expect(f.order(['Missing', 'Unrelated'])).to.deep.equal([
      'Missing',
      'Unrelated',
    ]);
  });

  it('retains original order inside SCCs without losing disconnected or dependent units', function () {
    const f = fixture({
      B: 'function b(){return a();}',
      A: 'function a(){return b()+p();}',
      Unrelated: 'var marker=1;',
      Provider: 'function p(){return 1;}',
      Consumer: 'var result=a();',
    });
    expect(f.order()).to.deep.equal([
      'Unrelated',
      'Provider',
      'B',
      'A',
      'Consumer',
    ]);
    expect(f.order(['Consumer', 'A', 'B', 'Provider'])).to.deep.equal([
      'Provider',
      'A',
      'B',
      'Consumer',
    ]);
  });

  for (const [kind, source] of Object.entries({
    local: 'function c(){var P=1;return P;}',
    parameter: 'function c(P){return P;}',
    static: 'function c(){static P=1;return P;}',
    catch: 'function c(){try{throw 1;}catch(P){return P;}}',
    withLocal: 'function c(){var P=1;with({}){return P;}}',
  })) {
    it(`honors ${kind} declarations instead of sorting by same-spelling globals`, function () {
      expect(
        fixture({
          Consumer: source,
          Provider: 'function P(){return 1;}',
        }).order(),
      ).to.deep.equal(['Consumer', 'Provider']);
    });
  }

  it('keeps possible-self-shadow edges and respects the same-function local boundary', function () {
    for (const source of [
      'function c(target){with(target){return P();}}',
      'function c(){var P=1;return function(){return P();};}',
    ])
      expect(
        fixture({
          Consumer: source,
          Provider: 'function P(){return 1;}',
        }).order(),
      ).to.deep.equal(['Provider', 'Consumer']);
  });

  it('distinguishes native bare names from explicit user global storage', function () {
    for (const [source, expected] of [
      ['var result=Builtin;', ['Consumer', 'Provider']],
      ['var result=global.Builtin;', ['Provider', 'Consumer']],
      ['var result=self.Builtin;', ['Provider', 'Consumer']],
    ] as const) {
      const f = fixture({
        Consumer: source,
        Provider: 'function Builtin(){return 1;}',
      });
      native(f.index, 'Builtin');
      expect(f.order()).to.deep.equal(expected);
    }
    const f = fixture({
      Consumer: 'function c(){with({}){return InstanceName;}}',
      Provider: 'function InstanceName(){return 1;}',
    });
    native(f.index, 'InstanceName', true);
    expect(f.order()).to.deep.equal(['Consumer', 'Provider']);
  });

  it('reads shorthand, callbacks, defaults and static initializers', function () {
    for (const source of [
      'var result={P};',
      'function c(callback=P){return callback;}',
      'function c(){static callback=P;return callback;}',
      'var callback=P;',
    ])
      expect(
        fixture({
          Consumer: source,
          Provider: 'function P(){return 1;}',
        }).order(),
      ).to.deep.equal(['Provider', 'Consumer']);
  });

  it('reads receivers and indices but not property names or plain write targets', function () {
    for (const source of [
      'var result={P:1};',
      'var object={};var result=object.P;',
      'global.P=1;',
    ])
      expect(
        fixture({
          Consumer: source,
          Provider: 'function P(){return 1;}',
        }).order(),
      ).to.deep.equal(['Consumer', 'Provider']);
    for (const source of [
      'global.P+=1;',
      'var object=[];object[P]=1;',
      'global.P++;',
    ])
      expect(
        fixture({
          Consumer: source,
          Provider: 'function P(){return 1;}',
        }).order(),
      ).to.deep.equal(['Provider', 'Consumer']);
  });

  it('uses bound base constructors and parsed named type atoms', function () {
    for (const source of [
      'function Child():P() constructor{}',
      '/// @type {Struct.P}\nvar result;',
      'function c(P){/// @type {Struct.P}\nvar result;return result;}',
    ])
      expect(
        fixture({
          Consumer: source,
          Provider: 'function P() constructor{field=1;}',
        }).order(),
      ).to.deep.equal(['Provider', 'Consumer']);
  });

  it('retains every contributor after merged bare eligibility, including qualified writes', function () {
    const f = fixture({
      Consumer: 'function c(){return P();}',
      First: 'function P(){return 1;}',
      Second: 'global.P=1;',
    });
    expect(f.order()).to.deep.equal(['First', 'Second', 'Consumer']);
    expect(
      fixture({
        Consumer: 'function c(){return P;}',
        Provider: 'global.P=1;',
      }).order(),
    ).to.deep.equal(['Consumer', 'Provider']);
    expect(
      fixture({ Consumer: 'var result=P;', Provider: 'global.P=1;' }).order(),
    ).to.deep.equal(['Provider', 'Consumer']);
  });

  it('uses legacy script identities rather than requiring named function syntax', function () {
    const language = new LanguageProfile({ runtimeVersion: '2.2.5.481' });
    const f = fixture(
      { Consumer: 'return Provider();', Provider: 'return 1;' },
      { Consumer: { language }, Provider: { language } },
    );
    expect(f.order()).to.deep.equal(['Provider', 'Consumer']);
  });

  it('uses public extension aliases and the hidden implementation name from binding metadata', function () {
    const context: Partial<UnitContext> = {
      kind: 'extension',
      extensionFunctions: [
        {
          sourceName: 'raw_impl',
          name: 'PublicAlias',
          hidden: false,
          signatureKey: 'signature:alias',
        },
        {
          sourceName: 'raw_impl',
          name: 'OtherAlias',
          hidden: false,
          signatureKey: 'signature:other',
        },
      ],
    };
    for (const name of ['PublicAlias', 'OtherAlias', 'raw_impl']) {
      const f = fixture(
        {
          Consumer: `var result=${name}();`,
          Extension: '#define raw_impl\nreturn 1;',
        },
        { Extension: context },
      );
      expect(f.order()).to.deep.equal(['Extension', 'Consumer']);
    }
  });

  it('does not alter input indexes and forwards cancellation', function () {
    const f = fixture({
      Consumer: 'var result=P();',
      Provider: 'function P(){return 1;}',
    });
    const prior = [...f.index.units];
    expect(() => f.order(undefined, () => true)).to.throw(AnalysisCancelled);
    expect([...f.index.units]).to.deep.equal(prior);
    expect(f.order()).to.deep.equal(['Provider', 'Consumer']);
    expect([...f.index.units]).to.deep.equal(prior);
  });
});
