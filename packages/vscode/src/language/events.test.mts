import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHost } from '../test/host.mjs';

function transport() {
  const inputs: any[] = [];
  const pending: { query: any; resolve(value: any): void }[] = [];
  const entered: (() => void)[] = [];
  return {
    inputs,
    pending,
    revision: 0,
    isCurrent: true,
    disposed: false,
    update(input: any) {
      inputs.push(input);
      this.revision++;
    },
    async flush() {
      return true;
    },
    query(query: any) {
      return new Promise((resolve) => {
        pending.push({ query, resolve });
        entered.shift()?.();
      });
    },
    nextQuery() {
      return new Promise<void>((resolve) => entered.push(resolve));
    },
    dispose() {
      this.disposed = true;
    },
  };
}

async function activated() {
  const host = await createHost();
  const service = transport();
  host.subject.StitchWorkspace.prototype.createLanguageService = () => service;
  host.chooseProject = async () =>
    host.vscode.Uri.file(host.root + '/memory.yyp');
  host.initializeProject = async (project: any) => {
    await host.subject.seedProject(project);
    Object.defineProperty(project, 'nativeSpecFiles', {
      value: [host.root + '/native.xml'],
    });
  };
  host.settings.set('editing.signatureStatus.enable', false);
  const workspace = await host.activate();
  assert.equal(workspace.projects.length, 1, JSON.stringify(host.logs));
  return { host, workspace, service };
}

test('selection UI rejects an older response even when source revision is unchanged', async () => {
  const { host, workspace, service } = await activated();
  try {
    const document = host.document(
      { path: { absolute: host.root + '/scripts/Use/Use.gml' } },
      'value;show_debug_message(1);',
    );
    host.documents.push(document);
    const select = (offset: number) =>
      host.events.selection.fire({
        textEditor: { document },
        selections: [{ start: document.positionAt(offset) }],
      });
    let entered = service.nextQuery();
    select(0);
    await entered;
    entered = service.nextQuery();
    select(6);
    await entered;
    const newest = host.waitForContext('stitch.selectionIsNative', true);
    service.pending[1].resolve({
      native: true,
      name: 'show_debug_message',
      type: 'Function',
    });
    await newest;
    service.pending[0].resolve({ native: false, name: 'value', type: 'Real' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(host.contexts.get('stitch.selectionIsNative'), true);
    assert.equal(workspace.signatureHelpStatus.visible, false);
  } finally {
    host.dispose();
  }
});

test('activation routes native/configuration/settings and preserves reopened document identity', async () => {
  const { host, workspace, service } = await activated();
  try {
    host.watchers
      .find((watcher: any) => watcher.pattern === 'native.xml')
      .change();
    assert.equal(service.inputs.at(-1).kind, 'native');
    assert.deepEqual(service.inputs.at(-1).files, [host.root + '/native.xml']);
    host.settings.set('run.defaultConfig', 'Test');
    host.events.configuration.fire({
      affectsConfiguration: (key: string) => key === 'stitch.run.defaultConfig',
    });
    assert.deepEqual(service.inputs.at(-1), {
      kind: 'configuration',
      name: 'Test',
    });
    host.settings.set('diagnostics.autoDeclaredGlobalsPatterns', [
      'temporary_',
    ]);
    host.events.configuration.fire({
      affectsConfiguration: (key: string) =>
        key === 'stitch.diagnostics.autoDeclaredGlobalsPatterns',
    });
    assert.deepEqual(service.inputs.at(-1), {
      kind: 'settings',
      prefixes: ['temporary_'],
    });
    const file = { path: { absolute: host.root + '/scripts/Use/Use.gml' } };
    const first = host.document(file, 'var first=1;');
    host.documents.push(first);
    host.events.open.fire(first);
    const oldGeneration = service.inputs.at(-1).generation;
    first.isClosed = true;
    host.events.close.fire(first);
    const reopened = host.document(file, 'var latest=2;');
    host.documents.push(reopened);
    host.events.open.fire(reopened);
    const current = service.inputs.at(-1);
    assert.equal(current.text, 'var latest=2;');
    assert(current.generation > oldGeneration);
    const count = service.inputs.length;
    host.events.close.fire(first);
    assert.equal(
      service.inputs.length,
      count,
      'A late close cannot retire the reopened document',
    );
    workspace.clearProjects();
    assert.equal(service.disposed, true);
    assert(
      host.watchers
        .filter((watcher: any) => watcher.pattern === 'native.xml')
        .every((watcher: any) => watcher.disposed),
    );
  } finally {
    host.dispose();
  }
});

test('retirement clears diagnostics on an open file while old text snapshots remain rejected', async () => {
  const { host, workspace } = await activated();
  try {
    const file = host.root + '/scripts/Removed/Removed.gml';
    const document = host.document({ path: { absolute: file } }, 'broken');
    host.documents.push(document);
    const snapshot = {
      path: file,
      text: 'broken',
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 6 },
          },
          message: 'syntax error',
          severity: 'error',
        },
      ],
    };
    workspace.emitDiagnosticSnapshot(snapshot);
    assert.equal(
      workspace.diagnosticCollection.entries.get(document.uri.toString())
        .length,
      1,
    );
    workspace.emitDiagnosticSnapshot({ path: file, diagnostics: [] });
    assert.equal(
      workspace.diagnosticCollection.entries.get(document.uri.toString())
        .length,
      0,
    );
    document.setText('repaired');
    workspace.emitDiagnosticSnapshot(snapshot);
    assert.equal(
      workspace.diagnosticCollection.entries.get(document.uri.toString())
        .length,
      0,
    );
  } finally {
    host.dispose();
  }
});
