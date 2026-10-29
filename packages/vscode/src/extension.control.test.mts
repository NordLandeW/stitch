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

// Real parser, scope analysis and providers; the host doubles editor UI,
// scheduling and project discovery. Source offsets below are authored oracles.
test('nested and switch blocks retain function-local identity through editor consumers', async () => {
  const { doc } = await document('ControlConsumers', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const references = new host.subject.StitchReferenceProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  for (const [open, close] of [
    ['{', '}'],
    ['begin', 'end'],
  ])
    for (const newline of ['\n', '\r\n']) {
      const source = [
        'var note="😀";',
        '/// @param {Real} input',
        '/// @returns {Real}',
        'function BlockScope(input){',
        `  ${open} var inside=input; ${open} inside+=1; ${close} ${close}`,
        `  switch(input) ${open} case 1: ${open} var chosen=inside; ${close} inside=chosen;break;default: ${open} ${close} break; ${close}`,
        '  if(false) inside=0;else if(true) then inside+=1;',
        '  return inside;',
        close,
        `function BlockOther(){var inside="unrelated";return inside; ${close}`,
        'var result=BlockScope(1);',
        'var unrelated=BlockOther();',
      ].join(newline);
      doc.setText(source);
      const localUse = doc.positionAt(
        source.indexOf('return inside;') + 'return '.length,
      );
      const localHover = await hover.provideHover(doc, localUse, token);
      assert(
        localHover.contents.codeBlocks.some((block: any) =>
          block.value.includes('Real'),
        ),
      );
      assert.equal(
        diagnostics(doc).length,
        0,
        JSON.stringify(diagnostics(doc)),
      );
      const definition = await definitions.provideDefinition(
        doc,
        localUse,
        token,
      );
      const links = Array.isArray(definition)
        ? definition
        : definition
          ? [definition]
          : [];
      assert.equal(links.length, 1);
      assert.equal(
        doc.offsetAt(links[0].range.start),
        source.indexOf('var inside') + 'var '.length,
      );
      const locations = await references.provideReferences(
        doc,
        localUse,
        { includeDeclaration: true },
        token,
      );
      assert.equal(locations.length, 7);
      const edits = await rename.provideRenameEdits(
        doc,
        localUse,
        'renamedInside',
        token,
      );
      assert.equal(edits.operations.length, 7);
      for (const location of [...locations, ...edits.operations]) {
        validRange(doc, location.range);
        assert.equal(doc.getText(location.range), 'inside');
        assert(
          doc.offsetAt(location.range.start) <
            source.indexOf('function BlockOther'),
        );
      }
      const callOffset = source.lastIndexOf('BlockScope');
      const help = await workspace.provideSignatureHelp(
        doc,
        doc.positionAt(callOffset + 'BlockScope('.length),
        token,
      );
      assert(help);
      assert.match(help.signatures[0].label, /input: Real.*Real/);
      const resultHover = await hover.provideHover(
        doc,
        doc.positionAt(source.indexOf('result=')),
        token,
      );
      assert(
        resultHover.contents.codeBlocks.some((block: any) =>
          block.value.includes('Real'),
        ),
      );
      const symbols = await outline.provideDocumentSymbols(doc, token);
      assert(symbols.some((symbol: any) => symbol.name === 'BlockScope'));
      assert(symbols.some((symbol: any) => symbol.name === 'BlockOther'));
      for (const symbol of symbols) {
        validRange(doc, symbol.range);
        validRange(doc, symbol.selectionRange);
      }
    }
});

test('unsaved block damage and repair preserve diagnostics, tail members and neighboring bindings', async () => {
  const neighbor = await document(
    'ControlNeighbor',
    '/** @type {String} */ var stable=1;',
  );
  const { doc } = await document('ControlRepair', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  const tail =
    '\nfunction ControlAfter(){return {member:2};}\nvar record=ControlAfter();\nrecord.';
  const prefixes = [
    '{var value=1;}',
    '{var value=1;',
    '} {var value=1;} end',
    '{var value=1;}',
  ];
  for (const [index, prefix] of prefixes.entries()) {
    const text = 'var note="😀";\n' + prefix + tail;
    doc.setText(text);
    const items = await completion.provideCompletionItems(
      doc,
      doc.positionAt(text.length),
      token,
      { triggerCharacter: '.' },
    );
    // An unfinished block may contain the following function until repaired;
    // the lexical/parse diagnostics must remain visible in that state.
    if (index === 0 || index === 3)
      assert(items.some((item: any) => item.label === 'member'));
    const published = diagnostics(doc);
    published.forEach((diagnostic: any) => validRange(doc, diagnostic.range));
    if (index === 1 || index === 2) assert(published.length > 0);
    const symbols = await outline.provideDocumentSymbols(doc, token);
    for (const symbol of symbols) {
      validRange(doc, symbol.range);
      validRange(doc, symbol.selectionRange);
    }
    if (index === 0 || index === 3)
      assert(symbols.some((symbol: any) => symbol.name === 'ControlAfter'));
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
  const repaired =
    'var note="😀";\n{var value=1;}\nfunction ControlAfter(){return {member:2};}\nvar record=ControlAfter();\nrecord.member;';
  doc.setText(repaired);
  await hover.provideHover(
    doc,
    doc.positionAt(repaired.lastIndexOf('member')),
    token,
  );
  assert.equal(diagnostics(doc).length, 0, JSON.stringify(diagnostics(doc)));
});

test('legacy constructor, struct and for boundaries preserve member navigation and loop bindings', async () => {
  const { doc, code } = await document('LegacyConsumers', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const references = new host.subject.StitchReferenceProvider(workspace);
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  for (const newline of ['\n', '\r\n']) {
    const source = [
      'var note="😀";',
      'function ControlBox() constructor { member=begin value:1 end; end',
      'function LoopScope(){',
      ' for(var index=0;index<3;index++;;;;) begin var copied=index; end',
      ' return copied;',
      'end',
      'var box=new ControlBox();',
      'var result=LoopScope();',
      'box.member.value;',
    ].join(newline);
    doc.setText(source);
    const use = doc.positionAt(source.lastIndexOf('value'));
    const value = await hover.provideHover(doc, use, token);
    assert(
      value.contents.codeBlocks.some((block: any) =>
        block.value.includes('Real'),
      ),
    );
    assert.equal(diagnostics(doc).length, 0, JSON.stringify(diagnostics(doc)));
    const definition = await definitions.provideDefinition(doc, use, token);
    const target = Array.isArray(definition)
      ? definition
      : definition
        ? [definition]
        : [];
    assert.equal(target.length, 1);
    assert.equal(
      doc.offsetAt(target[0].range.start),
      source.indexOf('value:1'),
    );
    const indexUse = doc.positionAt(
      source.indexOf('copied=index') + 'copied='.length,
    );
    const locations = await references.provideReferences(
      doc,
      indexUse,
      { includeDeclaration: true },
      token,
    );
    assert.equal(locations.length, 4);
    for (const location of locations) {
      validRange(doc, location.range);
      assert.equal(doc.getText(location.range), 'index');
    }
    const functionEnd = source.indexOf('end' + newline + 'var box') + 2;
    const functionRef = code.getReferenceAt(source.indexOf('LoopScope'));
    assert.equal(functionRef.item.declaration.end.offset, functionEnd);
    const symbols = await outline.provideDocumentSymbols(doc, token);
    assert.equal(
      doc.offsetAt(
        symbols.find((symbol: any) => symbol.name === 'LoopScope').range.end,
      ),
      functionEnd + 1,
    );
    const partial =
      source.slice(0, source.lastIndexOf('box.member.value;')) + 'box.member.';
    doc.setText(partial);
    const items = await completion.provideCompletionItems(
      doc,
      doc.positionAt(partial.length),
      token,
      { triggerCharacter: '.' },
    );
    assert(items.some((item: any) => item.label === 'value'));
    doc.setText(source);
    await hover.provideHover(doc, use, token);
    assert.equal(diagnostics(doc).length, 0);
  }
});

test('legacy blocks retain documentation and isolate catch and with scopes', async () => {
  const source = [
    'function DocScope(){',
    ' begin /** @localvar {String} documented */ end',
    ' begin var value=1; /** @localvar {Real} trailing */ end',
    ' try begin value+=1; end catch(problem) begin var captured=problem; end finally begin value+=1; end',
    ' var localRecord=begin member:1 end;',
    ' with(localRecord) begin var copied=member; end',
    ' return documented;',
    'end',
    'function DocNeighbor(){var documented=2;return documented;}',
    'var result=DocScope();var neighbor=DocNeighbor();',
  ].join('\n');
  const { doc, code } = await document('LegacyScopes', source);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const result = await hover.provideHover(
    doc,
    doc.positionAt(source.indexOf('result=')),
    token,
  );
  assert(
    result.contents.codeBlocks.some((block: any) =>
      block.value.includes('String'),
    ),
  );
  const use = doc.positionAt(
    source.indexOf('copied=member') + 'copied='.length,
  );
  const definition = await definitions.provideDefinition(doc, use, token);
  const target = Array.isArray(definition)
    ? definition
    : definition
      ? [definition]
      : [];
  assert.equal(target.length, 1);
  assert.equal(doc.offsetAt(target[0].range.start), source.indexOf('member:1'));
  const inScope = (needle: string) =>
    code
      .getInScopeSymbolsAt(source.indexOf(needle))
      .map((item: any) => item.name);
  const problemDefinition = code.getReferenceAt(
    source.indexOf('catch(problem)') + 'catch('.length,
  );
  const problemUse = code.getReferenceAt(
    source.indexOf('captured=problem') + 'captured='.length,
  );
  assert.strictEqual(problemUse.item, problemDefinition.item);
  assert.equal(
    problemUse.item.def.start.offset,
    source.indexOf('catch(problem)') + 'catch('.length,
  );
  assert(!inScope('return documented;').includes('problem'));
  assert(inScope('return documented;').includes('trailing'));
  const neighbor = await hover.provideHover(
    doc,
    doc.positionAt(source.indexOf('neighbor=')),
    token,
  );
  assert(
    neighbor.contents.codeBlocks.some((block: any) =>
      block.value.includes('Real'),
    ),
  );
  const syntax = code.getDiagnostics().SYNTAX_ERROR;
  assert.equal(
    syntax.length,
    0,
    JSON.stringify(syntax.map((item: any) => item.message)),
  );
});

test('macro-supplied legacy blocks and incomplete delimiters refresh original-source consumers', async () => {
  const { doc } = await document('LegacyMacro', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const neighbor = await document(
    'LegacyNeighbor',
    '/** @type {String} */ var stable=1;',
  );
  const normal =
    '#macro OPEN begin\n#macro CLOSE end\nfunction MacroScope(){ OPEN var amount=1; CLOSE return amount; end\nvar result=MacroScope();';
  for (const [source, broken] of [
    [normal, false],
    [normal.replace(' end\nvar result', '\nvar result'), true],
    [normal.replace('(){ OPEN', '() OPEN'), true],
    [normal + '\nend', true],
    [normal, false],
  ] as const) {
    doc.setText(source);
    const result = await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf('return amount') + 7),
      token,
    );
    if (!broken) {
      assert(
        result.contents.codeBlocks.some((block: any) =>
          block.value.includes('Real'),
        ),
      );
      assert.equal(
        diagnostics(doc).length,
        0,
        JSON.stringify(diagnostics(doc)),
      );
      const edits = await rename.provideRenameEdits(
        doc,
        doc.positionAt(source.indexOf('return amount') + 7),
        'changed',
        token,
      );
      assert.equal(edits.operations.length, 2);
      for (const edit of edits.operations) {
        validRange(doc, edit.range);
        assert.equal(doc.getText(edit.range), 'amount');
      }
    } else assert(diagnostics(doc).length > 0);
    diagnostics(doc).forEach((item: any) => validRange(doc, item.range));
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

test('struct-literal member entry completion follows brace and legacy openers through empty and repaired input', async () => {
  const { doc, code } = await document('StructEntries', '');
  const completion = new host.subject.StitchCompletionProvider(workspace);
  for (const [open, close] of [
    ['{', '}'],
    ['begin', 'end'],
  ])
    for (const newline of ['\n', '\r\n']) {
      for (const [body, closer, broken] of [
        [' member:1, next:2 ', close, false],
        [' ', close, false],
        [' member:1, next:2 ', '', true],
        [' member:1, next:2 ', close, false],
      ] as const) {
        const source = `var note="😀";${newline}var record=${open}${body}${closer};`;
        doc.setText(source);
        const first =
          source.indexOf(open, source.indexOf('var record=')) + open.length;
        const positions = [first];
        if (body.includes(',')) positions.push(source.indexOf(',') + 1);
        for (const offset of positions) {
          const items = await completion.provideCompletionItems(
            doc,
            doc.positionAt(offset),
            token,
            {},
          );
          assert.deepEqual(
            items.map((item: any) => item.label).sort(),
            body.trim() ? ['member', 'next'] : [],
          );
          const range = code.getStructNewMemberRangeAt(offset);
          assert(range);
          assert.equal(range.start.offset, offset - 1);
          assert(
            Number.isInteger(range.end.offset) &&
              range.end.offset >= offset &&
              range.end.offset <= source.length,
          );
        }
        assert.equal(code.getDiagnostics().SYNTAX_ERROR.length > 0, broken);
        diagnostics(doc).forEach((item: any) => validRange(doc, item.range));
      }
    }
});
