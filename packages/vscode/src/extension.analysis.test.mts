import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DocumentAnalysisQueue,
  type DocumentSnapshot,
} from './extension.analysis.core.mjs';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  analyze?: (key: string, snapshot: DocumentSnapshot) => Promise<void>,
) {
  const content = new Map<string, string>();
  const calls: { key: string; version?: number; text: string }[] = [];
  const errors: unknown[] = [];
  const timers = new Set<() => void>();
  const queue = new DocumentAnalysisQueue<string>({
    content: (key) => content.get(key),
    async analyze(key, snapshot) {
      calls.push({ key, ...snapshot });
      if (analyze) await analyze(key, snapshot);
      content.set(key, snapshot.text);
    },
    delay: () => 50,
    onError: (error) => errors.push(error),
    schedule(callback) {
      timers.add(callback);
      return () => timers.delete(callback);
    },
  });
  return {
    queue,
    content,
    calls,
    errors,
    timers,
    fire() {
      const callbacks = [...timers];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}
const snapshot = (version: number, text = `text ${version}`) => ({
  version,
  text,
});

test('coalesces a burst to the newest text before analysis starts', async () => {
  const f = fixture();
  for (let version = 1; version <= 5; version++)
    f.queue.enqueue('file', snapshot(version));
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 1);
  f.fire();
  await f.queue.flush('file', snapshot(5));
  assert.deepEqual(f.calls, [{ key: 'file', ...snapshot(5) }]);
  assert.equal(f.queue.pending, false);
});

test('an immediate trigger cancels the older timer and analyzes its version once', async () => {
  const f = fixture();
  f.queue.enqueue('file', snapshot(1, 'value'));
  f.queue.enqueue('file', snapshot(2, 'value.'), true);
  assert.equal(f.timers.size, 0);
  await f.queue.flush('file', snapshot(2, 'value.'));
  f.fire();
  assert.deepEqual(f.calls, [{ key: 'file', ...snapshot(2, 'value.') }]);
});

test('deletions, paste and undo coalesce using final content rather than edit shape', async () => {
  const f = fixture();
  for (const [version, text] of [
    [1, 'abc'],
    [2, 'ab'],
    [3, ''],
    [4, 'pasted text'],
    [5, 'ab'],
  ] as const) {
    f.queue.enqueue('file', snapshot(version, text));
  }
  await f.queue.flush('file', snapshot(5, 'ab'));
  assert.deepEqual(f.calls, [{ key: 'file', ...snapshot(5, 'ab') }]);
});

test('interactive requests flush pending text without waiting for the debounce timer', async () => {
  const f = fixture();
  f.queue.enqueue('file', snapshot(1));
  await f.queue.flush('file', snapshot(1));
  assert.equal(f.timers.size, 0);
  assert.equal(f.content.get('file'), 'text 1');
});

test('finishes the current transaction then catches up to the newest busy edit', async () => {
  const started = deferred();
  const release = deferred();
  const f = fixture(async (_, current) => {
    if (current.version === 1) {
      started.resolve();
      await release.promise;
    }
  });
  const first = f.queue.flush('file', snapshot(1));
  await started.promise;
  f.queue.enqueue('file', snapshot(2), true);
  f.queue.enqueue('file', snapshot(3));
  const newest = f.queue.flush('file', snapshot(3));
  assert.equal(f.calls.length, 1);
  release.resolve();
  await Promise.all([first, newest]);
  assert.deepEqual(
    f.calls.map((call) => call.version),
    [1, 3],
  );
  assert.equal(f.content.get('file'), 'text 3');
  assert.equal(f.queue.pending, false);
});

test('equal editor/save/disk content does not repeat an analysis', async () => {
  const f = fixture();
  await f.queue.flush('file', snapshot(1, 'saved'));
  await f.queue.flush('file', snapshot(2, 'saved'));
  await f.queue.flush('file', { text: 'saved' });
  assert.equal(f.calls.length, 1);
  f.content.set('file', 'external resource update');
  await f.queue.flush('file', snapshot(2, 'saved'));
  assert.equal(f.calls.length, 2);
  assert.equal(f.content.get('file'), 'saved');
});

test('initially loaded content is reused without a redundant first parse', async () => {
  const f = fixture();
  f.content.set('file', 'loaded');
  await f.queue.flush('file', snapshot(1, 'loaded'));
  assert.equal(f.calls.length, 0);
});

test('failure is reported and does not block retry even when text was assigned', async () => {
  let fail = true;
  const f = fixture(async (key, current) => {
    f.content.set(key, current.text);
    if (fail) throw new Error('analysis failed');
  });
  await assert.rejects(f.queue.flush('file', snapshot(1)), /analysis failed/);
  assert.equal(f.queue.pending, false);
  fail = false;
  await f.queue.flush('file', snapshot(1));
  assert.equal(f.calls.length, 2);
});

test('a failed older version still allows the already queued newer version', async () => {
  const started = deferred();
  const release = deferred();
  const f = fixture(async (_, current) => {
    if (current.version === 1) {
      started.resolve();
      await release.promise;
      throw new Error('old analysis failed');
    }
  });
  const first = f.queue.flush('file', snapshot(1));
  await started.promise;
  f.queue.enqueue('file', snapshot(2));
  release.resolve();
  await first;
  assert.equal(f.content.get('file'), 'text 2');
  assert.equal(f.errors.length, 1);
});

test('closing cancels pending text and permits a new document version sequence', async () => {
  const f = fixture();
  f.queue.enqueue('file', snapshot(100));
  f.queue.forget('file');
  f.fire();
  assert.equal(f.calls.length, 0);
  await f.queue.flush('file', snapshot(1, 'reopened'));
  assert.equal(f.content.get('file'), 'reopened');
});

test('closing while busy serializes the disk restore after the old transaction', async () => {
  const started = deferred();
  const release = deferred();
  const f = fixture(async (_, current) => {
    if (current.version === 10) {
      started.resolve();
      await release.promise;
    }
  });
  const old = f.queue.flush('file', snapshot(10, 'unsaved'));
  await started.promise;
  f.queue.forget('file');
  const restored = f.queue.flush('file', { text: 'on disk' });
  release.resolve();
  await Promise.all([old, restored]);
  assert.deepEqual(
    f.calls.map((call) => call.text),
    ['unsaved', 'on disk'],
  );
  assert.equal(f.content.get('file'), 'on disk');
});

test('dispose retires timers and queued versions without interrupting a transaction', async () => {
  const started = deferred();
  const release = deferred();
  const f = fixture(async () => {
    started.resolve();
    await release.promise;
  });
  const active = f.queue.flush('one', snapshot(1));
  await started.promise;
  f.queue.enqueue('one', snapshot(2));
  f.queue.enqueue('two', snapshot(1));
  f.queue.dispose();
  assert.equal(f.timers.size, 0);
  release.resolve();
  await active;
  f.fire();
  await f.queue.flush('three', snapshot(1));
  assert.deepEqual(
    f.calls.map((call) => call.key),
    ['one'],
  );
  assert.equal(f.queue.pending, false);
});

test('interactive readiness for one document does not wait for another delayed file', async () => {
  const f = fixture();
  f.queue.enqueue('background', snapshot(1));
  await f.queue.flush('active', snapshot(1));
  assert.deepEqual(
    f.calls.map((call) => call.key),
    ['active'],
  );
  assert.equal(f.timers.size, 1);
  f.queue.dispose();
});

test('background readers join the existing timer without forcing or postponing it', async () => {
  const f = fixture();
  f.queue.enqueue('file', snapshot(1));
  const timer = [...f.timers][0];
  let resolved = false;
  const waiting = f.queue.wait('file', snapshot(1)).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(f.calls.length, 0);
  assert.equal([...f.timers][0], timer);
  f.fire();
  await waiting;
  assert.equal(f.content.get('file'), 'text 1');
});

test('interactive flush also releases background readers of the same document', async () => {
  const f = fixture();
  const waiting = f.queue.wait('file', snapshot(1));
  await f.queue.flush('file', snapshot(1));
  await waiting;
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});

test('cancelling a background request retires its waiter but preserves the edit', async () => {
  const f = fixture();
  const listeners = new Set<() => void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback: () => void) {
      listeners.add(callback);
      return {
        dispose: () => {
          listeners.delete(callback);
        },
      };
    },
  };
  const waiting = f.queue.wait('file', snapshot(1), token);
  token.isCancellationRequested = true;
  for (const listener of [...listeners]) listener();
  await waiting;
  assert.equal(listeners.size, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 1);
  f.fire();
  await f.queue.flush('file', snapshot(1));
  assert.equal(f.content.get('file'), 'text 1');
});

test('background readers are released on close and disposal', async () => {
  const f = fixture();
  const closed = f.queue.wait('closed', snapshot(1));
  f.queue.forget('closed');
  await closed;
  const disposed = f.queue.wait('disposed', snapshot(1));
  f.queue.dispose();
  await disposed;
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
});

test('background readers receive analysis errors and can subsequently retry', async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error('failed');
  });
  const waiting = f.queue.wait('file', snapshot(1));
  const rejected = assert.rejects(waiting, /failed/);
  f.fire();
  await rejected;
  fail = false;
  await f.queue.flush('file', snapshot(1));
  assert.equal(f.content.get('file'), 'text 1');
});
