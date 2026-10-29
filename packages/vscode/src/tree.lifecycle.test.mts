import assert from 'node:assert/strict';
import test from 'node:test';
import { createHost, deferred } from './test/host.mjs';

const resourceView = 'bscotch-stitch-resources';
const inspectorView = 'bscotch-stitch-inspector';
const filesView = 'bscotch-stitch-files';

async function createTreeHost() {
  const host = await createHost({ realTrees: true });
  // The UI input boundary has no selected document or non-document editor.
  host.vscode.window.tabGroups = { activeTabGroup: {} };
  return host;
}

function actualTree(host: any, name: string, Provider: any) {
  const view = host.treeViews.find((candidate: any) => candidate.name === name);
  assert(view, `The real provider must create ${name}`);
  assert(view.treeDataProvider instanceof Provider);
  assert.equal(view.treeDataProvider.view, view);
  return view.treeDataProvider;
}

function emitters(host: any) {
  return host.resources.filter(
    (resource: any) => resource.label === 'semantic-emitter',
  );
}

function assertReleased(host: any) {
  assert.equal(host.ctx.subscriptions.length, 0);
  assert.equal(host.events.activeEditor.size, 0);
  assert.equal(host.commandCallbacks.size, 0);
  assert.equal(host.timers.size, 0);
  assert.equal(host.intervals.size, 0);
  assert.deepEqual(
    host.resources
      .filter((resource: any) => !resource.disposed)
      .map((resource: any) => resource.label),
    [],
  );
  assert.equal(host.subject.TreeAsset.lookup.size, 0);
  assert.equal(host.subject.TreeCode.lookup.size, 0);
  assert.equal(host.subject.GameMakerFolder.lookup.size, 0);
}

// Each case enters the real activation ownership loop and real provider
// generators. Only the indicated VS Code allocation API is made to throw.
for (const failure of [
  { label: 'command:stitch.assets.filters.edit', views: 1, emitters: 2 },
  { label: 'active-editor', views: 2, emitters: 4 },
  { label: `tree-view:${filesView}`, views: 2, emitters: 6 },
  {
    label: 'command:stitch.includedFiles.revealInExplorerView',
    views: 3,
    emitters: 6,
  },
]) {
  test(
    `real tree registration releases earlier allocations after ${failure.label} fails`,
    { timeout: 30_000 },
    async (t) => {
      const host = await createTreeHost();
      t.after(() => host.dispose());
      host.failRegistration = failure.label;
      await assert.rejects(host.activate(), (error: any) =>
        error.message.includes(`Registration failed: ${failure.label}`),
      );
      assert.equal(host.treeViews.length, failure.views);
      actualTree(host, resourceView, host.subject.GameMakerTreeProvider);
      if (failure.views >= 2)
        actualTree(
          host,
          inspectorView,
          host.subject.GameMakerInspectorProvider,
        );
      if (failure.views >= 3)
        actualTree(host, filesView, host.subject.StitchIncludedFilesTree);
      assert(host.treeViews.every((view: any) => view.disposed));
      assert.equal(emitters(host).length, failure.emitters);
      assert(
        emitters(host).every(
          (resource: any) => resource.disposed && resource.disposeCalls === 1,
        ),
      );
      assertReleased(host);
    },
  );
}

