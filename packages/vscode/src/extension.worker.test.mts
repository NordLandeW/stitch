import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHost } from './test/host.mjs';
import { workerFixture } from './test/worker.mjs';
import { WorkerLanguageService } from './language/client.mjs';

/** UI is doubled; the real providers call the production worker entry. The host
 * resource facade deliberately has no language graph to fall back to. */
test(
  'real providers consume production worker DTOs with no host language graph',
  { timeout: 60000 },
  async () => {
    const source =
      '#macro RESULT make_box\nfunction make_box(left, right){return {member:left};}';
    const use = 'var box=RESULT(1, 2);\nbox.member;\nbox.';
    const f = await workerFixture({
      Producer: source,
      Consumer: use,
      Native: 'show_debug_message(1);',
    });
    const host = await createHost();
    const workspace = host.newWorkspace();
    try {
      await f.service.ready;
      const project = new host.subject.GameMakerProject(
        host.vscode.Uri.file(f.yypPath),
        { analysis: 'resources' },
      );
      project.yyp = f.yyp;
      project.config = {};
      project.getGmlFile = () => {
        throw new Error('Provider must not query a host Code graph');
      };
      Object.defineProperty(project, 'self', {
        get() {
          throw new Error('Host language graph is unavailable');
        },
      });
      workspace.projects.push(project);
      workspace.createLanguageService = () => f.service;
      const producer = host.document(
        { path: { absolute: f.files.Producer } },
        source,
      );
      const consumer = host.document(
        { path: { absolute: f.files.Consumer } },
        use,
      );
      const native = host.document(
        { path: { absolute: f.files.Native } },
        'show_debug_message(1);',
      );
      host.documents.push(producer, consumer, native);
      const token = { isCancellationRequested: false };
      const at = consumer.positionAt(use.indexOf('member'));
      const definition = await new host.subject.StitchDefinitionsProvider(
        workspace,
      ).provideDefinition(consumer, at, token);
      assert.equal(definition.uri.toString(), producer.uri.toString());
      assert.equal(producer.getText(definition.range), 'member');
      const completion = await new host.subject.StitchCompletionProvider(
        workspace,
      ).provideCompletionItems(
        consumer,
        consumer.positionAt(use.length),
        token,
        { triggerCharacter: '.' },
      );
      assert(completion.some((item: any) => item.label === 'member'));
      const hover = await new host.subject.StitchHoverProvider(
        workspace,
      ).provideHover(consumer, at, token);
      assert(hover.contents.codeBlocks.length);
      const signature = await workspace.provideSignatureHelp(
        consumer,
        consumer.positionAt(use.indexOf('2)')),
        token,
      );
      assert.equal(signature.activeParameter, 1);
      assert.deepEqual(
        signature.signatures[0].parameters.map(
          (parameter: any) => parameter.label,
        ),
        ['left', 'right'],
      );
      const rename = await new host.subject.StitchRenameProvider(
        workspace,
      ).provideRenameEdits(consumer, at, 'edge', token);
      assert.equal(rename.operations.length, 2);
      const refs = await new host.subject.StitchReferenceProvider(
        workspace,
      ).provideReferences(consumer, at, { includeDeclaration: true }, token);
      assert.equal(refs.length, 2);
      const tokens =
        await workspace.semanticHighlightProvider.provideDocumentSemanticTokens(
          consumer,
          token,
        );
      assert(
        tokens.entries.some(
          (entry: any) =>
            consumer.getText(entry.range) === 'RESULT' &&
            entry.type === 'macro',
        ),
      );
      const outline = await new host.subject.StitchDocumentSymbolProvider(
        workspace,
      ).provideDocumentSymbols(producer, token);
      assert(outline.some((item: any) => item.name === 'make_box'));
      host.vscode.window.activeTextEditor = {
        document: consumer,
        selection: { active: at },
        selections: [{ start: at }],
      };
      const selection = await workspace.getSelection();
      assert.equal(selection.name, 'member');
      const symbols = await new host.subject.StitchWorkspaceSymbolProvider(
        workspace,
      ).provideWorkspaceSymbols('make_box', token);
      assert(symbols.some((item: any) => item.name === 'make_box'));
      producer.setText(source.replace('member:left', 'changed:right'));
      workspace.onChangeDoc({
        document: producer,
        contentChanges: [{ text: producer.getText() }],
      });
      const fallback = await new host.subject.StitchCompletionProvider(
        workspace,
      ).provideCompletionItems(native, native.positionAt(5), token, {});
      assert.equal(fallback.isIncomplete, true);
      assert(
        fallback.items.some(
          (item: any) =>
            item.label === 'show_debug_message' &&
            item.detail.includes('Analysis updating'),
        ),
      );
      const updating = await new host.subject.StitchCompletionProvider(
        workspace,
      ).provideCompletionItems(
        consumer,
        consumer.positionAt(use.length),
        token,
        { triggerCharacter: '.' },
      );
      assert.equal(updating.isIncomplete, true);
      assert(updating.items.some((item: any) => item.label === 'member'));
      await f.service.flush();
      const updated = await new host.subject.StitchCompletionProvider(
        workspace,
      ).provideCompletionItems(
        consumer,
        consumer.positionAt(use.length),
        token,
        { triggerCharacter: '.' },
      );
      assert(updated.some((item: any) => item.label === 'changed'));
      assert(!updated.some((item: any) => item.label === 'member'));
      assert.equal(f.errors.length, 0);
    } finally {
      host.dispose();
      await f.dispose();
    }
  },
);

