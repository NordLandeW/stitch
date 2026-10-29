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
function locations(value: any) {
  return Array.isArray(value) ? value : value ? [value] : [];
}
function syntax(code: any) {
  return code.getDiagnostics().SYNTAX_ERROR;
}
function assertReal(value: any) {
  assert(
    value?.contents?.codeBlocks?.some((block: any) =>
      /\bReal\b/.test(block.value),
    ),
    JSON.stringify(value),
  );
}

// Actual Code and providers; the host doubles UI, scheduling and discovery.
test('grouped member reads and assignments retain original identities, local RHS and dot completion', async () => {
  const { code, doc } = await document('PostfixMembers', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const references = new host.subject.StitchReferenceProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  for (const newline of ['\n', '\r\n']) {
    const source = [
      'var note="😀中文";',
      'function PostfixScope(){',
      ' var record={member:1}, neighbor={member:"separate"};',
      ' var input=2;',
      ' (record).member=input;',
      ' var result=(record).member;',
      ' return result+string_length(neighbor.member);',
      '}',
      'var output=PostfixScope();',
    ].join(newline);
    doc.setText(source);
    const use = source.indexOf('(record).member;') + '(record).'.length;
    assertReal(await hover.provideHover(doc, doc.positionAt(use), token));
    assert.equal(syntax(code).length, 0);
    const target = locations(
      await definitions.provideDefinition(doc, doc.positionAt(use), token),
    );
    assert.equal(target.length, 1);
    assert.equal(
      doc.offsetAt(target[0].range.start),
      source.indexOf('member:1'),
    );
    const refs = await references.provideReferences(
      doc,
      doc.positionAt(use),
      { includeDeclaration: true },
      token,
    );
    assert.deepEqual(
      refs
        .map((ref: any) => doc.offsetAt(ref.range.start))
        .sort((a: number, b: number) => a - b),
      [source.indexOf('member:1'), source.indexOf('member=input'), use],
    );
    const edits = await rename.provideRenameEdits(
      doc,
      doc.positionAt(use),
      'renamedMember',
      token,
    );
    assert.equal(edits.operations.length, 3);
    for (const item of [...refs, ...edits.operations]) {
      validRange(doc, item.range);
      assert.equal(doc.getText(item.range), 'member');
    }
    const inputUse = source.indexOf('member=input') + 'member='.length;
    const inputTarget = locations(
      await definitions.provideDefinition(doc, doc.positionAt(inputUse), token),
    );
    assert.equal(inputTarget.length, 1);
    assert.equal(
      doc.offsetAt(inputTarget[0].range.start),
      source.indexOf('input=2'),
    );
    const symbols = await outline.provideDocumentSymbols(doc, token);
    assert(symbols.some((symbol: any) => symbol.name === 'PostfixScope'));
    for (const symbol of symbols) {
      validRange(doc, symbol.range);
      validRange(doc, symbol.selectionRange);
    }
    const damaged = source.replace('(record).member;', '(record).;');
    doc.setText(damaged);
    const cursor = damaged.indexOf('(record).;') + '(record).'.length;
    const items = await completion.provideCompletionItems(
      doc,
      doc.positionAt(cursor),
      token,
      { triggerCharacter: '.' },
    );
    assert(items.some((item: any) => item.label === 'member'));
    assert(
      !items.some(
        (item: any) => item.label === 'neighbor' || item.label === 'input',
      ),
    );
    assert(syntax(code).length > 0);
    doc.setText(source);
    assertReal(await hover.provideHover(doc, doc.positionAt(use), token));
    assert.equal(syntax(code).length, 0);
  }
});

test('literal and parenthesized roots report the final value and real call arguments', async () => {
  const source = [
    '/// @param {Real} value',
    '/// @returns {Real}',
    'function Compute(value){return value*2;}',
    'function RootScope(){',
    ' var index=0,input=2;',
    ' var direct=[10,20][index];',
    ' var grouped=([10,20])[index];',
    ' var member=({value:1}).value;',
    ' var bare={value:2}.value;',
    ' var called=(Compute)(input);',
    ' var immediate=(function(arg){return arg*2;})(input);',
    ' var directCall=function(arg){return arg*2;}(input);',
    ' return direct+grouped+member+bare+called+immediate+directCall;',
    '}',
    'var output=RootScope();',
  ].join('\n');
  const { code, doc } = await document('PostfixValues', source);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const references = new host.subject.StitchReferenceProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  for (const name of [
    'direct',
    'grouped',
    'member',
    'bare',
    'called',
    'immediate',
    'directCall',
    'output',
  ])
    assertReal(
      await hover.provideHover(
        doc,
        doc.positionAt(source.indexOf(name + '=')),
        token,
      ),
    );
  assert.equal(
    syntax(code).length,
    0,
    JSON.stringify(syntax(code).map((item: any) => item.message)),
  );
  const call = source.indexOf('(Compute)(');
  const target = locations(
    await definitions.provideDefinition(doc, doc.positionAt(call + 1), token),
  );
  assert.equal(target.length, 1);
  assert.equal(
    doc.offsetAt(target[0].range.start),
    source.indexOf('Compute(value)'),
  );
  const help = await workspace.provideSignatureHelp(
    doc,
    doc.positionAt(call + '(Compute)('.length),
    token,
  );
  assert(help);
  assert.match(help.signatures[0].label, /value: Real.*Real/);
  const edits = await rename.provideRenameEdits(
    doc,
    doc.positionAt(call + 1),
    'RenamedCompute',
    token,
  );
  assert.equal(edits.operations.length, 2);
  for (const edit of edits.operations) {
    validRange(doc, edit.range);
    assert.equal(doc.getText(edit.range), 'Compute');
  }
  for (const [name, count] of [
    ['input', 4],
    ['index', 3],
  ] as const) {
    const refs = await references.provideReferences(
      doc,
      doc.positionAt(source.indexOf(name + '=')),
      { includeDeclaration: true },
      token,
    );
    assert.equal(refs.length, count);
    for (const ref of refs) {
      validRange(doc, ref.range);
      assert.equal(doc.getText(ref.range), name);
    }
  }
  const firstArg = source.indexOf('function(arg)') + 'function('.length;
  const firstUse = source.indexOf('return arg') + 'return '.length;
  const argTarget = locations(
    await definitions.provideDefinition(doc, doc.positionAt(firstUse), token),
  );
  assert.equal(doc.offsetAt(argTarget[0].range.start), firstArg);
});

test('keyword member access preserves lexer modes, original spelling and following code', async () => {
  const { code, doc } = await document('PostfixKeywords', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  for (const name of [
    'if',
    'constructor',
    'begin',
    'end',
    'and',
    'mod',
    'not',
    'true',
    'undefined',
    'pi',
  ]) {
    const source = [
      'function KeywordScope(){',
      ' var record={};',
      ` record.${name}=1;`,
      ` var result=(record). /** property */ ${name};`,
      ` var text=$"😀 {record.${name}} tail";`,
      ' return result+string_length(text);',
      '}',
      'function AfterKeyword(){return 2;}',
      'var output=KeywordScope()+AfterKeyword();',
    ].join('\r\n');
    doc.setText(source);
    const use = source.indexOf('/** property */ ') + '/** property */ '.length;
    assertReal(await hover.provideHover(doc, doc.positionAt(use), token));
    assert.equal(
      syntax(code).length,
      0,
      JSON.stringify(syntax(code).map((item: any) => item.message)),
    );
    const target = locations(
      await definitions.provideDefinition(doc, doc.positionAt(use), token),
    );
    assert.equal(target.length, 1);
    assert.equal(
      doc.offsetAt(target[0].range.start),
      source.indexOf(`record.${name}=`) + 'record.'.length,
    );
    const edits = await rename.provideRenameEdits(
      doc,
      doc.positionAt(use),
      'renamedProperty',
      token,
    );
    assert.equal(edits.operations.length, 3);
    for (const edit of edits.operations) {
      validRange(doc, edit.range);
      assert.equal(doc.getText(edit.range), name);
    }
    assertReal(
      await hover.provideHover(
        doc,
        doc.positionAt(source.indexOf('output=')),
        token,
      ),
    );
  }
});

test('two-dimensional index slots both participate in providers and element projection', async () => {
  const source =
    'function IndexScope(){var values=[[1]],col=0,row=0;var result=values[col,row];var grid=ds_grid_create(1,1);grid[#col,row]=result;return result;}var output=IndexScope();';
  const { code, doc } = await document('PostfixIndices', source);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const references = new host.subject.StitchReferenceProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  assertReal(
    await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf('result=')),
      token,
    ),
  );
  assert.equal(syntax(code).length, 0);
  for (const name of ['col', 'row']) {
    const decl = source.indexOf(name + '=0');
    const refs = await references.provideReferences(
      doc,
      doc.positionAt(decl),
      { includeDeclaration: true },
      token,
    );
    assert.equal(refs.length, 3);
    for (const ref of refs) {
      validRange(doc, ref.range);
      assert.equal(doc.getText(ref.range), name);
      const target = locations(
        await definitions.provideDefinition(doc, ref.range.start, token),
      );
      assert.equal(doc.offsetAt(target[0].range.start), decl);
    }
  }
});