for (const replaceExisting of [false, true]) {
  test(
    `metadata reconciliation ${replaceExisting ? 'replaces' : 'restores'} the resource in the real tree`,
    { timeout: 30_000 },
    async (t) => {
      const host = await createTreeHost();
      t.after(() => host.dispose());
      const workspace = await host.activate();
      const tree = actualTree(
        host,
        resourceView,
        host.subject.GameMakerTreeProvider,
      );
      const project = await host.project();
      project.yyp.Folders = [{ name: 'Owned', folderPath: 'folders/Owned.yy' }];
      workspace.projects.push(project);
      const previous = replaceExisting
        ? host.subject.addCode(project, 'Restored', 'var before = 1;')
        : undefined;
      if (previous)
        previous.asset.yy.parent = { name: 'Owned', path: 'folders/Owned.yy' };
      tree.rebuild();
      let restored: any;
      // Resource loading is the external input port. The actual tracker,
      // Project/Code registration, event bus and tree providers stay live.
      project.reloadResource = async () => {
        previous?.asset.retireModel();
        project.yyp.resources = project.yyp.resources.filter(
          (entry: any) => entry.id.name !== 'Restored',
        );
        restored = host.subject.addCode(
          project,
          'Restored',
          'var after = "current";',
        );
        restored.asset.yy.parent = { name: 'Owned', path: 'folders/Owned.yy' };
        await project.analysis.analyze();
      };
      const published: any[] = [];
      const subscription = host.subject.stitchEvents.on(
        'asset-changed',
        (asset: any) => published.push(asset),
      );
      t.after(() => subscription.off());
      workspace.externalChangeTracker.addChange({
        type: 'create',
        uri: host.vscode.Uri.file(
          project.dir.join('scripts/Restored/Restored.yy').absolute,
        ),
      });
      await workspace.externalChangeTracker.flush();
      const visible: any[] = [],
        pending = [...(tree.getChildren() || [])];
      while (pending.length) {
        const item = pending.pop();
        if (item instanceof host.subject.TreeAsset) visible.push(item.asset);
        else pending.push(...(tree.getChildren(item) || []));
      }
      assert(
        visible.includes(restored.asset),
        'The restored model must appear in the public tree children',
      );
      if (previous)
        assert(
          !visible.includes(previous.asset),
          'The tree must release the retired asset',
        );
      assert.deepEqual(published, [restored.asset]);
    },
  );
}

test(
  'real inspector rebuild failure releases its already-created view and editor listener',
  { timeout: 30_000 },
  async (t) => {
    const host = await createTreeHost();
    t.after(() => host.dispose());
    host.subject.StitchWorkspace.prototype.getCurrentAsset = () => {
      throw new Error('Selected asset unavailable');
    };
    await assert.rejects(host.activate(), /Selected asset unavailable/);
    actualTree(host, inspectorView, host.subject.GameMakerInspectorProvider);
    const listeners = host.resources.filter(
      (resource: any) => resource.label === 'active-editor',
    );
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].disposed, true);
    assert.equal(emitters(host).length, 4);
    assertReleased(host);
  },
);

