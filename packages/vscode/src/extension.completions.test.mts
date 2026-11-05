import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createHost, deferred } from './test/host.mjs';

let host: Awaited<ReturnType<typeof createHost>>;
beforeEach(async () => {
  host = await createHost();
});
afterEach(() => host.dispose());
const token = () => ({ isCancellationRequested: false });
const snapshot = () => [
  {
    name: 'member_value',
    kind: 'variable',
    detail: 'Real local',
    fallback: 'snapshot',
  },
];
function document(text = 'box.member_value;') {
  return host.document(
    { path: { absolute: `${host.root}/completion.gml` } },
    text,
  );
}
function select(doc: any, offset: number) {
  const position = doc.positionAt(offset);
  host.vscode.window.activeTextEditor = {
    document: doc,
    selection: { active: position },
    selections: [{ active: position }],
  };
  return position;
}
function runTimers() {
  for (const [id, callback] of [...host.timers]) {
    host.timers.delete(id);
    callback();
  }
}
function registered(query: (...args: any[]) => any = async () => snapshot()) {
  const commits = new host.vscode.EventEmitter();
  const registrations: any[] = [];
  host.vscode.languages.registerCompletionItemProvider = (
    selector: any,
    provider: any,
    ...triggers: string[]
  ) => {
    const registration = host.registration('completion');
    const activeBefore = registrations.filter(
      (item) => !item.registration.disposed,
    ).length;
    registrations.push({
      selector,
      provider,
      triggers,
      registration,
      activeBefore,
    });
    return registration;
  };
  const provider = host.subject.StitchCompletionProvider.register({
    query,
    onDidCommitLanguage: commits.event,
  });
  host.ctx.subscriptions.push(provider, commits);
  return { provider, commits, registrations };
}

// These tests exercise the real provider and public registration lifecycle.
// The host doubles UI and timers; it cannot prove real suggestion-widget state.
test('snapshot candidates preserve identities and types with current physical insert/replace ranges', async () => {
  const text = '// 😀\r\nvar value = box.member_value;';
  const doc = document(text);
  const cursor = text.indexOf('member_value') + 3;
  const provider = new host.subject.StitchCompletionProvider({
    query: async () => snapshot(),
  });
  const list = await provider.provideCompletionItems(
    doc,
    doc.positionAt(cursor),
    token(),
    {},
  );
  assert.equal(list.isIncomplete, true);
  assert.equal(list.items.length, 1);
  const item = list.items[0];
  assert.equal(item.label, 'member_value');
  assert.equal(item.kind, host.vscode.CompletionItemKind.Variable);
  assert.match(item.detail, /Analysis updating/);
  assert.match(item.detail, /Real local/);
  assert.equal(doc.getText(item.range.inserting), 'mem');
  assert.equal(doc.getText(item.range.replacing), 'member_value');
  assert.equal(item.range.inserting.start.line, 1);
  assert.equal(doc.offsetAt(item.range.inserting.end), cursor);
});

test('bare dots insert at the caret and native fallback retains its existing label', async () => {
  const doc = document('box.');
  const native = [
    {
      name: 'show_debug_message',
      kind: 'function',
      detail: 'Analysis updating · built-in candidate',
      fallback: 'native',
    },
  ];
  const provider = new host.subject.StitchCompletionProvider({
    query: async () => native,
  });
  const list = await provider.provideCompletionItems(
    doc,
    doc.positionAt(4),
    token(),
    { triggerCharacter: '.' },
  );
  assert.equal(list.isIncomplete, true);
  assert.equal(list.items[0].detail, native[0].detail);
  assert.equal(doc.getText(list.items[0].range.inserting), '');
  assert.equal(doc.offsetAt(list.items[0].range.replacing.start), 4);
  assert.equal(doc.offsetAt(list.items[0].range.replacing.end), 4);
});

test('precise candidates return complete results without an updating marker', async () => {
  const doc = document();
  const provider = new host.subject.StitchCompletionProvider({
    query: async () => [
      { name: 'member_latest', kind: 'variable', detail: 'String' },
    ],
  });
  const result = await provider.provideCompletionItems(
    doc,
    doc.positionAt(7),
    token(),
    {},
  );
  assert(Array.isArray(result));
  assert.equal(result[0].detail, 'String');
});

for (const change of ['edit', 'close', 'cancel', 'dispose'] as const) {
  test(`a pending result is discarded after ${change}`, async () => {
    const response = deferred<any>();
    const doc = document();
    const cancellation = token();
    const provider = new host.subject.StitchCompletionProvider({
      query: () => response.promise,
    });
    const result = provider.provideCompletionItems(
      doc,
      doc.positionAt(7),
      cancellation,
      {},
    );
    if (change === 'edit') doc.setText('different.receiver;');
    if (change === 'close') doc.isClosed = true;
    if (change === 'cancel') cancellation.isCancellationRequested = true;
    if (change === 'dispose') provider.dispose();
    response.resolve(snapshot());
    assert.equal(await result, undefined);
  });
}

