import assert from 'node:assert/strict';
import test from 'node:test';
import { createHost, deferred } from './test/host.mjs';

const viewName = 'bscotch-stitch-sprite-sources';

function actualTree(host: any) {
  const view = host.treeViews.find(
    (candidate: any) => candidate.name === viewName,
  );
  assert(view, 'The real register generator must create its VS Code tree view');
  const tree = view.treeDataProvider;
  assert(tree instanceof host.subject.SpriteSourcesTree);
  assert.equal(tree.view, view);
  return { tree, view };
}
function assertReleased(host: any) {
  assert.equal(host.intervals.size, 0);
  assert.equal(host.timers.size, 0);
  assert.equal(host.events.activeEditor.size, 0);
  assert.equal(host.ctx.subscriptions.length, 0);
  assert.deepEqual(
    host.resources
      .filter((resource: any) => !resource.disposed)
      .map((resource: any) => resource.label),
    [],
  );
}

// Only VS Code's allocation/event/timer APIs and third-party disk entry points
// are doubles. Registration, incremental ownership and teardown are real source.
test(
  'real SpriteSources registration releases earlier yields when a later command fails',
  { timeout: 30_000 },
  async (t) => {
    const host = await createHost({ realSpriteSources: true });
    t.after(() => host.dispose());
    host.failRegistration = 'command:stitch.spriteSource.clearCache';
    await assert.rejects(
      host.activate(),
      /Registration failed: command:stitch\.spriteSource\.clearCache/,
    );
    const { view } = actualTree(host);
    assert(
      host.registrationOrder.includes('command:stitch.spriteSource.watch'),
    );
    assert(
      host.registrationOrder.includes(
        'command:stitch.spriteSource.clearRecentImports',
      ),
    );
    assert.equal(view.disposed, true);
    const emitters = host.resources.filter(
      (resource: any) => resource.label === 'semantic-emitter',
    );
    assert.equal(
      emitters.length,
      2,
      'SpriteSources owns two real VS Code EventEmitter allocations',
    );
    assert(emitters.every((resource: any) => resource.disposed));
    assertReleased(host);
  },
);

test(
  'real SpriteSources disposal retires only its bus listeners, both emitters and the minute interval owner',
  { timeout: 30_000 },
  async (t) => {
    const host = await createHost({ realSpriteSources: true });
    t.after(() => host.dispose());
    await host.activate();
    const { tree, view } = actualTree(host);
    const emitters = host.resources.filter(
      (resource: any) => resource.label === 'semantic-emitter',
    );
    assert.equal(emitters.length, 2);
    assert(emitters.every((resource: any) => !resource.disposed));
    assert.equal(host.intervals.size, 1);
    const [interval] = host.intervals.values();
    assert.equal(interval.milliseconds, 60_000);
    assert.equal(host.events.activeEditor.size, 1);

    let rebuildCalls = 0;
    let changes = 0;
    let unrelatedCalls = 0;
    const rebuild = tree.rebuild.bind(tree);
    // Observe callback entry while still delegating to the production method.
    // This distinguishes a detached listener from a leaked listener whose method
    // merely returns early because tree.disposed is true.
    tree.rebuild = () => {
      rebuildCalls++;
      return rebuild();
    };
    host.ctx.subscriptions.push(
      tree.onDidChangeTreeData(() => {
        changes++;
      }),
    );
    const bus = host.subject.stitchEvents;
    bus.on('project-changed', () => {
      unrelatedCalls++;
    });
    const sprite = { assetKind: 'sprites' };
    const uri = host.vscode.Uri.file(`${host.root}/sprite.yy`);
    bus.emit('project-changed', {});
    bus.emit('asset-changed', sprite, 'change', uri);
    interval.callback();
    assert.equal(rebuildCalls, 3);
    assert.equal(changes, 3);
    assert.equal(unrelatedCalls, 1);

    // Dispose the actual tree before its workspace/context. A global bus.clear()
    // must not mask missing per-tree Subscription.off() calls.
    tree.dispose();
    tree.dispose();
    assert(emitters.every((resource: any) => resource.disposed));
    bus.emit('project-changed', {});
    bus.emit('asset-changed', sprite, 'change', uri);
    assert.equal(rebuildCalls, 3);
    assert.equal(changes, 3);
    assert.equal(
      unrelatedCalls,
      2,
      'Tree disposal must leave other bus subscribers alive',
    );

    // The generator separately yielded the interval's Disposable; the production
    // activation context, not a copied test cleanup loop, owns its cancellation.
    host.disposeContext(host.ctx);
    assert.equal(view.disposed, true);
    assertReleased(host);
  },
);

