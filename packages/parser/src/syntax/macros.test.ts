import { pathy } from '@bscotch/pathy';
import { expect } from 'chai';
import { parser } from '../parser.js';
import type { Asset } from '../project.asset.js';
import { Code } from '../project.code.js';
import { Type } from '../types.js';
import {
  collectMacros,
  MacroEnvironment,
  type PreprocessedDocument,
} from './macros.js';
import type { SourceDocument, SourceSpan } from './source.js';

// GameMaker Constants: global macros, configuration inheritance and continuation.
// https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Overview/Variables/Constants.htm
// These fixtures do not assume parameter macros or implicit parentheses.
function document(name: string, text: string): SourceDocument {
  return { uri: `file:///macro-tests/${name}.gml`, text };
}

function span(source: SourceDocument, text: string, from = 0): SourceSpan {
  const start = source.text.indexOf(text, from);
  expect(
    start,
    `${JSON.stringify(text)} exists in ${source.uri}`,
  ).to.be.at.least(0);
  return { uri: source.uri, start, end: start + text.length - 1 };
}

function parsedTokens(result: PreprocessedDocument) {
  const parsed = parser.parse(result.text);
  expect(parsed.lexed.errors).to.deep.equal([]);
  expect(parsed.errors).to.deep.equal([]);
  return parsed.lexed.tokens;
}

function assertMasked(collection: ReturnType<typeof collectMacros>) {
  expect(collection.maskedText.length).to.equal(
    collection.document.text.length,
  );
  for (let offset = 0; offset < collection.document.text.length; offset++) {
    const original = collection.document.text[offset];
    if (original === '\r' || original === '\n') {
      expect(collection.maskedText[offset], `newline at ${offset}`).to.equal(
        original,
      );
    }
  }
}