test('a newer request supersedes an older caret query in the same document', async () => {
  const old = deferred<any>();
  let calls = 0;
  const provider = new host.subject.StitchCompletionProvider({
    query: () =>
      ++calls === 1
        ? old.promise
        : Promise.resolve([{ name: 'newest', kind: 'variable' }]),
  });
  const doc = document();
  const first = provider.provideCompletionItems(
    doc,
    doc.positionAt(4),
    token(),
    {},
  );
  const next = await provider.provideCompletionItems(
    doc,
    doc.positionAt(7),
    token(),
    {},
  );
  assert.equal(next[0].label, 'newest');
  old.resolve(snapshot());
  assert.equal(await first, undefined);
});

test('a commit coalesces one replacement after an incomplete result, with no provider gap', async () => {
  const f = registered();
  const doc = document();
  const position = select(doc, 7);
  await f.provider.provideCompletionItems(doc, position, token(), {});
  f.commits.fire();
  f.commits.fire();
  assert.equal(host.timers.size, 1);
  runTimers();
  assert.equal(f.registrations.length, 2);
  assert.equal(
    f.registrations[1].activeBefore,
    1,
    'The replacement is registered before the old provider is removed',
  );
  assert.equal(f.registrations[0].registration.disposed, true);
  assert.equal(f.registrations[1].registration.disposed, false);
  assert.equal(f.registrations[0].provider, f.registrations[1].provider);
  f.commits.fire();
  runTimers();
  assert.equal(
    f.registrations.length,
    2,
    'A served incomplete response is refreshed at most once',
  );
});

test('no current fallback means commits do not churn provider registrations', async () => {
  const f = registered(async () => [
    { name: 'member_latest', kind: 'variable' },
  ]);
  const doc = document();
  const position = select(doc, 7);
  f.commits.fire();
  await f.provider.provideCompletionItems(doc, position, token(), {});
  f.commits.fire();
  runTimers();
  assert.equal(f.registrations.length, 1);
});

for (const change of [
  'edit',
  'close',
  'selection',
  'editor',
  'configuration',
  'dispose',
] as const) {
  test(`queued publication is withdrawn on ${change}`, async () => {
    const f = registered();
    const doc = document();
    const position = select(doc, 7);
    await f.provider.provideCompletionItems(doc, position, token(), {});
    f.commits.fire();
    if (change === 'edit') {
      doc.setText('box.member_value; ');
      host.events.change.fire({ document: doc });
    }
    if (change === 'close') {
      doc.isClosed = true;
      host.events.close.fire(doc);
    }
    if (change === 'selection') {
      select(doc, 8);
      host.events.selection.fire({
        textEditor: host.vscode.window.activeTextEditor,
      });
    }
    if (change === 'editor') {
      select(document('another.'), 8);
      host.events.activeEditor.fire(host.vscode.window.activeTextEditor);
    }
    if (change === 'configuration') host.events.configuration.fire({});
    if (change === 'dispose') f.provider.dispose();
    runTimers();
    f.commits.fire();
    runTimers();
    assert.equal(f.registrations.length, 1);
  });
}

test('the timer rechecks the live caret even before selection notification arrives', async () => {
  const f = registered();
  const doc = document();
  await f.provider.provideCompletionItems(doc, select(doc, 7), token(), {});
  f.commits.fire();
  select(doc, 8);
  runTimers();
  assert.equal(f.registrations.length, 1);
});

test('continued input replaces the old publication point with the newest incomplete result', async () => {
  const f = registered();
  const doc = document('box.m');
  await f.provider.provideCompletionItems(doc, select(doc, 5), token(), {});
  f.commits.fire();
  doc.setText('box.me');
  host.events.change.fire({ document: doc });
  await f.provider.provideCompletionItems(doc, select(doc, 6), token(), {});
  runTimers();
  assert.equal(f.registrations.length, 1);
  f.commits.fire();
  runTimers();
  assert.equal(f.registrations.length, 2);
});

test('commit delivery while the fallback Promise resolves still publishes once', async () => {
  const response = deferred<any>();
  const f = registered(() => response.promise);
  const doc = document();
  const pending = f.provider.provideCompletionItems(
    doc,
    select(doc, 7),
    token(),
    {},
  );
  f.commits.fire();
  response.resolve(snapshot());
  await pending;
  runTimers();
  assert.equal(f.registrations.length, 2);
});

test('registration failure releases the already registered provider and listeners', () => {
  host.failRegistration = 'active-editor';
  assert.throws(() => registered(), /Registration failed/);
  for (const event of Object.values(host.events) as any[])
    assert.equal(event.size, 0);
  const registrations = host.resources.filter(
    (item: any) => item.label === 'completion',
  );
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].disposed, true);
});

test('a cancelled fallback request never arms commit publication', async () => {
  const response = deferred<any>();
  const f = registered(() => response.promise);
  const doc = document();
  const cancellation = token();
  const request = f.provider.provideCompletionItems(
    doc,
    select(doc, 7),
    cancellation,
    {},
  );
  cancellation.isCancellationRequested = true;
  response.resolve(snapshot());
  assert.equal(await request, undefined);
  f.commits.fire();
  runTimers();
  assert.equal(f.registrations.length, 1);
});