async function sourceFixture(host: any) {
  host.spriteDestFrom = async () => ({
    loadConfig: async () => ({ sources: [{ source: 'sprite-fixture' }] }),
  });
  host.spriteSourceFrom = async () => ({
    loadConfig: async () => ({ staging: [{ dir: 'staging', transforms: [] }] }),
  });
  const workspace = await host.activate();
  const project = await host.project();
  workspace.projects.push(project);
  const { tree } = actualTree(host);
  const roots = await tree.getChildren();
  const sources = await tree.getChildren(
    roots.find((item: any) => item.kind === 'sprite-sources'),
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].invalid, false);
  return {
    tree,
    project,
    source: sources[0],
    registry: host.subject.SpriteSourcesTree,
  };
}

test(
  'real SpriteSource watch rejects failed discovery without allocation and retries after partial watcher allocation failure',
  { timeout: 30_000 },
  async (t) => {
    const host = await createHost({ realSpriteSources: true });
    t.after(() => host.dispose());
    const { source, registry } = await sourceFixture(host);
    const key = source.sourceDir.absolute;
    const baseline = host.watchers.length;
    const discovery = new Error('fixture stage discovery rejected');
    host.spriteSourceFrom = async () => ({
      loadConfig: async () => {
        throw discovery;
      },
    });
    await assert.rejects(
      source.watch(),
      (error: unknown) => error === discovery,
    );
    assert.equal(host.watchers.length, baseline);
    assert.equal(registry.watchSessions.has(key), false);
    assert.equal(registry.sourceWatchers.has(key), false);

    host.spriteSourceFrom = async () => ({
      loadConfig: async () => ({
        staging: [{ dir: 'staging', transforms: [] }],
      }),
    });
    const allocate = host.vscode.workspace.createFileSystemWatcher;
    const allocation = new Error('fixture watcher allocation rejected');
    let attempts = 0;
    host.vscode.workspace.createFileSystemWatcher = (...args: any[]) => {
      if (++attempts === 2) throw allocation;
      return allocate(...args);
    };
    await assert.rejects(
      source.watch(),
      (error: unknown) => error === allocation,
    );
    const partial = host.watchers.slice(baseline);
    assert.equal(partial.length, 1);
    assert(partial.every((watcher: any) => watcher.disposed));
    assert.equal(registry.watchSessions.has(key), false);
    assert.equal(registry.sourceWatchers.has(key), false);

    host.vscode.workspace.createFileSystemWatcher = allocate;
    await source.watch();
    const current = registry.sourceWatchers.get(key);
    assert.equal(
      current.length,
      4,
      'Three source formats and one stage directory are watched',
    );
    assert(current.every((watcher: any) => !watcher.disposed));
    assert.equal(source.contextValue, 'sprite-source-watched');
    source.unwatch();
    assert(current.every((watcher: any) => watcher.disposed));
    assert.equal(registry.sourceWatchers.has(key), false);
  },
);

for (const cancel of ['unwatch', 'tree-dispose', 'project-dispose'] as const) {
  test(
    `real SpriteSource watch does not allocate after ${cancel} during pending stage discovery`,
    { timeout: 30_000 },
    async (t) => {
      const host = await createHost({ realSpriteSources: true });
      const release = deferred<{ staging: never[] }>();
      let waiting: Promise<unknown> | undefined;
      t.after(async () => {
        release.resolve({ staging: [] });
        if (waiting) await Promise.allSettled([waiting]);
        host.dispose();
      });
      const { source, tree, project, registry } = await sourceFixture(host);
      const entered = deferred();
      host.spriteSourceFrom = async () => ({
        loadConfig: () => {
          entered.resolve();
          return release.promise;
        },
      });
      const baseline = host.watchers.length;
      waiting = source.watch();
      await entered.promise;
      if (cancel === 'unwatch') source.unwatch();
      else if (cancel === 'tree-dispose') tree.dispose();
      else project.dispose();
      release.resolve({ staging: [] });
      await waiting;
      assert.equal(host.watchers.length, baseline);
      assert.equal(
        registry.watchSessions.has(source.sourceDir.absolute),
        false,
      );
      assert.equal(
        registry.sourceWatchers.has(source.sourceDir.absolute),
        false,
      );
      assert.equal(source.contextValue, 'sprite-source-unwatched');
    },
  );
}
