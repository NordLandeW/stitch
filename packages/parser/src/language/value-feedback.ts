import type { UnitEvaluation } from '../analysis/model.js';

export type ValueEffects = Pick<UnitEvaluation, 'valueReads' | 'valueWrites'>;

interface UnitPorts {
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
  readonly effects: ValueEffects;
}

/** Exact value-flow incidence for one analysis transaction. Keys are opaque;
 * ordinary lookup dependencies do not imply value flow. Multiple ports can
 * support the same writer-to-reader edge independently. */
export class ValueFeedbackIndex {
  private readonly units = new Map<string, UnitPorts>();
  private readonly readers = new Map<string, Set<string>>();
  private readonly writers = new Map<string, Set<string>>();
  private readonly forward = new Map<string, Map<string, number>>();
  private readonly reverse = new Map<string, Map<string, number>>();
  private readonly components = new Map<string, ReadonlySet<string> | null>();

  effects(unit: string): ValueEffects | undefined {
    return this.units.get(unit)?.effects;
  }

  replace(unit: string, effects?: ValueEffects): void {
    const previous = this.units.get(unit);
    const reads = new Set(effects?.valueReads);
    const writes = new Set(effects?.valueWrites);
    // Remove incidence before adding it. In particular, a unit changing both
    // ends of a port must not count its old/new overlap twice.
    for (const key of previous?.reads || [])
      if (!reads.has(key)) {
        for (const writer of this.writers.get(key) || [])
          this.edge(writer, unit, -1);
        this.detach(this.readers, key, unit);
      }
    for (const key of previous?.writes || [])
      if (!writes.has(key)) {
        for (const reader of this.readers.get(key) || [])
          this.edge(unit, reader, -1);
        this.detach(this.writers, key, unit);
      }
    for (const key of reads)
      if (!previous?.reads.has(key)) {
        for (const writer of this.writers.get(key) || [])
          this.edge(writer, unit, 1);
        this.attach(this.readers, key, unit);
      }
    for (const key of writes)
      if (!previous?.writes.has(key)) {
        for (const reader of this.readers.get(key) || [])
          this.edge(unit, reader, 1);
        this.attach(this.writers, key, unit);
      }
    this.units.set(unit, {
      reads,
      writes,
      effects: { valueReads: [...reads], valueWrites: [...writes] },
    });
  }

  remove(unit: string): void {
    this.replace(unit);
    this.units.delete(unit);
  }

  /** Multi-unit feedback only. Evaluation already replaces its own unit's old
   * contribution with declarations, so an isolated self edge is not feedback
   * through the contribution index. Member order has no scheduling meaning. */
  component(unit: string): ReadonlySet<string> | undefined {
    if (this.components.has(unit))
      return this.components.get(unit) || undefined;
    const closure = (
      edges: ReadonlyMap<string, ReadonlyMap<string, number>>,
    ) => {
      const seen = new Set([unit]);
      for (const current of seen)
        for (const next of edges.get(current)?.keys() || []) seen.add(next);
      return seen;
    };
    const downstream = closure(this.forward);
    const upstream = closure(this.reverse);
    const members = new Set([...downstream].filter((uri) => upstream.has(uri)));
    if (members.size < 2) {
      this.components.set(unit, null);
      return undefined;
    }
    for (const member of members) this.components.set(member, members);
    return members;
  }

  private edge(writer: string, reader: string, delta: 1 | -1): void {
    if (writer === reader) return;
    const before = this.forward.get(writer)?.get(reader) || 0;
    const after = before + delta;
    const change = (
      edges: Map<string, Map<string, number>>,
      from: string,
      to: string,
    ) => {
      if (after) {
        let targets = edges.get(from);
        if (!targets) edges.set(from, (targets = new Map()));
        targets.set(to, after);
      } else {
        const targets = edges.get(from);
        targets?.delete(to);
        if (!targets?.size) edges.delete(from);
      }
    };
    change(this.forward, writer, reader);
    change(this.reverse, reader, writer);
    if (!before || !after) this.components.clear();
  }

  private attach(
    index: Map<string, Set<string>>,
    key: string,
    unit: string,
  ): void {
    let units = index.get(key);
    if (!units) index.set(key, (units = new Set()));
    units.add(unit);
  }

  private detach(
    index: Map<string, Set<string>>,
    key: string,
    unit: string,
  ): void {
    const units = index.get(key);
    units?.delete(unit);
    if (!units?.size) index.delete(key);
  }
}
