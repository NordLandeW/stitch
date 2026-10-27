export interface DocumentSnapshot {
  /** Undefined for a closed file read from disk. */
  version?: number;
  text: string;
}

/** Return a function that cancels the scheduled callback. */
export type ScheduleAnalysis = (
  callback: () => void,
  delay: number,
) => () => void;

export const scheduleAnalysis: ScheduleAnalysis = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

interface AnalysisCancellation {
  isCancellationRequested: boolean;
  onCancellationRequested(callback: () => void): { dispose(): void };
}

interface AnalysisWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface DocumentState {
  waiters?: Set<AnalysisWaiter>;
  latest?: DocumentSnapshot;
  running?: Promise<void>;
  cancelTimer?: () => void;
  failed?: boolean;
  forget?: boolean;
}

interface AnalysisOptions<Key> {
  content(key: Key): string | undefined;
  analyze(key: Key, snapshot: DocumentSnapshot): Promise<void>;
  delay(): number;
  onError(error: unknown): void;
  schedule?: ScheduleAnalysis;
}

/** Coalesce document versions while keeping each mutable analysis transaction intact. */
export class DocumentAnalysisQueue<Key> {
  private readonly states = new Map<Key, DocumentState>();
  private readonly schedule: ScheduleAnalysis;
  private disposed = false;

  constructor(private readonly options: AnalysisOptions<Key>) {
    this.schedule = options.schedule || scheduleAnalysis;
  }

  get pending(): boolean {
    return [...this.states.values()].some(
      (state) => state.latest || state.running,
    );
  }

  /** Record the newest text. Typing, deletion and replacement share this path. */
  enqueue(key: Key, snapshot: DocumentSnapshot, immediate = false): void {
    if (this.disposed) return;
    const state = this.accept(key, snapshot);
    if (
      !state.running &&
      !state.failed &&
      this.options.content(key) === snapshot.text
    ) {
      state.latest = undefined;
      this.settle(state);
      return;
    }
    if (immediate) {
      this.runInBackground(key, state);
    } else if (!state.running) {
      state.cancelTimer = this.schedule(() => {
        state.cancelTimer = undefined;
        this.runInBackground(key, state);
      }, this.options.delay());
    }
  }

  /** Interactive requests bypass the timer, not another document's diagnostics. */
  async flush(key: Key, snapshot: DocumentSnapshot): Promise<void> {
    if (this.disposed) return;
    const state = this.accept(key, snapshot);
    while (!this.disposed && (state.latest || state.running)) {
      await this.start(key, state);
    }
  }

  /** Background providers join the pending update without defeating its debounce. */
  wait(
    key: Key,
    snapshot: DocumentSnapshot,
    token?: AnalysisCancellation,
  ): Promise<void> {
    if (this.disposed || token?.isCancellationRequested)
      return Promise.resolve();
    const existing = this.states.get(key);
    // Joining the same version must not postpone its existing timer.
    if (
      !existing?.latest ||
      existing.latest.text !== snapshot.text ||
      existing.latest.version !== snapshot.version
    ) {
      this.enqueue(key, snapshot);
    }
    const state = this.states.get(key)!;
    if (!state.latest && !state.running) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let subscription: { dispose(): void } | undefined;
      const finish = (callback: () => void) => {
        state.waiters?.delete(waiter);
        subscription?.dispose();
        callback();
      };
      const waiter: AnalysisWaiter = {
        resolve: () => finish(resolve),
        reject: (error) => finish(() => reject(error)),
      };
      (state.waiters ||= new Set()).add(waiter);
      subscription = token?.onCancellationRequested(waiter.resolve);
      if (token?.isCancellationRequested) waiter.resolve();
    });
  }

  private settle(state: DocumentState, failure?: { error: unknown }) {
    for (const waiter of state.waiters || []) {
      if (failure) waiter.reject(failure.error);
      else waiter.resolve();
    }
  }

  /** Closing a document drops queued text; an in-flight transaction finishes safely. */
  forget(key: Key): void {
    const state = this.states.get(key);
    if (!state) return;
    state.cancelTimer?.();
    state.cancelTimer = undefined;
    state.latest = undefined;
    state.forget = true;
    this.settle(state);
    if (!state.running) this.states.delete(key);
  }

  clear(): void {
    for (const key of this.states.keys()) this.forget(key);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private accept(key: Key, snapshot: DocumentSnapshot): DocumentState {
    let state = this.states.get(key);
    if (!state) {
      state = {};
      this.states.set(key, state);
    }
    state.cancelTimer?.();
    state.cancelTimer = undefined;
    state.latest = snapshot;
    state.forget = false;
    return state;
  }

  private runInBackground(key: Key, state: DocumentState): void {
    void this.start(key, state).catch(this.options.onError);
  }

  private start(key: Key, state: DocumentState): Promise<void> {
    if (state.running) return state.running;
    // Publish the promise before invoking analyze, which can synchronously re-enter.
    let failure: { error: unknown } | undefined;
    state.running = Promise.resolve()
      .then(async () => {
        while (!this.disposed && state.latest) {
          const snapshot = state.latest;
          state.latest = undefined;
          try {
            // Re-read the model: resource reloads can also update its content.
            if (state.failed || this.options.content(key) !== snapshot.text) {
              await this.options.analyze(key, snapshot);
            }
            state.failed = false;
          } catch (error) {
            // A failed parse may already have assigned the new text to the model.
            state.failed = true;
            if (!state.latest) throw error;
            this.options.onError(error);
          }
        }
      })
      .catch((error) => {
        failure = { error };
        throw error;
      })
      .finally(() => {
        state.running = undefined;
        if (state.latest && !this.disposed) {
          this.runInBackground(key, state);
        } else {
          this.settle(state, failure);
          if (state.forget) this.states.delete(key);
        }
      });
    return state.running;
  }
}
