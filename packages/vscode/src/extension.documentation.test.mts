import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseJsdoc } from '@bscotch/gml-parser';
import {
  documentationCompletions,
  documentationContext,
} from './language/documentation-context.mjs';
import { createHost, deferred } from './test/host.mjs';

function input(marked: string) {
  const offset = marked.indexOf('^');
  assert(offset >= 0);
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  return { text, offset, context: documentationContext(text, offset) };
}
// Instantiate only the authored default placeholders used by these templates.
// This checks the resulting GML with its real parser, not VS Code's snippet UI.
function defaults(snippet: string) {
  return snippet.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
}
function insert(marked: string, name: string) {
  const { text, context } = input(marked);
  assert(context);
  const candidate = documentationCompletions(context, [name]).find(
    (item) => item.name === name,
  );
  assert(candidate, name);
  const value = candidate.insertText ?? candidate.name;
  return (
    text.slice(0, context.start) +
    (candidate.snippet ? defaults(value) : value) +
    text.slice(context.end)
  );
}

for (const marked of [
  '///^',
  '/// ^',
  '/// @^',
  '/// @ret^',
  '/** @ret^ */',
  '/**\r\n * @ret^\r\n */',
]) {
  test(`tag completion produces a parser-accepted return annotation at ${JSON.stringify(marked)}`, () => {
    const source = insert(marked, '@returns');
    const parsed = parseJsdoc(source);
    assert.equal(parsed.returns?.type?.content, 'Any');
    assert.equal(parsed.diagnostics.length, 0);
    assert.equal((source.match(/@returns/g) || []).length, 1);
  });
}

test('renaming an existing documentation tag preserves its type and description', () => {
  const source = insert(
    '/// @ret^urns {String} preserved description',
    '@returns',
  );
  const parsed = parseJsdoc(source);
  assert.equal(parsed.returns?.type?.content, 'String');
  assert.equal(parsed.returns?.description, 'preserved description');
  assert.equal(parsed.diagnostics.length, 0);
});

for (const [marked, expected] of [
  ['/// @returns Str^', 'String'],
  ['/// @returns Str^}', 'String'],
  ['/// @returns {Str^}', 'String'],
  ['/// @returns{Str^}', 'String'],
  ['/// @returns {Array<Str^>}', 'Array<String>'],
  ['/// @returns {Array[Str^]}', 'Array[String]'],
  ['/// @returns {Real|Str^}', 'Real|String'],
  ['/// @returns {Real,Str^}', 'Real,String'],
  ['/// @returns {Real OR Str^}', 'Real OR String'],
  ['/// @returns {Real or Str^}', 'Real or String'],
  ['/// @returns {Array<Array<Str^>>}', 'Array<Array<String>>'],
] as const) {
  test(`type insertion preserves the authored type expression ${marked}`, () => {
    const source = insert(marked, 'String');
    const parsed = parseJsdoc(source);
    assert.equal(parsed.returns?.type?.content, expected);
    assert.equal(parsed.diagnostics.length, 0);
  });
}

test('qualified names replace the whole spelling without consuming closing delimiters or prose', () => {
  const marked = '/// @returns {Array<Struct.Na^medBox>|Real} preserved prose';
  const source = insert(marked, 'Struct.NewBox');
  const parsed = parseJsdoc(source);
  assert.equal(parsed.returns?.type?.content, 'Array<Struct.NewBox>|Real');
  assert.equal(parsed.returns?.description, 'preserved prose');
  assert.equal(parsed.diagnostics.length, 0);
});

for (const marked of ['/// @self Struct.Na^', '/// @self {Struct.Na^}']) {
  test(`self completion preserves existing brace compatibility: ${marked}`, () => {
    const parsed = parseJsdoc(insert(marked, 'Struct.Player'));
    assert.equal(parsed.self?.content, 'Struct.Player');
    assert.equal(parsed.diagnostics.length, marked.includes('{') ? 1 : 0);
    if (marked.includes('{'))
      assert.match(parsed.diagnostics[0].message, /should not be wrapped/);
  });
}

