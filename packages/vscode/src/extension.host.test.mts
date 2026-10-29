import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createHost, deferred } from './test/host.mjs';

// These exercise the bundled production host modules, not extracted method
// copies. Only VS Code/UI and project discovery/disk loading are doubles; the
// Project resource barrier, Code inputs and semantic service are real sources.
// Per-case timeouts only bound a broken deferred harness; no latency is measured
// or used as a performance/correctness oracle.
test(
  'closing B holds an A query until the delayed disk restore joins the project view',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    const workspace = f.newWorkspace();
    const project = await f.project();
    workspace.projects.push(project);
    const a = f.subject.addCode(
      project,
      'A',
      'function Use() { return Source(); }',
    );
    const b = f.subject.addCode(
      project,
      'B',
      'function Source() { return "buffer"; }',
    );
    const aDoc = f.document(a, a.content);
    const bDoc = f.document(b, b.content);
    f.documents.push(aDoc, bDoc);
    b.setBufferContent(bDoc.getText());
    await project.analysis.analyze();

    const disk = deferred<string>();
    const reading = deferred();
    const order: string[] = [];
    b.path.read = async () => {
      order.push('disk-start');
      reading.resolve();
      const text = await disk.promise;
      order.push('disk-finish');
      return text;
    };
    bDoc.isClosed = true;
    f.documents.splice(f.documents.indexOf(bDoc), 1);
    const closing = workspace.onCloseDoc(bDoc);
    await reading.promise;
    const joining = deferred();
    const prototype = Object.getPrototypeOf(project);
    const barrier = project.resourcesReady;
    const observed = new Proxy(barrier, {
      get(target, key) {
        if (key === 'then')
          return (...args: any[]) => {
            joining.resolve();
            return target.then(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.defineProperty(project, 'resourcesReady', {
      configurable: true,
      get() {
        const current = Reflect.get(prototype, 'resourcesReady', project);
        return current === barrier ? observed : current;
      },
    });
    let completed = false;
    const query = workspace
      .ensureDocumentCurrent(aDoc)
      .then((code: unknown) => {
        completed = true;
        order.push('query-finish');
        return code;
      });
    t.after(async () => {
      disk.resolve('function Source() { return 42; }');
      await Promise.allSettled([query, closing]);
      delete project.resourcesReady;
    });
    assert.equal(
      await Promise.race([
        joining.promise.then(() => 'waiting-for-disk-barrier'),
        query.then(() => 'query-finished-too-soon'),
      ]),
      'waiting-for-disk-barrier',
    );
    assert.equal(project.resourcesPending, true);
    assert.equal(completed, false);
    assert.equal(b.content, bDoc.getText());
    disk.resolve('function Source() { return 42; }');
    const [current] = await Promise.all([query, closing]);
    assert.equal(current, a);
    assert.equal(b.content, 'function Source() { return 42; }');
    assert.equal(project.resourcesPending, false);
    assert.equal(project.analysis.isCurrent, true);
    assert(order.indexOf('disk-finish') < order.indexOf('query-finish'));
  },
);

test(
  'a queued close restore does not read the retired path after resource replacement',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    const workspace = f.newWorkspace();
    const project = await f.project();
    workspace.projects.push(project);
    const previous = f.subject.addCode(project, 'Moving', 'var buffer = 1;');
    const document = f.document(previous, previous.content);
    f.documents.push(document);
    previous.setBufferContent(document.getText());
    await project.analysis.analyze();
    let reads = 0;
    previous.path.read = async () => {
      reads++;
      throw new Error('Retired path no longer exists');
    };
    const entered = deferred();
    const release = deferred();
    let replacement: any;
    const replacing = project.withResourceUpdate(async () => {
      entered.resolve();
      await release.promise;
      replacement = f.subject.replaceCode(previous, 'var moved = 2;');
    });
    await entered.promise;
    document.isClosed = true;
    f.documents.splice(f.documents.indexOf(document), 1);
    const closing = workspace.onCloseDoc(document);
    release.resolve();
    await Promise.all([replacing, closing]);
    assert.equal(reads, 0);
    assert.equal(previous.analysisState.status, 'retired');
    assert.equal(replacement.content, 'var moved = 2;');
    assert.equal(project.resourcesPending, false);
    assert.equal(project.analysis.isCurrent, true);
  },
);

test(
  'metadata buffer edits reconcile before a moved document close restores disk input',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    const workspace = f.newWorkspace();
    const project = await f.project();
    workspace.projects.push(project);
    const previous = f.subject.addCode(project, 'Moving', 'var before = 1;');
    const document = f.document(previous, previous.content);
    const metadata = f.document(
      { path: { absolute: project.yypPath.absolute } },
      'before',
    );
    metadata.languageId = 'yy';
    f.documents.push(document, metadata);
    await project.analysis.analyze();
    let reads = 0,
      reloads = 0;
    previous.path.read = async () => {
      reads++;
      throw new Error('Old working-copy path was moved');
    };
    let replacement: any;
    // Metadata loading is the external port; actual replacement, resource
    // barriers, analysis and the host event/close path remain production code.
    project.reloadYyp = async () => {
      reloads++;
      assert.equal(metadata.getText(), 'restored');
      await project.withResourceUpdate(async () => {
        replacement = f.subject.replaceCode(previous, 'var restored = 2;');
      });
    };
    metadata.setText('restored');
    workspace.onChangeDoc({
      document: metadata,
      contentChanges: [{ text: 'restored' }],
    });
    document.isClosed = true;
    f.documents.splice(f.documents.indexOf(document), 1);
    await workspace.onCloseDoc(document);
    assert.equal(reloads, 1);
    assert.equal(reads, 0);
    assert.equal(previous.analysisState.status, 'retired');
    assert.equal(replacement.content, 'var restored = 2;');
    assert.equal(project.analysis.isCurrent, true);
  },
);

test(
  'a replacement Code reads an already-open buffer instead of stale disk input',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    const workspace = f.newWorkspace();
    const project = await f.project();
    workspace.projects.push(project);
    const previous = f.subject.addCode(project, 'Open', 'var saved = 1;');
    await project.analysis.analyze();
    const document = f.document(previous, 'var newest = 2;');
    f.documents.push(document);
    const replacement = f.subject.replaceCode(previous, 'var stale = 0;');
    let diskReads = 0;
    replacement.path.read = async () => {
      diskReads++;
      return 'var stale = 0;';
    };
    // GameMakerProject.from's real documentText callback is in the Code path.
    await replacement.readContent();
    assert.equal(replacement.content, document.getText());
    assert.equal(diskReads, 0);
    assert.equal(await workspace.ensureDocumentCurrent(document), replacement);
    assert.equal(previous.analysisState.status, 'retired');
    assert(
      replacement.refs.some(
        (reference: any) => reference.item.name === 'newest',
      ),
    );
    assert(
      !replacement.refs.some(
        (reference: any) => reference.item.name === 'stale',
      ),
    );
  },
);

test(
  'an older activation selection request cannot overwrite the newer position',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    const workspace = await f.activate();
    const document = f.document(
      { path: { absolute: path.join(f.root, 'selection.gml') } },
      'old        newer',
    );
    const editor = { document };
    f.vscode.window.activeTextEditor = editor;
    const old = deferred<any>();
    const newest = deferred<any>();
    const requests = [old, newest];
    // Readiness is an external port of activation's selection handler. Defer each
    // call independently; do not reproduce that handler's request/position logic.
    workspace.ensureDocumentCurrent = (
      _document: unknown,
      _token: unknown,
      immediate: boolean,
    ) => {
      assert.equal(immediate, false);
      return requests.shift()!.promise;
    };
    workspace.getSignatureHelp = (_document: unknown, position: any) => ({
      activeSignature: 0,
      activeParameter: 0,
      signatures: [
        {
          label: `function ${position.character ? 'newer' : 'old'}(value)`,
          parameters: [{ label: 'value' }],
        },
      ],
    });
    const reads: number[] = [];
    const code = {
      getReferenceAt(offset: number) {
        reads.push(offset);
        const asset = offset
          ? { isSound: true, name: 'new_sound' }
          : { isSprite: true, name: 'old_sprite' };
        return {
          item: {
            name: offset ? 'newer' : 'old',
            native: offset ? 'FixtureExtension' : undefined,
            def: { file: { asset } },
          },
          file: { project: {} },
        };
      },
    };
    const event = (character: number) => ({
      textEditor: editor,
      selections: [
        { start: new f.vscode.Position(0, character), isEmpty: true },
      ],
    });
    f.events.selection.fire(event(0));
    f.events.selection.fire(event(11));
    const updated = f.waitForContext('stitch.selectionIsSound', 'new_sound');
    newest.resolve(code);
    await updated;
    assert.equal(workspace.signatureHelpStatus.text, 'newer(VALUE)');
    const selected = event(11);
    selected.selections[0].isEmpty = false;
    workspace.ensureDocumentCurrent = async () => code;
    const selectedUpdate = f.waitForContext(
      'stitch.selectionIsSound',
      'new_sound',
    );
    f.events.selection.fire(selected);
    await selectedUpdate;
    assert.equal(workspace.signatureHelpStatus.text, 'newer(VALUE)');
    // Source-backed extension APIs use GML definition navigation rather than the docs shortcut.
    assert.equal(f.contexts.get('stitch.selectionIsNative'), false);
    old.resolve(code);
    // The handler registered its await before this continuation. Its stale guard
    // runs before this await resumes; no wall-clock sleeps or polling are used.
    await old.promise;
    assert.deepEqual(reads, [11, 11]);
    assert.equal(f.contexts.get('stitch.selectionIsSound'), 'new_sound');
    assert.equal(f.contexts.get('stitch.selectionIsSprite'), false);
    assert.equal(workspace.signatureHelpStatus.text, 'newer(VALUE)');
  },
);

