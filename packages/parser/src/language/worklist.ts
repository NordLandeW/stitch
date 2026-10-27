import { createHash } from 'node:crypto';
import type { UnitEvaluation } from '../analysis/model.js';

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
  private bases = digest([]);
  private readonly seen = new Set<string>();

  setUnit(
    uri: string,
    evaluation?: Pick<UnitEvaluation, 'summary' | 'dependencies'>,
    contributionKeys: Iterable<string> = [],
  ): void {
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
    this.units.set(
      uri,
      digest([
        evaluation ? ['evaluated', evaluation.summary] : ['declaration'],
        [...new Set(dependencies)].sort(),
        [...new Set(contributionKeys)].sort(),
      ]),
    );
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
      [...this.units].sort(([left], [right]) => left.localeCompare(right)),
      this.bases,
      pending,
    ]);
    if (this.seen.has(state)) return true;
    this.seen.add(state);
    return false;
  }
}
