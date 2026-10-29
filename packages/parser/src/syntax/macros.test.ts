import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { parser } from '../parser.js';
import {
  collectMacros,
  MacroEnvironment,
  MacroExpansionCancelled,
} from './macros.js';
import { SourceLines } from './source.js';

const collect = (uri: string, text: string) => collectMacros({ uri, text });
const usage = 'var result = WRAP; var tail = 7;';

describe('macro preprocessing', () => {
  it('expands forward and cross-file names while preserving the original tail and spelling', () => {
    const source = collect('use', usage);
    const definitions = collect(
      'defs',
      '#macro WRAP PICK\n#macro PICK local_value',
    );
    const result = new MacroEnvironment([source, definitions]).expand(source);
    assert.match(result.text, /var result =\s+local_value; var tail = 7;/);
    assert.equal(parser.parse(result.text).errors.length, 0);
    const map = result.sourceMap!;
    const token = result.text.indexOf('local_value');
    assert.deepEqual(map.origin(token, token + 10).spelling, {
      uri: 'defs',
      start: 29,
      end: 39,
    });
    assert.deepEqual(map.origin(token, token + 10).expansion, {
      uri: 'use',
      start: 13,
      end: 16,
    });
    const tail = result.text.indexOf('tail');
    assert.deepEqual(map.origin(tail, tail + 3).spelling, {
      uri: 'use',
      start: 23,
      end: 26,
    });
    assert(map.generatedOffsets('use', 24).includes(tail + 1));
    assert(map.generatedOffsets('defs', 30).includes(token + 1));
    assert.equal(source.document.text, usage);
  });

  it('selects the nearest configuration override without sibling leakage', () => {
    const defs = collect(
      'defs',
      '#macro VALUE 1\n#macro Parent:VALUE 2\n#macro Child:VALUE 3\n#macro Sibling:VALUE 4',
    );
    const source = collect('use', 'var result = VALUE;');
    for (const [lineage, expected] of [
      [['Default'], 1],
      [['Default', 'Parent'], 2],
      [['Default', 'Parent', 'Child'], 3],
      [['Default', 'Sibling'], 4],
    ] as const) {
      const result = new MacroEnvironment([defs, source], lineage).expand(
        source,
      );
      assert.equal(result.text.trim(), `var result =  ${expected};`);
    }
  });

  it('joins logical lines and keeps comments, strings and following statements separate', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const text = `#macro VALUE (1 + \\${newline}2) // trailing comment${newline}var result = VALUE; var tail = "VALUE";`;
      const source = collect('file', text);
      const result = new MacroEnvironment([source]).expand(source);
      assert.match(
        result.text,
        /var result =\s+\(1 \+\s+2\)\s*; var tail = "VALUE";/,
      );
      assert.equal(result.references.length, 1);
      assert.equal(result.diagnostics.length, 0);
      assert.equal(parser.parse(result.text).errors.length, 0);
    }
  });

  it('does not activate directives or names inside comments or string text', () => {
    const source = collect(
      'file',
      '// #macro BAD 1\n/* #macro BAD 2 */\nvar text = "#macro BAD 3";\n#macro GOOD "// literal"\nvar result = GOOD;',
    );
    assert.deepEqual(
      source.definitions.map((item) => item.name),
      ['GOOD'],
    );
    const result = new MacroEnvironment([source]).expand(source);
    assert(result.text.includes('var result =  "// literal";'));
    assert(result.text.includes('"#macro BAD 3"'));
  });

  it('preserves all later ordinary code when a single invocation exceeds the character budget', () => {
    const defs = collect(
      'defs',
      '#macro LARGE (1 + 2 + 3 + 4 + 5)\n#macro SMALL 2',
    );
    const source = collect(
      'use',
      'var before = 0; var result = LARGE; var tail = 7; var last = SMALL;',
    );
    const result = new MacroEnvironment([defs, source]).expand(source, {
      maxExpandedCharacters: 19,
    });
    assert.match(
      result.text,
      /^var before = 0; var result = LARGE; var tail = 7; var last =\s+2;$/,
    );
    assert.equal(
      result.diagnostics.filter((item) => /resource budget/.test(item.message))
        .length,
      1,
    );
    assert.equal(parser.parse(result.text).errors.length, 0);
    const tail = result.text.indexOf('tail');
    assert.equal(
      result.sourceMap!.origin(tail).spelling.start,
      source.document.text.indexOf('tail'),
    );
  });

  it('bounds low-output traversal and preserves the invocation and following code', () => {
    const defs = collect(
      'defs',
      '#macro A B B B B\n#macro B C C C C\n#macro C',
    );
    const source = collect('use', 'var result = A; var tail = 7;');
    const result = new MacroEnvironment([defs, source]).expand(source, {
      maxExpansionSteps: 20,
    });
    assert.equal(result.text, source.document.text);
    assert(
      result.diagnostics.some((item) => /resource budget/.test(item.message)),
    );
  });

  it('uses an identity fast path and never charges ordinary source text to the expansion budget', () => {
    const source = collect('file', 'var ordinary = "a long ordinary value";');
    const result = new MacroEnvironment([]).expand(source, {
      maxExpandedCharacters: 0,
      maxExpansionSteps: 0,
    });
    assert.equal(result.text, source.document.text);
    assert.equal(result.sourceMap, undefined);
    assert.equal(result.lexed, source.lexed);
    assert.equal(result.diagnostics.length, 0);
    assert(result.dependencies.has('ordinary'));
  });

  it('diagnoses cycles locally, allows repeated independent invocations and cancels explicitly', () => {
    const defs = collect('defs', '#macro A B\n#macro B A\n#macro OK 1');
    const source = collect(
      'use',
      'var a = A; var b = OK; var c = OK; var tail = 7;',
    );
    const environment = new MacroEnvironment([defs, source]);
    const result = environment.expand(source);
    assert(
      result.diagnostics.some((item) => /Recursive macro/.test(item.message)),
    );
    assert.match(result.text, /var b =\s+1; var c =\s+1; var tail = 7;/);
    assert.throws(
      () => environment.expand(source, { cancelled: () => true }),
      MacroExpansionCancelled,
    );
    assert.throws(
      () =>
        collectMacros(source.document, undefined, { cancelled: () => true }),
      MacroExpansionCancelled,
    );
  });

  it('keeps budget acceptance independent of token cache history', () => {
    const defs = collect('defs', '#macro N 7');
    const source = collect('use', 'var value = N; var tail = 3;');
    const environment = new MacroEnvironment([defs, source]);
    const cold = environment.expand(source, { maxExpansionSteps: 2 });
    const hot = environment.expand(source, { maxExpansionSteps: 2 });
    assert.equal(cold.text, source.document.text);
    assert.equal(hot.text, cold.text);
    assert.deepEqual(hot.diagnostics, cold.diagnostics);
  });

  it('retains UTF-16 columns, CR-only lines and EOF positions', () => {
    const text = 'var note = "😀";\rvar tail = 7;';
    const lines = new SourceLines(text);
    assert.deepEqual(lines.position(16), { offset: 16, line: 1, column: 17 });
    assert.deepEqual(lines.position(21), { offset: 21, line: 2, column: 5 });
    assert.equal(lines.offset({ line: 2, column: 5 }), 21);
    assert.equal(lines.position(text.length).offset, text.length);
  });

  it('expands compiler-accepted keyword names and multiline verbatim bodies', () => {
    const text =
      '#macro if 7\n#macro TEXT @"first\nsecond"\nvar result = if; var text = TEXT;';
    const source = collect('file', text);
    const result = new MacroEnvironment([source]).expand(source);
    assert.match(
      result.text,
      /var result =\s+7; var text =\s+@"first\nsecond";/,
    );
    assert.equal(parser.parse(result.text).errors.length, 0);
    assert.equal(result.diagnostics.length, 0);
    assert(result.dependencies.has('if'));
  });

  it('maps EOF to the physical EOF after a shorter macro expansion', () => {
    const defs = collect('defs', '#macro LONG_MACRO_NAME 1');
    const source = collect('use', 'LONG_MACRO_NAME');
    const result = new MacroEnvironment([defs, source]).expand(source);
    assert.equal(
      result.sourceMap!.origin(result.text.length).spelling.start,
      source.document.text.length,
    );
    assert.deepEqual(
      result.sourceMap!.generatedOffsets('use', source.document.text.length),
      [result.text.length],
    );
  });

  it('accepts macro fragments whose closing delimiter gets its context from the invocation', () => {
    const source = collect(
      'file',
      '#macro CLOSE }\nfunction probe() { return 7; CLOSE',
    );
    const result = new MacroEnvironment([source]).expand(source);
    assert.equal(result.diagnostics.length, 0);
    assert.equal(parser.parse(result.text).errors.length, 0);
  });

  it('retains incomplete invocations and diagnoses illegal tokens in unused definitions', () => {
    const empty = collect('defs', '#macro EMPTY');
    const use = collect('use', 'var result = EMPTY; var tail = 7;');
    const result = new MacroEnvironment([empty, use]).expand(use);
    assert.equal(result.text, use.document.text);
    assert(
      empty.diagnostics.some((item) => /no expression/.test(item.message)),
    );
    assert.equal(parser.parse(result.text).errors.length, 0);
    const invalid = collect('defs', '#macro BAD 1§');
    assert(
      invalid.diagnostics.some((item) =>
        /unexpected character/.test(item.message),
      ),
    );
    const close = collect('defs', '#macro CLOSE }');
    assert.equal(close.diagnostics.length, 0);
    assert.equal(close.lexed.errors.length, 0);
  });
});