test(
  'late provider registration failure releases all earlier acquired resources',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    f.failRegistration = 'StitchCompletionProvider';
    await assert.rejects(
      f.activate(),
      /Registration failed: StitchCompletionProvider/,
    );
    assert(f.registrationOrder.includes('GameMakerTreeProvider'));
    assert(f.registrationOrder.includes('StitchWorkspaceSymbolProvider'));
    assert.equal(f.ctx.subscriptions.length, 0);
    assert.deepEqual(
      f.resources
        .filter((resource: any) => !resource.disposed)
        .map((resource: any) => resource.label),
      [],
    );
    assert.equal(f.events.change.size, 0);
    assert.equal(f.events.configuration.size, 0);
    f.failRegistration = undefined;
    const retried = await f.activate();
    assert.equal(retried.diagnosticCollection.disposed, false);
  },
);

test(
  'watcher and settings changes arriving during project load replay after registration',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    const loading = deferred();
    const release = deferred();
    const order: string[] = [];
    let code: any;
    let project: any;
    f.chooseProject = async () =>
      f.vscode.Uri.file(path.join(f.root, 'memory.yyp'));
    f.initializeProject = async (value: any) => {
      project = value;
      f.subject.seedProject(project);
      code = f.subject.addCode(project, 'Watched', 'var before = 1;');
      code.path.read = async () => {
        order.push('disk');
        return 'var after = 2;';
      };
      const configure = project.setAnalysisConfiguration.bind(project);
      project.setAnalysisConfiguration = async (configuration: string) => {
        order.push('settings');
        await configure(configuration);
      };
      loading.resolve();
      await release.promise;
      order.push('loaded');
    };
    const activation = f.activate();
    await loading.promise;
    const watcher = f.watchers.find(
      (value: any) => value.pattern === '**/*.gml',
    );
    assert(watcher);
    watcher.change(f.vscode.Uri.file(code.path.absolute));
    f.settings.set('diagnostics.autoDeclaredGlobalsPatterns', ['_auto_']);
    f.settings.set('run.defaultConfig', 'Test');
    f.events.configuration.fire({
      affectsConfiguration: (key: string) =>
        [
          'stitch',
          'stitch.run.defaultConfig',
          'stitch.diagnostics.autoDeclaredGlobalsPatterns',
        ].includes(key),
    });
    assert.deepEqual(order, []);
    release.resolve();
    const workspace = await activation;
    assert(workspace.projects.includes(project));
    assert.equal(code.content, 'var after = 2;');
    assert.deepEqual(project.options.settings.autoDeclareGlobalsPrefixes, [
      '_auto_',
    ]);
    assert.deepEqual(project.analysisConfigurationLineage, ['Default', 'Test']);
    assert.deepEqual(order, ['loaded', 'disk', 'settings']);
    assert.equal(project.analysis.isCurrent, true);
  },
);

