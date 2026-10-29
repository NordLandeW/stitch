import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createHost, deferred } from './test/host.mjs';

let host: Awaited<ReturnType<typeof createHost>>;
let workspace: any;
let project: any;
const token = { isCancellationRequested: false };
beforeEach(async () => {
  host = await createHost();
  workspace = host.newWorkspace();
  project = await host.project();
  workspace.projects.push(project);
});
afterEach(() => host?.dispose());
async function document(name: string, text: string) {
  const code = await host.subject.addCode(project, name, text);
  const doc = host.document(code, text);
  host.documents.push(doc);
  return { code, doc };
}
const position = (doc: any, needle: string, delta = 0) => {
  const at = doc.getText().indexOf(needle);
  assert(at >= 0, `Missing independent source position ${needle}`);
  return doc.positionAt(at + delta);
};
const locationKey = (location: any) =>
  `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;

test('real definition, reference, hover and rename providers distinguish macro identities and shared bindings', async () => {
  const defs = await document(
    'MacroDefs',
    '#macro PICK local_value\n#macro WRAP PICK',
  );
  const usage = await document(
    'MacroUse',
    'function number_context() {\n var local_value = 1;\n return WRAP;\n}\nfunction text_context() {\n var local_value = "text";\n return WRAP;\n}',
  );
  const definitions = new host.subject.StitchDefinitionsProvider(workspace);
  const refs = new host.subject.StitchReferenceProvider(workspace);
  const rename = new host.subject.StitchRenameProvider(workspace);
  const hover = new host.subject.StitchHoverProvider(workspace);
  const macroResult = await definitions.provideDefinition(
    usage.doc,
    position(usage.doc, 'WRAP'),
    token,
  );
  const macroDefinition = Array.isArray(macroResult)
    ? macroResult
    : macroResult
      ? [macroResult]
      : [];
  assert.equal(macroDefinition.length, 1);
  assert.equal(macroDefinition[0].uri.toString(), defs.doc.uri.toString());
  assert.deepEqual(
    macroDefinition[0].range.start,
    new host.vscode.Position(1, 7),
  );
  const locals = await definitions.provideDefinition(
    defs.doc,
    position(defs.doc, 'local_value'),
    token,
  );
  assert.deepEqual(
    locals.map((item: any) => item.range.start.line).sort(),
    [1, 5],
  );
  assert(
    locals.every(
      (item: any) => item.uri.toString() === usage.doc.uri.toString(),
    ),
  );
  const occurrences = await refs.provideReferences(
    usage.doc,
    position(usage.doc, 'WRAP'),
    { includeDeclaration: true },
    token,
  );
  assert.equal(occurrences.length, 3);
  assert.equal(new Set(occurrences.map(locationKey)).size, 3);
  const info = await hover.provideHover(
    defs.doc,
    position(defs.doc, 'local_value'),
    token,
  );
  assert(
    info.contents.codeBlocks.some((block: any) => block.value.includes('Real')),
  );
  assert(
    info.contents.codeBlocks.some((block: any) =>
      block.value.includes('String'),
    ),
  );
  const edits = await rename.provideRenameEdits(
    usage.doc,
    position(usage.doc, 'WRAP'),
    'NEXT_WRAP',
    token,
  );
  assert.equal(edits.operations.length, 3);
  for (const edit of edits.operations) {
    const doc =
      edit.uri.toString() === defs.doc.uri.toString() ? defs.doc : usage.doc;
    assert.equal(doc.getText(edit.range), 'WRAP');
    assert.equal(edit.newText, 'NEXT_WRAP');
  }
  await assert.rejects(
    rename.prepareRename(defs.doc, position(defs.doc, 'local_value'), token),
    /unique symbol reference/,
  );
  await assert.rejects(
    rename.provideRenameEdits(
      usage.doc,
      position(usage.doc, 'local_value'),
      'renamed_local',
      token,
    ),
    /shared macro spelling/,
  );
});

test('real completion, signature and semantic-token providers query original positions after expansion', async () => {
  await document(
    'MacroDefs',
    '#macro VALUE { alpha: 1, beta: "text" }\n#macro CALL add_numbers',
  );
  const usage = await document(
    'MacroUse',
    '// emoji 😀 before offsets\nfunction add_numbers(left, right) { return left + right; }\nvar value = VALUE;\nCALL(1, 2);\nvalue.',
  );
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const items = await completion.provideCompletionItems(
    usage.doc,
    usage.doc.positionAt(usage.doc.getText().length),
    token,
    { triggerCharacter: '.' },
  );
  assert(items.some((item: any) => item.label === 'alpha'));
  assert(items.some((item: any) => item.label === 'beta'));
  const help = await workspace.provideSignatureHelp(
    usage.doc,
    position(usage.doc, '2);'),
    token,
  );
  assert.equal(help.activeParameter, 1);
  assert.deepEqual(
    help.signatures[0].parameters.map((parameter: any) => parameter.label),
    ['left', 'right'],
  );
  const tokens =
    await workspace.semanticHighlightProvider.provideDocumentSemanticTokens(
      usage.doc,
      token,
    );
  const value = tokens.entries.find(
    (entry: any) => usage.doc.getText(entry.range) === 'VALUE',
  );
  assert(value);
  assert.equal(value.type, 'macro');
  assert(value.modifiers.includes('readonly'));
  const spans = tokens.entries
    .map((entry: any) => [
      usage.doc.offsetAt(entry.range.start),
      usage.doc.offsetAt(entry.range.end),
    ])
    .sort((a: number[], b: number[]) => a[0] - b[0]);
  assert(
    spans.every(
      (span: number[], index: number) =>
        span[0] >= 0 &&
        span[1] > span[0] &&
        span[1] <= usage.doc.getText().length &&
        (!index || spans[index - 1][1] <= span[0]),
    ),
  );
});

test('unchanged user queries flush unsaved macro additions, edits, removal and repair through the workspace', async () => {
  const defs = await document('MacroDefs', '');
  const usage = await document('MacroUse', 'var value = VALUE;\nvalue.');
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const query = async () =>
    (
      await completion.provideCompletionItems(
        usage.doc,
        usage.doc.positionAt(usage.doc.getText().length),
        token,
        { triggerCharacter: '.' },
      )
    )?.map((item: any) => item.label) || [];
  const version = usage.doc.version;
  for (const [text, required, absent] of [
    ['#macro VALUE { first_member: 1 }', 'first_member', 'second_member'],
    ['#macro VALUE { second_member: 2 }', 'second_member', 'first_member'],
    ['', '', 'second_member'],
    ['#macro VALUE { repaired_member: 3 }', 'repaired_member', 'second_member'],
  ]) {
    defs.doc.setText(text);
    const members = await query();
    if (required) assert(members.includes(required), `Missing ${required}`);
    assert(!members.includes(absent));
    assert.equal(usage.doc.version, version);
    assert.equal(usage.code.content, usage.doc.getText());
  }
});

test('real settings and Run Later selection refresh unchanged users and outline every configuration declaration', async () => {
  await host.subject.activateStitchExtension(workspace, host.ctx);
  workspace.projects.push(project);
  const defs = await document(
    'MacroDefs',
    '#macro VALUE { base_member: 1 }\n#macro Test:VALUE { test_member: 1 }',
  );
  const usage = await document('MacroUse', 'var value = VALUE;\nvalue.');
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const query = async () =>
    (
      await completion.provideCompletionItems(
        usage.doc,
        usage.doc.positionAt(usage.doc.getText().length),
        token,
        { triggerCharacter: '.' },
      )
    ).map((item: any) => item.label);
  assert((await query()).includes('base_member'));
  host.settings.set('run.defaultConfig', 'Test');
  host.events.configuration.fire({
    affectsConfiguration: (name: string) => name === 'stitch.run.defaultConfig',
  });
  assert((await query()).includes('test_member'));
  assert(!(await query()).includes('base_member'));
  const answers: unknown[] = [
    'Default',
    'vm',
    { label: 'Run Later', now: false },
  ];
  host.vscode.window.showQuickPick = async () => answers.shift();
  await host.commandCallbacks.get('stitch.run.noDefaults')();
  assert.equal(answers.length, 0);
  assert.equal(project.analysisConfiguration, 'Default');
  assert((await query()).includes('base_member'));
  assert.equal(host.ctx.workspaceState.get('lastRunConfig').config, 'Default');
  const outline = await new host.subject.StitchDocumentSymbolProvider(
    workspace,
  ).provideDocumentSymbols(defs.doc, token);
  assert.deepEqual(
    outline.map((item: any) => [
      item.name,
      item.detail,
      item.selectionRange.start.line,
      item.selectionRange.start.character,
    ]),
    [
      ['VALUE', '', 0, 7],
      ['VALUE', 'Test', 1, 12],
    ],
  );
  for (const item of outline)
    assert.equal(defs.doc.getText(item.selectionRange), 'VALUE');
});

test('stale saved targets do not prevent loading another project; explicit invalid runs fail before side effects', async () => {
  await host.ctx.workspaceState.update('lastRunConfig', {
    config: 'OtherProjectOnly',
    compiler: 'vm',
  });
  const loaded = await workspace.loadProject(
    host.vscode.Uri.file(`${host.root}/second.yyp`),
    () => {},
  );
  assert.equal(loaded.analysisConfiguration, 'Default');
  assert.equal(workspace.savedRunOptions(loaded), undefined);
  let kills = 0;
  loaded.kill = async () => {
    kills++;
  };
  loaded.resolveRuntime = async () => undefined;
  await assert.rejects(
    loaded.run({ config: 'Missing' }),
    /Unknown GameMaker configuration/,
  );
  assert.equal(kills, 0);
  assert.equal(await loaded.run({ config: 'Test' }), false);
  assert.equal(loaded.analysisConfiguration, 'Test');
  loaded.yyp.configs.children = [];
  loaded.macros.configurationTreeChanged();
  loaded.macros.flush();
  assert.equal(loaded.analysisConfiguration, 'Default');
});

test('YY reload keeps the latest open macro buffer, then retires missing code through Asset.reload', async () => {
  const defs = await document('MacroDefs', '#macro VALUE 1');
  const usage = await document('MacroUse', 'var result_value = VALUE;');
  const entered = deferred();
  const read = deferred<string>();
  defs.code.asset.readYy = async () => {};
  // Asset.dir is a computed Pathy. Keep this test's I/O double stable across reads.
  Object.defineProperty(defs.code.asset, 'dir', { value: defs.code.asset.dir });
  defs.code.asset.dir.listChildren = async () => [defs.code.path];
  defs.code.path.read = async () => {
    entered.resolve();
    return read.promise;
  };
  const reloading = workspace.reloadAsset(defs.code.asset);
  await entered.promise;
  defs.doc.setText('#macro VALUE "latest"');
  const waiting = workspace.ensureDocumentCurrent(usage.doc, token);
  read.resolve('#macro VALUE 1');
  await reloading;
  await waiting;
  assert.equal(defs.code.content, '#macro VALUE "latest"');
  assert.equal(
    usage.code.getReferenceAt(usage.doc.getText().indexOf('result_value')).item
      .type.kind,
    'String',
  );
  defs.code.asset.dir.listChildren = async () => [];
  await workspace.reloadAsset(defs.code.asset);
  assert.equal(workspace.getGmlFile(defs.doc), undefined);
  assert(
    usage.code
      .getDiagnostics()
      .UNDECLARED_GLOBAL_REFERENCE.some((item: any) =>
        item.message.includes('VALUE'),
      ),
  );
});

test('closing an unsaved macro buffer during YY reload cannot restore the earlier disk snapshot', async () => {
  const defs = await document('MacroDefs', '#macro VALUE "unsaved"');
  const usage = await document('MacroUse', 'var result_value = VALUE;');
  const entered = deferred();
  const read = deferred<string>();
  let reads = 0;
  defs.code.asset.readYy = async () => {};
  // Asset.dir is a computed Pathy. Keep this test's I/O double stable across reads.
  Object.defineProperty(defs.code.asset, 'dir', { value: defs.code.asset.dir });
  defs.code.asset.dir.listChildren = async () => [defs.code.path];
  defs.code.path.read = async () => {
    if (++reads === 1) {
      entered.resolve();
      return read.promise;
    }
    return '#macro VALUE 42';
  };
  const reloading = workspace.reloadAsset(defs.code.asset);
  await entered.promise;
  defs.doc.isClosed = true;
  await workspace.onCloseDoc(defs.doc);
  read.resolve('#macro VALUE "older disk"');
  await reloading;
  await workspace.ensureDocumentCurrent(usage.doc, token);
  assert.equal(defs.code.content, '#macro VALUE 42');
  assert.equal(
    usage.code.getReferenceAt(usage.doc.getText().indexOf('result_value')).item
      .type.kind,
    'Real',
  );
});

test('the rename provider can produce and consume a valid keyword macro when no code word is captured', async () => {
  const defs = await document('MacroDefs', '#macro PICK 7');
  const usage = await document('MacroUse', 'var result_value = PICK;');
  const rename = new host.subject.StitchRenameProvider(workspace);
  const edits = await rename.provideRenameEdits(
    usage.doc,
    position(usage.doc, 'PICK'),
    'if',
    token,
  );
  assert.equal(edits.operations.length, 2);
  assert(edits.operations.every((edit: any) => edit.newText === 'if'));
  defs.doc.setText('#macro if 7');
  usage.doc.setText('var result_value = if;');
  await workspace.ensureDocumentCurrent(usage.doc, token);
  assert.equal(
    usage.code.getReferenceAt(usage.doc.getText().indexOf('result_value')).item
      .type.kind,
    'Real',
  );
  assert.equal(
    usage.code.getReferenceAt(usage.doc.getText().indexOf('if')).item.macro,
    true,
  );
  assert.equal(usage.code.getDiagnostics().SYNTAX_ERROR.length, 0);
});

test('physical UTF-16 ranges survive same-line emoji, CRLF, CR and macro argument expansion', async () => {
  for (const newline of ['\r\n', '\r']) {
    const suffix = newline.length;
    const defs = await document(
      `Defs${suffix}`,
      `#macro WORD${suffix} target${newline}#macro ARG${suffix} 2`,
    );
    const text = `var note = "😀"; var target = 7; var result_value = WORD${suffix};${newline}function plus${suffix}(left, right) { return left + right; }${newline}plus${suffix}(1, ARG${suffix});`;
    const usage = await document(`Use${suffix}`, text);
    const definitions = new host.subject.StitchDefinitionsProvider(workspace);
    const rename = new host.subject.StitchRenameProvider(workspace);
    const destination = await definitions.provideDefinition(
      usage.doc,
      position(usage.doc, `WORD${suffix}`),
      token,
    );
    assert.deepEqual(destination.range.start, new host.vscode.Position(0, 7));
    assert.equal(destination.uri.toString(), defs.doc.uri.toString());
    const edits = await rename.provideRenameEdits(
      usage.doc,
      position(usage.doc, `WORD${suffix}`),
      `RENAMED${suffix}`,
      token,
    );
    const edit = edits.operations.find(
      (item: any) => item.uri.toString() === usage.doc.uri.toString(),
    );
    assert.equal(edit.range.start.line, 0);
    assert.equal(edit.range.start.character, text.indexOf(`WORD${suffix}`));
    assert.equal(usage.doc.getText(edit.range), `WORD${suffix}`);
    const help = await workspace.provideSignatureHelp(
      usage.doc,
      position(usage.doc, `ARG${suffix}`),
      token,
    );
    assert.equal(help.activeParameter, 1);
    assert.deepEqual(
      help.signatures[0].parameters.map((item: any) => item.label),
      ['left', 'right'],
    );
    assert.equal(usage.code.getDiagnostics().SYNTAX_ERROR.length, 0);
  }
});

test('project-wide edits refresh foreign macros with bounded buffer snapshots', async () => {
  const buffers = [];
  let reads = 0;
  for (let index = 0; index < 12; index++) {
    const buffer = await document(
      `Buffer${index}`,
      index === 0
        ? 'var buffer_result = BUFFER_MACRO;'
        : `var ordinary_${index} = 7;`,
    );
    const getText = buffer.doc.getText.bind(buffer.doc);
    buffer.doc.getText = (...args: any[]) => {
      reads++;
      return getText(...args);
    };
    buffers.push(buffer);
  }
  buffers.at(-1)!.doc.setText('#macro BUFFER_MACRO 7');
  reads = 0;
  const code = await workspace.ensureProjectCurrent(buffers[0].doc, token);
  assert(code === buffers[0].code);
  assert.equal(code.getReferenceAt(4).item.type.kind, 'Real');
  assert(
    reads <= 4 * buffers.length,
    `Repeated buffer materialization: ${reads} reads for ${buffers.length} buffers`,
  );
});
