import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { WorkerLanguageService, type WorkerEndpoint } from './client.mjs';
import type { Input, WorkerRequest } from './protocol.mjs';

class Endpoint extends EventEmitter implements WorkerEndpoint {
  requests: WorkerRequest[] = [];
  terminated = false;
  postMessage(request: WorkerRequest) {
    this.requests.push(request);
    this.emit('request', request);
  }
  async terminate() {
    this.terminated = true;
    return 0;
  }
  reply(request: WorkerRequest, value?: unknown, diagnostics?: unknown[]) {
    this.emit('message', {
      id: request.id,
      session: request.session,
      ok: true,
      revision: 'revision' in request ? request.revision : 0,
      value,
      diagnostics,
    });
  }
  next(kind: WorkerRequest['kind']): Promise<WorkerRequest> {
    const existing = this.requests.find((request) => request.kind === kind);
    if (existing) {
      this.requests.splice(this.requests.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const listener = (request: WorkerRequest) => {
        if (request.kind !== kind) return;
        this.off('request', listener);
        this.requests.splice(this.requests.indexOf(request), 1);
        resolve(request);
      };
      this.on('request', listener);
    });
  }
}
async function setup(
  options: Partial<ConstructorParameters<typeof WorkerLanguageService>[2]> = {},
) {
  const endpoint = new Endpoint();
  const client = new WorkerLanguageService(
    { yypPath: '/project/game.yyp' },
    '',
    { delay: () => 60000, createWorker: () => endpoint, ...options },
  );
  endpoint.reply(await endpoint.next('initialize'));
  await client.ready;
  return { client, endpoint };
}
function cancellation() {
  let listener: (() => void) | undefined;
  return {
    isCancellationRequested: false,
    onCancellationRequested(callback: () => void) {
      listener = callback;
      return {
        dispose: () => {
          listener = undefined;
        },
      };
    },
    cancel() {
      this.isCancellationRequested = true;
      listener?.();
    },
    get subscribed() {
      return !!listener;
    },
  };
}
const document = (
  text: string,
  generation = 1,
): Extract<Input, { kind: 'document' }> => ({
  kind: 'document',
  path: '/project/scripts/A/A.gml',
  text,
  version: text.length,
  generation,
});

test('coalesces pending edits, preserves close/reopen and metadata ordering, publishes only latest commit', async () => {
  const published: unknown[] = [];
  const { client, endpoint } = await setup({
    onCommit: (value) => published.push(value),
  });
  try {
    published.length = 0;
    client.update(document('one'), true);
    const first = await endpoint.next('update');
    client.update(document('two'));
    client.update(document('latest'));
    client.update({ ...document('outdated'), version: 1 });
    client.update({ kind: 'asset', name: 'A' });
    client.update({
      kind: 'close',
      path: '/project/scripts/A/A.gml',
      generation: 1,
    });
    client.update(document('reopened', 2));
    const flushed = client.flush();
    endpoint.reply(first, undefined, [
      { path: 'consumer.gml', text: 'old', diagnostics: [] },
    ]);
    const second = await endpoint.next('update');
    assert.equal(published.length, 0);
    assert.equal(second.kind, 'update');
    if (second.kind !== 'update') throw new Error('Expected update');
    assert.deepEqual(
      second.inputs.map((input) => input.kind),
      ['document', 'asset', 'close', 'document'],
    );
    assert.equal((second.inputs[0] as any).text, 'latest');
    endpoint.reply(second, undefined, [
      { path: 'consumer.gml', text: 'latest', diagnostics: [] },
    ]);
    assert.equal(await flushed, true);
    assert.deepEqual(published, [
      [{ path: 'consumer.gml', text: 'latest', diagnostics: [] }],
    ]);
  } finally {
    client.dispose();
  }
});