test(
  'dispose/reactivate uses an independent live diagnostic collection',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    t.after(() => f.dispose());
    const firstContext = f.context();
    const first = await f.activate(firstContext);
    let oldEvents = 0,
      newEvents = 0;
    f.subject.stitchEvents.on('project-changed', () => {
      oldEvents++;
    });
    f.subject.stitchEvents.emit('project-changed', {});
    assert.equal(oldEvents, 1);
    const uri = f.vscode.Uri.file(path.join(f.root, 'visible.gml'));
    const diagnostic = {
      message: 'visible',
      severity: 'error',
      location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    };
    first.emitDiagnostics({ filePath: uri.fsPath, diagnostics: [diagnostic] });
    const oldCollection = first.diagnosticCollection;
    assert.equal(
      oldCollection.entries.get(uri.toString())[0].message,
      'visible',
    );
    f.disposeContext(firstContext);
    assert.equal(oldCollection.disposed, true);
    assert.equal(oldCollection.entries.size, 0);
    const second = await f.activate(f.context());
    f.subject.stitchEvents.on('project-changed', () => {
      newEvents++;
    });
    f.subject.stitchEvents.emit('project-changed', {});
    assert.equal(oldEvents, 1);
    assert.equal(newEvents, 1);
    assert.notEqual(second, first);
    assert.notEqual(second.diagnosticCollection, oldCollection);
    assert.equal(second.diagnosticCollection.disposed, false);
    second.emitDiagnostics({ filePath: uri.fsPath, diagnostics: [diagnostic] });
    assert.equal(
      second.diagnosticCollection.entries.get(uri.toString())[0].message,
      'visible',
    );
    assert.equal(oldCollection.entries.size, 0);
  },
);

