import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type {
  Cancellation,
  Completion,
  DiagnosticSnapshot,
  Initialization,
  Input,
  LanguageService,
  Query,
  QueryKind,
  QueryResults,
  WorkerRequest,
  WorkerResponse,
} from './protocol.mjs';

type Reply = Extract<WorkerResponse, { ok: true }>;
type Request = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id' | 'session'>
    : never
  : never;
export interface WorkerEndpoint {
  postMessage(message: WorkerRequest): void;
  on(event: 'message', listener: (message: WorkerResponse) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  removeAllListeners(): unknown;
  terminate(): Promise<number>;
}
export interface ClientOptions {
  delay(): number;
  onCommit?(diagnostics: DiagnosticSnapshot[]): void;
  onError?(error: Error): void;
  onProgress?(increment: number, message?: string): void;
  onLog?(level: 'log' | 'warn' | 'error', message: string): void;
  /** Dependency injection for transport tests; production always creates Worker. */
  createWorker?(): WorkerEndpoint;
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

/** Cancel the waiter, never the analysis transaction shared by other requests. */
export function cancellable<T>(
  promise: Promise<T>,
  token?: Cancellation,
): Promise<T | undefined> {
  if (token?.isCancellationRequested) return Promise.resolve(undefined);
  if (!token?.onCancellationRequested) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: { dispose(): void } | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      subscription?.dispose();
      action();
    };
    subscription = token.onCancellationRequested!(() =>
      finish(() => resolve(undefined)),
    );
    if (settled) subscription.dispose();
    if (token.isCancellationRequested) finish(() => resolve(undefined));
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Persistent worker transport with an ordered input watermark and value cache. */
export class WorkerLanguageService implements LanguageService {
  private readonly session = randomUUID();
  private readonly worker?: WorkerEndpoint;
  private nextRequest = 0;
  private inputRevision = 0;
  private committedRevision = -1;
  private disposed = false;
  private failure?: Error;
  private timer?: ReturnType<typeof setTimeout>;
  private queued: Input[] = [];
  private running?: Promise<void>;
  private readonly calls = new Map<
    number,
    { resolve(reply: Reply): void; reject(error: Error): void }
  >();
  private readonly diagnostics = new Map<string, DiagnosticSnapshot>();
  private readonly cache = new Map<string, unknown>();
  private nativeCandidates?: Completion[];
  private nativeInvalidatedAt = 0;
  private readonly idleWaiters = new Set<{
    resolve(value: boolean): void;
    reject(error: Error): void;
  }>();
  readonly ready: Promise<void>;