test(
  'real tree disposal releases individual bus subscriptions, emitters and retained graphs before workspace disposal',
  { timeout: 30_000 },
  async (t) => {
    const host = await createTreeHost();
    t.after(() => host.dispose());
    const bus = host.subject.stitchEvents;
    const on = bus.on;
    let deliveries = 0;
    // Observe callback entry while retaining the actual bus's on/off/emit. A
    // disposed guard must not hide a subscription that remains on the bus.
    bus.on = (name: string, listener: (...args: any[]) => unknown) =>
      on(name, (...args: any[]) => {
        deliveries++;
        return listener(...args);
      });
    const workspace = await host.activate();
    bus.on = on;
    const tree = actualTree(
      host,
      resourceView,
      host.subject.GameMakerTreeProvider,
    );
    const inspector = actualTree(
      host,
      inspectorView,
      host.subject.GameMakerInspectorProvider,
    );
    const included = actualTree(
      host,
      filesView,
      host.subject.StitchIncludedFilesTree,
    );
    const project = await host.project();
    project.yyp.Folders = [{ name: 'Owned', folderPath: 'folders/Owned.yy' }];
    project.yyp.IncludedFiles = [
      { name: 'settings.txt', filePath: 'datafiles/config' },
    ];
    const code = host.subject.addCode(project, 'Create_0', 'var owned = 1;');
    code.asset.yy.parent = { name: 'Owned', path: 'folders/Owned.yy' };
    workspace.projects.push(project);
    tree.rebuild();
    const assetItem = host.subject.TreeAsset.lookup.get(code.asset);
    assert(assetItem instanceof host.subject.TreeAsset);
    new host.subject.TreeCode(assetItem, code);
    included.project = project;
    included.rebuild();
    const folder = included
      .getChildren()
      .find((item: any) => item.kind === 'datafiles-folder');
    const file = included
      .getChildren(folder)
      .find((item: any) => item.kind === 'datafiles-file');
    assert(folder && file);
    const folderLookup = folder.constructor.lookup;
    const fileLookup = file.constructor.lookup;
    const selected = {
      assetKind: 'objects',
      name: 'Selected',
      children: [],
      gmlFilesArray: [],
    };
    workspace.getCurrentAsset = () => selected;
    inspector.rebuild();
    assert.equal(inspector.asset, selected);
    let unrelatedCalls = 0;
    bus.on('project-changed', () => {
      unrelatedCalls++;
    });
    const emitEvents = () => {
      bus.emit('project-changed', project);
      bus.emit(
        'asset-changed',
        code.asset,
        'change',
        host.vscode.Uri.file(code.path.absolute),
      );
      bus.emit('asset-deleted', { assetKind: 'objects', name: 'Other' });
      bus.emit('code-file-deleted', { asset: selected });
      bus.emit('datafiles-changed', project);
    };
    emitEvents();
    assert.equal(deliveries, 7);
    assert.equal(unrelatedCalls, 1);
    for (const lookup of [
      host.subject.TreeAsset.lookup,
      host.subject.TreeCode.lookup,
      host.subject.GameMakerFolder.lookup,
      folderLookup,
      fileLookup,
    ])
      assert(lookup.size > 0);
    const allocations = emitters(host);
    assert.equal(allocations.length, 6);
    const fireCounts = allocations.map((resource: any) => resource.fireCalls);
    for (const provider of [tree, inspector, included]) {
      provider.dispose();
      provider.dispose();
    }
    assert(
      allocations.every(
        (resource: any) => resource.disposed && resource.disposeCalls === 1,
      ),
    );
    assert.equal(inspector.asset, undefined);
    assert.equal(included.project, undefined);
    assert.deepEqual(tree.tree.folders, []);
    for (const lookup of [
      host.subject.TreeAsset.lookup,
      host.subject.TreeCode.lookup,
      host.subject.GameMakerFolder.lookup,
      folderLookup,
      fileLookup,
    ])
      assert.equal(lookup.size, 0);
    emitEvents();
    assert.equal(
      deliveries,
      7,
      'Each provider must remove its callbacks rather than only guard their bodies',
    );
    assert.equal(
      unrelatedCalls,
      2,
      'Disposing the providers must leave unrelated bus subscribers alive',
    );
    tree.changed();
    tree.rebuild();
    tree.reveal(code);
    inspector.onUpdate(undefined);
    inspector.rebuild();
    included.rebuild();
    included.reveal(file);
    assert.deepEqual(
      allocations.map((resource: any) => resource.fireCalls),
      fireCounts,
    );
    assert.deepEqual(tree.getChildren(), []);
    assert.equal(inspector.getChildren(), undefined);
    assert.equal(included.getChildren(), undefined);
    assert.equal(
      host.subject.GameMakerFolder.lookup.size,
      0,
      'Late rebuild must not repopulate the disposed graph',
    );
    // Views, editor subscriptions and commands were separately yielded to the
    // activation context; its real ownership wrappers now release those handles.
    host.disposeContext(host.ctx);
    assertReleased(host);
  },
);

test(
  'the real editSound command returns failures from vscode.open to its caller',
  { timeout: 30_000 },
  async (t) => {
    const host = await createTreeHost();
    t.after(() => host.dispose());
    await host.activate();
    const project = await host.project();
    const sound = {
      assetKind: 'sounds',
      dir: project.dir.join('sounds/Owned'),
      yy: { soundFile: 'Owned.wav' },
    };
    const opened = deferred();
    // Observe rejection even if a regression drops the command's Promise.
    void opened.promise.catch(() => {});
    const executeCommand = host.vscode.commands.executeCommand;
    let openedPath: string | undefined;
    host.vscode.commands.executeCommand = (name: string, ...args: any[]) => {
      if (name !== 'vscode.open') return executeCommand(name, ...args);
      openedPath = args[0].fsPath;
      return opened.promise;
    };
    const command = host.commandCallbacks.get('stitch.assets.editSound');
    assert(command);
    const result = command({ asset: sound });
    assert(result && typeof result.then === 'function');
    assert.equal(
      openedPath,
      host.vscode.Uri.file(sound.dir.join(sound.yy.soundFile).absolute).fsPath,
    );
    const failure = new Error('Sound editor could not open');
    const rejected = assert.rejects(
      result,
      (error: unknown) => error === failure,
    );
    opened.reject(failure);
    await rejected;
  },
);
