import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHost, deferred } from './test/host.mjs';

/** Actual activation, diagnostic wiring, Project/Code/service and metadata grouping.
 * Paths are identities only: save/delete ports fail unless a case explicitly records them.
 * No native discovery, project serialization, watcher disk application or real game is run.
 */
async function fixture(t: TestContext) {
  const host = await createHost();
  const restores: (() => void)[] = [];
  const drains: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    try {
      for (const drain of drains) await drain();
    } finally {
      for (const restore of restores.reverse()) restore();
      host.dispose();
      assert.equal(
        existsSync(host.root),
        false,
        'No identity-only host project directory may be created',
      );
    }
  });
  assert.equal(existsSync(host.root), false);
  function patch(target: any, key: string, descriptor: PropertyDescriptor) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restores.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    });
  }
  const files: Record<string, any> = {};
  let loadedProject: any;
  host.chooseProject = async () =>
    host.vscode.Uri.file(path.join(host.root, 'memory.yyp'));
  host.initializeProject = async (project: any) => {
    loadedProject = project;
    host.subject.seedProject(project);
    files.Target = host.subject.addCode(
      project,
      'Target',
      'var target_value = audit_target_missing;',
    );
    files.Sibling = host.subject.addCode(
      project,
      'Sibling',
      'var sibling_value = audit_sibling_missing;',
    );
    // Public parsed-YY inputs, not an isInFolder substitute. Exercise subtree grouping.
    files.Target.asset.yy.parent = {
      name: 'Suppressed/Nested',
      path: 'folders/Suppressed/Nested.yy',
    };
    files.Sibling.asset.yy.parent = { name: 'Other', path: 'folders/Other.yy' };
  };
  const workspace = await host.activate();
  const project = workspace.projects[0];
  assert.equal(project, loadedProject);
  const publications: any[] = [];
  const unsubscribe = project.onDiagnostics((payload: any) =>
    publications.push(payload),
  );
  restores.push(unsubscribe);
  const unexpectedWrite = async () => {
    throw new Error(
      'Unexpected real project save/delete in an identity-only fixture',
    );
  };
  patch(project, 'saveYyp', { value: unexpectedWrite });
  for (const code of Object.values(files)) {
    const dir = code.asset.dir;
    // Asset.dir normally returns a new Pathy. Cache that same real path on this
    // instance so its lowest delete port can be guarded, without replacing onRemove.
    patch(code.asset, 'dir', { get: () => dir });
    patch(dir, 'delete', { value: unexpectedWrite });
    patch(code.asset, 'saveYy', { value: unexpectedWrite });
    patch(code.path, 'delete', { value: unexpectedWrite });
  }
  await project.analysis.analyze();
  const uris = Object.fromEntries(
    Object.entries(files).map(([name, code]) => [
      name,
      host.vscode.Uri.file(code.path.absolute),
    ]),
  );
  assert(
    visible(workspace, uris.Target).some((item) =>
      item.message.includes('audit_target_missing'),
    ),
  );
  assert(
    visible(workspace, uris.Sibling).some((item) =>
      item.message.includes('audit_sibling_missing'),
    ),
  );
  assert.equal(workspace.diagnosticCollection.disposed, false);
  return { host, workspace, project, files, uris, publications, patch, drains };
}

type VisibleDiagnostic = {
  message: string;
  severity: number;
  source: string;
  start: number[];
  end: number[];
};

/** Host-visible diagnostics only, detached from collection arrays and model identities. */
function visible(workspace: any, uri: any): VisibleDiagnostic[] {
  return (workspace.diagnosticCollection.entries.get(uri.toString()) || []).map(
    (diagnostic: any) => ({
      message: diagnostic.message as string,
      severity: diagnostic.severity,
      source: diagnostic.source,
      start: [diagnostic.range.start.line, diagnostic.range.start.character],
      end: [diagnostic.range.end.line, diagnostic.range.end.character],
    }),
  );
}

function expectRetired(
  f: Awaited<ReturnType<typeof fixture>>,
  code: any,
  references: any[],
) {
  assert.equal(f.project.analysis.document(code.path.absolute), undefined);
  assert.equal(code.analysisState.status, 'retired');
  assert.deepEqual(code.refs, []);
  for (const reference of references) {
    assert(!f.project.analysis.references.includes(reference));
    assert.equal(reference.item.refs.has(reference), false);
  }
  assert(
    f.publications.some(
      (payload) =>
        payload.filePath === code.path.absolute &&
        payload.diagnostics.length === 0,
    ),
    'Real retirement must publish the target URI tombstone',
  );
  assert.deepEqual(
    visible(f.workspace, f.host.vscode.Uri.file(code.path.absolute)),
    [],
  );
  assert.equal(f.project.analysis.isCurrent, true);
  assert.equal(f.project.analysis.error, undefined);
}

