import assert from 'node:assert/strict';
import test from 'node:test';
import { armContinueFocusGuard } from './continueFocusGuard.mjs';

test('does not guard Continue when VS Code was already unfocused', () => {
  let listening = false;
  let scheduled = false;
  const cancel = armContinueFocusGuard({
    initiallyFocused: false,
    onDidChangeFocus() {
      listening = true;
      return () => {};
    },
    focusWindow() {},
    scheduleTimeout() {
      scheduled = true;
      return () => {};
    },
  });

  assert.equal(cancel, undefined);
  assert.equal(listening, false);
  assert.equal(scheduled, false);
});

test('restores VS Code focus once when Continue activates the Runner', async () => {
  let focusListener: ((focused: boolean) => void) | undefined;
  let listenerRemovals = 0;
  let timeoutCancellations = 0;
  let focusRequests = 0;
  const cancel = armContinueFocusGuard({
    initiallyFocused: true,
    onDidChangeFocus(listener) {
      focusListener = listener;
      return () => listenerRemovals++;
    },
    focusWindow() {
      focusRequests++;
    },
    scheduleTimeout() {
      return () => timeoutCancellations++;
    },
  });

  assert(cancel);
  focusListener?.(true);
  assert.equal(focusRequests, 0);

  focusListener?.(false);
  focusListener?.(false);
  await Promise.resolve();
  assert.equal(focusRequests, 1);
  assert.equal(listenerRemovals, 1);
  assert.equal(timeoutCancellations, 1);
});

test('expires without restoring focus when the Runner does not activate', () => {
  let focusListener: ((focused: boolean) => void) | undefined;
  let expire: (() => void) | undefined;
  let listenerRemovals = 0;
  let focusRequests = 0;
  armContinueFocusGuard({
    initiallyFocused: true,
    onDidChangeFocus(listener) {
      focusListener = listener;
      return () => listenerRemovals++;
    },
    focusWindow() {
      focusRequests++;
    },
    scheduleTimeout(callback) {
      expire = callback;
      return () => {};
    },
  });

  expire?.();
  focusListener?.(false);
  assert.equal(focusRequests, 0);
  assert.equal(listenerRemovals, 1);
});