  constructor(
    input: Initialization,
    workerPath: string | URL,
    private readonly options: ClientOptions,
  ) {
    try {
      this.worker = options.createWorker?.() || new Worker(workerPath);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.ready = Promise.reject(this.failure);
      void this.ready.catch(() => {});
      queueMicrotask(() => {
        if (!this.disposed) this.options.onError?.(this.failure!);
      });
      return;
    }
    this.worker.on('message', (message) => this.receive(message));
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.disposed)
        this.fail(new Error(`Stitch language worker exited (${code})`));
    });
    this.ready = this.request({ kind: 'initialize', input })
      .then((reply) => this.commit(reply))
      .catch((error) => {
        this.fail(error);
        throw error;
      });
    // Background startup must not create an unhandled rejection; callers can
    // still await ready/flush to observe the original failure.
    void this.ready.catch(() => {});
  }

  get revision() {
    return this.inputRevision;
  }
  get isCurrent() {
    return (
      !this.disposed &&
      !this.failure &&
      this.committedRevision === this.inputRevision
    );
  }

  update(input: Input, immediate = false): void {
    if (this.disposed || this.failure) return;
    // Coalesce only adjacent source updates. Metadata/close/config are barriers.
    if (input.kind === 'document') {
      for (let i = this.queued.length - 1; i >= 0; i--) {
        const prior = this.queued[i];
        if (prior.kind !== 'document') break;
        if (
          prior.path === input.path &&
          prior.generation === input.generation
        ) {
          if (prior.version >= input.version) return;
          this.queued.splice(i, 1);
          break;
        }
      }
    }
    this.inputRevision++;
    this.cache.clear();
    if (!['document', 'close', 'disk'].includes(input.kind)) {
      this.nativeCandidates = undefined;
      this.nativeInvalidatedAt = this.inputRevision;
    }
    this.queued.push(input);
    clearTimeout(this.timer);
    this.timer = undefined;
    if (immediate) this.background();
    else if (!this.running)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.background();
      }, this.options.delay());
  }

  private background() {
    void this.flush().catch((error) => this.fail(error));
  }

  private start(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.ready
      .then(async () => {
        if (this.disposed || this.failure || !this.queued.length) return;
        const inputs = this.queued;
        this.queued = [];
        const revision = this.inputRevision;
        const reply = await this.request({ kind: 'update', revision, inputs });
        this.commit(reply);
      })
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
        if (this.queued.length && !this.disposed && !this.failure)
          this.background();
      });
    return this.running;
  }

  async flush(token?: Cancellation): Promise<boolean> {
    if (this.disposed || this.failure || token?.isCancellationRequested)
      return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (
      (await cancellable(
        this.ready.then(() => true),
        token,
      )) !== true
    )
      return false;
    while (
      !this.disposed &&
      !this.failure &&
      (this.running || this.queued.length)
    ) {
      if (
        (await cancellable(
          this.start().then(() => true),
          token,
        )) !== true
      )
        return false;
    }

    return !this.disposed && !this.failure && !token?.isCancellationRequested;
  }

  async query<K extends QueryKind>(
    query: Query<K>,
    token?: Cancellation,
  ): Promise<QueryResults[K] | undefined> {
    if (
      !this.disposed &&
      !this.failure &&
      !token?.isCancellationRequested &&
      !this.isCurrent &&
      query.kind === 'completion' &&
      query.allowNativeFallback &&
      query.trigger !== '.' &&
      this.nativeCandidates?.length
    )
      return this.nativeCandidates as QueryResults[K];
    const background =
      query.kind === 'tokens' || query.kind === 'documentSymbols';
    if (!(await (background ? this.waitCurrent(token) : this.flush(token))))
      return;
    const revision = this.inputRevision;
    // Import planning reads a separate project whose disk state is not covered
    // by this target's revision. Recompute it, including after a rejected apply.
    const cacheable = query.kind !== 'importPlan';
    const key = JSON.stringify(query);
    if (cacheable && this.cache.has(key))
      return this.cache.get(key) as QueryResults[K];
    const reply = await cancellable(
      this.request({ kind: 'query', revision, query }),
      token,
    );
    if (
      !reply ||
      this.disposed ||
      token?.isCancellationRequested ||
      revision !== this.inputRevision ||
      reply.revision !== revision
    )
      return;
    const value = immutable(reply.value) as QueryResults[K];
    if (cacheable) {
      if (this.cache.size >= 256)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, value);
    }
    return value;
  }

  private async waitCurrent(token?: Cancellation): Promise<boolean> {
    if (this.disposed || this.failure || token?.isCancellationRequested)
      return false;
    if (this.isCurrent) return true;
    let waiter!: { resolve(value: boolean): void; reject(error: Error): void };
    const promise = new Promise<boolean>((resolve, reject) => {
      waiter = { resolve, reject };
      this.idleWaiters.add(waiter);
    });
    try {
      return (await cancellable(promise, token)) === true;
    } finally {
      this.idleWaiters.delete(waiter);
    }
  }

  private request(request: Request): Promise<Reply> {
    if (this.disposed || this.failure)
      return Promise.reject(
        this.failure || new Error('Language service disposed'),
      );
    const id = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      try {
        this.worker!.postMessage({
          ...request,
          id,
          session: this.session,
        } as WorkerRequest);
      } catch (error) {
        this.calls.delete(id);
        reject(error);
      }
    });
  }

  private receive(message: WorkerResponse) {
    if (this.disposed || message.session !== this.session) return;
    if ('event' in message) {
      if (message.event === 'progress')
        this.options.onProgress?.(message.increment, message.message);
      else this.options.onLog?.(message.level, message.message);
      return;
    }
    const waiter = this.calls.get(message.id);
    if (!waiter) return;
    this.calls.delete(message.id);
    if (message.ok) waiter.resolve(message);
    else waiter.reject(new Error(message.error));
  }

  private commit(reply: Reply) {
    if (this.disposed || reply.revision < this.committedRevision) return;
    this.committedRevision = reply.revision;
    if (reply.nativeCandidates && reply.revision >= this.nativeInvalidatedAt)
      this.nativeCandidates = immutable(reply.nativeCandidates);
    // A stale transaction may have changed a different file. Accumulate its
    // values privately and publish only once the latest input is committed.
    for (const snapshot of reply.diagnostics || [])
      this.diagnostics.set(snapshot.path, immutable(snapshot));
    if (reply.revision !== this.inputRevision) return;
    const diagnostics = [...this.diagnostics.values()];
    this.diagnostics.clear();
    this.options.onCommit?.(diagnostics);
    for (const waiter of this.idleWaiters) waiter.resolve(true);
    this.idleWaiters.clear();
  }

  private fail(error: unknown) {
    if (this.disposed || this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    clearTimeout(this.timer);
    this.queued = [];
    this.cache.clear();
    this.diagnostics.clear();
    for (const call of this.calls.values()) call.reject(this.failure);
    this.calls.clear();
    for (const waiter of this.idleWaiters) waiter.reject(this.failure);
    this.idleWaiters.clear();
    this.worker?.removeAllListeners();
    void this.worker?.terminate().catch(() => {});
    this.options.onError?.(this.failure);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.queued = [];
    this.cache.clear();
    this.diagnostics.clear();
    for (const call of this.calls.values())
      call.reject(new Error('Language service disposed'));
    this.calls.clear();
    for (const waiter of this.idleWaiters) waiter.resolve(false);
    this.idleWaiters.clear();
    this.worker?.removeAllListeners();
    void this.worker?.terminate().catch(() => {});
  }
}
