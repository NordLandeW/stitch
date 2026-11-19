import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHost, deferred } from '../test/host.mjs';
import { buildTestWorker, workerProject } from '../test/worker.mjs';

test(
  'tree-created scripts and object events participate in live language analysis',
  { timeout: 60000 },
  async () => {
    const useText = 'var value = created_function();';
    const f = await workerProject({ Existing: useText });
    const host = await createHost({ resourceTree: true });
    try {
      await mkdir(path.join(f.directory, 'datafiles'));
      await mkdir(path.join(f.directory, 'dist'));
      await copyFile(
        await buildTestWorker(f.directory),
        path.join(f.directory, 'dist/language-worker.js'),
      );
      host.ctx.extensionPath = f.directory;
      host.chooseProject = async () => host.vscode.Uri.file(f.yypPath);
      host.initializeProject = async (project: any) => {
        Object.assign(project.options, {
          nativeSpecFiles: f.input.nativeSpecFiles,
          documentation: false,
        });
        await host.subject.initializeProject.call(project, project.options);
      };
      host.subject.StitchWorkspace.prototype.createLanguageService =
        host.subject.createWorkerLanguageService;
      const workspace = await host.activate();
      const tree = host.treeViews.find(
        (v: any) => v.name === 'bscotch-stitch-resources',
      );
      tree.reveal = () => {};
      assert.equal(workspace.projects.length, 1, JSON.stringify(host.logs));
      const folder = () =>
        tree.treeDataProvider.tree.folders[0].addFolder('Scripts');
      const project = workspace.projects[0];
      const open = async (file: string) => {
        const doc = host.document(
          { path: { absolute: file } },
          await readFile(file, 'utf8'),
        );
        host.documents.push(doc);
        host.events.open.fire(doc);
        return doc;
      };
      const edit = (doc: any, text: string) => {
        doc.setText(text);
        host.events.change.fire({ document: doc, contentChanges: [{ text }] });
      };
      const definitions = new host.subject.StitchDefinitionsProvider(workspace);
      const definition = async (doc: any, name: string) =>
        definitions.provideDefinition(
          doc,
          doc.positionAt(doc.getText().indexOf(name)),
          { isCancellationRequested: false },
        );
      const declared = await open(f.files.Existing);
      host.vscode.window.showInputBox = async () => 'NewScript';
      const wroteYyp = deferred(),
        continueCreation = deferred();
      const addAsset = project.addAssetToYyp.bind(project);
      project.addAssetToYyp = async (...args: any[]) => {
        const entry = await addAsset(...args);
        wroteYyp.resolve();
        await continueCreation.promise;
        return entry;
      };
      const creating = host.commandCallbacks.get('stitch.assets.newScript')(
        folder(),
      );
      await wroteYyp.promise;
      const reading = workspace.externalChangeTracker.flushPending();
      const visible = project
        .whenSourcesCurrent()
        .then(() => project.getAssetByName('NewScript'));
      // Let an already-current barrier settle before the command finishes registering.
      await new Promise<void>((resolve) => setImmediate(resolve));
      continueCreation.resolve();
      await Promise.all([creating, reading]);
      assert.equal(await visible, project.getAssetByName('NewScript'));
      project.addAssetToYyp = addAsset;
      const created = await open(
        project.getAssetByName('NewScript').gmlFile.path.absolute,
      );
      edit(created, 'function created_function(){return 1;}');
      const firstDef = await definition(declared, 'created_function');
      assert.equal(firstDef?.uri.toString(), created.uri.toString());
      assert.equal(
        workspace.diagnosticCollection.entries.get(declared.uri.toString())
          ?.length,
        0,
      );
      const references = await new host.subject.StitchReferenceProvider(
        workspace,
      ).provideReferences(
        created,
        created.positionAt(created.getText().indexOf('created_function')),
        { includeDeclaration: true },
        { isCancellationRequested: false },
      );
      assert(
        references?.some(
          (ref: any) => ref.uri.toString() === declared.uri.toString(),
        ),
      );
      edit(created, 'function created_function(){static }');
      await definition(declared, 'created_function');
      assert(
        workspace.diagnosticCollection.entries
          .get(created.uri.toString())
          ?.some(
            (d: any) => d.severity === host.vscode.DiagnosticSeverity.Error,
          ),
      );
      edit(created, 'function created_function(){return 2;}');
      await definition(declared, 'created_function');
      assert.equal(
        workspace.diagnosticCollection.entries.get(created.uri.toString())
          ?.length,
        0,
      );
      host.vscode.window.showInputBox = async () => 'NewObject';
      await host.commandCallbacks.get('stitch.assets.newObject')(folder());
      const owner = project.getAssetByName('NewObject');
      const create = await open(owner.gmlFile.path.absolute);
      edit(create, 'added_member = created_function();');
      assert.equal(
        (await definition(create, 'created_function'))?.uri.toString(),
        created.uri.toString(),
      );
      host.vscode.QuickPickItemKind = { Separator: -1 };
      host.vscode.window.showQuickPick = async (events: any[]) =>
        events.find((e) => e.name === 'Step_0');
      let shown: any;
      host.vscode.window.showTextDocument = (uri: any) => (shown = uri);
      await host.commandCallbacks.get('stitch.assets.newEvent')(
        folder().getResource('NewObject'),
      );
      const step = await open(shown.fsPath);
      edit(step, 'var value = added_member;');
      assert.equal(
        (await definition(step, 'added_member'))?.uri.toString(),
        create.uri.toString(),
      );
    } finally {
      host.dispose();
      await f.dispose();
    }
  },
);
