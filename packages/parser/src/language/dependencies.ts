import type { SemanticDependency } from '../analysis/model.js';

/** Negative lookups and type facets participate in the same retirement rules. */
export class DependencyIndex {
  private readonly byUnit = new Map<string, Set<string>>();
  private readonly users = new Map<string, Set<string>>();
  private readonly inputs = new Map<string, readonly SemanticDependency[]>();

  clone(): DependencyIndex {
    const clone = new DependencyIndex();
    for (const [unit, keys] of this.byUnit) clone.byUnit.set(unit, keys);
    for (const [key, users] of this.users) clone.users.set(key, new Set(users));
    for (const [unit, input] of this.inputs) clone.inputs.set(unit, input);
    return clone;
  }

  replace(unit: string, dependencies: readonly SemanticDependency[]): void {
    if (this.inputs.get(unit) === dependencies) return;
    this.remove(unit);
    this.inputs.set(unit, dependencies);
    const keys = new Set<string>();
    for (const dependency of dependencies) {
      if (
        !dependency.name ||
        (dependency.kind === 'type' && dependency.owner !== 'global')
      )
        keys.add(dependency.owner);
      if (dependency.target) keys.add(dependency.target);
      if (dependency.name)
        keys.add(`${dependency.owner}/lookup:${dependency.name}`);
    }
    this.byUnit.set(unit, keys);
    for (const key of keys) {
      let users = this.users.get(key);
      if (!users) this.users.set(key, (users = new Set()));
      users.add(unit);
    }
  }

  remove(unit: string): void {
    for (const key of this.byUnit.get(unit) || []) {
      const users = this.users.get(key)!;
      users.delete(unit);
      if (!users.size) this.users.delete(key);
    }
    this.byUnit.delete(unit);
    this.inputs.delete(unit);
  }

  affected(keys: Iterable<string>): Set<string> {
    const result = new Set<string>();
    for (const key of keys)
      for (const user of this.users.get(key) || []) result.add(user);
    return result;
  }
}
