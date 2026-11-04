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