test('computed method arguments evaluate their temporary function root in the original self scope', async () => {
  const source = [
    'function ContextOwner() constructor {',
    ' member="outer";',
    ' var receiver={member:1};',
    ' var callback=method(receiver,(function(){',
    '   var captured=member;',
    '   return function(){return captured;};',
    ' })());',
    ' var direct=method(receiver,function(){return member;});',
    '}',
    'var instance=new ContextOwner();',
  ].join('\n');
  const { code, doc } = await document('PostfixMethodContext', source);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const use = source.indexOf('captured=member') + 'captured='.length;
  const target = locations(
    await definitions.provideDefinition(doc, doc.positionAt(use), token),
  );
  assert.equal(syntax(code).length, 0);
  assert.equal(target.length, 1);
  assert.equal(
    doc.offsetAt(target[0].range.start),
    source.indexOf('member="outer"'),
  );
  const directUse =
    source.indexOf('direct=method(receiver,function(){return member') +
    'direct=method(receiver,function(){return '.length;
  const directTarget = locations(
    await definitions.provideDefinition(doc, doc.positionAt(directUse), token),
  );
  assert.equal(directTarget.length, 1);
  assert.equal(
    doc.offsetAt(directTarget[0].range.start),
    source.indexOf('member:1'),
  );
});