test(
  'explicit worker recovery reconstructs current unsaved buffers in a fresh session',
  { timeout: 60000 },
  async () => {
    const original = 'function value(){return 1;}';
    const f = await workerFixture({ Producer: original });
    const host = await createHost();
    const workspace = host.newWorkspace();
    try {
      await f.service.ready;
      const project = new host.subject.GameMakerProject(
        host.vscode.Uri.file(f.yypPath),
        { analysis: 'resources' },
      );
      project.yyp = f.yyp;
      project.config = {};
      workspace.projects.push(project);
      let current = f.service;
      workspace.createLanguageService = () => current;
      const document = host.document(
        { path: { absolute: f.files.Producer } },
        original,
      );
      host.documents.push(document);
      const query = () =>
        workspace.query(document, {
          kind: 'hover',
          offset: original.indexOf('value'),
        });
      assert(
        (await query()).code.some((code: string) => code.includes('Real')),
      );
      await f.worker.terminate();
      await new Promise<void>((resolve) => setImmediate(resolve));
      document.setText('function value(){return "latest";}');
      workspace.onChangeDoc(document);
      assert.equal(await query(), undefined);
      current = new WorkerLanguageService(f.input, f.workerPath, {
        delay: () => 0,
      });
      assert.equal(
        await workspace.retryLanguageService(project, f.service),
        true,
      );
      assert(
        (await query()).code.some((code: string) => code.includes('String')),
      );
      assert.equal(await f.diskText('Producer'), original);
      assert.equal(
        await workspace.retryLanguageService(project, f.service),
        false,
        'An obsolete Retry action cannot replace the recovered session',
      );
    } finally {
      host.dispose();
      await f.dispose();
    }
  },
);

test('precise providers keep the working text when another model addresses its path', async () => {
  const old = 'show_debug_message(1);';
  const live =
    'if (true) {\n\tvar label = "working";\n\tshow_debug_message(label);\n}';
  const f = await workerFixture({ Draw: old });
  const host = await createHost();
  const workspace = host.newWorkspace();
  try {
    const project = new host.subject.GameMakerProject(
      host.vscode.Uri.file(f.yypPath),
      { analysis: 'resources' },
    );
    project.yyp = f.yyp;
    project.config = {};
    workspace.projects.push(project);
    workspace.createLanguageService = () => f.service;
    const doc = (name: string, text: string) =>
      host.document({ path: { absolute: name } }, text);
    const working = doc(f.files.Draw, old);
    const alternate = doc(f.files.Draw.replace('/Draw/', '/draw/'), old);
    const preview = doc(f.files.Draw, old);
    Object.assign(preview.uri, { query: 'revision=before' });
    const token = { isCancellationRequested: false };
    const tokens = (d: typeof working) =>
      workspace.semanticHighlightProvider.provideDocumentSemanticTokens(
        d,
        token,
      );
    const hover = (d: typeof working) =>
      workspace.query(d, {
        kind: 'hover',
        offset: d.getText().indexOf('label'),
      });
    const expectWorking = async () => {
      const result = await tokens(working);
      assert(
        result?.entries.some(
          (entry: any) =>
            entry.range.start.line === 2 &&
            working.getText(entry.range) === 'show_debug_message',
        ),
      );
      assert((await hover(working))?.code.includes('String'));
    };
    host.documents.push(working);
    workspace.onChangeDoc(working);
    await tokens(working);
    working.setText(live);
    workspace.onChangeDoc({
      document: working,
      contentChanges: [{ text: 'if (true) {' }, { text: '\t' }],
    });
    await expectWorking();
    working.setText(live + '\n');
    workspace.onChangeDoc({
      document: working,
      contentChanges: [{ text: '\n' }],
    });
    host.documents.push(alternate, preview);
    workspace.onChangeDoc(alternate);
    workspace.onChangeDoc(preview);
    await expectWorking();
    assert.equal(
      await tokens(alternate),
      undefined,
      'Never draw working ranges on a divergent, non-owning document',
    );
    assert.equal(await tokens(preview), undefined);
    const rename = () =>
      new host.subject.StitchRenameProvider(workspace).provideRenameEdits(
        working,
        working.positionAt(live.indexOf('label')),
        'renamed',
        token,
      );
    assert.equal(
      await rename(),
      undefined,
      'A physical edit plan cannot be applied to divergent aliases',
    );
    // Editing the other real model transfers ownership even if its local version is lower.
    alternate.setText('var next = 42;');
    workspace.onChangeDoc({
      document: alternate,
      contentChanges: [{ text: '42' }],
    });
    assert(
      (await tokens(alternate))?.entries.some(
        (entry: any) => alternate.getText(entry.range) === 'next',
      ),
    );
    assert.equal(await tokens(working), undefined);
    alternate.isClosed = true;
    await workspace.onCloseDoc(alternate);
    // Disk is still old. The surviving open text must be restored without another edit.
    await expectWorking();
    await workspace.onChangeFile(alternate.uri);
    await expectWorking();
    assert.equal((await rename())?.operations.length, 2);
    assert.equal(await f.diskText('Draw'), old);
  } finally {
    host.dispose();
    await f.dispose();
  }
});
