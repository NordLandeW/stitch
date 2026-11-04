import type { Project } from '@bscotch/gml-parser';
import { cancellable } from '../language/client.mjs';
import { LanguageEngine } from '../language/engine.mjs';
import type {
  Cancellation,
  Input,
  LanguageService,
  Query,
  QueryKind,
  QueryResults,
} from '../language/protocol.mjs';

/** Real engine, in-memory transport for existing parser/provider contracts.
 * Only this fixture shares resource identities with the host, which already
 * applies metadata operations. Worker/lifecycle tests use the production entry. */
export class TestLanguageService implements LanguageService {
  revision = 0;
  private committed = 0;
  private disposed = false;
  private pending = Promise.resolve();
  private readonly engine: LanguageEngine;
  get isCurrent() {
    return !this.disposed && this.committed === this.revision;
  }
  constructor(project: Project) {
    this.engine = new LanguageEngine({}, project);
  }
  update(input: Input) {
    const revision = ++this.revision;
    this.pending = this.pending.then(async () => {
      if (this.disposed) return;
      if (
        input.kind === 'document' ||
        input.kind === 'close' ||
        input.kind === 'disk'
      )
        await this.engine.apply([input]);
      this.committed = revision;
    });
    void this.pending.catch(() => {});
  }
  async flush(token?: Cancellation): Promise<boolean> {
    if (this.disposed || token?.isCancellationRequested) return false;
    if (
      (await cancellable(
        this.pending.then(() => true),
        token,
      )) !== true
    )
      return false;
    return this.isCurrent;
  }
  async query<K extends QueryKind>(
    query: Query<K>,
    token?: Cancellation,
  ): Promise<QueryResults[K] | undefined> {
    if (!(await this.flush(token))) return;
    return this.engine.query(query);
  }
  dispose() {
    this.disposed = true;
  }
}
