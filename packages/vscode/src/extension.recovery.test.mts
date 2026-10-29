import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createHost } from './test/host.mjs';

let host: Awaited<ReturnType<typeof createHost>>;
let workspace: any;
let project: any;
const token = { isCancellationRequested: false };
beforeEach(async () => {
  host = await createHost();
  workspace = host.newWorkspace();
  project = await host.project();
  workspace.projects.push(project);
  project.onDiagnostics((event: any) => workspace.emitDiagnostics(event));
});
afterEach(() => {
  const errors = host.logs.filter((entry: unknown[]) => entry[0] === 'error');
  host.dispose();
  assert.equal(
    errors.length,
    0,
    errors.map((entry: unknown[]) => entry.map(String).join(' ')).join('\n'),
  );
});
async function document(name: string, text: string) {
  const code = await host.subject.addCode(project, name, text);
  const doc = host.document(code, text);
  host.documents.push(doc);
  return { code, doc };
}
function validRange(doc: any, range: any) {
  for (const point of [range.start, range.end]) {
    assert(Number.isInteger(point.line) && Number.isInteger(point.character));
    assert(point.line >= 0 && point.line < doc.lineCount);
    assert(
      point.character >= 0 &&
        point.character <= doc.lineAt(point.line).text.length,
    );
  }
  assert(doc.offsetAt(range.end) >= doc.offsetAt(range.start));
}
function diagnostics(doc: any) {
  return workspace.diagnosticCollection.entries.get(doc.uri.toString()) || [];
}

// The providers, project/Code refresh and diagnostic normalization are real.
// The shared host doubles editor UI, discovery and scheduling; it never starts a game.
test('unsaved lexical errors publish valid UTF-16 diagnostics and repair through real hover/definition/reference providers', async () => {
  const source =
    'var note = "😀"; § function RecoveryAfter(){return 2;} var recovered=RecoveryAfter();';
  const { code, doc } = await document(
    'RecoveryLexical',
    source.replace('§', ''),
  );
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const refs = new host.subject.StitchReferenceProvider(workspace);
  for (const broken of [true, false, true, false]) {
    const text = broken ? source : source.replace('§', '');
    doc.setText(text);
    const result = await hover.provideHover(
      doc,
      doc.positionAt(text.indexOf('recovered')),
      token,
    );
    assert(
      result.contents.codeBlocks.some((block: any) =>
        block.value.includes('Real'),
      ),
    );
    assert.equal(code.content, text);
    const published = diagnostics(doc);
    published.forEach((diagnostic: any) => validRange(doc, diagnostic.range));
    const lexical = published.filter((diagnostic: any) =>
      /unexpected character/i.test(diagnostic.message),
    );
    assert.equal(lexical.length, broken ? 1 : 0);
    if (broken) {
      assert.equal(doc.getText(lexical[0].range), '§');
      assert.equal(lexical[0].range.start.character, 17);
    }
    const call = doc.positionAt(text.lastIndexOf('RecoveryAfter'));
    const definition = await definitions.provideDefinition(doc, call, token);
    const links = Array.isArray(definition)
      ? definition
      : definition
        ? [definition]
        : [];
    assert.equal(links.length, 1);
    validRange(doc, links[0].range);
    assert.equal(
      doc.offsetAt(links[0].range.start),
      text.indexOf('RecoveryAfter'),
    );
    const locations = await refs.provideReferences(
      doc,
      call,
      { includeDeclaration: true },
      token,
    );
    assert.equal(locations.length, 2);
    locations.forEach((location: any) => validRange(doc, location.range));
  }
});

test('root and JSDoc recovery retain completion, definition, rename and outline results after the damaged region', async () => {
  const tail =
    'function RecoveryAfter(){return {member:2};}\nvar recovered=RecoveryAfter();\nrecovered.';
  const { code, doc } = await document('RecoveryTail', tail);
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  for (const prefix of [
    '} else }\n',
    '/// @type {Real>String}\nvar annotated=1;\n',
    '/// @type {_Bad}\nvar annotated=1;\n',
    '/// @globalvar {_Bad} RecoveryDocumentedGlobal\n',
    '/// @template _T\n/// @param {_T} value\n/// @returns {_T}\nfunction RecoveryGeneric(value){return value;}\n',
    '/// @type {UnknownType}\nvar annotated=1;\n',
    '',
  ]) {
    const text = prefix + tail;
    doc.setText(text);
    const items = await completion.provideCompletionItems(
      doc,
      doc.positionAt(text.length),
      token,
      { triggerCharacter: '.' },
    );
    assert(items.some((item: any) => item.label === 'member'));
    const call = doc.positionAt(text.lastIndexOf('RecoveryAfter'));
    const definition = await definitions.provideDefinition(doc, call, token);
    const links = Array.isArray(definition)
      ? definition
      : definition
        ? [definition]
        : [];
    assert.equal(links.length, 1);
    assert.equal(
      doc.offsetAt(links[0].range.start),
      text.indexOf('RecoveryAfter'),
    );
    const edits = await rename.provideRenameEdits(
      doc,
      call,
      'RecoveryRenamed',
      token,
    );
    assert.equal(edits.operations.length, 2);
    for (const edit of edits.operations) {
      validRange(doc, edit.range);
      assert.equal(doc.getText(edit.range), 'RecoveryAfter');
    }
    const symbols = await outline.provideDocumentSymbols(doc, token);
    assert(symbols.some((symbol: any) => symbol.name === 'RecoveryAfter'));
    for (const symbol of symbols) {
      validRange(doc, symbol.range);
      validRange(doc, symbol.selectionRange);
    }
    const published = diagnostics(doc);
    published.forEach((diagnostic: any) => validRange(doc, diagnostic.range));
    const state = JSON.stringify({
      prefix,
      model: Object.values(code.getDiagnostics())
        .flat()
        .map((d: any) => d.message),
      published: published.map((d: any) => d.message),
    });
    assert.equal(
      published.some((diagnostic: any) =>
        /Unexpected closing bracket/.test(diagnostic.message),
      ),
      prefix.includes('{Real>String}'),
      state,
    );
    assert.equal(
      published.some((diagnostic: any) =>
        /between statements/.test(diagnostic.message),
      ),
      prefix.startsWith('}'),
      state,
    );
  }
});

