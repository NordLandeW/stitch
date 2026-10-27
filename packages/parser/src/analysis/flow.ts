import type { TypeStore } from '../types.js';
import { fingerprints, join, value } from './values.js';

export interface FlowState {
  readonly values: Map<string, TypeStore>;
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
  return { values: new Map(), reachable: true };
}
export function copyFlow(state: FlowState): FlowState {
  return { values: new Map(state.values), reachable: state.reachable };
}
export function mergeFlow(states: readonly FlowState[]): FlowState {
  const reachable = states.filter((state) => state.reachable);
  const merged: FlowState = {
    values: new Map(),
    reachable: !!reachable.length,
  };
  for (const state of reachable) {
    for (const [key, current] of state.values)
      merged.values.set(key, join(merged.values.get(key) || value(), current));
  }
  return merged;
}
export function flowKey(state: FlowState): string {
  const entries = [...state.values];
  const summaries = fingerprints(entries.map(([, current]) => current));
  return `${state.reachable}:${entries
    .map(([key], index) => `${key}=${summaries[index]}`)
    .sort()
    .join(';')}`;
}
export function normal(state: FlowState): Completion[] {
  return [{ kind: 'normal', state }];
}
