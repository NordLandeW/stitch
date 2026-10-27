import assert from 'node:assert/strict';
import test from 'node:test';
import { stitchEvents } from './events.mjs';

test('event-bus off releases its owner handle while preserving other listeners and subscription identity', (t) => {
  t.after(() => stitchEvents.clear());
  let removedCalls = 0;
  let remainingCalls = 0;
  const removed = stitchEvents.on('request-kill-project-in-webview', () => {
    removedCalls++;
  });
  stitchEvents.on('request-kill-project-in-webview', () => {
    remainingCalls++;
  });
  stitchEvents.emit('request-kill-project-in-webview');
  assert.equal(removedCalls, 1);
  assert.equal(remainingCalls, 1);
  assert.equal(removed.off(), removed);
  assert.equal(removed.off(), removed);
  stitchEvents.emit('request-kill-project-in-webview');
  assert.equal(removedCalls, 1);
  assert.equal(remainingCalls, 2);
  // A released handle must not remain in the bus's teardown ownership. Observe
  // its public off port instead of inspecting the private registry or forcing GC.
  const off = removed.off.bind(removed);
  let staleTeardowns = 0;
  removed.off = () => {
    staleTeardowns++;
    return off();
  };
  stitchEvents.clear();
  assert.equal(staleTeardowns, 0);
  stitchEvents.emit('request-kill-project-in-webview');
  assert.equal(remainingCalls, 2);
});