test('computed constructors keep call results distinct from whole function bindings', async () => {
  const source = [
    '/// @param {Real} value',
    'function Record(value) constructor{member=value;}',
    'function Choose(){return Record;}',
    'function ConstructorScope(){',
    ' var factory=(function(value) constructor{member=value*2;});',
    ' var named=new (Record)(3);',
    ' var anonymous=new (function(value) constructor{member=value*2;})(3);',
    ' var selected=new (Choose())(3);',
    ' var bound=new (factory)(3);',
    ' var immediate=(function(){return 4;})();',
    ' return named.member+anonymous.member+selected.member+bound.member+immediate;',
    '}',
    'var output=ConstructorScope();',
  ].join('\n');
  const { code, doc } = await document('PostfixConstructors', source);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  assertReal(
    await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf('output=')),
      token,
    ),
  );
  assert.equal(syntax(code).length, 0);
  for (const name of ['named', 'selected']) {
    const use = source.indexOf(name + '.member') + name.length + 1;
    const info = await hover.provideHover(doc, doc.positionAt(use), token);
    assert(
      info,
      `${name} has no member hover; ${JSON.stringify(code.sourceRefs.map((ref: any) => ({ name: ref.item?.name, type: ref.item?.type?.toFeatherString?.(), offset: ref.start?.offset })))} `,
    );
    assertReal(info);
    const target = locations(
      await definitions.provideDefinition(doc, doc.positionAt(use), token),
    );
    assert.equal(target.length, 1);
    assert.equal(
      doc.offsetAt(target[0].range.start),
      source.indexOf('member=value;'),
    );
  }
  for (const name of ['anonymous', 'bound'])
    assertReal(
      await hover.provideHover(
        doc,
        doc.positionAt(source.indexOf(name + '.member') + name.length + 1),
        token,
      ),
    );
  const help = await workspace.provideSignatureHelp(
    doc,
    doc.positionAt(source.indexOf('new (Record)(3)') + 'new (Record)('.length),
    token,
  );
  assert(help);
  assert.match(help.signatures[0].label, /value: Real/);
  const symbols = await outline.provideDocumentSymbols(doc, token);
  const flat = (items: any[]): any[] =>
    items.flatMap((item) => [item, ...flat(item.children || [])]);
  const all = flat(symbols);
  assert(all.some((symbol: any) => symbol.name === 'factory'));
  assert(!all.some((symbol: any) => symbol.name === 'immediate'));
  for (const symbol of all) {
    validRange(doc, symbol.range);
    validRange(doc, symbol.selectionRange);
  }
});