test(
  'configuration events suppress an existing diagnostic group and republish it on release without clearing another URI',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const targetBefore = visible(f.workspace, f.uris.Target);
    const siblingBefore = visible(f.workspace, f.uris.Sibling);
    const configurations: Promise<void>[] = [];
    const configure = f.workspace.onConfigurationChanged;
    // Observe completion of the actual handler reached by the actual activation
    // subscription. Do not invoke that handler directly or reproduce suppression.
    f.patch(f.workspace, 'onConfigurationChanged', {
      value: function (this: any, event: any) {
        const pending = configure.call(this, event);
        configurations.push(pending);
        return pending;
      },
    });
    f.drains.push(async () => {
      await Promise.allSettled(configurations);
    });
    async function suppression(groups: string[]) {
      f.host.settings.set('diagnostics.suppressGroups', groups);
      const before = configurations.length;
      f.host.events.configuration.fire({
        affectsConfiguration: (key: string) =>
          key === 'stitch' || key === 'stitch.diagnostics.suppressGroups',
      });
      assert.equal(
        configurations.length,
        before + 1,
        'The registered configuration callback must run',
      );
      await configurations[before];
    }

    const beforeSuppress = f.publications.length;
    await suppression(['Suppressed']);
    assert.deepEqual(visible(f.workspace, f.uris.Target), []);
    assert.deepEqual(visible(f.workspace, f.uris.Sibling), siblingBefore);
    assert(
      f.publications
        .slice(beforeSuppress)
        .some(
          (payload) =>
            payload.code === f.files.Target && payload.diagnostics.length > 0,
        ),
      'Suppression filters the host view, not the real Code diagnostics',
    );
    f.files.Target.publishDiagnostics();
    assert.deepEqual(
      visible(f.workspace, f.uris.Target),
      [],
      'A later normal publication must not reintroduce a suppressed URI',
    );
    assert.deepEqual(visible(f.workspace, f.uris.Sibling), siblingBefore);

    const beforeRelease = f.publications.length;
    await suppression([]);
    assert.deepEqual(visible(f.workspace, f.uris.Target), targetBefore);
    assert.deepEqual(visible(f.workspace, f.uris.Sibling), siblingBefore);
    assert(
      f.publications
        .slice(beforeRelease)
        .some(
          (payload) =>
            payload.code === f.files.Target && payload.diagnostics.length > 0,
        ),
      'Unsuppression must actively republish the existing view',
    );
    assert.equal(
      f.project.analysis.document(f.files.Target.path.absolute),
      f.files.Target,
    );
    assert.equal(f.workspace.diagnosticCollection.disposed, false);
  },
);

test(
  'the actual Code.remove entry retracts only its URI from the live diagnostic collection',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const target = f.files.Target;
    const asset = target.asset;
    const references = [...target.refs];
    assert(references.length > 0);
    const siblingBefore = visible(f.workspace, f.uris.Sibling);
    const deleted: string[] = [];
    f.patch(target.path, 'delete', {
      value: async () => {
        deleted.push(target.path.absolute);
      },
    });

    await target.remove();

    assert.deepEqual(deleted, [target.path.absolute]);
    assert.equal(
      f.project.getAssetByName('Target'),
      asset,
      'Removing Code is not resource removal',
    );
    assert.equal(asset.gmlFiles.size, 0);
    assert(
      f.project.yyp.resources.some(
        (resource: any) => resource.id.name === 'Target',
      ),
    );
    expectRetired(f, target, references);
    assert.equal(
      f.project.analysis.document(f.files.Sibling.path.absolute),
      f.files.Sibling,
    );
    assert.deepEqual(visible(f.workspace, f.uris.Sibling), siblingBefore);
    assert.equal(f.workspace.diagnosticCollection.disposed, false);
  },
);

test(
  'the actual Project.removeAssetByName entry retracts its Code URI while preserving another asset diagnostics',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const target = f.files.Target;
    const asset = target.asset;
    const dir = asset.dir;
    const references = [...target.refs];
    assert(references.length > 0);
    const siblingBefore = visible(f.workspace, f.uris.Sibling);
    const saves: string[][] = [];
    const deletions: {
      path: string;
      options: unknown;
      unregistered: boolean;
    }[] = [];
    f.patch(f.project, 'saveYyp', {
      value: async () => {
        saves.push(
          f.project.yyp.resources.map((resource: any) => resource.id.name),
        );
      },
    });
    f.patch(dir, 'delete', {
      value: async (options: unknown) => {
        deletions.push({
          path: dir.absolute,
          options,
          unregistered:
            f.project.analysis.document(target.path.absolute) === undefined,
        });
      },
    });

    await f.project.removeAssetByName('Target');

    assert.deepEqual(saves, [['Sibling']]);
    assert.deepEqual(deletions, [
      {
        path: dir.absolute,
        options: { force: true, recursive: true },
        unregistered: true,
      },
    ]);
    assert.equal(f.project.getAssetByName('Target'), undefined);
    assert(
      !f.project.yyp.resources.some(
        (resource: any) => resource.id.name === 'Target',
      ),
    );
    assert.equal(asset.gmlFiles.size, 0);
    expectRetired(f, target, references);
    assert.equal(f.project.getAssetByName('Sibling'), f.files.Sibling.asset);
    assert.deepEqual(visible(f.workspace, f.uris.Sibling), siblingBefore);
    assert.equal(f.workspace.diagnosticCollection.disposed, false);
  },
);

