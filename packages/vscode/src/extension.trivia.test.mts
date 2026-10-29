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

// Real providers, parser and refresh; the host doubles only editor UI,
// scheduling and project discovery. No extension installation or game run.
test('comment trivia preserves annotated hover, signatures, navigation, rename, members and outline at authored positions', async () => {
  const { doc } = await document('TriviaConsumers', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  for (const newline of ['\n', '\r\n']) {
    const source = [
      'var note="😀";',
      '#region title !!!',
      '/// @description Callable documentation',
      '/// @param {String} input Input documentation',
      '/// @returns {Real}',
      'function Commented(/** @type {Bool} */ input) /** ordinary */ {return 1 /** ignored */+2;}',
      '/** @type {String} Local documentation */ var annotated=1;',
      'var result=Commented(/** ordinary */ "ok");',
      '#endregion done!!!',
      'var record={/** @type {String} */ member:1};',
      'record.member;',
    ].join(newline);
    doc.setText(source);
    const result = await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf('annotated')),
      token,
    );
    assert(
      result.contents.codeBlocks.some((block: any) =>
        block.value.includes('String'),
      ),
    );
    assert.match(JSON.stringify(result), /Local documentation/);
    const callOffset = source.lastIndexOf('Commented');
    const functionHover = await hover.provideHover(
      doc,
      doc.positionAt(callOffset),
      token,
    );
    assert.match(JSON.stringify(functionHover), /Callable documentation/);
    const target = await definitions.provideDefinition(
      doc,
      doc.positionAt(callOffset),
      token,
    );
    const links = Array.isArray(target) ? target : target ? [target] : [];
    assert.equal(links.length, 1);
    validRange(doc, links[0].range);
    assert.equal(
      doc.offsetAt(links[0].range.start),
      source.indexOf('function Commented') + 'function '.length,
    );
    const edits = await rename.provideRenameEdits(
      doc,
      doc.positionAt(callOffset),
      'RenamedCommented',
      token,
    );
    assert.equal(edits.operations.length, 2);
    for (const edit of edits.operations) {
      validRange(doc, edit.range);
      assert.equal(doc.getText(edit.range), 'Commented');
    }
    const help = await workspace.provideSignatureHelp(
      doc,
      doc.positionAt(callOffset + 'Commented('.length),
      token,
    );
    assert(help);
    assert.deepEqual(
      help.signatures[0].parameters.map((parameter: any) => parameter.label),
      ['input'],
    );
    assert.match(help.signatures[0].label, /input: String.*Real/);
    assert.match(
      help.signatures[0].parameters[0].documentation,
      /Input documentation/,
    );
    const symbols = await outline.provideDocumentSymbols(doc, token);
    assert(symbols.some((symbol: any) => symbol.name === 'Commented'));
    for (const symbol of symbols) {
      validRange(doc, symbol.range);
      validRange(doc, symbol.selectionRange);
    }
    const partial =
      source.slice(0, source.lastIndexOf('record.member;')) + 'record.';
    doc.setText(partial);
    const items = await completion.provideCompletionItems(
      doc,
      doc.positionAt(partial.length),
      token,
      { triggerCharacter: '.' },
    );
    assert(items.some((item: any) => item.label === 'member'));
    diagnostics(doc).forEach((diagnostic: any) =>
      validRange(doc, diagnostic.range),
    );
    doc.setText(source);
    await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf('annotated')),
      token,
    );
    assert.equal(diagnostics(doc).length, 0);
  }
});

test('comment close, inline annotations and source repair refresh consumers without stale neighboring documentation', async () => {
  const neighbor = await document(
    'TriviaNeighbor',
    '/** @type {String} */ var stable=1;',
  );
  const { doc } = await document('TriviaChanges', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  const tail = 'function TriviaAfter(){return 2;} var result=TriviaAfter();';
  for (const prefix of [
    '/* slash\\*/ ',
    'var value=1 + /** @type {String} */ 2; ',
    '#region title\n#endregion !!!\n',
    '/* unfinished ',
    '',
  ]) {
    const source = prefix + tail;
    doc.setText(source);
    // A foreground query flushes the unsaved buffer before the background
    // outline request; the host intentionally does not run debounce timers.
    const result = await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf('result')),
      token,
    );
    const symbols = await outline.provideDocumentSymbols(doc, token);
    assert.equal(
      symbols.some((symbol: any) => symbol.name === 'TriviaAfter'),
      !prefix.includes('unfinished'),
      prefix,
    );
    if (!prefix.includes('unfinished')) {
      assert(
        result.contents.codeBlocks.some((block: any) =>
          block.value.includes('Real'),
        ),
      );
    }
    for (const symbol of symbols) validRange(doc, symbol.range);
    diagnostics(doc).forEach((diagnostic: any) =>
      validRange(doc, diagnostic.range),
    );
    const stable = await hover.provideHover(
      neighbor.doc,
      neighbor.doc.positionAt(neighbor.doc.getText().indexOf('stable')),
      token,
    );
    assert(
      stable.contents.codeBlocks.some((block: any) =>
        block.value.includes('String'),
      ),
    );
  }
});