test('stale query responses cannot be cached or returned after any input revision changes', async () => {
  const { client, endpoint } = await setup();
  try {
    const result = client.query({ kind: 'hover', path: 'A.gml', offset: 0 });
    const request = await endpoint.next('query');
    client.update(document('changed'));
    endpoint.reply(request, { code: ['Old'], text: [], sprites: [] });
    assert.equal(await result, undefined);
    const next = client.query({ kind: 'hover', path: 'A.gml', offset: 0 });
    endpoint.reply(await endpoint.next('update'));
    endpoint.reply(await endpoint.next('query'), {
      code: ['New'],
      text: [],
      sprites: [],
    });
    assert.deepEqual((await next)?.code, ['New']);
    const cached = await client.query({
      kind: 'hover',
      path: 'A.gml',
      offset: 0,
    });
    assert(Object.isFrozen(cached));
    assert(Object.isFrozen(cached?.code));
    assert.equal(endpoint.requests.length, 0);
  } finally {
    client.dispose();
  }
});

test('cancellation settles a query waiter without discarding an edit or terminating the persistent worker', async () => {
  const { client, endpoint } = await setup();
  try {
    client.update(document('value'), true);
    const update = await endpoint.next('update');
    const token = cancellation();
    const query = client.query({ kind: 'definition', path: 'A.gml' }, token);
    token.cancel();
    assert.equal(await query, undefined);
    assert.equal(token.subscribed, false);
    assert.equal(endpoint.terminated, false);
    endpoint.reply(update);
    assert.equal(await client.flush(), true);
    const next = client.query({ kind: 'definition', path: 'A.gml' });
    endpoint.reply(await endpoint.next('query'), []);
    assert.deepEqual(await next, []);
  } finally {
    client.dispose();
  }
});

test('foreign-session replies are ignored; worker failure settles every pending request and reclaims listeners', async () => {
  const errors: Error[] = [];
  const { client, endpoint } = await setup({
    onError: (error) => errors.push(error),
  });
  const result = client.query({ kind: 'hover', path: 'A.gml' });
  const request = await endpoint.next('query');
  endpoint.emit('message', {
    id: request.id,
    session: 'old-session',
    ok: true,
    revision: 0,
    value: 'wrong',
  });
  const rejected = assert.rejects(result, /crashed/);
  endpoint.emit('error', new Error('crashed'));
  await rejected;
  assert.equal(errors.length, 1);
  assert.equal(endpoint.terminated, true);
  assert.equal(endpoint.listenerCount('message'), 0);
  assert.equal(await client.query({ kind: 'hover' }), undefined);
  client.dispose();
});

test('disposal rejects pending queries and terminates exactly the owned worker', async () => {
  const { client, endpoint } = await setup();
  const result = client.query({ kind: 'hover' });
  await endpoint.next('query');
  const rejected = assert.rejects(result, /disposed/);
  client.dispose();
  await rejected;
  client.dispose();
  assert.equal(endpoint.terminated, true);
  assert.equal(endpoint.listenerCount('message'), 0);
});

test(
  'a real blocked worker leaves the host event loop usable and cancellation does not preempt its transaction',
  { timeout: 15000 },
  async () => {
    const gate = new SharedArrayBuffer(4);
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const worker = new Worker(
      `
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.on('message', (request) => {
      if (request.kind === 'update') {
        parentPort.postMessage({ entered: true });
        Atomics.wait(new Int32Array(workerData), 0, 0);
      }
      parentPort.postMessage({ id: request.id, session: request.session, ok: true, revision: request.revision || 0, value: undefined });
    });
  `,
      { eval: true, workerData: gate },
    );
    worker.on('message', (message) => {
      if (message.entered) entered();
    });
    const client = new WorkerLanguageService({ yypPath: '/test.yyp' }, '', {
      delay: () => 0,
      createWorker: () => worker,
    });
    try {
      await client.ready;
      client.update(document('blocked'), true);
      await blocked;
      const token = cancellation();
      const waiting = client.query({ kind: 'hover' }, token);
      await new Promise<void>((resolve) => setImmediate(resolve));
      token.cancel();
      assert.equal(await waiting, undefined);
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      assert.equal(await client.flush(), true);
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      client.dispose();
    }
  },
);