test('signature help remains usable at missing delimiters without taking over the next statement', async () => {
  const prefix = 'function RecoveryCall(left,right){return left+right;}\n';
  const { doc } = await document('RecoverySignature', prefix);
  for (const suffix of [
    'RecoveryCall(',
    'RecoveryCall(1,',
    'RecoveryCall(1,2; var after=2;',
    'RecoveryCall(1,2); var after=2;',
  ]) {
    const text = prefix + suffix;
    doc.setText(text);
    const at = suffix.startsWith('RecoveryCall(1,2')
      ? prefix.length + 'RecoveryCall(1,'.length
      : text.length;
    const help = await workspace.provideSignatureHelp(
      doc,
      doc.positionAt(at),
      token,
    );
    assert(help, suffix);
    assert.deepEqual(
      help.signatures[0].parameters.map((parameter: any) => parameter.label),
      ['left', 'right'],
    );
    assert.equal(help.activeParameter, suffix === 'RecoveryCall(' ? 0 : 1);
    if (suffix.includes('var after')) {
      const later = await workspace.provideSignatureHelp(
        doc,
        doc.positionAt(text.indexOf('after')),
        token,
      );
      assert(
        !later,
        'A synthesized closing delimiter must end before the next declaration',
      );
    }
    diagnostics(doc).forEach((diagnostic: any) =>
      validRange(doc, diagnostic.range),
    );
  }
});

test('deep complete and malformed annotations remain usable through the real hover provider', async () => {
  const complete = 'Array<'.repeat(8192) + 'Real' + '>'.repeat(8192);
  const { doc } = await document('RecoveryDeep', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  for (const type of [complete, complete.slice(0, -1), 'Real']) {
    const text = `/// @type {${type}}\nvar deeply_typed=undefined;`;
    doc.setText(text);
    const result = await hover.provideHover(
      doc,
      doc.positionAt(text.indexOf('deeply_typed')),
      token,
    );
    assert(result);
    const expected = type === 'Real' ? 'Real' : complete;
    assert(
      result.contents.codeBlocks.some((block: any) =>
        block.value.includes(expected),
      ),
    );
    diagnostics(doc).forEach((diagnostic: any) =>
      validRange(doc, diagnostic.range),
    );
  }
});

test('empty and truncated buffers keep every public editor result finite and repair on the same document', async () => {
  const { doc } = await document('RecoveryPartial', '');
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const outlines = new host.subject.StitchDocumentSymbolProvider(workspace);
  for (const text of [
    '',
    ' \r\n\t',
    '// comment',
    'with(',
    'var partial={',
    'try{}catch(',
    'enum PartialEnum{',
    'function PartialFunction(){',
    'function RecoveryAfter(){return 2;}',
  ]) {
    doc.setText(text);
    await completion.provideCompletionItems(
      doc,
      doc.positionAt(text.length),
      token,
      {},
    );
    const symbols = await outlines.provideDocumentSymbols(doc, token);
    for (const symbol of symbols) {
      validRange(doc, symbol.range);
      validRange(doc, symbol.selectionRange);
    }
    const semantic =
      await workspace.semanticHighlightProvider.provideDocumentSemanticTokens(
        doc,
        token,
      );
    semantic.entries.forEach((entry: any) => validRange(doc, entry.range));
    diagnostics(doc).forEach((diagnostic: any) =>
      validRange(doc, diagnostic.range),
    );
    if (text.startsWith('function RecoveryAfter')) {
      assert(symbols.some((symbol: any) => symbol.name === 'RecoveryAfter'));
      assert(!symbols.some((symbol: any) => symbol.name.startsWith('Partial')));
    }
  }
});