for (const boundary of ['reloadResource', 'onChangeFile'] as const) {
  test(
    `disposing ChangeTracker during actual ${boundary} prevents a late asset event without clearing the live bus`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      const tracker = f.workspace.externalChangeTracker;
      const target = f.files.Target;
      const sibling = f.files.Sibling;
      const entered = deferred();
      const release = deferred<string>();
      const flushes: Promise<void>[] = [];
      f.drains.push(async () => {
        release.resolve('var after_disposal = "current";');
        await Promise.allSettled(flushes);
      });
      const events: { asset: any; type: string; uri: string }[] = [];
      const subscription = f.host.subject.stitchEvents.on(
        'asset-changed',
        (asset: any, type: string, uri: any) => {
          events.push({ asset, type, uri: uri.toString() });
        },
      );
      // Remove this test observer only after any pending real reconciliation drains.
      f.drains.push(async () => {
        subscription.off();
      });
      let siblingReads = 0;
      f.patch(sibling.path, 'read', {
        value: async () => {
          siblingReads++;
          throw new Error(
            'A disposed tracker must abandon its queued sibling change',
          );
        },
      });
      let reads = 0;
      let readCompletions = 0;
      let uri = f.uris.Target;
      if (boundary === 'reloadResource') {
        // Supply real YY text through the existing documentText callback. Only its
        // asynchronous read is gated; reloadResource, Asset.reload and retirement
        // remain actual production code. The identity root has no physical GML.
        const metadata = f.host.document(
          { path: { absolute: target.asset.yyPath.absolute } },
          JSON.stringify(target.asset.yy),
        );
        metadata.languageId = 'yy';
        f.host.documents.push(metadata);
        uri = metadata.uri;
        const read = f.project.readDocumentText;
        f.patch(f.project, 'readDocumentText', {
          value: async function (this: any, file: any) {
            assert.equal(file.absolute, target.asset.yyPath.absolute);
            reads++;
            entered.resolve();
            await release.promise;
            const text = await read.call(this, file);
            readCompletions++;
            return text;
          },
        });
      } else {
        // Preserve the actual workspace.onChangeFile and resource barrier. Only
        // the lowest file-read port returns the new saved text after release.
        f.patch(target.path, 'read', {
          value: async () => {
            reads++;
            entered.resolve();
            const text = await release.promise;
            readCompletions++;
            return text;
          },
        });
      }
      tracker.addChange({ type: 'change', uri });
      tracker.addChange({ type: 'change', uri: f.uris.Sibling });
      const flushing = tracker.flush();
      flushes.push(flushing);
      const settled = Promise.allSettled([flushing]);
      // Race against actual completion so a missing awaited port fails instead
      // of relying on sleeps or a guessed number of microtask turns.
      assert.equal(
        await Promise.race([
          entered.promise.then(() => 'entered-read'),
          settled.then(() => 'finished-before-read'),
        ]),
        'entered-read',
      );
      assert.equal(reads, 1);
      assert.equal(readCompletions, 0);
      assert.equal(f.project.resourcesPending, true);

      tracker.dispose(); // Do not dispose workspace/project or clear stitchEvents.
      assert.equal(f.project.isDisposed, false);
      assert.equal(f.workspace.diagnosticCollection.disposed, false);
      f.host.subject.stitchEvents.emit(
        'asset-changed',
        sibling.asset,
        'change',
        f.uris.Sibling,
      );
      const controls = [
        {
          asset: sibling.asset,
          type: 'change',
          uri: f.uris.Sibling.toString(),
        },
      ];
      assert.deepEqual(
        events,
        controls,
        'The original listener and global bus remain live after tracker disposal',
      );
      tracker.addChange({ type: 'change', uri: f.uris.Sibling });
      release.resolve('var after_disposal = "current";');
      const [result] = await settled;
      assert.equal(result.status, 'fulfilled');
      assert.equal(readCompletions, 1);
      assert.equal(siblingReads, 0);
      assert.deepEqual(
        events,
        controls,
        'Completing an abandoned operation must not emit asset-changed',
      );
      assert.equal(f.project.resourcesPending, false);
      assert.equal(f.project.analysis.isCurrent, true);
      assert.equal(f.project.analysis.error, undefined);
      if (boundary === 'reloadResource') {
        assert.equal(
          target.analysisState.status,
          'retired',
          'Actual metadata reconciliation sees the absent listed physical GML',
        );
        assert.equal(target.asset.gmlFiles.size, 0);
        assert.equal(
          f.project.analysis.document(target.path.absolute),
          undefined,
        );
      } else {
        assert.equal(target.content, 'var after_disposal = "current";');
        assert(
          target.refs.some(
            (reference: any) =>
              reference.isDef && reference.item.name === 'after_disposal',
          ),
        );
        assert.equal(f.project.analysis.document(target.path.absolute), target);
      }
      f.host.subject.stitchEvents.emit(
        'asset-changed',
        sibling.asset,
        'change',
        f.uris.Sibling,
      );
      assert.deepEqual(
        events,
        [...controls, ...controls],
        'The bus also remains usable after the pending operation completes',
      );
    },
  );
}