test(
  'concurrent activation callers share one initialization failure and can retry afterward',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    const entered = deferred();
    const release = deferred();
    const activations: Promise<unknown>[] = [];
    const initialized: any[] = [];
    t.after(async () => {
      release.resolve();
      await Promise.allSettled(activations);
      f.dispose();
    });
    f.chooseProject = async () =>
      f.vscode.Uri.file(path.join(f.root, 'memory.yyp'));
    f.initializeProject = async (project: any) => {
      initialized.push(project);
      f.subject.seedProject(project);
      entered.resolve();
      await release.promise;
    };
    f.failRegistration = 'StitchCompletionProvider';
    const first = f.activate();
    activations.push(first);
    const firstResult = Promise.allSettled([first]);
    await entered.promise;
    const second = f.activate();
    activations.push(second);
    const secondResult = Promise.allSettled([second]);
    release.resolve();
    const [[left], [right]] = await Promise.all([firstResult, secondResult]);
    // No timing/pending-state oracle: both callers must observe the eventual
    // fatal registration failure, not an early successful half-ready workspace.
    assert(left.status === 'rejected');
    assert(right.status === 'rejected');
    assert.equal(left.reason, right.reason);
    assert.match(
      left.reason.message,
      /Registration failed: StitchCompletionProvider/,
    );
    assert.equal(initialized.length, 1);
    assert.equal(initialized[0].isDisposed, true);
    assert.equal(f.ctx.subscriptions.length, 0);
    assert.deepEqual(
      f.resources
        .filter((resource: any) => !resource.disposed)
        .map((resource: any) => resource.label),
      [],
    );

    f.failRegistration = undefined;
    const retry = f.activate();
    activations.push(retry);
    const ready = await retry;
    assert.equal(initialized.length, 2);
    assert.notEqual(initialized[1], initialized[0]);
    assert(ready.projects.includes(initialized[1]));
    assert.equal(initialized[1].isDisposed, false);
    assert.equal(ready.diagnosticCollection.disposed, false);
  },
);

test(
  'disposal during project loading cannot fulfill activation with a disposed workspace',
  { timeout: 30_000 },
  async (t) => {
    const f = await createHost();
    const entered = deferred();
    const release = deferred();
    let project: any;
    let activation: Promise<unknown> | undefined;
    t.after(async () => {
      release.resolve();
      if (activation) await Promise.allSettled([activation]);
      f.dispose();
    });
    f.chooseProject = async () =>
      f.vscode.Uri.file(path.join(f.root, 'memory.yyp'));
    f.initializeProject = async (value: any) => {
      project = value;
      f.subject.seedProject(project);
      entered.resolve();
      await release.promise;
    };
    activation = f.activate();
    const settled = Promise.allSettled([activation]);
    await entered.promise;
    const collection = f.resources.find(
      (resource: any) => resource.label === 'diagnostics',
    );
    assert(collection);
    assert.equal(collection.disposed, false);
    // Dispose through the actual activation-owned context resources while the
    // real GameMakerProject.from initializer is still behind the load gate.
    f.disposeContext(f.ctx);
    assert.equal(collection.disposed, true);
    release.resolve();
    const [result] = await settled;
    assert(
      result.status === 'rejected',
      'Activation must not succeed with the abandoned workspace',
    );
    assert(result.reason instanceof Error);
    assert.equal(project.isDisposed, true);
    assert.equal(f.ctx.subscriptions.length, 0);
  },
);