test('new invalid postfix combinations diagnose, retain later symbols and recover on repair', async () => {
  const { code, doc } = await document('PostfixInvalid', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const repaired =
    'function Record() constructor{} function InvalidScope(){var values=[1],record={member:1};(record).member=2;return (values)[0];}var tail=2;';
  for (const bad of [
    '(values)[0]=2',
    '(values)[@0]=2',
    '(values)[0].member=2',
    'var x=(record)[$"member"]',
    'var x=(values)[|0]',
    'var x=(values)[?"key"]',
    'var x=(values)[#0,0]',
    'var x=new (Record)',
    'var x=new (Record())',
    'var x=new (function() constructor{})',
    'var x=new function() constructor{}',
  ]) {
    const source = `function Record() constructor{} function InvalidScope(){var values=[1],record={member:1};${bad};return 1;}var tail=2;`;
    doc.setText(source);
    assertReal(
      await hover.provideHover(
        doc,
        doc.positionAt(source.indexOf('tail=')),
        token,
      ),
    );
    const errors = code
      .getDiagnostics()
      .INVALID_OPERATION.filter((item: any) => item.severity === 'error');
    assert(errors.length > 0, bad);
    for (const error of errors) {
      assert(Number.isFinite(error.location.start.offset));
      assert(Number.isFinite(error.location.end.offset));
    }
    doc.setText(repaired);
    assertReal(
      await hover.provideHover(
        doc,
        doc.positionAt(repaired.indexOf('tail=')),
        token,
      ),
    );
    assert.equal(code.getDiagnostics().INVALID_OPERATION.length, 0);
    assert.equal(syntax(code).length, 0);
  }
});

test('grouped globals, inherited calls and macro expansion preserve physical navigation', async () => {
  const globalSource =
    'var before=(global).postfix_global;(global).postfix_global=1;';
  const first = await document('PostfixGlobal', globalSource);
  const second = await document(
    'PostfixGlobalUse',
    'var after=(global).postfix_global;',
  );
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  assertReal(
    await hover.provideHover(second.doc, second.doc.positionAt(4), token),
  );
  const target = locations(
    await definitions.provideDefinition(
      second.doc,
      second.doc.positionAt(second.doc.getText().indexOf('postfix_global')),
      token,
    ),
  );
  assert.equal(target.length, 1);
  assert.equal(target[0].uri.toString(), first.doc.uri.toString());
  assert.equal(
    first.doc.offsetAt(target[0].range.start),
    globalSource.lastIndexOf('postfix_global'),
  );
  const inherited = await document('PostfixInherited', '(event_inherited)();');
  await hover.provideHover(inherited.doc, inherited.doc.positionAt(1), token);
  assert.equal(inherited.code.callsSuper, true);
  inherited.doc.setText('var callback=(event_inherited);');
  await hover.provideHover(inherited.doc, inherited.doc.positionAt(4), token);
  assert.equal(inherited.code.callsSuper, false);
  const source =
    '#macro GROUP (record)\r\nfunction MacroScope(){var record={member:1};return GROUP.member;}\r\nvar output=MacroScope();';
  const { code, doc } = await document('PostfixMacro', source);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const use = source.indexOf('GROUP.member') + 'GROUP.'.length;
  assertReal(await hover.provideHover(doc, doc.positionAt(use), token));
  assert.equal(code.content, source);
  assert.equal(syntax(code).length, 0);
  const member = locations(
    await definitions.provideDefinition(doc, doc.positionAt(use), token),
  );
  assert.equal(member.length, 1);
  assert.equal(doc.offsetAt(member[0].range.start), source.indexOf('member:1'));
  const edits = await rename.provideRenameEdits(
    doc,
    doc.positionAt(use),
    'renamedMember',
    token,
  );
  assert.equal(edits.operations.length, 2);
  for (const edit of edits.operations) {
    validRange(doc, edit.range);
    assert.equal(doc.getText(edit.range), 'member');
  }
});

test('incomplete calls and indices keep physical results available through repair', async () => {
  const source =
    '/// @param {Real} value\n/// @returns {Real}\nfunction Compute(value){return value*2;}\nfunction RepairScope(){var index=0;var value=(Compute)(2);var item=[1,2][index];return value+item;}var tail=2;';
  const { code, doc } = await document('PostfixRepair', source);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const references = new host.subject.StitchReferenceProvider(workspace);
  for (const damaged of [
    source.replace('(Compute)(2)', '(Compute)('),
    source.replace('[1,2][index]', '[1,2]['),
    source.replace('(Compute)(2)', '(Compute)(,'),
  ]) {
    doc.setText(damaged);
    await hover.provideHover(
      doc,
      doc.positionAt(damaged.indexOf('Compute(value)')),
      token,
    );
    assert(syntax(code).length > 0);
    for (const diagnostic of syntax(code)) {
      assert(Number.isFinite(diagnostic.location.start.offset));
      assert(Number.isFinite(diagnostic.location.end.offset));
    }
    doc.setText(source);
    assertReal(
      await hover.provideHover(
        doc,
        doc.positionAt(source.indexOf('tail=')),
        token,
      ),
    );
    assert.equal(syntax(code).length, 0);
    const refs = await references.provideReferences(
      doc,
      doc.positionAt(source.indexOf('index=0')),
      { includeDeclaration: true },
      token,
    );
    assert.equal(refs.length, 2);
    for (const ref of refs) {
      validRange(doc, ref.range);
      assert.equal(doc.getText(ref.range), 'index');
    }
  }
});

test('bare keyword struct entries retain member identity and lexer context', async () => {
  const { code, doc } = await document('PostfixKeys', '');
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const accepted = [
    'pointer_null',
    'pointer_invalid',
    'undefined',
    'infinity',
    'pi',
    'NaN',
    'true',
    'false',
    'begin',
    'if',
    'then',
    'else',
    'while',
    'do',
    'for',
    'break',
    'continue',
    'with',
    'until',
    'repeat',
    'exit',
    'return',
    'switch',
    'case',
    'default',
    'var',
    'global',
    'globalvar',
    'try',
    'catch',
    'finally',
    'static',
    'new',
    'delete',
    'constructor',
    'self',
    'other',
    'noone',
    'all',
  ];
  for (const name of accepted) {
    const source = `function KeyScope(){var record={${name}:1};var value=(record).${name};return value;}var tail=KeyScope();`;
    doc.setText(source);
    const use = source.indexOf('(record).') + '(record).'.length;
    assertReal(await hover.provideHover(doc, doc.positionAt(use), token));
    assert.equal(syntax(code).length, 0, name);
    const target = locations(
      await definitions.provideDefinition(doc, doc.positionAt(use), token),
    );
    assert.equal(target.length, 1, name);
    assert.equal(
      doc.offsetAt(target[0].range.start),
      source.indexOf(name + ':1'),
      name,
    );
    const edits = await rename.provideRenameEdits(
      doc,
      doc.positionAt(use),
      'memberRenamed',
      token,
    );
    assert.equal(edits.operations.length, 2, name);
    for (const edit of edits.operations) {
      validRange(doc, edit.range);
      assert.equal(doc.getText(edit.range), name);
    }
  }
  for (const name of [
    'end',
    'and',
    'or',
    'xor',
    'not',
    'mod',
    'div',
    'enum',
    'function',
  ]) {
    const source = `function KeyScope(){var record={${name}:1};return 1;}var tail=2;`;
    doc.setText(source);
    await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf('tail=')),
      token,
    );
    assert(syntax(code).length > 0, name);
  }
  for (const [open, close] of [
    ['{', '}'],
    ['begin', 'end'],
  ])
    for (const separator of [' ', '/** comment */ ', '// comment\r\n']) {
      const source = `function KeyScope(){var record=${open} begin${separator}:1,if:2, ${close};var text=$"😀 {record.begin}";return record.if;}var tail=KeyScope();`;
      doc.setText(source);
      assertReal(
        await hover.provideHover(
          doc,
          doc.positionAt(source.indexOf('tail=')),
          token,
        ),
      );
      assert.equal(syntax(code).length, 0, source);
      const partial = source.replace('if:2,', '');
      doc.setText(partial);
      const cursor = partial.indexOf(` ${close};`);
      const items = await completion.provideCompletionItems(
        doc,
        doc.positionAt(cursor),
        token,
        {},
      );
      assert(!items.some((item: any) => item.label === 'record'), source);
      doc.setText(source);
      assertReal(
        await hover.provideHover(
          doc,
          doc.positionAt(source.indexOf('tail=')),
          token,
        ),
      );
      assert.equal(syntax(code).length, 0);
    }
});

