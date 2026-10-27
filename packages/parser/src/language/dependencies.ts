import type { SemanticDependency } from '../analysis/model.js';

/** Negative lookups and type facets participate in the same retirement rules. */
export class DependencyIndex {
  private readonly byUnit = new Map<string, Set<string>>();
  private readonly users = new Map<string, Set<string>>();

  replace(unit: string, dependencies: readonly SemanticDependency[]): void {
    this.remove(unit);
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
  }

  affected(keys: Iterable<string>): Set<string> {
    const result = new Set<string>();
    for (const key of keys)
      for (const user of this.users.get(key) || []) result.add(user);
    return result;
  }
}
