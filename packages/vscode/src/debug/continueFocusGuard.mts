export interface ContinueFocusGuardOptions {
  initiallyFocused: boolean;
  onDidChangeFocus(listener: (focused: boolean) => void): () => void;
  focusWindow(): unknown;
  scheduleTimeout?(callback: () => void, delay: number): () => void;
  timeout?: number;
}

function scheduleTimeout(callback: () => void, delay: number) {
  const timeout = setTimeout(callback, delay);
  return () => clearTimeout(timeout);
}

export function armContinueFocusGuard({
  initiallyFocused,
  onDidChangeFocus,
  focusWindow,
  scheduleTimeout: schedule = scheduleTimeout,
  timeout = 250,
}: ContinueFocusGuardOptions): (() => void) | undefined {
  if (!initiallyFocused) return undefined;

  let active = true;
  let removeFocusListener: (() => void) | undefined;
  let cancelTimeout: (() => void) | undefined;
  const cancel = () => {
    if (!active) return;
    active = false;
    removeFocusListener?.();
    cancelTimeout?.();
  };

  removeFocusListener = onDidChangeFocus((focused) => {
    if (!active || focused) return;
    cancel();
    void Promise.resolve(focusWindow()).catch(() => {});
  });
  if (!active) removeFocusListener();

  cancelTimeout = schedule(cancel, timeout);
  if (!active) cancelTimeout();

  return cancel;
}