test('returned functions retain callable signatures and original parameter identities', async () => {
  const source =
    '/// @param {Real} value\n/// @returns {Real}\nfunction Double(value){return value*2;}\nfunction Select(){return Double;}\nfunction ReturnScope(){var input=2;var result=Select()(input);var grouped=(Select())(input);return result+grouped;}var output=ReturnScope();';
  const { code, doc } = await document('PostfixReturnedCall', source);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  for (const name of ['result', 'grouped', 'output'])
    assertReal(
      await hover.provideHover(
        doc,
        doc.positionAt(source.indexOf(name + '=')),
        token,
      ),
    );
  assert.equal(syntax(code).length, 0);
  for (const prefix of ['Select()(', '(Select())(']) {
    const offset = source.indexOf(prefix) + prefix.length;
    const help = await workspace.provideSignatureHelp(
      doc,
      doc.positionAt(offset),
      token,
    );
    assert(help);
    assert.match(help.signatures[0].label, /value: Real.*Real/);
    const target = locations(
      await definitions.provideDefinition(doc, doc.positionAt(offset), token),
    );
    assert.equal(target.length, 1);
    assert.equal(
      doc.offsetAt(target[0].range.start),
      source.indexOf('input=2'),
    );
  }
});

test('keyword-named members can be renamed while actual self, other and global stay protected', async () => {
  const source =
    'function KeywordOwner() constructor{var receiver={self:1,other:2,global:3};var value=receiver.self+receiver.other+receiver.global;var mine=self;with(receiver){var enclosing=other;}var globals=global;}var instance=new KeywordOwner();';
  const { doc } = await document('PostfixKeywordIdentity', source);
  const rename = new host.subject.StitchRenameProvider(workspace);
  for (const name of ['self', 'other', 'global']) {
    const edits = await rename.provideRenameEdits(
      doc,
      doc.positionAt(source.indexOf('receiver.' + name) + 'receiver.'.length),
      'memberRenamed',
      token,
    );
    assert.equal(edits.operations.length, 2, name);
    for (const edit of edits.operations) {
      validRange(doc, edit.range);
      assert.equal(doc.getText(edit.range), name);
    }
  }
  for (const needle of ['mine=self', 'enclosing=other', 'globals=global']) {
    const offset = source.indexOf(needle) + needle.indexOf('=') + 1;
    await assert.rejects(() =>
      rename.provideRenameEdits(
        doc,
        doc.positionAt(offset),
        'NotAScopeKeyword',
        token,
      ),
    );
  }
  const owner = await rename.provideRenameEdits(
    doc,
    doc.positionAt(source.indexOf('KeywordOwner')),
    'RenamedOwner',
    token,
  );
  assert.equal(owner.operations.length, 2);
  for (const edit of owner.operations)
    assert.equal(doc.getText(edit.range), 'KeywordOwner');
});