test('background display joins the edit debounce; a precise request flushes both without duplicate analysis', async () => {
  const { client, endpoint } = await setup();
  try {
    client.update(document('pending'));
    const background = client.query({ kind: 'tokens', path: 'A.gml' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(endpoint.requests.length, 0);
    const precise = client.query({ kind: 'definition', path: 'A.gml' });
    endpoint.reply(await endpoint.next('update'));
    const a = await endpoint.next('query');
    const b = await endpoint.next('query');
    endpoint.reply(a, []);
    endpoint.reply(b, []);
    assert.deepEqual(await background, []);
    assert.deepEqual(await precise, []);
    assert.equal(endpoint.requests.length, 0);
  } finally {
    client.dispose();
  }
});

test('cancelling a background display before its timer fires preserves the pending source update', async () => {
  const { client, endpoint } = await setup();
  try {
    client.update(document('pending'));
    const token = cancellation();
    const background = client.query(
      { kind: 'documentSymbols', path: 'A.gml' },
      token,
    );
    token.cancel();
    assert.equal(await background, undefined);
    assert.equal(endpoint.requests.length, 0);
    const flushed = client.flush();
    endpoint.reply(await endpoint.next('update'));
    assert.equal(await flushed, true);
  } finally {
    client.dispose();
  }
});

test('native fallback is immediate during source work, while member queries wait and metadata invalidates candidates', async () => {
  const endpoint = new Endpoint();
  const client = new WorkerLanguageService(
    { yypPath: '/project/game.yyp' },
    '',
    { delay: () => 60000, createWorker: () => endpoint },
  );
  const initialize = await endpoint.next('initialize');
  endpoint.emit('message', {
    id: initialize.id,
    session: initialize.session,
    ok: true,
    revision: 0,
    nativeCandidates: [
      {
        name: 'show_debug_message',
        kind: 'function',
        detail: 'Analysis updating · built-in candidate',
      },
    ],
  });
  await client.ready;
  try {
    client.update(document('show_'));
    const fast = await client.query({
      kind: 'completion',
      allowNativeFallback: true,
    });
    assert.equal(fast?.[0].name, 'show_debug_message');
    assert.match(fast[0].detail!, /candidate/);
    assert(Object.isFrozen(fast));
    assert.equal(
      endpoint.requests.length,
      0,
      'Fallback does not force the edit debounce',
    );
    const precise = client.query({
      kind: 'completion',
      allowNativeFallback: true,
      trigger: '.',
    });
    endpoint.reply(await endpoint.next('update'));
    endpoint.reply(await endpoint.next('query'), [
      { name: 'member', kind: 'variable' },
    ]);
    assert.equal((await precise)?.[0].name, 'member');
    client.update({ kind: 'native', files: ['/different.xml'] });
    const noFallback = client.query({
      kind: 'completion',
      allowNativeFallback: true,
    });
    endpoint.reply(await endpoint.next('update'));
    endpoint.reply(await endpoint.next('query'), [
      { name: 'current', kind: 'variable' },
    ]);
    assert.equal((await noFallback)?.[0].name, 'current');
  } finally {
    client.dispose();
  }
});

test('a synchronous worker-spawn failure is reported once and leaves queries safely unavailable', async () => {
  const errors: Error[] = [];
  const client = new WorkerLanguageService({ yypPath: '/test.yyp' }, '', {
    delay: () => 0,
    createWorker: () => {
      throw new Error('spawn refused');
    },
    onError: (error) => errors.push(error),
  });
  await assert.rejects(client.ready, /spawn refused/);
  assert.equal(await client.query({ kind: 'definition' }), undefined);
  assert.equal(await client.query({ kind: 'definition' }), undefined);
  assert.equal(errors.length, 1);
  client.dispose();
});