for (const marked of [
  '/// @param {Real} na^me description',
  '/// @returns {Real} des^cription',
  '/// @description Str^',
  '/// @template T^ ',
  '/// @returns {Array<Real>^}',
]) {
  test(`type names do not replace names or prose: ${marked}`, () => {
    const { context } = input(marked);
    assert.equal(context?.kind, 'none');
    assert.deepEqual(documentationCompletions(context!, ['String']), []);
  });
}

for (const marked of [
  'var text = "/// @ret^";',
  'var text = @"first\n/// @ret^\nlast";',
  "var text = @'first\n/** @ret^ */\nlast';",
  'var text = $"prefix {string(1)} /// @ret^";',
  'var text = "escaped \\" /** @ret^ */";',
  '// @ret^',
  '/* ordinary\n/// @ret^\n*/',
]) {
  test(`documentation-looking text stays outside doc completion: ${JSON.stringify(marked)}`, () => {
    const { context } = input(marked);
    assert.equal(context, undefined);
  });
}

test('block comments inside interpolation code are documentation, while surrounding string text is not', () => {
  const { context } = input('var text = $"{string(/** @type {Str^} */ 1)}";');
  assert.equal(context?.kind, 'type');
});

test('current-block template declarations join type candidates and do not leak across blocks', () => {
  const first = input(
    '/// @template T\n/// @returns {Array<T^>}\nfunction first(){}\n/// @template U\n/// @returns {U}\nfunction second(){}',
  );
  const second = input(
    '/// @template T\n/// @returns {T}\nfunction first(){}\n/// @template U\n/// @returns {U^}\nfunction second(){}',
  );
  const names = (context: NonNullable<typeof first.context>) =>
    documentationCompletions(context, ['String']).map((item) => item.name);
  assert.deepEqual(names(first.context!).sort(), ['String', 'T']);
  assert.deepEqual(names(second.context!).sort(), ['String', 'U']);
  const changed = input(
    '/// @template Fresh\n/// @returns {Fresh^}\nfunction fresh(){}',
  );
  assert(names(changed.context!).includes('Fresh'));
});

test('a variable-documentation group does not inherit function templates', () => {
  const { context } = input(
    '/// @template T\n/// @globalvar {Str^} global_value',
  );
  assert(context);
  assert(
    !documentationCompletions(context, ['String']).some(
      (item) => item.name === 'T',
    ),
  );
});

test('missing-brace repair does not wrap only one part of a generic or union', () => {
  for (const marked of [
    '/// @returns Arr^ay<Real>',
    '/// @returns Real^|String',
    '/// @returns Real^ OR String',
  ]) {
    const { context } = input(marked);
    assert.equal(context?.kind, 'none');
  }
});