test('same-named struct members do not make fixed scope keywords renameable', async () => {
  for (const name of ['self', 'other']) {
    const body =
      name === 'self'
        ? 'return self.member;'
        : 'with({}){var captured=other.member;}return 1;';
    const source = `function Collision(){var record={${name}:{member:1}};var callback=method(record.${name},function(){${body}});return callback();}var output=Collision();`;
    const { doc } = await document('PostfixScopeCollision' + name, source);
    const rename = new host.subject.StitchRenameProvider(workspace);
    const key = source.indexOf(name + ':{');
    const qualified = source.indexOf('record.' + name) + 'record.'.length;
    const fixed =
      name === 'self'
        ? source.indexOf('return self.member') + 'return '.length
        : source.indexOf('captured=other') + 'captured='.length;
    for (const offset of [key, qualified]) {
      const edits = await rename.provideRenameEdits(
        doc,
        doc.positionAt(offset),
        'renamedReceiver',
        token,
      );
      assert.deepEqual(
        edits.operations
          .map((edit: any) => doc.offsetAt(edit.range.start))
          .sort((a: number, b: number) => a - b),
        [key, qualified],
      );
    }
    await assert.rejects(() =>
      rename.prepareRename(doc, doc.positionAt(fixed), token),
    );
    await assert.rejects(() =>
      rename.provideRenameEdits(doc, doc.positionAt(fixed), 'NotSelf', token),
    );
  }
});

