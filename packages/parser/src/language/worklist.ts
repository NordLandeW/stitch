import { createHash } from 'node:crypto';
import type { UnitEvaluation } from '../analysis/model.js';
import type { ValueEffects } from './value-feedback.js';

function digest(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input) ?? 'null')
    .digest('hex');
}

/** Cycle detection for one transaction's deterministic worklist. Syntax,
 * declarations, native inputs and macros are fixed for its lifetime; cancellation
 * starts a new transaction. A single unit's output may repeat while its inputs
 * advance, so only a repeated complete scheduling state proves an oscillation. */
export class WorklistHistory {
  private readonly units = new Map<string, string>();
  private unitTree: string[] | undefined;
  private readonly unitLeaves = new Map<string, number>();
  private readonly evaluated = new Set<string>();
  private scheduling = digest([[], [], []]);

  /** First-evaluation retries depend on whether a consumer has already run in
   * this transaction, including after its contribution is withdrawn. */
  markEvaluated(uri: string): void {
    if (this.evaluated.has(uri)) return;
    this.evaluated.add(uri);
    this.updateUnitLeaf(uri);
  }

  /** Active membership is a set; deferred consumers retain queue order.
   * Frozen comparison states determine which outside consumers run on exit. */
  setSchedulingState(
    active: Iterable<string> = [],
    deferred: Iterable<string> = [],
    comparisons: Iterable<readonly [string, string]> = [],
  ): void {
    this.scheduling = digest([
      [...new Set(active)].sort(),
      [...deferred],
      [...comparisons].sort(([a], [b]) => a.localeCompare(b)),
    ]);
  }

  /** The unit set is normally fixed after initialization. Keep its canonical
   * digest in a tree so updating one unit does not sort/hash every unit again. */
  setUnitState(uri: string, state: string): void {
    if (this.units.get(uri) === state) return;
    this.units.set(uri, state);
    this.updateUnitLeaf(uri);
  }

  private updateUnitLeaf(uri: string): void {
    const leaf = this.unitLeaves.get(uri);
    if (!this.unitTree || leaf === undefined) {
      this.unitTree = undefined;
      return;
    }
    this.unitTree[leaf] = digest([
      uri,
      this.units.get(uri),
      this.evaluated.has(uri),
    ]);
    for (let node = leaf >> 1; node; node >>= 1)
      this.unitTree[node] = digest([
        this.unitTree[node * 2],
        this.unitTree[node * 2 + 1],
      ]);
  }

  private unitDigest(): string {
    if (!this.unitTree) {
      const units = [...this.units].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      let size = 1;
      while (size < units.length) size *= 2;
      const tree = Array<string>(size * 2).fill(digest([]));
      this.unitLeaves.clear();
      units.forEach(([uri, state], index) => {
        this.unitLeaves.set(uri, size + index);
        tree[size + index] = digest([uri, state, this.evaluated.has(uri)]);
      });
      for (let node = size - 1; node; node--)
        tree[node] = digest([tree[node * 2], tree[node * 2 + 1]]);
      this.unitTree = tree;
    }
    return this.unitTree[1];
  }
  private bases = digest([]);
  private readonly seen = new Set<string>();

  setUnit(
    uri: string,
    evaluation?: Pick<UnitEvaluation, 'summary' | 'dependencies'> &
      ValueEffects,
    contributionKeys: Iterable<string> = [],
    knownEffects: ValueEffects = evaluation || {},
  ): string {
    const dependencies =
      evaluation?.dependencies.map((dependency) =>
        JSON.stringify([
          dependency.kind,
          dependency.owner,
          dependency.name,
          dependency.target,
          dependency.facet,
        ]),
      ) || [];
    const state = digest([
      evaluation ? ['evaluated', evaluation.summary] : ['declaration'],
      [...new Set(dependencies)].sort(),
      [...new Set(contributionKeys)].sort(),
      [...new Set(knownEffects.valueReads)].sort(),
      [...new Set(knownEffects.valueWrites)].sort(),
    ]);
    this.setUnitState(uri, state);
    return state;
  }

  setResourceBases(
    bases: Iterable<readonly [string, string | undefined]>,
  ): void {
    this.bases = digest(
      [...bases].map((entry) => JSON.stringify(entry)).sort(),
    );
  }

  /** Observe the boundary before consuming a queue entry. Empty is convergence. */
  repeats(queue: Iterable<string>): boolean {
    const pending = [...queue];
    if (!pending.length) return false;
    const state = digest([
      this.unitDigest(),
      this.bases,
      this.scheduling,
      pending,
    ]);
    if (this.seen.has(state)) return true;
    this.seen.add(state);
    return false;
  }
}