describe('documentation completion provider', () => {
  let host: Awaited<ReturnType<typeof createHost>>;
  beforeEach(async () => {
    host = await createHost();
  });
  afterEach(() => host.dispose());
  function document(marked: string) {
    const { text, offset } = input(marked);
    const doc = host.document(
      { path: { absolute: `${host.root}/documentation.gml` } },
      text,
    );
    return { doc, position: doc.positionAt(offset), offset };
  }

  test('the provider serves tags without touching analysis and exposes real snippet insertions', async () => {
    const { doc, position } = document('/// @ret^');
    const provider = new host.subject.StitchCompletionProvider({
      query: () => {
        throw new Error('Tag completion must not wait for analysis');
      },
    });
    const items = await provider.provideCompletionItems(
      doc,
      position,
      { isCancellationRequested: false },
      { triggerCharacter: '@' },
    );
    const item = items.find((item: any) => item.label === '@returns');
    assert(item.insertText instanceof host.vscode.SnippetString);
    const range = item.range;
    const source =
      doc.getText().slice(0, doc.offsetAt(range.start)) +
      defaults(item.insertText.value) +
      doc.getText().slice(doc.offsetAt(range.end));
    assert.equal(parseJsdoc(source).returns?.type?.content, 'Any');
  });

  test('the provider preserves UTF-16 ranges and fallback status for qualified doc types', async () => {
    const { doc, position } = document(
      '// 😀\r\n/// @returns {Array<Struct.Na^medBox>} description',
    );
    const provider = new host.subject.StitchCompletionProvider({
      query: async (_doc: any, query: any) => {
        assert.equal(query.trigger, '.');
        const context = documentationContext(doc.getText(), query.offset)!;
        return documentationCompletions(context, ['Struct.NewBox']).map(
          (value) => ({ ...value, fallback: 'snapshot' }),
        );
      },
    });
    const list = await provider.provideCompletionItems(
      doc,
      position,
      { isCancellationRequested: false },
      { triggerCharacter: '.' },
    );
    assert.equal(list.isIncomplete, true);
    const range = list.items[0].range;
    assert.equal(range.start.line, 1);
    assert.equal(doc.getText(range), 'Struct.NamedBox');
    const source =
      doc.getText().slice(0, doc.offsetAt(range.start)) +
      list.items[0].label +
      doc.getText().slice(doc.offsetAt(range.end));
    assert.equal(
      parseJsdoc(source.slice(source.indexOf('///'))).returns?.type?.content,
      'Array<Struct.NewBox>',
    );
  });

  for (const trigger of ['/', '@', '[', ',', ' ']) {
    test(`the extra ${trigger} trigger does not query ordinary GML analysis`, async () => {
      const { doc, position } = document(`var value = something${trigger}^`);
      const provider = new host.subject.StitchCompletionProvider({
        query: () => {
          throw new Error('An unrelated trigger must not flush analysis');
        },
      });
      assert.equal(
        await provider.provideCompletionItems(
          doc,
          position,
          { isCancellationRequested: false },
          { triggerCharacter: trigger },
        ),
        undefined,
      );
    });
  }

  test('a space after the documentation opener offers tags without analysis', async () => {
    const { doc, position } = document('/// ^');
    const provider = new host.subject.StitchCompletionProvider({
      query: () => {
        throw new Error('Tag completion is local');
      },
    });
    const items = await provider.provideCompletionItems(
      doc,
      position,
      { isCancellationRequested: false },
      { triggerCharacter: ' ' },
    );
    assert(items.some((item: any) => item.label === '@returns'));
  });

  test('a space after a return tag offers a parser-accepted braced type', async () => {
    const { doc, position } = document('/// @returns ^');
    const provider = new host.subject.StitchCompletionProvider({
      query: async (_doc: any, query: any) => {
        assert.equal(query.trigger, ' ');
        return documentationCompletions(
          documentationContext(doc.getText(), query.offset)!,
          ['String'],
        );
      },
    });
    const items = await provider.provideCompletionItems(
      doc,
      position,
      { isCancellationRequested: false },
      { triggerCharacter: ' ' },
    );
    const item = items.find((item: any) => item.label === 'String');
    const source =
      doc.getText().slice(0, doc.offsetAt(item.range.start)) +
      item.insertText +
      doc.getText().slice(doc.offsetAt(item.range.end));
    const parsed = parseJsdoc(source);
    assert.equal(parsed.returns?.type?.content, 'String');
    assert.equal(parsed.diagnostics.length, 0);
  });

  test('prose returns no type candidates without querying the graph', async () => {
    const { doc, position } = document('/// @returns {Real} description ^');
    const provider = new host.subject.StitchCompletionProvider({
      query: () => {
        throw new Error('No type query in prose');
      },
    });
    assert.deepEqual(
      await provider.provideCompletionItems(
        doc,
        position,
        { isCancellationRequested: false },
        { triggerCharacter: ' ' },
      ),
      [],
    );
  });

  test('a late doc type result cannot apply a range from an older buffer', async () => {
    const response = deferred<any>();
    const { doc, position } = document('/// @returns {Str^}');
    const provider = new host.subject.StitchCompletionProvider({
      query: () => response.promise,
    });
    const pending = provider.provideCompletionItems(
      doc,
      position,
      { isCancellationRequested: false },
      {},
    );
    doc.setText('/// @description changed');
    response.resolve([{ name: 'String', kind: 'interface' }]);
    assert.equal(await pending, undefined);
  });
});