describe('macro preprocessing', function () {
  it('collects global definitions across files and forward uses independent of collection order', function () {
    const definitions = document('definitions', '#macro ANSWER 42\n');
    const usage = document(
      'usage',
      [
        'var before = ANSWER;',
        'var forward = LATER;',
        '#macro LATER 9',
        'var after = before + forward;',
      ].join('\n'),
    );
    const collections = [collectMacros(definitions), collectMacros(usage)];
    for (const ordered of [collections, [...collections].reverse()]) {
      const env = new MacroEnvironment(ordered);
      const result = env.expand(usage);
      expect(result.diagnostics).to.deep.equal([]);
      const tokens = parsedTokens(result);
      expect(tokens.filter((token) => token.image === '42')).to.have.lengthOf(
        1,
      );
      expect(tokens.filter((token) => token.image === '9')).to.have.lengthOf(1);
      expect(
        result.references.map((reference) => reference.name),
      ).to.deep.equal(['ANSWER', 'LATER']);
      expect(result.references[0].definition.source).to.deep.equal(
        span(definitions, 'ANSWER'),
      );
      expect(result.references[0].origin.spelling).to.deep.equal(
        span(usage, 'ANSWER'),
      );
      expect(result.references[1].definition.source).to.deep.equal(
        span(usage, 'LATER', usage.text.indexOf('#macro')),
      );
      expect(
        result.definitions.map((definition) => definition.name),
      ).to.deep.equal(['LATER']);
      expect(result.dependencies.has('ANSWER')).to.equal(true);
      expect(result.dependencies.has('LATER')).to.equal(true);
      const expanded = tokens.find((token) => token.image === '42')!;
      const origin = result.sourceMap.origin(
        expanded.startOffset,
        expanded.endOffset!,
      );
      expect(origin.spelling).to.deep.equal(span(definitions, '42'));
      expect(origin.expansion).to.deep.equal(span(usage, 'ANSWER'));
      expect(origin.macroName).to.equal('ANSWER');
      const after = tokens.find((token) => token.image === 'after')!;
      expect(
        result.sourceMap.origin(after.startOffset, after.endOffset!).spelling,
      ).to.deep.equal(span(usage, 'after'));
    }
  });

  it('chooses default, inherited parent and child configuration overrides without activating siblings', function () {
    const definitions = document(
      'configurations',
      [
        '#macro LABEL "base"',
        '#macro Default:LABEL "default"',
        '#macro Parent:LABEL "parent"',
        '#macro Child:LABEL "child"',
        '#macro Sibling:LABEL "sibling"',
        '#macro INHERITED 1',
        '#macro Parent:INHERITED 2',
        '#macro FALLBACK 3',
      ].join('\n'),
    );
    const usage = document(
      'configuration-usage',
      'var label = LABEL; var inherited = INHERITED; var fallback = FALLBACK;',
    );
    const collections = [collectMacros(definitions), collectMacros(usage)];
    expect(
      new MacroEnvironment(collections).definitions.get('LABEL')!.configuration,
    ).to.equal('Default');
    for (const [lineage, selected, inherited] of [
      [['Default'], 'Default', undefined],
      [['Default', 'Parent'], 'Parent', 'Parent'],
      [['Default', 'Parent', 'Child'], 'Child', 'Parent'],
    ] as const) {
      const env = new MacroEnvironment(collections, lineage);
      const result = env.expand(usage);
      expect(result.diagnostics).to.deep.equal([]);
      parsedTokens(result);
      const label = result.references.find(
        (reference) => reference.name === 'LABEL',
      )!;
      const parent = result.references.find(
        (reference) => reference.name === 'INHERITED',
      )!;
      expect(label.definition.configuration).to.equal(selected);
      expect(parent.definition.configuration).to.equal(inherited);
      expect(label.definition.source).to.deep.equal(
        span(
          definitions,
          'LABEL',
          definitions.text.indexOf(`#macro ${selected}:`),
        ),
      );
      expect(
        result.references.find((reference) => reference.name === 'FALLBACK')!
          .definition.configuration,
      ).to.equal(undefined);
      expect(
        result.references.some(
          (reference) => reference.definition.configuration === 'Sibling',
        ),
      ).to.equal(false);
    }
  });

  for (const newline of ['\n', '\r\n']) {
    it(`joins backslash continuations while retaining declaration and body source coordinates (${JSON.stringify(newline)})`, function () {
      const definitions = document(
        'continued',
        ['#macro TOTAL (10 + \\', '    20)', 'var untouched = 3;'].join(
          newline,
        ),
      );
      const usage = document(
        'continuation-usage',
        'var total = TOTAL; var tail = 4;',
      );
      const collection = collectMacros(definitions);
      expect(collection.diagnostics).to.deep.equal([]);
      expect(collection.definitions).to.have.lengthOf(1);
      assertMasked(collection);
      const directive = collection.definitions[0].directive;
      for (let offset = 0; offset < definitions.text.length; offset++) {
        const original = definitions.text[offset];
        const inside = offset >= directive.start && offset <= directive.end;
        expect(collection.maskedText[offset]).to.equal(
          inside && original !== '\r' && original !== '\n' ? ' ' : original,
        );
      }
      expect(collection.maskedText.indexOf('var untouched')).to.equal(
        definitions.text.indexOf('var untouched'),
      );
      const result = new MacroEnvironment([
        collection,
        collectMacros(usage),
      ]).expand(usage);
      expect(result.diagnostics).to.deep.equal([]);
      const tokens = parsedTokens(result);
      for (const numeric of ['10', '20']) {
        const token = tokens.find((token) => token.image === numeric)!;
        const origin = result.sourceMap.origin(
          token.startOffset,
          token.endOffset!,
        );
        expect(origin.spelling).to.deep.equal(span(definitions, numeric));
        expect(origin.expansion).to.deep.equal(span(usage, 'TOTAL'));
      }
      const first = tokens.find((token) => token.image === '10')!;
      const last = tokens.find((token) => token.image === '20')!;
      expect(
        result.sourceMap.origin(first.startOffset, last.endOffset!).editable,
      ).to.equal(false);
    });
  }

  it('expands each occurrence in its invocation scope rather than caching the definition value', async function () {
    const definitions = document(
      'dynamic-definition',
      '#macro CURRENT local_value\n',
    );
    const usage = document(
      'dynamic-usage',
      [
        'function numeric_context() { var local_value = 1; return CURRENT; }',
        'function string_context() { var local_value = "text"; return CURRENT; }',
        'var numeric_result = numeric_context();',
        'var string_result = string_context();',
      ].join('\n'),
    );
    const result = new MacroEnvironment([
      collectMacros(definitions),
      collectMacros(usage),
    ]).expand(usage);
    expect(result.diagnostics).to.deep.equal([]);
    parsedTokens(result);
    expect(result.references.map((reference) => reference.name)).to.deep.equal([
      'CURRENT',
      'CURRENT',
    ]);
    const first = span(usage, 'CURRENT');
    const second = span(usage, 'CURRENT', first.end + 1);
    expect(
      result.references.map((reference) => reference.origin.spelling),
    ).to.deep.equal([first, second]);

    // Check real semantic inference on the expanded document, without a real
    // GameMaker project, native loading, file writes or a dirty-file worker.
    const project = {
      self: new Type('Struct').named('global'),
      types: new Map<string, Type>(),
      options: {},
      queueDirtyFileUpdate() {},
      emitDiagnostics() {},
    };
    const asset = {
      project,
      assetKind: 'scripts',
      name: 'macro_dynamic',
    } as unknown as Asset;
    const code = new Code(asset, pathy('macro_dynamic.gml'));
    await code.reload(result.text);
    expect(code.getDiagnostics().SYNTAX_ERROR).to.deep.equal([]);
    expect(code.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE).to.deep.equal(
      [],
    );
    const numeric = code.refs.find(
      (reference) =>
        reference.isDef && reference.item.name === 'numeric_result',
    )!;
    const string = code.refs.find(
      (reference) => reference.isDef && reference.item.name === 'string_result',
    )!;
    expect(numeric.item.type.toFeatherString()).to.equal('Real');
    expect(string.item.type.toFeatherString()).to.equal('String');
    const values = code.refs.filter(
      (reference) => !reference.isDef && reference.item.name === 'local_value',
    );
    expect(values).to.have.lengthOf(2);
    expect(
      values.map((reference) => reference.item.type.toFeatherString()),
    ).to.deep.equal(['Real', 'String']);
    for (const [index, reference] of values.entries()) {
      const origin = result.sourceMap.origin(
        reference.start.offset,
        reference.end.offset,
      );
      expect(origin.spelling).to.deep.equal(span(definitions, 'local_value'));
      expect(origin.expansion).to.deep.equal(index === 0 ? first : second);
    }
  });

  it('keeps nested macro references distinct from their definition spelling and outer invocation anchor', function () {
    const definitions = document(
      'nested-definitions',
      '#macro OUTER INNER\n#macro INNER 9\n',
    );
    const usage = document('nested-usage', 'var answer = OUTER;');
    const result = new MacroEnvironment([
      collectMacros(definitions),
      collectMacros(usage),
    ]).expand(usage);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.references.map((reference) => reference.name)).to.deep.equal([
      'OUTER',
      'INNER',
    ]);
    const innerUse = span(definitions, 'INNER');
    expect(result.references[1].origin.spelling).to.deep.equal(innerUse);
    expect(result.references[1].definition.source).to.deep.equal(
      span(definitions, 'INNER', innerUse.end + 1),
    );
    expect(result.references[1].origin.expansion).to.deep.equal(
      span(usage, 'OUTER'),
    );
    const token = parsedTokens(result).find((token) => token.image === '9')!;
    const origin = result.sourceMap.origin(token.startOffset, token.endOffset!);
    expect(origin.spelling).to.deep.equal(span(definitions, '9'));
    expect(origin.expansion).to.deep.equal(span(usage, 'OUTER'));
    expect(origin.expansionStack).to.deep.equal([
      span(usage, 'OUTER'),
      innerUse,
    ]);
    expect(origin.macroName).to.equal('INNER');
  });

  for (const directives of [
    '#macro LOOP LOOP\n',
    '#macro LOOP OTHER\n#macro OTHER LOOP\n',
  ]) {
    it(`diagnoses recursive expansion at its invocation and preserves later ordinary code (${directives.trim()})`, function () {
      const definitions = document('cycle-definition', directives);
      const usage = document('cycle-usage', 'var value = LOOP; var tail = 3;');
      const result = new MacroEnvironment([
        collectMacros(definitions),
        collectMacros(usage),
      ]).expand(usage);
      expect(
        result.diagnostics.some((diagnostic) =>
          /recurs|cycl/i.test(diagnostic.message),
        ),
      ).to.equal(true);
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.span).to.deep.equal(span(usage, 'LOOP'));
      }
      expect(
        result.references.some((reference) => reference.name === 'LOOP'),
      ).to.equal(true);
      const tail = parsedTokens(result).find(
        (token) => token.image === 'tail',
      )!;
      expect(
        result.sourceMap.origin(tail.startOffset, tail.endOffset!).spelling,
      ).to.deep.equal(span(usage, 'tail'));
    });
  }

  it('expands a long bounded acyclic chain without a language-depth cutoff or JavaScript stack failure', function () {
    const count = 2048;
    const definitions = document(
      'long-chain',
      Array.from(
        { length: count },
        (_, index) =>
          `#macro M${index} ${index === count - 1 ? '42' : `M${index + 1}`}`,
      ).join('\n'),
    );
    const usage = document(
      'long-chain-usage',
      'var result = M0; var tail = 1;',
    );
    const result = new MacroEnvironment([
      collectMacros(definitions),
      collectMacros(usage),
    ]).expand(usage);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.references).to.have.lengthOf(count);
    const token = parsedTokens(result).find((token) => token.image === '42')!;
    const origin = result.sourceMap.origin(token.startOffset, token.endOffset!);
    expect(origin.spelling).to.deep.equal(
      span(definitions, '42', definitions.text.lastIndexOf('#macro')),
    );
    expect(origin.expansion).to.deep.equal(span(usage, 'M0'));
    expect(origin.macroName).to.equal(`M${count - 1}`);
  });

  it('does not expand same-name text or collect fake directives inside strings and comments', function () {
    const definitions = document('literal-definitions', '#macro FLAG 123\n');
    const usage = document(
      'literal-usage',
      [
        'var quoted = "#macro FAKE 2 FLAG";',
        'var multiline = @"FLAG";',
        '// FLAG and #macro NOT_A_MACRO 3',
        '/* FLAG and #macro ALSO_NOT_A_MACRO 4 */',
        '/// FLAG',
        'var expanded = FLAG;',
      ].join('\n'),
    );
    const collection = collectMacros(usage);
    expect(collection.definitions).to.deep.equal([]);
    const result = new MacroEnvironment([
      collectMacros(definitions),
      collection,
    ]).expand(usage);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.references.map((reference) => reference.name)).to.deep.equal([
      'FLAG',
    ]);
    expect(result.references[0].origin.spelling).to.deep.equal(
      span(usage, 'FLAG', usage.text.lastIndexOf('var expanded')),
    );
    for (const literal of [
      '"#macro FAKE 2 FLAG"',
      '@"FLAG"',
      '// FLAG and #macro NOT_A_MACRO 3',
      '/* FLAG and #macro ALSO_NOT_A_MACRO 4 */',
      '/// FLAG',
    ]) {
      expect(result.text).to.include(literal);
    }
    parsedTokens(result);
  });

  it('does not let a definition comment consume the invocation remainder or strip comment-looking string content', function () {
    const definitions = document(
      'body-comments',
      [
        '#macro VALUE 1 // not part of the invocation',
        '#macro TEXT "https://example.test/VALUE"',
      ].join('\n'),
    );
    const usage = document(
      'body-comment-usage',
      'var value = VALUE; var text = TEXT; var after = 5;',
    );
    const result = new MacroEnvironment([
      collectMacros(definitions),
      collectMacros(usage),
    ]).expand(usage);
    expect(result.diagnostics).to.deep.equal([]);
    const tokens = parsedTokens(result);
    expect(tokens.some((token) => token.image === 'after')).to.equal(true);
    expect(result.text).to.include('"https://example.test/VALUE"');
    expect(result.references.map((reference) => reference.name)).to.deep.equal([
      'VALUE',
      'TEXT',
    ]);
    const after = tokens.find((token) => token.image === 'after')!;
    expect(
      result.sourceMap.origin(after.startOffset, after.endOffset!).spelling,
    ).to.deep.equal(span(usage, 'after'));
  });

  for (const header of [
    '#macro',
    '#macro :',
    '#macro 9BAD 1',
    '#macro Broken: 1',
    '#macro EMPTY',
  ]) {
    it(`reports an empty or malformed directive locally without swallowing subsequent code: ${header}`, function () {
      const usage = document(
        'malformed',
        `${header}\nvar after = 3;\n#macro GOOD 7\nvar value = GOOD;`,
      );
      const collection = collectMacros(usage);
      assertMasked(collection);
      expect(collection.diagnostics.length).to.be.greaterThan(0);
      expect(
        collection.definitions.some((definition) => definition.name === 'GOOD'),
      ).to.equal(true);
      for (const diagnostic of collection.diagnostics) {
        expect(diagnostic.span.uri).to.equal(usage.uri);
        expect(diagnostic.span.start).to.be.at.least(0);
        expect(diagnostic.span.end).to.be.at.least(diagnostic.span.start);
        expect(diagnostic.span.end).to.be.lessThan(header.length);
      }
      const result = new MacroEnvironment([collection]).expand(usage);
      expect(result.diagnostics.length).to.be.greaterThan(0);
      expect(
        result.references.map((reference) => reference.name),
      ).to.deep.equal(['GOOD']);
      const after = parsedTokens(result).find(
        (token) => token.image === 'after',
      )!;
      expect(
        result.sourceMap.origin(after.startOffset, after.endOffset!).spelling,
      ).to.deep.equal(span(usage, 'after'));
    });
  }

  it('tracks an unresolved name so adding and removing its global definition changes the same source correctly', function () {
    const usage = document(
      'new-definition-usage',
      'var result = LATER_ADDED; var tail = 1;',
    );
    const definitions = document('new-definition', '#macro LATER_ADDED 12\n');
    const original = collectMacros(usage);
    const before = new MacroEnvironment([original]).expand(usage);
    const during = new MacroEnvironment([
      original,
      collectMacros(definitions),
    ]).expand(usage);
    const after = new MacroEnvironment([original]).expand(usage);
    expect(before.dependencies.has('LATER_ADDED')).to.equal(true);
    expect(before.references).to.deep.equal([]);
    expect(during.references.map((reference) => reference.name)).to.deep.equal([
      'LATER_ADDED',
    ]);
    expect(during.references[0].definition.source).to.deep.equal(
      span(definitions, 'LATER_ADDED'),
    );
    expect(parsedTokens(during).some((token) => token.image === '12')).to.equal(
      true,
    );
    expect(after.text).to.equal(before.text);
    expect(after.references).to.deep.equal(before.references);
    expect([...after.dependencies]).to.deep.equal([...before.dependencies]);
  });
});
