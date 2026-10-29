import type { TypeStore } from '../types.js';
import {
  fingerprints,
  ValueHistory,
  type ValueHistoryBudget,
  value,
  valueFrom,
  type FingerprintCache,
} from './values.js';

export interface TypeConstraint {
  readonly type: TypeStore;
  /** At least one incoming path has no explicit constraint for this storage. */
  readonly conditional: boolean;
}
export interface FlowState {
  readonly values: Map<string, TypeStore>;
  readonly constraints: Map<string, TypeConstraint>;
  /** Statics initialized on every path reaching this point. */
  readonly initializedStatics: Set<string>;
  reachable: boolean;
}
export type CompletionKind =
  | 'normal'
  | 'return'
  | 'throw'
  | 'break'
  | 'continue'
  | 'exit';
export interface Completion {
  kind: CompletionKind;
  state: FlowState;
  value?: TypeStore;
}
export function initialFlow(): FlowState {
  return {
    values: new Map(),
    constraints: new Map(),
    initializedStatics: new Set(),
    reachable: true,
  };
}
export function copyFlow(state: FlowState): FlowState {
  return {
    values: new Map(state.values),
    constraints: new Map(state.constraints),
    initializedStatics: new Set(state.initializedStatics),
    reachable: state.reachable,
  };
}
export function mergeFlow(states: readonly FlowState[]): FlowState {
  const reachable = states.filter((state) => state.reachable);
  const merged: FlowState = {
    values: new Map(),
    constraints: new Map(),
    initializedStatics: new Set(
      [...(reachable[0]?.initializedStatics || [])].filter((key) =>
        reachable.every((state) => state.initializedStatics.has(key)),
      ),
    ),
    reachable: !!reachable.length,
  };
  if (reachable.length === 1) {
    const state = reachable[0];
    for (const [key, current] of state.values)
      merged.values.set(key, value(current));
    for (const [key, constraint] of state.constraints)
      merged.constraints.set(key, {
        type: value(constraint.type),
        conditional: constraint.conditional,
      });
    return merged;
  }
  // Normalize each complete union once instead of renormalizing its growing
  // prefix for every incoming branch. Shared stores are read once per union.
  const values = new Map<string, Set<TypeStore>>();
  const constraints = new Map<
    string,
    { types: Set<TypeStore>; count: number; conditional: boolean }
  >();
  for (const state of reachable) {
    for (const [key, current] of state.values) {
      let inputs = values.get(key);
      if (!inputs) values.set(key, (inputs = new Set()));
      inputs.add(current);
    }
    for (const [key, current] of state.constraints) {
      let inputs = constraints.get(key);
      if (!inputs)
        constraints.set(
          key,
          (inputs = { types: new Set(), count: 0, conditional: false }),
        );
      inputs.types.add(current.type);
      inputs.count++;
      inputs.conditional ||= current.conditional;
    }
  }
  for (const [key, inputs] of values)
    merged.values.set(
      key,
      inputs.size === 1
        ? value(inputs.values().next().value)
        : valueFrom(inputs),
    );
  for (const [key, inputs] of constraints) {
    merged.constraints.set(key, {
      type:
        inputs.types.size === 1
          ? value(inputs.types.values().next().value)
          : valueFrom(inputs.types),
      conditional: inputs.conditional || inputs.count < reachable.length,
    });
  }
  return merged;
}
/** Replace all flow facts together when an expression rejoins its branches. */
export function replaceFlow(target: FlowState, source: FlowState): void {
  target.values.clear();
  source.values.forEach((current, key) => target.values.set(key, current));
  target.constraints.clear();
  source.constraints.forEach((constraint, key) =>
    target.constraints.set(key, constraint),
  );
  target.initializedStatics.clear();
  source.initializedStatics.forEach((key) =>
    target.initializedStatics.add(key),
  );
  target.reachable = source.reachable;
}
export function flowKey(state: FlowState, reuse?: FingerprintCache): string {
  const entries = [
    ...[...state.values].map(
      ([key, current]) => [`value:${key}`, current] as const,
    ),
    ...[...state.constraints].map(
      ([key, constraint]) =>
        [
          `constraint:${constraint.conditional}:${key}`,
          constraint.type,
        ] as const,
    ),
  ];
  const summaries = fingerprints(
    entries.map(([, current]) => current),
    undefined,
    reuse,
    'storage',
  );
  return `${state.reachable}:${JSON.stringify([...state.initializedStatics].sort())}:${entries
    .map(([key], index) => `${key}=${summaries[index]}`)
    .sort()
    .join(';')}`;
}

/** One evaluator loop owns one comparison domain. Context is diagnostic only;
 * class numbers never become exported value or transaction identities. */
export class FlowHistory {
  private readonly values: ValueHistory;
  constructor(
    readonly context = '',
    budget?: ValueHistoryBudget,
  ) {
    // Equal shapes can still alias different mutable storage. Loop convergence
    // must retain that distinction before subsequent reads and writes execute.
    this.values = new ValueHistory(budget, 'storage');
  }
  get statistics() {
    return this.values.statistics;
  }
  repeats(state: FlowState): boolean {
    const entries: [string, TypeStore][] = [
      ...[...state.values].map(
        ([key, current]) =>
          [JSON.stringify(['value', key]), current] as [string, TypeStore],
      ),
      ...[...state.constraints].map(
        ([key, constraint]) =>
          [
            JSON.stringify(['constraint', key, constraint.conditional]),
            constraint.type,
          ] as [string, TypeStore],
      ),
    ];
    return this.values.repeats(
      entries,
      JSON.stringify([state.reachable, [...state.initializedStatics].sort()]),
    );
  }
}

export function normal(state: FlowState): Completion[] {
  return [{ kind: 'normal', state }];
}