test('shared macro spelling cannot rename a member and a fixed scope keyword together', async () => {
  const source =
    '#macro MEMBER self\nfunction Collision(){var record={self:{member:1}};var callback=method(record.MEMBER,function(){return MEMBER.member;});return callback();}var output=Collision();';
  const repaired = source.replace('return MEMBER.member;', 'return 1;');
  const { doc } = await document('PostfixMacroScopeCollision', repaired);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const initial = await rename.provideRenameEdits(
    doc,
    doc.positionAt(repaired.indexOf('self:{')),
    'renamedReceiver',
    token,
  );
  assert.equal(initial.operations.length, 2);
  doc.setText(source);
  await assert.rejects(
    () =>
      rename.provideRenameEdits(
        doc,
        doc.positionAt(source.indexOf('self:{')),
        'renamedReceiver',
        token,
      ),
    /fixed scope keyword/,
  );
  await assert.rejects(() =>
    rename.prepareRename(doc, doc.positionAt(source.indexOf('self\n')), token),
  );
  const macro = await rename.provideRenameEdits(
    doc,
    doc.positionAt(source.indexOf('MEMBER')),
    'OTHER_MACRO',
    token,
  );
  assert.equal(macro.operations.length, 3);
  for (const edit of macro.operations)
    assert.equal(doc.getText(edit.range), 'MEMBER');
  doc.setText(repaired);
  const member = await rename.provideRenameEdits(
    doc,
    doc.positionAt(repaired.indexOf('self:{')),
    'renamedReceiver',
    token,
  );
  assert.deepEqual(
    member.operations
      .map((edit: any) => doc.offsetAt(edit.range.start))
      .sort((a: number, b: number) => a - b),
    [repaired.indexOf('self\n'), repaired.indexOf('self:{')],
  );
});

test('operated literal roots do not bind their temporary value to the final variable', async () => {
  const source =
    'function ValueScope(){var negated=!(function(){return 1;});var compared=({member:1})==({member:2});return negated||compared;}var output=ValueScope();';
  const { code, doc } = await document('PostfixOperatedValues', source);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const outline = new host.subject.StitchDocumentSymbolProvider(workspace);
  for (const name of ['negated', 'compared', 'output']) {
    const value = await hover.provideHover(
      doc,
      doc.positionAt(source.indexOf(name + '=')),
      token,
    );
    assert(
      value?.contents?.codeBlocks?.some((block: any) =>
        /\bBool\b/.test(block.value),
      ),
      name + ': ' + JSON.stringify(value),
    );
  }
  assert.equal(syntax(code).length, 0);
  const symbols = await outline.provideDocumentSymbols(doc, token);
  const visit = (items: any[]): any[] =>
    items.flatMap((item) => [item, ...visit(item.children || [])]);
  assert(
    !visit(symbols).some(
      (item: any) => item.name === 'negated' || item.name === 'compared',
    ),
  );
});
