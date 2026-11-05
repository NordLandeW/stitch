import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createHost } from './test/host.mjs';
import { workerFixture } from './test/worker.mjs';

// The gate withholds delivery of an analysis transaction. Assertions about
// early candidates run before its explicit release, with no latency threshold.
test(
  'production completion reuses contextual candidates across edits and saves before analysis, then publishes the current result',
  { timeout: 60000 },
  async () => {
    const source =
      'function NamedBox() constructor {value=1;}\nfunction project_factory(){return {member_old:1,member_other:2};}';
    const use =
      'function Use(){var local_value=1; var box=project_factory();\nbox.member_old;\nlocal_value;\nproject_factory();\n}';
    const documentation =
      '/// @template T\r\n/// @returns {Array<T>|Struct.NamedBox}\r\nfunction identity(value){return value;}';
    const f = await workerFixture({
      Producer: source,
      Consumer: use,
      Documentation: documentation,
    });
    const host = await createHost();
    const post = Worker.prototype.postMessage;
    let hold = false;
    const held: (() => void)[] = [];
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    Worker.prototype.postMessage = function (message, transferList) {
      if (hold && message.kind === 'update') {
        held.push(() => post.call(this, message, transferList));
        entered();
      } else post.call(this, message, transferList);
    };
    try {
      await f.service.ready;
      f.service.dispose();
      await f.worker.terminate();
      await mkdir(path.join(f.directory, 'dist'));
      await copyFile(
        f.workerPath,
        path.join(f.directory, 'dist/language-worker.js'),
      );
      const workspace = host.newWorkspace({
        ...host.ctx,
        extensionPath: f.directory,
      });
      const project = new host.subject.GameMakerProject(
        host.vscode.Uri.file(f.yypPath),
        { analysis: 'resources' },
      );
      project.yyp = f.yyp;
      project.config = {};
      Object.defineProperty(project, 'nativeSpecFiles', {
        value: f.input.nativeSpecFiles,
      });
      project.getGmlFile = () => {
        throw new Error('No host language graph');
      };
      workspace.projects.push(project);
      let service: any;
      const create = host.subject.createWorkerLanguageService.bind(workspace);
      workspace.createLanguageService = (value: any) =>
        (service = create(value));
      const producer = host.document(
        { path: { absolute: f.files.Producer } },
        source,
      );
      const consumer = host.document(
        { path: { absolute: f.files.Consumer } },
        use,
      );
      const documented = host.document(
        { path: { absolute: f.files.Documentation } },
        documentation,
      );
      host.documents.push(producer, consumer, documented);
      const token = { isCancellationRequested: false };
      await workspace.query(consumer, {
        kind: 'hover',
        offset: use.indexOf('box.member') + 4,
      });
      const registrations: any[] = [];
      host.vscode.languages.registerCompletionItemProvider = () => {
        const value = host.registration('completion');
        registrations.push(value);
        return value;
      };
      const provider =
        host.subject.StitchCompletionProvider.register(workspace);
      host.ctx.subscriptions.push(provider);
      const select = (offset: number) => {
        const position = consumer.positionAt(offset);
        host.vscode.window.activeTextEditor = {
          document: consumer,
          selection: { active: position },
          selections: [{ start: position }],
        };
        return position;
      };
      const request = (offset: number) =>
        provider.provideCompletionItems(consumer, select(offset), token, {});
      const changed = (document: any, text: string) => {
        document.setText(text);
        workspace.onChangeDoc({ document, contentChanges: [{ text }] });
      };
      hold = true;
      changed(producer, source.replace('member_old', 'member_latest'));
      const flushing = service.flush();
      await blocked;
      for (const [needle, prefix, expected] of [
        ['box.member_old', 'box.mem', 'member_old'],
        ['\nlocal_value;', '\nlocal_', 'local_value'],
        ['\nproject_factory();', '\nproject_', 'project_factory'],
      ]) {
        const result = await request(
          consumer.getText().indexOf(needle) + prefix.length,
        );
        assert.equal(result.isIncomplete, true);
        assert(
          result.items.some((item: any) => item.label === expected),
          expected,
        );
        assert.equal(service.isCurrent, false);
      }
      for (const [needle, prefix, expected] of [
        ['Struct.NamedBox', 'Struct.Na', 'Struct.NamedBox'],
        ['Array<T>', 'Array<T', 'T'],
      ]) {
        const position = documented.positionAt(
          documentation.indexOf(needle) + prefix.length,
        );
        const result = await provider.provideCompletionItems(
          documented,
          position,
          token,
          { triggerCharacter: needle.startsWith('Struct') ? '.' : '<' },
        );
        assert.equal(result.isIncomplete, true);
        const item = result.items.find((item: any) => item.label === expected);
        assert(item, expected);
        assert.equal(
          documented.getText(item.range),
          needle.startsWith('Struct') ? 'Struct.NamedBox' : 'T',
        );
        assert.equal(
          service.isCurrent,
          false,
          'Documented project/local types are available before the blocked analysis is released',
        );
      }
      let text = use;
      for (const prefix of ['m', 'me', 'mem']) {
        text = use.replace('box.member_old', 'box.' + prefix);
        changed(consumer, text);
        const result = await request(text.indexOf('box.') + 4 + prefix.length);
        assert.deepEqual(result.items.map((item: any) => item.label).sort(), [
          'member_old',
          'member_other',
        ]);
        assert.equal(result.isIncomplete, true);
      }
      workspace.externalChangeTracker.addChange({
        type: 'change',
        uri: producer.uri,
      });
      const saved = await request(text.indexOf('box.') + 7);
      assert(saved.items.some((item: any) => item.label === 'member_old'));
      assert.equal(service.isCurrent, false);
      let navigated = false;
      const definition = workspace
        .query(consumer, {
          kind: 'definition',
          offset: text.indexOf('project_factory'),
        })
        .then((value: any) => {
          navigated = true;
          return value;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        navigated,
        false,
        'Navigation waits for current source analysis',
      );
      assert.equal(
        registrations.length,
        1,
        'Uncommitted analysis does not refresh completions',
      );
      hold = false;
      for (const release of held.splice(0)) release();
      await flushing;
      await definition;
      await workspace.externalChangeTracker.flushPending();
      assert.equal(service.isCurrent, true);
      for (const [id, callback] of [...host.timers]) {
        host.timers.delete(id);
        callback();
      }
      assert.equal(
        registrations.length,
        2,
        'The production workspace commit refreshes a relevant incomplete session',
      );
      assert.equal(registrations[0].disposed, true);
      const latest = await request(text.indexOf('box.') + 7);
      assert.deepEqual(latest.map((item: any) => item.label).sort(), [
        'member_latest',
        'member_other',
      ]);
      assert.equal(await f.diskText('Producer'), source);
      assert.equal(await f.diskText('Consumer'), use);
    } finally {
      hold = false;
      for (const release of held.splice(0)) release();
      Worker.prototype.postMessage = post;
      host.dispose();
      await f.dispose();
    }
  },
);
